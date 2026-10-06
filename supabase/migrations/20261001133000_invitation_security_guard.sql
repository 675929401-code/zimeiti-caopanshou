BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Invitation abuse controls are durable database state, not hard-coded UI
-- decoration. IP and device hashes are correlation signals only; they never
-- block an account without an administrator review.
CREATE TABLE IF NOT EXISTS public.invitation_security_policies (
  policy_key text PRIMARY KEY CHECK (policy_key = 'default'),
  monthly_code_limit integer NOT NULL DEFAULT 6 CHECK (monthly_code_limit IN (4, 5, 6)),
  risk_window_days integer NOT NULL DEFAULT 30 CHECK (risk_window_days BETWEEN 1 AND 90),
  inviter_burst_threshold integer NOT NULL DEFAULT 3 CHECK (inviter_burst_threshold BETWEEN 2 AND 20),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  configured_by character varying(36),
  last_request_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invitation_security_policy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monthly_code_limit integer NOT NULL,
  risk_window_days integer NOT NULL,
  inviter_burst_threshold integer NOT NULL,
  revision integer NOT NULL,
  configured_by character varying(36) NOT NULL,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configured_by, request_key)
);

ALTER TABLE public.invitation_records
  ADD COLUMN IF NOT EXISTS registration_ip_hash character varying(64),
  ADD COLUMN IF NOT EXISTS registration_device_hash character varying(64),
  ADD COLUMN IF NOT EXISTS risk_status character varying(16) NOT NULL DEFAULT 'clear',
  ADD COLUMN IF NOT EXISTS risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS automatic_trial_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS risk_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_reviewed_by character varying(36),
  ADD COLUMN IF NOT EXISTS risk_review_note text;

ALTER TABLE public.invitation_records
  DROP CONSTRAINT IF EXISTS invitation_records_risk_status_check;
ALTER TABLE public.invitation_records
  ADD CONSTRAINT invitation_records_risk_status_check
  CHECK (risk_status IN ('clear', 'review', 'cleared', 'blocked'));
ALTER TABLE public.invitation_records
  DROP CONSTRAINT IF EXISTS invitation_records_risk_reasons_array_check;
ALTER TABLE public.invitation_records
  ADD CONSTRAINT invitation_records_risk_reasons_array_check
  CHECK (jsonb_typeof(risk_reasons) = 'array');

CREATE INDEX IF NOT EXISTS invitation_records_registration_ip_idx
  ON public.invitation_records (registration_ip_hash, invited_at DESC)
  WHERE registration_ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS invitation_records_registration_device_idx
  ON public.invitation_records (registration_device_hash, invited_at DESC)
  WHERE registration_device_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS invitation_records_risk_review_idx
  ON public.invitation_records (risk_status, invited_at DESC)
  WHERE risk_status IN ('review', 'blocked');

CREATE TABLE IF NOT EXISTS public.invitation_risk_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_record_id character varying(36) NOT NULL REFERENCES public.invitation_records(id) ON DELETE CASCADE,
  previous_status character varying(16) NOT NULL,
  decision character varying(16) NOT NULL CHECK (decision IN ('cleared', 'blocked')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NOT NULL DEFAULT '',
  reviewed_by character varying(36) NOT NULL,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reviewed_by, request_key)
);

ALTER TABLE public.invitation_security_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_security_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitation_risk_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invitation_security_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitation_security_policy_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.invitation_risk_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.invitation_security_policies TO service_role;
GRANT SELECT, INSERT ON TABLE public.invitation_security_policy_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.invitation_risk_reviews TO service_role;

