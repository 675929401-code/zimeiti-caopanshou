BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

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
  INTO v_target
  FROM public.users
  WHERE id=p_target_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_USER_NOT_FOUND');
  END IF;
  IF v_target.role='admin' THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_ALREADY_ADMIN');
  END IF;
  IF v_target.is_active IS DISTINCT FROM true OR v_target.status <> 'active' THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_ACCOUNT_NOT_ACTIVE');
  END IF;
  IF nullif(btrim(coalesce(v_target.password_hash,'')),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','TARGET_LOGIN_PASSWORD_REQUIRED');
  END IF;

  v_keys := public.normalize_admin_permission_keys(p_permission_keys);
  SELECT coalesce(revision,0)+1 INTO v_revision
  FROM public.admin_access_profiles
  WHERE user_id=p_target_user_id;
  v_revision := coalesce(v_revision,1);
  v_checksum := public.admin_access_checksum(p_target_user_id,'admin',v_keys,v_revision,true);

  PERFORM set_config('app.admin_governance_write','on',true);
  UPDATE public.users
  SET role='admin', session_id=NULL, updated_at=now()
  WHERE id=p_target_user_id;

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

  UPDATE public.user_auth_sessions
  SET revoked_at=now(), revoke_reason='promoted_to_admin'
  WHERE user_id=p_target_user_id AND revoked_at IS NULL;

  PERFORM public.append_admin_governance_audit(
    p_actor_id, 'super_admin', p_target_user_id, 'admin.accounts.manage',
    'admin_account_promote', 'success', '', 'admin_access_profile',
    '/api/admin/access-control', 'POST', p_request_key, '', '',
    jsonb_build_object('former_role',v_target.role,'permission_keys',v_keys,'revision',v_revision)
  );
  RETURN jsonb_build_object(
    'success',true,
    'user_id',p_target_user_id,
    'revision',v_revision,
    'permission_keys',v_keys,
    'former_role',v_target.role,
    'sessions_revoked',true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.promote_existing_member_to_admin_atomic(text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_existing_member_to_admin_atomic(text,text,jsonb,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
