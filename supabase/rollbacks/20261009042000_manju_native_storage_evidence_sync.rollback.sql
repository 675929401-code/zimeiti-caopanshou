BEGIN;

DROP TRIGGER IF EXISTS manju_config_active_native_storage_evidence
  ON public.manju_config_active;
DROP FUNCTION IF EXISTS public.manju_config_sync_native_storage_evidence();

COMMIT;

