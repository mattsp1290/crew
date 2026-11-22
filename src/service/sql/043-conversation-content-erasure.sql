-- Coordinated upgrade: no pre-043 writers/readers may serve once a fence exists.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '200 seconds';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE birbcrew_ts.conversations, birbcrew_ts.turns, birbcrew_ts.audit_events IN ACCESS EXCLUSIVE MODE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > deadline THEN RAISE; END IF;
    END;
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$;

ALTER TABLE birbcrew_ts.conversations
  ADD COLUMN content_erasure_id uuid,
  ADD COLUMN text_location_inventory_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN text_start_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN text_lifecycle text NOT NULL DEFAULT 'startable' CHECK (text_lifecycle IN ('startable','sealed_closed')),
  ADD COLUMN text_closure jsonb,
  ADD COLUMN text_closing_at timestamptz,
  ADD CONSTRAINT text_closure_shape CHECK ((text_lifecycle='sealed_closed') = (text_closure IS NOT NULL)),
  ADD CONSTRAINT text_closure_evidence CHECK (text_closure IS NULL OR ((
    text_closure->>'status' IN ('COMPLETED','FAILED','CANCELLED','CANCELED','TERMINATED','TIMED_OUT') AND
    text_closure->>'generation'=text_start_generation::text AND
    text_closure->>'workflowId'='birbcrew-ts/member/'||member_id::text||'/conversation/'||conversation_id::text AND
    text_closure->>'runId' ~ '^[0-9a-fA-F-]{36}$' AND length(text_closure->>'namespace')>0
  ) IS TRUE));
