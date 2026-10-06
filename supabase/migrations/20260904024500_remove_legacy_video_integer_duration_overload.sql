-- Keep one unambiguous reservation RPC for PostgREST. The numeric-duration
-- implementation supports both whole and fractional seconds, so the legacy
-- integer overload is no longer needed and makes JSON RPC dispatch ambiguous.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.reserve_video_generation_task_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,
  text,text,text,text,integer,text,text,text,text,text,text,integer,text
);

NOTIFY pgrst, 'reload schema';
COMMIT;
