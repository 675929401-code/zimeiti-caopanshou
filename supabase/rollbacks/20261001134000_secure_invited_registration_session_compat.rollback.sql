BEGIN;
-- The paired source rollback also removes calls to the secure RPC. Dropping
-- this corrected overload exposes the preceding migration's rollback path.
DROP FUNCTION IF EXISTS public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text);
NOTIFY pgrst, 'reload schema';
COMMIT;
