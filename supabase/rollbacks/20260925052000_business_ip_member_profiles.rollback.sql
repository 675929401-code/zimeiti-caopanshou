BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS public.business_ip_conversation_profiles;
DROP TABLE IF EXISTS public.business_ip_member_profiles;
NOTIFY pgrst, 'reload schema';
COMMIT;
