BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DROP TRIGGER IF EXISTS users_admin_access_profile_seed ON public.users;
DROP FUNCTION IF EXISTS public.seed_admin_access_profile();
DROP FUNCTION IF EXISTS public.admin_governance_health();
DROP FUNCTION IF EXISTS public.create_admin_account_atomic(text,text,text,text,text,text,jsonb,text);
DROP FUNCTION IF EXISTS public.set_admin_access_profile_atomic(text,text,jsonb,boolean,integer,text,text);
DROP FUNCTION IF EXISTS public.revoke_admin_step_up_sessions(text,text);
DROP FUNCTION IF EXISTS public.read_admin_step_up_session(text,text,text);
DROP FUNCTION IF EXISTS public.create_admin_step_up_session(text,text,jsonb,integer,text,text,text,timestamptz);
DROP FUNCTION IF EXISTS public.append_admin_governance_audit(text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.read_admin_access_snapshot(text);

DROP TRIGGER IF EXISTS admin_governance_audit_write_guard ON public.admin_governance_audit;
DROP TRIGGER IF EXISTS admin_step_up_write_guard ON public.admin_step_up_sessions;
DROP TRIGGER IF EXISTS admin_access_profile_write_guard ON public.admin_access_profiles;
DROP FUNCTION IF EXISTS public.guard_admin_governance_audit_write();
DROP FUNCTION IF EXISTS public.guard_admin_step_up_write();
DROP FUNCTION IF EXISTS public.guard_admin_access_profile_write();
DROP FUNCTION IF EXISTS public.admin_access_checksum(text,text,jsonb,integer,boolean);
DROP FUNCTION IF EXISTS public.normalize_admin_permission_keys(jsonb);

DROP TABLE IF EXISTS public.admin_governance_audit;
DROP TABLE IF EXISTS public.admin_step_up_sessions;
DROP TABLE IF EXISTS public.admin_access_profiles;
DROP TABLE IF EXISTS public.admin_permission_catalog;

NOTIFY pgrst, 'reload schema';
COMMIT;
