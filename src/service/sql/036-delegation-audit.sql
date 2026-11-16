-- ACCESS EXCLUSIVE replaces the audit type CHECK and builds the partial index without a table rewrite.
-- NOWAIT avoids queuing behind an audited transaction whose next statement still needs this table.
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
            AND (jsonb_typeof(payload->'packIds') = 'array') IS TRUE)
        OR (event_type IN ('delegation.started', 'delegation.finished') AND conversation_id IS NOT NULL AND request_id IS NOT NULL
            AND (jsonb_typeof(payload->'childId') = 'string') IS TRUE)) NOT VALID;

CREATE UNIQUE INDEX audit_events_delegation_fact ON birbcrew_ts.audit_events (event_type, (payload->>'childId'))
    WHERE event_type IN ('delegation.started', 'delegation.finished');
