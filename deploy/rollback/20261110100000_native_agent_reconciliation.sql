BEGIN;
SET LOCAL lock_timeout='10s';
-- Preserve original task history, authoritative main results and all wallet evidence.
REVOKE EXECUTE ON FUNCTION public.reconcile_native_agent_main_atomic(text,uuid,text,text,text,text) FROM service_role;
COMMIT;
