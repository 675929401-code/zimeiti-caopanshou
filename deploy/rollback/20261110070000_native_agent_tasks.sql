BEGIN;
SET LOCAL lock_timeout='10s';
-- Stop new mutations. Preserve tasks, immutable events, execution references and all main-site billing facts.
REVOKE EXECUTE ON FUNCTION public.mutate_native_agent_atomic(text,jsonb) FROM service_role;
COMMIT;
