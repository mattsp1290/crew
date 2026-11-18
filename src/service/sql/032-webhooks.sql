-- Outbound webhooks (docs/webhooks.md). An owner registers HTTPS endpoints; the gateway's
-- dispatcher (src/service/webhooks.ts) reads committed audit rows after a cursor, records one
-- delivery per endpoint and event in an outbox, and posts a small signed body to each.
--
-- Locks on existing tables, held until migrate() commits: ACCESS EXCLUSIVE on audit_events to drop
-- NOT NULL from member_id (webhook rows belong to no member), add a member CHECK and replace the
-- type CHECK (both NOT VALID, so no row is scanned), and SHARE for two empty partial unique index
-- builds, which read audit_events once each. No other existing table is locked. As in 025 to 031 the
-- lock is taken with NOWAIT and retried, so the migration never waits in a lock queue, where every
-- audited write would queue behind it. Applied alone, from version 31, it holds nothing while it
-- retries; applied after 031 in one transaction it already holds the lock. After 60 s without the
-- lock it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE TABLE birbcrew_ts.webhook_endpoints (
    webhook_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    create_request_id uuid NOT NULL,
    -- Erased, with the secret, when the endpoint is deleted: a URL path can itself be a credential.
    url text CHECK (octet_length(url) BETWEEN 1 AND 2048),
    -- The URL's host and port, kept after deletion for the tombstone and the audit trail.
    host text NOT NULL CHECK (octet_length(host) BETWEEN 1 AND 300),
    -- webhookKinds in webhooks.ts; stored sorted and distinct.
    kinds text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 4
        AND kinds <@ ARRAY['approval.pending', 'request.finished', 'routine.firing_settled', 'routine.disabled']::text[]),
    -- The HMAC key, returned once at creation. Stored as text: Crew has no vault (docs/webhooks.md).
    secret text CHECK (secret ~ '^[A-Za-z0-9_-]{43}$'),
    state text NOT NULL CHECK (state IN ('enabled', 'disabled', 'deleted')),
    disabled_reason text CHECK (disabled_reason IN ('owner', 'consecutive_failures', 'recovery_restore')),
    -- webhookLimits.consecutiveFailures: deliveries given up on in a row.
    consecutive_failures smallint NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 10),
    -- Events that occurred from this database time on are delivered; only an enabled endpoint has one.
    enabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Raised by every lifecycle change; with webhook_id it keys that change's audit row.
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (owner_id, create_request_id),
    CHECK ((state = 'disabled') = (disabled_reason IS NOT NULL)),
    CHECK ((state = 'enabled') = (enabled_at IS NOT NULL)),
    CHECK ((state = 'deleted') = (url IS NULL) AND (state = 'deleted') = (secret IS NULL))
);
CREATE INDEX webhook_endpoints_enabled ON birbcrew_ts.webhook_endpoints (owner_id) WHERE state = 'enabled';
CREATE INDEX webhook_endpoints_owner_page ON birbcrew_ts.webhook_endpoints (owner_id, webhook_id);

-- At most 10 enabled endpoints per owner (webhookLimits.enabledPerOwner in webhooks.ts), as
-- limit_enabled_routines in 025-routines.sql does for routines.
CREATE FUNCTION birbcrew_ts.limit_enabled_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.state = 'enabled' THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('birbcrew_ts.webhook_endpoints/' || NEW.owner_id, 0));
    IF (SELECT count(*) FROM birbcrew_ts.webhook_endpoints WHERE owner_id = NEW.owner_id AND state = 'enabled'
          AND webhook_id <> NEW.webhook_id AND create_request_id <> NEW.create_request_id) >= 10 THEN
        RAISE EXCEPTION 'An owner may have at most 10 enabled webhook endpoints'
            USING ERRCODE = '23514', CONSTRAINT = 'webhook_endpoints_enabled_limit';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_endpoints_enabled_limit BEFORE INSERT OR UPDATE OF state ON birbcrew_ts.webhook_endpoints
    FOR EACH ROW WHEN (NEW.state = 'enabled') EXECUTE FUNCTION birbcrew_ts.limit_enabled_webhooks();

-- The target and kinds never change (a new URL is a new endpoint), the URL and secret are only
-- ever erased, and a deleted endpoint is a tombstone that keeps its id and history.
CREATE FUNCTION birbcrew_ts.guard_webhook_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook endpoints are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.webhook_id, OLD.owner_id, OLD.create_request_id, OLD.host, OLD.kinds, OLD.created_at)
        IS DISTINCT FROM (NEW.webhook_id, NEW.owner_id, NEW.create_request_id, NEW.host, NEW.kinds, NEW.created_at) THEN
        RAISE EXCEPTION 'A webhook endpoint definition is immutable' USING ERRCODE = '23514';
    END IF;
    IF (NEW.url IS NOT NULL AND NEW.url IS DISTINCT FROM OLD.url) OR (NEW.secret IS NOT NULL AND NEW.secret IS DISTINCT FROM OLD.secret) THEN
        RAISE EXCEPTION 'A webhook endpoint URL and secret can only be erased' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'deleted' AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'A deleted webhook endpoint never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_endpoints_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_webhook_endpoint();

