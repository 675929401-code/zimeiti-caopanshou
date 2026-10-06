BEGIN;
SET LOCAL lock_timeout = '10s';

-- users_legacy_session_authority may already create the authoritative row when
-- users.session_id is inserted. Reuse that row instead of treating the trigger
-- as a registration conflict.
CREATE OR REPLACE FUNCTION public.register_invited_user_secure_atomic(
  p_email text,
  p_phone text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_invitation_code text,
  p_session_id text,
  p_registration_ip_hash text DEFAULT NULL,
  p_registration_device_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_policy public.invitation_security_policies%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_consumed integer := 0;
  v_risk_reasons jsonb := '[]'::jsonb;
  v_risk_status text := 'clear';
  v_automatic_trial_eligible boolean := true;
BEGIN
  IF nullif(btrim(p_session_id), '') IS NULL OR length(p_session_id) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;
  IF p_registration_ip_hash IS NOT NULL AND p_registration_ip_hash !~ '^[0-9a-f]{16,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_RISK_INPUT');
  END IF;
  IF p_registration_device_hash IS NOT NULL AND p_registration_device_hash !~ '^[0-9a-f]{32,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_RISK_INPUT');
  END IF;

  SELECT * INTO v_invitation FROM public.invitation_codes
  WHERE upper(code) = upper(trim(p_invitation_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_NOT_FOUND'); END IF;
  IF v_invitation.user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_invitation.user_id::text AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID'); END IF;
  IF coalesce(v_invitation.is_used, false) THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS'); END IF;

  SELECT * INTO v_policy FROM public.invitation_security_policies WHERE policy_key = 'default';
  IF p_registration_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invitation_records
    WHERE registration_ip_hash = p_registration_ip_hash
      AND invited_at >= v_now - make_interval(days => v_policy.risk_window_days)
  ) THEN v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_IP_RECENT'); END IF;
  IF p_registration_device_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invitation_records
    WHERE registration_device_hash = p_registration_device_hash
      AND invited_at >= v_now - make_interval(days => v_policy.risk_window_days)
  ) THEN v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_DEVICE_RECENT'); END IF;
  IF p_registration_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = v_invitation.user_id::text AND ip_hash = p_registration_ip_hash
      AND revoked_at IS NULL AND expires_at > v_now
  ) THEN v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_IP_AS_INVITER'); END IF;
  IF (SELECT count(*) FROM public.invitation_records
      WHERE inviter_id = v_invitation.user_id AND invited_at >= v_now - interval '24 hours')
      >= v_policy.inviter_burst_threshold THEN
    v_risk_reasons := v_risk_reasons || jsonb_build_array('INVITER_BURST_24H');
  END IF;
  IF jsonb_array_length(v_risk_reasons) > 0 THEN
    v_risk_status := 'review';
    v_automatic_trial_eligible := false;
  END IF;

  INSERT INTO public.users (
    username, phone, email, password_hash, display_name, role, credits,
    is_active, status, member_status, allowed_categories, invited_by,
    session_id, last_sign_in_at, updated_at
  ) VALUES (
    p_username, p_phone, p_email, p_password_hash, p_display_name, 'student', 0,
    true, 'active', 'inactive', '[]'::jsonb, v_invitation.user_id,
    p_session_id, v_now, v_now
  ) RETURNING * INTO v_user;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = v_user.id AND session_id = p_session_id
      AND revoked_at IS NULL AND expires_at > v_now
  ) THEN
    INSERT INTO public.user_auth_sessions (
      user_id, session_id, ip_hash, created_at, expires_at, revoked_at, revoke_reason
    ) VALUES (
      v_user.id, p_session_id, p_registration_ip_hash, v_now, v_now + interval '3 days', NULL, NULL
    );
  ELSE
    UPDATE public.user_auth_sessions
    SET ip_hash = coalesce(p_registration_ip_hash, ip_hash)
    WHERE user_id = v_user.id AND session_id = p_session_id;
  END IF;

  UPDATE public.invitation_codes
  SET is_used = true, is_permanent = false, used_by = v_user.id::uuid, used_at = v_now
  WHERE id = v_invitation.id AND is_used IS FALSE;
  GET DIAGNOSTICS v_consumed = ROW_COUNT;
  IF v_consumed <> 1 THEN RAISE EXCEPTION 'INVITATION_ALREADY_CONSUMED'; END IF;

  INSERT INTO public.invitation_records (
    inviter_id, invitee_id, invitee_activated, invited_at,
    invitation_code_id, invitation_code_snapshot,
    registration_ip_hash, registration_device_hash, risk_status,
    risk_reasons, automatic_trial_eligible
  ) VALUES (
    v_invitation.user_id, v_user.id::uuid, false, v_now,
    v_invitation.id, v_invitation.code,
    p_registration_ip_hash, p_registration_device_hash, v_risk_status,
    v_risk_reasons, v_automatic_trial_eligible
  );

  RETURN jsonb_build_object(
    'ok', true, 'session_active', true,
    'risk_status', v_risk_status, 'risk_reasons', v_risk_reasons,
    'automatic_trial_eligible', v_automatic_trial_eligible,
    'user', jsonb_build_object(
      'id', v_user.id, 'username', v_user.username, 'display_name', v_user.display_name,
      'email', v_user.email, 'phone', v_user.phone, 'role', v_user.role,
      'credits', v_user.credits, 'is_active', v_user.is_active,
      'allowed_categories', v_user.allowed_categories, 'member_status', v_user.member_status
    )
  );
EXCEPTION WHEN unique_violation THEN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS'); END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'REGISTRATION_CONFLICT');
END;
$$;

REVOKE ALL ON FUNCTION public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
