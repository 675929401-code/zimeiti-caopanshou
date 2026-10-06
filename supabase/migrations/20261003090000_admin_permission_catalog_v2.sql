BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Permission catalog v2 separates unrelated control planes and makes the
-- delegation contract durable. UI concealment remains a presentation rule;
-- this migration is the database boundary that prevents an ordinary admin
-- profile from retaining owner-only permissions or incomplete dependencies.
ALTER TABLE public.admin_permission_catalog
  ADD COLUMN IF NOT EXISTS is_delegable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dependency_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.admin_permission_catalog'::regclass
      AND conname = 'admin_permission_catalog_dependency_keys_array'
  ) THEN
    ALTER TABLE public.admin_permission_catalog
      ADD CONSTRAINT admin_permission_catalog_dependency_keys_array
      CHECK (jsonb_typeof(dependency_keys) = 'array');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.admin_permission_catalog'::regclass
      AND conname = 'admin_permission_catalog_no_self_dependency'
  ) THEN
    ALTER TABLE public.admin_permission_catalog
      ADD CONSTRAINT admin_permission_catalog_no_self_dependency
      CHECK (NOT (dependency_keys ? permission_key));
  END IF;
END;
$$;

INSERT INTO public.admin_permission_catalog (
  permission_key, group_key, label, description, risk_level,
  step_up_required, sort_order, is_active, is_delegable, dependency_keys
) VALUES
  ('brand.settings.manage','platform','品牌与界面','维护平台名称、品牌图片、主题与卡片布局，并执行品牌版本发布或回滚。','sensitive',true,191,true,true,'[]'::jsonb),
  ('integrations.manage','platform','外部连接','维护邮件、插件、外部平台和服务连接及其脱敏凭据。','critical',true,192,true,true,'[]'::jsonb),
  ('payment.settings.manage','billing','支付系统配置','维护支付渠道、商户号、密钥、网关和支付方式。','critical',true,193,true,true,'["billing.view"]'::jsonb),
  ('white_label.manage','platform','域名与贴牌','管理租户边界、域名认领、DNS、TLS 和品牌绑定发布。','critical',true,194,true,true,'["brand.settings.manage"]'::jsonb)
ON CONFLICT (permission_key) DO UPDATE SET
  group_key = EXCLUDED.group_key,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  risk_level = EXCLUDED.risk_level,
  step_up_required = EXCLUDED.step_up_required,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_delegable = EXCLUDED.is_delegable,
  dependency_keys = EXCLUDED.dependency_keys,
  updated_at = now();

UPDATE public.admin_permission_catalog
SET label = '平台基础规则',
    description = '修改跨业务的基础运行参数；不包含品牌、支付、外部连接和贴牌发布。',
    updated_at = now()
WHERE permission_key = 'platform.settings.manage';

UPDATE public.admin_permission_catalog
SET is_delegable = permission_key <> 'admin.accounts.manage',
    dependency_keys = CASE permission_key
      WHEN 'members.manage' THEN '["members.view"]'::jsonb
      WHEN 'members.delete' THEN '["members.view"]'::jsonb
      WHEN 'member_permissions.manage' THEN '["members.view"]'::jsonb
      WHEN 'wallet.adjust' THEN '["billing.view"]'::jsonb
      WHEN 'billing.export' THEN '["billing.view"]'::jsonb
      WHEN 'agents.manage' THEN '["agents.view"]'::jsonb
      WHEN 'prompts.view' THEN '["agents.view"]'::jsonb
      WHEN 'prompts.edit' THEN '["prompts.view","agents.view"]'::jsonb
      WHEN 'internal_tools.manage' THEN '["agents.view"]'::jsonb
      WHEN 'models.manage' THEN '["models.view"]'::jsonb
      WHEN 'security.manage' THEN '["security.view"]'::jsonb
      WHEN 'logs.export' THEN '["logs.view"]'::jsonb
      WHEN 'deployment.execute' THEN '["logs.view"]'::jsonb
      WHEN 'payment.settings.manage' THEN '["billing.view"]'::jsonb
      WHEN 'white_label.manage' THEN '["brand.settings.manage"]'::jsonb
      ELSE '[]'::jsonb
    END,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.normalize_delegable_admin_permission_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE expanded(permission_key) AS (
    SELECT c.permission_key
    FROM public.admin_permission_catalog c
    WHERE c.is_active = true
      AND c.is_delegable = true
      AND CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? c.permission_key ELSE false END
    UNION
    SELECT dependency.permission_key
    FROM expanded selected
    JOIN public.admin_permission_catalog owner_permission
      ON owner_permission.permission_key = selected.permission_key
    CROSS JOIN LATERAL jsonb_array_elements_text(owner_permission.dependency_keys)
      AS dependency(permission_key)
    JOIN public.admin_permission_catalog dependency_permission
      ON dependency_permission.permission_key = dependency.permission_key
     AND dependency_permission.is_active = true
     AND dependency_permission.is_delegable = true
  )
  SELECT coalesce(jsonb_agg(c.permission_key ORDER BY c.sort_order, c.permission_key), '[]'::jsonb)
  FROM public.admin_permission_catalog c
  JOIN expanded e ON e.permission_key = c.permission_key
