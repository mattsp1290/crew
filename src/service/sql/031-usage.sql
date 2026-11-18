-- Usage metering (docs/usage-metering.md): one ledger row per native launch whose SDK returned a
-- result, with the token counts it reported, and an optional per-member token budget that
-- request admission enforces.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members and
-- native_launches for the new foreign keys; ACCESS EXCLUSIVE on audit_events to replace its type
-- CHECK (dropped and re-added NOT VALID, so no row is scanned) and to build two empty
-- partial unique indexes, each of which reads audit_events once; ACCESS EXCLUSIVE on
-- routine_firings to replace its reason CHECK the same way. As in 025 to 030 they are taken together with NOWAIT and
-- retried, so the migration never waits in a lock queue and never joins a deadlock. Applied
-- alone, from version 30, it holds nothing while it retries; applied with earlier migrations in
-- one transaction it retries while holding their locks, and admissions and audited writes wait.
-- A native turn's admission transaction holds ACCESS SHARE and ROW SHARE (FOR SHARE) only, which
-- these modes allow, so a running turn never delays it. After 60 s without the locks it fails
-- with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.native_launches IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.audit_events, birbcrew_ts.routine_firings IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

-- One row per native launch (conversation, request, launch generation): native_launches
-- reserves each generation once, before its SDK process starts, so a Temporal replay or an
-- activity retry can never add a second row for the same model work. Token columns follow
-- segmentUsage in usage-capture.ts: input counts cache reads and writes, output counts
-- reasoning, and a column the SDK does not report is NULL. 'unknown' means the SDK reported
-- nothing usable; it is never stored as zero.
CREATE TABLE birbcrew_ts.usage_ledger (
    usage_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    token uuid NOT NULL,
    child_id uuid,
    engine text NOT NULL CHECK (engine IN ('pi', 'claude', 'codex')),
    state text NOT NULL CHECK (state IN ('reported', 'unknown')),
    model text CHECK (octet_length(model) BETWEEN 1 AND 256),
    input_tokens integer CHECK (input_tokens >= 0),
    output_tokens integer CHECK (output_tokens >= 0),
    cached_input_tokens integer CHECK (cached_input_tokens >= 0),
    cache_write_tokens integer CHECK (cache_write_tokens >= 0),
    reasoning_tokens integer CHECK (reasoning_tokens >= 0),
    -- Only a cost the provider billed and reported; never an estimate from a price table.
    cost_usd numeric(18, 10) CHECK (cost_usd >= 0),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (conversation_id, request_id, token),
    FOREIGN KEY (conversation_id, request_id, token) REFERENCES birbcrew_ts.native_launches (conversation_id, request_id, token),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    CHECK ((state = 'reported') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
    CHECK (state = 'reported' OR (input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL
        AND cache_write_tokens IS NULL AND reasoning_tokens IS NULL AND cost_usd IS NULL))
);
-- The budget check sums one member's current window; the record list pages an owner's rows;
-- the summary reads a time range and the conversation list groups by conversation.
CREATE INDEX usage_ledger_member_window ON birbcrew_ts.usage_ledger (member_id, recorded_at);
CREATE INDEX usage_ledger_owner_page ON birbcrew_ts.usage_ledger (owner_id, usage_id);
CREATE INDEX usage_ledger_owner_time ON birbcrew_ts.usage_ledger (owner_id, recorded_at);
CREATE INDEX usage_ledger_owner_conversation ON birbcrew_ts.usage_ledger (owner_id, conversation_id);

CREATE FUNCTION birbcrew_ts.reject_usage_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'The usage ledger is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER usage_ledger_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.usage_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_usage_ledger_change();

-- At most one budget per member. Clearing keeps the row so its revision, which keys the audit
-- row of every change, keeps rising. The period is fixed: the UTC calendar day.
CREATE TABLE birbcrew_ts.usage_budgets (
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('active', 'cleared')),
    token_limit bigint CHECK (token_limit BETWEEN 1 AND 1000000000000),
    period text NOT NULL DEFAULT 'utc_day' CHECK (period = 'utc_day'),
    revision integer NOT NULL CHECK (revision > 0),
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (member_id),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    CHECK ((state = 'active') = (token_limit IS NOT NULL))
);

