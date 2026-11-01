-- Read-only scoped digital-human asset preflight; no provider, billing or business-data writes.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.read_gaorui_person_asset_preflight_v1(
  p_user_id text,
  p_owned_asset_id text,
  p_model_id text,
  p_provider_origin text,
  p_credential_binding_fingerprint text
) RETURNS TABLE(scope jsonb, state text, result jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT operation.scope, operation.state, operation.result
    FROM public.gaorui_provider_asset_operations AS operation
   WHERE p_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND p_owned_asset_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND length(p_model_id) BETWEEN 1 AND 200
     AND p_model_id = btrim(p_model_id)
     AND p_provider_origin = 'https://gaorui.cc'
     AND p_credential_binding_fingerprint ~ '^[a-f0-9]{64}$'
     AND operation.scope->>'user_id' = p_user_id
     AND operation.scope->>'owned_asset_id' = p_owned_asset_id
     AND operation.scope->>'model_id' = p_model_id
     AND operation.scope->>'provider_origin' = p_provider_origin
     AND operation.scope->>'credential_binding_fingerprint' = p_credential_binding_fingerprint
     AND EXISTS (
       SELECT 1 FROM public.user_files AS asset
        WHERE asset.id::text = p_owned_asset_id
          AND asset.user_id::text = p_user_id
          AND asset.file_category = 'image'
          AND asset.source = 'digital-human-input'
          AND asset.storage_provider = 'tencent_cos'
          AND asset.storage_key = operation.scope->>'storage_key'
          AND nullif(to_jsonb(asset)->>'deleted_at', '') IS NULL
          AND coalesce(to_jsonb(asset)->>'is_deleted', 'false') <> 'true'
          AND nullif(asset.meta->>'deleted_at', '') IS NULL
          AND nullif(asset.meta->>'deletedAt', '') IS NULL
          AND coalesce(asset.meta->>'deleted', 'false') <> 'true'
     )
   ORDER BY operation.updated_at DESC, operation.scope_key
   -- The reader treats 101 rows as overflow, never a complete cache verdict.
   LIMIT 101;
$$;

ALTER FUNCTION public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text) OWNER TO zimeiti_owner;
REVOKE ALL ON FUNCTION public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text) TO service_role;
COMMIT;
