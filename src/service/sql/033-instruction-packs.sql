-- Reusable instruction packs (docs/instruction-packs.md). An owner writes named packs of
-- instruction text through the API, and attaches up to eight of them, in order, to a member when
-- it spawns it. Like the member's own instructions (029), a member's packs never change, so every
-- launch of every conversation of the member gives the model the same text.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members for the
-- new foreign key, and ACCESS EXCLUSIVE on audit_events to replace its member and type CHECKs
-- (dropped and re-added NOT VALID, so no row is scanned) and to build two empty partial unique
-- indexes, each of which reads audit_events once. As in 029 they are taken together with NOWAIT
-- and retried, so the migration never waits in a lock queue and never joins a deadlock. A native
-- turn's admission transaction holds ACCESS SHARE and ROW SHARE (FOR SHARE) only, which these modes
-- allow, so a running turn never delays it. Applied alone it holds nothing while it retries;
-- applied after earlier migrations in one transaction it retries while holding their locks, and
-- admissions and audited writes wait. After 60 s without the locks it fails with 55P03 and applies
-- nothing.
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

-- packLimits in instruction-packs.ts. A pack is immutable: new text is a new pack. Deletion erases
-- everything the owner wrote and keeps the row, so a replayed create can be answered.
CREATE TABLE birbcrew_ts.instruction_packs (
    pack_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    create_request_id uuid NOT NULL,
    name text CHECK (octet_length(name) BETWEEN 1 AND 128),
    description text CHECK (octet_length(description) BETWEEN 1 AND 512),
    body text CHECK (octet_length(body) BETWEEN 1 AND 16384),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    UNIQUE (owner_id, create_request_id),
    -- The attachment's foreign key names the owner too, so a member can only use its own owner's packs.
    UNIQUE (owner_id, pack_id),
    CHECK ((state = 'deleted') = (body IS NULL) AND (state = 'deleted') = (name IS NULL)
        AND (state = 'deleted') = (deleted_at IS NOT NULL) AND (state = 'active' OR description IS NULL))
);
CREATE INDEX instruction_packs_active ON birbcrew_ts.instruction_packs (owner_id) WHERE state = 'active';

-- At most 32 active packs per owner (packLimits.activePerOwner in instruction-packs.ts), as
-- limit_active_memories in 026-memories.sql does for memory. Only an insert makes a pack active.
CREATE FUNCTION birbcrew_ts.limit_active_instruction_packs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('birbcrew_ts.instruction_packs/' || NEW.owner_id, 0));
    IF (SELECT count(*) FROM birbcrew_ts.instruction_packs WHERE owner_id = NEW.owner_id AND state = 'active'
          AND pack_id <> NEW.pack_id AND create_request_id <> NEW.create_request_id) >= 32 THEN
        RAISE EXCEPTION 'An owner may have at most 32 active instruction packs'
            USING ERRCODE = '23514', CONSTRAINT = 'instruction_packs_active_limit';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER instruction_packs_active_limit BEFORE INSERT ON birbcrew_ts.instruction_packs
    FOR EACH ROW WHEN (NEW.state = 'active') EXECUTE FUNCTION birbcrew_ts.limit_active_instruction_packs();

-- Which packs each member received at spawn, in the order the model reads them.
CREATE TABLE birbcrew_ts.member_instruction_packs (
    member_id uuid NOT NULL,
    -- packLimits.perMember in instruction-packs.ts.
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 8),
    owner_id text NOT NULL,
    pack_id uuid NOT NULL,
    PRIMARY KEY (member_id, position),
    UNIQUE (member_id, pack_id),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    FOREIGN KEY (owner_id, pack_id) REFERENCES birbcrew_ts.instruction_packs (owner_id, pack_id)
);
CREATE INDEX member_instruction_packs_pack ON birbcrew_ts.member_instruction_packs (pack_id);

