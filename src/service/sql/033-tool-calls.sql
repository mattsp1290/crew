-- The tool-call ledger (docs/member-capabilities.md): one row for each call of a Crew tool
-- that the approval gate decided, from its verdict to the delivery of its outcome to the
-- model. Crew runs these tools itself, so after a worker is lost this row, not the engine,
-- says what happened: a finished call is delivered, a read is run again, and an effect that
-- had started is uncertain and never run again. No engine calls a Crew tool yet, so nothing
-- writes here outside tests.
--
-- Locks on existing tables, held until migrate() commits: SHARE ROW EXCLUSIVE on members,
-- turns and tool_grants for the three foreign keys. As in 025 and 026 they are taken together
-- with NOWAIT and retried, so the migration never waits in a lock queue and never joins a
-- deadlock. A native turn's admission transaction holds ACCESS SHARE on members and ROW SHARE
-- on turns, which SHARE ROW EXCLUSIVE allows, so a running turn never delays it. No existing
-- table is altered and the audit registry is unchanged. After 60 s without the locks it fails
-- with 55P03 and applies nothing. Applied in one transaction with 032, it finds these locks
-- already held: 032 takes them with its own, so this block never retries while 032 holds
-- ACCESS EXCLUSIVE on profiles.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.members, birbcrew_ts.turns, birbcrew_ts.tool_grants IN SHARE ROW EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            -- Leaving the block rolls back its subtransaction, releasing any lock it took.
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

CREATE TABLE birbcrew_ts.tool_calls (
    call_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL,
    member_id uuid NOT NULL,
    -- Identity, as for deferred_calls: the engine's call inside one invocation of one request.
    conversation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    native_call_id text NOT NULL CHECK (octet_length(native_call_id) BETWEEN 1 AND 256),
    -- What was asked, as tool-catalog.ts classified it.
    tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_]{0,63}$'),
    catalog_version smallint NOT NULL CHECK (catalog_version > 0),
    kind text NOT NULL CHECK (kind IN ('read', 'effect')),
    scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND octet_length(scope::text) <= 8192),
    -- Private: never audited, published or logged. The catalog's own limits keep the largest
    -- call it accepts (a file of control characters, six bytes each as JSON) under half of this.
    arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object' AND octet_length(arguments::text) <= 4194304),
    argument_digest text NOT NULL CHECK (argument_digest ~ '^[a-f0-9]{64}$'),
    -- The hash of the file an edit was approved against: part of what the digest covers.
    prior_sha256 text CHECK (prior_sha256 ~ '^[a-f0-9]{64}$'),
    -- The gate's verdict and what decided it. A later slice adds the owner's answer to an ask
    -- and policy rules, and widens these CHECKs with them.
    verdict text NOT NULL CHECK (verdict IN ('allow', 'ask', 'deny')),
    decided_by text NOT NULL,
    grant_id uuid REFERENCES birbcrew_ts.tool_grants (grant_id),
    phase text NOT NULL CHECK (phase IN ('waiting', 'ready', 'admitted', 'completed', 'failed', 'uncertain', 'refused')),
    -- The execution that holds an admitted call. Only it may finish the call.
    execution_id uuid,
    -- An object, so a stored result is never JSON null. toolCallLimits.resultBytes bounds the
    -- canonical JSON to half of this.
    result jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 131072),
    failure text CHECK (failure ~ '^[a-z][a-z0-9_]{0,63}$'),
    uncertain_reason text CHECK (uncertain_reason IN ('worker_lost', 'recovery_restore')),
    -- Whether the model has been given the outcome.
    delivered boolean NOT NULL DEFAULT false,
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    admitted_at timestamptz,
    finished_at timestamptz,
    delivered_at timestamptz,
    UNIQUE (conversation_id, request_id, invocation_id, native_call_id),
    FOREIGN KEY (owner_id, member_id) REFERENCES birbcrew_ts.members (owner_id, member_id),
    FOREIGN KEY (conversation_id, request_id) REFERENCES birbcrew_ts.turns (conversation_id, request_id),
    -- What may decide which verdict. Nothing allows an effect by default: only a grant can.
    CONSTRAINT tool_calls_decision_check CHECK (
        (verdict = 'allow' AND decided_by = 'default' AND kind = 'read' AND grant_id IS NULL)
        OR (verdict = 'allow' AND decided_by = 'grant' AND grant_id IS NOT NULL)
        OR (verdict = 'ask' AND decided_by = 'default' AND grant_id IS NULL)
        OR (verdict = 'deny' AND decided_by IN ('capability', 'budget', 'credential_scan') AND grant_id IS NULL)),
    -- The phase a verdict allows. An ask stays waiting until a later slice records its answer,
    -- so today only an allowed call can ever be admitted.
    CONSTRAINT tool_calls_verdict_phase_check CHECK ((phase = 'waiting') = (verdict = 'ask') AND (phase = 'refused') = (verdict = 'deny')),
    CONSTRAINT tool_calls_outcome_check CHECK ((phase = 'completed') = (result IS NOT NULL) AND (phase = 'failed') = (failure IS NOT NULL)
        AND (phase = 'uncertain') = (uncertain_reason IS NOT NULL)),
    -- Only an effect can be uncertain: a read is run again instead.
    CONSTRAINT tool_calls_uncertain_check CHECK (phase <> 'uncertain' OR kind = 'effect'),
    -- An admitted call names its execution and keeps it; a call that never started names none.
    -- An uncertain call may be either: a restore settles effects that had not started too.
    CONSTRAINT tool_calls_execution_check CHECK ((execution_id IS NOT NULL) = (admitted_at IS NOT NULL) AND (CASE
        WHEN phase IN ('admitted', 'completed', 'failed') THEN execution_id IS NOT NULL
        WHEN phase = 'uncertain' THEN true ELSE execution_id IS NULL END)),
    CONSTRAINT tool_calls_finished_check CHECK ((finished_at IS NOT NULL) = (phase IN ('completed', 'failed', 'uncertain'))),
    -- Only an outcome can be delivered: a result, a failure, a refusal or an uncertainty.
    CONSTRAINT tool_calls_delivered_check CHECK (delivered = (delivered_at IS NOT NULL)
        AND (NOT delivered OR phase IN ('completed', 'failed', 'uncertain', 'refused')))
);
-- Effects a restored installation must settle, and calls an operator may find stuck.
CREATE INDEX tool_calls_unfinished ON birbcrew_ts.tool_calls (phase, admitted_at) WHERE phase IN ('ready', 'admitted');

