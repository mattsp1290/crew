-- Approval expiry (docs/approval-expiry.md). An owner may bound how long a Claude or Pi card may
-- wait: a request, or every firing of a routine, carries an approval deadline in seconds. A
-- top-level card proposed for such a request records when it expires. The conversation workflow
-- waits for an answer until then and asks SQL to settle the card; a decision commits only before
-- the deadline, and an expiry only after it with no decision, under the conversation lock. An
-- expired card cancels its request as an owner's cancel does, and the card records that its
-- deadline settled it.
--
-- Locks on existing tables, held until migrate() commits: ACCESS EXCLUSIVE on deferred_calls,
-- request_admissions, routines, routine_firings and audit_events. New columns have no default
-- and every new constraint is NOT VALID, so no table is rewritten or scanned to check them; the
-- one scan is the empty unique index build on audit_events. Crew takes these tables in several
-- orders (an admission writes request_admissions then audit_events, an audit append locks
-- audit_events and then reads request_admissions, the routine dispatcher locks routines then
-- routine_firings, a firing's admission the reverse), so, as in 025, all five are taken together
-- with NOWAIT and retried: the migration never waits in a lock queue and never joins a deadlock.
-- Applied alone it holds nothing while it retries; applied with earlier migrations in one
-- transaction it retries while holding their locks, and admissions and audited writes wait.
-- A native turn's admission transaction (native-admission.ts) touches none of them, so a running
-- turn never delays it. After 60 s without the locks it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.deferred_calls, birbcrew_ts.request_admissions, birbcrew_ts.routines,
                birbcrew_ts.routine_firings, birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

-- approvalDeadline in domain.ts repeats the bounds. NULL: a card waits for an answer as before.
ALTER TABLE birbcrew_ts.request_admissions
    ADD COLUMN approval_deadline_seconds integer,
    ADD CONSTRAINT request_admissions_approval_deadline_check
        CHECK (approval_deadline_seconds BETWEEN 60 AND 604800) NOT VALID;

-- A request's terms are fixed at admission, like its initiator (023-request-initiator.sql).
CREATE FUNCTION birbcrew_ts.reject_approval_deadline_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A request approval deadline is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_approval_deadline
    BEFORE UPDATE OF approval_deadline_seconds ON birbcrew_ts.request_admissions FOR EACH ROW
    WHEN (OLD.approval_deadline_seconds IS DISTINCT FROM NEW.approval_deadline_seconds)
    EXECUTE FUNCTION birbcrew_ts.reject_approval_deadline_change();

ALTER TABLE birbcrew_ts.deferred_calls
    -- When a top-level card stops accepting a decision: its proposal time plus the request's
    -- deadline. A Codex live card keeps its own deadline in codex_live_calls instead, and a Pi
    -- child card or a call a standing grant approved has none.
    ADD COLUMN expires_at timestamptz,
    -- Set once, when Crew settles the undecided card at its deadline.
    ADD COLUMN expired_at timestamptz,
    -- An expired card has no decision, so a decision and an expiry can never both commit.
    ADD CONSTRAINT deferred_calls_expiry_check CHECK (
        (expires_at IS NULL OR (invocation_id = request_id AND grant_id IS NULL))
        AND (expired_at IS NULL OR (decision IS NULL AND expires_at IS NOT NULL AND expired_at >= expires_at))) NOT VALID;

-- Every firing of a routine gets the routine's deadline. The definition stays immutable.
ALTER TABLE birbcrew_ts.routines
    ADD COLUMN approval_deadline_seconds integer,
    ADD CONSTRAINT routines_approval_deadline_check CHECK (approval_deadline_seconds BETWEEN 60 AND 604800) NOT VALID;
CREATE OR REPLACE FUNCTION birbcrew_ts.guard_routine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Routines are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.routine_id, OLD.owner_id, OLD.create_request_id, OLD.member_id, OLD.schedule, OLD.prompt,
        OLD.approval_policy, OLD.created_at, OLD.approval_deadline_seconds) IS DISTINCT FROM (NEW.routine_id,
        NEW.owner_id, NEW.create_request_id, NEW.member_id, NEW.schedule, NEW.prompt, NEW.approval_policy,
        NEW.created_at, NEW.approval_deadline_seconds) THEN
        RAISE EXCEPTION 'A routine definition is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'deleted' AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'A deleted routine never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

-- 025 left this CHECK unnamed, so PostgreSQL named it routine_firings_check4. The replacement
-- has a name and adds approval_expired, a firing whose card expired, to the failed reasons.
ALTER TABLE birbcrew_ts.routine_firings
    DROP CONSTRAINT routine_firings_check4,
    ADD CONSTRAINT routine_firings_reason_check CHECK ((CASE status
        WHEN 'skipped' THEN reason IN ('missed', 'overlap', 'owner_unavailable')
        WHEN 'failed' THEN reason IN ('rejected', 'approval_required', 'approval_expired', 'turn_failed', 'turn_cancelled',
            'turn_uncertain')
        WHEN 'admitted' THEN reason IS NULL OR reason = 'approval_required'
        WHEN 'waiting' THEN reason IS NULL OR reason = 'approval_required'
        ELSE reason IS NULL END) IS TRUE) NOT VALID;

-- 021's recipe. This constraint replaces 027's, so it repeats every type 027 lists. Keep it in
-- step with auditEvents in src/service/audit.ts.
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
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)) NOT VALID;

-- One expiry per card. No existing row matches the predicate, so the index is empty, but building
-- it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_expiry_fact ON birbcrew_ts.audit_events ((payload->>'approvalId'))
    WHERE event_type = 'approval.expired';
