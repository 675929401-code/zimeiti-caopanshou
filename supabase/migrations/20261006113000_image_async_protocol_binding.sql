BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Extend the explicit model-pool contract with the provider-documented
-- asynchronous Images Generations transport. The provider/channel remains a
-- separate field; publishing one async image model cannot change another
-- model's protocol.
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

  PERFORM public.project_model_pool_configuration_atomic_before_explicit_protocol(p_snapshot);

  UPDATE public.llm_models target
     SET api_protocol_config = coalesce(model #> '{configuration,protocolConfig}', target.api_protocol_config, '{}'::jsonb),
         updated_at = now()
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}' = 'llm_models'
     AND target.id::text = model #>> '{configuration,legacyId}';

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
