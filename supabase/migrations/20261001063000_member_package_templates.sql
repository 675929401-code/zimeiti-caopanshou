BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Runtime permission resources are durable keys, not release-time booleans.
-- The admin API upserts newly shipped navigation/category keys here. Existing
-- templates and member snapshots are never widened automatically.
CREATE TABLE IF NOT EXISTS public.member_permission_resources (
  resource_type text NOT NULL CHECK (resource_type IN ('feature', 'agent')),
  resource_key text NOT NULL,
  label text NOT NULL,
  route text,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_type, resource_key)
);

ALTER TABLE public.member_permission_resources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_permission_resources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_permission_resources TO service_role;

INSERT INTO public.member_permission_resources (
  resource_type, resource_key, label, route, description, sort_order
) VALUES
  ('feature','marketplace','应用广场','/','智能体与业务能力入口',10),
  ('feature','toolbox','效率工具','/tools','文案提取、视频提取、文字排版与智能分段',20),
  ('feature','storyboard_workbench','分镜编排','/storyboard-workbench','统一组织分镜图片、视频提示词与生成状态',30),
  ('feature','image_workbench','图像生成','/image-workbench','批量文生图与图生图',40),
  ('feature','create','视频创作','/video','AI 视频生成与任务管理',50),
  ('feature','voice','声音制作','/voice-studio/workspace','配音、音色与声音任务',60),
  ('feature','cover','封面设计','/cover','封面构图与生成',70),
  ('feature','youcai','漫剧创作','/youcai','进入漫剧创作工作台',80),
  ('feature','commerce_agent','带货创作','/commerce','商品图、商详套图与带货视频创作',90),
  ('agent','bip:loop','商业IP',NULL,'商业 IP 相关智能体分类',10),
  ('agent','task:影像编导','影像编导',NULL,'影像与导演类智能体',20),
  ('agent','task:文案创作','文案创作',NULL,'文案与脚本类智能体',30),
  ('agent','task:获客转化','运营增长',NULL,'运营、增长与转化类智能体',40),
  ('agent','自用','内部工具',NULL,'仅限明确授权的内部智能体',50)
ON CONFLICT (resource_type, resource_key) DO UPDATE SET
  label = EXCLUDED.label,
  route = EXCLUDED.route,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  last_seen_at = now();

CREATE OR REPLACE FUNCTION public.normalize_member_feature_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(resource_key ORDER BY sort_order, resource_key), '[]'::jsonb)
  FROM public.member_permission_resources
  WHERE resource_type = 'feature'
    AND CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? resource_key ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.normalize_member_agent_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(resource_key ORDER BY sort_order, resource_key), '[]'::jsonb)
  FROM public.member_permission_resources
  WHERE resource_type = 'agent'
    AND CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? resource_key ELSE false END
$$;

