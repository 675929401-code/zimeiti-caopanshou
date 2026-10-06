-- Guarded rollback: once any immutable release exists, use a forward repair
-- migration. Dropping either stream would erase audit and rollback lineage.

DO $$
BEGIN
  IF to_regclass('public.model_pool_config_releases') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.model_pool_config_releases LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'PLATFORM_CONFIGURATION_ROLLBACK_REQUIRES_EMPTY_RELEASE_TABLES';
  END IF;
  IF to_regclass('public.workspace_model_config_releases') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.workspace_model_config_releases LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'PLATFORM_CONFIGURATION_ROLLBACK_REQUIRES_EMPTY_RELEASE_TABLES';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.publish_platform_configuration_release_atomic(text, uuid, uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.project_workspace_model_configuration_atomic(jsonb);
DROP FUNCTION IF EXISTS public.project_model_pool_configuration_atomic(jsonb);
DROP FUNCTION IF EXISTS public.platform_configuration_order_map(jsonb);
DROP FUNCTION IF EXISTS public.create_platform_configuration_candidate_atomic(text, uuid, jsonb, text, jsonb, text, text, uuid, uuid);
DROP TABLE IF EXISTS public.platform_model_credential_bindings;
DROP TABLE IF EXISTS public.workspace_model_config_releases;
DROP TABLE IF EXISTS public.model_pool_config_releases;
DROP FUNCTION IF EXISTS public.reject_platform_configuration_release_mutation();

NOTIFY pgrst, 'reload schema';
