BEGIN;
-- Retain content, references, immutable replay receipts and execution guards.
REVOKE EXECUTE ON FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) FROM service_role;
COMMIT;
