BEGIN;

-- Roll back only the function definition. Existing authoritative sessions are
-- retained so a rollback never logs out accounts or deletes audit evidence.
CREATE OR REPLACE FUNCTION public.register_invited_user_atomic(
  p_email text,
  p_phone text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_invitation_code text,
  p_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_user public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_invitation
  FROM public.invitation_codes
  WHERE upper(code) = upper(trim(p_invitation_code))
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_NOT_FOUND'); END IF;
  IF v_invitation.user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID'); END IF;
  IF NOT coalesce(v_invitation.is_permanent, false) AND coalesce(v_invitation.is_used, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS'); END IF;

  INSERT INTO public.users (
    username, phone, email, password_hash, display_name, role, credits,
    is_active, status, member_status, allowed_categories, invited_by, session_id
  ) VALUES (
    p_username, p_phone, p_email, p_password_hash, p_display_name, 'student', 0,
    true, 'active', 'inactive', '[]'::jsonb, v_invitation.user_id, p_session_id
  ) RETURNING * INTO v_user;

  IF NOT coalesce(v_invitation.is_permanent, false) THEN
    UPDATE public.invitation_codes
    SET is_used = true, used_by = v_user.id::uuid, used_at = now()
    WHERE id = v_invitation.id;
  END IF;
  INSERT INTO public.invitation_records (inviter_id, invitee_id, invitee_activated)
  VALUES (v_invitation.user_id, v_user.id::uuid, false);
  RETURN jsonb_build_object('ok', true, 'user', jsonb_build_object(
    'id', v_user.id, 'username', v_user.username, 'display_name', v_user.display_name,
    'email', v_user.email, 'phone', v_user.phone, 'role', v_user.role,
    'credits', v_user.credits, 'is_active', v_user.is_active,
    'allowed_categories', v_user.allowed_categories, 'member_status', v_user.member_status
  ));
EXCEPTION WHEN unique_violation THEN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS'); END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'REGISTRATION_CONFLICT');
END;
$$;

DROP INDEX IF EXISTS public.invitation_records_one_owner_per_invitee;
ALTER TABLE public.invitation_records
  DROP CONSTRAINT IF EXISTS invitation_records_invitation_code_fk,
  DROP COLUMN IF EXISTS invitation_code_id,
  DROP COLUMN IF EXISTS invitation_code_snapshot;

NOTIFY pgrst, 'reload schema';
COMMIT;
