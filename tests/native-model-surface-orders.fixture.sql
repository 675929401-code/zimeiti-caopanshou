-- Local reviewed database only. Metadata projection writes are rolled back;
-- release hashes, models, credentials and application balances are untouched.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE native_model_surface_fixture_results(name text PRIMARY KEY,passed boolean NOT NULL);
CREATE FUNCTION pg_temp.order_assert(p boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FIXTURE_ASSERTION_FAILED: %',label;END IF;INSERT INTO native_model_surface_fixture_results VALUES(label,true);END$$;
DO $$DECLARE snapshot jsonb:='{"schema":"workspace-model-config/v1","surfaces":{}}';surface text;projected jsonb;original_image jsonb;original_video jsonb;before_releases jsonb;BEGIN
 SELECT jsonb_build_object('workspace',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'sha256',snapshot_sha256) ORDER BY id) FROM public.workspace_model_config_releases),'[]'::jsonb),'model',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'sha256',snapshot_sha256) ORDER BY id) FROM public.model_pool_config_releases),'[]'::jsonb)) INTO before_releases;
 FOREACH surface IN ARRAY ARRAY['image-workbench','cover-studio','storyboard-image','free-canvas-image','film-studio-image','video-page','storyboard-video','free-canvas-video','film-studio-video','commerce-video'] LOOP snapshot:=jsonb_set(snapshot,ARRAY['surfaces',surface],'{"assignedModelIds":["pm_fixture_b","pm_fixture_a"],"orderedModelIds":["pm_fixture_b","pm_fixture_a"]}');END LOOP;
 PERFORM public.project_workspace_model_configuration_atomic(snapshot);
 SELECT setting_value::jsonb INTO original_image FROM public.platform_settings WHERE setting_key='image_model_surface_orders_v1';
 SELECT setting_value::jsonb INTO original_video FROM public.platform_settings WHERE setting_key='video_model_surface_orders_v1';
 PERFORM pg_temp.order_assert(original_image='{"version":1,"surfaces":{"image-workbench":{"pm_fixture_b":10,"pm_fixture_a":20},"cover-studio":{"pm_fixture_b":10,"pm_fixture_a":20},"storyboard-workbench":{"pm_fixture_b":10,"pm_fixture_a":20},"free-canvas":{"pm_fixture_b":10,"pm_fixture_a":20},"film-studio":{"pm_fixture_b":10,"pm_fixture_a":20}}}'::jsonb,'old image five surfaces retain exact keys and ordering');
 PERFORM pg_temp.order_assert(original_video='{"version":1,"surfaces":{"ai-video":{"pm_fixture_b":10,"pm_fixture_a":20},"storyboard":{"pm_fixture_b":10,"pm_fixture_a":20},"free-canvas":{"pm_fixture_b":10,"pm_fixture_a":20},"film-studio":{"pm_fixture_b":10,"pm_fixture_a":20},"commerce-agent":{"pm_fixture_b":10,"pm_fixture_a":20}}}'::jsonb,'old video five surfaces retain exact keys and ordering');
 PERFORM pg_temp.order_assert(NOT(original_image->'surfaces'?'publish-center-image') AND NOT(original_video->'surfaces'?'publish-center-video'),'legacy snapshots do not acquire native null or empty keys');
 snapshot:=jsonb_set(snapshot,'{surfaces,publish-center-image}','{"assignedModelIds":["pm_fixture_native_a","pm_fixture_native_b"],"orderedModelIds":["pm_fixture_native_b","pm_fixture_native_a"]}');
 snapshot:=jsonb_set(snapshot,'{surfaces,publish-center-video}','{"assignedModelIds":["pm_fixture_native_c"],"orderedModelIds":["pm_fixture_native_c"]}');
 PERFORM public.project_workspace_model_configuration_atomic(snapshot);
 SELECT setting_value::jsonb INTO projected FROM public.platform_settings WHERE setting_key='image_model_surface_orders_v1';
 PERFORM pg_temp.order_assert(projected->'surfaces'->'publish-center-image'='{"pm_fixture_native_b":10,"pm_fixture_native_a":20}'::jsonb AND (projected#-'{surfaces,publish-center-image}')=original_image,'native image order adds its exact scene without changing old five');
 SELECT setting_value::jsonb INTO projected FROM public.platform_settings WHERE setting_key='video_model_surface_orders_v1';
 PERFORM pg_temp.order_assert(projected->'surfaces'->'publish-center-video'='{"pm_fixture_native_c":10}'::jsonb AND (projected#-'{surfaces,publish-center-video}')=original_video,'native video order adds its exact scene without changing old five');
 SELECT setting_value::jsonb INTO projected FROM public.platform_settings WHERE setting_key='workspace_model_assignment_overrides_v1';
 PERFORM pg_temp.order_assert(projected->'surfaces'->'publish-center-image'='{"pm_fixture_native_a":true,"pm_fixture_native_b":true}'::jsonb AND projected->'surfaces'->'publish-center-video'='{"pm_fixture_native_c":true}'::jsonb,'native assignment projection still follows dynamic surface contract');
 PERFORM pg_temp.order_assert(before_releases=jsonb_build_object('workspace',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'sha256',snapshot_sha256) ORDER BY id) FROM public.workspace_model_config_releases),'[]'::jsonb),'model',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'sha256',snapshot_sha256) ORDER BY id) FROM public.model_pool_config_releases),'[]'::jsonb)),'projection does not mutate immutable release hashes');
END$$;
SELECT name,passed FROM native_model_surface_fixture_results ORDER BY name;
ROLLBACK;

