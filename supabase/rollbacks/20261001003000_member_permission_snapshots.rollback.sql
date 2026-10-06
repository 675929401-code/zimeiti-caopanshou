BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.member_permission_events') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.member_permission_events
       WHERE source NOT IN ('migration_compat')
     ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_MEMBER_PERMISSION_EVENTS_EXIST';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS users_member_permission_projection_sync ON public.users;
DROP FUNCTION IF EXISTS public.sync_member_permission_from_user();
DROP FUNCTION IF EXISTS public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer);
DROP FUNCTION IF EXISTS public.read_member_permission_snapshot(text);
DROP TRIGGER IF EXISTS member_permission_event_write_guard ON public.member_permission_events;
DROP TRIGGER IF EXISTS member_permission_assignment_write_guard ON public.member_permission_assignments;
DROP FUNCTION IF EXISTS public.guard_member_permission_event_write();
DROP FUNCTION IF EXISTS public.guard_member_permission_assignment_write();
DROP TABLE IF EXISTS public.member_permission_events;
DROP TABLE IF EXISTS public.member_permission_assignments;
DROP TABLE IF EXISTS public.member_permission_profiles;
DROP FUNCTION IF EXISTS public.resolve_legacy_member_agent_keys(jsonb);
DROP FUNCTION IF EXISTS public.member_permission_checksum(text,jsonb,jsonb,integer);
DROP FUNCTION IF EXISTS public.normalize_member_agent_keys(jsonb);
DROP FUNCTION IF EXISTS public.normalize_member_feature_keys(jsonb);
NOTIFY pgrst, 'reload schema';
COMMIT;