ALTER TABLE birbcrew_ts.turns ADD COLUMN erased boolean NOT NULL DEFAULT false;
DO $$
DECLARE name text; definition text;
BEGIN
  FOR name,definition IN SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='birbcrew_ts.turns'::regclass AND contype='c'
  LOOP
    IF definition LIKE '%committed%' AND definition LIKE '%reply%' AND definition LIKE '%checkpoint%' THEN
      EXECUTE format('ALTER TABLE birbcrew_ts.turns DROP CONSTRAINT %I', name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE birbcrew_ts.turns ADD CONSTRAINT turns_content_shape CHECK (
  (phase='committed' AND ((NOT erased AND reply IS NOT NULL AND checkpoint IS NOT NULL) OR (erased AND reply IS NULL AND checkpoint IS NULL)))
  OR (phase IN ('started','uncertain') AND NOT erased AND reply IS NULL AND checkpoint IS NULL));

CREATE TABLE birbcrew_ts.text_state_locations (
  location_id uuid PRIMARY KEY, engine text NOT NULL CHECK (engine IN ('cursor','opencode')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE birbcrew_ts.text_conversation_locations (
  conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversations,
  location_id uuid NOT NULL REFERENCES birbcrew_ts.text_state_locations,
  profile text NOT NULL, PRIMARY KEY(conversation_id,location_id)
);
CREATE TABLE birbcrew_ts.conversation_workflow_starts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversations,
  generation bigint NOT NULL, workflow_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','acknowledged','ambiguous','absent_after_trusted_drain')),
  run_id uuid, drain_id uuid, namespace text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(conversation_id,generation), CHECK ((state='acknowledged') = (run_id IS NOT NULL)),
  CHECK (state<>'absent_after_trusted_drain' OR (drain_id IS NOT NULL AND namespace IS NOT NULL))
);
CREATE TABLE birbcrew_ts.text_runtime_cleanup_proofs (
  conversation_id uuid NOT NULL, request_id uuid NOT NULL, token uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES birbcrew_ts.text_state_locations,
  confirmed_at timestamptz, drain_id uuid,
  PRIMARY KEY(conversation_id,request_id,token,location_id),
  FOREIGN KEY(conversation_id,request_id,token) REFERENCES birbcrew_ts.native_launches(conversation_id,request_id,token)
);
CREATE TABLE birbcrew_ts.text_request_no_launch_proofs (
  conversation_id uuid NOT NULL, request_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('predecessor_failed','predecessor_cancelled','admission_unconfirmed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(conversation_id,request_id),
  FOREIGN KEY(conversation_id,request_id) REFERENCES birbcrew_ts.request_admissions
);
CREATE TABLE birbcrew_ts.conversation_content_erasures (
  conversation_id uuid PRIMARY KEY REFERENCES birbcrew_ts.conversations, erasure_id uuid NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), erased_at timestamptz,
  terminal_phase text NOT NULL CHECK(terminal_phase IN ('complete','failed','cancelled')),
  inventory_id uuid NOT NULL DEFAULT gen_random_uuid(), UNIQUE(conversation_id,erasure_id)
);
ALTER TABLE birbcrew_ts.conversations ADD FOREIGN KEY (content_erasure_id) REFERENCES birbcrew_ts.conversation_content_erasures(erasure_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE birbcrew_ts.conversation_content_cleanup (
  conversation_id uuid NOT NULL REFERENCES birbcrew_ts.conversation_content_erasures,
  erasure_id uuid NOT NULL REFERENCES birbcrew_ts.conversation_content_erasures(erasure_id),
  location_id uuid NOT NULL REFERENCES birbcrew_ts.text_state_locations,
  cleaned_at timestamptz, PRIMARY KEY(conversation_id,location_id),
  FOREIGN KEY(conversation_id,erasure_id) REFERENCES birbcrew_ts.conversation_content_erasures(conversation_id,erasure_id)
);
CREATE TABLE birbcrew_ts.text_closure_scan (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), after_id uuid
);
INSERT INTO birbcrew_ts.text_closure_scan(singleton) VALUES(true);

-- Widen the released vocabulary without duplicating (and accidentally dropping) alternatives.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint
   WHERE conrelid='birbcrew_ts.audit_events'::regclass AND conname='audit_events_type_check';
  ALTER TABLE birbcrew_ts.audit_events DROP CONSTRAINT audit_events_type_check;
  EXECUTE 'ALTER TABLE birbcrew_ts.audit_events ADD CONSTRAINT audit_events_type_check CHECK ((' || definition ||
    ') OR (event_type=''conversation.content_erased'' AND conversation_id IS NOT NULL AND request_id IS NULL AND payload = jsonb_build_object(''erasureId'',payload->''erasureId'') AND jsonb_typeof(payload->''erasureId'')=''string'')) NOT VALID';
END $$;
CREATE UNIQUE INDEX audit_events_content_erasure_fact ON birbcrew_ts.audit_events(conversation_id)
  WHERE event_type='conversation.content_erased';

CREATE FUNCTION birbcrew_ts.erased_projection(cid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('conversationId',c.conversation_id,'memberId',c.member_id,'engine',m.engine,'profile',m.profile,
   'phase',e.terminal_phase,'erased',true,'openStep',NULL,'pendingApprovals','[]'::jsonb)
 FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
 JOIN birbcrew_ts.conversation_content_erasures e USING(conversation_id) WHERE c.conversation_id=cid
$$;
CREATE FUNCTION birbcrew_ts.content_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid; fence uuid; lifecycle text; clearing boolean := false;
BEGIN
  IF TG_OP='DELETE' THEN cid:=OLD.conversation_id; ELSE cid:=NEW.conversation_id; END IF;
  SELECT content_erasure_id,text_lifecycle INTO fence,lifecycle FROM birbcrew_ts.conversations WHERE conversation_id=cid FOR UPDATE;
  IF fence IS NULL THEN
    IF lifecycle='sealed_closed' AND ((TG_OP='INSERT' AND TG_TABLE_NAME NOT IN ('text_request_no_launch_proofs','text_runtime_cleanup_proofs')) OR TG_TABLE_NAME IN ('turns','public_snapshots','public_events','public_publications')) THEN
      RAISE EXCEPTION 'conversation_open' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='turns' THEN
      clearing := NEW.erased AND NEW.phase='committed' AND NEW.reply IS NULL AND NEW.checkpoint IS NULL
        AND (to_jsonb(NEW)-ARRAY['reply','checkpoint','erased'])=(to_jsonb(OLD)-ARRAY['reply','checkpoint','erased']);
    ELSIF TG_TABLE_NAME='public_snapshots' THEN
      clearing := NEW.messages='[]'::jsonb AND NEW.open_text IS NULL AND NEW.open_tools='{}'::jsonb
        AND NEW.child_open_text='{}'::jsonb AND NEW.state=birbcrew_ts.erased_projection(cid)
        AND (to_jsonb(NEW)-ARRAY['messages','state','open_text','open_tools','child_open_text'])=
            (to_jsonb(OLD)-ARRAY['messages','state','open_text','open_tools','child_open_text']);
    ELSIF TG_TABLE_NAME='public_events' THEN
      clearing := NEW.event='{"type":"CUSTOM","name":"crew.content_erased","value":null}'::jsonb
        AND (to_jsonb(NEW)-'event')=(to_jsonb(OLD)-'event');
    ELSIF TG_TABLE_NAME='native_launches' THEN
      -- Stop acknowledgements never authorize a new launch.
      IF NEW.stopped AND (to_jsonb(NEW)-'stopped')=(to_jsonb(OLD)-'stopped') THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF clearing AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=cid AND cleaned_at IS NULL)
     AND EXISTS(SELECT 1 FROM birbcrew_ts.conversation_content_erasures WHERE conversation_id=cid AND erased_at IS NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'conversation_erased' USING ERRCODE='23514';
END $$;
CREATE FUNCTION birbcrew_ts.keep_content_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Erasure identities are permanent' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='conversation_content_erasures' THEN
    IF OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND
       (to_jsonb(NEW)-'erased_at')=(to_jsonb(OLD)-'erased_at') AND
       NOT EXISTS(SELECT 1 FROM birbcrew_ts.conversation_content_cleanup WHERE conversation_id=OLD.conversation_id AND cleaned_at IS NULL) AND
       NOT EXISTS(SELECT 1 FROM birbcrew_ts.turns WHERE conversation_id=OLD.conversation_id AND (NOT erased OR reply IS NOT NULL OR checkpoint IS NOT NULL)) AND
       NOT EXISTS(SELECT 1 FROM birbcrew_ts.public_snapshots WHERE conversation_id=OLD.conversation_id AND
         (messages<>'[]'::jsonb OR open_text IS NOT NULL OR open_tools<>'{}'::jsonb OR child_open_text<>'{}'::jsonb OR state<>birbcrew_ts.erased_projection(OLD.conversation_id))) AND
       NOT EXISTS(SELECT 1 FROM birbcrew_ts.public_events WHERE conversation_id=OLD.conversation_id AND event<>'{"type":"CUSTOM","name":"crew.content_erased","value":null}'::jsonb)
       THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='conversation_content_cleanup' THEN
    IF OLD.cleaned_at IS NULL AND NEW.cleaned_at IS NOT NULL AND (to_jsonb(NEW)-'cleaned_at')=(to_jsonb(OLD)-'cleaned_at') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='text_runtime_cleanup_proofs' THEN
    IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND
       (to_jsonb(NEW)-ARRAY['confirmed_at','drain_id'])=(to_jsonb(OLD)-ARRAY['confirmed_at','drain_id']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='conversation_workflow_starts' THEN
    IF OLD.state IN ('reserved','ambiguous') AND NEW.state IN ('ambiguous','acknowledged','absent_after_trusted_drain') AND
      (to_jsonb(NEW)-ARRAY['state','run_id','drain_id','namespace'])=(to_jsonb(OLD)-ARRAY['state','run_id','drain_id','namespace']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Erasure evidence is immutable' USING ERRCODE='23514';
END $$;
CREATE FUNCTION birbcrew_ts.keep_content_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_erasure_id IS NOT NULL AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'conversation_erased' USING ERRCODE='23514';
  END IF;
  IF OLD.text_lifecycle='sealed_closed' AND
    (OLD.text_lifecycle,OLD.text_closure,OLD.text_start_generation) IS DISTINCT FROM
    (NEW.text_lifecycle,NEW.text_closure,NEW.text_start_generation) THEN
    RAISE EXCEPTION 'Closed text lifecycle is permanent' USING ERRCODE='23514';
  END IF;
  IF NEW.text_start_generation<OLD.text_start_generation OR (OLD.text_location_inventory_complete AND NOT NEW.text_location_inventory_complete) THEN
    RAISE EXCEPTION 'Text lifecycle evidence is monotonic' USING ERRCODE='23514';
  END IF;
  IF NEW.content_erasure_id IS NOT NULL AND (NEW.text_lifecycle<>'sealed_closed' OR NOT NEW.text_location_inventory_complete OR
    NOT EXISTS(SELECT 1 FROM birbcrew_ts.conversation_content_erasures WHERE conversation_id=NEW.conversation_id AND erasure_id=NEW.content_erasure_id)) THEN
    RAISE EXCEPTION 'Incomplete erasure evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_content_fence BEFORE UPDATE ON birbcrew_ts.conversations FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.keep_content_fence();
CREATE FUNCTION birbcrew_ts.keep_fenced_parents() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Erasure identities are permanent' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='members' THEN
    IF EXISTS(SELECT 1 FROM birbcrew_ts.conversations WHERE member_id=OLD.member_id AND content_erasure_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Erasure identities are permanent' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.content_erasure_id IS NOT NULL THEN RAISE EXCEPTION 'Erasure identities are permanent' USING ERRCODE='23514'; END IF;
  RETURN OLD;
END $$;
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['request_admissions','turns','public_snapshots','public_events','public_publications','text_conversation_locations','native_launches','conversation_workflow_starts','text_runtime_cleanup_proofs','text_request_no_launch_proofs'] LOOP
    EXECUTE format('CREATE TRIGGER content_fence BEFORE INSERT OR UPDATE OR DELETE ON birbcrew_ts.%I FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.content_fence_guard()',name);
    EXECUTE format('CREATE TRIGGER keep_fenced_rows BEFORE TRUNCATE ON birbcrew_ts.%I FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.keep_fenced_parents()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['members','conversations'] LOOP
    EXECUTE format('CREATE TRIGGER keep_fenced_parent BEFORE DELETE ON birbcrew_ts.%I FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.keep_fenced_parents()',name);
    EXECUTE format('CREATE TRIGGER keep_fenced_rows BEFORE TRUNCATE ON birbcrew_ts.%I FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.keep_fenced_parents()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['text_state_locations','text_conversation_locations','text_request_no_launch_proofs','text_runtime_cleanup_proofs','conversation_workflow_starts','conversation_content_erasures','conversation_content_cleanup'] LOOP
    EXECUTE format('CREATE TRIGGER keep_identity BEFORE UPDATE OR DELETE ON birbcrew_ts.%I FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.keep_content_identity()',name);
    EXECUTE format('CREATE TRIGGER keep_identity_truncate BEFORE TRUNCATE ON birbcrew_ts.%I FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.keep_content_identity()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['text_state_locations','text_conversation_locations','text_request_no_launch_proofs','text_runtime_cleanup_proofs','conversation_workflow_starts','conversation_content_erasures','conversation_content_cleanup','text_closure_scan'] LOOP
    EXECUTE format('CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.%I FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation()',name);
  END LOOP;
END $$;