CREATE FUNCTION birbcrew_ts.guard_usage_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Usage budgets are cleared, never deleted' USING ERRCODE = '23514';
    END IF;
    IF (OLD.owner_id, OLD.member_id) IS DISTINCT FROM (NEW.owner_id, NEW.member_id) OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'A usage budget keeps its member and raises its revision by one per change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER usage_budgets_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.usage_budgets
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_usage_budget();
CREATE FUNCTION birbcrew_ts.reject_usage_budget_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Usage budgets are cleared, never deleted' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER usage_budgets_kept BEFORE TRUNCATE ON birbcrew_ts.usage_budgets
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_usage_budget_truncate();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.usage_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.usage_budgets
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- A routine firing refused by its member's budget fails with its own reason, which counts toward
-- the consecutive-failure switch-off like any failure. This replaces 028's constraint, so it
-- repeats every reason 028 lists. Keep it in step with skipReasons and failReasons in
-- src/service/routines.ts.
ALTER TABLE birbcrew_ts.routine_firings
    DROP CONSTRAINT routine_firings_reason_check,
    ADD CONSTRAINT routine_firings_reason_check CHECK ((CASE status
        WHEN 'skipped' THEN reason IN ('missed', 'overlap', 'owner_unavailable')
        WHEN 'failed' THEN reason IN ('rejected', 'approval_required', 'approval_expired', 'turn_failed', 'turn_cancelled',
            'turn_uncertain', 'usage_limit')
        WHEN 'admitted' THEN reason IS NULL OR reason = 'approval_required'
        WHEN 'waiting' THEN reason IS NULL OR reason = 'approval_required'
        ELSE reason IS NULL END) IS TRUE) NOT VALID;

-- 021's recipe. This constraint replaces 029's, so it repeats every type 029 lists. Keep it in
-- step with auditEvents in src/service/audit.ts. A budget change belongs to a member only; a
-- refusal names the refused request, which has no admission row.
ALTER TABLE birbcrew_ts.audit_events
    DROP CONSTRAINT audit_events_type_check,
    ADD CONSTRAINT audit_events_type_check CHECK (
        (event_type = 'member.spawned' AND conversation_id IS NULL AND request_id IS NULL)
        OR (event_type = 'conversation.opened' AND conversation_id IS NOT NULL AND request_id IS NULL)
        OR (event_type IN ('request.accepted', 'request.cancellation_requested', 'request.finished')
            AND conversation_id IS NOT NULL AND request_id IS NOT NULL)
        OR (event_type = 'approval.decided' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)
        OR (event_type = 'work_item.committed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'receiptId') = 'string') IS TRUE)
        OR (event_type = 'trusted_effect.completed' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'operationId') = 'string') IS TRUE)
        OR (event_type IN ('approval.auto_approved', 'grant.created') AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string' AND jsonb_typeof(payload->'grantId') = 'string') IS TRUE)
        OR (event_type = 'grant.revoked' AND request_id IS NULL
            AND (jsonb_typeof(payload->'grantId') = 'string' AND NOT payload ? 'approvalId') IS TRUE)
        OR (event_type IN ('routine.created', 'routine.enabled', 'routine.disabled', 'routine.deleted')
            AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'routineId') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'revision') = 'number') IS TRUE)
        OR (event_type = 'routine.firing_settled' AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'routineId') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'scheduledFor') = 'string') IS TRUE)
        OR (event_type IN ('memory.created', 'memory.deleted', 'memory.suspended')
            AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'memoryId') = 'string') IS TRUE)
        OR (event_type = 'conversation.handed_off' AND conversation_id IS NOT NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'handoffId') = 'string') IS TRUE)
        OR (event_type = 'approval.expired' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)
        OR (event_type = 'member.instructions_set' AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'digest') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'bytes') = 'number') IS TRUE)
        OR (event_type IN ('usage.budget_set', 'usage.budget_cleared')
            AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'revision') = 'number') IS TRUE)
        OR (event_type = 'usage.request_refused' AND conversation_id IS NOT NULL AND request_id IS NOT NULL)) NOT VALID;

-- Natural keys for the new facts. No existing row matches either predicate, so each index is
-- empty, but building each reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_usage_budget_fact ON birbcrew_ts.audit_events (member_id, (payload->>'revision'))
    WHERE event_type IN ('usage.budget_set', 'usage.budget_cleared');
CREATE UNIQUE INDEX audit_events_usage_refusal_fact ON birbcrew_ts.audit_events (conversation_id, request_id)
    WHERE event_type = 'usage.request_refused';
