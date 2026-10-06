-- Restore the operator-approved model catalog for every product surface.
-- Resource-pool visibility remains independent: this migration only writes
-- explicit per-surface assignments and their stable display order.

DO $$
DECLARE
  v_assignment_key CONSTANT text := 'workspace_model_assignment_overrides_v1';
  v_image_order_key CONSTANT text := 'image_model_surface_orders_v1';
  v_video_order_key CONSTANT text := 'video_model_surface_orders_v1';
  v_backup_key CONSTANT text := 'workspace_model_settings_backup_20260924090000';

  v_image_ids text[] := ARRAY[
    'pending-cover-model-1789087566193-f4a5f4f1190f',
    'pending-cover-model-1789087539302-c79bd2865ca4',
    'cover-model-seedream-5-pro',
    'gemini-3-0-pro-image-chA',
    'gemini-3-1-flash-image-chA',
    'pending-cover-model-gpt-image-2-image-2-1k',
    'pending-cover-model-gpt-image-2-adobe-mid'
  ]::text[];
  v_storyboard_video_ids text[] := ARRAY[
    'minimax-h3-autodl-hosted-image-audio-v2',
    'minimax-h3-autodl-hosted-lightx2v-v5',
    'minimax-h3-768p-lc',
    'omni-flash-10s-720p-ch3',
    'minimax-h3-2k-lc',
    'grok-imagine-1.5-15s-ch3',
    'veo-3-1-fast-chC',
    'grok-imagine-video-1-5-fast-chA',
    'lconai-seedance-2-0-4k',
    'lconai-seedance-2-0-mini-480p',
    'lconai-seedance-2-5-720p',
    'omni-flash-8s-gaorui',
    'veo-3-1-components-gaorui',
    'secure-skill-doubao-seedance-2-0-g37',
    'secure-skill-doubao-seedance-2-0-fast-g37',
    'secure-skill-doubao-seedance-2-5-g37',
    'secure-skill-flow-omni-ch14',
    'secure-skill-flow-veo-3-1-i2v-lite-ch14',
    'secure-skill-flow-veo-3-1-i2v-fast-ch14',
    'secure-skill-flow-veo-3-1-r2v-fast-ch14',
    'secure-skill-seedance-2-5-enterprise-g16',
    'secure-skill-video-2-0-fast-g16',
    'secure-skill-video-2-0-pro-g16',
    'secure-skill-minimax-h3-ecommerce-ch36',
    'secure-skill-wan3-video-ch40',
    'secure-skill-wan3-video-prime-ch40'
  ]::text[];
  v_video_page_ids text[] := ARRAY[
    'omni-flash-8s-gaorui',
    'minimax-h3-autodl-hosted-text',
    'omni-flash-10s-720p-ch3',
    'minimax-h3-768p-lc',
    'minimax-h3-2k-lc',
    'grok-imagine-1.5-15s-ch3',
    'veo-3-1-fast-chC',
    'veo-3-1-chC',
    'grok-imagine-video-1-5-fast-chA',
    'veo-3-1-components-gaorui',
    'secure-skill-flow-omni-ch14',
    'veo-3-1-fl-gaorui',
    'secure-skill-flow-veo-3-1-i2v-lite-ch14',
    'secure-skill-flow-veo-3-1-i2v-fast-ch14',
    'secure-skill-flow-veo-3-1-interpolation-lite-ch14',
    'secure-skill-flow-veo-3-1-r2v-fast-ch14',
    'secure-skill-flow-veo-3-1-t2v-fast-ch14',
    'secure-skill-flow-veo-3-1-t2v-lite-ch14',
    'secure-skill-video-2-0-fast-g16',
    'secure-skill-video-2-0-pro-g16',
    'secure-skill-minimax-h3-ecommerce-ch36'
  ]::text[];
  v_free_canvas_video_ids text[] := ARRAY[
    'minimax-h3-autodl-hosted-lightx2v-v5',
    'minimax-h3-autodl-hosted-text',
    'minimax-h3-autodl-hosted-image-audio-v2',
    'omni-flash-10s-720p-ch3',
    'minimax-h3-768p-lc',
    'minimax-h3-2k-lc',
    'grok-imagine-1.5-15s-ch3',
    'veo-3-1-fast-chC',
    'veo-3-1-chC',
    'grok-imagine-video-1-5-fast-chA',
    'lconai-seedance-2-0-4k',
    'lconai-seedance-2-0-mini-480p',
    'lconai-seedance-2-5-720p',
    'omni-flash-8s-gaorui',
    'veo-3-1-components-gaorui',
    'veo-3-1-fl-gaorui',
    'secure-skill-doubao-seedance-2-0-g37',
    'secure-skill-doubao-seedance-2-0-fast-g37',
    'secure-skill-doubao-seedance-2-5-g37',
    'secure-skill-flow-omni-ch14',
    'secure-skill-flow-veo-3-1-i2v-lite-ch14',
    'secure-skill-flow-veo-3-1-i2v-fast-ch14',
    'secure-skill-flow-veo-3-1-interpolation-lite-ch14',
    'secure-skill-flow-veo-3-1-r2v-fast-ch14',
    'secure-skill-flow-veo-3-1-t2v-fast-ch14',
    'secure-skill-flow-veo-3-1-t2v-lite-ch14',
    'secure-skill-seedance-2-5-enterprise-g16',
    'secure-skill-video-2-0-fast-g16',
    'secure-skill-video-2-0-pro-g16',
    'secure-skill-minimax-h3-ecommerce-ch36',
    'secure-skill-wan3-video-ch40',
    'secure-skill-wan3-video-prime-ch40'
  ]::text[];
  v_commerce_video_ids text[] := ARRAY[
    'secure-skill-doubao-seedance-2-5-g37',
    'minimax-h3-autodl-hosted-lightx2v-v5',
    'minimax-h3-autodl-hosted-image-audio-v2',
    'secure-skill-flow-omni-ch14',
    'secure-skill-flow-veo-3-1-r2v-fast-ch14',
    'secure-skill-minimax-h3-ecommerce-ch36',
    'secure-skill-wan3-video-ch40',
    'secure-skill-wan3-video-prime-ch40'
  ]::text[];

  v_assignment_raw text;
  v_image_order_raw text;
  v_video_order_raw text;
  v_assignment_surfaces jsonb := '{}'::jsonb;
  v_image_order_surfaces jsonb := '{}'::jsonb;
  v_video_order_surfaces jsonb := '{}'::jsonb;
  v_map jsonb;
  v_count integer;
  v_surface text;
