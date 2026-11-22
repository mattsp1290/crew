-- Additive policy; full-row guard_profile_child_authority keeps it immutable.
-- Fail without applying a schema version if a running turn prevents the DDL lock.
SET LOCAL lock_timeout = '5s';
ALTER TABLE birbcrew_ts.profiles
    ADD COLUMN request_text_bytes integer NOT NULL DEFAULT 16384,
    ADD CONSTRAINT profiles_request_text_bytes_check CHECK (
        request_text_bytes BETWEEN 16384 AND 65536
        AND (engine IN ('cursor', 'opencode') OR request_text_bytes = 16384)
    );
