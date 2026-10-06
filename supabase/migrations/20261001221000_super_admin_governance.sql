BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Backend authority is durable business data. Stable permission keys remain
-- independent from UI releases; newly added keys are not silently granted to
-- ordinary administrators. The one super administrator receives the complete
-- active catalog at read time.
CREATE TABLE IF NOT EXISTS public.admin_permission_catalog (
  permission_key text PRIMARY KEY,
  group_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  risk_level text NOT NULL CHECK (risk_level IN ('normal','sensitive','critical')),
  step_up_required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_access_profiles (
  user_id character varying(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  admin_level text NOT NULL DEFAULT 'admin' CHECK (admin_level IN ('super_admin','admin')),
  permission_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permission_keys) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  checksum character varying(64) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by character varying(36),
  updated_by character varying(36),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_access_one_active_super
  ON public.admin_access_profiles(admin_level)
  WHERE admin_level = 'super_admin' AND is_active = true;

CREATE TABLE IF NOT EXISTS public.admin_step_up_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash character varying(64) NOT NULL UNIQUE,
  scope_keys jsonb NOT NULL CHECK (jsonb_typeof(scope_keys) = 'array'),
  profile_revision integer NOT NULL CHECK (profile_revision > 0),
  auth_method text NOT NULL CHECK (auth_method IN ('login_password','management_password')),
  request_ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS admin_step_up_actor_expiry_idx
  ON public.admin_step_up_sessions(actor_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_governance_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id character varying(36),
  actor_level text,
  target_user_id character varying(36),
  permission_key text,
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('allowed','denied','success','failure')),
  reason_code text NOT NULL DEFAULT '',
  resource text,
  request_path text,
  request_method text,
  request_key text,
  request_ip text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_governance_audit_request_unique
  ON public.admin_governance_audit(actor_id, request_key)
  WHERE actor_id IS NOT NULL AND nullif(btrim(request_key), '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_governance_audit_created_idx
  ON public.admin_governance_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_governance_audit_actor_idx
  ON public.admin_governance_audit(actor_id, created_at DESC);

ALTER TABLE public.admin_permission_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_access_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_step_up_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_governance_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_permission_catalog FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_access_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_step_up_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_governance_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_permission_catalog TO service_role;
GRANT SELECT ON TABLE public.admin_access_profiles TO service_role;
GRANT SELECT ON TABLE public.admin_step_up_sessions TO service_role;
GRANT SELECT ON TABLE public.admin_governance_audit TO service_role;

INSERT INTO public.admin_permission_catalog (
  permission_key, group_key, label, description, risk_level, step_up_required, sort_order
) VALUES
  ('admin.accounts.manage','super','管理员与授权','新增、停用管理员，修改管理员资料与后台权限。','critical',true,10),
  ('members.view','member','查看会员','查看会员档案、状态与基础使用数据。','normal',false,20),
  ('members.manage','member','编辑会员','编辑会员资料、状态、套餐与账户恢复信息。','sensitive',true,30),
  ('members.delete','member','删除会员','删除会员及其关联数据。','critical',true,40),
  ('member_permissions.manage','member','会员功能权限','设置会员业务导航与智能体分类访问范围。','sensitive',true,50),
  ('invitations.manage','member','邀请关系与礼包','查看邀请归因并决定、发放注册与正式会员奖励。','sensitive',true,60),
  ('packages.manage','member','套餐与试用','维护套餐模板、开通套餐和试用策略。','sensitive',true,70),
  ('cards.manage','member','卡密系统','生成、绑定、推送、兑换管理和作废卡密。','critical',true,80),
  ('billing.view','billing','查看资金与账单','查看余额、充值、消费、支付和对账记录。','normal',false,90),
  ('wallet.adjust','billing','充值与调账','给会员增加或扣减积分、现金并补录线下收款。','critical',true,100),
  ('billing.export','billing','导出账单','下载会员、邀请、充值、消费及公司对账数据。','critical',true,110),
  ('agents.view','content','查看智能体','查看智能体清单和非敏感运行配置。','normal',false,120),
  ('agents.manage','content','管理智能体','新增、上下架、排序、迁移和删除智能体。','sensitive',true,130),
  ('prompts.view','content','查看内部提示词','查看系统提示词、历史版本和内部知识资产。','critical',true,140),
  ('prompts.edit','content','编辑内部提示词','修改提示词、版本和防泄露策略。','critical',true,150),
  ('internal_tools.manage','content','内部工具分类','维护仅内部人员可见的智能体分类和入口。','critical',true,160),
  ('models.view','content','查看模型资源','查看模型目录、状态和脱敏后的渠道配置。','normal',false,170),
  ('models.manage','content','管理模型与密钥','新增模型、修改渠道、密钥、计费和发布状态。','critical',true,180),
  ('platform.settings.manage','platform','平台设置','修改主题、布局、连接、支付、插件和平台参数。','sensitive',true,190),
  ('announcements.manage','platform','公告与通知','创建、推送和撤回系统公告与站内通知。','sensitive',true,200),
  ('security.view','security','查看安全中心','查看安全事件、提示词拦截和登录日志。','normal',false,210),
  ('security.manage','security','安全策略','调整安全规则、敏感策略和平台操作密码。','critical',true,220),
  ('logs.view','security','查看运行日志','查看全链路运行、故障、性能和操作日志。','normal',false,230),
  ('logs.export','security','导出日志','下载登录、安全、运行和管理员审计记录。','critical',true,240),
  ('backups.manage','security','备份与同步','执行数据导入、导出、备份、恢复与同步。','critical',true,250),
  ('deployment.execute','security','发布与部署','触发受审计的版本发布或部署入口。','critical',true,260)
ON CONFLICT (permission_key) DO UPDATE SET
  group_key = EXCLUDED.group_key,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  risk_level = EXCLUDED.risk_level,
  step_up_required = EXCLUDED.step_up_required,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.normalize_admin_permission_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(c.permission_key ORDER BY c.sort_order, c.permission_key), '[]'::jsonb)
  FROM public.admin_permission_catalog c
  WHERE c.is_active = true
    AND CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? c.permission_key ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.admin_access_checksum(
  p_user_id text,
  p_admin_level text,
  p_permission_keys jsonb,
  p_revision integer,
  p_is_active boolean
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(canonical.payload) || md5('admin-governance:v1:' || canonical.payload)
  FROM (
    SELECT jsonb_build_object(
      'user_id', p_user_id,
      'admin_level', p_admin_level,
      'permission_keys', public.normalize_admin_permission_keys(p_permission_keys),
      'revision', p_revision,
      'is_active', p_is_active
    )::text AS payload
  ) canonical
$$;

CREATE OR REPLACE FUNCTION public.guard_admin_access_profile_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.admin_governance_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ADMIN_ACCESS_PROFILE_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_admin_step_up_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.admin_governance_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ADMIN_STEP_UP_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_admin_governance_audit_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR coalesce(current_setting('app.admin_governance_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ADMIN_GOVERNANCE_AUDIT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_access_profile_write_guard ON public.admin_access_profiles;
CREATE TRIGGER admin_access_profile_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_access_profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_admin_access_profile_write();
DROP TRIGGER IF EXISTS admin_step_up_write_guard ON public.admin_step_up_sessions;
CREATE TRIGGER admin_step_up_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_step_up_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_admin_step_up_write();
DROP TRIGGER IF EXISTS admin_governance_audit_write_guard ON public.admin_governance_audit;
CREATE TRIGGER admin_governance_audit_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_governance_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_admin_governance_audit_write();

SELECT set_config('app.admin_governance_write', 'on', true);

-- The oldest active administrator is the deterministic bootstrap owner. There
-- can be only one active super administrator; subsequent administrators begin
-- with no backend grants until the owner explicitly assigns them.
WITH bootstrap AS (
  SELECT u.id
  FROM public.users u
  WHERE u.role = 'admin' AND u.is_active = true AND coalesce(u.status, 'active') = 'active'
  ORDER BY u.created_at ASC, u.id ASC
  LIMIT 1
), all_keys AS (
  SELECT coalesce(jsonb_agg(permission_key ORDER BY sort_order, permission_key), '[]'::jsonb) AS keys
  FROM public.admin_permission_catalog WHERE is_active = true
)
INSERT INTO public.admin_access_profiles (
  user_id, admin_level, permission_keys, revision, checksum, is_active, created_by, updated_by
)
SELECT b.id, 'super_admin', a.keys, 1,
  public.admin_access_checksum(b.id, 'super_admin', a.keys, 1, true),
  true, b.id, b.id
FROM bootstrap b CROSS JOIN all_keys a
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.admin_access_profiles (
  user_id, admin_level, permission_keys, revision, checksum, is_active, created_by, updated_by
)
SELECT u.id, 'admin', '[]'::jsonb, 1,
  public.admin_access_checksum(u.id, 'admin', '[]'::jsonb, 1, u.is_active = true AND coalesce(u.status, 'active') = 'active'),
  u.is_active = true AND coalesce(u.status, 'active') = 'active', NULL, NULL
FROM public.users u
WHERE u.role = 'admin'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.read_admin_access_snapshot(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_profile public.admin_access_profiles%ROWTYPE;
  v_valid boolean;
  v_effective jsonb;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_user.role <> 'admin' THEN
    RETURN jsonb_build_object('authority_status','missing','integrity_valid',false,'permission_keys','[]'::jsonb);
  END IF;
  IF v_user.is_active IS DISTINCT FROM true OR coalesce(v_user.status, 'active') <> 'active' THEN
    RETURN jsonb_build_object('authority_status','disabled','integrity_valid',false,'permission_keys','[]'::jsonb);
  END IF;
  SELECT * INTO v_profile FROM public.admin_access_profiles WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authority_status','missing','integrity_valid',false,'permission_keys','[]'::jsonb);
  END IF;
  v_valid := v_profile.checksum = public.admin_access_checksum(
    v_profile.user_id, v_profile.admin_level, v_profile.permission_keys,
    v_profile.revision, v_profile.is_active
  );
  IF v_valid AND v_profile.is_active THEN
    IF v_profile.admin_level = 'super_admin' THEN
      SELECT coalesce(jsonb_agg(permission_key ORDER BY sort_order, permission_key), '[]'::jsonb)
      INTO v_effective FROM public.admin_permission_catalog WHERE is_active = true;
    ELSE
      v_effective := public.normalize_admin_permission_keys(v_profile.permission_keys);
    END IF;
  ELSE
    v_effective := '[]'::jsonb;
  END IF;
  RETURN jsonb_build_object(
    'authority_status', CASE WHEN NOT v_valid THEN 'invalid' WHEN NOT v_profile.is_active THEN 'disabled' ELSE 'ready' END,
    'integrity_valid', v_valid,
    'admin_level', v_profile.admin_level,
    'permission_keys', v_effective,
    'revision', v_profile.revision,
    'checksum', v_profile.checksum,
    'profile_active', v_profile.is_active,
    'updated_at', v_profile.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_admin_governance_audit(
  p_actor_id text,
  p_actor_level text,
  p_target_user_id text,
  p_permission_key text,
  p_action text,
  p_result text,
  p_reason_code text,
  p_resource text,
  p_request_path text,
  p_request_method text,
  p_request_key text,
  p_request_ip text,
  p_user_agent text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('app.admin_governance_write', 'on', true);
  INSERT INTO public.admin_governance_audit (
    actor_id, actor_level, target_user_id, permission_key, action, result,
    reason_code, resource, request_path, request_method, request_key,
    request_ip, user_agent, metadata
  ) VALUES (
    nullif(p_actor_id,''), nullif(p_actor_level,''), nullif(p_target_user_id,''), nullif(p_permission_key,''),
    p_action, p_result, coalesce(p_reason_code,''), nullif(p_resource,''), nullif(p_request_path,''),
    nullif(p_request_method,''), nullif(p_request_key,''), nullif(p_request_ip,''),
    left(coalesce(p_user_agent,''), 500), coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (actor_id, request_key) WHERE actor_id IS NOT NULL AND nullif(btrim(request_key), '') IS NOT NULL
  DO UPDATE SET request_key = EXCLUDED.request_key
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_admin_step_up_session(
  p_actor_id text,
  p_token_hash text,
  p_scope_keys jsonb,
  p_profile_revision integer,
  p_auth_method text,
  p_request_ip text,
  p_user_agent text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_snapshot jsonb; v_scopes jsonb; v_id uuid;
BEGIN
  v_snapshot := public.read_admin_access_snapshot(p_actor_id);
  IF v_snapshot->>'authority_status' <> 'ready' THEN
    RETURN jsonb_build_object('success',false,'code','ADMIN_AUTHORITY_NOT_READY');
  END IF;
  IF (v_snapshot->>'revision')::integer <> p_profile_revision THEN
    RETURN jsonb_build_object('success',false,'code','ADMIN_PROFILE_REVISION_CONFLICT');
  END IF;
  v_scopes := public.normalize_admin_permission_keys(p_scope_keys);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_scopes) requested(key)
    WHERE NOT (v_snapshot->'permission_keys' ? requested.key)
  ) THEN
    RETURN jsonb_build_object('success',false,'code','ADMIN_SCOPE_NOT_GRANTED');
  END IF;
  PERFORM set_config('app.admin_governance_write', 'on', true);
  UPDATE public.admin_step_up_sessions SET revoked_at = now()
  WHERE actor_id = p_actor_id AND revoked_at IS NULL;
  INSERT INTO public.admin_step_up_sessions (
    actor_id, token_hash, scope_keys, profile_revision, auth_method,
    request_ip, user_agent, expires_at
  ) VALUES (
    p_actor_id, p_token_hash, v_scopes, p_profile_revision, p_auth_method,
    nullif(p_request_ip,''), left(coalesce(p_user_agent,''),500), p_expires_at
  ) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'session_id',v_id,'expires_at',p_expires_at,'scope_keys',v_scopes);
END;
$$;

CREATE OR REPLACE FUNCTION public.read_admin_step_up_session(
  p_actor_id text,
  p_token_hash text,
  p_permission_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_session public.admin_step_up_sessions%ROWTYPE; v_snapshot jsonb;
BEGIN
  SELECT * INTO v_session FROM public.admin_step_up_sessions
  WHERE actor_id = p_actor_id AND token_hash = p_token_hash
    AND revoked_at IS NULL AND expires_at > now()
  LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','missing'); END IF;
  v_snapshot := public.read_admin_access_snapshot(p_actor_id);
  IF v_snapshot->>'authority_status' <> 'ready'
     OR (v_snapshot->>'revision')::integer <> v_session.profile_revision
     OR NOT (v_session.scope_keys ? p_permission_key) THEN
    RETURN jsonb_build_object('status','invalid');
  END IF;
  RETURN jsonb_build_object(
    'status','ready','expires_at',v_session.expires_at,
    'auth_method',v_session.auth_method,'session_id',v_session.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_admin_step_up_sessions(p_actor_id text, p_token_hash text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  PERFORM set_config('app.admin_governance_write', 'on', true);
  UPDATE public.admin_step_up_sessions SET revoked_at = now()
  WHERE actor_id = p_actor_id AND revoked_at IS NULL
    AND (p_token_hash IS NULL OR token_hash = p_token_hash);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_access_profile_atomic(
  p_actor_id text,
  p_target_user_id text,
  p_permission_keys jsonb,
  p_is_active boolean,
  p_expected_revision integer,
  p_request_key text,
  p_reason text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_actor jsonb; v_target public.users%ROWTYPE; v_profile public.admin_access_profiles%ROWTYPE;
DECLARE v_keys jsonb; v_revision integer; v_checksum text;
BEGIN
  v_actor := public.read_admin_access_snapshot(p_actor_id);
  IF v_actor->>'authority_status' <> 'ready' OR v_actor->>'admin_level' <> 'super_admin' THEN
    RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_REQUIRED');
  END IF;
  SELECT * INTO v_target FROM public.users WHERE id=p_target_user_id AND role='admin';
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','ADMIN_TARGET_NOT_FOUND'); END IF;
  SELECT * INTO v_profile FROM public.admin_access_profiles WHERE user_id=p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','ADMIN_PROFILE_NOT_FOUND'); END IF;
  IF v_profile.admin_level='super_admin' THEN
    RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_PROFILE_IMMUTABLE');
  END IF;
  IF v_profile.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('success',false,'code','ADMIN_PROFILE_REVISION_CONFLICT','revision',v_profile.revision);
  END IF;
  v_keys := public.normalize_admin_permission_keys(p_permission_keys);
  v_revision := v_profile.revision + 1;
  v_checksum := public.admin_access_checksum(p_target_user_id,'admin',v_keys,v_revision,p_is_active);
  PERFORM set_config('app.admin_governance_write', 'on', true);
  UPDATE public.admin_access_profiles SET
    permission_keys=v_keys, revision=v_revision, checksum=v_checksum,
    is_active=p_is_active, updated_by=p_actor_id, updated_at=now()
  WHERE user_id=p_target_user_id;
  UPDATE public.users SET
    is_active=p_is_active, status=CASE WHEN p_is_active THEN 'active' ELSE 'suspended' END,
    session_id=CASE WHEN p_is_active THEN session_id ELSE NULL END, updated_at=now()
  WHERE id=p_target_user_id;
  IF NOT p_is_active THEN
    UPDATE public.user_auth_sessions SET revoked_at=coalesce(revoked_at,now()), revoke_reason='admin_access_disabled'
    WHERE user_id=p_target_user_id AND revoked_at IS NULL;
  END IF;
  UPDATE public.admin_step_up_sessions SET revoked_at=now()
  WHERE actor_id=p_target_user_id AND revoked_at IS NULL;
  PERFORM public.append_admin_governance_audit(
    p_actor_id, 'super_admin', p_target_user_id, 'admin.accounts.manage',
    'admin_permissions_update', 'success', '', 'admin_access_profile',
    '/api/admin/access-control', 'PATCH', p_request_key, '', '',
    jsonb_build_object('revision',v_revision,'permission_keys',v_keys,'active',p_is_active,'reason',coalesce(p_reason,''))
  );
  RETURN jsonb_build_object('success',true,'revision',v_revision,'checksum',v_checksum,'permission_keys',v_keys,'is_active',p_is_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_admin_account_atomic(
  p_actor_id text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_phone text,
  p_email text,
  p_permission_keys jsonb,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_actor jsonb; v_user_id text; v_keys jsonb; v_checksum text;
BEGIN
  v_actor := public.read_admin_access_snapshot(p_actor_id);
  IF v_actor->>'authority_status' <> 'ready' OR v_actor->>'admin_level' <> 'super_admin' THEN
    RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_REQUIRED');
  END IF;
  IF nullif(btrim(p_username),'') IS NULL OR nullif(btrim(p_password_hash),'') IS NULL OR nullif(btrim(p_display_name),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','ADMIN_ACCOUNT_FIELDS_REQUIRED');
  END IF;
  v_user_id := gen_random_uuid()::text;
  v_keys := public.normalize_admin_permission_keys(p_permission_keys);
  v_checksum := public.admin_access_checksum(v_user_id,'admin',v_keys,1,true);
  PERFORM set_config('app.admin_governance_write', 'on', true);
  INSERT INTO public.users (
    id, username, password_hash, display_name, phone, email, role,
    credits, cash_balance, is_active, status, member_status
  ) VALUES (
    v_user_id, btrim(p_username), p_password_hash, btrim(p_display_name),
    nullif(btrim(p_phone),''), nullif(lower(btrim(p_email)),''), 'admin',
    0, 0, true, 'active', 'inactive'
  );
  -- The generic new-admin trigger creates an empty profile. Replace it inside
  -- this transaction with the explicitly selected permission snapshot.
  UPDATE public.admin_access_profiles SET
    permission_keys=v_keys, checksum=v_checksum, updated_by=p_actor_id, updated_at=now()
  WHERE user_id=v_user_id;
  PERFORM public.append_admin_governance_audit(
    p_actor_id, 'super_admin', v_user_id, 'admin.accounts.manage',
    'admin_account_create', 'success', '', 'admin_access_profile',
    '/api/admin/access-control', 'POST', p_request_key, '', '',
    jsonb_build_object('permission_keys',v_keys,'display_name',btrim(p_display_name))
  );
  RETURN jsonb_build_object('success',true,'user_id',v_user_id,'revision',1,'permission_keys',v_keys);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'code','ADMIN_ACCOUNT_ALREADY_EXISTS');
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_admin_access_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_active boolean; v_checksum text;
BEGIN
  IF NEW.role <> 'admin' THEN RETURN NEW; END IF;
  v_active := NEW.is_active = true AND coalesce(NEW.status,'active')='active';
  v_checksum := public.admin_access_checksum(NEW.id,'admin','[]'::jsonb,1,v_active);
  PERFORM set_config('app.admin_governance_write','on',true);
  INSERT INTO public.admin_access_profiles (
    user_id,admin_level,permission_keys,revision,checksum,is_active
  ) VALUES (NEW.id,'admin','[]'::jsonb,1,v_checksum,v_active)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_admin_access_profile_seed ON public.users;
CREATE TRIGGER users_admin_access_profile_seed
AFTER INSERT OR UPDATE OF role ON public.users
FOR EACH ROW EXECUTE FUNCTION public.seed_admin_access_profile();

CREATE OR REPLACE FUNCTION public.admin_governance_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH metrics AS (
    SELECT
      (SELECT count(*) FROM public.admin_access_profiles WHERE admin_level='super_admin' AND is_active=true) AS active_super_count,
      (SELECT count(*) FROM public.users u WHERE u.role='admin' AND u.is_active=true AND coalesce(u.status,'active')='active' AND NOT EXISTS (SELECT 1 FROM public.admin_access_profiles p WHERE p.user_id=u.id)) AS missing_profile_count,
      (SELECT count(*) FROM public.admin_access_profiles p WHERE p.checksum <> public.admin_access_checksum(p.user_id,p.admin_level,p.permission_keys,p.revision,p.is_active)) AS invalid_checksum_count,
      (SELECT count(*) FROM public.admin_access_profiles p WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=p.user_id AND u.role='admin')) AS orphan_profile_count,
      (SELECT count(*) FROM public.admin_step_up_sessions WHERE revoked_at IS NULL AND expires_at <= now()) AS expired_session_count
  )
  SELECT jsonb_build_object(
    'healthy', active_super_count=1 AND missing_profile_count=0 AND invalid_checksum_count=0 AND orphan_profile_count=0,
    'active_super_count',active_super_count,
    'missing_profile_count',missing_profile_count,
    'invalid_checksum_count',invalid_checksum_count,
    'orphan_profile_count',orphan_profile_count,
    'expired_session_count',expired_session_count
  ) FROM metrics
$$;

-- Bootstrap receipt is immutable and contains no password, prompt or secret.
INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
)
SELECT p.user_id, 'super_admin', p.user_id, 'admin.accounts.manage',
  'super_admin_bootstrap', 'success', '', 'admin_access_profile',
  jsonb_build_object('revision',p.revision,'migration','20261001221000')
FROM public.admin_access_profiles p
WHERE p.admin_level='super_admin' AND p.is_active=true
  AND NOT EXISTS (
    SELECT 1 FROM public.admin_governance_audit a
    WHERE a.action='super_admin_bootstrap' AND a.target_user_id=p.user_id
  );

REVOKE ALL ON FUNCTION public.normalize_admin_permission_keys(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_access_checksum(text,text,jsonb,integer,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_admin_access_snapshot(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_admin_governance_audit(text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_admin_step_up_session(text,text,jsonb,integer,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_admin_step_up_session(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_admin_step_up_sessions(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_access_profile_atomic(text,text,jsonb,boolean,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_admin_account_atomic(text,text,text,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_governance_health() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_admin_access_profile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_admin_access_snapshot(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_admin_governance_audit(text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_step_up_session(text,text,jsonb,integer,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_admin_step_up_session(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_admin_step_up_sessions(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_admin_access_profile_atomic(text,text,jsonb,boolean,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_account_atomic(text,text,text,text,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_governance_health() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
