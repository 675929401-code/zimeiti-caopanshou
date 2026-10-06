BEGIN;
SET LOCAL lock_timeout = '10s';

-- Invitation codes are tickets for exactly one successful registration. Keep
-- the historical column for compatibility, but permanently pin it to false.
DROP INDEX IF EXISTS public.invitation_codes_one_permanent_per_user;

WITH first_relation AS (
  SELECT DISTINCT ON (invitation_code_id)
    invitation_code_id,
    invitee_id,
    invited_at
  FROM public.invitation_records
  WHERE invitation_code_id IS NOT NULL
  ORDER BY invitation_code_id, invited_at ASC, id ASC
)
UPDATE public.invitation_codes AS code
SET is_used = true,
    used_by = coalesce(code.used_by, relation.invitee_id),
    used_at = coalesce(code.used_at, relation.invited_at, clock_timestamp()),
    is_permanent = false
FROM first_relation AS relation
WHERE code.id = relation.invitation_code_id;

UPDATE public.invitation_codes
SET is_permanent = false
WHERE is_permanent IS DISTINCT FROM false;

-- If legacy data contains several unused codes for one member, retain only
-- the newest one as usable. Older codes are retired without inventing an
-- invitee; their historical rows and snapshots remain untouched.
WITH ranked_open_codes AS (
  SELECT id,
         row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS position
  FROM public.invitation_codes
  WHERE is_used IS FALSE
)
UPDATE public.invitation_codes AS code
SET is_used = true,
    used_at = coalesce(code.used_at, clock_timestamp()),
    is_permanent = false
FROM ranked_open_codes AS ranked
WHERE code.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE public.invitation_codes
  ALTER COLUMN is_permanent SET DEFAULT false,
  ALTER COLUMN is_permanent SET NOT NULL;

ALTER TABLE public.invitation_codes
  DROP CONSTRAINT IF EXISTS invitation_codes_single_use_only;
ALTER TABLE public.invitation_codes
  ADD CONSTRAINT invitation_codes_single_use_only
  CHECK (is_permanent IS FALSE);

CREATE UNIQUE INDEX IF NOT EXISTS invitation_codes_unique_normalized_code
  ON public.invitation_codes (upper(code));

CREATE UNIQUE INDEX IF NOT EXISTS invitation_codes_one_open_per_user
  ON public.invitation_codes (user_id)
  WHERE is_used IS FALSE;

CREATE OR REPLACE FUNCTION public.create_one_time_invitation_code(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_code text;
  v_attempt integer;
  v_index integer;
  v_random_bytes bytea;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = p_user_id::text
      AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('one-time-invitation:' || p_user_id::text, 0));

  SELECT *
  INTO v_invitation
  FROM public.invitation_codes
  WHERE user_id = p_user_id
    AND is_used IS FALSE
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reused_open_code', true,
      'code', to_jsonb(v_invitation)
    );
  END IF;

  FOR v_attempt IN 1..8 LOOP
    v_random_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    FOR v_index IN 0..7 LOOP
      v_code := v_code || substr(
        v_alphabet,
        (get_byte(v_random_bytes, v_index) % length(v_alphabet)) + 1,
        1
      );
    END LOOP;

    BEGIN
      INSERT INTO public.invitation_codes (user_id, code, is_used, is_permanent)
      VALUES (p_user_id, v_code, false, false)
      RETURNING * INTO v_invitation;

      RETURN jsonb_build_object(
        'ok', true,
        'reused_open_code', false,
        'code', to_jsonb(v_invitation)
      );
    EXCEPTION
      WHEN unique_violation THEN
        SELECT *
        INTO v_invitation
        FROM public.invitation_codes
        WHERE user_id = p_user_id
          AND is_used IS FALSE
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'ok', true,
            'reused_open_code', true,
            'code', to_jsonb(v_invitation)
          );
        END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', false, 'code', 'CODE_GENERATION_EXHAUSTED');