$$;

-- Normalize any pre-v2 ordinary profile once, rotate its revision/checksum and
-- revoke stale step-up sessions. Super-admin effective access remains the live
-- active catalog and therefore automatically includes the four new keys.
CREATE TEMP TABLE permission_v2_changed_admins(
  user_id text PRIMARY KEY,
  old_permission_keys jsonb NOT NULL,
  new_permission_keys jsonb NOT NULL
) ON COMMIT DROP;
INSERT INTO permission_v2_changed_admins(user_id, old_permission_keys, new_permission_keys)
SELECT p.user_id,
       p.permission_keys,
       public.normalize_delegable_admin_permission_keys(p.permission_keys)
FROM public.admin_access_profiles p
WHERE p.admin_level = 'admin'
  AND p.permission_keys IS DISTINCT FROM public.normalize_delegable_admin_permission_keys(p.permission_keys);

SELECT set_config('app.admin_governance_write', 'on', true);
WITH normalized AS (
  SELECT p.user_id,
         changed.new_permission_keys AS permission_keys,
         p.revision + 1 AS revision,
         p.is_active
  FROM public.admin_access_profiles p
  JOIN permission_v2_changed_admins changed ON changed.user_id = p.user_id
)
UPDATE public.admin_access_profiles profile
SET permission_keys = normalized.permission_keys,
    revision = normalized.revision,
    checksum = public.admin_access_checksum(
      profile.user_id,
      'admin',
      normalized.permission_keys,
      normalized.revision,
      normalized.is_active
    ),
    updated_at = now()
FROM normalized
WHERE profile.user_id = normalized.user_id;

UPDATE public.admin_step_up_sessions session
SET revoked_at = coalesce(session.revoked_at, now())
FROM permission_v2_changed_admins changed
WHERE session.actor_id = changed.user_id
  AND session.revoked_at IS NULL;

INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
)
SELECT NULL, 'system', changed.user_id, 'admin.accounts.manage',
       'admin_permission_policy_v2_migration', 'success', '', 'admin_access_profile',
       jsonb_build_object(
         'migration', '20261003090000',
         'old_permission_keys', changed.old_permission_keys,
         'new_permission_keys', changed.new_permission_keys
       )
FROM permission_v2_changed_admins changed;

CREATE OR REPLACE FUNCTION public.enforce_admin_permission_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_normalized jsonb;
BEGIN
  IF NEW.admin_level = 'admin' THEN
    v_normalized := public.normalize_delegable_admin_permission_keys(NEW.permission_keys);
    IF NEW.permission_keys IS DISTINCT FROM v_normalized THEN
      RAISE EXCEPTION 'ADMIN_PERMISSION_CONTRACT_VIOLATION'
        USING ERRCODE = '23514',
              DETAIL = 'ordinary administrator permissions must be delegable, catalog ordered, and dependency complete';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_access_permission_contract_guard ON public.admin_access_profiles;
CREATE TRIGGER admin_access_permission_contract_guard
BEFORE INSERT OR UPDATE ON public.admin_access_profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_admin_permission_contract();

