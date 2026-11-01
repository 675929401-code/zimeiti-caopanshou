-- Pending credentials belong to an immutable model-pool candidate. Nothing here
-- authorizes a final user: service_role is the trusted, capability-gated caller.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='zimeiti_owner') OR
    (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)'::regprocedure) IS DISTINCT FROM 'zimeiti_owner' THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PENDING_OWNER_MISMATCH';
  END IF;
END $$;

ALTER TABLE public.platform_model_credential_bindings ADD COLUMN IF NOT EXISTS revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE OR REPLACE FUNCTION public.platform_model_credential_revision_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.revision := gen_random_uuid();
  ELSE
    IF NEW.model_key IS DISTINCT FROM OLD.model_key OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_IDENTITY_IMMUTABLE';
    END IF;
    NEW.revision := CASE WHEN NEW.secret_value IS DISTINCT FROM OLD.secret_value THEN gen_random_uuid() ELSE OLD.revision END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_model_credential_revision_guard ON public.platform_model_credential_bindings;
CREATE TRIGGER platform_model_credential_revision_guard BEFORE INSERT OR UPDATE ON public.platform_model_credential_bindings
FOR EACH ROW EXECUTE FUNCTION public.platform_model_credential_revision_guard();

CREATE TABLE public.platform_model_pending_credentials (
  release_id uuid NOT NULL REFERENCES public.model_pool_config_releases(id) ON DELETE RESTRICT,
  model_key text NOT NULL,
  credential_ref text NOT NULL,
  expected_exists boolean NOT NULL,
  expected_revision uuid,
  pending_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  secret_value text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  PRIMARY KEY(release_id,model_key),
  CHECK (expected_exists = (expected_revision IS NOT NULL)),
  CHECK ((state='pending' AND secret_value IS NOT NULL AND length(secret_value)>0 AND applied_at IS NULL)
    OR (state='applied' AND secret_value IS NULL AND applied_at IS NOT NULL))
);
CREATE TABLE public.platform_model_mutation_receipts (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.model_pool_config_releases(id) ON DELETE RESTRICT,
  request_salt uuid NOT NULL DEFAULT gen_random_uuid(),
  request_fingerprint text NOT NULL,
  payload_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','applied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  PRIMARY KEY(actor_id,request_id)
);
ALTER TABLE public.platform_model_pending_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_model_mutation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_model_pending_credentials,public.platform_model_mutation_receipts FROM PUBLIC,anon,authenticated,service_role;
REVOKE INSERT,UPDATE,DELETE ON public.platform_model_credential_bindings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.platform_model_credential_bindings TO service_role;

