BEGIN;
SET LOCAL lock_timeout='10s';
-- Stop new compensation without reversing any allowance already restored.
-- Keep the append-only release ledger, events and terminal operation guard;
-- released operations must remain unable to dispatch even after rollback.
DROP TRIGGER IF EXISTS native_unissued_quota_release_on_blocked ON public.pub3_events;
REVOKE EXECUTE ON FUNCTION public.release_native_unissued_quota_atomic(text,uuid,integer) FROM service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