-- The outbox: one row per endpoint and audit event. No foreign key to audit_events: its rows are
-- never updated or deleted, and a key would lock each audit row a delivery names.
CREATE TABLE birbcrew_ts.webhook_deliveries (
    webhook_id uuid NOT NULL REFERENCES birbcrew_ts.webhook_endpoints,
    event_id bigint NOT NULL CHECK (event_id > 0),
    kind text NOT NULL CHECK (kind IN ('approval.pending', 'request.finished', 'routine.firing_settled', 'routine.disabled')),
    -- The exact bytes every attempt signs and sends: identifiers, the kind, the time and a status.
    body text NOT NULL CHECK (octet_length(body) BETWEEN 2 AND 1024),
    state text NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
    reason text,
    -- webhookLimits.maximumAttempts. Counted when an attempt is claimed, so a crash still counts.
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
    next_attempt_at timestamptz,
    lease_until timestamptz,
    last_attempt_at timestamptz,
    last_outcome text CHECK (last_outcome IN ('delivered', 'http_status', 'timeout', 'network', 'address_refused',
        'url_refused', 'interrupted')),
    last_status_code smallint CHECK (last_status_code BETWEEN 100 AND 599),
    created_at timestamptz NOT NULL,
    settled_at timestamptz,
    PRIMARY KEY (webhook_id, event_id),
    CHECK ((state = 'pending') = (next_attempt_at IS NOT NULL)),
    CHECK ((state = 'delivering') = (lease_until IS NOT NULL)),
    CHECK ((state IN ('delivered', 'failed', 'cancelled')) = (settled_at IS NOT NULL)),
    CHECK ((attempts = 0) = (last_attempt_at IS NULL)),
    CHECK ((last_status_code IS NOT NULL) = (last_outcome IS NOT NULL AND last_outcome IN ('delivered', 'http_status'))),
    CHECK (state <> 'delivered' OR (last_outcome = 'delivered' AND last_status_code BETWEEN 200 AND 299)),
    -- IS TRUE: a NULL reason makes IN yield NULL, which a CHECK would otherwise accept.
    CHECK ((CASE state
        WHEN 'failed' THEN reason = 'attempts_exhausted'
        WHEN 'cancelled' THEN reason IN ('endpoint_disabled', 'endpoint_deleted', 'recovery_restore')
        ELSE reason IS NULL END) IS TRUE)
);
CREATE INDEX webhook_deliveries_open ON birbcrew_ts.webhook_deliveries (webhook_id, event_id)
    WHERE state IN ('pending', 'delivering');

-- A delivery's identity and body never change, attempts only grow, and a settled delivery is history.
CREATE FUNCTION birbcrew_ts.guard_webhook_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook deliveries are kept' USING ERRCODE = '23514';
    END IF;
    IF (OLD.webhook_id, OLD.event_id, OLD.kind, OLD.body, OLD.created_at)
        IS DISTINCT FROM (NEW.webhook_id, NEW.event_id, NEW.kind, NEW.body, NEW.created_at) OR NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'A webhook delivery identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state IN ('delivered', 'failed', 'cancelled') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'A settled webhook delivery never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_deliveries_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_webhook_delivery();

-- The highest audit event ID the dispatcher has fanned out. It starts at the current end of the
-- trail, so no earlier event is ever delivered, and it only moves forward.
CREATE TABLE birbcrew_ts.webhook_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    last_event_id bigint NOT NULL CHECK (last_event_id >= 0)
);
INSERT INTO birbcrew_ts.webhook_cursor (last_event_id) SELECT coalesce(max(event_id), 0) FROM birbcrew_ts.audit_events;
CREATE FUNCTION birbcrew_ts.guard_webhook_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.last_event_id < OLD.last_event_id THEN
        RAISE EXCEPTION 'The webhook cursor only moves forward' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_cursor_guard BEFORE UPDATE OR DELETE ON birbcrew_ts.webhook_cursor
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_webhook_cursor();

CREATE FUNCTION birbcrew_ts.reject_webhook_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Webhook state is kept' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER webhook_endpoints_kept BEFORE TRUNCATE ON birbcrew_ts.webhook_endpoints
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_webhook_truncate();
CREATE TRIGGER webhook_deliveries_kept BEFORE TRUNCATE ON birbcrew_ts.webhook_deliveries
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_webhook_truncate();
CREATE TRIGGER webhook_cursor_kept BEFORE TRUNCATE ON birbcrew_ts.webhook_cursor
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_webhook_truncate();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.webhook_endpoints
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.webhook_deliveries
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.webhook_cursor
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

-- 021's recipe. This constraint replaces 031's, so it repeats every clause 031 lists, unchanged.
-- Keep it in step with auditEvents in src/service/audit.ts. approval.requested is a card or question that
-- became pending; the webhook facts belong to no member, conversation or request, and carry the
-- endpoint's host, never its URL or secret. Dropping NOT NULL is a catalog change: no row is read.
ALTER TABLE birbcrew_ts.audit_events
    ALTER COLUMN member_id DROP NOT NULL,
    ADD CONSTRAINT audit_events_member_check CHECK (member_id IS NOT NULL
        OR event_type IN ('webhook.created', 'webhook.enabled', 'webhook.disabled', 'webhook.deleted')) NOT VALID,
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
            AND (jsonb_typeof(payload->'revision') = 'number') IS TRUE)) NOT VALID;

-- Natural keys for the new facts. No existing row matches either predicate, so each index is
-- empty, but building it reads audit_events once while the lock above is held.
CREATE UNIQUE INDEX audit_events_approval_request_fact ON birbcrew_ts.audit_events ((payload->>'approvalId'))
    WHERE event_type = 'approval.requested';
CREATE UNIQUE INDEX audit_events_webhook_fact ON birbcrew_ts.audit_events ((payload->>'webhookId'), (payload->>'revision'))
    WHERE event_type IN ('webhook.created', 'webhook.enabled', 'webhook.disabled', 'webhook.deleted');
