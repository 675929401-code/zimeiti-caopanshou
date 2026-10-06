BEGIN;
SET LOCAL lock_timeout = '10s';

-- users_legacy_session_authority already creates the authoritative session when
-- users.session_id is set during INSERT. Registration must reuse that row and
-- only insert it itself on databases where the compatibility trigger is absent.
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
  v_now timestamptz := clock_timestamp();
BEGIN
  IF nullif(btrim(p_session_id), '') IS NULL OR length(p_session_id) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  SELECT *
  INTO v_invitation
  FROM public.invitation_codes
  WHERE upper(code) = upper(trim(p_invitation_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_NOT_FOUND');
  END IF;
  IF v_invitation.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;
  IF NOT coalesce(v_invitation.is_permanent, false)
     AND coalesce(v_invitation.is_used, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS');
  END IF;

  INSERT INTO public.users (
    username, phone, email, password_hash, display_name, role, credits,
    is_active, status, member_status, allowed_categories, invited_by,
    session_id, last_sign_in_at, updated_at
  ) VALUES (
    p_username, p_phone, p_email, p_password_hash, p_display_name, 'student', 0,
    true, 'active', 'inactive', '[]'::jsonb, v_invitation.user_id,
    p_session_id, v_now, v_now
  )
  RETURNING * INTO v_user;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_auth_sessions
    WHERE user_id = v_user.id
      AND session_id = p_session_id
      AND revoked_at IS NULL
      AND expires_at > v_now
  ) THEN
    INSERT INTO public.user_auth_sessions (
      user_id, session_id, created_at, expires_at, revoked_at, revoke_reason
    ) VALUES (
      v_user.id, p_session_id, v_now, v_now + interval '3 days', NULL, NULL
    );
  END IF;

  IF NOT coalesce(v_invitation.is_permanent, false) THEN
    UPDATE public.invitation_codes
    SET is_used = true, used_by = v_user.id::uuid, used_at = v_now
    WHERE id = v_invitation.id;
  END IF;

  INSERT INTO public.invitation_records (
    inviter_id, invitee_id, invitee_activated, invited_at,
    invitation_code_id, invitation_code_snapshot
  ) VALUES (
    v_invitation.user_id, v_user.id::uuid, false, v_now,
    v_invitation.id, v_invitation.code
  );

  RETURN jsonb_build_object(
    'ok', true,
    'session_active', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'username', v_user.username,
      'display_name', v_user.display_name,
      'email', v_user.email,
      'phone', v_user.phone,
      'role', v_user.role,
      'credits', v_user.credits,
      'is_active', v_user.is_active,
      'allowed_categories', v_user.allowed_categories,
      'member_status', v_user.member_status
    )
  );
EXCEPTION
  WHEN unique_violation THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS');
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'REGISTRATION_CONFLICT');
END;
$$;

REVOKE ALL ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) IS 'Server-only atomic invited registration compatible with the users session-authority trigger.';

NOTIFY pgrst, 'reload schema';
COMMIT;
