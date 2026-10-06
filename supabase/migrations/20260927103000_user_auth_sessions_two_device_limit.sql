BEGIN;

-- Server-owned login sessions. A user may keep the two newest sessions active;
-- a third login atomically revokes the oldest one. IP is audit metadata only and
-- never becomes the identity boundary (shared NAT and changing IPs make that unsafe).
CREATE TABLE IF NOT EXISTS public.user_auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id character varying(64) NOT NULL,
  ip_hash character varying(64),
  user_agent_hash character varying(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT user_auth_sessions_session_id_unique UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS user_auth_sessions_user_active_idx
  ON public.user_auth_sessions (user_id, created_at DESC, id DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.user_auth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_auth_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_auth_sessions TO service_role;

-- Preserve the currently valid legacy session during the schema transition.
INSERT INTO public.user_auth_sessions (user_id, session_id, created_at, expires_at)
SELECT id, session_id, coalesce(last_sign_in_at, updated_at, now()), now() + interval '3 days'
FROM public.users
WHERE session_id IS NOT NULL AND btrim(session_id) <> ''
ON CONFLICT (session_id) DO NOTHING;

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
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = ''
     OR p_session_id IS NULL OR btrim(p_session_id) = ''
     OR length(p_session_id) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  -- Serialize login rotation per user so simultaneous logins cannot exceed two.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id, 9272026));
  -- clock_timestamp() is evaluated after a waiting request acquires the lock;
  -- transaction-start now() could otherwise make a later login look older.
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
  WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at <= v_now;

  INSERT INTO public.user_auth_sessions (
    user_id, session_id, ip_hash, user_agent_hash, created_at, expires_at, revoked_at, revoke_reason
  ) VALUES (
    p_user_id, p_session_id, nullif(btrim(p_ip_hash), ''), nullif(btrim(p_user_agent_hash), ''),
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

  WITH ranked AS (
    SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS position
    FROM public.user_auth_sessions
    WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at > v_now
  ), evicted AS (
    UPDATE public.user_auth_sessions sessions
    SET revoked_at = v_now, revoke_reason = 'concurrency_limit'
    FROM ranked
    WHERE sessions.id = ranked.id AND ranked.position > 2
    RETURNING sessions.id
  )
  SELECT count(*)::integer INTO v_evicted_count FROM evicted;

  UPDATE public.users
  SET session_id = p_session_id, last_sign_in_at = v_now, updated_at = v_now
  WHERE id = p_user_id;

  SELECT count(*)::integer INTO v_active_count
  FROM public.user_auth_sessions
  WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at > v_now;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_auth_sessions
    WHERE user_id = p_user_id AND session_id = p_session_id
      AND revoked_at IS NULL AND expires_at > v_now
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SESSION_ROTATION_FAILED');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', p_session_id,
    'activeCount', v_active_count,
    'evictedCount', v_evicted_count
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
  v_now timestamptz := now();
  v_latest_session text;
  v_revoked_count integer := 0;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = ''
     OR p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id, 9272026));

  UPDATE public.user_auth_sessions
  SET revoked_at = v_now, revoke_reason = left(coalesce(nullif(btrim(p_reason), ''), 'logout'), 80)
  WHERE user_id = p_user_id AND session_id = p_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

  SELECT session_id INTO v_latest_session
  FROM public.user_auth_sessions
  WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at > v_now
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  UPDATE public.users
  SET session_id = v_latest_session, updated_at = v_now
  WHERE id = p_user_id;

  RETURN jsonb_build_object('ok', true, 'revoked', v_revoked_count > 0, 'latestSessionId', v_latest_session);
END;
$$;

-- Legacy code clears users.session_id when a password or login identity changes.
-- Keep that action authoritative by revoking every active server-owned session.
CREATE OR REPLACE FUNCTION public.revoke_sessions_on_legacy_session_clear()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id, 9272026));
  IF TG_OP = 'UPDATE' AND NEW.session_id IS NULL THEN
    UPDATE public.user_auth_sessions
    SET revoked_at = clock_timestamp(), revoke_reason = 'account_credentials_changed'
    WHERE user_id = NEW.id AND revoked_at IS NULL;
  ELSIF NEW.session_id IS NOT NULL
        AND btrim(NEW.session_id) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM public.user_auth_sessions
          WHERE session_id = NEW.session_id AND user_id = NEW.id AND revoked_at IS NULL
        ) THEN
    INSERT INTO public.user_auth_sessions (user_id, session_id, created_at, expires_at)
    VALUES (NEW.id, NEW.session_id, clock_timestamp(), clock_timestamp() + interval '3 days')
    ON CONFLICT (session_id) DO UPDATE SET
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL,
      revoke_reason = NULL
    WHERE public.user_auth_sessions.user_id = EXCLUDED.user_id;

    -- Direct legacy writers remain compatible without bypassing the two-session cap.
    WITH ranked AS (
      SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS position
      FROM public.user_auth_sessions
      WHERE user_id = NEW.id AND revoked_at IS NULL AND expires_at > clock_timestamp()
    )
    UPDATE public.user_auth_sessions sessions
    SET revoked_at = clock_timestamp(), revoke_reason = 'concurrency_limit'
    FROM ranked
    WHERE sessions.id = ranked.id AND ranked.position > 2;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_legacy_session_authority ON public.users;
CREATE TRIGGER users_legacy_session_authority
AFTER INSERT OR UPDATE OF session_id ON public.users
FOR EACH ROW EXECUTE FUNCTION public.revoke_sessions_on_legacy_session_clear();

REVOKE ALL ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_user_auth_session(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_auth_session(text, text, text) TO service_role;

COMMENT ON TABLE public.user_auth_sessions IS 'Server-owned login sessions; at most two active sessions per user.';
COMMENT ON FUNCTION public.issue_user_auth_session(text, text, text, text, timestamptz) IS 'Atomically issues one session and revokes active sessions older than the newest two.';
COMMENT ON FUNCTION public.revoke_user_auth_session(text, text, text) IS 'Revokes only the caller session and preserves another active device session.';

NOTIFY pgrst, 'reload schema';

COMMIT;
