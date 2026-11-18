-- Owner-written member instructions (docs/member-instructions.md). An owner may give a member
-- instructions when it spawns it. Like the member's engine and profile they never change, so
-- every launch of every conversation of the member gives the model the same text.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members for the
-- new foreign key, and ACCESS EXCLUSIVE on audit_events to replace its type CHECK (dropped and
-- re-added NOT VALID, so no row is scanned) and to build one empty partial unique index, which
-- reads audit_events once. As in 025 and 026 they are taken together with NOWAIT and retried, so
-- the migration never waits in a lock queue and never joins a deadlock. A native turn's admission
-- transaction holds only ACCESS SHARE on members, which this mode allows, and nothing on
-- audit_events, so a running turn never delays it. After 60 s without the locks it fails with
-- 55P03 and applies nothing. Applied with 027 in one transaction it already holds both; applied
-- with 028 alone it retries while holding 028's locks, so admissions and audited writes wait, and
-- a spawn in flight, which holds members and waits to append its audit row, makes it fail.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

-- A table of its own, not a column on members: adding a column would take ACCESS EXCLUSIVE on
-- members and queue behind every running native turn.
CREATE TABLE birbcrew_ts.member_instructions (
    member_id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    -- instructionsBytes in domain.ts.
    body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 16384),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id)
);

-- Launches read the instructions afresh and conversations keep no snapshot of them, so a
-- conversation is stable only while the text never changes under it. Instructions therefore
-- arrive before the member's first conversation and are never edited or removed. The row lock
-- excludes the FOR KEY SHARE a conversation insert takes on its member, so an open either
-- commits before this check, which then sees it, or waits for this insert to commit.
CREATE FUNCTION birbcrew_ts.bind_member_instructions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM birbcrew_ts.members WHERE owner_id = NEW.owner_id AND member_id = NEW.member_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id = NEW.owner_id AND member_id = NEW.member_id) THEN
        RAISE EXCEPTION 'Member instructions are set before the member opens a conversation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_instructions_binding BEFORE INSERT ON birbcrew_ts.member_instructions
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.bind_member_instructions();
CREATE FUNCTION birbcrew_ts.reject_member_instructions_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Member instructions are fixed for the life of the member' USING ERRCODE = '23514';
END;
$$;
-- Statement level so even a zero-row UPDATE or DELETE, and TRUNCATE, are refused.
CREATE TRIGGER member_instructions_fixed BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_instructions
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_member_instructions_change();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_instructions
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 021's recipe. This constraint replaces 028's, so it repeats every type 028 lists. Keep it in
-- step with auditEvents in src/service/audit.ts. The instructions row belongs to no conversation
-- or request and never carries text: only its SHA-256 and byte count.
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
            AND (jsonb_typeof(payload->'bytes') = 'number') IS TRUE)) NOT VALID;

-- One row per member, as for member.spawned. No existing row matches the predicate, so the index
-- is empty, but building it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_member_instructions_fact ON birbcrew_ts.audit_events (member_id)
    WHERE event_type = 'member.instructions_set';
