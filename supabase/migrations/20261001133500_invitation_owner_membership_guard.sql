BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.invitation_owner_is_eligible(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id::text
      AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
      AND (
        role = 'admin'
        OR (
          coalesce(member_status, 'inactive') = 'active'
          AND (member_expires_at IS NULL OR member_expires_at > now())
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_invitation_owner_eligible_on_consume()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.is_used IS FALSE AND NEW.is_used IS TRUE
     AND NOT public.invitation_owner_is_eligible(NEW.user_id) THEN
    RAISE EXCEPTION 'INVITATION_OWNER_NOT_ELIGIBLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invitation_codes_owner_eligible_on_consume ON public.invitation_codes;
CREATE TRIGGER invitation_codes_owner_eligible_on_consume
BEFORE UPDATE OF is_used ON public.invitation_codes
FOR EACH ROW
WHEN (OLD.is_used IS FALSE AND NEW.is_used IS TRUE)
EXECUTE FUNCTION public.enforce_invitation_owner_eligible_on_consume();

REVOKE ALL ON FUNCTION public.invitation_owner_is_eligible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_invitation_owner_eligible_on_consume() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invitation_owner_is_eligible(uuid) TO service_role;

COMMENT ON FUNCTION public.invitation_owner_is_eligible(uuid)
  IS 'A code can be issued or consumed only while its owner is an active formal member (or administrator).';

NOTIFY pgrst, 'reload schema';
COMMIT;
