BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Member access is durable business data.  It deliberately lives outside the
-- release bundle and uses stable product keys, so a UI rebuild neither erases
-- grants nor silently opens a newly-added feature.
CREATE TABLE IF NOT EXISTS public.member_permission_profiles (
  profile_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  feature_navigation_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_navigation_keys) = 'array'),
  agent_navigation_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(agent_navigation_keys) = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by character varying(36),
  PRIMARY KEY (profile_key, version)
);

CREATE TABLE IF NOT EXISTS public.member_permission_assignments (
  user_id character varying(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  feature_navigation_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_navigation_keys) = 'array'),
  agent_navigation_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(agent_navigation_keys) = 'array'),
  source_profile_key text,
  source_profile_version integer,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  checksum character varying(64) NOT NULL,
  source text NOT NULL DEFAULT 'custom',
  reason text NOT NULL DEFAULT '',
  updated_by character varying(36),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_permission_assignment_profile_fk
    FOREIGN KEY (source_profile_key, source_profile_version)
    REFERENCES public.member_permission_profiles(profile_key, version)
);

CREATE TABLE IF NOT EXISTS public.member_permission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  actor_id character varying(36),
  revision integer NOT NULL CHECK (revision > 0),
  source text NOT NULL,
  request_key text,
  reason text NOT NULL DEFAULT '',
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS member_permission_event_request_unique
  ON public.member_permission_events(actor_id, request_key)
  WHERE actor_id IS NOT NULL AND nullif(btrim(request_key), '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_permission_events_user_created_idx
  ON public.member_permission_events(user_id, created_at DESC);

ALTER TABLE public.member_permission_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_permission_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_permission_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_permission_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_permission_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.member_permission_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.member_permission_profiles TO service_role;
GRANT SELECT ON TABLE public.member_permission_assignments TO service_role;
GRANT SELECT ON TABLE public.member_permission_events TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_member_feature_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(key ORDER BY ordinal), '[]'::jsonb)
  FROM unnest(ARRAY[
    'marketplace', 'toolbox', 'storyboard_workbench', 'image_workbench',
    'create', 'voice', 'cover', 'youcai', 'commerce_agent'
  ]::text[]) WITH ORDINALITY AS allowed(key, ordinal)
  WHERE CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? key ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.normalize_member_agent_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(key ORDER BY ordinal), '[]'::jsonb)
  FROM unnest(ARRAY[
    'bip:loop', 'task:影像编导', 'task:文案创作', 'task:获客转化', '自用'
  ]::text[]) WITH ORDINALITY AS allowed(key, ordinal)
  WHERE CASE WHEN jsonb_typeof(p_keys) = 'array' THEN p_keys ? key ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.member_permission_checksum(
  p_user_id text,
  p_feature_keys jsonb,
  p_agent_keys jsonb,
  p_revision integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT md5(canonical.payload) || md5('member-permission:v1:' || canonical.payload)
  FROM (
    SELECT jsonb_build_object(
      'user_id', p_user_id,
      'feature_navigation_keys', public.normalize_member_feature_keys(p_feature_keys),
      'agent_navigation_keys', public.normalize_member_agent_keys(p_agent_keys),
      'revision', p_revision
    )::text AS payload
  ) canonical
$$;

-- Compatibility bridge for the pre-existing UUID category grants.  Once a
-- permission is saved, the stable five navigation keys become authoritative.
CREATE OR REPLACE FUNCTION public.resolve_legacy_member_agent_keys(p_keys jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stable jsonb;
  v_candidates jsonb;
BEGIN
  v_stable := public.normalize_member_agent_keys(p_keys);
  IF jsonb_array_length(v_stable) > 0 OR jsonb_typeof(p_keys) <> 'array' THEN
    RETURN v_stable;
  END IF;

  WITH allowed_category_names AS (
    SELECT c.name
    FROM public.categories c
    WHERE p_keys ? c.id::text
  ), classified AS (
    SELECT CASE
      WHEN a.id IN (
        'agent-1787079707230-h0sdiq', 'agent-1787158020109-cj3wnh',
        'agent-1787163731976-5xntwm', 'agent-1787160182534-uk29g4',
        'agent-bip-script-2', 'agent-1787160183236-5fi3w8',
        'agent-1787160184111-bj5hi3'
      ) THEN 'bip:loop'
      WHEN a.category = '自用' OR a.category LIKE 'custom_cat_%' THEN '自用'
      WHEN coalesce(a.name, '') ~ '(3D|2D|影像|故事导演)' THEN 'task:影像编导'
      WHEN coalesce(a.name, '') ~ '(文案|编导|脚本|爆点|钩子|标题|封面|知识爆款)' THEN 'task:文案创作'
      ELSE 'task:获客转化'
    END AS key
    FROM public.agents a
    JOIN allowed_category_names c ON c.name = a.category
    WHERE a.deleted_at IS NULL
  )
  SELECT coalesce(jsonb_agg(DISTINCT key), '[]'::jsonb) INTO v_candidates
  FROM classified;
  RETURN public.normalize_member_agent_keys(v_candidates);
END;
$$;

INSERT INTO public.member_permission_profiles (
  profile_key, version, name, description, feature_navigation_keys, agent_navigation_keys
) VALUES
  (
    'registered_basic', 1, '注册体验',
    '只开放应用入口与效率工具；新功能保持关闭，适合注册未激活账号。',
    '["marketplace","toolbox"]'::jsonb,
    '[]'::jsonb
  ),
  (
    'formal_member', 1, '正式会员',
    '开放当前九项业务功能与四项学员智能体分类，不含内部工具。',
    '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
    '["bip:loop","task:影像编导","task:文案创作","task:获客转化"]'::jsonb
  ),
  (
    'internal_full', 1, '内部全功能',
    '开放当前全部业务功能及内部工具；仅用于明确授权的内部账号。',
    '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
    '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb
  )
ON CONFLICT (profile_key, version) DO NOTHING;

-- Preserve all currently-visible business functions for existing users.  This
-- is a one-time compatibility snapshot: future features are never appended.
INSERT INTO public.member_permission_assignments (
  user_id, feature_navigation_keys, agent_navigation_keys, revision, checksum,
  source, reason, updated_by
)
SELECT
  u.id,
  '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
  public.resolve_legacy_member_agent_keys(u.allowed_categories),
  1,
  public.member_permission_checksum(
    u.id,
    '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
    public.resolve_legacy_member_agent_keys(u.allowed_categories),
    1
  ),
  'migration_compat',
  '升级时固化已有可见功能；以后新增功能默认关闭',
  NULL
FROM public.users u
WHERE u.role <> 'admin'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.member_permission_events (
  user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
)
SELECT
  a.user_id, NULL, a.revision, 'migration_compat', NULL, a.reason, NULL,
  jsonb_build_object(
    'feature_navigation_keys', a.feature_navigation_keys,
    'agent_navigation_keys', a.agent_navigation_keys,
    'source_profile_key', a.source_profile_key,
    'source_profile_version', a.source_profile_version,
    'revision', a.revision,
    'checksum', a.checksum
  )
FROM public.member_permission_assignments a
WHERE NOT EXISTS (
  SELECT 1 FROM public.member_permission_events e
  WHERE e.user_id = a.user_id AND e.revision = a.revision
);

CREATE OR REPLACE FUNCTION public.guard_member_permission_assignment_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.member_permission_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_member_permission_event_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR coalesce(current_setting('app.member_permission_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_EVENT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_permission_assignment_write_guard ON public.member_permission_assignments;
CREATE TRIGGER member_permission_assignment_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.member_permission_assignments
FOR EACH ROW EXECUTE FUNCTION public.guard_member_permission_assignment_write();

DROP TRIGGER IF EXISTS member_permission_event_write_guard ON public.member_permission_events;
CREATE TRIGGER member_permission_event_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.member_permission_events
FOR EACH ROW EXECUTE FUNCTION public.guard_member_permission_event_write();

CREATE OR REPLACE FUNCTION public.read_member_permission_snapshot(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_assignment public.member_permission_assignments%ROWTYPE;
  v_valid boolean;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authority_status', 'missing', 'integrity_valid', false);
  END IF;
  IF v_user.role = 'admin' THEN
    RETURN jsonb_build_object(
      'authority_status', 'admin', 'integrity_valid', true, 'role', 'admin',
      'feature_navigation_keys', '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
      'agent_navigation_keys', '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb,
      'revision', 0, 'checksum', 'admin-bypass'
    );
  END IF;
  SELECT * INTO v_assignment
  FROM public.member_permission_assignments
  WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'authority_status', 'missing', 'integrity_valid', false, 'role', v_user.role,
      'feature_navigation_keys', '[]'::jsonb, 'agent_navigation_keys', '[]'::jsonb
    );
  END IF;
  v_valid := v_assignment.checksum = public.member_permission_checksum(
    v_assignment.user_id,
    v_assignment.feature_navigation_keys,
    v_assignment.agent_navigation_keys,
    v_assignment.revision
  );
  RETURN jsonb_build_object(
    'authority_status', CASE WHEN v_valid THEN 'ready' ELSE 'invalid' END,
    'integrity_valid', v_valid,
    'role', v_user.role,
    'feature_navigation_keys', CASE WHEN v_valid THEN v_assignment.feature_navigation_keys ELSE '[]'::jsonb END,
    'agent_navigation_keys', CASE WHEN v_valid THEN v_assignment.agent_navigation_keys ELSE '[]'::jsonb END,
    'source_profile_key', v_assignment.source_profile_key,
    'source_profile_version', v_assignment.source_profile_version,
    'revision', v_assignment.revision,
    'checksum', v_assignment.checksum,
    'source', v_assignment.source,
    'reason', v_assignment.reason,
    'updated_by', v_assignment.updated_by,
    'updated_at', v_assignment.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_member_permissions_atomic(
  p_admin_id text,
  p_user_id text,
  p_feature_navigation_keys jsonb,
  p_agent_navigation_keys jsonb,
  p_expected_revision integer,
  p_request_key text,
  p_reason text DEFAULT '',
  p_source_profile_key text DEFAULT NULL,
  p_source_profile_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target public.users%ROWTYPE;
  v_current public.member_permission_assignments%ROWTYPE;
  v_existing public.member_permission_events%ROWTYPE;
  v_profile public.member_permission_profiles%ROWTYPE;
  v_features jsonb;
  v_agents jsonb;
  v_revision integer;
  v_checksum text;
  v_request_key text := btrim(coalesce(p_request_key, ''));
  v_reason text := left(btrim(coalesce(p_reason, '')), 500);
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_ADMIN_INVALID');
  END IF;
  IF v_request_key = '' OR length(v_request_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_REQUEST_KEY_INVALID');
  END IF;
  IF jsonb_typeof(p_feature_navigation_keys) <> 'array' OR jsonb_typeof(p_agent_navigation_keys) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_FORMAT_INVALID');
  END IF;
  v_features := public.normalize_member_feature_keys(p_feature_navigation_keys);
  v_agents := public.normalize_member_agent_keys(p_agent_navigation_keys);
  IF jsonb_array_length(v_features) <> jsonb_array_length(p_feature_navigation_keys)
     OR jsonb_array_length(v_agents) <> jsonb_array_length(p_agent_navigation_keys) THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_KEY_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('member-permission:' || p_user_id, 10012026));

  SELECT * INTO v_existing
  FROM public.member_permission_events
  WHERE actor_id = p_admin_id AND request_key = v_request_key;
  IF FOUND THEN
    IF v_existing.user_id <> p_user_id
       OR v_existing.after_snapshot->'feature_navigation_keys' <> v_features
       OR v_existing.after_snapshot->'agent_navigation_keys' <> v_agents THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'already_applied', true, 'revision', v_existing.revision,
      'snapshot', v_existing.after_snapshot
    );
  END IF;

  SELECT * INTO v_target FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_USER_NOT_FOUND');
  END IF;
  IF v_target.role = 'admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_ADMIN_TARGET_FORBIDDEN');
  END IF;

  IF p_source_profile_key IS NOT NULL OR p_source_profile_version IS NOT NULL THEN
    IF p_source_profile_key IS NULL OR p_source_profile_version IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_PROFILE_INCOMPLETE');
    END IF;
    SELECT * INTO v_profile
    FROM public.member_permission_profiles
    WHERE profile_key = p_source_profile_key AND version = p_source_profile_version AND is_active;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_PROFILE_NOT_FOUND');
    END IF;
    IF public.normalize_member_feature_keys(v_profile.feature_navigation_keys) <> v_features
       OR public.normalize_member_agent_keys(v_profile.agent_navigation_keys) <> v_agents THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_PROFILE_MISMATCH');
    END IF;
  END IF;

  SELECT * INTO v_current
  FROM public.member_permission_assignments
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_current.checksum <> public.member_permission_checksum(
      v_current.user_id, v_current.feature_navigation_keys, v_current.agent_navigation_keys, v_current.revision
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_INTEGRITY_INVALID');
    END IF;
    IF p_expected_revision IS NULL OR p_expected_revision <> v_current.revision THEN
      RETURN jsonb_build_object(
        'success', false, 'code', 'MEMBER_PERMISSION_REVISION_CONFLICT',
        'current_revision', v_current.revision
      );
    END IF;
    v_revision := v_current.revision + 1;
    v_before := jsonb_build_object(
      'feature_navigation_keys', v_current.feature_navigation_keys,
      'agent_navigation_keys', v_current.agent_navigation_keys,
      'source_profile_key', v_current.source_profile_key,
      'source_profile_version', v_current.source_profile_version,
      'revision', v_current.revision,
      'checksum', v_current.checksum
    );
  ELSE
    IF coalesce(p_expected_revision, 0) <> 0 THEN
      RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_REVISION_CONFLICT', 'current_revision', 0);
    END IF;
    v_revision := 1;
    v_before := NULL;
  END IF;

  v_checksum := public.member_permission_checksum(p_user_id, v_features, v_agents, v_revision);
  v_after := jsonb_build_object(
    'feature_navigation_keys', v_features,
    'agent_navigation_keys', v_agents,
    'source_profile_key', p_source_profile_key,
    'source_profile_version', p_source_profile_version,
    'revision', v_revision,
    'checksum', v_checksum
  );

  PERFORM set_config('app.member_permission_write', 'on', true);
  PERFORM set_config('app.member_permission_origin', 'rpc', true);
  INSERT INTO public.member_permission_assignments (
    user_id, feature_navigation_keys, agent_navigation_keys,
    source_profile_key, source_profile_version, revision, checksum,
    source, reason, updated_by, updated_at
  ) VALUES (
    p_user_id, v_features, v_agents,
    p_source_profile_key, p_source_profile_version, v_revision, v_checksum,
    CASE WHEN p_source_profile_key IS NULL THEN 'custom' ELSE 'profile_copy' END,
    v_reason, p_admin_id, clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    feature_navigation_keys = EXCLUDED.feature_navigation_keys,
    agent_navigation_keys = EXCLUDED.agent_navigation_keys,
    source_profile_key = EXCLUDED.source_profile_key,
    source_profile_version = EXCLUDED.source_profile_version,
    revision = EXCLUDED.revision,
    checksum = EXCLUDED.checksum,
    source = EXCLUDED.source,
    reason = EXCLUDED.reason,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at;

  -- Existing Agent routes keep reading users.allowed_categories.  Updating the
  -- compatibility projection in this same transaction prevents split-brain.
  UPDATE public.users
  SET allowed_categories = v_agents, updated_at = clock_timestamp()
  WHERE id = p_user_id;

  INSERT INTO public.member_permission_events (
    user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
  ) VALUES (
    p_user_id, p_admin_id, v_revision,
    CASE WHEN p_source_profile_key IS NULL THEN 'custom' ELSE 'profile_copy' END,
    v_request_key, v_reason, v_before, v_after
  );
  RETURN jsonb_build_object('success', true, 'already_applied', false, 'revision', v_revision, 'snapshot', v_after);
END;
$$;

-- Legacy workflows such as card redemption still mutate the compatibility
-- projection.  Synchronize only the Agent half, preserve business-feature
-- grants, increment the revision and leave an immutable event.
CREATE OR REPLACE FUNCTION public.sync_member_permission_from_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current public.member_permission_assignments%ROWTYPE;
  v_features jsonb;
  v_agents jsonb;
  v_revision integer;
  v_checksum text;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF coalesce(current_setting('app.member_permission_origin', true), '') = 'rpc' OR NEW.role = 'admin' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_current
  FROM public.member_permission_assignments
  WHERE user_id = NEW.id
  FOR UPDATE;
  v_agents := public.resolve_legacy_member_agent_keys(NEW.allowed_categories);
  IF FOUND THEN
    IF v_current.agent_navigation_keys = v_agents THEN RETURN NEW; END IF;
    v_features := v_current.feature_navigation_keys;
    v_revision := v_current.revision + 1;
    v_before := jsonb_build_object(
      'feature_navigation_keys', v_current.feature_navigation_keys,
      'agent_navigation_keys', v_current.agent_navigation_keys,
      'source_profile_key', v_current.source_profile_key,
      'source_profile_version', v_current.source_profile_version,
      'revision', v_current.revision,
      'checksum', v_current.checksum
    );
  ELSE
    v_features := '["marketplace","toolbox"]'::jsonb;
    v_revision := 1;
    v_before := NULL;
  END IF;
  v_checksum := public.member_permission_checksum(NEW.id, v_features, v_agents, v_revision);
  v_after := jsonb_build_object(
    'feature_navigation_keys', v_features,
    'agent_navigation_keys', v_agents,
    'source_profile_key', NULL,
    'source_profile_version', NULL,
    'revision', v_revision,
    'checksum', v_checksum
  );
  PERFORM set_config('app.member_permission_write', 'on', true);
  INSERT INTO public.member_permission_assignments (
    user_id, feature_navigation_keys, agent_navigation_keys, revision, checksum,
    source, reason, updated_by, updated_at
  ) VALUES (
    NEW.id, v_features, v_agents, v_revision, v_checksum,
    CASE WHEN TG_OP = 'INSERT' THEN 'registration_default' ELSE 'legacy_sync' END,
    CASE WHEN TG_OP = 'INSERT' THEN '新注册账号默认权限快照' ELSE '兼容业务同步智能体权限' END,
    NULL, clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    feature_navigation_keys = EXCLUDED.feature_navigation_keys,
    agent_navigation_keys = EXCLUDED.agent_navigation_keys,
    source_profile_key = NULL,
    source_profile_version = NULL,
    revision = EXCLUDED.revision,
    checksum = EXCLUDED.checksum,
    source = EXCLUDED.source,
    reason = EXCLUDED.reason,
    updated_by = NULL,
    updated_at = EXCLUDED.updated_at;
  INSERT INTO public.member_permission_events (
    user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
  ) VALUES (
    NEW.id, NULL, v_revision,
    CASE WHEN TG_OP = 'INSERT' THEN 'registration_default' ELSE 'legacy_sync' END,
    NULL,
    CASE WHEN TG_OP = 'INSERT' THEN '新注册账号默认权限快照' ELSE '兼容业务同步智能体权限' END,
    v_before, v_after
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_member_permission_projection_sync ON public.users;
CREATE TRIGGER users_member_permission_projection_sync
AFTER INSERT OR UPDATE OF allowed_categories, role ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_member_permission_from_user();

REVOKE ALL ON FUNCTION public.read_member_permission_snapshot(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_member_permission_snapshot(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
