-- Decision receipts (docs/decision-receipts.md). A caller may name its decision with a UUID; the
-- card records it with the choice, so a caller that lost the reply or restarted can read the exact
-- choice back. The name is scoped to its card: the same UUID on another card is another decision.
--
-- Lock on an existing table, held until migrate() commits: ACCESS EXCLUSIVE on deferred_calls,
-- taken with NOWAIT and retried as in 037, so the migration never waits in a lock queue. The new
-- column has no default and the constraint is NOT VALID, so the table is neither rewritten nor
-- scanned. No index: a receipt is always read by its card's identity, and a unique index across
-- cards would tell one owner whether another owner used a UUID.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
 LOOP
  BEGIN
   LOCK TABLE birbcrew_ts.deferred_calls IN ACCESS EXCLUSIVE MODE NOWAIT;
   RETURN;
  EXCEPTION WHEN lock_not_available THEN
   IF clock_timestamp() > deadline THEN RAISE; END IF;
  END;
  PERFORM pg_sleep(0.02 + random() * 0.08);
 END LOOP;
END $$;

ALTER TABLE birbcrew_ts.deferred_calls
    ADD COLUMN decision_id uuid,
    -- Only an owner's decision carries one, never a call a standing grant approved.
    ADD CONSTRAINT deferred_calls_decision_id_check
        CHECK (decision_id IS NULL OR (decision IS NOT NULL AND grant_id IS NULL)) NOT VALID;
