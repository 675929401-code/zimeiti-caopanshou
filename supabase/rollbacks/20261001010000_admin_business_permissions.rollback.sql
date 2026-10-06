BEGIN;

DROP TRIGGER IF EXISTS users_admin_member_permission_seed ON public.users;
DROP FUNCTION IF EXISTS public.seed_admin_member_permission_snapshot();

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
  IF NOT FOUND THEN RETURN jsonb_build_object('authority_status', 'missing', 'integrity_valid', false); END IF;
  IF v_user.role = 'admin' THEN
    RETURN jsonb_build_object(
      'authority_status', 'admin', 'integrity_valid', true, 'role', 'admin',
      'feature_navigation_keys', '["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"]'::jsonb,
      'agent_navigation_keys', '["bip:loop","task:影像编导","task:文案创作","task:获客转化","自用"]'::jsonb,
      'revision', 0, 'checksum', 'admin-bypass'
    );
  END IF;
  SELECT * INTO v_assignment FROM public.member_permission_assignments WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authority_status', 'missing', 'integrity_valid', false, 'role', v_user.role, 'feature_navigation_keys', '[]'::jsonb, 'agent_navigation_keys', '[]'::jsonb);
  END IF;
  v_valid := v_assignment.checksum = public.member_permission_checksum(v_assignment.user_id,v_assignment.feature_navigation_keys,v_assignment.agent_navigation_keys,v_assignment.revision);
  RETURN jsonb_build_object(
    'authority_status', CASE WHEN v_valid THEN 'ready' ELSE 'invalid' END,
    'integrity_valid', v_valid, 'role', v_user.role,
    'feature_navigation_keys', CASE WHEN v_valid THEN v_assignment.feature_navigation_keys ELSE '[]'::jsonb END,
    'agent_navigation_keys', CASE WHEN v_valid THEN v_assignment.agent_navigation_keys ELSE '[]'::jsonb END,
    'source_profile_key', v_assignment.source_profile_key, 'source_profile_version', v_assignment.source_profile_version,
    'revision', v_assignment.revision, 'checksum', v_assignment.checksum, 'source', v_assignment.source,
    'reason', v_assignment.reason, 'updated_by', v_assignment.updated_by, 'updated_at', v_assignment.updated_at
  );
END;
$$;

DO $migration$
DECLARE
  v_definition text;
  v_anchor text := $block$  IF p_source_profile_key IS NOT NULL OR p_source_profile_version IS NOT NULL THEN
$block$;
  v_guard text := $block$  IF v_target.role = 'admin' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MEMBER_PERMISSION_ADMIN_TARGET_FORBIDDEN');
  END IF;

$block$;
BEGIN
  SELECT pg_get_functiondef('public.set_member_permissions_atomic(text,text,jsonb,jsonb,integer,text,text,text,integer)'::regprocedure) INTO v_definition;
  IF position(v_guard IN v_definition) = 0 THEN
    IF position(v_anchor IN v_definition) = 0 THEN RAISE EXCEPTION 'MEMBER_PERMISSION_SETTER_ANCHOR_NOT_FOUND'; END IF;
    EXECUTE replace(v_definition, v_anchor, v_guard || v_anchor);
  END IF;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
