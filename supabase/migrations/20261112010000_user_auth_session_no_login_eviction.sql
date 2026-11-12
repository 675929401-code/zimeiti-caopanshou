BEGIN;

-- 2026-11-12：登录不再挤掉已有会话。
-- 业务要求：同一台电脑、同一出口 IP，不论开多少浏览器、登录多少个账号，
-- 都不能因为新登录而让旧会话失效。旧实现按 ip_hash 判断“换 IP”，但实际
-- 浏览器/代理/IPv6 会让同一台电脑产生不同 ip_hash，导致误踢。
-- 新策略：issue_user_auth_session 只清理本账号已过期会话并新增当前会话；
-- 不撤销任何未过期会话。退出、改密、管理员撤销仍走各自的显式撤销路径。

CREATE OR REPLACE FUNCTION public.issue_user_auth_session(
  p_user_id text,
  p_session_id text,
  p_ip_hash text DEFAULT NULL::text,
  p_user_agent_hash text DEFAULT NULL::text,
  p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz;
  v_expires_at timestamptz;
  v_active_count integer := 0;
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

  -- 仅清理本账号已经过期的会话；未过期会话一律保留。
  UPDATE public.user_auth_sessions
  SET revoked_at = v_now, revoke_reason = 'expired'
  WHERE revoked_at IS NULL
    AND expires_at <= v_now
    AND user_id = p_user_id;

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
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = p_user_id
      AND session_id = p_session_id
      AND revoked_at IS NULL
      AND expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_ROTATION_FAILED');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', p_session_id,
    'activeCount', v_active_count,
    'evictedCount', 0,
    'evictedUsers', 0
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_exclusive_user_auth_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(92720261009);

  -- Direct writes may only expire this account's already-expired sessions.
  -- Active sessions are never revoked just because another session exists.
  UPDATE public.user_auth_sessions
  SET revoked_at = clock_timestamp(), revoke_reason = 'expired'
  WHERE id <> NEW.id
    AND user_id = NEW.user_id
    AND revoked_at IS NULL
    AND expires_at <= clock_timestamp();

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) IS
  'Adds a session without evicting any unexpired session; concurrent browsers, accounts and IP changes are allowed.';

COMMENT ON FUNCTION public.enforce_exclusive_user_auth_session_write() IS
  'Direct session writes only expire already-expired sessions for the same account; no active session is evicted.';

REVOKE ALL ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) TO service_role;

COMMIT;
