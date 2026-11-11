BEGIN;
-- Stop V2 writes without reintroducing a known invalid PostgreSQL regex or
-- deleting immutable history. A reviewed forward release must regrant writes.
REVOKE EXECUTE ON FUNCTION public.mutate_publish_v2_atomic(text,jsonb) FROM service_role;
COMMIT;
