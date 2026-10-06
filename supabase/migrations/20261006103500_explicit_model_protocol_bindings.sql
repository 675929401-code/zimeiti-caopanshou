BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- A channel/provider and a wire protocol are different identities. Persist the
-- binding on every model so runtime code never has to infer it from a host or
-- model alias.
ALTER TABLE public.llm_models
  ADD COLUMN IF NOT EXISTS api_protocol_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cover_models
  ADD COLUMN IF NOT EXISTS api_protocol_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.video_models
  ADD COLUMN IF NOT EXISTS api_protocol_config jsonb NOT NULL DEFAULT '{}'::jsonb;

WITH source AS (
  SELECT id,
         coalesce(api_protocol_config, '{}'::jsonb) AS config,
         lower(coalesce(api_endpoint, proxy_url, '')) AS endpoint,
         lower(coalesce(model_name, '')) AS model_name
    FROM public.llm_models
), normalized AS (
  SELECT id, config,
         coalesce(nullif(config->>'provider', ''), CASE
           WHEN endpoint LIKE '%n.lconai.com%' THEN 'lc_anthropic'
           WHEN endpoint LIKE '%s.lconai.com%' THEN 'lc_openai'
           WHEN endpoint LIKE '%token.secure-skill.com%' THEN 'secure_skill'
           WHEN endpoint LIKE '%api.deepseek.com%' THEN 'deepseek_official'
           WHEN endpoint LIKE '%api.openai.com%' THEN 'openai_official'
           WHEN endpoint LIKE '%api.anthropic.com%' THEN 'anthropic_official'
           WHEN endpoint LIKE '%bigmodel.cn%' THEN 'zhipu_official'
           ELSE 'legacy_configured'
         END) AS provider,
         CASE
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', '')) IN ('anthropic', 'anthropic_messages', 'claude_messages')
             THEN 'anthropic_messages'
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', '')) IN ('openai', 'openai_chat', 'openai_chat_completions', 'chat_completions')
             THEN 'openai_chat'
           WHEN model_name LIKE '%claude%' AND endpoint LIKE '%n.lconai.com%' THEN 'anthropic_messages'
           WHEN model_name LIKE '%claude%' AND endpoint LIKE '%anthropic.com%' THEN 'anthropic_messages'
           ELSE 'openai_chat'
         END AS protocol
    FROM source
)
UPDATE public.llm_models target
   SET api_protocol_config = normalized.config || jsonb_build_object(
         'provider', normalized.provider,
         'protocol', normalized.protocol,
         'auth_scheme', coalesce(nullif(normalized.config->>'auth_scheme', ''),
           CASE WHEN normalized.provider = 'anthropic_official' THEN 'x-api-key' ELSE 'bearer' END)
       ) || CASE WHEN normalized.protocol = 'anthropic_messages'
            THEN jsonb_build_object('protocol_version', coalesce(nullif(normalized.config->>'protocol_version', ''), '2023-06-01'))
            ELSE '{}'::jsonb END,
       updated_at = now()
  FROM normalized
 WHERE target.id = normalized.id;

UPDATE public.cover_models
   SET provider = 'legacy_configured'
 WHERE coalesce(btrim(provider), '') = '';

WITH source AS (
  SELECT id,
         coalesce(api_protocol_config, '{}'::jsonb) AS config,
         lower(coalesce(provider, '')) AS provider,
         supports_image_input
    FROM public.cover_models
), normalized AS (
  SELECT id, config, supports_image_input,
         CASE
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', config->>'image_protocol', '')) ~ 'google|gemini.*generate' THEN 'google_generate_content'
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', config->>'image_protocol', '')) ~ 'chat' THEN 'chat_completions'
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', config->>'image_protocol', '')) ~ 'edit' THEN 'images_edits'
           WHEN lower(coalesce(config->>'protocol', config->>'protocol_type', config->>'image_protocol', '')) ~ 'generation|secure[_-]?skill[_-]?images|openai[_-]?image|volcengine[_-]?images' THEN 'images_generations'
           WHEN lower(coalesce(config->>'reference_transport', config->>'image_reference_transport', '')) = 'chat_inline_data' THEN 'chat_completions'
           WHEN lower(coalesce(config->>'reference_transport', config->>'image_reference_transport', '')) LIKE 'edits_%' THEN 'images_edits'
           WHEN lower(coalesce(config->>'reference_transport', config->>'image_reference_transport', '')) = 'generations_url_array' THEN 'images_generations'
           WHEN provider = 'secure_skill_chat' THEN 'chat_completions'
           WHEN provider = 'gemini_native' THEN 'google_generate_content'
           ELSE 'images_generations'
         END AS protocol
    FROM source
)
UPDATE public.cover_models target
   SET api_protocol_config = normalized.config || jsonb_build_object(
         'protocol', normalized.protocol,
         'reference_transport', coalesce(
           nullif(normalized.config->>'reference_transport', ''),
           CASE normalized.protocol
             WHEN 'chat_completions' THEN 'chat_inline_data'
             WHEN 'google_generate_content' THEN 'chat_inline_data'
             WHEN 'images_edits' THEN CASE WHEN normalized.supports_image_input THEN 'edits_multipart_array' ELSE 'none' END
             ELSE CASE WHEN normalized.supports_image_input THEN 'generations_url_array' ELSE 'none' END
           END
         )
       ),
       updated_at = now()
  FROM normalized
 WHERE target.id = normalized.id;

UPDATE public.video_models
   SET provider = CASE WHEN coalesce(btrim(provider), '') = '' THEN 'legacy_configured' ELSE provider END,
       protocol_type = CASE WHEN coalesce(btrim(protocol_type), '') = '' THEN 'openai_compatible' ELSE protocol_type END;

ALTER TABLE public.llm_models DROP CONSTRAINT IF EXISTS llm_models_api_protocol_config_object;
ALTER TABLE public.llm_models ADD CONSTRAINT llm_models_api_protocol_config_object
  CHECK (jsonb_typeof(api_protocol_config) = 'object');
ALTER TABLE public.cover_models DROP CONSTRAINT IF EXISTS cover_models_api_protocol_config_object;
ALTER TABLE public.cover_models ADD CONSTRAINT cover_models_api_protocol_config_object
  CHECK (jsonb_typeof(api_protocol_config) = 'object');
ALTER TABLE public.video_models DROP CONSTRAINT IF EXISTS video_models_api_protocol_config_object;
ALTER TABLE public.video_models ADD CONSTRAINT video_models_api_protocol_config_object
  CHECK (jsonb_typeof(api_protocol_config) = 'object');

ALTER FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  RENAME TO project_model_pool_configuration_atomic_before_explicit_protocol;

CREATE OR REPLACE FUNCTION public.project_model_pool_configuration_atomic(p_snapshot jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
BEGIN
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
         'chat_completions', 'google_generate_content', 'images_generations', 'images_edits',
         'secure_skill_images', 'volcengine_images_v3', 'openai_image'
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

  PERFORM public.project_model_pool_configuration_atomic_before_explicit_protocol(p_snapshot);

  UPDATE public.llm_models target
     SET api_protocol_config = coalesce(model #> '{configuration,protocolConfig}', target.api_protocol_config, '{}'::jsonb),
         updated_at = now()
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
     AND target.id::text = model #>> '{configuration,legacyId}';

  -- Protocol changes invalidate earlier paid validation evidence just like an
  -- endpoint/key/model change. Unchanged models retain their active state.
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
         updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb)
  TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN
    GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO zimeiti_owner;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
