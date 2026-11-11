-- REVIEW PLAN ONLY. Not applied to zimeiti_local or any active database.
-- New, service-role-only entry points. Existing publish/projector/delta functions
-- are neither wrapped nor replaced. The server is the trusted configuration
-- proof producer; SQL checks the fixed vision envelope, exact evidence and CAS.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $precondition$
DECLARE v_expected record; v_proc pg_proc%ROWTYPE;
BEGIN
  FOR v_expected IN SELECT * FROM (VALUES
      ('model_pool_projection_delta(jsonb)','d60f87a7bb9f9bb244f2eec5499906d264d8706691c9d1738f93e131043e9061','s'),
      ('project_model_pool_configuration_atomic(jsonb)','0b364dc0fa70f9c26bfe54387677af525944bcab0cf88d475877c44f8930efe8','v'),
      ('project_model_pool_configuration_atomic_before_explicit_protoco(jsonb)','5a8084bd7b6a7236aa2c3f8136da0b25b90d419eae3bc4cda5b08df136659749','v'),
      ('project_model_pool_configuration_atomic_before_explicit_protoco(jsonb,jsonb)','ba3c54ebc9cdc3d092c7d25ffcec6a2e4603096dc99ce05222cc8f2a81c35605','v'),
      ('project_model_pool_configuration_atomic_before_llm_gate(jsonb)','3562ed16176e0dad14efe81dcd3f4fa434e21b8739076742e79c4a64e63e46b6','v'),
      ('project_model_pool_configuration_atomic_before_llm_gate(jsonb,jsonb)','442d200164619974b42f2a25e5051014c59b20047b29074f95ebcbee3dbb555d','v'),
      ('publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)','030649c7db1be77eb9222dd87a39088ae1b1b66d0312a470976211d901993cb9','v')
  ) expected(signature, definition_sha256, volatility) LOOP
    SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid = to_regprocedure('public.' || v_expected.signature);
    IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
      OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
      OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      OR NOT v_proc.prosecdef OR v_proc.provolatile::text IS DISTINCT FROM v_expected.volatility
      OR encode(sha256(convert_to(pg_get_functiondef(v_proc.oid), 'UTF8')), 'hex') IS DISTINCT FROM v_expected.definition_sha256 THEN
      RAISE EXCEPTION 'VISION_PUBLICATION_BASELINE_PRECONDITION_FAILED';
    END IF;
  END LOOP;
  -- A comma-separated privilege list means ANY, so require each privilege
  -- separately. FOR UPDATE / SHARE also require existing UPDATE privilege.
  -- No new table privilege is granted by this plan.
  IF NOT has_table_privilege('zimeiti_owner','public.llm_models','SELECT')
    OR NOT has_table_privilege('zimeiti_owner','public.llm_models','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.model_pool_config_releases','SELECT')
    OR NOT has_table_privilege('zimeiti_owner','public.model_pool_config_releases','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_credential_bindings','SELECT')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_credential_bindings','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.llm_model_validation_evidence','SELECT')
    OR NOT has_table_privilege('zimeiti_owner','public.llm_model_validation_evidence','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_mutation_receipts','SELECT')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_mutation_receipts','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_pending_credentials','SELECT') THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_OWNER_PRIVILEGES_MISSING';
  END IF;
END;
$precondition$;