-- A pack never changes, and one attached to a member is never deleted, so a member's packs are
-- the same text for its whole life. The row lock an UPDATE takes before this trigger runs waits
-- for an attachment holding the pack FOR SHARE, and the check below, a later statement under READ
-- COMMITTED, then sees that attachment.
CREATE FUNCTION birbcrew_ts.guard_instruction_pack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Instruction packs are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.pack_id, OLD.owner_id, OLD.create_request_id, OLD.created_at)
        IS DISTINCT FROM (NEW.pack_id, NEW.owner_id, NEW.create_request_id, NEW.created_at) THEN
        RAISE EXCEPTION 'An instruction pack identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = NEW.state THEN
        IF OLD IS DISTINCT FROM NEW THEN
            RAISE EXCEPTION 'An instruction pack never changes; create another' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.state <> 'active' THEN
        RAISE EXCEPTION 'A deleted instruction pack never changes' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM birbcrew_ts.member_instruction_packs WHERE pack_id = OLD.pack_id) THEN
        RAISE EXCEPTION 'An instruction pack attached to a member is never deleted'
            USING ERRCODE = '23514', CONSTRAINT = 'instruction_packs_in_use';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER instruction_packs_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.instruction_packs
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_instruction_pack();

-- As bind_member_instructions in 029: packs arrive before the member's first conversation, so
-- every conversation sees the same packs, or none, from its first launch on. The pack row lock
-- excludes a concurrent delete, which then sees this attachment, or waits for the delete and finds
-- the pack gone.
CREATE FUNCTION birbcrew_ts.bind_member_instruction_pack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM birbcrew_ts.members WHERE owner_id = NEW.owner_id AND member_id = NEW.member_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM birbcrew_ts.conversations WHERE owner_id = NEW.owner_id AND member_id = NEW.member_id) THEN
        RAISE EXCEPTION 'Instruction packs are attached before the member opens a conversation' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM birbcrew_ts.instruction_packs WHERE owner_id = NEW.owner_id AND pack_id = NEW.pack_id AND state = 'active' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Only an active instruction pack of the member''s owner can be attached' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_instruction_packs_binding BEFORE INSERT ON birbcrew_ts.member_instruction_packs
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.bind_member_instruction_pack();
CREATE FUNCTION birbcrew_ts.reject_member_instruction_packs_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'A member''s instruction packs are fixed for the life of the member' USING ERRCODE = '23514';
END;
$$;
-- Statement level so even a zero-row UPDATE or DELETE, and TRUNCATE, are refused.
CREATE TRIGGER member_instruction_packs_fixed BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_instruction_packs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_member_instruction_packs_change();
CREATE FUNCTION birbcrew_ts.reject_instruction_pack_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Instruction packs are kept as tombstones' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER instruction_packs_kept BEFORE TRUNCATE ON birbcrew_ts.instruction_packs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_instruction_pack_truncate();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.instruction_packs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_instruction_packs
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 021's recipe. These constraints replace 032's, so they repeat every clause 032 lists, unchanged.
-- Keep them in step with auditEvents in src/service/audit.ts. A pack is the owner's, not a
-- member's, so its rows name no member; the attachment row belongs to the member it was spawned
-- with. None carries pack text, a name or a description: identifiers only.
ALTER TABLE birbcrew_ts.audit_events
    DROP CONSTRAINT audit_events_member_check,
    ADD CONSTRAINT audit_events_member_check CHECK (member_id IS NOT NULL
        OR event_type IN ('webhook.created', 'webhook.enabled', 'webhook.disabled', 'webhook.deleted',
            'instruction_pack.created', 'instruction_pack.deleted')) NOT VALID,
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
        OR (event_type = 'usage.request_refused' AND conversation_id IS NOT NULL AND request_id IS NOT NULL)
        OR (event_type = 'approval.requested' AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'approvalId') = 'string') IS TRUE)
        OR (event_type IN ('webhook.created', 'webhook.enabled', 'webhook.disabled', 'webhook.deleted')
            AND member_id IS NULL AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'webhookId') = 'string') IS TRUE
            AND (jsonb_typeof(payload->'revision') = 'number') IS TRUE)
        OR (event_type IN ('instruction_pack.created', 'instruction_pack.deleted')
            AND member_id IS NULL AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'packId') = 'string') IS TRUE)
        OR (event_type = 'member.instruction_packs_attached' AND conversation_id IS NULL AND request_id IS NULL
            AND (jsonb_typeof(payload->'packIds') = 'array') IS TRUE)) NOT VALID;

-- Natural keys for the new facts: each happens once per pack, and once per member as
-- member.instructions_set does. No existing row matches either predicate, so each index is empty,
-- but building it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_instruction_pack_fact ON birbcrew_ts.audit_events ((payload->>'packId'), event_type)
    WHERE event_type IN ('instruction_pack.created', 'instruction_pack.deleted');
CREATE UNIQUE INDEX audit_events_member_instruction_packs_fact ON birbcrew_ts.audit_events (member_id)
    WHERE event_type = 'member.instruction_packs_attached';
