BEGIN;
DROP FUNCTION IF EXISTS public.promote_existing_member_to_admin_atomic(text,text,jsonb,text);
NOTIFY pgrst, 'reload schema';
COMMIT;
