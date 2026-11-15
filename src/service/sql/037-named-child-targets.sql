DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
 LOOP
  BEGIN
   LOCK TABLE birbcrew_ts.profiles, birbcrew_ts.members, birbcrew_ts.pi_children IN ACCESS EXCLUSIVE MODE NOWAIT;
   RETURN;
  EXCEPTION WHEN lock_not_available THEN
   IF clock_timestamp() > deadline THEN RAISE; END IF;
  END;
  PERFORM pg_sleep(0.02 + random() * 0.08);
 END LOOP;
END $$;

ALTER TABLE birbcrew_ts.profiles
 ADD COLUMN child_target_seal jsonb NOT NULL DEFAULT '{"mode":"legacy"}',
 ADD COLUMN child_target_active text[] NOT NULL DEFAULT '{}';
ALTER TABLE birbcrew_ts.members ADD COLUMN child_target_consent jsonb NOT NULL DEFAULT '{"mode":"legacy"}';

CREATE FUNCTION birbcrew_ts.lock_child_authority(engine text, profile text) RETURNS void
 LANGUAGE sql VOLATILE AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('birbcrew_ts.child_authority:' || jsonb_build_array(engine,profile)::text,0));
$$;

CREATE FUNCTION birbcrew_ts.valid_child_destination(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_typeof(d)='object'
  AND d=jsonb_build_object('engine',d->'engine','profile',d->'profile','model',d->'model','providerHost',d->'providerHost','accountDigest',d->'accountDigest')
  AND d->>'engine' IN ('pi','claude','codex')
  AND jsonb_typeof(d->'profile')='string' AND octet_length(d->>'profile') BETWEEN 1 AND 128
  AND jsonb_typeof(d->'model')='string' AND octet_length(d->>'model') BETWEEN 1 AND 256
  AND jsonb_typeof(d->'providerHost')='string' AND octet_length(d->>'providerHost') BETWEEN 1 AND 512
  AND d->>'providerHost' !~ '[[:space:]/@?#]'
  AND jsonb_typeof(d->'accountDigest')='string' AND d->>'accountDigest' ~ '^[a-f0-9]{64}$',false);
$$;

CREATE FUNCTION birbcrew_ts.guard_profile_child_authority() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE role text; destination jsonb; keys text[];
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Profile authority is permanent' USING ERRCODE='23514'; END IF;
 PERFORM birbcrew_ts.lock_child_authority(NEW.engine,NEW.name);
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'child_target_active') IS DISTINCT FROM (to_jsonb(OLD)-'child_target_active')
   OR (NEW.child_target_active <@ OLD.child_target_active) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Profile authority cannot grow or change identity' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM birbcrew_ts.profiles WHERE engine=NEW.engine AND name=NEW.name) THEN RETURN NEW; END IF;
  IF NEW.child_target_seal->>'mode'='named' AND EXISTS(SELECT 1 FROM birbcrew_ts.members WHERE engine=NEW.engine AND profile=NEW.name) THEN
   RAISE EXCEPTION 'Existing members reserve legacy profile authority' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.child_target_seal='{"mode":"legacy"}'::jsonb THEN
  IF NEW.child_target_active <> '{}'::text[] THEN RAISE EXCEPTION 'Legacy profile has named authority' USING ERRCODE='23514'; END IF;
 ELSIF (NEW.child_target_seal=jsonb_build_object('mode','named','roles',NEW.child_target_seal->'roles')
  AND jsonb_typeof(NEW.child_target_seal->'roles')='object') IS TRUE THEN
  keys := ARRAY(SELECT jsonb_object_keys(NEW.child_target_seal->'roles'));
  IF (NEW.child_target_active <@ keys AND cardinality(NEW.child_target_active)=
    (SELECT count(DISTINCT r) FROM unnest(NEW.child_target_active) r)) IS DISTINCT FROM true
   OR (TG_OP='INSERT' AND NOT keys <@ NEW.child_target_active) THEN
   RAISE EXCEPTION 'Invalid active child roles' USING ERRCODE='23514';
  END IF;
  FOR role,destination IN SELECT * FROM jsonb_each(NEW.child_target_seal->'roles') LOOP
   IF role NOT IN ('analyst','recorder') OR NOT birbcrew_ts.valid_child_destination(destination)
    OR (NEW.engine IN ('claude','codex') AND role<>'analyst')
    OR (NEW.engine='pi' AND NOT NEW.delegate_task)
    OR (role='recorder' AND (NEW.protected_tool IS DISTINCT FROM 'record_work_item' OR destination->>'engine'='codex')) THEN
    RAISE EXCEPTION 'Invalid fixed child role or destination' USING ERRCODE='23514';
   END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'Invalid profile target seal' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_child_authority BEFORE INSERT OR UPDATE OR DELETE ON birbcrew_ts.profiles
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_profile_child_authority();
CREATE TRIGGER permanent_profile_authority BEFORE TRUNCATE ON birbcrew_ts.profiles
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.guard_profile_child_authority();