CREATE OR REPLACE FUNCTION public.platform_model_pending_credential_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state<>'pending' OR NEW.state<>'applied' OR NEW.secret_value IS NOT NULL OR NEW.applied_at IS NULL
    OR (to_jsonb(NEW)-'state'-'secret_value'-'applied_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'secret_value'-'applied_at') THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PENDING_CREDENTIAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_model_pending_credential_immutable_guard BEFORE UPDATE OR DELETE ON public.platform_model_pending_credentials
FOR EACH ROW EXECUTE FUNCTION public.platform_model_pending_credential_immutable_guard();

CREATE OR REPLACE FUNCTION public.stage_model_pool_candidate_with_credentials_atomic(
  p_actor_id uuid,p_request_id uuid,p_request_payload jsonb,p_snapshot jsonb,p_snapshot_sha256 text,
  p_validation_result jsonb,p_status text,p_change_note text,p_parent_release_id uuid,p_credential_changes jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE
  v_receipt public.platform_model_mutation_receipts%ROWTYPE;
  v_binding public.platform_model_credential_bindings%ROWTYPE;
  v_candidate jsonb;
  v_change jsonb;
  v_salt uuid := gen_random_uuid();
  v_exists boolean;
  v_table text;
  v_id text;
BEGIN
  IF p_actor_id IS NULL OR p_request_id IS NULL OR p_actor_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR p_request_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR jsonb_typeof(p_request_payload) IS DISTINCT FROM 'object'
    OR octet_length(p_request_payload::text)>1048576 THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED'; END IF;
  -- Publication first everywhere; request lock never precedes this dependency lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-model-request:'||p_actor_id::text||':'||p_request_id::text,0));
  SELECT * INTO v_receipt FROM public.platform_model_mutation_receipts WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF FOUND THEN
    IF v_receipt.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(v_receipt.request_salt::text||p_request_payload::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT';
    END IF;
    SELECT to_jsonb(r) INTO v_candidate FROM public.model_pool_config_releases r WHERE id=v_receipt.candidate_id;
    RETURN v_candidate;
  END IF;
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR p_snapshot->>'schema' IS DISTINCT FROM 'model-pool-config/v1'
    OR jsonb_typeof(p_snapshot->'models') IS DISTINCT FROM 'array' OR jsonb_typeof(p_credential_changes) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_credential_changes)>200 OR p_snapshot_sha256 IS NULL OR p_status IS NULL OR p_status NOT IN ('draft','validated') OR jsonb_typeof(p_validation_result) IS DISTINCT FROM 'object' OR p_snapshot_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_INPUT_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_credential_changes) c WHERE jsonb_typeof(c) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(c))<>3
    OR jsonb_typeof(c->'model_key') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'credential_ref') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'secret_value') IS DISTINCT FROM 'string' OR length(btrim(c->>'secret_value')) NOT BETWEEN 1 AND 32768
    OR c->>'secret_value' ~* '^(\*+|sk-\*+|configured|unchanged)$'
    OR length(c->>'model_key') NOT BETWEEN 1 AND 220 OR length(c->>'credential_ref') NOT BETWEEN 1 AND 240)
    OR (SELECT count(*) FROM jsonb_array_elements(p_credential_changes))<>(SELECT count(DISTINCT c->>'model_key') FROM jsonb_array_elements(p_credential_changes) c) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_INPUT_INVALID';
  END IF;
  FOR v_change IN SELECT value FROM jsonb_array_elements(p_credential_changes) ORDER BY value->>'model_key' LOOP
    v_table := split_part(v_change->>'model_key',':',1); v_id := substr(v_change->>'model_key',length(v_table)+2);
    IF v_table NOT IN ('cover_models','video_models','llm_models','chat_models') OR v_id !~ '^[A-Za-z0-9._-]{1,160}$'
      OR v_change->>'credential_ref' IS DISTINCT FROM 'secret://platform-model/'||v_table||'/'||v_id
      OR (SELECT count(*) FROM jsonb_array_elements(p_snapshot->'models') m
        WHERE m #>> '{configuration,legacyTable}'=v_table AND m #>> '{configuration,legacyId}'=v_id
        AND m->>'credentialRef'=v_change->>'credential_ref'
        AND m->>'id'=CASE WHEN v_table='llm_models' THEN 'llm:'||v_id WHEN v_table='chat_models' THEN 'chat:'||v_id ELSE v_id END)<>1 THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH';
    END IF;
  END LOOP;
  -- Existing function owns version-counter serialization and candidate validation.
  v_candidate := public.create_platform_configuration_candidate_atomic('model-pool',p_actor_id,p_snapshot,p_snapshot_sha256,p_validation_result,p_status,p_change_note,p_parent_release_id,NULL);
  FOR v_change IN SELECT value FROM jsonb_array_elements(p_credential_changes) ORDER BY value->>'model_key' LOOP
    SELECT * INTO v_binding FROM public.platform_model_credential_bindings WHERE model_key=v_change->>'model_key' FOR UPDATE;
    v_exists := FOUND;
    IF v_exists AND v_binding.credential_ref IS DISTINCT FROM v_change->>'credential_ref' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH'; END IF;
    INSERT INTO public.platform_model_pending_credentials(release_id,model_key,credential_ref,expected_exists,expected_revision,secret_value)
    VALUES((v_candidate->>'id')::uuid,v_change->>'model_key',v_change->>'credential_ref',v_exists,CASE WHEN v_exists THEN v_binding.revision ELSE NULL END,v_change->>'secret_value');
  END LOOP;
  INSERT INTO public.platform_model_mutation_receipts(actor_id,request_id,candidate_id,request_salt,request_fingerprint,payload_fingerprint)
  VALUES(p_actor_id,p_request_id,(v_candidate->>'id')::uuid,v_salt,
    encode(sha256(convert_to(v_salt::text||p_request_payload::text,'UTF8')),'hex'),
    encode(sha256(convert_to(v_salt::text||jsonb_build_object('snapshot',p_snapshot,'credentialChanges',p_credential_changes)::text,'UTF8')),'hex'));
  RETURN v_candidate;
