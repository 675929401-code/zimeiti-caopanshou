BEGIN;

-- Registration and legacy maintenance functions can write user_auth_sessions
-- directly. Keep those paths inside the same account/IP scope invariant as
-- issue_user_auth_session instead of relying on every caller to duplicate it.
-- Same-account sessions on the same IP intentionally remain active.
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
    AND revoked_at IS NULL
    AND expires_at <= v_now
    AND (
      (user_id = NEW.user_id AND ip_hash IS DISTINCT FROM NEW.ip_hash)
      OR (NEW.ip_hash IS NOT NULL AND ip_hash = NEW.ip_hash AND user_id <> NEW.user_id)
    );

  SELECT coalesce(array_agg(DISTINCT user_id::text), ARRAY[]::text[])
  INTO v_evicted_user_ids
  FROM public.user_auth_sessions
  WHERE id <> NEW.id
    AND revoked_at IS NULL
    AND expires_at > v_now
    AND (
      (user_id = NEW.user_id AND ip_hash IS DISTINCT FROM NEW.ip_hash)
      OR (NEW.ip_hash IS NOT NULL AND ip_hash = NEW.ip_hash AND user_id <> NEW.user_id)
    );

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now,
      revoke_reason = CASE
        WHEN user_id = NEW.user_id THEN 'superseded_by_new_ip_direct_session_write'
        ELSE 'ip_account_replaced_by_direct_session_write'
      END
  WHERE id <> NEW.id
    AND revoked_at IS NULL
    AND expires_at > v_now
    AND (
      (user_id = NEW.user_id AND ip_hash IS DISTINCT FROM NEW.ip_hash)
      OR (NEW.ip_hash IS NOT NULL AND ip_hash = NEW.ip_hash AND user_id <> NEW.user_id)
    );

  UPDATE public.users
  SET session_id = NULL, updated_at = v_now
  WHERE id::text = ANY(v_evicted_user_ids)
    AND id <> NEW.user_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_auth_sessions_exclusive_write_guard ON public.user_auth_sessions;
CREATE TRIGGER user_auth_sessions_exclusive_write_guard
BEFORE INSERT OR UPDATE OF user_id, ip_hash, expires_at, revoked_at
ON public.user_auth_sessions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_exclusive_user_auth_session_write();

REVOKE ALL ON FUNCTION public.enforce_exclusive_user_auth_session_write() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_exclusive_user_auth_session_write() IS
  'Keeps direct writes inside one-account-per-IP and one-IP-per-account while allowing same-account sessions on the same IP.';

COMMIT;
