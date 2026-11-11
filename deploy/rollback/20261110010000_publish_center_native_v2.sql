-- Revoke V2 writes while preserving immutable snapshots, quota/financial history
-- and V1 service access. A later reviewed forward migration can regrant access.
BEGIN;
REVOKE EXECUTE ON FUNCTION public.mutate_publish_v2_atomic(text,jsonb) FROM service_role;
COMMIT;
