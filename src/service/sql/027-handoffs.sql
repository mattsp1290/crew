-- Conversation handoff (docs/handoffs.md). An owner hands a conversation of one of their members to
-- another of their members. One row records it: the source, which it seals, the new target
-- conversation, the request it reserves for the target's first turn, and the transcript that turn
-- carries. The row is the only authority that lets an admission record the handoff initiator, and
-- only for that reserved request (handoffs.ts, recordAcceptance).
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members and
-- conversations for the new foreign keys; ACCESS EXCLUSIVE on request_admissions and audit_events
-- to replace their CHECKs (dropped and re-added NOT VALID, so no row is scanned) and to build one
-- empty partial unique index, which reads audit_events once. As 025 explains, Crew takes
-- request_admissions and audit_events in both orders, so all four are taken together with NOWAIT
-- and retried: the migration never waits in a lock queue and never joins a deadlock. A native
-- turn's admission transaction holds only ACCESS SHARE on members and conversations and nothing on
-- the other two, so a running turn never delays it. After 60 s without the locks it fails with
-- 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.conversations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.request_admissions, birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE TABLE birbcrew_ts.conversation_handoffs (
    handoff_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    -- The client's idempotency key: a retry returns this row and never creates a second target.
    request_id uuid NOT NULL,
    -- One handoff per source: a source with a row is sealed to new requests.
    source_conversation_id uuid NOT NULL UNIQUE REFERENCES birbcrew_ts.conversations (conversation_id),
    source_member_id uuid NOT NULL,
    target_conversation_id uuid NOT NULL UNIQUE REFERENCES birbcrew_ts.conversations (conversation_id),
    target_member_id uuid NOT NULL,
    -- The server's request identity for the target's first turn, drawn once here.
    first_request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    -- turnTextBytes in domain.ts.
    transcript text NOT NULL CHECK (octet_length(transcript) BETWEEN 1 AND 65536),
    transcript_digest bytea NOT NULL CHECK (transcript_digest = sha256(convert_to(transcript, 'UTF8'))),
    carried_turns smallint NOT NULL CHECK (carried_turns BETWEEN 1 AND 128),
    omitted_turns smallint NOT NULL CHECK (omitted_turns BETWEEN 0 AND 127),
    uncertain_turns smallint NOT NULL CHECK (uncertain_turns BETWEEN 0 AND 128),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_id, request_id),
    FOREIGN KEY (owner_id, source_member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    FOREIGN KEY (owner_id, target_member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    CHECK (source_conversation_id <> target_conversation_id),
    CHECK (carried_turns + omitted_turns + uncertain_turns <= 128)
);

-- As bind_audit_conversation (021-audit.sql) does for audit rows: both conversations must be
-- visible to this lookup and belong to the row's owner and to the member it names, whoever
-- writes it. A conversation's owner and member never change and it cannot be deleted, so the
-- binding holds until commit.
CREATE FUNCTION birbcrew_ts.bind_conversation_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM birbcrew_ts.conversations WHERE conversation_id = NEW.source_conversation_id
        AND owner_id = NEW.owner_id AND member_id = NEW.source_member_id;
    IF FOUND THEN
        PERFORM 1 FROM birbcrew_ts.conversations WHERE conversation_id = NEW.target_conversation_id
            AND owner_id = NEW.owner_id AND member_id = NEW.target_member_id;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Handoff conversation is missing or belongs to another owner or member' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER conversation_handoffs_binding BEFORE INSERT ON birbcrew_ts.conversation_handoffs
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.bind_conversation_handoff();
-- The seal and the reserved request rest on this row, so it never changes and is never removed.
CREATE FUNCTION birbcrew_ts.reject_handoff_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A conversation handoff never changes' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER conversation_handoffs_fixed BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.conversation_handoffs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_handoff_change();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.conversation_handoffs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 023's recipe: drop and re-add NOT VALID in one ALTER TABLE. This replaces 025's constraint, so it
-- repeats its kinds. A handoff names itself by id.
ALTER TABLE birbcrew_ts.request_admissions
    DROP CONSTRAINT request_admissions_initiator_kind_check,
    ADD CONSTRAINT request_admissions_initiator_kind_check CHECK (initiator_kind IN ('owner', 'routine', 'handoff')) NOT VALID;

-- 021's recipe. The initiator constraint replaces 025's and the type constraint 026's, so each
-- repeats every value they list. Only request-tied rows copy an admission's initiator, so only they
-- can name a routine or a handoff. Keep the type list in step with auditEvents in src/service/audit.ts.
-- A handoff row names the source conversation and never carries transcript text.
ALTER TABLE birbcrew_ts.audit_events
    DROP CONSTRAINT audit_events_initiator_check,
    ADD CONSTRAINT audit_events_initiator_check CHECK (
        (initiator_kind = 'owner' AND initiator_id = owner_id)
        OR (initiator_kind = 'routine' AND initiator_id IS NOT NULL AND request_id IS NOT NULL)
        OR (initiator_kind = 'handoff' AND initiator_id IS NOT NULL AND request_id IS NOT NULL)) NOT VALID,
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
            AND (jsonb_typeof(payload->'handoffId') = 'string') IS TRUE)) NOT VALID;

-- One row per handoff. No existing row matches the predicate, so the index is empty, but building
-- it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_handoff_fact ON birbcrew_ts.audit_events ((payload->>'handoffId'))
    WHERE event_type = 'conversation.handed_off';
