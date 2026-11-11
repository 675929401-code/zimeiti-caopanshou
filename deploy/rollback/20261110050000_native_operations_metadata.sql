BEGIN;
-- Retain immutable V2 versions, native metadata and all audit events. Existing
-- publishing quotas and wallet history are unaffected; no automatic refunds.
REVOKE EXECUTE ON FUNCTION public.mutate_native_metadata_atomic(text,jsonb) FROM service_role;
COMMIT;
