-- Member capabilities (docs/member-capabilities.md). The operator's profile registration
-- stores a capability ceiling, and a member spawned with capabilities stores the set it was
-- given, which is within that ceiling and never changes. A profile without a ceiling and a
-- member without a row have no capabilities, as before this migration. No engine reads either
-- yet.
--
-- Locks on existing tables, held until migrate() commits: ACCESS EXCLUSIVE on profiles for
-- the new column (nullable with no default, and its CHECK is NOT VALID, so the table is
-- neither rewritten nor scanned), and SHARE ROW EXCLUSIVE on members for the foreign key. As
-- in 025 and 026 they are taken together with NOWAIT and retried, so the migration never
-- waits in a lock queue and never joins a deadlock. A native turn's admission transaction
-- holds only ACCESS SHARE on members, which SHARE ROW EXCLUSIVE allows, and nothing on
-- profiles, so a running turn never delays it. The member's set is a table of its own because
-- a column on members would need ACCESS EXCLUSIVE there and wait for every running turn.
-- After 60 s without the locks it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.profiles IN ACCESS EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.members IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

-- The shape a stored set must have, whoever writes it: an object at version 1 with at least
-- one capability (no set at all is NULL or no row, never an empty set), bounded, and a shell
-- only inside a writable workspace. capabilities.ts validates the rest and is the only place
-- that decides whether one set is within another. IS TRUE: a missing key yields NULL, which a
-- CHECK would otherwise accept.
ALTER TABLE birbcrew_ts.profiles
    -- The ceiling this registration allows its members. NULL allows none.
    ADD COLUMN capabilities jsonb,
    ADD CONSTRAINT profiles_capabilities_check CHECK (capabilities IS NULL OR (
        jsonb_typeof(capabilities) = 'object' AND capabilities->'version' = '1'::jsonb
        AND capabilities <> '{"version": 1}'::jsonb AND octet_length(capabilities::text) <= 16384
        AND (capabilities #> '{workspace,shell}' IS NULL OR capabilities #>> '{workspace,files}' = 'write')
    ) IS TRUE) NOT VALID;

CREATE FUNCTION birbcrew_ts.reject_capability_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Capabilities are fixed when they are first stored' USING ERRCODE = '23514';
END;
$$;
-- A registration's ceiling never changes, so a member checked against it at spawn stays within it.
CREATE TRIGGER profiles_capabilities_fixed BEFORE UPDATE ON birbcrew_ts.profiles
    FOR EACH ROW WHEN (OLD.capabilities IS DISTINCT FROM NEW.capabilities)
    EXECUTE FUNCTION birbcrew_ts.reject_capability_change();

CREATE TABLE birbcrew_ts.member_capabilities (
    member_id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    capabilities jsonb NOT NULL CONSTRAINT member_capabilities_check CHECK ((
        jsonb_typeof(capabilities) = 'object' AND capabilities->'version' = '1'::jsonb
        AND capabilities <> '{"version": 1}'::jsonb AND octet_length(capabilities::text) <= 16384
        AND (capabilities #> '{workspace,shell}' IS NULL OR capabilities #>> '{workspace,files}' = 'write')
    ) IS TRUE),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id)
);

-- The member must be visible to this lookup, belong to the row's owner, and name a profile
-- registration that carries a ceiling. As in bind_audit_conversation (021-audit.sql), a
-- member the lookup cannot see is refused here rather than left to the foreign key. Members
-- are immutable (001-members.sql) and a ceiling never changes, so the binding holds. Whether
-- the set is within the ceiling is decided by capabilities.ts in the transaction that inserts
-- the member; no trigger repeats it.
CREATE FUNCTION birbcrew_ts.bind_member_capabilities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM birbcrew_ts.members m
      JOIN birbcrew_ts.profiles p ON p.name = m.profile AND p.engine = m.engine
     WHERE m.owner_id = NEW.owner_id AND m.member_id = NEW.member_id AND p.capabilities IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member is missing, belongs to another owner, or its profile registers no capability ceiling'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER member_capabilities_binding BEFORE INSERT ON birbcrew_ts.member_capabilities
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.bind_member_capabilities();
-- Statement level so even a zero-row UPDATE or DELETE is refused.
CREATE TRIGGER member_capabilities_fixed BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_capabilities
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_capability_change();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.member_capabilities
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
