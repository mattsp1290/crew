-- Estimated cost and the trusted-context lane in the usage ledger (docs/usage-metering.md).
--
-- An estimate comes from the operator's price table (usage-prices.ts), computed when the row is
-- written and never recomputed, so a later price never rewrites an earlier row. A trusted-context
-- request has no native launch: its row is bound to its trusted request instead, once.
--
-- Locks on existing tables, held until migrate() commits: ACCESS EXCLUSIVE on usage_ledger to add
-- three nullable columns without a default (no rewrite), drop NOT NULL from token, add CHECKs and a
-- foreign key NOT VALID (no row is scanned) and build one empty partial unique index, which reads
-- the ledger once; SHARE ROW EXCLUSIVE on trusted_requests for the foreign key. As in 025 to 032
-- they are taken together with NOWAIT and retried, so the migration never waits in a lock queue.
-- Only short statements hold either table: a ledger insert or read, or a trusted request's submit,
-- start or commit. A trusted native turn's lease reads trusted_requests under ACCESS SHARE, which
-- SHARE ROW EXCLUSIVE allows. After 60 s without the locks it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.usage_ledger IN ACCESS EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.trusted_requests IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

ALTER TABLE birbcrew_ts.usage_ledger
    -- USD, exact: integer token counts times rates of at most six decimal places per million tokens.
    ADD COLUMN estimated_cost_usd numeric(22, 12),
    -- The rates the estimate used, USD per million tokens as decimal strings (usage-prices.ts Price).
    ADD COLUMN estimate_price jsonb,
    -- Set, and equal to request_id, only on a trusted-context row, which has no launch token.
    ADD COLUMN trusted_request_id uuid,
    ALTER COLUMN token DROP NOT NULL,
    -- A provider-billed cost and an estimate never share a row, so the two totals never overlap.
    ADD CONSTRAINT usage_ledger_estimate_check CHECK (estimated_cost_usd IS NULL OR (estimated_cost_usd >= 0
        AND state = 'reported' AND model IS NOT NULL AND cost_usd IS NULL AND jsonb_typeof(estimate_price) = 'object')) NOT VALID,
    ADD CONSTRAINT usage_ledger_estimate_price_check CHECK ((estimated_cost_usd IS NULL) = (estimate_price IS NULL)) NOT VALID,
    -- A row is a member launch's (token) or a trusted request's, never both. A member row keeps its
    -- foreign key to native_launches; a trusted row's NULL token exempts it from that key.
    ADD CONSTRAINT usage_ledger_lane_check CHECK ((token IS NULL) <> (trusted_request_id IS NULL)
        AND (trusted_request_id IS NULL OR (trusted_request_id = request_id AND child_id IS NULL))) NOT VALID,
    ADD CONSTRAINT usage_ledger_trusted_request_fkey FOREIGN KEY (conversation_id, trusted_request_id)
        REFERENCES birbcrew_ts.trusted_requests (conversation_id, request_id) NOT VALID;

-- One row per trusted request: it runs at most once, under one token, so its ID identifies the
-- model work as a launch generation does on the member lane.
CREATE UNIQUE INDEX usage_ledger_trusted_request ON birbcrew_ts.usage_ledger (conversation_id, trusted_request_id)
    WHERE trusted_request_id IS NOT NULL;
