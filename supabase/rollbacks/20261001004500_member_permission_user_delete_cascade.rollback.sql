BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.guard_member_permission_assignment_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.member_permission_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_member_permission_event_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR coalesce(current_setting('app.member_permission_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_EVENT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

