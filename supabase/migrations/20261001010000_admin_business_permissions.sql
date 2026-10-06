BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Administrator role governs the management console. Product workbench and
-- Agent entitlements remain account-scoped, so an administrator can test and
-- use exactly the same durable permission path as any other member.
SELECT set_config('app.member_permission_write', 'on', true);

WITH inserted AS (
  INSERT INTO public.member_permission_assignments (
    user_id, feature_navigation_keys, agent_navigation_keys, revision, checksum,
    source, reason, updated_by
  )
  SELECT
    u.id,
    '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
    '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb,
    1,
    public.member_permission_checksum(
      u.id,
      '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
      '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb,
      1
    ),
    'admin_default',
    '管理员后台角色保持不变；前台业务功能建立独立全量初始快照',
    NULL
  FROM public.users u
  WHERE u.role = 'admin'
  ON CONFLICT (user_id) DO NOTHING
  RETURNING *
)
INSERT INTO public.member_permission_events (
  user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
)
SELECT
  user_id, NULL, revision, source, NULL, reason, NULL,
  jsonb_build_object(
    'feature_navigation_keys', feature_navigation_keys,
    'agent_navigation_keys', agent_navigation_keys,
    'source_profile_key', source_profile_key,
    'source_profile_version', source_profile_version,
    'revision', revision,
    'checksum', checksum
  )
FROM inserted;

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

-- The atomic setter already performs role verification on the actor. Remove
-- only the obsolete prohibition on an administrator being the target; all
-- revision, integrity, idempotency and audit checks stay unchanged.
DO $migration$
DECLARE
  v_definition text;
  v_forbidden_block text := $block$  IF v_target.role = 'admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_ADMIN_TARGET_FORBIDDEN');
  END IF;

$block$;
BEGIN
  SELECT pg_get_functiondef(
    'public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer)'::regprocedure
  ) INTO v_definition;
  IF position(v_forbidden_block IN v_definition) = 0 THEN
    RAISE EXCEPTION 'MEMBER_PERMISSION_ADMIN_TARGET_GUARD_NOT_FOUND';
  END IF;
  EXECUTE replace(v_definition, v_forbidden_block, '');
END;
$migration$;

CREATE OR REPLACE FUNCTION public.seed_admin_member_permission_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_features jsonb := '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb;
  v_agents jsonb := '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb;
  v_checksum text;
  v_inserted integer := 0;
BEGIN
  IF NEW.role <> 'admin' THEN RETURN NEW; END IF;
  v_checksum := public.member_permission_checksum(NEW.id, v_features, v_agents, 1);
  PERFORM set_config('app.member_permission_write', 'on', true);
  INSERT INTO public.member_permission_assignments (
    user_id, feature_navigation_keys, agent_navigation_keys, revision, checksum,
    source, reason, updated_by
  ) VALUES (
    NEW.id, v_features, v_agents, 1, v_checksum,
    'admin_default', '管理员后台角色保持不变；前台业务功能建立独立全量初始快照', NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted > 0 THEN
    INSERT INTO public.member_permission_events (
      user_id, actor_id, revision, source, request_key, reason, before_snapshot, after_snapshot
    ) VALUES (
      NEW.id, NULL, 1, 'admin_default', NULL,
      '管理员后台角色保持不变；前台业务功能建立独立全量初始快照', NULL,
      jsonb_build_object(
        'feature_navigation_keys', v_features,
        'agent_navigation_keys', v_agents,
        'source_profile_key', NULL,
        'source_profile_version', NULL,
        'revision', 1,
        'checksum', v_checksum
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_admin_member_permission_seed ON public.users;
CREATE TRIGGER users_admin_member_permission_seed
AFTER INSERT OR UPDATE OF role ON public.users
FOR EACH ROW EXECUTE FUNCTION public.seed_admin_member_permission_snapshot();

REVOKE ALL ON FUNCTION public.read_member_permission_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_member_permission_snapshot(text) TO service_role;
REVOKE ALL ON FUNCTION public.seed_admin_member_permission_snapshot() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