CREATE FUNCTION public.read_llm_vision_publication_guard(p_model_id uuid, p_credential_ref text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $guard$
  -- One SELECT / one MVCC snapshot: never read a row and its xmin separately.
  -- physical is SERVER-PRIVATE, containing the existing credential. The binding
  -- secret is never returned. No HTTP response may include this guard result.
  SELECT jsonb_build_object(
    'physical', to_jsonb(model), 'rowVersion', model.xmin::text,
    'credentialLiteral', coalesce(length(btrim(model.api_key)) > 0
      AND btrim(model.api_key) !~* '^(env|secret)://', false),
    'bindingExists', binding.model_key IS NOT NULL,
    'bindingMatches', coalesce(binding.secret_value = model.api_key, false),
    'credentialRef', binding.credential_ref, 'bindingRevision', binding.revision)
  FROM public.llm_models model
  LEFT JOIN public.platform_model_credential_bindings binding
    ON binding.model_key = 'llm_models:' || model.id::text
    AND binding.credential_ref = p_credential_ref
  WHERE model.id = p_model_id
    AND p_model_id = 'b6a9d79d-9a0f-4ca5-86fa-4601d80e590d'::uuid;
$guard$;

CREATE FUNCTION public.publish_llm_vision_capability_only_atomic(
  p_release_id uuid, p_actor_id uuid,
  p_expected_candidate_sha256 text, p_expected_current_id uuid, p_expected_current_sha256 text,
  p_expected_current_snapshot jsonb, p_expected_candidate_snapshot jsonb,
  p_target_model_id uuid, p_expected_row_version text,
  p_expected_credential_ref text, p_expected_credential_revision uuid,
  p_ordinary_configuration_hash text, p_vision_configuration_hash text,
  p_evidence_id uuid, p_evidence_checked_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $publish$
DECLARE
  v_current public.model_pool_config_releases%ROWTYPE;
  v_candidate public.model_pool_config_releases%ROWTYPE;
  v_physical record;
  v_binding public.platform_model_credential_bindings%ROWTYPE;
  v_position integer; v_count integer;
  v_old jsonb; v_next jsonb; v_expected jsonb; v_envelope text;
BEGIN
  IF p_release_id IS NULL OR p_actor_id IS NULL OR p_expected_current_id IS NULL
    OR p_target_model_id IS DISTINCT FROM 'b6a9d79d-9a0f-4ca5-86fa-4601d80e590d'::uuid
    OR jsonb_typeof(p_expected_current_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_expected_candidate_snapshot) IS DISTINCT FROM 'object'
    OR p_expected_credential_revision IS NULL OR p_evidence_id IS NULL
    OR p_evidence_checked_at IS NULL OR p_expected_row_version IS NULL OR p_expected_row_version !~ '^[0-9]+$'
    OR p_expected_candidate_sha256 IS NULL OR p_expected_candidate_sha256 !~ '^[a-f0-9]{64}$'
    OR p_expected_current_sha256 IS NULL OR p_expected_current_sha256 !~ '^[a-f0-9]{64}$'
    OR p_ordinary_configuration_hash IS NULL OR p_ordinary_configuration_hash !~ '^[a-f0-9]{64}$'
    OR p_vision_configuration_hash IS NULL OR p_vision_configuration_hash !~ '^[a-f0-9]{64}$'
    OR coalesce(p_expected_credential_ref, '') = '' THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_INPUT_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool', 0));
  SELECT count(*) INTO v_count FROM public.model_pool_config_releases WHERE is_current;
  IF v_count <> 1 THEN RAISE EXCEPTION 'VISION_PUBLICATION_CURRENT_CHANGED'; END IF;
  SELECT * INTO v_current FROM public.model_pool_config_releases WHERE is_current FOR UPDATE;
  SELECT * INTO v_candidate FROM public.model_pool_config_releases WHERE id = p_release_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND'; END IF;
  IF v_candidate.snapshot_sha256 IS DISTINCT FROM p_expected_candidate_sha256
    OR v_candidate.snapshot IS DISTINCT FROM p_expected_candidate_snapshot THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_CANDIDATE_CHANGED';
  END IF;
  -- A replay may return the same published receipt, with zero physical UPDATEs.
  -- Superseded releases never acquire authority to change a newer current.
  IF v_candidate.id = v_current.id AND v_candidate.is_current AND v_candidate.status = 'published' THEN
    RETURN to_jsonb(v_candidate);
  END IF;
  IF v_current.id IS DISTINCT FROM p_expected_current_id
    OR v_current.snapshot_sha256 IS DISTINCT FROM p_expected_current_sha256
    OR v_current.snapshot IS DISTINCT FROM p_expected_current_snapshot
    OR v_current.status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_CURRENT_CHANGED';
  END IF;
  IF v_candidate.status IS DISTINCT FROM 'validated' OR v_candidate.is_current
    OR v_candidate.parent_release_id IS DISTINCT FROM v_current.id
    OR v_candidate.rollback_target_id IS NOT NULL THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_CANDIDATE_BASE_CHANGED';
  END IF;
  -- No pending/applied credential rows at all, including unrelated models.
  IF EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id = p_release_id) THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_PENDING_CREDENTIALS_REJECTED';
  END IF;
  IF v_current.snapshot->>'schema' IS DISTINCT FROM 'model-pool-config/v1'
    OR jsonb_typeof(v_current.snapshot->'models') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_candidate.snapshot->'models') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_SCOPE_INVALID';
  END IF;
  SELECT count(*), min(ordinal::integer - 1) INTO v_count, v_position
  FROM jsonb_array_elements(v_current.snapshot->'models') WITH ORDINALITY model(value, ordinal)
  WHERE value->>'id' = 'llm:' || p_target_model_id::text;
  IF v_count <> 1 THEN RAISE EXCEPTION 'VISION_PUBLICATION_SCOPE_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_current.snapshot->'models') model
      WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
        AND model #>> '{configuration,legacyId}' = p_target_model_id::text) <> 1 THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_SCOPE_INVALID';
  END IF;
  v_old := v_current.snapshot #> ARRAY['models', v_position::text];
  v_next := v_candidate.snapshot #> ARRAY['models', v_position::text];
  IF v_old->>'kind' IS DISTINCT FROM 'agent' OR v_old->>'catalogState' IS DISTINCT FROM 'enabled'
    OR v_old #>> '{configuration,legacyTable}' IS DISTINCT FROM 'llm_models'
    OR v_old #>> '{configuration,legacyId}' IS DISTINCT FROM p_target_model_id::text
    OR coalesce(v_old #>> '{capabilities,imageParsing}', 'none') <> 'none'
    OR jsonb_typeof(v_old->'capabilities') IS DISTINCT FROM 'object'
    OR v_old->>'credentialRef' IS DISTINCT FROM p_expected_credential_ref
    OR v_next #>> '{capabilities,imageParsing}' IS DISTINCT FROM 'gpt_vision' THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_SCOPE_INVALID';
  END IF;
  v_expected := jsonb_set(v_current.snapshot,
    ARRAY['models', v_position::text, 'capabilities', 'imageParsing'], '"gpt_vision"'::jsonb, true);
  -- Full equality preserves every other value AND array order. No live import,
  -- global delta or projector can repair unrelated drifting/missing models.
  IF v_expected IS DISTINCT FROM v_candidate.snapshot THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_SCOPE_INVALID';
  END IF;

  -- Same lock order as existing publishers: release -> binding -> physical.
  SELECT * INTO v_binding FROM public.platform_model_credential_bindings
    WHERE model_key = 'llm_models:' || p_target_model_id::text FOR UPDATE;
  IF NOT FOUND OR v_binding.credential_ref IS DISTINCT FROM p_expected_credential_ref
    OR v_binding.revision IS DISTINCT FROM p_expected_credential_revision THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_CREDENTIAL_CHANGED';
  END IF;
  SELECT model.*, model.xmin::text AS row_version INTO v_physical
    FROM public.llm_models model WHERE model.id = p_target_model_id FOR UPDATE;
  IF NOT FOUND OR v_physical.row_version IS DISTINCT FROM p_expected_row_version
    OR coalesce(v_physical.image_parsing, 'none') <> 'none'
    OR v_physical.is_hidden IS DISTINCT FROM false
    OR v_physical.user_access IS NOT DISTINCT FROM 'hidden' THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_PHYSICAL_CHANGED';
  END IF;
  IF coalesce(length(btrim(v_physical.api_key)), 0) = 0
    OR btrim(v_physical.api_key) ~* '^(env|secret)://'
    OR v_binding.secret_value IS DISTINCT FROM v_physical.api_key THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_CREDENTIAL_CHANGED';
  END IF;

  -- This fixed ASCII envelope exactly matches visionConfigurationHash. Only a
  -- validated 64-hex value is interpolated; no JS endpoint/number/JSON hash is
  -- reimplemented here. Configuration binding is trusted-server proof + CAS.
  v_envelope := '{"domain":"llm-vision-validation/v1","ordinaryConfigurationHash":"'
    || p_ordinary_configuration_hash
    || '","capability":"vision","imageParsing":"gpt_vision","fixtureVersion":"llm-vision-three-images/1","requiredImageCount":3}';
  IF encode(sha256(convert_to(v_envelope, 'UTF8')), 'hex') IS DISTINCT FROM p_vision_configuration_hash THEN
    RAISE EXCEPTION 'VISION_PUBLICATION_EVIDENCE_DOMAIN_INVALID';
  END IF;
  PERFORM 1 FROM public.llm_model_validation_evidence evidence
    WHERE evidence.id = p_evidence_id AND evidence.model_id = p_target_model_id
      AND evidence.configuration_hash = p_vision_configuration_hash
      AND evidence.checked_at = p_evidence_checked_at
      AND evidence.checked_at <= clock_timestamp() + interval '60 seconds'
      AND evidence.checked_at >= clock_timestamp() - interval '7 days'
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VISION_PUBLICATION_EVIDENCE_REQUIRED'; END IF;

  -- Ordinary publication treats image_parsing as an activation binding change.
  -- Match that gate without running any global projector: visible catalogue
  -- placement stays intact, execution becomes pending and explicitly inactive.
  -- A vision-domain row is never ordinary activation evidence. Normal saved
  -- text validation and /api/admin/models/activate remain separate operations.
  UPDATE public.llm_models SET image_parsing = 'gpt_vision', is_active = false,
    user_access = 'pending_model_activation', updated_at = now()
    WHERE id = p_target_model_id AND xmin::text = p_expected_row_version;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'VISION_PUBLICATION_UPDATE_INCOMPLETE'; END IF;
  UPDATE public.model_pool_config_releases SET status = 'superseded', is_current = false
    WHERE id = v_current.id;
  UPDATE public.model_pool_config_releases
    SET status = 'published', is_current = true, published_by = p_actor_id, published_at = now()
    WHERE id = p_release_id RETURNING * INTO v_candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'VISION_PUBLICATION_UPDATE_INCOMPLETE'; END IF;
  -- Preserve the ordinary mutation receipt finalization, scoped to this exact
  -- candidate; pending credential rows were rejected before the first write.
  UPDATE public.platform_model_mutation_receipts SET state = 'applied', applied_at = now()
    WHERE candidate_id = p_release_id;
  RETURN to_jsonb(v_candidate);
END;
$publish$;

ALTER FUNCTION public.read_llm_vision_publication_guard(uuid, text) OWNER TO zimeiti_owner;
ALTER FUNCTION public.publish_llm_vision_capability_only_atomic(uuid, uuid, text, uuid, text, jsonb, jsonb, uuid, text, text, uuid, text, text, uuid, timestamptz) OWNER TO zimeiti_owner;
REVOKE ALL ON FUNCTION public.read_llm_vision_publication_guard(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_llm_vision_capability_only_atomic(uuid, uuid, text, uuid, text, jsonb, jsonb, uuid, text, text, uuid, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_llm_vision_publication_guard(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_llm_vision_capability_only_atomic(uuid, uuid, text, uuid, text, jsonb, jsonb, uuid, text, text, uuid, text, text, uuid, timestamptz) TO service_role;
COMMIT;
