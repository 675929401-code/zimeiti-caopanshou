BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.reconcile_stale_image_generation_request_atomic(text,text,integer);

NOTIFY pgrst, 'reload schema';
COMMIT;
