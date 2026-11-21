-- Text-engine members (cursor, opencode). ACCESS EXCLUSIVE conflicts with the ACCESS SHARE a
-- native admission holds from BEGIN until the driver returns. supervisor-runner bounds that call
-- at 170 seconds, so this waits longer than one admission and then fails closed: 55P03 applies
-- nothing and the new process exits. The previous process keeps serving. Do not wait in the lock
-- queue.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '200 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.profiles, birbcrew_ts.conversations
                IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

ALTER TABLE birbcrew_ts.members
    DROP CONSTRAINT members_engine_check,
    ADD CONSTRAINT members_engine_check CHECK (engine IN ('pi', 'claude', 'codex', 'cursor', 'opencode'));

ALTER TABLE birbcrew_ts.profiles
    DROP CONSTRAINT profiles_engine_check,
    ADD CONSTRAINT profiles_engine_check CHECK (engine IN ('pi', 'claude', 'codex', 'cursor', 'opencode'));

-- profiles_native_volume_check stays: claude and codex still require a volume. cursor and
-- opencode store volume NULL.
ALTER TABLE birbcrew_ts.conversations
    DROP CONSTRAINT conversations_turn_limit_check,
    ADD CONSTRAINT conversations_turn_limit_check CHECK (turn_limit IN (1, 4, 128));

-- The column default remains 128. A text-engine insert must supply 1; every other engine must
-- not use 1. The trigger does not rewrite the value.
CREATE FUNCTION birbcrew_ts.reject_text_engine_turn_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE member_engine text;
BEGIN
    SELECT engine INTO member_engine FROM birbcrew_ts.members
     WHERE owner_id = NEW.owner_id AND member_id = NEW.member_id;
    IF member_engine IN ('cursor', 'opencode') THEN
        IF NEW.turn_limit IS DISTINCT FROM 1 THEN
            RAISE EXCEPTION 'text engine turn_limit must be 1' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.turn_limit = 1 THEN
        RAISE EXCEPTION 'turn_limit 1 is only for a text engine' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER conversations_text_engine_turn_limit
    BEFORE INSERT OR UPDATE OF turn_limit ON birbcrew_ts.conversations
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.reject_text_engine_turn_limit();
