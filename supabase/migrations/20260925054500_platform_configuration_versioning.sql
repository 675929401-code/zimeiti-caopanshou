-- Immutable logical configuration streams for the global model pool and
-- workspace assignments. Runtime/business rows remain separate until every
-- legacy mutation path has been routed through this control plane.

CREATE TABLE IF NOT EXISTS public.model_pool_config_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_version bigint NOT NULL UNIQUE CHECK (release_version > 0),
  schema_version text NOT NULL DEFAULT 'model-pool-config/v1'
    CHECK (schema_version = 'model-pool-config/v1'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validated', 'published', 'superseded', 'failed')),
  is_current boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'schema' = 'model-pool-config/v1'
  ),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(validation_result) = 'object'),
  change_note text NOT NULL DEFAULT '' CHECK (length(change_note) <= 1000),
  parent_release_id uuid REFERENCES public.model_pool_config_releases(id) ON DELETE RESTRICT,
  rollback_target_id uuid REFERENCES public.model_pool_config_releases(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  published_at timestamptz,
  CHECK (is_current = false OR status = 'published')
);

CREATE TABLE IF NOT EXISTS public.workspace_model_config_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_version bigint NOT NULL UNIQUE CHECK (release_version > 0),
  schema_version text NOT NULL DEFAULT 'workspace-model-config/v1'
    CHECK (schema_version = 'workspace-model-config/v1'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validated', 'published', 'superseded', 'failed')),
  is_current boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'schema' = 'workspace-model-config/v1'
  ),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(validation_result) = 'object'),
  change_note text NOT NULL DEFAULT '' CHECK (length(change_note) <= 1000),
  parent_release_id uuid REFERENCES public.workspace_model_config_releases(id) ON DELETE RESTRICT,
  rollback_target_id uuid REFERENCES public.workspace_model_config_releases(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  published_at timestamptz,
  CHECK (is_current = false OR status = 'published')
);

