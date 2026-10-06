BEGIN;

DO $$
DECLARE
  has_rows boolean := false;
BEGIN
  IF to_regclass('public.user_appearance_preferences') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.user_appearance_preferences LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED_USER_APPEARANCE_PREFERENCES_EXIST';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS public.user_appearance_preferences;

COMMIT;
