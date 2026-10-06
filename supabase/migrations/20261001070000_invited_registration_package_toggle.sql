BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- One administrator-controlled switch for the invited-registration welcome
-- package. Disabled means the relation remains pending for manual assignment;
-- enabled means the latest active trial_member template is assigned after the
-- relation and its three recipient-safe reward nodes have been created.
CREATE TABLE IF NOT EXISTS public.member_package_automation_settings (
  automation_key text PRIMARY KEY CHECK (automation_key = 'invited_registration_welcome'),
  enabled boolean NOT NULL DEFAULT false,
  profile_key text NOT NULL DEFAULT 'trial_member' CHECK (profile_key = 'trial_member'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  configured_by character varying(36),
  last_request_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.member_package_automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_key text NOT NULL,
  revision integer NOT NULL,
  enabled boolean NOT NULL,
  profile_key text NOT NULL,
  profile_version integer NOT NULL,
  configured_by character varying(36) NOT NULL,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configured_by, request_key)
);

CREATE TABLE IF NOT EXISTS public.member_package_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_record_id character varying(36) NOT NULL REFERENCES public.invitation_records(id) ON DELETE CASCADE,
  user_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  profile_key text NOT NULL,
  profile_version integer,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  package_assignment_id uuid REFERENCES public.member_package_assignments(id) ON DELETE SET NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_record_id)
);

CREATE INDEX IF NOT EXISTS member_package_automation_runs_created_idx
  ON public.member_package_automation_runs(created_at DESC);

ALTER TABLE public.member_package_automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_package_automation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_package_automation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_package_automation_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_package_automation_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_package_automation_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_package_automation_settings TO service_role;
GRANT SELECT, INSERT ON TABLE public.member_package_automation_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.member_package_automation_runs TO service_role;

INSERT INTO public.member_package_automation_settings (
  automation_key, enabled, profile_key, revision, configured_by, updated_at
) VALUES (
  'invited_registration_welcome', false, 'trial_member', 1, NULL, now()
) ON CONFLICT (automation_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_invited_registration_package_automation_atomic(
  p_admin_id text,
  p_enabled boolean,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request text := btrim(coalesce(p_request_key, ''));
  v_setting public.member_package_automation_settings%ROWTYPE;
  v_profile public.member_permission_profiles%ROWTYPE;
  v_existing public.member_package_automation_events%ROWTYPE;
  v_revision integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'PACKAGE_AUTOMATION_ADMIN_INVALID');
  END IF;
  IF v_request = '' OR length(v_request) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'PACKAGE_AUTOMATION_REQUEST_INVALID');
  END IF;

  IF p_enabled IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'PACKAGE_AUTOMATION_ENABLED_REQUIRED');
  END IF;

  -- Serialize the idempotency read and the setting revision increment.  Without
  -- this lock, two retries with the same request key could both miss the first
  -- read and race into the unique event constraint.
  PERFORM pg_advisory_xact_lock(hashtextextended('invited-registration-package-automation', 1102026));
  SELECT * INTO v_existing
  FROM public.member_package_automation_events
  WHERE configured_by = p_admin_id AND request_key = v_request;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true,
      'enabled', v_existing.enabled, 'profile_key', v_existing.profile_key,
      'profile_version', v_existing.profile_version, 'revision', v_existing.revision
    );
  END IF;

  SELECT * INTO v_profile
  FROM public.member_permission_profiles
  WHERE profile_key = 'trial_member' AND is_active AND is_selectable
  ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR v_profile.membership_status <> 'trial' THEN
    RETURN jsonb_build_object('success', false, 'code', 'PACKAGE_AUTOMATION_TRIAL_TEMPLATE_INVALID');
  END IF;

  SELECT * INTO v_setting
  FROM public.member_package_automation_settings
  WHERE automation_key = 'invited_registration_welcome'
  FOR UPDATE;
  v_revision := coalesce(v_setting.revision, 0) + 1;

  INSERT INTO public.member_package_automation_settings (
    automation_key, enabled, profile_key, revision, configured_by, last_request_key, updated_at
  ) VALUES (
    'invited_registration_welcome', coalesce(p_enabled, false), 'trial_member',
    v_revision, p_admin_id, v_request, clock_timestamp()
  ) ON CONFLICT (automation_key) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    profile_key = EXCLUDED.profile_key,
    revision = EXCLUDED.revision,
    configured_by = EXCLUDED.configured_by,
    last_request_key = EXCLUDED.last_request_key,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.member_package_automation_events (
    automation_key, revision, enabled, profile_key, profile_version,
    configured_by, request_key, created_at
  ) VALUES (
    'invited_registration_welcome', v_revision, coalesce(p_enabled, false),
    v_profile.profile_key, v_profile.version, p_admin_id, v_request, clock_timestamp()
  );

  RETURN jsonb_build_object(
    'success', true, 'already_applied', false,
    'enabled', coalesce(p_enabled, false), 'profile_key', v_profile.profile_key,
    'profile_version', v_profile.version, 'revision', v_revision
  );
END;
$$;

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
  SELECT * INTO v_setting
  FROM public.member_package_automation_settings
  WHERE automation_key = 'invited_registration_welcome' AND enabled;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT * INTO v_profile
  FROM public.member_permission_profiles
  WHERE profile_key = v_setting.profile_key AND is_active AND is_selectable
  ORDER BY version DESC LIMIT 1;
  SELECT * INTO v_permission
  FROM public.member_permission_assignments
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
      v_setting.configured_by,
      NEW.invitee_id::text,
      NEW.id,
      v_profile.profile_key,
      v_profile.version,
      v_profile.name,
      v_profile.membership_status,
      coalesce(v_profile.duration_days, 0),
      v_profile.credits,
      v_profile.cash_amount,
      v_profile.feature_navigation_keys,
      v_profile.agent_navigation_keys,
      v_permission.revision,
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
    NEW.id, NEW.invitee_id::text, v_profile.profile_key, v_profile.version,
    v_status,
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
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_invitation_records_auto_welcome_package ON public.invitation_records;
CREATE TRIGGER zz_invitation_records_auto_welcome_package
AFTER INSERT ON public.invitation_records
FOR EACH ROW EXECUTE FUNCTION public.maybe_assign_invited_registration_welcome_package();

REVOKE ALL ON FUNCTION public.set_invited_registration_package_automation_atomic(text,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.maybe_assign_invited_registration_welcome_package() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_invited_registration_package_automation_atomic(text,boolean,text) TO service_role;

COMMENT ON TABLE public.member_package_automation_settings
  IS 'Administrator-controlled switch for automatic invited-registration trial package assignment.';
COMMENT ON TABLE public.member_package_automation_runs
  IS 'Exactly-once receipts for each invited-registration automatic package attempt; failures leave manual assignment available.';

NOTIFY pgrst, 'reload schema';
COMMIT;
