BEGIN;
-- Preserve authorization/billing/attempt history. Disable official API writes;
-- V1 and V2 plugin paths and their ledger remain under their original policy.
REVOKE EXECUTE ON FUNCTION public.mutate_publish_v3_atomic(text,jsonb) FROM service_role;
COMMIT;
