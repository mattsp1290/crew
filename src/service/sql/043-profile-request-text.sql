-- Additive policy; full-row guard_profile_child_authority keeps it immutable.
-- Retry without queueing behind a running turn; do not stall later profile readers.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '5 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.profiles IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;
ALTER TABLE birbcrew_ts.profiles
    ADD COLUMN request_text_bytes integer NOT NULL DEFAULT 16384,
    ADD CONSTRAINT profiles_request_text_bytes_check CHECK (
        request_text_bytes BETWEEN 16384 AND 65536
        AND (engine IN ('cursor', 'opencode') OR request_text_bytes = 16384)
    );