INSERT INTO public.invitation_security_policies (
  policy_key, monthly_code_limit, risk_window_days, inviter_burst_threshold, revision
) VALUES ('default', 6, 30, 3, 1)
ON CONFLICT (policy_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_invitation_security_policy_atomic(
  p_admin_id text,
  p_monthly_code_limit integer,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request text := btrim(coalesce(p_request_key, ''));
  v_policy public.invitation_security_policies%ROWTYPE;
  v_existing public.invitation_security_policy_events%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_POLICY_ADMIN_INVALID');
  END IF;
  IF p_monthly_code_limit NOT IN (4, 5, 6) THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_POLICY_LIMIT_INVALID');
  END IF;
  IF v_request = '' OR length(v_request) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'INVITATION_POLICY_REQUEST_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invitation-security-policy', 1102026));
  SELECT * INTO v_existing
  FROM public.invitation_security_policy_events
  WHERE configured_by = p_admin_id AND request_key = v_request;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true,
      'monthly_code_limit', v_existing.monthly_code_limit,
      'risk_window_days', v_existing.risk_window_days,
      'inviter_burst_threshold', v_existing.inviter_burst_threshold,
      'revision', v_existing.revision
    );
  END IF;

  SELECT * INTO v_policy
  FROM public.invitation_security_policies
  WHERE policy_key = 'default'
  FOR UPDATE;

  UPDATE public.invitation_security_policies
  SET monthly_code_limit = p_monthly_code_limit,
      revision = v_policy.revision + 1,
      configured_by = p_admin_id,
      last_request_key = v_request,
      updated_at = clock_timestamp()
  WHERE policy_key = 'default'
  RETURNING * INTO v_policy;

  INSERT INTO public.invitation_security_policy_events (
    monthly_code_limit, risk_window_days, inviter_burst_threshold,
    revision, configured_by, request_key, created_at
  ) VALUES (
    v_policy.monthly_code_limit, v_policy.risk_window_days, v_policy.inviter_burst_threshold,
    v_policy.revision, p_admin_id, v_request, clock_timestamp()
  );

  RETURN jsonb_build_object(
    'success', true, 'already_applied', false,
    'monthly_code_limit', v_policy.monthly_code_limit,
    'risk_window_days', v_policy.risk_window_days,
    'inviter_burst_threshold', v_policy.inviter_burst_threshold,
    'revision', v_policy.revision,
    'updated_at', v_policy.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_invitation_code_quota(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_policy public.invitation_security_policies%ROWTYPE;
  v_issued integer := 0;
  v_has_open boolean := false;
  v_month_start timestamptz;
  v_next_month timestamptz;
BEGIN
  SELECT * INTO v_policy FROM public.invitation_security_policies WHERE policy_key = 'default';
  v_month_start := date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_next_month := (date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') + interval '1 month') AT TIME ZONE 'Asia/Shanghai';
  SELECT count(*)::integer INTO v_issued
  FROM public.invitation_codes
  WHERE user_id = p_user_id AND created_at >= v_month_start AND created_at < v_next_month;
  SELECT EXISTS (
    SELECT 1 FROM public.invitation_codes WHERE user_id = p_user_id AND is_used IS FALSE
  ) INTO v_has_open;
  RETURN jsonb_build_object(
    'monthly_limit', coalesce(v_policy.monthly_code_limit, 6),
    'issued_this_month', v_issued,
    'remaining_this_month', greatest(coalesce(v_policy.monthly_code_limit, 6) - v_issued, 0),
    'resets_at', v_next_month,
    'has_open_code', v_has_open,
    'can_generate', v_has_open OR v_issued < coalesce(v_policy.monthly_code_limit, 6)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_one_time_invitation_code(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_policy public.invitation_security_policies%ROWTYPE;
  v_code text;
  v_attempt integer;
  v_index integer;
  v_issued integer := 0;
  v_random_bytes bytea;
  v_month_start timestamptz;
  v_next_month timestamptz;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  SELECT * INTO v_policy FROM public.invitation_security_policies WHERE policy_key = 'default';
  v_month_start := date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
  v_next_month := (date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') + interval '1 month') AT TIME ZONE 'Asia/Shanghai';
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id::text AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
      AND (role = 'admin' OR (
        coalesce(member_status, 'inactive') = 'active'
        AND (member_expires_at IS NULL OR member_expires_at > clock_timestamp())
      ))
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('one-time-invitation:' || p_user_id::text, 0));
  SELECT count(*)::integer INTO v_issued
  FROM public.invitation_codes
  WHERE user_id = p_user_id AND created_at >= v_month_start AND created_at < v_next_month;
  SELECT * INTO v_invitation
  FROM public.invitation_codes
  WHERE user_id = p_user_id AND is_used IS FALSE
  ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'reused_open_code', true, 'code', to_jsonb(v_invitation),
      'monthly_limit', v_policy.monthly_code_limit, 'issued_this_month', v_issued,
      'remaining_this_month', greatest(v_policy.monthly_code_limit - v_issued, 0),
      'resets_at', v_next_month
    );
  END IF;
  IF v_issued >= v_policy.monthly_code_limit THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'INVITATION_MONTHLY_LIMIT',
      'monthly_limit', v_policy.monthly_code_limit, 'issued_this_month', v_issued,
      'remaining_this_month', 0, 'resets_at', v_next_month
    );
  END IF;

  FOR v_attempt IN 1..8 LOOP
    v_random_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR v_index IN 0..7 LOOP
      v_code := v_code || substr(v_alphabet, (get_byte(v_random_bytes, v_index) % length(v_alphabet)) + 1, 1);
    END LOOP;
    BEGIN
      INSERT INTO public.invitation_codes (user_id, code, is_used, is_permanent)
      VALUES (p_user_id, v_code, false, false)
      RETURNING * INTO v_invitation;
      v_issued := v_issued + 1;
      RETURN jsonb_build_object(
        'ok', true, 'reused_open_code', false, 'code', to_jsonb(v_invitation),
        'monthly_limit', v_policy.monthly_code_limit, 'issued_this_month', v_issued,
        'remaining_this_month', greatest(v_policy.monthly_code_limit - v_issued, 0),
        'resets_at', v_next_month
      );
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_invitation FROM public.invitation_codes
      WHERE user_id = p_user_id AND is_used IS FALSE
      ORDER BY created_at DESC, id DESC LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object(
          'ok', true, 'reused_open_code', true, 'code', to_jsonb(v_invitation),
          'monthly_limit', v_policy.monthly_code_limit, 'issued_this_month', v_issued,
          'remaining_this_month', greatest(v_policy.monthly_code_limit - v_issued, 0),
          'resets_at', v_next_month
        );
      END IF;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', false, 'code', 'CODE_GENERATION_EXHAUSTED');
END;
$$;

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

  SELECT * INTO v_invitation
  FROM public.invitation_codes
  WHERE upper(code) = upper(trim(p_invitation_code))
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_NOT_FOUND'); END IF;
  IF v_invitation.user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_invitation.user_id::text AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;
  IF coalesce(v_invitation.is_used, false) THEN RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS'); END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS'); END IF;

  SELECT * INTO v_policy FROM public.invitation_security_policies WHERE policy_key = 'default';
  IF p_registration_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invitation_records
    WHERE registration_ip_hash = p_registration_ip_hash
      AND invited_at >= v_now - make_interval(days => v_policy.risk_window_days)
  ) THEN
    v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_IP_RECENT');
  END IF;
  IF p_registration_device_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invitation_records
    WHERE registration_device_hash = p_registration_device_hash
      AND invited_at >= v_now - make_interval(days => v_policy.risk_window_days)
  ) THEN
    v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_DEVICE_RECENT');
  END IF;
  IF p_registration_ip_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = v_invitation.user_id::text
      AND ip_hash = p_registration_ip_hash
      AND revoked_at IS NULL AND expires_at > v_now
  ) THEN
    v_risk_reasons := v_risk_reasons || jsonb_build_array('SAME_IP_AS_INVITER');
  END IF;
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

  INSERT INTO public.user_auth_sessions (
    user_id, session_id, ip_hash, created_at, expires_at, revoked_at, revoke_reason
  ) VALUES (
    v_user.id, p_session_id, p_registration_ip_hash, v_now, v_now + interval '3 days', NULL, NULL
  );

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

