-- Narrow forward guard for an own pending credential plus strict pure removal.
-- Migration 186/187 and all projector/visibility functions remain byte-preserved.
BEGIN;
DO $precondition$ DECLARE v_proc pg_proc%ROWTYPE; BEGIN
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR v_proc.prokind IS DISTINCT FROM 'f' OR v_proc.prorettype IS DISTINCT FROM 'jsonb'::regtype
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM '462e0aa08ed4fe5418adef4d9d68b2b677ffafb3dd5dada6cb5a1a59dc2280e9' THEN
    RAISE EXCEPTION 'PLATFORM_CREDENTIAL_REMOVAL_GUARD_PRECONDITION_FAILED';
  END IF;
END $precondition$;
CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic(p_kind text, p_release_id uuid, p_actor_id uuid, p_expected_candidate_sha256 text, p_expected_current_id uuid, p_expected_current_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  -- A pending credential is bound to the model-pool identity on which it was staged.
  -- Re-previewing a later current does not rebase that immutable candidate.
  IF EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND state='pending')
    AND v_candidate.parent_release_id IS DISTINCT FROM (CASE WHEN v_has_current THEN v_current.id ELSE NULL END) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED';
  END IF;
  -- A strict unchanged subset projects only removals, not surviving credentials.
  -- Reject this own-candidate combination before any active binding promotion.
  IF v_has_current
    AND EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND state='pending')
    AND jsonb_typeof(v_current.snapshot->'models') = 'array'
    AND jsonb_typeof(v_candidate.snapshot->'models') = 'array'
    AND jsonb_array_length(v_candidate.snapshot->'models') < jsonb_array_length(v_current.snapshot->'models')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') next(model)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') old(model)
        WHERE old.model = next.model
      )
    ) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED';
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
END $function$;

-- CREATE OR REPLACE preserves the existing owner and ACL; no grants or table writes.
COMMIT;
