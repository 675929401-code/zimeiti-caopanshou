BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
-- A published native ordering cannot be silently removed by downgrade.
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM public.workspace_model_config_releases WHERE (snapshot->'surfaces') ?| ARRAY['publish-center-image','publish-center-video'])
 OR EXISTS(SELECT 1 FROM public.platform_settings WHERE setting_key IN ('image_model_surface_orders_v1','video_model_surface_orders_v1') AND (setting_value::jsonb->'surfaces') ?| ARRAY['publish-center-image','publish-center-video']) THEN
  RAISE EXCEPTION 'NATIVE_MODEL_SURFACE_ROLLBACK_REQUIRES_FORWARD_REPAIR';
 END IF;
END$$;
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
NOTIFY pgrst,'reload schema';
COMMIT;