CREATE OR REPLACE FUNCTION public.review_invitation_risk_atomic(
  p_admin_id text,
  p_record_id text,
  p_decision text,
  p_note text,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record public.invitation_records%ROWTYPE;
  v_existing public.invitation_risk_reviews%ROWTYPE;
  v_request text := btrim(coalesce(p_request_key, ''));
  v_decision text := lower(btrim(coalesce(p_decision, '')));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REVIEW_ADMIN_INVALID'); END IF;
  IF v_decision NOT IN ('cleared', 'blocked') THEN RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REVIEW_DECISION_INVALID'); END IF;
  IF v_request = '' OR length(v_request) > 180 THEN RETURN jsonb_build_object('success', false, 'code', 'INVITATION_REVIEW_REQUEST_INVALID'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('invitation-risk:' || coalesce(p_record_id, ''), 1102026));
  SELECT * INTO v_existing FROM public.invitation_risk_reviews
  WHERE reviewed_by = p_admin_id AND request_key = v_request;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'already_applied', true, 'record_id', v_existing.invitation_record_id, 'decision', v_existing.decision);
  END IF;
  SELECT * INTO v_record FROM public.invitation_records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'INVITATION_RECORD_NOT_FOUND'); END IF;

  INSERT INTO public.invitation_risk_reviews (
    invitation_record_id, previous_status, decision, reasons, note,
    reviewed_by, request_key, created_at
  ) VALUES (
    v_record.id, v_record.risk_status, v_decision, v_record.risk_reasons,
    left(coalesce(p_note, ''), 1000), p_admin_id, v_request, clock_timestamp()
  );
  UPDATE public.invitation_records
  SET risk_status = v_decision,
      automatic_trial_eligible = (v_decision = 'cleared'),
      risk_reviewed_at = clock_timestamp(),
      risk_reviewed_by = p_admin_id,
      risk_review_note = left(coalesce(p_note, ''), 1000)
  WHERE id = v_record.id;
  RETURN jsonb_build_object('success', true, 'already_applied', false, 'record_id', v_record.id, 'decision', v_decision);