END $$;

CREATE OR REPLACE FUNCTION public.read_platform_model_pending_credential_metadata(p_release_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('modelKey',model_key,'credentialRef',credential_ref,
    'pendingRevision',pending_revision,'expectedExists',expected_exists,'expectedRevision',expected_revision,'state',state) ORDER BY model_key),'[]'::jsonb)
  FROM public.platform_model_pending_credentials WHERE release_id=p_release_id
$$;
CREATE OR REPLACE FUNCTION public.read_platform_model_mutation_receipt(p_actor_id uuid,p_request_id uuid,p_request_payload jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_receipt public.platform_model_mutation_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt FROM public.platform_model_mutation_receipts WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_request_payload IS NOT NULL AND (jsonb_typeof(p_request_payload) IS DISTINCT FROM 'object'
    OR v_receipt.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(v_receipt.request_salt::text||p_request_payload::text,'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT';
  END IF;
  RETURN jsonb_build_object('candidateId',v_receipt.candidate_id,'state',v_receipt.state,'hasStagedCredentials',EXISTS(
    SELECT 1 FROM public.platform_model_pending_credentials p WHERE p.release_id=v_receipt.candidate_id AND p.state='pending'));
END $$;

ALTER FUNCTION public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text) RENAME TO publish_platform_configuration_release_before_pending_credentials;
REVOKE ALL ON FUNCTION public.publish_platform_configuration_release_before_pending_credentials(text,uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic(
  p_kind text,p_release_id uuid,p_actor_id uuid,p_expected_candidate_sha256 text,p_expected_current_id uuid,p_expected_current_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_candidate record; v_current record; v_has_current boolean; v_pending record; v_active record; v_exists boolean; v_result jsonb;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('model-pool','workspace-models') OR p_actor_id IS NULL OR p_release_id IS NULL OR p_expected_candidate_sha256 IS NULL OR p_expected_candidate_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PUBLISH_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0));
  IF p_kind='workspace-models' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:workspace-models',0));
    RETURN public.publish_platform_configuration_release_before_pending_credentials(p_kind,p_release_id,p_actor_id,p_expected_candidate_sha256,p_expected_current_id,p_expected_current_sha256);
  END IF;
  SELECT * INTO v_current FROM public.model_pool_config_releases WHERE is_current FOR UPDATE; v_has_current:=FOUND;
  SELECT * INTO v_candidate FROM public.model_pool_config_releases WHERE id=p_release_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND'; END IF;
  IF v_candidate.snapshot_sha256 IS DISTINCT FROM p_expected_candidate_sha256 THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CANDIDATE_CHANGED'; END IF;
  IF v_candidate.is_current AND v_candidate.status='published' THEN RETURN to_jsonb(v_candidate); END IF;
  IF v_candidate.status='superseded' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT'; END IF;
  IF v_candidate.status<>'validated' OR v_candidate.is_current THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_VALIDATED'; END IF;
  IF (NOT v_has_current AND (p_expected_current_id IS NOT NULL OR p_expected_current_sha256 IS NOT NULL))
    OR (v_has_current AND (v_current.id IS DISTINCT FROM p_expected_current_id OR v_current.snapshot_sha256 IS DISTINCT FROM p_expected_current_sha256)) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CURRENT_CHANGED';
  END IF;
  -- Verify every expected revision first, before changing any active binding.
  FOR v_pending IN SELECT * FROM public.platform_model_pending_credentials WHERE release_id=p_release_id ORDER BY model_key FOR UPDATE LOOP
    IF v_pending.state<>'pending' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PENDING_CREDENTIAL_STATE_INVALID'; END IF;
    SELECT * INTO v_active FROM public.platform_model_credential_bindings WHERE model_key=v_pending.model_key FOR UPDATE; v_exists:=FOUND;
    IF v_exists IS DISTINCT FROM v_pending.expected_exists OR (v_exists AND (v_active.revision IS DISTINCT FROM v_pending.expected_revision OR v_active.credential_ref IS DISTINCT FROM v_pending.credential_ref)) THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT';
    END IF;
  END LOOP;
  FOR v_pending IN SELECT * FROM public.platform_model_pending_credentials WHERE release_id=p_release_id ORDER BY model_key LOOP
    IF v_pending.expected_exists THEN
      UPDATE public.platform_model_credential_bindings SET secret_value=v_pending.secret_value,updated_by=p_actor_id,updated_at=now()
      WHERE model_key=v_pending.model_key AND credential_ref=v_pending.credential_ref AND revision=v_pending.expected_revision
      RETURNING * INTO v_active;
    ELSE
      INSERT INTO public.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by,updated_at)
        VALUES(v_pending.credential_ref,v_pending.model_key,v_pending.secret_value,p_actor_id,now())
      ON CONFLICT DO NOTHING RETURNING * INTO v_active;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'; END IF;
  END LOOP;
  -- The original projector and pointer switch run in the SAME transaction.
  -- A projector or pointer failure rolls back bindings and pending transitions.
  v_result:=public.publish_platform_configuration_release_before_pending_credentials(p_kind,p_release_id,p_actor_id,p_expected_candidate_sha256,p_expected_current_id,p_expected_current_sha256);
  UPDATE public.platform_model_pending_credentials SET state='applied',secret_value=NULL,applied_at=now() WHERE release_id=p_release_id;
  UPDATE public.platform_model_mutation_receipts SET state='applied',applied_at=now() WHERE candidate_id=p_release_id;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.stage_model_pool_candidate_with_credentials_atomic(uuid,uuid,jsonb,jsonb,text,jsonb,text,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.read_platform_model_pending_credential_metadata(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.read_platform_model_mutation_receipt(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.platform_model_credential_revision_guard(),public.platform_model_pending_credential_immutable_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.stage_model_pool_candidate_with_credentials_atomic(uuid,uuid,jsonb,jsonb,text,jsonb,text,text,uuid,jsonb),public.read_platform_model_pending_credential_metadata(uuid),public.read_platform_model_mutation_receipt(uuid,uuid,jsonb),public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text) TO service_role;
ALTER TABLE public.platform_model_pending_credentials OWNER TO zimeiti_owner;
ALTER TABLE public.platform_model_mutation_receipts OWNER TO zimeiti_owner;
ALTER FUNCTION public.platform_model_credential_revision_guard() OWNER TO zimeiti_owner;
ALTER FUNCTION public.platform_model_pending_credential_immutable_guard() OWNER TO zimeiti_owner;
ALTER FUNCTION public.stage_model_pool_candidate_with_credentials_atomic(uuid,uuid,jsonb,jsonb,text,jsonb,text,text,uuid,jsonb) OWNER TO zimeiti_owner;
ALTER FUNCTION public.read_platform_model_pending_credential_metadata(uuid) OWNER TO zimeiti_owner;
ALTER FUNCTION public.read_platform_model_mutation_receipt(uuid,uuid,jsonb) OWNER TO zimeiti_owner;
ALTER FUNCTION public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text) OWNER TO zimeiti_owner;
COMMIT;
