BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DROP FUNCTION IF EXISTS public.register_invited_user_secure_atomic(text,text,text,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.review_invitation_risk_atomic(text,text,text,text,text);
DROP FUNCTION IF EXISTS public.set_invitation_security_policy_atomic(text,integer,text);
DROP FUNCTION IF EXISTS public.get_invitation_code_quota(uuid);

-- Restore the pre-guard one-open-code implementation. Source rollback must be
-- performed in the same release because the newer API expects quota fields.
CREATE OR REPLACE FUNCTION public.create_one_time_invitation_code(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_code text;
  v_attempt integer;
  v_index integer;
  v_random_bytes bytea;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id::text AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('one-time-invitation:' || p_user_id::text, 0));
  SELECT * INTO v_invitation FROM public.invitation_codes
  WHERE user_id = p_user_id AND is_used IS FALSE
  ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'reused_open_code', true, 'code', to_jsonb(v_invitation));
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
      RETURN jsonb_build_object('ok', true, 'reused_open_code', false, 'code', to_jsonb(v_invitation));
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_invitation FROM public.invitation_codes
      WHERE user_id = p_user_id AND is_used IS FALSE
      ORDER BY created_at DESC, id DESC LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'reused_open_code', true, 'code', to_jsonb(v_invitation));
      END IF;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', false, 'code', 'CODE_GENERATION_EXHAUSTED');
END;
$$;

-- Restore the automatic package trigger without the risk columns that are
-- removed below.
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

REVOKE ALL ON FUNCTION public.create_one_time_invitation_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_one_time_invitation_code(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.maybe_assign_invited_registration_welcome_package() FROM PUBLIC, anon, authenticated;

DROP INDEX IF EXISTS public.invitation_records_registration_ip_idx;
DROP INDEX IF EXISTS public.invitation_records_registration_device_idx;
DROP INDEX IF EXISTS public.invitation_records_risk_review_idx;
DROP TABLE IF EXISTS public.invitation_risk_reviews;
DROP TABLE IF EXISTS public.invitation_security_policy_events;
DROP TABLE IF EXISTS public.invitation_security_policies;

ALTER TABLE public.invitation_records
  DROP CONSTRAINT IF EXISTS invitation_records_risk_status_check,
  DROP CONSTRAINT IF EXISTS invitation_records_risk_reasons_array_check,
  DROP COLUMN IF EXISTS registration_ip_hash,
  DROP COLUMN IF EXISTS registration_device_hash,
  DROP COLUMN IF EXISTS risk_status,
  DROP COLUMN IF EXISTS risk_reasons,
  DROP COLUMN IF EXISTS automatic_trial_eligible,
  DROP COLUMN IF EXISTS risk_reviewed_at,
  DROP COLUMN IF EXISTS risk_reviewed_by,
  DROP COLUMN IF EXISTS risk_review_note;

NOTIFY pgrst, 'reload schema';
COMMIT;
