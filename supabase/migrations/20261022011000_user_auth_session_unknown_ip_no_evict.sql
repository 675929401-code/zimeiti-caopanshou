BEGIN;

-- 直接写入但没有 IP 指纹（例如本地脚本、历史维护）不应挤掉同账号其它会话：
-- 只有明确提供了不同 IP 才判定为换 IP 登录。
CREATE OR REPLACE FUNCTION public.enforce_exclusive_user_auth_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.ip_hash IS NULL THEN
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
  'Same-account sessions coexist on one IP; only an explicit different IP replaces them, and other accounts on the same IP are never signed out.';

COMMIT;
