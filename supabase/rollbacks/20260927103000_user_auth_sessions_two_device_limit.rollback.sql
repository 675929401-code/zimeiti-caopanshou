BEGIN;

DROP TRIGGER IF EXISTS users_legacy_session_authority ON public.users;
DROP FUNCTION IF EXISTS public.revoke_sessions_on_legacy_session_clear();
DROP FUNCTION IF EXISTS public.revoke_user_auth_session(text, text, text);
DROP FUNCTION IF EXISTS public.issue_user_auth_session(text, text, text, text, timestamptz);
DROP TABLE IF EXISTS public.user_auth_sessions;

NOTIFY pgrst, 'reload schema';

COMMIT;