ALTER TABLE public.member_permission_profiles
  ADD COLUMN IF NOT EXISTS membership_status text,
  ADD COLUMN IF NOT EXISTS duration_days integer,
  ADD COLUMN IF NOT EXISTS credits numeric(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_amount numeric(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_selectable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS change_request_key text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.member_permission_profiles
  DROP CONSTRAINT IF EXISTS member_permission_profiles_membership_status_check;
ALTER TABLE public.member_permission_profiles
  ADD CONSTRAINT member_permission_profiles_membership_status_check
  CHECK (membership_status IS NULL OR membership_status IN ('trial', 'active'));
ALTER TABLE public.member_permission_profiles
  DROP CONSTRAINT IF EXISTS member_permission_profiles_duration_days_check;
ALTER TABLE public.member_permission_profiles
  ADD CONSTRAINT member_permission_profiles_duration_days_check
  CHECK (duration_days IS NULL OR duration_days >= 0);
ALTER TABLE public.member_permission_profiles
  DROP CONSTRAINT IF EXISTS member_permission_profiles_benefit_amount_check;
ALTER TABLE public.member_permission_profiles
  ADD CONSTRAINT member_permission_profiles_benefit_amount_check
  CHECK (credits >= 0 AND credits <= 1000000000 AND cash_amount >= 0 AND cash_amount <= 100000000);

CREATE UNIQUE INDEX IF NOT EXISTS member_permission_profile_change_request_unique
  ON public.member_permission_profiles(created_by, change_request_key)
  WHERE created_by IS NOT NULL AND nullif(btrim(change_request_key), '') IS NOT NULL;

UPDATE public.member_permission_profiles
SET membership_status = 'trial', duration_days = 7, sort_order = 10,
    is_selectable = false, updated_at = now()
WHERE profile_key = 'registered_basic';

UPDATE public.member_permission_profiles
SET membership_status = 'active', duration_days = 0, sort_order = 20,
    is_selectable = true, updated_at = now()
WHERE profile_key = 'formal_member';

UPDATE public.member_permission_profiles
SET membership_status = 'active', duration_days = 0, sort_order = 90,
    is_selectable = false, updated_at = now()
WHERE profile_key = 'internal_full';

INSERT INTO public.member_permission_profiles (
  profile_key, version, name, description,
  feature_navigation_keys, agent_navigation_keys,
  membership_status, duration_days, credits, cash_amount,
  sort_order, is_selectable, is_active
) VALUES
  (
    'trial_member', 1, '试用套餐',
    '用于新人体验；默认只开放应用广场和效率工具，额度与权限可在后台保存为新版。',
    '["marketplace","toolbox"]'::jsonb, '[]'::jsonb,
    'trial', 7, 50, 0, 10, true, true
  ),
  (
    'super_vip', 1, '超级 VIP 套餐',
    '开放当前全部面向学员的业务功能和智能体分类；内部工具仍保持关闭。',
    '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
    '["bip:loop","task:影像编导","task:文案创作","task:获客转化"]'::jsonb,
    'active', 0, 1000, 0, 30, true, true
  )
ON CONFLICT (profile_key, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.member_package_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  invitation_record_id character varying(36) REFERENCES public.invitation_records(id) ON DELETE SET NULL,
  profile_key text,
  profile_version integer,
  package_name text NOT NULL,
  membership_status text NOT NULL CHECK (membership_status IN ('trial', 'active')),
  duration_days integer NOT NULL DEFAULT 0 CHECK (duration_days >= 0),
  member_expires_at timestamptz,
  credits numeric(20,6) NOT NULL DEFAULT 0 CHECK (credits >= 0),
  cash_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  feature_navigation_keys jsonb NOT NULL CHECK (jsonb_typeof(feature_navigation_keys) = 'array'),
  agent_navigation_keys jsonb NOT NULL CHECK (jsonb_typeof(agent_navigation_keys) = 'array'),
  permission_revision integer NOT NULL CHECK (permission_revision > 0),
  note text NOT NULL DEFAULT '',
  assigned_by character varying(36) NOT NULL,
  request_key text NOT NULL,
  credit_operation_id bigint,
  cash_operation_id bigint,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_package_assignment_profile_fk
    FOREIGN KEY (profile_key, profile_version)
    REFERENCES public.member_permission_profiles(profile_key, version),
  UNIQUE (assigned_by, request_key)
);

CREATE INDEX IF NOT EXISTS member_package_assignments_user_created_idx
  ON public.member_package_assignments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS member_package_assignments_invitation_created_idx
  ON public.member_package_assignments(invitation_record_id, created_at DESC)
  WHERE invitation_record_id IS NOT NULL;

ALTER TABLE public.member_package_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_package_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.member_package_assignments TO service_role;

ALTER TABLE public.invitation_reward_grants
  ADD COLUMN IF NOT EXISTS package_assignment_id uuid
    REFERENCES public.member_package_assignments(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.create_member_package_profile_version_atomic(
  p_admin_id text,
  p_profile_key text,
  p_name text,
  p_description text,
  p_membership_status text,
  p_duration_days integer,
  p_credits numeric,
  p_cash_amount numeric,
  p_feature_navigation_keys jsonb,
  p_agent_navigation_keys jsonb,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := lower(btrim(coalesce(p_profile_key, '')));
  v_request text := btrim(coalesce(p_request_key, ''));
  v_status text := lower(btrim(coalesce(p_membership_status, '')));
  v_features jsonb;
  v_agents jsonb;
  v_version integer;
  v_existing public.member_permission_profiles%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_ADMIN_INVALID');
  END IF;
  IF v_key !~ '^[a-z][a-z0-9_]{2,63}$' OR v_request = '' OR length(v_request) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_PROFILE_INPUT_INVALID');
  END IF;
  IF nullif(btrim(coalesce(p_name, '')), '') IS NULL OR length(p_name) > 120
     OR v_status NOT IN ('trial', 'active')
     OR coalesce(p_duration_days, 0) < 0 OR coalesce(p_duration_days, 0) > 36500
     OR (v_status = 'trial' AND coalesce(p_duration_days, 0) <= 0)
     OR coalesce(p_credits, 0) < 0 OR coalesce(p_credits, 0) > 1000000000
     OR coalesce(p_cash_amount, 0) < 0 OR coalesce(p_cash_amount, 0) > 100000000
     OR jsonb_typeof(p_feature_navigation_keys) <> 'array'
     OR jsonb_typeof(p_agent_navigation_keys) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_PROFILE_INPUT_INVALID');
  END IF;
  v_features := public.normalize_member_feature_keys(p_feature_navigation_keys);
  v_agents := public.normalize_member_agent_keys(p_agent_navigation_keys);
  IF jsonb_array_length(v_features) <> jsonb_array_length(p_feature_navigation_keys)
     OR jsonb_array_length(v_agents) <> jsonb_array_length(p_agent_navigation_keys) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_PROFILE_RESOURCE_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('member-package-profile:' || v_key, 1102026));
  SELECT * INTO v_existing
  FROM public.member_permission_profiles
  WHERE created_by = p_admin_id AND change_request_key = v_request;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true,
      'profile_key', v_existing.profile_key, 'version', v_existing.version
    );
  END IF;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
  FROM public.member_permission_profiles WHERE profile_key = v_key;

  UPDATE public.member_permission_profiles
  SET is_active = false, updated_at = clock_timestamp()
  WHERE profile_key = v_key AND is_active;

  INSERT INTO public.member_permission_profiles (
    profile_key, version, name, description,
    feature_navigation_keys, agent_navigation_keys,
    membership_status, duration_days, credits, cash_amount,
    sort_order, is_selectable, is_active, created_by, change_request_key, updated_at
  ) VALUES (
    v_key, v_version, btrim(p_name), left(coalesce(p_description, ''), 1000),
    v_features, v_agents, v_status, coalesce(p_duration_days, 0),
    round(coalesce(p_credits, 0), 6), round(coalesce(p_cash_amount, 0), 2),
    coalesce((SELECT min(sort_order) FROM public.member_permission_profiles WHERE profile_key = v_key), 50),
    true, true, p_admin_id, v_request, clock_timestamp()
  );

  RETURN jsonb_build_object(
    'success', true, 'already_applied', false,
    'profile_key', v_key, 'version', v_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_member_package_atomic(
  p_admin_id text,
  p_user_id text,
  p_invitation_record_id text,
  p_profile_key text,
  p_profile_version integer,
  p_package_name text,
  p_membership_status text,
  p_duration_days integer,
  p_credits numeric,
  p_cash_amount numeric,
  p_feature_navigation_keys jsonb,
  p_agent_navigation_keys jsonb,
  p_expected_permission_revision integer,
  p_request_key text,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_user_uuid uuid;
  v_assignment_id uuid := gen_random_uuid();
  v_record public.invitation_records%ROWTYPE;
  v_profile public.member_permission_profiles%ROWTYPE;
  v_existing public.member_package_assignments%ROWTYPE;
  v_welcome public.invitation_reward_grants%ROWTYPE;
  v_status text := lower(btrim(coalesce(p_membership_status, '')));
  v_request text := btrim(coalesce(p_request_key, ''));
  v_name text := btrim(coalesce(p_package_name, ''));
  v_features jsonb;
  v_agents jsonb;
  v_permission jsonb;
  v_activation jsonb;
  v_credit jsonb;
  v_cash jsonb;
  v_delivery jsonb;
  v_expiry timestamptz;
  v_amount_copy text;
  v_now timestamptz := clock_timestamp();
BEGIN
  BEGIN
    v_admin_uuid := p_admin_id::uuid;
    v_user_uuid := p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_ID_INVALID');
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_ADMIN_INVALID');
  END IF;
  IF v_request = '' OR length(v_request) > 180 OR v_name = '' OR length(v_name) > 120
     OR v_status NOT IN ('trial', 'active')
     OR coalesce(p_duration_days, 0) < 0 OR coalesce(p_duration_days, 0) > 36500
     OR (v_status = 'trial' AND coalesce(p_duration_days, 0) <= 0)
     OR coalesce(p_credits, 0) < 0 OR coalesce(p_credits, 0) > 1000000000
     OR coalesce(p_cash_amount, 0) < 0 OR coalesce(p_cash_amount, 0) > 100000000
     OR jsonb_typeof(p_feature_navigation_keys) <> 'array'
     OR jsonb_typeof(p_agent_navigation_keys) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_INPUT_INVALID');
  END IF;

  v_features := public.normalize_member_feature_keys(p_feature_navigation_keys);
  v_agents := public.normalize_member_agent_keys(p_agent_navigation_keys);
  IF jsonb_array_length(v_features) <> jsonb_array_length(p_feature_navigation_keys)
     OR jsonb_array_length(v_agents) <> jsonb_array_length(p_agent_navigation_keys) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_RESOURCE_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('member-package:' || p_user_id, 1102026));
  SELECT * INTO v_existing
  FROM public.member_package_assignments
  WHERE assigned_by = p_admin_id AND request_key = v_request;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true, 'assignment_id', v_existing.id,
      'user_id', v_existing.user_id, 'package_name', v_existing.package_name,
      'notification_id', v_existing.notification_id,
      'credits', v_existing.credits, 'cash_amount', v_existing.cash_amount,
      'permission_revision', v_existing.permission_revision
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role <> 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_USER_INVALID');
  END IF;

  IF nullif(btrim(coalesce(p_invitation_record_id, '')), '') IS NOT NULL THEN
    SELECT * INTO v_record
    FROM public.invitation_records
    WHERE id = p_invitation_record_id FOR UPDATE;
    IF NOT FOUND OR v_record.invitee_id::text <> p_user_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_INVITATION_MISMATCH');
    END IF;
    SELECT * INTO v_welcome
    FROM public.invitation_reward_grants
    WHERE invitation_record_id = v_record.id AND reward_stage = 'invitee_welcome'
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_WELCOME_NODE_MISSING');
    END IF;
    IF v_welcome.status = 'sent' THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_ALREADY_ASSIGNED');
    END IF;
  END IF;

  IF nullif(btrim(coalesce(p_profile_key, '')), '') IS NOT NULL THEN
    SELECT * INTO v_profile
    FROM public.member_permission_profiles
    WHERE profile_key = p_profile_key AND version = p_profile_version
      AND is_active AND is_selectable;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_PROFILE_NOT_FOUND');
    END IF;
    IF v_profile.name <> v_name
       OR v_profile.membership_status <> v_status
       OR coalesce(v_profile.duration_days, 0) <> coalesce(p_duration_days, 0)
       OR v_profile.credits <> round(coalesce(p_credits, 0), 6)
       OR v_profile.cash_amount <> round(coalesce(p_cash_amount, 0), 2)
       OR public.normalize_member_feature_keys(v_profile.feature_navigation_keys) <> v_features
       OR public.normalize_member_agent_keys(v_profile.agent_navigation_keys) <> v_agents THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PACKAGE_PROFILE_MISMATCH');
    END IF;
  END IF;

  v_permission := public.set_member_permissions_atomic(
    p_admin_id, p_user_id, v_features, v_agents,
    p_expected_permission_revision,
    'package-permission:' || v_request,
    '开通会员套餐：' || v_name,
    CASE WHEN v_profile.profile_key IS NULL THEN NULL ELSE v_profile.profile_key END,
    CASE WHEN v_profile.profile_key IS NULL THEN NULL ELSE v_profile.version END
  );
  IF coalesce((v_permission ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'MEMBER_PACKAGE_PERMISSION_FAILED:%', coalesce(v_permission ->> 'code', 'UNKNOWN');
  END IF;

  v_activation := public.set_member_activation_state_atomic(
    p_admin_id, p_user_id, v_status,
    CASE WHEN v_status = 'active' THEN 'admin_manual' ELSE NULL END,
    'member-package:' || v_assignment_id::text,
    NULL,
    '开通会员套餐：' || v_name,
    'package-activation:' || v_request
  );
  IF coalesce((v_activation ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'MEMBER_PACKAGE_ACTIVATION_FAILED:%', coalesce(v_activation ->> 'code', 'UNKNOWN');
  END IF;

  v_expiry := CASE
    WHEN coalesce(p_duration_days, 0) = 0 THEN NULL
    ELSE v_now + make_interval(days => p_duration_days)
  END;
  UPDATE public.users
  SET member_expires_at = v_expiry, updated_at = v_now
  WHERE id = p_user_id;

  IF coalesce(p_credits, 0) > 0 THEN
    v_credit := public.apply_wallet_operation_atomic(
      p_user_id, 'credit_topup', 'member-package:' || v_assignment_id::text || ':credits',
      p_credits, '会员套餐「' || v_name || '」积分权益',
      jsonb_build_object('source','member_package','assignment_id',v_assignment_id,'package_name',v_name)
    );
    IF coalesce((v_credit ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_credit ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'MEMBER_PACKAGE_CREDIT_FAILED';
    END IF;
  END IF;
  IF coalesce(p_cash_amount, 0) > 0 THEN
    v_cash := public.apply_wallet_operation_atomic(
      p_user_id, 'cash_topup', 'member-package:' || v_assignment_id::text || ':cash',
      p_cash_amount, '会员套餐「' || v_name || '」现金权益',
      jsonb_build_object('source','member_package','assignment_id',v_assignment_id,'package_name',v_name)
    );
    IF coalesce((v_cash ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_cash ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'MEMBER_PACKAGE_CASH_FAILED';
    END IF;
  END IF;

  v_amount_copy := concat_ws('、',
    CASE WHEN coalesce(p_credits, 0) > 0 THEN trim(to_char(p_credits, 'FM999999999999990.######')) || ' 积分' END,
    CASE WHEN coalesce(p_cash_amount, 0) > 0 THEN '¥' || trim(to_char(p_cash_amount, 'FM999999999999990.00')) || ' 现金' END
  );
  v_delivery := public.enqueue_user_notification_once(
    p_user_id,
    'member_package',
    '「' || v_name || '」已开通',
    format('管理员已为你开通“%s”。%s%s功能权限已经生效，无需再次领取。%s',
      v_name,
      CASE WHEN v_expiry IS NULL THEN '长期有效；' ELSE '有效期至 ' || to_char(v_expiry AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || '；' END,
      CASE WHEN v_amount_copy <> '' THEN '同时到账：' || v_amount_copy || '；' ELSE '' END,
      CASE WHEN nullif(btrim(coalesce(p_note, '')), '') IS NOT NULL THEN E'\n说明：' || left(p_note, 2000) ELSE '' END
    ),
    NULL,
    jsonb_build_object(
      'dedupe_key','member-package:' || v_assignment_id::text,
      'source','member_package',
      'assignment_id',v_assignment_id,
      'package_name',v_name,
      'membership_status',v_status,
      'invitation_record_id',CASE WHEN v_record.id IS NULL THEN NULL ELSE v_record.id END
    )
  );
  IF coalesce((v_delivery ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'MEMBER_PACKAGE_NOTIFICATION_FAILED';
  END IF;

  INSERT INTO public.member_package_assignments (
    id, user_id, invitation_record_id, profile_key, profile_version,
    package_name, membership_status, duration_days, member_expires_at,
    credits, cash_amount, feature_navigation_keys, agent_navigation_keys,
    permission_revision, note, assigned_by, request_key,
    credit_operation_id, cash_operation_id, notification_id, created_at
  ) VALUES (
    v_assignment_id, p_user_id, v_record.id,
    CASE WHEN v_profile.profile_key IS NULL THEN NULL ELSE v_profile.profile_key END,
    CASE WHEN v_profile.profile_key IS NULL THEN NULL ELSE v_profile.version END,
    v_name, v_status, coalesce(p_duration_days, 0), v_expiry,
    round(coalesce(p_credits, 0), 6), round(coalesce(p_cash_amount, 0), 2),
    v_features, v_agents, (v_permission ->> 'revision')::integer,
    left(coalesce(p_note, ''), 2000), p_admin_id, v_request,
    nullif(v_credit ->> 'operation_id', '')::bigint,
    nullif(v_cash ->> 'operation_id', '')::bigint,
    (v_delivery ->> 'notification_id')::uuid, v_now
  );

  IF v_record.id IS NOT NULL THEN
    UPDATE public.invitation_reward_grants
    SET status = 'sent',
        credits = round(coalesce(p_credits, 0), 6),
        cash_amount = round(coalesce(p_cash_amount, 0), 2),
        note = left(coalesce(p_note, ''), 2000),
        drafted_at = v_now, drafted_by = v_admin_uuid,
        sent_at = v_now, sent_by = v_admin_uuid,
        send_request_key = v_request,
        credit_operation_id = nullif(v_credit ->> 'operation_id', '')::bigint,
        cash_operation_id = nullif(v_cash ->> 'operation_id', '')::bigint,
        notification_id = (v_delivery ->> 'notification_id')::uuid,
        package_assignment_id = v_assignment_id,
        updated_at = v_now
    WHERE id = v_welcome.id;

    UPDATE public.invitation_records AS relation
    SET reward_sent = NOT EXISTS (
      SELECT 1 FROM public.invitation_reward_grants AS grant_row
      WHERE grant_row.invitation_record_id = relation.id
        AND grant_row.eligibility_at IS NOT NULL
        AND grant_row.status NOT IN ('sent', 'skipped')
    )
    WHERE relation.id = v_record.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_applied', false,
    'assignment_id', v_assignment_id, 'user_id', p_user_id,
    'package_name', v_name, 'membership_status', v_status,
    'member_expires_at', v_expiry,
    'credits', round(coalesce(p_credits, 0), 6),
    'cash_amount', round(coalesce(p_cash_amount, 0), 2),
    'permission_revision', (v_permission ->> 'revision')::integer,
    'notification_id', v_delivery ->> 'notification_id',
    'credit_operation_id', v_credit ->> 'operation_id',
    'cash_operation_id', v_cash ->> 'operation_id',
    'activation_reward_unlocked', v_status = 'active' AND v_record.id IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_member_package_profile_version_atomic(
  text,text,text,text,text,integer,numeric,numeric,jsonb,jsonb,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_member_package_atomic(
  text,text,text,text,integer,text,text,integer,numeric,numeric,jsonb,jsonb,integer,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_member_package_profile_version_atomic(
  text,text,text,text,text,integer,numeric,numeric,jsonb,jsonb,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_member_package_atomic(
  text,text,text,text,integer,text,text,integer,numeric,numeric,jsonb,jsonb,integer,text,text
) TO service_role;

COMMENT ON TABLE public.member_permission_resources
  IS 'Stable runtime permission catalog. New resources are discovered, but never auto-granted to existing templates or members.';
COMMENT ON TABLE public.member_package_assignments
  IS 'Immutable receipts for atomic membership status, permission snapshot, wallet benefit and user-notification assignment.';
COMMENT ON FUNCTION public.assign_member_package_atomic(
  text,text,text,text,integer,text,text,integer,numeric,numeric,jsonb,jsonb,integer,text,text
) IS 'Atomically assigns a template or custom package, permissions, wallet benefits, membership state and exactly-once user notification.';

NOTIFY pgrst, 'reload schema';
COMMIT;
