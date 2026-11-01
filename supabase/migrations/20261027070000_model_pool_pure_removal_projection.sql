BEGIN;

-- A strict subset release owns only its removals. Unrelated pre-existing
-- physical-row/credential drift remains outside that release's projection.
-- CREATE OR REPLACE preserves the existing function owner; ACL stays unchanged.
CREATE OR REPLACE FUNCTION public.model_pool_projection_delta(p_snapshot jsonb)
RETURNS TABLE(legacy_table text, legacy_id text, removed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $delta$
DECLARE
  v_current_count integer;
  v_current_models jsonb;
  v_models jsonb;
BEGIN
  SELECT count(*) INTO v_current_count
    FROM public.model_pool_config_releases release
   WHERE release.is_current AND release.status = 'published';
  IF v_current_count > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_CURRENT_IDENTITY_AMBIGUOUS';
  END IF;
  IF v_current_count = 1 THEN
    SELECT release.snapshot->'models' INTO v_current_models
      FROM public.model_pool_config_releases release
     WHERE release.is_current AND release.status = 'published';
  END IF;

  -- Reject ambiguous identities instead of allowing subset joins to hide an
  -- entry. Check each snapshot separately: the same survivor in both is valid.
  FOREACH v_models IN ARRAY ARRAY[p_snapshot->'models', v_current_models] LOOP
    IF jsonb_typeof(v_models) = 'array' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_models) model
         WHERE jsonb_typeof(model->'id') IS DISTINCT FROM 'string'
            OR coalesce(model->>'id', '') = ''
            OR jsonb_typeof(model #> '{configuration,legacyTable}') IS DISTINCT FROM 'string'
            OR model #>> '{configuration,legacyTable}' NOT IN ('cover_models', 'video_models', 'llm_models', 'chat_models')
            OR jsonb_typeof(model #> '{configuration,legacyId}') IS DISTINCT FROM 'string'
            OR coalesce(model #>> '{configuration,legacyId}', '') = ''
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_LEGACY_IDENTITY_INVALID';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_models) model
         GROUP BY model->>'id' HAVING count(*) > 1
      ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_models) model
         GROUP BY model #>> '{configuration,legacyTable}', model #>> '{configuration,legacyId}'
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'MODEL_POOL_LEGACY_IDENTITY_AMBIGUOUS';
      END IF;
    END IF;
  END LOOP;

  IF v_current_count = 1
     AND jsonb_typeof(v_current_models) = 'array'
     AND jsonb_typeof(p_snapshot->'models') = 'array'
     AND jsonb_array_length(p_snapshot->'models') < jsonb_array_length(v_current_models)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') next(model)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_current_models) old(model)
           WHERE old.model = next.model
        )
     ) THEN
    RETURN QUERY
    SELECT old.model #>> '{configuration,legacyTable}', old.model #>> '{configuration,legacyId}', true
      FROM jsonb_array_elements(v_current_models) old(model)
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') next(model)
        WHERE old.model = next.model
     );
    RETURN;
  END IF;

  -- Original drift-repair semantics, byte-preserved below for every other
  -- release (including no-op, additions, or any changed survivor).
  RETURN QUERY
WITH old_entries AS (
 SELECT model FROM public.model_pool_config_releases release,
 LATERAL jsonb_array_elements(release.snapshot->'models') model
 WHERE release.is_current AND release.status = 'published'
), next_entries AS (SELECT model FROM jsonb_array_elements(p_snapshot->'models') model),
physical AS (
 SELECT 'cover_models'::text AS tbl,id::text AS id,api_key FROM public.cover_models
 UNION ALL SELECT 'video_models',id::text,api_key FROM public.video_models
 UNION ALL SELECT 'llm_models',id::text,api_key FROM public.llm_models
 UNION ALL SELECT 'chat_models',id::text,api_key FROM public.chat_models
)
SELECT next.model #>> '{configuration,legacyTable}',next.model #>> '{configuration,legacyId}',false
FROM next_entries next
LEFT JOIN old_entries old ON old.model #>> '{configuration,legacyTable}' = next.model #>> '{configuration,legacyTable}'
 AND old.model #>> '{configuration,legacyId}' = next.model #>> '{configuration,legacyId}'
LEFT JOIN physical physical_row ON physical_row.tbl = next.model #>> '{configuration,legacyTable}' AND physical_row.id = next.model #>> '{configuration,legacyId}'
LEFT JOIN public.platform_model_credential_bindings binding ON binding.credential_ref = next.model->>'credentialRef'
WHERE old.model IS DISTINCT FROM next.model OR physical_row.id IS NULL
 OR (coalesce(binding.secret_value,'') <> '' AND binding.secret_value IS DISTINCT FROM physical_row.api_key)
UNION ALL
SELECT old.model #>> '{configuration,legacyTable}',old.model #>> '{configuration,legacyId}',true
FROM old_entries old WHERE NOT EXISTS (SELECT 1 FROM next_entries next
 WHERE old.model #>> '{configuration,legacyTable}' = next.model #>> '{configuration,legacyTable}'
 AND old.model #>> '{configuration,legacyId}' = next.model #>> '{configuration,legacyId}');
END;
$delta$;

REVOKE ALL ON FUNCTION public.model_pool_projection_delta(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO service_role;
DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN GRANT EXECUTE ON FUNCTION public.model_pool_projection_delta(jsonb) TO zimeiti_owner; END IF; END $grant$;

COMMIT;
