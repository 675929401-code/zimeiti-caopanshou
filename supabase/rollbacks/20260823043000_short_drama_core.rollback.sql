BEGIN;

-- Post-deployment rollback is intentionally fail-closed. It may only remove an
-- unused short-drama schema. Once any project, job, asset, version, prompt or
-- settlement exists, data-preserving rollback requires a reviewed follow-up
-- migration instead of this destructive teardown.
DO $rollback_guard$
DECLARE
  v_table text;
  v_count bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'short_drama_settlements',
    'short_drama_assets',
    'short_drama_jobs',
    'short_drama_prompt_snapshots',
    'short_drama_shots',
    'short_drama_entities',
    'short_drama_project_versions',
    'short_drama_projects'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'SHORT_DRAMA_ROLLBACK_REFUSED_NONEMPTY:%:%', v_table, v_count;
      END IF;
    END IF;
  END LOOP;
END;
$rollback_guard$;

DROP FUNCTION IF EXISTS public.short_drama_delete_project(varchar, uuid, integer);
DROP FUNCTION IF EXISTS public.short_drama_update_project(varchar, uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.short_drama_create_project(
  varchar, text, text, text, text, text, jsonb, jsonb
);

-- No CASCADE: any unknown dependency aborts the transaction for manual review.
DROP TABLE IF EXISTS public.short_drama_settlements;
DROP TABLE IF EXISTS public.short_drama_assets;
DROP TABLE IF EXISTS public.short_drama_jobs;
DROP TABLE IF EXISTS public.short_drama_prompt_snapshots;
DROP TABLE IF EXISTS public.short_drama_shots;
DROP TABLE IF EXISTS public.short_drama_entities;
DROP TABLE IF EXISTS public.short_drama_project_versions;
DROP TABLE IF EXISTS public.short_drama_projects;
DROP FUNCTION IF EXISTS public.short_drama_touch_updated_at();

COMMIT;
