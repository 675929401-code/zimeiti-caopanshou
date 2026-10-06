BEGIN;

-- Manual rollback for 20260829223000_manju_config_storage_state.sql.
-- Refuse to erase the cutover control plane after any scope has moved native;
-- an operator must first perform an explicit, separately reviewed recovery.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.manju_config_storage_state
     WHERE state = 'native'
  ) OR EXISTS (
    SELECT 1
      FROM public.manju_config_audit
     WHERE action IN ('storage_reconcile', 'cutover')
  ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_ROLLBACK_REQUIRES_MANUAL_RECOVERY'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS manju_config_storage_state_guard
  ON public.manju_config_storage_state;

DROP FUNCTION IF EXISTS public.cutover_manju_config_storage(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, text
);
DROP FUNCTION IF EXISTS public.commit_manju_config_compat_envelope(
  text, text, bigint, timestamptz, jsonb
);
DROP FUNCTION IF EXISTS public.reconcile_manju_config_storage_to_compat(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text
);
DROP FUNCTION IF EXISTS public.reconcile_manju_config_storage_to_native(
  text, text, bigint, uuid, uuid, text, text
);

DROP TABLE IF EXISTS public.manju_config_storage_state;
DROP FUNCTION IF EXISTS public.manju_config_guard_storage_state();

ALTER TABLE public.manju_config_audit
  DROP CONSTRAINT manju_config_audit_action_check;
ALTER TABLE public.manju_config_audit
  ADD CONSTRAINT manju_config_audit_action_check CHECK (
    action IN ('validate', 'create_draft', 'update_draft', 'publish', 'rollback')
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
