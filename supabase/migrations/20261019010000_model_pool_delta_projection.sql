BEGIN;
-- Project only release-owned changes. Publish calls this before switching current.
CREATE OR REPLACE FUNCTION public.model_pool_projection_delta(p_snapshot jsonb)
RETURNS TABLE(legacy_table text, legacy_id text, removed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $delta$
WITH old_entries AS (
 SELECT model FROM public.model_pool_config_releases release,
 LATERAL jsonb_array_elements(release.snapshot->'models') model
 WHERE release.is_current AND release.status = 'published'
), next_entries AS (SELECT model FROM jsonb_array_elements(p_snapshot->'models') model),
physical AS (
 SELECT 'cover_models'::text AS tbl,id::text AS id,api_key FROM public.cover_models
 UNION ALL SELECT 'video_models',id::text,api_key FROM public.video_models
 UNION ALL SELECT 'llm_models',id::text,api_key FROM public.llm_models
 UNION ALL SELECT 'chat_models',id::text,api_key FROM public.chat_models
)
SELECT next.model #>> '{configuration,legacyTable}',next.model #>> '{configuration,legacyId}',false
FROM next_entries next
LEFT JOIN old_entries old ON old.model #>> '{configuration,legacyTable}' = next.model #>> '{configuration,legacyTable}'
 AND old.model #>> '{configuration,legacyId}' = next.model #>> '{configuration,legacyId}'
LEFT JOIN physical physical_row ON physical_row.tbl = next.model #>> '{configuration,legacyTable}' AND physical_row.id = next.model #>> '{configuration,legacyId}'
LEFT JOIN public.platform_model_credential_bindings binding ON binding.credential_ref = next.model->>'credentialRef'
WHERE old.model IS DISTINCT FROM next.model OR physical_row.id IS NULL
 OR (coalesce(binding.secret_value,'') <> '' AND binding.secret_value IS DISTINCT FROM physical_row.api_key)
UNION ALL
SELECT old.model #>> '{configuration,legacyTable}',old.model #>> '{configuration,legacyId}',true
FROM old_entries old WHERE NOT EXISTS (SELECT 1 FROM next_entries next
 WHERE old.model #>> '{configuration,legacyTable}' = next.model #>> '{configuration,legacyTable}'
 AND old.model #>> '{configuration,legacyId}' = next.model #>> '{configuration,legacyId}');
$delta$;

-- Internal overload: trusted service_role/owner callers supply one frozen delta.
CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(p_snapshot jsonb, p_delta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delta jsonb := p_delta;
  v_expected integer;
  v_affected integer;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->>'schema' <> 'model-pool-config/v1'
     OR jsonb_typeof(p_snapshot->'models') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_CONFIGURATION_SCHEMA_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' NOT IN ('cover_models', 'video_models', 'llm_models', 'chat_models')
        OR coalesce(model #>> '{configuration,legacyId}', '') = ''
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_LEGACY_IDENTITY_INVALID';
  END IF;



  INSERT INTO public.cover_models (
    id, name, model_name, provider, api_endpoint, api_key, cost_price,
    selling_price, is_active, is_hidden, supports_image_input, sort_order,
    api_protocol_config, updated_at
  )
  SELECT model #>> '{configuration,legacyId}', model->>'name', model->>'modelName',
         model->>'provider', model->>'endpoint', coalesce(binding.secret_value, ''),
         coalesce(nullif(model #>> '{pricing,cost}', '')::numeric, 0),
         coalesce(nullif(model #>> '{pricing,selling}', '')::numeric, 0),
         false, model->>'catalogState' <> 'enabled',
         coalesce((model #>> '{capabilities,supportsImageInput}')::boolean, false),
         coalesce(nullif(model->>'sortOrder', '')::integer, 0),
         coalesce(model #> '{configuration,protocolConfig}', '{}'::jsonb), now()
    FROM jsonb_array_elements(p_snapshot->'models') model
    LEFT JOIN public.platform_model_credential_bindings binding
      ON binding.credential_ref = model->>'credentialRef'
   WHERE model #>> '{configuration,legacyTable}' = 'cover_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'cover_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false)
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name, model_name = excluded.model_name, provider = excluded.provider,
    api_endpoint = excluded.api_endpoint,
    api_key = CASE WHEN excluded.api_key <> '' THEN excluded.api_key ELSE public.cover_models.api_key END,
    cost_price = excluded.cost_price, selling_price = excluded.selling_price,
    is_active = CASE WHEN excluded.is_hidden THEN false ELSE public.cover_models.is_active END,
    is_hidden = excluded.is_hidden,
    supports_image_input = excluded.supports_image_input, sort_order = excluded.sort_order,
    api_protocol_config = excluded.api_protocol_config, updated_at = now();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  SELECT count(*) INTO v_expected FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'cover_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'cover_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false);
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_COVER_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.cover_models target SET is_active = false, is_hidden = true, updated_at = now()
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'cover_models' AND delta.legacy_id = target.id::text AND delta.removed = true) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' = 'cover_models'
       AND model #>> '{configuration,legacyId}' = target.id);

  INSERT INTO public.video_models (
    id, name, model_name, provider, api_endpoint, api_key, protocol_type,
    price_per_use, cost_price, currency, duration_seconds, max_duration,
    supports_image_input, requires_image, is_active, is_hidden, sort_order,
    api_protocol_config
  )
  SELECT model #>> '{configuration,legacyId}', model->>'name', model->>'modelName',
         model->>'provider', model->>'endpoint', coalesce(binding.secret_value, ''), model->>'protocol',
         coalesce(nullif(model #>> '{pricing,selling}', '')::numeric, 0),
         coalesce(nullif(model #>> '{pricing,cost}', '')::numeric, 0),
         coalesce(model #>> '{pricing,currency}', 'CNY'),
         coalesce(nullif(model #>> '{capabilities,durationSeconds}', '')::integer, 10),
         coalesce(nullif(model #>> '{capabilities,maxDuration}', '')::integer, 10),
         coalesce((model #>> '{capabilities,supportsImageInput}')::boolean, false),
         coalesce((model #>> '{capabilities,requiresImage}')::boolean, false),
         false, model->>'catalogState' <> 'enabled',
         coalesce(nullif(model->>'sortOrder', '')::integer, 0),
         coalesce(model #> '{configuration,protocolConfig}', '{}'::jsonb)
    FROM jsonb_array_elements(p_snapshot->'models') model
    LEFT JOIN public.platform_model_credential_bindings binding
      ON binding.credential_ref = model->>'credentialRef'
   WHERE model #>> '{configuration,legacyTable}' = 'video_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'video_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false)
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name, model_name = excluded.model_name, provider = excluded.provider,
    api_endpoint = excluded.api_endpoint,
    api_key = CASE WHEN excluded.api_key <> '' THEN excluded.api_key ELSE public.video_models.api_key END,
    protocol_type = excluded.protocol_type, price_per_use = excluded.price_per_use,
    cost_price = excluded.cost_price, currency = excluded.currency,
    duration_seconds = excluded.duration_seconds, max_duration = excluded.max_duration,
    supports_image_input = excluded.supports_image_input, requires_image = excluded.requires_image,
    is_active = CASE WHEN excluded.is_hidden THEN false ELSE public.video_models.is_active END,
    is_hidden = excluded.is_hidden,
    sort_order = excluded.sort_order,
    api_protocol_config = CASE
      WHEN public.video_models.api_protocol_config ? '__model_activation_gate'
        THEN excluded.api_protocol_config || jsonb_build_object('__model_activation_gate', public.video_models.api_protocol_config->'__model_activation_gate')
      ELSE excluded.api_protocol_config
    END;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  SELECT count(*) INTO v_expected FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'video_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'video_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false);
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_VIDEO_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.video_models target SET is_active = false, is_hidden = true
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'video_models' AND delta.legacy_id = target.id::text AND delta.removed = true) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' = 'video_models'
       AND model #>> '{configuration,legacyId}' = target.id);

  INSERT INTO public.llm_models (
    id, name, model_name, description, category, api_endpoint, api_key, proxy_url,
    billing_mode, cost_per_use, cost_price, token_billing_enabled,
    input_cost_per_million, output_cost_per_million, cached_cost_per_million,
    profit_margin, token_rounding_unit, max_context_rounds, max_context_tokens,
    max_reply_tokens, timeout, temperature, response_format, is_active, is_hidden,
    sort_order, user_access, admin_notes, icon_url, updated_at
  )
  SELECT (model #>> '{configuration,legacyId}')::uuid, model->>'name', model->>'modelName',
         coalesce(model #>> '{configuration,description}', ''), coalesce(model #>> '{configuration,category}', '通用'),
         model->>'endpoint', coalesce(binding.secret_value, ''), model->>'endpoint',
         coalesce(model #>> '{pricing,billingMode}', model #>> '{configuration,billingMode}', 'credit'),
         coalesce(nullif(model #>> '{pricing,costPerUse}', '')::numeric, 0),
         coalesce(nullif(model #>> '{pricing,costPrice}', '')::numeric, 0),
         coalesce((model #>> '{configuration,tokenBillingEnabled}')::boolean, false),
         nullif(model #>> '{pricing,inputCostPerMillion}', '')::numeric,
         nullif(model #>> '{pricing,outputCostPerMillion}', '')::numeric,
         nullif(model #>> '{pricing,cachedCostPerMillion}', '')::numeric,
         nullif(model #>> '{configuration,profitMargin}', '')::numeric,
         coalesce(nullif(model #>> '{configuration,tokenRoundingUnit}', '')::integer, 0),
         coalesce(nullif(model #>> '{configuration,maxContextRounds}', '')::integer, 12),
         coalesce(nullif(model #>> '{configuration,maxContextTokens}', '')::integer, 64000),
         coalesce(nullif(model #>> '{configuration,maxReplyTokens}', '')::integer, 4096),
         coalesce(nullif(model #>> '{configuration,timeout}', '')::integer, 300),
         nullif(model #>> '{configuration,temperature}', '')::numeric,
         nullif(model #>> '{configuration,responseFormat}', ''),
         model->>'catalogState' = 'enabled', model->>'catalogState' <> 'enabled',
         coalesce(nullif(model->>'sortOrder', '')::integer, 0),
         coalesce(model #>> '{configuration,userAccess}', 'available'),
         coalesce(model #>> '{configuration,adminNotes}', ''),
         coalesce(model #>> '{configuration,iconUrl}', ''), now()
    FROM jsonb_array_elements(p_snapshot->'models') model
    LEFT JOIN public.platform_model_credential_bindings binding
      ON binding.credential_ref = model->>'credentialRef'
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false)
  ON CONFLICT (id) DO UPDATE SET
    name = excluded.name, model_name = excluded.model_name, description = excluded.description,
    category = excluded.category, api_endpoint = excluded.api_endpoint,
    proxy_url = excluded.proxy_url,
    api_key = CASE WHEN excluded.api_key <> '' THEN excluded.api_key ELSE public.llm_models.api_key END,
    billing_mode = excluded.billing_mode, cost_per_use = excluded.cost_per_use,
    cost_price = excluded.cost_price, token_billing_enabled = excluded.token_billing_enabled,
    input_cost_per_million = excluded.input_cost_per_million,
    output_cost_per_million = excluded.output_cost_per_million,
    cached_cost_per_million = excluded.cached_cost_per_million,
    profit_margin = excluded.profit_margin, token_rounding_unit = excluded.token_rounding_unit,
    max_context_rounds = excluded.max_context_rounds, max_context_tokens = excluded.max_context_tokens,
    max_reply_tokens = excluded.max_reply_tokens, timeout = excluded.timeout,
    temperature = excluded.temperature, response_format = excluded.response_format,
    is_active = excluded.is_active, is_hidden = excluded.is_hidden,
    sort_order = excluded.sort_order, user_access = excluded.user_access,
    admin_notes = excluded.admin_notes, icon_url = excluded.icon_url, updated_at = now();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  SELECT count(*) INTO v_expected FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false);
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_LLM_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.llm_models target SET is_active = false, is_hidden = true, updated_at = now()
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text AND delta.removed = true) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
       AND model #>> '{configuration,legacyId}' = target.id::text);

  INSERT INTO public.chat_models (
    id, model_name, display_name, icon_url, description, proxy_url, api_key,
    is_active, sort_order, updated_at
  )
  SELECT (model #>> '{configuration,legacyId}')::uuid, model->>'modelName', model->>'name',
         coalesce(model #>> '{configuration,iconUrl}', ''), coalesce(model #>> '{configuration,description}', ''),
         model->>'endpoint', coalesce(binding.secret_value, ''), model->>'catalogState' = 'enabled',
         coalesce(nullif(model->>'sortOrder', '')::integer, 0), now()
    FROM jsonb_array_elements(p_snapshot->'models') model
    LEFT JOIN public.platform_model_credential_bindings binding
      ON binding.credential_ref = model->>'credentialRef'
   WHERE model #>> '{configuration,legacyTable}' = 'chat_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'chat_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false)
  ON CONFLICT (id) DO UPDATE SET
    model_name = excluded.model_name, display_name = excluded.display_name,
    icon_url = excluded.icon_url, description = excluded.description,
    proxy_url = excluded.proxy_url,
    api_key = CASE WHEN excluded.api_key <> '' THEN excluded.api_key ELSE public.chat_models.api_key END,
    is_active = excluded.is_active, sort_order = excluded.sort_order, updated_at = now();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  SELECT count(*) INTO v_expected FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'chat_models' AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'chat_models' AND delta.legacy_id = model #>> '{configuration,legacyId}' AND delta.removed = false);
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_CHAT_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.chat_models target SET is_active = false, updated_at = now()
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'chat_models' AND delta.legacy_id = target.id::text AND delta.removed = true) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' = 'chat_models'
       AND model #>> '{configuration,legacyId}' = target.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_delta jsonb;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->>'schema' <> 'model-pool-config/v1'
     OR jsonb_typeof(p_snapshot->'models') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_CONFIGURATION_SCHEMA_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' NOT IN ('cover_models', 'video_models', 'llm_models', 'chat_models')
        OR coalesce(model #>> '{configuration,legacyId}', '') = ''
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_LEGACY_IDENTITY_INVALID';
  END IF;


  -- Freeze before the lower layer writes credentials or activation fields.
  SELECT coalesce(jsonb_agg(to_jsonb(delta)), '[]'::jsonb) INTO v_delta
    FROM public.model_pool_projection_delta(p_snapshot) delta;
  PERFORM public.project_model_pool_configuration_atomic_before_llm_gate(p_snapshot, v_delta);
END;
$$;

-- Internal overload: trusted service_role/owner callers supply one frozen delta.
CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(p_snapshot jsonb, p_delta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
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
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_delta jsonb;
BEGIN
  -- Freeze before the lower layer writes credentials or activation fields.
  SELECT coalesce(jsonb_agg(to_jsonb(delta)), '[]'::jsonb) INTO v_delta
    FROM public.model_pool_projection_delta(p_snapshot) delta;
  PERFORM public.project_model_pool_configuration_atomic_before_explicit_protoco(p_snapshot, v_delta);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
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
   WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset(v_delta) AS delta(legacy_table text, legacy_id text, removed boolean) WHERE delta.legacy_table = 'llm_models' AND delta.legacy_id = target.id::text);
END;
$$;
REVOKE ALL ON FUNCTION public.model_pool_projection_delta(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO zimeiti_owner; END IF; END $grant$;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO zimeiti_owner; END IF; END $grant$;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb) TO zimeiti_owner; END IF; END $grant$;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb) TO zimeiti_owner; END IF; END $grant$;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb,jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_explicit_protoco(jsonb,jsonb) TO zimeiti_owner; END IF; END $grant$;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb,jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic_before_llm_gate(jsonb,jsonb) TO zimeiti_owner; END IF; END $grant$;
NOTIFY pgrst, 'reload schema';
COMMIT;