CREATE OR REPLACE FUNCTION public.validate_admin_permission_catalog_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_invalid_count integer; v_cycle_count integer;
BEGIN
  SELECT count(*)::integer INTO v_invalid_count
  FROM public.admin_permission_catalog catalog
  CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
  LEFT JOIN public.admin_permission_catalog target ON target.permission_key = dependency.permission_key
  WHERE catalog.is_active = true
    AND (
      target.permission_key IS NULL
      OR target.is_active IS DISTINCT FROM true
      OR target.is_delegable IS DISTINCT FROM true
    );
  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'ADMIN_PERMISSION_CATALOG_INVALID'
      USING ERRCODE = '23514', DETAIL = 'dependencies must reference active delegable catalog permissions';
  END IF;

  WITH RECURSIVE dependency_graph(root_key, current_key, path, cycle) AS (
    SELECT catalog.permission_key,
           dependency.permission_key,
           ARRAY[catalog.permission_key, dependency.permission_key]::text[],
           dependency.permission_key = catalog.permission_key
    FROM public.admin_permission_catalog catalog
    CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
    WHERE catalog.is_active = true
    UNION ALL
    SELECT graph.root_key,
           dependency.permission_key,
           graph.path || dependency.permission_key,
           dependency.permission_key = ANY(graph.path)
    FROM dependency_graph graph
    JOIN public.admin_permission_catalog catalog ON catalog.permission_key = graph.current_key
    CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
    WHERE NOT graph.cycle
  )
  SELECT count(DISTINCT root_key)::integer INTO v_cycle_count
  FROM dependency_graph WHERE cycle;
  IF v_cycle_count > 0 THEN
    RAISE EXCEPTION 'ADMIN_PERMISSION_CATALOG_CYCLE'
      USING ERRCODE = '23514', DETAIL = 'permission dependency graph must be acyclic';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS admin_permission_catalog_contract_guard ON public.admin_permission_catalog;
CREATE CONSTRAINT TRIGGER admin_permission_catalog_contract_guard
AFTER INSERT OR UPDATE OR DELETE ON public.admin_permission_catalog
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_admin_permission_catalog_contract();

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
  ) AND (
    v_profile.admin_level = 'super_admin'
    OR v_profile.permission_keys = public.normalize_delegable_admin_permission_keys(v_profile.permission_keys)
  );
  IF v_valid AND v_profile.is_active THEN
    IF v_profile.admin_level = 'super_admin' THEN
      SELECT coalesce(jsonb_agg(permission_key ORDER BY sort_order, permission_key), '[]'::jsonb)
      INTO v_effective FROM public.admin_permission_catalog WHERE is_active = true;
    ELSE
      v_effective := public.normalize_delegable_admin_permission_keys(v_profile.permission_keys);
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
  v_keys := public.normalize_delegable_admin_permission_keys(p_permission_keys);
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
  v_keys := public.normalize_delegable_admin_permission_keys(p_permission_keys);
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

