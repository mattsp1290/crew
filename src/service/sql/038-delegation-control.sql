CREATE FUNCTION birbcrew_ts.valid_delegation_scope(scope jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(scope='{"kind":"global"}'::jsonb OR (
  scope=jsonb_build_object('kind','target','engine',scope->'engine','profile',scope->'profile')
  AND scope->>'engine' IN ('pi','claude','codex') AND jsonb_typeof(scope->'profile')='string'
  AND octet_length(scope->>'profile') BETWEEN 1 AND 128),false);
$$;
CREATE FUNCTION birbcrew_ts.valid_disabled_targets(targets jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(targets) AS entries(target)
  WHERE NOT birbcrew_ts.valid_delegation_scope(target) OR target->>'kind'<>'target')
  AND jsonb_array_length(targets)=(SELECT count(DISTINCT target) FROM jsonb_array_elements(targets) AS entries(target));
END $$;

CREATE TABLE birbcrew_ts.delegation_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 global_enabled boolean NOT NULL DEFAULT true,
 disabled_targets jsonb NOT NULL DEFAULT '[]' CHECK(birbcrew_ts.valid_disabled_targets(disabled_targets))
);
INSERT INTO birbcrew_ts.delegation_control(singleton) VALUES(true);
CREATE TABLE birbcrew_ts.delegation_control_changes (
 command_id uuid PRIMARY KEY,
 request jsonb NOT NULL,
 installation_id uuid NOT NULL,
 instance_id uuid NOT NULL,
 revision bigint NOT NULL UNIQUE CHECK(revision>0),
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE birbcrew_ts.delegation_control_children (
 command_id uuid NOT NULL REFERENCES birbcrew_ts.delegation_control_changes,
 child_id uuid NOT NULL REFERENCES birbcrew_ts.pi_children,
 retire boolean NOT NULL,
 PRIMARY KEY(command_id,child_id)
);
CREATE INDEX delegation_control_retired ON birbcrew_ts.delegation_control_children(child_id) WHERE retire;
CREATE FUNCTION birbcrew_ts.reject_delegation_control_removal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Delegation control history is permanent' USING ERRCODE='23514';
END $$;
CREATE TRIGGER permanent_delegation_control BEFORE DELETE OR TRUNCATE ON birbcrew_ts.delegation_control
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_delegation_control_removal();
CREATE TRIGGER immutable_delegation_control_changes BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.delegation_control_changes
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_delegation_control_removal();
CREATE TRIGGER immutable_delegation_control_children BEFORE UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.delegation_control_children
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_delegation_control_removal();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.delegation_control
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.delegation_control_changes
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();
CREATE TRIGGER recovery_write_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON birbcrew_ts.delegation_control_children
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.require_active_installation();

CREATE FUNCTION birbcrew_ts.delegation_child_scope(cid uuid, role_profile jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE target jsonb := role_profile->'target'; parent_profile text;
BEGIN
 IF role_profile ? 'target' THEN
  IF (target->'version'='1'::jsonb AND birbcrew_ts.valid_child_destination(target-'version')) IS DISTINCT FROM true THEN
   RETURN NULL;
  END IF;
  RETURN jsonb_build_object('kind','target','engine',target->'engine','profile',target->'profile');
 END IF;
 SELECT m.profile INTO parent_profile FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING(owner_id,member_id)
  WHERE c.conversation_id=cid AND m.engine='pi';
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('kind','target','engine','pi','profile',parent_profile);
END $$;

CREATE FUNCTION birbcrew_ts.require_delegation_enabled(child uuid, cid uuid, role_profile jsonb) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE control birbcrew_ts.delegation_control; scope jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Delegation writes require READ COMMITTED' USING ERRCODE='55000';
 END IF;
 PERFORM 1 FROM birbcrew_ts.delegation_control WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Delegation control is missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT control FROM birbcrew_ts.delegation_control WHERE singleton;
 scope := birbcrew_ts.delegation_child_scope(cid,role_profile);
 IF scope IS NULL THEN RAISE EXCEPTION 'Delegation target is unreadable' USING ERRCODE='55000'; END IF;
 IF NOT control.global_enabled OR control.disabled_targets @> jsonb_build_array(scope)
  OR EXISTS(SELECT 1 FROM birbcrew_ts.delegation_control_children WHERE child_id=child AND retire) THEN
  RAISE EXCEPTION 'Delegation admission is disabled or retired' USING ERRCODE='55000';
 END IF;
END $$;

CREATE FUNCTION birbcrew_ts.guard_delegation_child() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM birbcrew_ts.require_delegation_enabled(NEW.child_id,NEW.conversation_id,NEW.role_profile);
 ELSE
  IF OLD.outcome IS NOT NULL AND (NEW.outcome,NEW.phase) IS DISTINCT FROM (OLD.outcome,OLD.phase) THEN
   RAISE EXCEPTION 'Child outcome is permanent' USING ERRCODE='23514';
  END IF;
  IF NEW.generation IS DISTINCT FROM OLD.generation
   OR (OLD.launch_revoked AND NOT NEW.launch_revoked)
   OR (NEW.phase IN ('running','waiting','resuming') AND
    (NEW.phase,NEW.workflow_run_id,NEW.activity_id,NEW.attempt,NEW.approval_id,NEW.native_checkpoint)
     IS DISTINCT FROM (OLD.phase,OLD.workflow_run_id,OLD.activity_id,OLD.attempt,OLD.approval_id,OLD.native_checkpoint))
   OR (OLD.outcome IS NULL AND (NEW.phase='complete' OR NEW.outcome->>'kind'='completed')) THEN
   PERFORM birbcrew_ts.require_delegation_enabled(NEW.child_id,NEW.conversation_id,NEW.role_profile);
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_delegation_control BEFORE INSERT OR UPDATE ON birbcrew_ts.pi_children
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_delegation_child();

CREATE FUNCTION birbcrew_ts.require_child_delegation_enabled(child uuid, cid uuid, rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE j birbcrew_ts.pi_children;
BEGIN
 SELECT * INTO j FROM birbcrew_ts.pi_children WHERE child_id=child AND conversation_id=cid AND request_id=rid FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Delegation child is unavailable' USING ERRCODE='55000'; END IF;
 PERFORM birbcrew_ts.require_delegation_enabled(j.child_id,j.conversation_id,j.role_profile);
END $$;
CREATE FUNCTION birbcrew_ts.guard_delegation_call() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.conversation_id,NEW.request_id,NEW.invocation_id)
  IS DISTINCT FROM (OLD.conversation_id,OLD.request_id,OLD.invocation_id) THEN
  RAISE EXCEPTION 'Approval invocation is permanent' USING ERRCODE='23514';
 END IF;
 IF (TG_OP='INSERT' OR NEW.decision IS DISTINCT FROM OLD.decision)
  AND EXISTS(SELECT 1 FROM birbcrew_ts.pi_children WHERE child_id=NEW.invocation_id
    AND conversation_id=NEW.conversation_id AND request_id=NEW.request_id) THEN
  PERFORM birbcrew_ts.require_child_delegation_enabled(NEW.invocation_id,NEW.conversation_id,NEW.request_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_delegation_control BEFORE INSERT OR UPDATE ON birbcrew_ts.deferred_calls
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_delegation_call();
CREATE FUNCTION birbcrew_ts.guard_delegation_effect() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE child uuid;
BEGIN
 SELECT j.child_id INTO child FROM birbcrew_ts.deferred_calls p JOIN birbcrew_ts.pi_children j
  ON (j.child_id,j.conversation_id,j.request_id)=(p.invocation_id,p.conversation_id,p.request_id)
  WHERE (p.approval_id,p.conversation_id,p.request_id)=(NEW.approval_id,NEW.conversation_id,NEW.request_id);
 IF FOUND THEN PERFORM birbcrew_ts.require_child_delegation_enabled(child,NEW.conversation_id,NEW.request_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_delegation_control BEFORE INSERT ON birbcrew_ts.work_items
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_delegation_effect();
CREATE FUNCTION birbcrew_ts.guard_delegation_reservation() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NEW.child_id IS NOT NULL THEN
  PERFORM birbcrew_ts.require_child_delegation_enabled(NEW.child_id,NEW.conversation_id,NEW.request_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_delegation_control BEFORE INSERT ON birbcrew_ts.native_launches
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_delegation_reservation();

CREATE FUNCTION birbcrew_ts.change_delegation_control(command uuid, expected_revision bigint, scope jsonb,
 enabled boolean, actor text, reason text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE control birbcrew_ts.delegation_control; recovery birbcrew_ts.recovery_control;
 prior birbcrew_ts.delegation_control_changes; canonical jsonb; result jsonb; targets jsonb;
BEGIN
 IF command IS NULL OR expected_revision IS NULL OR expected_revision<0 OR enabled IS NULL
  OR NOT birbcrew_ts.valid_delegation_scope(scope)
  OR actor IS NULL OR octet_length(actor) NOT BETWEEN 1 AND 256
  OR reason IS NULL OR octet_length(reason) NOT BETWEEN 1 AND 1024 THEN
  RAISE EXCEPTION 'Invalid delegation control command' USING ERRCODE='22023';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Delegation control requires READ COMMITTED' USING ERRCODE='55000';
 END IF;
 canonical := jsonb_build_object('commandId',command,'expectedRevision',expected_revision::text,
  'scope',scope,'enabled',enabled,'actor',actor,'reason',reason);
 PERFORM 1 FROM birbcrew_ts.recovery_control WHERE singleton AND phase='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Installation is held for recovery' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM birbcrew_ts.delegation_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Delegation control is missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT control FROM birbcrew_ts.delegation_control WHERE singleton;
 SELECT * INTO STRICT recovery FROM birbcrew_ts.recovery_control WHERE singleton;
 SELECT * INTO prior FROM birbcrew_ts.delegation_control_changes WHERE command_id=command;
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM canonical THEN
   RAISE EXCEPTION 'Delegation control command identity conflict' USING ERRCODE='23505';
  END IF;
  IF (prior.installation_id,prior.instance_id) IS DISTINCT FROM (recovery.installation_id,recovery.instance_id) THEN
   RAISE EXCEPTION 'Delegation control command belongs to a previous recovery instance' USING ERRCODE='55000';
  END IF;
  RETURN prior.receipt;
 END IF;
 IF control.revision<>expected_revision THEN RAISE EXCEPTION 'Stale delegation control revision' USING ERRCODE='40001'; END IF;
 targets := control.disabled_targets;
 IF scope->>'kind'='target' THEN
  SELECT COALESCE(jsonb_agg(target ORDER BY target::text),'[]'::jsonb) INTO targets FROM (
   SELECT target FROM jsonb_array_elements(targets) AS entries(target) WHERE target<>scope
   UNION SELECT scope WHERE NOT enabled
  ) selected;
 END IF;
 UPDATE birbcrew_ts.delegation_control SET revision=control.revision+1,disabled_targets=targets,
  global_enabled=CASE WHEN scope->>'kind'='global' THEN enabled ELSE global_enabled END WHERE singleton;
 result := jsonb_build_object('commandId',command,'installationId',recovery.installation_id,'instanceId',recovery.instance_id,
  'revision',(control.revision+1)::text,'scope',scope,'enabled',enabled);
 INSERT INTO birbcrew_ts.delegation_control_changes(command_id,request,installation_id,instance_id,revision,receipt)
  VALUES(command,canonical,recovery.installation_id,recovery.instance_id,control.revision+1,result);
 IF NOT enabled THEN
  INSERT INTO birbcrew_ts.delegation_control_children(command_id,child_id,retire)
   SELECT command,j.child_id,j.outcome IS NULL FROM birbcrew_ts.pi_children j
   JOIN birbcrew_ts.delegations d USING(conversation_id,request_id) JOIN birbcrew_ts.turns t USING(conversation_id,request_id)
   WHERE (j.outcome IS NULL OR d.resume_activity_id IS NULL OR t.phase<>'committed' OR t.reply IS NULL
    OR EXISTS(SELECT 1 FROM birbcrew_ts.native_launches n
     WHERE (n.conversation_id,n.request_id)=(j.conversation_id,j.request_id) AND NOT n.stopped))
    AND (scope->>'kind'='global' OR COALESCE(birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile)=scope,true));
  INSERT INTO birbcrew_ts.native_stop_requests(conversation_id,request_id,token)
   SELECT j.conversation_id,j.request_id,j.generation FROM birbcrew_ts.pi_children j
   JOIN birbcrew_ts.delegation_control_children m USING(child_id)
   WHERE m.command_id=command AND m.retire AND j.generation IS NOT NULL
   UNION
   SELECT n.conversation_id,n.request_id,n.token FROM birbcrew_ts.native_launches n
   JOIN birbcrew_ts.delegation_control_children m USING(child_id)
   WHERE m.command_id=command AND m.retire AND NOT n.stopped
   ON CONFLICT DO NOTHING;
 END IF;
 RETURN result;
END $$;
