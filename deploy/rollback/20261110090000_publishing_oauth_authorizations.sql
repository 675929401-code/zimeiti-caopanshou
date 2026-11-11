BEGIN;
-- Close new authorization mutations; retain bindings, unknown operations and audit history.
REVOKE ALL ON FUNCTION public.mutate_publishing_authorization_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
