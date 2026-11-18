-- Notification formats for webhook endpoints (docs/webhooks.md#formats). An endpoint chooses at
-- creation how each delivery is written: `crew`, the signed JSON body every existing endpoint keeps,
-- or a readable message for a chat or push service's incoming-webhook URL. webhookFormats in
-- src/service/webhooks.ts is the registry. The CHECK bounds only the shape of a name, so a format
-- added there needs no migration. Like the URL and the kinds, the format never changes.
--
-- Locks: ACCESS EXCLUSIVE on webhook_endpoints only, held until migrate() commits. The default is a
-- constant, so no row is rewritten; the CHECK reads the table's few rows once. No transaction that
-- audits a request, card or routine touches a webhook table, so none waits for it. Only the webhook
-- routes, the dispatcher and a restore do, and the earlier release's processes are stopped for the
-- upgrade, so unlike 025 to 033 this takes its lock without retrying.
ALTER TABLE birbcrew_ts.webhook_endpoints
    ADD COLUMN format text NOT NULL DEFAULT 'crew' CHECK (format ~ '^[a-z][a-z0-9_]{0,31}$');

-- 032's guard, with the format among the fields that never change.
CREATE OR REPLACE FUNCTION birbcrew_ts.guard_webhook_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Webhook endpoints are kept as tombstones' USING ERRCODE = '23514';
    END IF;
    IF (OLD.webhook_id, OLD.owner_id, OLD.create_request_id, OLD.host, OLD.kinds, OLD.format, OLD.created_at)
        IS DISTINCT FROM (NEW.webhook_id, NEW.owner_id, NEW.create_request_id, NEW.host, NEW.kinds, NEW.format, NEW.created_at) THEN
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
