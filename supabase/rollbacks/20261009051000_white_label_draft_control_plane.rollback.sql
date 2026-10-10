BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.white_label_profiles LIMIT 1) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_WHITE_LABEL_PROFILES_EXIST';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.save_white_label_draft_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.read_white_label_admin_state();
DROP TRIGGER IF EXISTS white_label_profile_events_immutable ON public.white_label_profile_events;
DROP FUNCTION IF EXISTS public.reject_white_label_event_mutation();
DROP TABLE IF EXISTS public.white_label_profile_events;
DROP TABLE IF EXISTS public.white_label_profiles;

COMMIT;
