BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE ALL ON public.commerce_home_catalog_entries FROM PUBLIC, anon, authenticated, service_role;
DROP TABLE IF EXISTS public.commerce_home_catalog_entries;

NOTIFY pgrst, 'reload schema';

COMMIT;
