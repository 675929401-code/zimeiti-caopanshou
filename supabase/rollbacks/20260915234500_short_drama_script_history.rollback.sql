BEGIN;

DROP FUNCTION IF EXISTS public.finalize_short_drama_script_request_atomic(text,text,text,text,jsonb,text,jsonb,text,integer,text,text);
DROP FUNCTION IF EXISTS public.claim_short_drama_script_request_atomic(text,text,text,jsonb,text,text,text);
DROP TABLE IF EXISTS public.short_drama_script_requests;

COMMIT;
