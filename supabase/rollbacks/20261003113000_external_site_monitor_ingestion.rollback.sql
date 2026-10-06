BEGIN;
SET LOCAL lock_timeout = '10s';

-- Keep append-only probe and audit evidence. Rollback removes only the two
-- external-monitor RPC entry points so historical evidence remains auditable.
DROP FUNCTION IF EXISTS public.get_external_site_monitor_status(integer);
DROP FUNCTION IF EXISTS public.ingest_external_site_monitor_probe(
  text,text,text,text,text,text,text,text,timestamptz,timestamptz,text,integer,timestamptz,timestamptz,text,text,jsonb
);

NOTIFY pgrst, 'reload schema';
COMMIT;
