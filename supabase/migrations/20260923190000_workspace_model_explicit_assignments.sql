-- Separate the shared model resource pool from per-workspace model selection.
-- Missing assignment entries are intentionally closed: a model appears in a
-- product workspace only after that exact surface contains an explicit true.

DO $$
DECLARE
  v_setting_key CONSTANT text := 'workspace_model_assignment_overrides_v1';
  v_backup_key CONSTANT text := 'workspace_model_assignment_overrides_v1_backup_20260923';
  v_raw text;
  v_existing jsonb := '{}'::jsonb;
  v_surfaces jsonb := '{}'::jsonb;
  v_seed jsonb := '{}'::jsonb;
  v_seed_count bigint := 0;
  v_surface text;
BEGIN
  SELECT setting_value INTO v_raw
    FROM public.platform_settings
   WHERE setting_key = v_setting_key;

  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
  VALUES (
    v_backup_key,
    jsonb_build_object('existed', v_raw IS NOT NULL, 'setting_value', v_raw)::text,
    now()
  )
  ON CONFLICT (setting_key) DO NOTHING;

  IF v_raw IS NOT NULL AND btrim(v_raw) <> '' THEN
    BEGIN
      v_existing := v_raw::jsonb;
    EXCEPTION WHEN others THEN
      v_existing := '{}'::jsonb;
    END;
  END IF;
  v_surfaces := CASE
    WHEN jsonb_typeof(v_existing->'surfaces') = 'object' THEN v_existing->'surfaces'
    WHEN jsonb_typeof(v_existing) = 'object' THEN v_existing - 'version'
    ELSE '{}'::jsonb
  END;

  SELECT coalesce(jsonb_object_agg(id, true), '{}'::jsonb), count(*)
    INTO v_seed, v_seed_count
    FROM public.cover_models
   WHERE provider IS DISTINCT FROM 'retired_configuration'
     AND id = ANY (ARRAY[
       'gpt-image-25-sunburst-chA', 'gpt-image-2-chA-1',
       'gpt-image-25-flare-chA', 'gemini-3-1-flash-image-chA',
       'gemini-3-0-pro-image-chA', 'cover-model-seedream-5-pro'
     ]::text[]);
  FOREACH v_surface IN ARRAY ARRAY['image-workbench', 'cover-studio', 'storyboard-image'] LOOP
    IF NOT (v_surfaces ? v_surface)
       OR CASE WHEN jsonb_typeof(v_surfaces->v_surface) = 'object'
               THEN v_surfaces->v_surface = '{}'::jsonb
               ELSE true END THEN
      IF v_seed_count <> 6 THEN
        RAISE EXCEPTION 'workspace assignment image seed incomplete: expected 6, found %', v_seed_count;
      END IF;
      v_surfaces := jsonb_set(v_surfaces, ARRAY[v_surface], v_seed, true);
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_object_agg(id, true), '{}'::jsonb), count(*)
    INTO v_seed, v_seed_count
    FROM public.video_models
   WHERE provider IS DISTINCT FROM 'retired_configuration'
     AND id = ANY (ARRAY[
       'omni-flash-10s-720p-ch3', 'grok-imagine-1.0-10s-ch3',
       'omni-flash-10s-1080p-ch3', 'minimax-h3-autodl-hosted-lightx2v-v5',
       'secure-skill-flow-omni-ch14', 'minimax-h3-autodl-hosted-image-audio-v2',
       'veo-3-1-chC',
       'secure-skill-flow-veo-3-1-i2v-lite-ch14',
       'secure-skill-flow-veo-3-1-i2v-fast-ch14',
       'secure-skill-minimax-h3-ecommerce-ch36',
       'secure-skill-wan3-video-ch40', 'secure-skill-wan3-video-prime-ch40'
     ]::text[]);
  IF NOT (v_surfaces ? 'storyboard-video')
     OR CASE WHEN jsonb_typeof(v_surfaces->'storyboard-video') = 'object'
             THEN v_surfaces->'storyboard-video' = '{}'::jsonb
             ELSE true END THEN
    IF v_seed_count <> 12 THEN
      RAISE EXCEPTION 'workspace assignment storyboard-video seed incomplete: expected 12, found %', v_seed_count;
    END IF;
    v_surfaces := jsonb_set(v_surfaces, ARRAY['storyboard-video'], v_seed, true);
  END IF;

  SELECT coalesce(jsonb_object_agg(id, true), '{}'::jsonb), count(*)
    INTO v_seed, v_seed_count
    FROM public.video_models
   WHERE provider IS DISTINCT FROM 'retired_configuration'
     AND id = ANY (ARRAY[
       'secure-skill-flow-omni-ch14', 'omni-video-edit-chA',
       'omni-flash-abra-edit-ch3', 'omni-flash-10s-720p-ch3',
       'omni-flash-10s-1080p-ch3', 'grok-imagine-1.0-10s-ch3',
       'minimax-h3-autodl-hosted-lightx2v-v5', 'minimax-h3-autodl-hosted-text',
       'minimax-h3-autodl-hosted-image-audio-v2', 'minimax-h3-768p-lc',
       'minimax-h3-2k-lc', 'grok-imagine-1.5-15s-ch3',
       'grok-imagine-1.0-super-20s-ch4', 'grok-imagine-image-pro-10s-ch4',
       'veo-3-1-fast-chC', 'grok-imagine-1.0-super-10s-ch4',
       'veo-3-1-chC', 'grok-imagine-1.0-super-720p-10s-ch4',
       'grok-imagine-video-1-5-fast-chA',
       'grok-imagine-video-1-5-preview-chA',
       'secure-skill-flow-veo-3-1-i2v-lite-ch14',
       'secure-skill-flow-veo-3-1-i2v-fast-ch14',
       'secure-skill-flow-veo-3-1-interpolation-lite-ch14',
       'secure-skill-flow-veo-3-1-r2v-fast-ch14',
       'secure-skill-flow-veo-3-1-t2v-fast-ch14',
       'secure-skill-flow-veo-3-1-t2v-lite-ch14',
       'secure-skill-minimax-h3-ecommerce-ch36',
       'secure-skill-wan3-video-ch40', 'secure-skill-wan3-video-prime-ch40'
     ]::text[]);
  IF NOT (v_surfaces ? 'video-page')
     OR CASE WHEN jsonb_typeof(v_surfaces->'video-page') = 'object'
             THEN v_surfaces->'video-page' = '{}'::jsonb
             ELSE true END THEN
    IF v_seed_count <> 29 THEN
      RAISE EXCEPTION 'workspace assignment video-page seed incomplete: expected 29, found %', v_seed_count;
    END IF;
    v_surfaces := jsonb_set(v_surfaces, ARRAY['video-page'], v_seed, true);
  END IF;

  SELECT coalesce(jsonb_object_agg(id, true), '{}'::jsonb), count(*)
    INTO v_seed, v_seed_count
    FROM public.video_models
   WHERE provider IS DISTINCT FROM 'retired_configuration'
     AND id = ANY (ARRAY[
       'minimax-h3-autodl-hosted-lightx2v-v5',
       'minimax-h3-autodl-hosted-image-audio-v2',
       'secure-skill-flow-omni-ch14',
       'secure-skill-flow-veo-3-1-r2v-fast-ch14',
       'secure-skill-minimax-h3-ecommerce-ch36',
       'secure-skill-wan3-video-ch40', 'secure-skill-wan3-video-prime-ch40'
     ]::text[]);
  IF NOT (v_surfaces ? 'commerce-video')
     OR CASE WHEN jsonb_typeof(v_surfaces->'commerce-video') = 'object'
             THEN v_surfaces->'commerce-video' = '{}'::jsonb
             ELSE true END THEN
    IF v_seed_count <> 7 THEN
      RAISE EXCEPTION 'workspace assignment commerce-video seed incomplete: expected 7, found %', v_seed_count;
    END IF;
    v_surfaces := jsonb_set(v_surfaces, ARRAY['commerce-video'], v_seed, true);
  END IF;

  INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
  VALUES (
    'workspace_model_assignment_overrides_v1',
    jsonb_build_object('version', 1, 'surfaces', v_surfaces)::text,
    now()
  )
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = excluded.setting_value,
        updated_at = excluded.updated_at;
END $$;
