-- Atomically validates/consumes an invitation, creates the user, and records
-- the invitation relationship. The function is server-only: browser roles
-- must never receive direct access because password hashes are parameters.

BEGIN;

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
BEGIN
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

  IF NOT coalesce(v_invitation.is_permanent, false)
     AND coalesce(v_invitation.is_used, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVITATION_USED');
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE email = p_email) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMAIL_EXISTS');
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE phone = p_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PHONE_EXISTS');
  END IF;

  INSERT INTO public.users (
    username,
    phone,
    email,
    password_hash,
    display_name,
    role,
    credits,
    is_active,
    status,
    member_status,
    allowed_categories,
    invited_by,
    session_id
  ) VALUES (
    p_username,
    p_phone,
    p_email,
    p_password_hash,
    p_display_name,
    'student',
    0,
    true,
    'active',
    'inactive',
    '[]'::jsonb,
    v_invitation.user_id,
    p_session_id
  )
  RETURNING * INTO v_user;

  IF NOT coalesce(v_invitation.is_permanent, false) THEN
    UPDATE public.invitation_codes
    SET
      is_used = true,
      used_by = v_user.id::uuid,
      used_at = now()
    WHERE id = v_invitation.id;
  END IF;

  INSERT INTO public.invitation_records (
    inviter_id,
    invitee_id,
    invitee_activated
  ) VALUES (
    v_invitation.user_id,
    v_user.id::uuid,
    false
  );

  RETURN jsonb_build_object(
    'ok', true,
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
) IS 'Server-only atomic invited registration. Locks one-time codes and rolls back user/code/record writes together.';

-- These indexes are the database-level invariants behind idempotent permanent
-- code creation. The pre-deploy audit found no duplicate codes or duplicate
-- permanent codes per user in the current database.
CREATE UNIQUE INDEX IF NOT EXISTS invitation_codes_unique_normalized_code
  ON public.invitation_codes (upper(code));

CREATE UNIQUE INDEX IF NOT EXISTS invitation_codes_one_permanent_per_user
  ON public.invitation_codes (user_id)
  WHERE is_permanent IS TRUE;

CREATE OR REPLACE FUNCTION public.get_or_create_permanent_invitation_code(
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
  -- Serialize creation for one user even before the partial unique index is
  -- consulted, then return an existing permanent code idempotently.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT *
  INTO v_invitation
  FROM public.invitation_codes
  WHERE user_id = p_user_id
    AND is_permanent IS TRUE
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', to_jsonb(v_invitation));
  END IF;

  FOR v_attempt IN 1..5 LOOP
    -- gen_random_uuid() is backed by PostgreSQL's cryptographic random source.
    -- Map eight bytes into the 32-character alphabet without modulo bias.
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
      INSERT INTO public.invitation_codes (user_id, code, is_permanent)
      VALUES (p_user_id, v_code, true)
      RETURNING * INTO v_invitation;

      RETURN jsonb_build_object('ok', true, 'code', to_jsonb(v_invitation));
    EXCEPTION
      WHEN unique_violation THEN
        SELECT *
        INTO v_invitation
        FROM public.invitation_codes
        WHERE user_id = p_user_id
          AND is_permanent IS TRUE
        ORDER BY created_at DESC
        LIMIT 1;

        IF FOUND THEN
          RETURN jsonb_build_object('ok', true, 'code', to_jsonb(v_invitation));
        END IF;
        -- Otherwise this was a rare random-code collision; retry.
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', false, 'code', 'CODE_GENERATION_EXHAUSTED');
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_or_create_permanent_invitation_code(uuid)
  IS 'Server-only idempotent permanent invitation-code creation with per-user serialization.';

COMMIT;
