BEGIN;
SET LOCAL lock_timeout = '10s';

-- Keep the exact code used at registration. Mapping a record back to the
-- inviter's current permanent code is ambiguous after one-time codes or code
-- rotation and is not acceptable for commercial attribution.
ALTER TABLE public.invitation_records
  ADD COLUMN IF NOT EXISTS invitation_code_id character varying(36),
  ADD COLUMN IF NOT EXISTS invitation_code_snapshot character varying(64);

DO $invitation_code_reference$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invitation_records_invitation_code_fk'
  ) THEN
    ALTER TABLE public.invitation_records
      ADD CONSTRAINT invitation_records_invitation_code_fk
      FOREIGN KEY (invitation_code_id)
      REFERENCES public.invitation_codes(id)
      ON DELETE SET NULL;
  END IF;
END;
$invitation_code_reference$;

CREATE UNIQUE INDEX IF NOT EXISTS invitation_records_one_owner_per_invitee
  ON public.invitation_records (invitee_id);

-- Historical one-time codes can be matched exactly by used_by. A permanent
-- inviter code is the best available legacy snapshot when no one-time match
-- exists. New registrations always persist both fields directly.
WITH ranked_matches AS (
  SELECT
    record.id AS record_id,
    code.id AS code_id,
    code.code,
    row_number() OVER (
      PARTITION BY record.id
      ORDER BY (code.used_by = record.invitee_id) DESC, code.created_at DESC, code.id
    ) AS position
  FROM public.invitation_records AS record
  JOIN public.invitation_codes AS code
    ON code.used_by = record.invitee_id
    OR (code.is_permanent IS TRUE AND code.user_id = record.inviter_id)
  WHERE record.invitation_code_id IS NULL
)
UPDATE public.invitation_records AS record
SET
  invitation_code_id = matched.code_id,
  invitation_code_snapshot = matched.code
FROM ranked_matches AS matched
WHERE matched.record_id = record.id
  AND matched.position = 1;

-- Registration already creates the account, consumes the invitation and writes
-- the invitation relationship atomically. Keep the first authenticated session
-- in that same transaction now that user_auth_sessions is the login authority.
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
    username, phone, email, password_hash, display_name, role, credits,
    is_active, status, member_status, allowed_categories, invited_by,
    session_id, last_sign_in_at, updated_at
  ) VALUES (
    p_username, p_phone, p_email, p_password_hash, p_display_name, 'student', 0,
    true, 'active', 'inactive', '[]'::jsonb, v_invitation.user_id,
    p_session_id, v_now, v_now
  )
  RETURNING * INTO v_user;

  INSERT INTO public.user_auth_sessions (
    user_id, session_id, created_at, expires_at, revoked_at, revoke_reason
  ) VALUES (
    v_user.id, p_session_id, v_now, v_now + interval '3 days', NULL, NULL
  );

  IF NOT coalesce(v_invitation.is_permanent, false) THEN
    UPDATE public.invitation_codes
    SET is_used = true, used_by = v_user.id::uuid, used_at = v_now
    WHERE id = v_invitation.id;
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
) IS 'Server-only atomic invited registration including invitation ownership, first authoritative session and last-sign-in activity.';

NOTIFY pgrst, 'reload schema';
COMMIT;
