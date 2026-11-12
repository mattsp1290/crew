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
-- holds only ACCESS SHARE on members and ROW SHARE on turns, which SHARE ROW EXCLUSIVE
-- allows, and nothing on profiles, so a running turn never delays it. The member's set is a
-- table of its own because a column on members would need ACCESS EXCLUSIVE there and wait for
-- every running turn. After 60 s without the locks it fails with 55P03 and applies nothing.
--
-- The block also takes the locks 033 needs, on turns and tool_grants. The two migrations
-- usually apply in one transaction; without this, 033 would retry for its own locks while
-- this one held ACCESS EXCLUSIVE on profiles, and every spawn and profile registration would
-- wait behind it for up to 60 s. Applied after other pending migrations in one transaction,
-- the block retries while holding their locks, as 026 describes for 025.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.turns, birbcrew_ts.tool_grants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            LOCK TABLE birbcrew_ts.profiles IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

-- The shape a stored set must have, whoever writes it: an object at version 1 that holds at
-- least one capability and no key but the known ones, at any level; a workspace that says
-- read or write; a shell only inside a writable workspace, with its network off or proxied; a
-- fetch whose hosts are "any" or a list that is not empty; a search with nothing in it; and at
-- most 16 KiB. capabilities.ts validates the rest (each host pattern, and how many) and is the
-- only place that decides whether one set is within another. IS TRUE: a missing key yields
-- NULL, which a CHECK would otherwise accept. The parentheses around -> and #> matter: binary
-- minus binds tighter than either.
ALTER TABLE birbcrew_ts.profiles
    -- The ceiling this registration allows its members. NULL allows none.
    ADD COLUMN capabilities jsonb,
    ADD CONSTRAINT profiles_capabilities_check CHECK (capabilities IS NULL OR (
        jsonb_typeof(capabilities) = 'object' AND capabilities->'version' = '1'::jsonb
        AND capabilities - '{version,workspace,webFetch,webSearch}'::text[] = '{}'::jsonb
        AND capabilities ?| '{workspace,webFetch,webSearch}'::text[]
        AND jsonb_typeof(coalesce(capabilities->'workspace', '{}')) = 'object'
        AND jsonb_typeof(coalesce(capabilities->'webFetch', '{}')) = 'object'
        AND jsonb_typeof(coalesce(capabilities->'webSearch', '{}')) = 'object'
        AND (capabilities->'workspace' IS NULL OR (capabilities #>> '{workspace,files}' IN ('read', 'write')
            AND ((capabilities->'workspace') - '{files,shell}'::text[]) = '{}'::jsonb))
        AND (capabilities #> '{workspace,shell}' IS NULL OR (capabilities #>> '{workspace,files}' = 'write'
            AND jsonb_typeof(capabilities #> '{workspace,shell}') = 'object'
            AND ((capabilities #> '{workspace,shell}') - 'network') = '{}'::jsonb
            AND capabilities #>> '{workspace,shell,network}' IN ('off', 'proxied')))
        AND (capabilities->'webFetch' IS NULL OR (((capabilities->'webFetch') - 'hosts') = '{}'::jsonb
            AND (capabilities #> '{webFetch,hosts}' = '"any"'::jsonb
                OR (jsonb_typeof(capabilities #> '{webFetch,hosts}') = 'array'
                    AND jsonb_array_length(capabilities #> '{webFetch,hosts}') > 0))))
        AND (capabilities->'webSearch' IS NULL OR capabilities->'webSearch' = '{}'::jsonb)
        AND octet_length(capabilities::text) <= 16384
    ) IS TRUE) NOT VALID;

CREATE FUNCTION birbcrew_ts.reject_capability_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Capabilities are fixed when they are first stored' USING ERRCODE = '23514';
END;
$$;
-- A member is checked against its registration's ceiling once, at spawn. So a ceiling never
-- changes, and a registration that has one is never renamed or removed: otherwise the same
-- name could be registered again with a narrower ceiling, or with none and a provider key,
-- under members that keep the set they were given.
CREATE TRIGGER profiles_capabilities_fixed BEFORE UPDATE ON birbcrew_ts.profiles
    FOR EACH ROW WHEN (OLD.capabilities IS DISTINCT FROM NEW.capabilities
        OR (OLD.capabilities IS NOT NULL AND (OLD.name, OLD.engine) IS DISTINCT FROM (NEW.name, NEW.engine)))
    EXECUTE FUNCTION birbcrew_ts.reject_capability_change();
CREATE TRIGGER profiles_capabilities_kept BEFORE DELETE ON birbcrew_ts.profiles
    FOR EACH ROW WHEN (OLD.capabilities IS NOT NULL) EXECUTE FUNCTION birbcrew_ts.reject_capability_change();
CREATE FUNCTION birbcrew_ts.keep_profile_ceilings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM birbcrew_ts.profiles WHERE capabilities IS NOT NULL) THEN
        RAISE EXCEPTION 'A registration with a capability ceiling is kept' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER profiles_capabilities_not_truncated BEFORE TRUNCATE ON birbcrew_ts.profiles
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.keep_profile_ceilings();

CREATE TABLE birbcrew_ts.member_capabilities (
    member_id uuid PRIMARY KEY,
    owner_id text NOT NULL,
    capabilities jsonb NOT NULL CONSTRAINT member_capabilities_check CHECK ((
        jsonb_typeof(capabilities) = 'object' AND capabilities->'version' = '1'::jsonb
        AND capabilities - '{version,workspace,webFetch,webSearch}'::text[] = '{}'::jsonb
        AND capabilities ?| '{workspace,webFetch,webSearch}'::text[]
        AND jsonb_typeof(coalesce(capabilities->'workspace', '{}')) = 'object'
        AND jsonb_typeof(coalesce(capabilities->'webFetch', '{}')) = 'object'
        AND jsonb_typeof(coalesce(capabilities->'webSearch', '{}')) = 'object'
        AND (capabilities->'workspace' IS NULL OR (capabilities #>> '{workspace,files}' IN ('read', 'write')
            AND ((capabilities->'workspace') - '{files,shell}'::text[]) = '{}'::jsonb))
        AND (capabilities #> '{workspace,shell}' IS NULL OR (capabilities #>> '{workspace,files}' = 'write'
            AND jsonb_typeof(capabilities #> '{workspace,shell}') = 'object'
            AND ((capabilities #> '{workspace,shell}') - 'network') = '{}'::jsonb
            AND capabilities #>> '{workspace,shell,network}' IN ('off', 'proxied')))
        AND (capabilities->'webFetch' IS NULL OR (((capabilities->'webFetch') - 'hosts') = '{}'::jsonb
            AND (capabilities #> '{webFetch,hosts}' = '"any"'::jsonb
                OR (jsonb_typeof(capabilities #> '{webFetch,hosts}') = 'array'
                    AND jsonb_array_length(capabilities #> '{webFetch,hosts}') > 0))))
        AND (capabilities->'webSearch' IS NULL OR capabilities->'webSearch' = '{}'::jsonb)
        AND octet_length(capabilities::text) <= 16384
    ) IS TRUE),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id)
);

-- The member must be visible to this lookup, belong to the row's owner, and name a profile
-- registration that carries a ceiling. As in bind_audit_conversation (021-audit.sql), a
-- member the lookup cannot see is refused here rather than left to the foreign key. Members
-- are immutable (001-members.sql), and a registration with a ceiling keeps it and stays, so
-- the binding holds. Whether the set is within the ceiling is decided by capabilities.ts in
-- the transaction that inserts the member; no trigger repeats it.
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
