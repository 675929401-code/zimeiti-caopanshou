BEGIN;
DROP TRIGGER IF EXISTS invitation_codes_owner_eligible_on_consume ON public.invitation_codes;
DROP FUNCTION IF EXISTS public.enforce_invitation_owner_eligible_on_consume();
DROP FUNCTION IF EXISTS public.invitation_owner_is_eligible(uuid);
NOTIFY pgrst, 'reload schema';
COMMIT;
