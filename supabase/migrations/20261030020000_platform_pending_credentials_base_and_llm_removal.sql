-- Narrow forward correction, bound to independently read database definitions.
-- Existing migration 185/186 bytes, visibility guards, ACLs and lock order stay intact.
BEGIN;
DO $precondition$ DECLARE v_proc pg_proc%ROWTYPE; BEGIN
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb,jsonb)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'd563f2bc84936d1596f376594680e136f07441f17ab4c937ad3a0bce01b523e2' THEN
    RAISE EXCEPTION 'PLATFORM_PENDING_FORWARD_SOURCE_PRECONDITION_FAILED';
  END IF;
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.project_model_pool_before_visibility(jsonb)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM '674c28cf5ba76c2c7f04877743aae90db45f7a05997e8ebd2d33b04e5f9677fc' THEN
    RAISE EXCEPTION 'PLATFORM_PENDING_FORWARD_SOURCE_PRECONDITION_FAILED';
  END IF;
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM '5749260aad306cfa40b9494b0efe7e8696558511def4d78d1996e60115a554e2' THEN
    RAISE EXCEPTION 'PLATFORM_PENDING_FORWARD_SOURCE_PRECONDITION_FAILED';
  END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(p_snapshot jsonb, p_delta jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_delta jsonb := p_delta;
  v_before jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(
    id::text,
    jsonb_build_object(
      'active', is_active,
      'userAccess', user_access,
      'binding', jsonb_build_array(
        model_name,
        regexp_replace(coalesce(api_endpoint, proxy_url, ''), '/+$', ''),
        md5(coalesce(api_key, '')),
        billing_mode,
        token_billing_enabled,
        input_cost_per_million,
        output_cost_per_million,
        cached_cost_per_million,
        profit_margin,
        max_context_rounds,
        max_context_tokens,
        max_reply_tokens,
        timeout,
        deep_thinking_type,
        enable_web_search,
        deduct_deep_think,
        frequency_limit,
        image_parsing,
        file_parsing
      )
    )
  ), '{}'::jsonb)
  INTO v_before
  FROM public.llm_models;

  PERFORM public.project_model_pool_configuration_atomic_before_llm_gate(p_snapshot, v_delta);

  UPDATE public.llm_models target
     SET enable_web_search = coalesce((model #>> '{capabilities,webSearch}')::boolean, target.enable_web_search, false),
         deep_thinking_type = coalesce(nullif(model #>> '{capabilities,deepThinkingType}', '')::integer, target.deep_thinking_type, 0),
         image_parsing = coalesce(nullif(model #>> '{capabilities,imageParsing}', ''), target.image_parsing, 'none'),
         file_parsing = coalesce(nullif(model #>> '{capabilities,fileParsing}', ''), target.file_parsing, 'none'),
         deduct_deep_think = coalesce(nullif(model #>> '{configuration,deductDeepThink}', '')::numeric, target.deduct_deep_think, 1),
         frequency_limit = coalesce(nullif(model #>> '{configuration,frequencyLimit}', '')::integer, target.frequency_limit, 50)
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
     AND target.id::text = model #>> '{configuration,legacyId}' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text AND delta.removed = false);

  UPDATE public.llm_models target
     SET is_active = (
       target.is_hidden = false
       AND target.user_access <> 'hidden'
       AND coalesce((v_before -> target.id::text ->> 'active')::boolean, false)
       AND (v_before -> target.id::text -> 'binding') IS NOT DISTINCT FROM jsonb_build_array(
         target.model_name,
         regexp_replace(coalesce(target.api_endpoint, target.proxy_url, ''), '/+$', ''),
         md5(coalesce(target.api_key, '')),
         target.billing_mode,
         target.token_billing_enabled,
         target.input_cost_per_million,
         target.output_cost_per_million,
         target.cached_cost_per_million,
         target.profit_margin,
         target.max_context_rounds,
         target.max_context_tokens,
         target.max_reply_tokens,
         target.timeout,
         target.deep_thinking_type,
         target.enable_web_search,
         target.deduct_deep_think,
         target.frequency_limit,
         target.image_parsing,
         target.file_parsing
       )
     ),
         user_access = CASE
           WHEN target.is_hidden OR target.user_access = 'hidden' THEN 'hidden'
           WHEN coalesce((v_before -> target.id::text ->> 'active')::boolean, false)
             AND v_before -> target.id::text ->> 'userAccess' = 'available'
             AND (v_before -> target.id::text -> 'binding') IS NOT DISTINCT FROM jsonb_build_array(
               target.model_name,
               regexp_replace(coalesce(target.api_endpoint, target.proxy_url, ''), '/+$', ''),
               md5(coalesce(target.api_key, '')),
               target.billing_mode,
               target.token_billing_enabled,
               target.input_cost_per_million,
               target.output_cost_per_million,
               target.cached_cost_per_million,
               target.profit_margin,
               target.max_context_rounds,
               target.max_context_tokens,
               target.max_reply_tokens,
               target.timeout,
               target.deep_thinking_type,
               target.enable_web_search,
               target.deduct_deep_think,
               target.frequency_limit,
               target.image_parsing,
               target.file_parsing
             )
           THEN 'available'
           ELSE 'pending_model_activation'
         END,
         updated_at = now()
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text AND delta.removed = false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.project_model_pool_before_visibility(p_snapshot jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_delta jsonb;
  v_before jsonb;
BEGIN
  -- Freeze before the lower layer writes credentials or activation fields.
  SELECT coalesce(jsonb_agg(to_jsonb(delta)), '[]'::jsonb) INTO v_delta
    FROM public.model_pool_projection_delta(p_snapshot) delta;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'llm_models'
       AND (
         coalesce(model #>> '{configuration,protocolConfig,provider}', '') = ''
         OR coalesce(model #>> '{configuration,protocolConfig,protocol}', '') NOT IN ('openai_chat', 'anthropic_messages')
       )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'cover_models'
       AND coalesce(model #>> '{configuration,protocolConfig,protocol}', '') NOT IN (
         'chat_completions', 'google_generate_content', 'images_generations', 'images_generations_async', 'images_edits',
         'secure_skill_images', 'secure_skill_images_async', 'volcengine_images_v3', 'openai_image'
       )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'video_models'
       AND (coalesce(model->>'provider', '') = '' OR coalesce(model->>'protocol', '') = '')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_PROTOCOL_BINDING_REQUIRED';
  END IF;

  SELECT coalesce(jsonb_object_agg(
    id::text,
    jsonb_build_object(
      'active', is_active,
      'userAccess', user_access,
      'protocolConfig', api_protocol_config
    )
  ), '{}'::jsonb)
    INTO v_before
    FROM public.llm_models;

  PERFORM public.project_model_pool_configuration_atomic_before_explicit_protoco(p_snapshot, v_delta);

  UPDATE public.llm_models target
     SET api_protocol_config = coalesce(model #> '{configuration,protocolConfig}', target.api_protocol_config, '{}'::jsonb),
         updated_at = now()
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
     AND target.id::text = model #>> '{configuration,legacyId}' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text AND delta.removed = false);

  UPDATE public.llm_models target
     SET is_active = target.is_active
       AND coalesce((v_before -> target.id::text ->> 'active')::boolean, false)
       AND (v_before -> target.id::text -> 'protocolConfig') IS NOT DISTINCT FROM target.api_protocol_config,
         user_access = CASE
           WHEN target.is_hidden OR target.user_access = 'hidden' THEN 'hidden'
           WHEN target.user_access = 'available'
             AND v_before -> target.id::text ->> 'userAccess' = 'available'
             AND (v_before -> target.id::text -> 'protocolConfig') IS NOT DISTINCT FROM target.api_protocol_config
           THEN 'available'
           ELSE 'pending_model_activation'
         END,
         updated_at = now()
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text AND delta.removed = false);
END;
$function$;

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

-- CREATE OR REPLACE preserves existing owners and ACLs; no privilege is granted.
COMMIT;
