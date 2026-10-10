BEGIN;

-- Product session policy: one active account per IP fingerprint and one active
-- IP per account. Multiple browsers/windows for the same account on the same
-- IP are intentionally allowed. Login rotation is serialized because a new IP
-- login may revoke rows owned by another user; a single transaction lock keeps
-- the mapping atomic and avoids cross-user deadlocks.
UPDATE public.user_auth_sessions
SET revoked_at = clock_timestamp(), revoke_reason = 'expired'
WHERE revoked_at IS NULL AND expires_at <= clock_timestamp();

WITH conflicted AS (
  SELECT sessions.id
  FROM public.user_auth_sessions sessions
  WHERE sessions.revoked_at IS NULL
    AND sessions.expires_at > clock_timestamp()
    AND EXISTS (
      SELECT 1
      FROM public.user_auth_sessions newer
      WHERE newer.id <> sessions.id
        AND newer.revoked_at IS NULL
        AND newer.expires_at > clock_timestamp()
        AND (
          (
            newer.user_id = sessions.user_id
            AND newer.ip_hash IS DISTINCT FROM sessions.ip_hash
          )
          OR (
            sessions.ip_hash IS NOT NULL
            AND newer.ip_hash = sessions.ip_hash
            AND newer.user_id <> sessions.user_id
          )
        )
        AND (newer.created_at, newer.id) > (sessions.created_at, sessions.id)
    )
)
UPDATE public.user_auth_sessions sessions
SET revoked_at = clock_timestamp(), revoke_reason = 'exclusive_ip_scope_policy_migration'
FROM conflicted
WHERE sessions.id = conflicted.id;

WITH latest AS (
  SELECT users.id AS user_id,
    (
      SELECT sessions.session_id
      FROM public.user_auth_sessions sessions
      WHERE sessions.user_id = users.id
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > clock_timestamp()
      ORDER BY sessions.created_at DESC, sessions.id DESC
      LIMIT 1
    ) AS session_id
  FROM public.users users
  WHERE users.session_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.user_auth_sessions sessions
       WHERE sessions.user_id = users.id
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > clock_timestamp()
     )
)
UPDATE public.users users
SET session_id = latest.session_id, updated_at = clock_timestamp()
FROM latest
WHERE users.id = latest.user_id
  AND users.session_id IS DISTINCT FROM latest.session_id;

DROP INDEX IF EXISTS public.user_auth_sessions_one_active_user_idx;
DROP INDEX IF EXISTS public.user_auth_sessions_one_active_ip_idx;

CREATE INDEX IF NOT EXISTS user_auth_sessions_active_user_ip_idx
  ON public.user_auth_sessions (user_id, ip_hash, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_auth_sessions_active_ip_user_idx
  ON public.user_auth_sessions (ip_hash, user_id, created_at DESC)
  WHERE revoked_at IS NULL AND ip_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.issue_user_auth_session(
  p_user_id text,
  p_session_id text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent_hash text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    AND (user_id = p_user_id OR ip_hash = btrim(p_ip_hash));

  SELECT coalesce(array_agg(DISTINCT user_id::text), ARRAY[]::text[])
  INTO v_evicted_user_ids
  FROM public.user_auth_sessions
  WHERE revoked_at IS NULL
    AND expires_at > v_now
    AND (
      (user_id = p_user_id AND ip_hash IS DISTINCT FROM btrim(p_ip_hash))
      OR (ip_hash = btrim(p_ip_hash) AND user_id <> p_user_id)
    );

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now,
      revoke_reason = CASE
        WHEN user_id = p_user_id THEN 'superseded_by_new_ip'
        ELSE 'ip_account_replaced'
      END
  WHERE revoked_at IS NULL
    AND expires_at > v_now
    AND (
      (user_id = p_user_id AND ip_hash IS DISTINCT FROM btrim(p_ip_hash))
      OR (ip_hash = btrim(p_ip_hash) AND user_id <> p_user_id)
    );
  GET DIAGNOSTICS v_evicted_count = ROW_COUNT;

  UPDATE public.users
  SET session_id = NULL, updated_at = v_now
  WHERE id::text = ANY(v_evicted_user_ids)
    AND id <> p_user_id;

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
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_auth_session(
  p_user_id text,
  p_session_id text,
  p_reason text DEFAULT 'logout'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
  v_latest_session text;
  v_revoked_count integer := 0;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = ''
     OR p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  PERFORM pg_advisory_xact_lock(92720261009);
  v_now := clock_timestamp();

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now,
      revoke_reason = left(coalesce(nullif(btrim(p_reason), ''), 'logout'), 80)
  WHERE user_id = p_user_id AND session_id = p_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

  SELECT session_id INTO v_latest_session
  FROM public.user_auth_sessions
  WHERE user_id = p_user_id
    AND revoked_at IS NULL
    AND expires_at > v_now
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  UPDATE public.users
  SET session_id = v_latest_session, updated_at = v_now
  WHERE id = p_user_id AND session_id = p_session_id;

  RETURN jsonb_build_object('ok', true, 'revoked', v_revoked_count > 0, 'latestSessionId', v_latest_session);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_sessions_on_legacy_session_clear()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(92720261009);
  v_now := clock_timestamp();

  IF TG_OP = 'UPDATE' AND NEW.session_id IS NULL THEN
    UPDATE public.user_auth_sessions
    SET revoked_at = v_now, revoke_reason = 'account_credentials_changed'
    WHERE user_id = NEW.id AND revoked_at IS NULL;
  ELSIF NEW.session_id IS NOT NULL
        AND btrim(NEW.session_id) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM public.user_auth_sessions
          WHERE session_id = NEW.session_id AND user_id = NEW.id AND revoked_at IS NULL
        ) THEN
    UPDATE public.user_auth_sessions
    SET revoked_at = v_now, revoke_reason = 'legacy_session_replaced'
    WHERE user_id = NEW.id AND revoked_at IS NULL;

    INSERT INTO public.user_auth_sessions (user_id, session_id, created_at, expires_at)
    VALUES (NEW.id, NEW.session_id, v_now, v_now + interval '3 days')
    ON CONFLICT (session_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL,
      revoke_reason = NULL
    WHERE public.user_auth_sessions.user_id = EXCLUDED.user_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_user_auth_session(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_auth_session(text, text, text) TO service_role;

COMMENT ON TABLE public.user_auth_sessions IS
  'Server-owned login sessions; one active IP per account and one active account per IP, while same-account sessions on that IP may coexist.';
COMMENT ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) IS
  'Atomically issues a session, preserving same-account sessions on the same IP while replacing other IPs or another account on that IP.';
COMMENT ON FUNCTION public.revoke_user_auth_session(text, text, text) IS
  'Revokes only the caller session and preserves sibling sessions for the same account and IP.';

NOTIFY pgrst, 'reload schema';

COMMIT;
