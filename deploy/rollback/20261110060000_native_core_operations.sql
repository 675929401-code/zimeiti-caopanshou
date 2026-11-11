BEGIN;
-- Preserve all native requests, immutable content and events. Stop this newly
-- introduced mutation entry point without altering prior quotas or history.
-- Local account-disconnection admission guards deliberately remain active;
-- rollback never revives a disconnected grant or changes provider outcomes.
REVOKE EXECUTE ON FUNCTION public.mutate_native_core_atomic(text,jsonb) FROM service_role;
COMMIT;
