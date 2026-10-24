BEGIN;

-- 同一 IP 上允许多账号、多窗口、多浏览器共存：只有“同一账号换了 IP”才挤下线。
-- 原实现的 ip_account_replaced（不同账号同 IP 互踢）被移除，因为本地/同一台电脑
-- 多标签、多浏览器、多账号同时在线属于正常用法，不应被判定为异常登录。

CREATE OR REPLACE FUNCTION public.issue_user_auth_session(p_user_id text, p_session_id text, p_ip_hash text DEFAULT NULL::text, p_user_agent_hash text DEFAULT NULL::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz;
  v_expires_at timestamptz;
  v_active_count integer := 0;
  v_evicted_count integer := 0;
  v_evicted_user_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = ''
     OR p_session_id IS NULL OR btrim(p_session_id) = ''
     OR length(p_session_id) > 64
     OR p_ip_hash IS NULL OR btrim(p_ip_hash) = ''
     OR length(p_ip_hash) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  PERFORM pg_advisory_xact_lock(92720261009);
  v_now := clock_timestamp();
  v_expires_at := coalesce(p_expires_at, v_now + interval '3 days');
  IF v_expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND is_active IS TRUE AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'USER_NOT_ACTIVE');
  END IF;

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now, revoke_reason = 'expired'
  WHERE revoked_at IS NULL
    AND expires_at <= v_now
    AND user_id = p_user_id;

  SELECT coalesce(array_agg(DISTINCT user_id::text), ARRAY[]::text[])
  INTO v_evicted_user_ids
  FROM public.user_auth_sessions
  WHERE revoked_at IS NULL
    AND expires_at > v_now
    AND user_id = p_user_id
    AND ip_hash IS DISTINCT FROM btrim(p_ip_hash);

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now,
      revoke_reason = 'superseded_by_new_ip'
  WHERE revoked_at IS NULL
    AND expires_at > v_now
    AND user_id = p_user_id
    AND ip_hash IS DISTINCT FROM btrim(p_ip_hash);
  GET DIAGNOSTICS v_evicted_count = ROW_COUNT;

  INSERT INTO public.user_auth_sessions (
    user_id, session_id, ip_hash, user_agent_hash, created_at, expires_at, revoked_at, revoke_reason
  ) VALUES (
    p_user_id, p_session_id, btrim(p_ip_hash), nullif(btrim(p_user_agent_hash), ''),
    v_now, v_expires_at, NULL, NULL
  )
  ON CONFLICT (session_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    ip_hash = EXCLUDED.ip_hash,
    user_agent_hash = EXCLUDED.user_agent_hash,
    created_at = EXCLUDED.created_at,
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revoke_reason = NULL;

  UPDATE public.users
  SET session_id = p_session_id, last_sign_in_at = v_now, updated_at = v_now
  WHERE id = p_user_id;

  SELECT count(*)::integer INTO v_active_count
  FROM public.user_auth_sessions
  WHERE user_id = p_user_id
    AND ip_hash = btrim(p_ip_hash)
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = p_user_id
      AND session_id = p_session_id
      AND ip_hash = btrim(p_ip_hash)
      AND revoked_at IS NULL
      AND expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_ROTATION_FAILED');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', p_session_id,
    'activeCount', v_active_count,
    'evictedCount', v_evicted_count,
    'evictedUsers', coalesce(array_length(v_evicted_user_ids, 1), 0)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_exclusive_user_auth_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_evicted_user_ids text[] := ARRAY[]::text[];
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(92720261009);
  v_now := clock_timestamp();

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now, revoke_reason = 'expired'
  WHERE id <> NEW.id
    AND user_id = NEW.user_id
    AND revoked_at IS NULL
    AND expires_at <= v_now;

  SELECT coalesce(array_agg(DISTINCT user_id::text), ARRAY[]::text[])
  INTO v_evicted_user_ids
  FROM public.user_auth_sessions
  WHERE id <> NEW.id
    AND user_id = NEW.user_id
    AND revoked_at IS NULL
    AND expires_at > v_now
    AND ip_hash IS DISTINCT FROM NEW.ip_hash;

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now,
      revoke_reason = 'superseded_by_new_ip_direct_session_write'
  WHERE id <> NEW.id
    AND user_id = NEW.user_id
    AND revoked_at IS NULL
    AND expires_at > v_now
    AND ip_hash IS DISTINCT FROM NEW.ip_hash;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_exclusive_user_auth_session_write() IS
  'Direct session writes only replace that same account''s sessions from a different IP; other accounts on the same IP stay signed in.';

COMMIT;