CREATE FUNCTION birbcrew_ts.check_child_destination_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE role text; destination jsonb;
BEGIN
 IF NEW.child_target_seal->>'mode'='named' THEN
  FOR role,destination IN SELECT * FROM jsonb_each(NEW.child_target_seal->'roles') LOOP
   IF NOT EXISTS(SELECT 1 FROM birbcrew_ts.profiles p WHERE p.engine=destination->>'engine' AND p.name=destination->>'profile'
    AND encode(p.account_digest,'hex')=destination->>'accountDigest'
    AND (role='analyst' OR p.protected_tool='record_work_item')) THEN
    RAISE EXCEPTION 'Child target profile identity or tools differ' USING ERRCODE='23514';
   END IF;
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER child_destination_profiles AFTER INSERT ON birbcrew_ts.profiles
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.check_child_destination_profiles();

CREATE FUNCTION birbcrew_ts.capture_member_child_consent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE p birbcrew_ts.profiles;
BEGIN
 PERFORM birbcrew_ts.lock_child_authority(NEW.engine,NEW.profile);
 SELECT * INTO p FROM birbcrew_ts.profiles WHERE engine=NEW.engine AND name=NEW.profile;
 NEW.child_target_consent := CASE WHEN p.child_target_seal->>'mode'='named'
  THEN jsonb_build_object('mode','named','roles',COALESCE((SELECT jsonb_object_agg(key,value)
   FROM jsonb_each(p.child_target_seal->'roles') WHERE key=ANY(p.child_target_active)),'{}'::jsonb))
  ELSE '{"mode":"legacy"}'::jsonb END;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_child_consent BEFORE INSERT ON birbcrew_ts.members FOR EACH ROW
 EXECUTE FUNCTION birbcrew_ts.capture_member_child_consent();
CREATE TRIGGER permanent_member_authority BEFORE DELETE OR TRUNCATE ON birbcrew_ts.members
 FOR EACH STATEMENT EXECUTE FUNCTION birbcrew_ts.reject_rebind();

CREATE FUNCTION birbcrew_ts.guard_child_role_profile() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE m birbcrew_ts.members; p birbcrew_ts.profiles; d jsonb; role text; instructions text; tools jsonb; expected jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.role_profile IS DISTINCT FROM OLD.role_profile THEN RAISE EXCEPTION 'Child role profile is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT members.* INTO STRICT m FROM birbcrew_ts.members members JOIN birbcrew_ts.conversations c USING(owner_id,member_id)
  JOIN birbcrew_ts.turns t USING(conversation_id)
  WHERE c.conversation_id=NEW.conversation_id AND t.request_id=NEW.request_id AND t.phase='started';
 PERFORM birbcrew_ts.lock_child_authority(m.engine,m.profile);
 SELECT * INTO p FROM birbcrew_ts.profiles WHERE engine=m.engine AND name=m.profile;
 role := NEW.role_profile->>'role';
 IF role='analyst' THEN
  instructions := 'Answer the assigned question using only the supplied task context.'; tools := '[]';
 ELSIF role='recorder' THEN
  instructions := 'Complete the assigned task. Request owner approval to record a work item when asked.'; tools := '["record_work_item"]';
 ELSE RAISE EXCEPTION 'Unknown fixed child role' USING ERRCODE='23514';
 END IF;
 expected := jsonb_build_object('role',role,'version',1,'instructions',instructions,'tools',tools,'model',NEW.role_profile->'model');
 IF (m.engine='pi' AND jsonb_typeof(NEW.role_profile->'model')='string'
  AND octet_length(NEW.role_profile->>'model') BETWEEN 1 AND 256) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Invalid child engine or model' USING ERRCODE='23514';
 END IF;
 IF m.child_target_consent->>'mode'='named' THEN
  d := m.child_target_consent->'roles'->role;
  IF (birbcrew_ts.valid_child_destination(d) AND d=p.child_target_seal->'roles'->role
   AND role=ANY(p.child_target_active) AND d->>'engine'='pi' AND p.delegate_task
   AND NEW.role_profile->>'model'=d->>'model'
   AND (role='analyst' OR p.protected_tool='record_work_item')) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Child target lacks current member authority' USING ERRCODE='23514';
  END IF;
  expected := expected || jsonb_build_object('target',d || '{"version":1}'::jsonb);
 ELSIF m.child_target_consent <> '{"mode":"legacy"}'::jsonb THEN
  RAISE EXCEPTION 'Invalid member child consent' USING ERRCODE='23514';
 END IF;
 IF NEW.role_profile IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Child fixed role or target differs' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_role_authority BEFORE INSERT OR UPDATE OF role_profile ON birbcrew_ts.pi_children
 FOR EACH ROW EXECUTE FUNCTION birbcrew_ts.guard_child_role_profile();
