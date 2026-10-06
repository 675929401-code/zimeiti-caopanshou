-- Keep workspace assignment and per-surface ordering updates from replacing
-- unrelated settings when two administrators save at the same time.

CREATE OR REPLACE FUNCTION public.update_workspace_model_configuration_atomic(
  p_action text,
  p_kind text,
  p_surface text,
  p_model_id text DEFAULT NULL,
  p_enabled boolean DEFAULT NULL,
  p_order_map jsonb DEFAULT NULL,
  p_require_assigned boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_assignment_key CONSTANT text := 'workspace_model_assignment_overrides_v1';
  v_image_order_key CONSTANT text := 'image_model_surface_orders_v1';
  v_video_order_key CONSTANT text := 'video_model_surface_orders_v1';
  v_order_key text;
  v_order_surface text;
  v_keys text[];
  v_assignment_raw text;
  v_order_raw text;
  v_assignment jsonb;
  v_orders jsonb;
  v_surface_assignments jsonb;
  v_model_id text;
BEGIN
  IF p_action IS NULL
     OR p_kind IS NULL
     OR p_surface IS NULL
     OR p_require_assigned IS NULL
     OR p_action NOT IN ('assign', 'reorder')
     OR p_kind NOT IN ('image', 'video') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_MUTATION_INVALID';
  END IF;

  IF (p_kind = 'image' AND p_surface NOT IN (
      'image-workbench', 'cover-studio', 'storyboard-image', 'free-canvas-image', 'film-studio-image'
    )) OR (p_kind = 'video' AND p_surface NOT IN (
      'video-page', 'storyboard-video', 'free-canvas-video', 'film-studio-video', 'commerce-video'
    )) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_SURFACE_INVALID';
  END IF;

  IF p_action = 'assign' THEN
    IF coalesce(btrim(p_model_id), '') = '' OR p_enabled IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_ASSIGNMENT_INVALID';
    END IF;
    v_keys := ARRAY[v_assignment_key];
  ELSE
    IF jsonb_typeof(p_order_map) IS DISTINCT FROM 'object'
       OR p_order_map = '{}'::jsonb
       OR EXISTS (
         SELECT 1
           FROM jsonb_each(p_order_map) entry
          WHERE btrim(entry.key) = ''
             OR jsonb_typeof(entry.value) <> 'number'
             OR (entry.value #>> '{}')::numeric < 0
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_each(p_order_map) entry
          GROUP BY (entry.value #>> '{}')::numeric
         HAVING count(*) > 1
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKSPACE_MODEL_ORDER_INVALID';
    END IF;
    v_order_surface := CASE p_surface
      WHEN 'image-workbench' THEN 'image-workbench'
      WHEN 'cover-studio' THEN 'cover-studio'
      WHEN 'storyboard-image' THEN 'storyboard-workbench'
      WHEN 'free-canvas-image' THEN 'free-canvas'
      WHEN 'film-studio-image' THEN 'film-studio'
      WHEN 'video-page' THEN 'ai-video'
      WHEN 'storyboard-video' THEN 'storyboard'
      WHEN 'free-canvas-video' THEN 'free-canvas'
      WHEN 'film-studio-video' THEN 'film-studio'
      WHEN 'commerce-video' THEN 'commerce-agent'
    END;
    v_order_key := CASE WHEN p_kind = 'image' THEN v_image_order_key ELSE v_video_order_key END;
    v_keys := CASE WHEN p_require_assigned
      THEN ARRAY[v_assignment_key, v_order_key]
      ELSE ARRAY[v_order_key]
    END;
  END IF;

  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
  VALUES
    (v_assignment_key, '{"version":1,"surfaces":{}}', now()),
    (v_image_order_key, '{"version":1,"surfaces":{}}', now()),
    (v_video_order_key, '{"version":1,"surfaces":{}}', now())
  ON CONFLICT (setting_key) DO NOTHING;

  -- Every caller uses the same lexical lock order, including mixed assignment
  -- and ordering mutations, so unrelated surface updates cannot be lost.
  PERFORM setting_key
    FROM public.platform_settings
   WHERE setting_key = ANY (v_keys)
   ORDER BY setting_key
   FOR UPDATE;

  IF v_assignment_key = ANY (v_keys) THEN
    SELECT setting_value INTO v_assignment_raw
      FROM public.platform_settings
     WHERE setting_key = v_assignment_key;
    BEGIN
      v_assignment := v_assignment_raw::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'WORKSPACE_MODEL_ASSIGNMENT_CORRUPT';
    END;
    IF jsonb_typeof(v_assignment) <> 'object'
       OR v_assignment->>'version' <> '1'
       OR jsonb_typeof(v_assignment->'surfaces') <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'WORKSPACE_MODEL_ASSIGNMENT_CORRUPT';
    END IF;
  END IF;

  IF p_action = 'assign' THEN
    v_surface_assignments := coalesce(v_assignment#>ARRAY['surfaces', p_surface], '{}'::jsonb);
    IF jsonb_typeof(v_surface_assignments) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'WORKSPACE_MODEL_ASSIGNMENT_CORRUPT';
    END IF;
    v_surface_assignments := v_surface_assignments || jsonb_build_object(btrim(p_model_id), p_enabled);
    v_assignment := jsonb_set(v_assignment, ARRAY['surfaces', p_surface], v_surface_assignments, true);
    UPDATE public.platform_settings
       SET setting_value = v_assignment::text, updated_at = now()
     WHERE setting_key = v_assignment_key;
    RETURN jsonb_build_object(
      'action', 'assign', 'kind', p_kind, 'surface', p_surface,
      'modelId', btrim(p_model_id), 'assigned', p_enabled
    );
  END IF;

  SELECT setting_value INTO v_order_raw
    FROM public.platform_settings
   WHERE setting_key = v_order_key;
  BEGIN
    v_orders := v_order_raw::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'WORKSPACE_MODEL_ORDER_CORRUPT';
  END;
  IF jsonb_typeof(v_orders) <> 'object'
     OR v_orders->>'version' <> '1'
     OR jsonb_typeof(v_orders->'surfaces') <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'WORKSPACE_MODEL_ORDER_CORRUPT';
  END IF;

  IF p_require_assigned THEN
    v_surface_assignments := coalesce(v_assignment#>ARRAY['surfaces', p_surface], '{}'::jsonb);
    FOR v_model_id IN SELECT jsonb_object_keys(p_order_map)
    LOOP
      IF v_surface_assignments->v_model_id IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'WORKSPACE_MODEL_NOT_ASSIGNED';
      END IF;
    END LOOP;
  END IF;

  v_orders := jsonb_set(v_orders, ARRAY['surfaces', v_order_surface], p_order_map, true);
  UPDATE public.platform_settings
     SET setting_value = v_orders::text, updated_at = now()
   WHERE setting_key = v_order_key;
  RETURN jsonb_build_object(
    'action', 'reorder', 'kind', p_kind, 'surface', p_surface,
    'modelIds', (SELECT coalesce(jsonb_agg(entry.key ORDER BY entry.value::numeric), '[]'::jsonb) FROM jsonb_each(p_order_map) entry)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_workspace_model_configuration_atomic(text, text, text, text, boolean, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_workspace_model_configuration_atomic(text, text, text, text, boolean, jsonb, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';