END;
$$;

-- Preserve the existing automatic-package switch, but stop risky registrations
-- before any package mutation. A later cleared review permits manual assignment;
-- it intentionally does not retroactively auto-send a package.
CREATE OR REPLACE FUNCTION public.maybe_assign_invited_registration_welcome_package()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_setting public.member_package_automation_settings%ROWTYPE;
  v_profile public.member_permission_profiles%ROWTYPE;
  v_permission public.member_permission_assignments%ROWTYPE;
  v_result jsonb;
  v_status text;
BEGIN
  SELECT * INTO v_setting FROM public.member_package_automation_settings
  WHERE automation_key = 'invited_registration_welcome' AND enabled;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.automatic_trial_eligible IS FALSE OR NEW.risk_status IN ('review', 'blocked') THEN
    INSERT INTO public.member_package_automation_runs (
      invitation_record_id, user_id, profile_key, profile_version, status, result
    ) VALUES (
      NEW.id, NEW.invitee_id::text, coalesce(v_setting.profile_key, 'trial_member'), NULL,
      'failed', jsonb_build_object(
        'code', 'PACKAGE_AUTOMATION_RISK_REVIEW_REQUIRED',
        'risk_status', NEW.risk_status, 'risk_reasons', NEW.risk_reasons
      )
    ) ON CONFLICT (invitation_record_id) DO NOTHING;
    RETURN NEW;
  END IF;

  SELECT * INTO v_profile FROM public.member_permission_profiles
  WHERE profile_key = v_setting.profile_key AND is_active AND is_selectable
  ORDER BY version DESC LIMIT 1;
  SELECT * INTO v_permission FROM public.member_permission_assignments
  WHERE user_id = NEW.invitee_id::text;
  IF v_setting.configured_by IS NULL OR v_profile.profile_key IS NULL
     OR v_profile.membership_status IS DISTINCT FROM 'trial' THEN
    INSERT INTO public.member_package_automation_runs (
      invitation_record_id, user_id, profile_key, profile_version, status, result
    ) VALUES (
      NEW.id, NEW.invitee_id::text, coalesce(v_setting.profile_key, 'trial_member'),
      v_profile.version, 'failed', jsonb_build_object('code', 'PACKAGE_AUTOMATION_CONFIGURATION_INVALID')
    ) ON CONFLICT (invitation_record_id) DO NOTHING;
    RETURN NEW;
  END IF;
  IF v_permission.user_id IS NULL THEN
    INSERT INTO public.member_package_automation_runs (
      invitation_record_id, user_id, profile_key, profile_version, status, result
    ) VALUES (
      NEW.id, NEW.invitee_id::text, v_profile.profile_key, v_profile.version,
      'failed', jsonb_build_object('code', 'PACKAGE_AUTOMATION_PERMISSION_SNAPSHOT_MISSING')
    ) ON CONFLICT (invitation_record_id) DO NOTHING;
    RETURN NEW;
  END IF;
  BEGIN
    v_result := public.assign_member_package_atomic(
      v_setting.configured_by, NEW.invitee_id::text, NEW.id,
      v_profile.profile_key, v_profile.version, v_profile.name,
      v_profile.membership_status, coalesce(v_profile.duration_days, 0),
      v_profile.credits, v_profile.cash_amount, v_profile.feature_navigation_keys,
      v_profile.agent_navigation_keys, v_permission.revision,
      'auto-invited-welcome:' || NEW.id,
      '管理员已开启“新人注册体验包”自动派发'
    );
  EXCEPTION WHEN OTHERS THEN
    v_result := jsonb_build_object('success', false, 'code', 'PACKAGE_AUTOMATION_EXCEPTION', 'detail', SQLSTATE);
  END;
  v_status := CASE WHEN coalesce((v_result ->> 'success')::boolean, false) THEN 'sent' ELSE 'failed' END;
  INSERT INTO public.member_package_automation_runs (
    invitation_record_id, user_id, profile_key, profile_version,
    status, package_assignment_id, result, created_at
  ) VALUES (
    NEW.id, NEW.invitee_id::text, v_profile.profile_key, v_profile.version, v_status,
    CASE WHEN nullif(v_result ->> 'assignment_id', '') IS NULL THEN NULL ELSE (v_result ->> 'assignment_id')::uuid END,
    coalesce(v_result, '{}'::jsonb), clock_timestamp()
  ) ON CONFLICT (invitation_record_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.member_package_automation_runs (
      invitation_record_id, user_id, profile_key, profile_version, status, result
    ) VALUES (
      NEW.id, NEW.invitee_id::text, coalesce(v_setting.profile_key, 'trial_member'),
      v_profile.version, 'failed', jsonb_build_object('code', 'PACKAGE_AUTOMATION_TRIGGER_FAILED', 'detail', SQLSTATE)
    ) ON CONFLICT (invitation_record_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_invitation_security_policy_atomic(text,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_invitation_code_quota(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_one_time_invitation_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_invitation_risk_atomic(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maybe_assign_invited_registration_welcome_package() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_invitation_security_policy_atomic(text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_invitation_code_quota(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_one_time_invitation_code(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_invitation_risk_atomic(text,text,text,text,text) TO service_role;

COMMENT ON TABLE public.invitation_security_policies IS 'Durable administrator-controlled invitation quota and risk thresholds.';
COMMENT ON TABLE public.invitation_risk_reviews IS 'Auditable human decisions for invitation risk signals; IP/device signals alone never ban an account.';
COMMENT ON FUNCTION public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text)
  IS 'Consumes one code atomically, creates one account and attribution, and records non-blocking hashed IP/device risk signals.';

NOTIFY pgrst, 'reload schema';
COMMIT;