-- The rules no CHECK can state, because they compare a row with what it was, or with other rows.
--
-- Insert: the conversation must be visible to this lookup and belong to the row's owner and
-- member, and a grant must be that owner's and member's and, when it names a conversation,
-- this one. As in bind_audit_conversation (021-audit.sql), a row the lookup cannot see is
-- refused here rather than left to the foreign keys. A call starts in the phase its verdict
-- gives it and nowhere later, and a request holds at most 256 calls
-- (toolCallLimits.perRequest): the advisory lock serialises a request's inserts until commit,
-- so under READ COMMITTED the count sees every call committed before it.
--
-- Update: identity, classification, arguments, digest and verdict never change. The phase
-- moves only ready -> admitted -> completed | failed | uncertain, or ready -> uncertain when a
-- restored installation resumes; nothing leaves completed, failed, uncertain or refused, and
-- nothing leaves waiting yet. A read that is run again changes its execution and stays
-- admitted; an effect never does. Delivery happens once, on its own, and a delivered call
-- never changes again.
CREATE FUNCTION birbcrew_ts.guard_tool_call() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound record;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Tool calls are kept' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT owner_id, member_id INTO bound FROM birbcrew_ts.conversations WHERE conversation_id = NEW.conversation_id;
        IF NOT FOUND OR (bound.owner_id, bound.member_id) IS DISTINCT FROM (NEW.owner_id, NEW.member_id) THEN
            RAISE EXCEPTION 'Tool call conversation is missing or belongs to another owner or member'
                USING ERRCODE = '23503', CONSTRAINT = 'tool_calls_conversation_binding';
        END IF;
        IF NEW.grant_id IS NOT NULL THEN
            PERFORM 1 FROM birbcrew_ts.tool_grants g WHERE g.grant_id = NEW.grant_id AND g.owner_id = NEW.owner_id
               AND g.member_id = NEW.member_id AND (g.conversation_id IS NULL OR g.conversation_id = NEW.conversation_id);
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Tool call grant is missing or belongs to another owner, member or conversation'
                    USING ERRCODE = '23503', CONSTRAINT = 'tool_calls_grant_binding';
            END IF;
        END IF;
        IF NEW.phase IS DISTINCT FROM (CASE NEW.verdict WHEN 'allow' THEN 'ready' WHEN 'ask' THEN 'waiting' WHEN 'deny' THEN 'refused' END)
           OR NEW.delivered OR NEW.execution_id IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
            RAISE EXCEPTION 'A tool call starts ready, waiting or refused, as its verdict says' USING ERRCODE = '23514';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('birbcrew_ts.tool_calls/' || NEW.conversation_id::text || '/' || NEW.request_id::text, 0));
        IF (SELECT count(*) FROM birbcrew_ts.tool_calls WHERE conversation_id = NEW.conversation_id AND request_id = NEW.request_id) >= 256 THEN
            RAISE EXCEPTION 'A request may record at most 256 tool calls' USING ERRCODE = '23514', CONSTRAINT = 'tool_calls_request_limit';
        END IF;
        RETURN NEW;
    END IF;

    -- Every column but the ones named here: a column a later migration adds is immutable until
    -- that migration says otherwise.
    IF (to_jsonb(OLD) - '{phase,execution_id,result,failure,uncertain_reason,delivered,admitted_at,finished_at,delivered_at}'::text[])
        IS DISTINCT FROM (to_jsonb(NEW) - '{phase,execution_id,result,failure,uncertain_reason,delivered,admitted_at,finished_at,delivered_at}'::text[]) THEN
        RAISE EXCEPTION 'A tool call''s identity, classification, arguments and verdict are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.delivered THEN
        IF OLD IS DISTINCT FROM NEW THEN
            RAISE EXCEPTION 'A delivered tool call never changes' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.phase = NEW.phase THEN
        IF NEW.delivered THEN
            IF (OLD.execution_id, OLD.result, OLD.failure, OLD.uncertain_reason, OLD.admitted_at, OLD.finished_at)
                IS DISTINCT FROM (NEW.execution_id, NEW.result, NEW.failure, NEW.uncertain_reason, NEW.admitted_at, NEW.finished_at) THEN
                RAISE EXCEPTION 'Delivery changes nothing else' USING ERRCODE = '23514';
            END IF;
        ELSIF NOT (OLD.phase = 'admitted' AND OLD.kind = 'read') AND OLD.execution_id IS DISTINCT FROM NEW.execution_id THEN
            RAISE EXCEPTION 'Only an admitted read can be taken over by another execution' USING ERRCODE = '23514';
        ELSIF (OLD.result, OLD.failure, OLD.uncertain_reason, OLD.admitted_at, OLD.finished_at)
            IS DISTINCT FROM (NEW.result, NEW.failure, NEW.uncertain_reason, NEW.admitted_at, NEW.finished_at) THEN
            RAISE EXCEPTION 'A tool call changes only by moving phase, being taken over or being delivered' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.delivered THEN
        RAISE EXCEPTION 'A tool call is delivered after it has an outcome, not with it' USING ERRCODE = '23514';
    END IF;
    IF OLD.phase = 'ready' AND NEW.phase = 'admitted' THEN
        RETURN NEW;
    END IF;
    IF OLD.phase = 'ready' AND NEW.phase = 'uncertain' AND NEW.uncertain_reason = 'recovery_restore' AND NEW.execution_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD.phase = 'admitted' AND NEW.phase IN ('completed', 'failed', 'uncertain')
       AND (OLD.execution_id, OLD.admitted_at) IS NOT DISTINCT FROM (NEW.execution_id, NEW.admitted_at) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A tool call cannot move from % to %', OLD.phase, NEW.phase USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER tool_calls_guard BEFORE INSERT OR UPDATE OR DELETE ON birbcrew_ts.tool_calls
    FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_tool_call();
CREATE FUNCTION birbcrew_ts.reject_tool_call_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Tool calls are kept' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER tool_calls_kept BEFORE TRUNCATE ON birbcrew_ts.tool_calls
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_tool_call_truncate();

-- 019 fenced only the tables that existed then; recovery capture refuses an unfenced table.
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.tool_calls
    FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