-- Credentials are operational bindings, not logical release contents. A
-- rollback intentionally keeps the current environment credential while the
-- immutable snapshot only carries its secret:// reference.
CREATE TABLE IF NOT EXISTS public.platform_model_credential_bindings (
  credential_ref text PRIMARY KEY CHECK (credential_ref ~ '^secret://platform-model/[A-Za-z0-9._/-]+$'),
  model_key text NOT NULL UNIQUE,
  secret_value text NOT NULL CHECK (length(secret_value) > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS model_pool_config_one_current
  ON public.model_pool_config_releases (is_current) WHERE is_current = true;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_model_config_one_current
  ON public.workspace_model_config_releases (is_current) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS model_pool_config_release_status_idx
  ON public.model_pool_config_releases (status, release_version DESC);
CREATE INDEX IF NOT EXISTS workspace_model_config_release_status_idx
  ON public.workspace_model_config_releases (status, release_version DESC);

ALTER TABLE public.model_pool_config_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_model_config_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_model_credential_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.model_pool_config_releases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_model_config_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_pool_config_releases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_model_config_releases TO service_role;
REVOKE ALL ON public.platform_model_credential_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_model_credential_bindings TO service_role;

CREATE OR REPLACE FUNCTION public.reject_platform_configuration_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_RELEASE_DELETE_FORBIDDEN';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.release_version IS DISTINCT FROM OLD.release_version
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.change_note IS DISTINCT FROM OLD.change_note
     OR NEW.parent_release_id IS DISTINCT FROM OLD.parent_release_id
     OR NEW.rollback_target_id IS DISTINCT FROM OLD.rollback_target_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_SNAPSHOT_IMMUTABLE';
  END IF;

  IF OLD.status = 'superseded' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_HISTORY_IMMUTABLE';
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status = 'superseded'
       AND NEW.is_current = false
       AND NEW.validation_result IS NOT DISTINCT FROM OLD.validation_result
       AND NEW.validated_at IS NOT DISTINCT FROM OLD.validated_at
       AND NEW.published_by IS NOT DISTINCT FROM OLD.published_by
       AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at THEN
      RETURN NEW;
    END IF;
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_PUBLISHED_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'validated', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_STATUS_TRANSITION_INVALID';
  ELSIF OLD.status = 'validated' AND NEW.status NOT IN ('draft', 'validated', 'published', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_STATUS_TRANSITION_INVALID';
  ELSIF OLD.status = 'failed' AND NEW.status NOT IN ('draft', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_STATUS_TRANSITION_INVALID';
  END IF;

  IF NEW.is_current AND NEW.status <> 'published' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_CONFIGURATION_CURRENT_STATUS_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS model_pool_config_release_immutable ON public.model_pool_config_releases;
CREATE TRIGGER model_pool_config_release_immutable
  BEFORE UPDATE OR DELETE ON public.model_pool_config_releases
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_configuration_release_mutation();
DROP TRIGGER IF EXISTS workspace_model_config_release_immutable ON public.workspace_model_config_releases;
CREATE TRIGGER workspace_model_config_release_immutable
  BEFORE UPDATE OR DELETE ON public.workspace_model_config_releases
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_configuration_release_mutation();

CREATE OR REPLACE FUNCTION public.create_platform_configuration_candidate_atomic(
  p_kind text,
  p_actor_id uuid,
  p_snapshot jsonb,
  p_snapshot_sha256 text,
  p_validation_result jsonb,
  p_status text,
  p_change_note text,
  p_parent_release_id uuid,
  p_rollback_target_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next_version bigint;
  v_model_release public.model_pool_config_releases%ROWTYPE;
  v_model_target public.model_pool_config_releases%ROWTYPE;
  v_workspace_release public.workspace_model_config_releases%ROWTYPE;
  v_workspace_target public.workspace_model_config_releases%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('model-pool', 'workspace-models')
     OR p_actor_id IS NULL
     OR p_status NOT IN ('draft', 'validated')
     OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_validation_result) IS DISTINCT FROM 'object'
     OR p_snapshot_sha256 !~ '^[a-f0-9]{64}$'
     OR length(coalesce(p_change_note, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_CONFIGURATION_CANDIDATE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-candidate:' || p_kind, 0));

  IF p_kind = 'model-pool' THEN
    IF p_snapshot->>'schema' <> 'model-pool-config/v1' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_CONFIGURATION_SCHEMA_INVALID';
    END IF;
    IF p_rollback_target_id IS NOT NULL THEN
      SELECT * INTO v_model_target
        FROM public.model_pool_config_releases
       WHERE id = p_rollback_target_id
         AND status IN ('published', 'superseded')
         AND is_current = false;
      IF NOT FOUND
         OR v_model_target.snapshot IS DISTINCT FROM p_snapshot
         OR v_model_target.snapshot_sha256 IS DISTINCT FROM p_snapshot_sha256 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_ROLLBACK_TARGET_INVALID';
      END IF;
    END IF;
    SELECT coalesce(max(release_version), 0) + 1
      INTO v_next_version FROM public.model_pool_config_releases;
    INSERT INTO public.model_pool_config_releases (
      release_version, snapshot, snapshot_sha256, validation_result, status,
      change_note, parent_release_id, rollback_target_id, created_by, validated_at
    ) VALUES (
      v_next_version, p_snapshot, p_snapshot_sha256, p_validation_result, p_status,
      coalesce(p_change_note, ''), p_parent_release_id, p_rollback_target_id, p_actor_id,
      CASE WHEN p_status = 'validated' THEN now() ELSE NULL END
    ) RETURNING * INTO v_model_release;
    RETURN to_jsonb(v_model_release);
  END IF;

  IF p_snapshot->>'schema' <> 'workspace-model-config/v1' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_CONFIGURATION_SCHEMA_INVALID';
  END IF;
  IF p_rollback_target_id IS NOT NULL THEN
    SELECT * INTO v_workspace_target
      FROM public.workspace_model_config_releases
     WHERE id = p_rollback_target_id
       AND status IN ('published', 'superseded')
       AND is_current = false;
    IF NOT FOUND
       OR v_workspace_target.snapshot IS DISTINCT FROM p_snapshot
       OR v_workspace_target.snapshot_sha256 IS DISTINCT FROM p_snapshot_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_ROLLBACK_TARGET_INVALID';
    END IF;
  END IF;
  SELECT coalesce(max(release_version), 0) + 1
    INTO v_next_version FROM public.workspace_model_config_releases;
  INSERT INTO public.workspace_model_config_releases (
    release_version, snapshot, snapshot_sha256, validation_result, status,
    change_note, parent_release_id, rollback_target_id, created_by, validated_at
  ) VALUES (
    v_next_version, p_snapshot, p_snapshot_sha256, p_validation_result, p_status,
    coalesce(p_change_note, ''), p_parent_release_id, p_rollback_target_id, p_actor_id,
    CASE WHEN p_status = 'validated' THEN now() ELSE NULL END
  ) RETURNING * INTO v_workspace_release;
  RETURN to_jsonb(v_workspace_release);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_configuration_order_map(p_ids jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_object_agg(value, ordinality * 10 ORDER BY ordinality), '{}'::jsonb)
    FROM jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) WITH ORDINALITY;
$$;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
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
   WHERE model #>> '{configuration,legacyTable}' = 'cover_models'
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
   WHERE model #>> '{configuration,legacyTable}' = 'cover_models';
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_COVER_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.cover_models target SET is_active = false, is_hidden = true, updated_at = now()
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
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
   WHERE model #>> '{configuration,legacyTable}' = 'video_models'
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
   WHERE model #>> '{configuration,legacyTable}' = 'video_models';
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_VIDEO_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.video_models target SET is_active = false, is_hidden = true
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
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
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
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
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models';
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_LLM_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.llm_models target SET is_active = false, is_hidden = true, updated_at = now()
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
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
   WHERE model #>> '{configuration,legacyTable}' = 'chat_models'
  ON CONFLICT (id) DO UPDATE SET
    model_name = excluded.model_name, display_name = excluded.display_name,
    icon_url = excluded.icon_url, description = excluded.description,
    proxy_url = excluded.proxy_url,
    api_key = CASE WHEN excluded.api_key <> '' THEN excluded.api_key ELSE public.chat_models.api_key END,
    is_active = excluded.is_active, sort_order = excluded.sort_order, updated_at = now();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  SELECT count(*) INTO v_expected FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'chat_models';
  IF v_affected <> v_expected THEN RAISE EXCEPTION 'MODEL_POOL_CHAT_PROJECTION_INCOMPLETE'; END IF;
  UPDATE public.chat_models target SET is_active = false, updated_at = now()
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE model #>> '{configuration,legacyTable}' = 'chat_models'
       AND model #>> '{configuration,legacyId}' = target.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_workspace_model_configuration_atomic(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_assignments jsonb;
  v_image_orders jsonb;
  v_video_orders jsonb;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->>'schema' <> 'workspace-model-config/v1'
     OR jsonb_typeof(p_snapshot->'surfaces') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_CONFIGURATION_SCHEMA_INVALID';
  END IF;
  SELECT jsonb_build_object('version', 1, 'surfaces', coalesce(jsonb_object_agg(surface, assignments), '{}'::jsonb))
    INTO v_assignments
    FROM (
      SELECT key AS surface,
             (SELECT coalesce(jsonb_object_agg(model_id, true), '{}'::jsonb)
                FROM jsonb_array_elements_text(value->'assignedModelIds') model_id) AS assignments
        FROM jsonb_each(p_snapshot->'surfaces')
    ) configured;
  v_image_orders := jsonb_build_object('version', 1, 'surfaces', jsonb_build_object(
    'image-workbench', public.platform_configuration_order_map(p_snapshot #> '{surfaces,image-workbench,orderedModelIds}'),
    'cover-studio', public.platform_configuration_order_map(p_snapshot #> '{surfaces,cover-studio,orderedModelIds}'),
    'storyboard-workbench', public.platform_configuration_order_map(p_snapshot #> '{surfaces,storyboard-image,orderedModelIds}'),
    'free-canvas', public.platform_configuration_order_map(p_snapshot #> '{surfaces,free-canvas-image,orderedModelIds}'),
    'film-studio', public.platform_configuration_order_map(p_snapshot #> '{surfaces,film-studio-image,orderedModelIds}')
  ));
  v_video_orders := jsonb_build_object('version', 1, 'surfaces', jsonb_build_object(
    'ai-video', public.platform_configuration_order_map(p_snapshot #> '{surfaces,video-page,orderedModelIds}'),
    'storyboard', public.platform_configuration_order_map(p_snapshot #> '{surfaces,storyboard-video,orderedModelIds}'),
    'free-canvas', public.platform_configuration_order_map(p_snapshot #> '{surfaces,free-canvas-video,orderedModelIds}'),
    'film-studio', public.platform_configuration_order_map(p_snapshot #> '{surfaces,film-studio-video,orderedModelIds}'),
    'commerce-agent', public.platform_configuration_order_map(p_snapshot #> '{surfaces,commerce-video,orderedModelIds}')
  ));
  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at) VALUES
    ('workspace_model_assignment_overrides_v1', v_assignments::text, now()),
    ('image_model_surface_orders_v1', v_image_orders::text, now()),
    ('video_model_surface_orders_v1', v_video_orders::text, now())
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = excluded.setting_value, updated_at = excluded.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic(
  p_kind text,
  p_release_id uuid,
  p_actor_id uuid,
  p_expected_candidate_sha256 text,
  p_expected_current_id uuid,
  p_expected_current_sha256 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_has_current boolean := false;
  v_model_current public.model_pool_config_releases%ROWTYPE;
  v_model_candidate public.model_pool_config_releases%ROWTYPE;
  v_workspace_current public.workspace_model_config_releases%ROWTYPE;
  v_workspace_candidate public.workspace_model_config_releases%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('model-pool', 'workspace-models')
     OR p_release_id IS NULL
     OR p_actor_id IS NULL
     OR p_expected_candidate_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_CONFIGURATION_PUBLISH_INVALID';
  END IF;

  -- A workspace release is only coherent while its referenced model-pool
  -- release is still current. Take the dependency lock before the workspace
  -- lock so a concurrent model-pool switch cannot slip between the API check
  -- and this atomic publication transaction.
  IF p_kind = 'workspace-models' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool', 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:' || p_kind, 0));

  IF p_kind = 'model-pool' THEN
    SELECT * INTO v_model_current
      FROM public.model_pool_config_releases
     WHERE is_current = true
     FOR UPDATE;
    v_has_current := FOUND;
    SELECT * INTO v_model_candidate
      FROM public.model_pool_config_releases
     WHERE id = p_release_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND'; END IF;
    IF v_model_candidate.is_current OR v_model_candidate.status <> 'validated' THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_VALIDATED';
    END IF;
    IF v_model_candidate.snapshot_sha256 <> p_expected_candidate_sha256 THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CANDIDATE_CHANGED';
    END IF;
    IF (NOT v_has_current AND (p_expected_current_id IS NOT NULL OR p_expected_current_sha256 IS NOT NULL))
       OR (v_has_current AND (p_expected_current_id IS NULL
         OR v_model_current.id <> p_expected_current_id
         OR v_model_current.snapshot_sha256 <> p_expected_current_sha256)) THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CURRENT_CHANGED';
    END IF;
    -- Projection and current-pointer switch share this transaction. Existing
    -- runtime readers therefore never observe a published identity whose
    -- legacy physical catalog still belongs to another snapshot.
    PERFORM public.project_model_pool_configuration_atomic(v_model_candidate.snapshot);
    IF v_has_current THEN
      UPDATE public.model_pool_config_releases
         SET status = 'superseded', is_current = false
       WHERE id = v_model_current.id;
    END IF;
    UPDATE public.model_pool_config_releases
       SET status = 'published', is_current = true,
           published_by = p_actor_id, published_at = now()
     WHERE id = p_release_id
     RETURNING * INTO v_model_candidate;
    RETURN to_jsonb(v_model_candidate);
  END IF;

  SELECT * INTO v_workspace_current
    FROM public.workspace_model_config_releases
   WHERE is_current = true
   FOR UPDATE;
  v_has_current := FOUND;
  SELECT * INTO v_workspace_candidate
    FROM public.workspace_model_config_releases
   WHERE id = p_release_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND'; END IF;
  IF v_workspace_candidate.is_current OR v_workspace_candidate.status <> 'validated' THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_VALIDATED';
  END IF;
  IF v_workspace_candidate.snapshot_sha256 <> p_expected_candidate_sha256 THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CANDIDATE_CHANGED';
  END IF;
  SELECT * INTO v_model_current
    FROM public.model_pool_config_releases
   WHERE is_current = true AND status = 'published'
   FOR SHARE;
  IF NOT FOUND
     OR v_workspace_candidate.snapshot #>> '{modelPoolRelease,releaseId}' IS DISTINCT FROM v_model_current.id::text
     OR v_workspace_candidate.snapshot #>> '{modelPoolRelease,snapshotSha256}' IS DISTINCT FROM v_model_current.snapshot_sha256 THEN
    RAISE EXCEPTION 'WORKSPACE_MODEL_POOL_NOT_CURRENT';
  END IF;
  IF (NOT v_has_current AND (p_expected_current_id IS NOT NULL OR p_expected_current_sha256 IS NOT NULL))
     OR (v_has_current AND (p_expected_current_id IS NULL
       OR v_workspace_current.id <> p_expected_current_id
       OR v_workspace_current.snapshot_sha256 <> p_expected_current_sha256)) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CURRENT_CHANGED';
  END IF;
  PERFORM public.project_workspace_model_configuration_atomic(v_workspace_candidate.snapshot);
  UPDATE public.workspace_model_config_releases
     SET status = 'superseded', is_current = false
   WHERE v_has_current AND id = v_workspace_current.id;
  UPDATE public.workspace_model_config_releases
     SET status = 'published', is_current = true,
         published_by = p_actor_id, published_at = now()
   WHERE id = p_release_id
   RETURNING * INTO v_workspace_candidate;
  RETURN to_jsonb(v_workspace_candidate);
END;
$$;

REVOKE ALL ON FUNCTION public.create_platform_configuration_candidate_atomic(text, uuid, jsonb, text, jsonb, text, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_platform_configuration_release_atomic(text, uuid, uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_configuration_order_map(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_workspace_model_configuration_atomic(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_configuration_candidate_atomic(text, uuid, jsonb, text, jsonb, text, text, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_platform_configuration_release_atomic(text, uuid, uuid, text, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_configuration_order_map(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_workspace_model_configuration_atomic(jsonb) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_pool_config_releases TO zimeiti_owner;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_model_config_releases TO zimeiti_owner;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_model_credential_bindings TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.create_platform_configuration_candidate_atomic(text, uuid, jsonb, text, jsonb, text, text, uuid, uuid) TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.publish_platform_configuration_release_atomic(text, uuid, uuid, text, uuid, text) TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.platform_configuration_order_map(jsonb) TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO zimeiti_owner;
    GRANT EXECUTE ON FUNCTION public.project_workspace_model_configuration_atomic(jsonb) TO zimeiti_owner;
  END IF;
END;
$$;

COMMENT ON TABLE public.model_pool_config_releases IS
  'Immutable logical global model-pool snapshots; credentials remain environment references.';
COMMENT ON TABLE public.workspace_model_config_releases IS
  'Immutable workspace assignment/order snapshots; never mutates global model enabled state.';

NOTIFY pgrst, 'reload schema';
