BEGIN;

DO $$
DECLARE
  has_rows boolean := false;
BEGIN
  IF to_regclass('public.user_profile_avatars') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.user_profile_avatars LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED_USER_PROFILE_AVATARS_EXIST';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS public.user_profile_avatars;

COMMIT;
