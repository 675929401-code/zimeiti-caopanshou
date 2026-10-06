BEGIN;

-- Roll back only the newly admitted protocol identifiers. Existing model rows
-- must be changed back through a reviewed model-pool release before applying
-- this rollback, otherwise the function will intentionally reject them.
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
    SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'llm_models'
       AND (coalesce(model #>> '{configuration,protocolConfig,provider}', '') = ''
         OR coalesce(model #>> '{configuration,protocolConfig,protocol}', '') NOT IN ('openai_chat', 'anthropic_messages'))
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'cover_models'
       AND coalesce(model #>> '{configuration,protocolConfig,protocol}', '') NOT IN (
         'chat_completions', 'google_generate_content', 'images_generations', 'images_edits',
         'secure_skill_images', 'volcengine_images_v3', 'openai_image')
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
     WHERE (model #>> '{configuration,legacyTable}') = 'video_models'
       AND (coalesce(model->>'provider', '') = '' OR coalesce(model->>'protocol', '') = '')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_PROTOCOL_BINDING_REQUIRED';
  END IF;

  SELECT coalesce(jsonb_object_agg(id::text,jsonb_build_object('active',is_active,'userAccess',user_access,'protocolConfig',api_protocol_config)),'{}'::jsonb)
    INTO v_before FROM public.llm_models;
  PERFORM public.project_model_pool_configuration_atomic_before_explicit_protocol(p_snapshot);
  UPDATE public.llm_models target
     SET api_protocol_config=coalesce(model #> '{configuration,protocolConfig}',target.api_protocol_config,'{}'::jsonb),updated_at=now()
    FROM jsonb_array_elements(p_snapshot->'models') model
   WHERE model #>> '{configuration,legacyTable}'='llm_models' AND target.id::text=model #>> '{configuration,legacyId}';
  UPDATE public.llm_models target
     SET is_active=target.is_active AND coalesce((v_before->target.id::text->>'active')::boolean,false)
       AND (v_before->target.id::text->'protocolConfig') IS NOT DISTINCT FROM target.api_protocol_config,
         user_access=CASE WHEN target.is_hidden OR target.user_access='hidden' THEN 'hidden'
           WHEN target.user_access='available' AND v_before->target.id::text->>'userAccess'='available'
             AND (v_before->target.id::text->'protocolConfig') IS NOT DISTINCT FROM target.api_protocol_config THEN 'available'
           ELSE 'pending_model_activation' END,updated_at=now();
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