CREATE OR REPLACE FUNCTION public.promote_existing_member_to_admin_atomic(
  p_actor_id text,
  p_target_user_id text,
  p_permission_keys jsonb,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor jsonb;
  v_target record;
  v_keys jsonb;
  v_revision integer;
  v_checksum text;
BEGIN
  v_actor := public.read_admin_access_snapshot(p_actor_id);
  IF v_actor->>'authority_status' <> 'ready' OR v_actor->>'admin_level' <> 'super_admin' THEN
    RETURN jsonb_build_object('success',false,'code','SUPER_ADMIN_REQUIRED');
  END IF;
  IF nullif(btrim(p_target_user_id),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_USER_REQUIRED');
  END IF;
  SELECT id, role, is_active, coalesce(status,'active') AS status, password_hash
  INTO v_target FROM public.users WHERE id=p_target_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','TARGET_USER_NOT_FOUND'); END IF;
  IF v_target.role='admin' THEN RETURN jsonb_build_object('success',false,'code','TARGET_ALREADY_ADMIN'); END IF;
  IF v_target.is_active IS DISTINCT FROM true OR v_target.status <> 'active' THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_ACCOUNT_NOT_ACTIVE');
  END IF;
  IF nullif(btrim(coalesce(v_target.password_hash,'')),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_LOGIN_PASSWORD_REQUIRED');
  END IF;
  v_keys := public.normalize_delegable_admin_permission_keys(p_permission_keys);
  SELECT coalesce(revision,0)+1 INTO v_revision
  FROM public.admin_access_profiles WHERE user_id=p_target_user_id;
  v_revision := coalesce(v_revision,1);
  v_checksum := public.admin_access_checksum(p_target_user_id,'admin',v_keys,v_revision,true);
  PERFORM set_config('app.admin_governance_write','on',true);
  UPDATE public.users SET role='admin', session_id=NULL, updated_at=now() WHERE id=p_target_user_id;
  INSERT INTO public.admin_access_profiles (
    user_id, admin_level, permission_keys, revision, checksum, is_active,
    created_by, updated_by, created_at, updated_at
  ) VALUES (
    p_target_user_id, 'admin', v_keys, v_revision, v_checksum, true,
    p_actor_id, p_actor_id, now(), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    admin_level='admin', permission_keys=EXCLUDED.permission_keys,
    revision=EXCLUDED.revision, checksum=EXCLUDED.checksum, is_active=true,
    updated_by=p_actor_id, updated_at=now();
  UPDATE public.user_auth_sessions SET revoked_at=now(), revoke_reason='promoted_to_admin'
  WHERE user_id=p_target_user_id AND revoked_at IS NULL;
  PERFORM public.append_admin_governance_audit(
    p_actor_id, 'super_admin', p_target_user_id, 'admin.accounts.manage',
    'admin_account_promote', 'success', '', 'admin_access_profile',
    '/api/admin/access-control', 'POST', p_request_key, '', '',
    jsonb_build_object('former_role',v_target.role,'permission_keys',v_keys,'revision',v_revision)
  );
  RETURN jsonb_build_object(
    'success',true,'user_id',p_target_user_id,'revision',v_revision,
    'permission_keys',v_keys,'former_role',v_target.role,'sessions_revoked',true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_governance_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE dependency_graph(root_key, current_key, path, cycle) AS (
    SELECT catalog.permission_key,
           dependency.permission_key,
           ARRAY[catalog.permission_key, dependency.permission_key]::text[],
           dependency.permission_key = catalog.permission_key
    FROM public.admin_permission_catalog catalog
    CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
    WHERE catalog.is_active = true
    UNION ALL
    SELECT graph.root_key,
           dependency.permission_key,
           graph.path || dependency.permission_key,
           dependency.permission_key = ANY(graph.path)
    FROM dependency_graph graph
    JOIN public.admin_permission_catalog catalog ON catalog.permission_key = graph.current_key
    CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
    WHERE NOT graph.cycle
  ), metrics AS (
    SELECT
      (SELECT count(*) FROM public.admin_access_profiles WHERE admin_level='super_admin' AND is_active=true) AS active_super_count,
      (SELECT count(*) FROM public.users u WHERE u.role='admin' AND u.is_active=true AND coalesce(u.status,'active')='active' AND NOT EXISTS (SELECT 1 FROM public.admin_access_profiles p WHERE p.user_id=u.id)) AS missing_profile_count,
      (SELECT count(*) FROM public.admin_access_profiles p WHERE p.checksum <> public.admin_access_checksum(p.user_id,p.admin_level,p.permission_keys,p.revision,p.is_active)) AS invalid_checksum_count,
      (SELECT count(*) FROM public.admin_access_profiles p WHERE p.admin_level='admin' AND p.permission_keys IS DISTINCT FROM public.normalize_delegable_admin_permission_keys(p.permission_keys)) AS noncanonical_profile_count,
      (SELECT count(*) FROM public.admin_access_profiles p WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=p.user_id AND u.role='admin')) AS orphan_profile_count,
      (SELECT count(*) FROM public.admin_step_up_sessions WHERE revoked_at IS NULL AND expires_at <= now()) AS expired_session_count,
      (SELECT count(*) FROM public.admin_permission_catalog catalog
       CROSS JOIN LATERAL jsonb_array_elements_text(catalog.dependency_keys) dependency(permission_key)
       LEFT JOIN public.admin_permission_catalog target ON target.permission_key = dependency.permission_key
       WHERE catalog.is_active = true AND (target.permission_key IS NULL OR target.is_active IS DISTINCT FROM true OR target.is_delegable IS DISTINCT FROM true)) AS catalog_invalid_dependency_count,
      (SELECT count(DISTINCT root_key) FROM dependency_graph WHERE cycle) AS catalog_cycle_count
  )
  SELECT jsonb_build_object(
    'healthy', active_super_count=1 AND missing_profile_count=0 AND invalid_checksum_count=0
      AND noncanonical_profile_count=0 AND orphan_profile_count=0
      AND catalog_invalid_dependency_count=0 AND catalog_cycle_count=0,
    'active_super_count',active_super_count,
    'missing_profile_count',missing_profile_count,
    'invalid_checksum_count',invalid_checksum_count,
    'noncanonical_profile_count',noncanonical_profile_count,
    'orphan_profile_count',orphan_profile_count,
    'expired_session_count',expired_session_count,
    'catalog_invalid_dependency_count',catalog_invalid_dependency_count,
    'catalog_cycle_count',catalog_cycle_count
  ) FROM metrics
$$;

REVOKE ALL ON FUNCTION public.normalize_delegable_admin_permission_keys(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_admin_permission_contract() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_admin_permission_catalog_contract() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_access_profile_atomic(text,text,jsonb,boolean,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_admin_account_atomic(text,text,text,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.promote_existing_member_to_admin_atomic(text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_delegable_admin_permission_keys(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_admin_access_profile_atomic(text,text,jsonb,boolean,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_account_atomic(text,text,text,text,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.promote_existing_member_to_admin_atomic(text,text,jsonb,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
