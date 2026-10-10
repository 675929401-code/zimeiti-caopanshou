BEGIN;

DROP TRIGGER IF EXISTS user_auth_sessions_exclusive_write_guard ON public.user_auth_sessions;
DROP FUNCTION IF EXISTS public.enforce_exclusive_user_auth_session_write();

COMMIT;