END;
$$;

REVOKE ALL ON FUNCTION public.create_one_time_invitation_code(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_one_time_invitation_code(uuid)
  TO service_role;

COMMENT ON FUNCTION public.create_one_time_invitation_code(uuid)
  IS 'Creates at most one open single-use invitation code per active member; returns the existing open code idempotently.';

-- Compatibility wrapper for an older server during a rolling deployment. It
-- deliberately returns a one-time code despite the legacy function name.
CREATE OR REPLACE FUNCTION public.get_or_create_permanent_invitation_code(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.create_one_time_invitation_code(p_user_id);
$$;

REVOKE ALL ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  IS 'Deprecated compatibility alias. Returns the current open single-use invitation code.';

CREATE OR REPLACE FUNCTION public.register_invited_user_atomic(
  p_email text,
  p_phone text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_invitation_code text,
  p_session_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation public.invitation_codes%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_consumed integer := 0;
BEGIN
  IF nullif(btrim(p_session_id), '') IS NULL OR length(p_session_id) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SESSION_INPUT');
  END IF;

  SELECT *
  INTO v_invitation
  FROM public.invitation_codes
  WHERE upper(code) = upper(trim(p_invitation_code))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_NOT_FOUND');
  END IF;
  IF v_invitation.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_OWNER_INVALID');
  END IF;
  IF coalesce(v_invitation.is_used, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS');
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS');
  END IF;

  INSERT INTO public.users (
    username, phone, email, password_hash, display_name, role, credits,
    is_active, status, member_status, allowed_categories, invited_by,
    session_id, last_sign_in_at, updated_at
  ) VALUES (
    p_username, p_phone, p_email, p_password_hash, p_display_name, 'student', 0,
    true, 'active', 'inactive', '[]'::jsonb, v_invitation.user_id,
    p_session_id, v_now, v_now
  )
  RETURNING * INTO v_user;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_auth_sessions
    WHERE user_id = v_user.id
      AND session_id = p_session_id
      AND revoked_at IS NULL
      AND expires_at > v_now
  ) THEN
    INSERT INTO public.user_auth_sessions (
      user_id, session_id, created_at, expires_at, revoked_at, revoke_reason
    ) VALUES (
      v_user.id, p_session_id, v_now, v_now + interval '3 days', NULL, NULL
    );
  END IF;

  UPDATE public.invitation_codes
  SET is_used = true,
      is_permanent = false,
      used_by = v_user.id::uuid,
      used_at = v_now
  WHERE id = v_invitation.id
    AND is_used IS FALSE;
  GET DIAGNOSTICS v_consumed = ROW_COUNT;
  IF v_consumed <> 1 THEN
    RAISE EXCEPTION 'INVITATION_ALREADY_CONSUMED';
  END IF;

  INSERT INTO public.invitation_records (
    inviter_id, invitee_id, invitee_activated, invited_at,
    invitation_code_id, invitation_code_snapshot
  ) VALUES (
    v_invitation.user_id, v_user.id::uuid, false, v_now,
    v_invitation.id, v_invitation.code
  );

  RETURN jsonb_build_object(
    'ok', true,
    'session_active', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'username', v_user.username,
      'display_name', v_user.display_name,
      'email', v_user.email,
      'phone', v_user.phone,
      'role', v_user.role,
      'credits', v_user.credits,
      'is_active', v_user.is_active,
      'allowed_categories', v_user.allowed_categories,
      'member_status', v_user.member_status
    )
  );
EXCEPTION
  WHEN unique_violation THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS');
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'REGISTRATION_CONFLICT');
END;
$$;

REVOKE ALL ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.register_invited_user_atomic(
  text, text, text, text, text, text, text
) IS 'Server-only atomic registration. Every invitation code is consumed exactly once in the same transaction as account and attribution creation.';

NOTIFY pgrst, 'reload schema';
COMMIT;
