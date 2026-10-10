BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

REVOKE ALL ON FUNCTION public.apply_agent_reorder_cas_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_coze_agent_import_cas_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.apply_agent_reorder_cas_v1(jsonb);
DROP FUNCTION IF EXISTS public.apply_coze_agent_import_cas_v1(jsonb);

DO $ledger_cleanup$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    DELETE FROM supabase_migrations.schema_migrations
    WHERE version::text = '20261010140000';
  END IF;
END;
$ledger_cleanup$;

NOTIFY pgrst, 'reload schema';
COMMIT;