BEGIN
  SELECT setting_value INTO v_assignment_raw FROM public.platform_settings WHERE setting_key = v_assignment_key FOR UPDATE;
  SELECT setting_value INTO v_image_order_raw FROM public.platform_settings WHERE setting_key = v_image_order_key FOR UPDATE;
  SELECT setting_value INTO v_video_order_raw FROM public.platform_settings WHERE setting_key = v_video_order_key FOR UPDATE;

  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
  VALUES (
    v_backup_key,
    jsonb_build_object(
      'capturedAt', now(),
      'assignment', v_assignment_raw,
      'imageOrder', v_image_order_raw,
      'videoOrder', v_video_order_raw
    )::text,
    now()
  )
  ON CONFLICT (setting_key) DO NOTHING;

  SELECT count(*) INTO v_count FROM public.cover_models
   WHERE id = ANY(v_image_ids)
     AND provider IS DISTINCT FROM 'retired_configuration'
     AND is_active IS TRUE
     AND coalesce(is_hidden, false) IS FALSE;
  IF v_count <> cardinality(v_image_ids) THEN
    RAISE EXCEPTION 'workspace image catalog incomplete: expected %, found %', cardinality(v_image_ids), v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.video_models
   WHERE id = ANY(v_storyboard_video_ids || v_video_page_ids || v_free_canvas_video_ids || v_commerce_video_ids)
     AND provider IS DISTINCT FROM 'retired_configuration'
     AND is_active IS TRUE
     AND coalesce(is_hidden, false) IS FALSE;
  IF v_count <> (SELECT count(DISTINCT id) FROM unnest(v_storyboard_video_ids || v_video_page_ids || v_free_canvas_video_ids || v_commerce_video_ids) AS ids(id)) THEN
    RAISE EXCEPTION 'workspace video catalog contains missing, hidden, inactive or retired records';
  END IF;

  BEGIN
    v_assignment_surfaces := CASE
      WHEN jsonb_typeof(v_assignment_raw::jsonb->'surfaces') = 'object' THEN v_assignment_raw::jsonb->'surfaces'
      WHEN jsonb_typeof(v_assignment_raw::jsonb) = 'object' THEN v_assignment_raw::jsonb - 'version'
      ELSE '{}'::jsonb END;
  EXCEPTION WHEN others THEN v_assignment_surfaces := '{}'::jsonb;
  END;
  BEGIN
    v_image_order_surfaces := CASE
      WHEN jsonb_typeof(v_image_order_raw::jsonb->'surfaces') = 'object' THEN v_image_order_raw::jsonb->'surfaces'
      WHEN jsonb_typeof(v_image_order_raw::jsonb) = 'object' THEN v_image_order_raw::jsonb - 'version'
      ELSE '{}'::jsonb END;
  EXCEPTION WHEN others THEN v_image_order_surfaces := '{}'::jsonb;
  END;
  BEGIN
    v_video_order_surfaces := CASE
      WHEN jsonb_typeof(v_video_order_raw::jsonb->'surfaces') = 'object' THEN v_video_order_raw::jsonb->'surfaces'
      WHEN jsonb_typeof(v_video_order_raw::jsonb) = 'object' THEN v_video_order_raw::jsonb - 'version'
      ELSE '{}'::jsonb END;
  EXCEPTION WHEN others THEN v_video_order_surfaces := '{}'::jsonb;
  END;

  SELECT jsonb_object_agg(id, true) INTO v_map FROM unnest(v_image_ids) AS ids(id);
  FOREACH v_surface IN ARRAY ARRAY['image-workbench','cover-studio','storyboard-image','free-canvas-image','film-studio-image'] LOOP
    v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY[v_surface], v_map, true);
  END LOOP;
  SELECT jsonb_object_agg(id, true) INTO v_map FROM unnest(v_storyboard_video_ids) AS ids(id);
  v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY['storyboard-video'], v_map, true);
  v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY['film-studio-video'], v_map, true);
  SELECT jsonb_object_agg(id, true) INTO v_map FROM unnest(v_video_page_ids) AS ids(id);
  v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY['video-page'], v_map, true);
  SELECT jsonb_object_agg(id, true) INTO v_map FROM unnest(v_free_canvas_video_ids) AS ids(id);
  v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY['free-canvas-video'], v_map, true);
  SELECT jsonb_object_agg(id, true) INTO v_map FROM unnest(v_commerce_video_ids) AS ids(id);
  v_assignment_surfaces := jsonb_set(v_assignment_surfaces, ARRAY['commerce-video'], v_map, true);

  SELECT jsonb_object_agg(id, (position * 10)::integer) INTO v_map
    FROM unnest(v_image_ids) WITH ORDINALITY AS ids(id, position);
  FOREACH v_surface IN ARRAY ARRAY['image-workbench','cover-studio','storyboard-workbench','free-canvas','film-studio'] LOOP
    v_image_order_surfaces := jsonb_set(v_image_order_surfaces, ARRAY[v_surface], v_map, true);
  END LOOP;
  SELECT jsonb_object_agg(id, (position * 10)::integer) INTO v_map
    FROM unnest(v_storyboard_video_ids) WITH ORDINALITY AS ids(id, position);
  v_video_order_surfaces := jsonb_set(v_video_order_surfaces, ARRAY['storyboard'], v_map, true);
  v_video_order_surfaces := jsonb_set(v_video_order_surfaces, ARRAY['film-studio'], v_map, true);
  SELECT jsonb_object_agg(id, (position * 10)::integer) INTO v_map
    FROM unnest(v_video_page_ids) WITH ORDINALITY AS ids(id, position);
  v_video_order_surfaces := jsonb_set(v_video_order_surfaces, ARRAY['ai-video'], v_map, true);
  SELECT jsonb_object_agg(id, (position * 10)::integer) INTO v_map
    FROM unnest(v_free_canvas_video_ids) WITH ORDINALITY AS ids(id, position);
  v_video_order_surfaces := jsonb_set(v_video_order_surfaces, ARRAY['free-canvas'], v_map, true);
  SELECT jsonb_object_agg(id, (position * 10)::integer) INTO v_map
    FROM unnest(v_commerce_video_ids) WITH ORDINALITY AS ids(id, position);
  v_video_order_surfaces := jsonb_set(v_video_order_surfaces, ARRAY['commerce-agent'], v_map, true);

  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at) VALUES
    (v_assignment_key, jsonb_build_object('version', 1, 'surfaces', v_assignment_surfaces)::text, now()),
    (v_image_order_key, jsonb_build_object('version', 1, 'surfaces', v_image_order_surfaces)::text, now()),
    (v_video_order_key, jsonb_build_object('version', 1, 'surfaces', v_video_order_surfaces)::text, now())
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = excluded.setting_value,
        updated_at = excluded.updated_at;
END $$;
