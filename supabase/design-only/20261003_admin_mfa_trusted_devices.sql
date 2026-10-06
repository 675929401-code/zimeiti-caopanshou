-- DESIGN ONLY — DO NOT APPLY FROM THE NORMAL MIGRATION RUNNER.
--
-- This candidate describes the durable state required before the product may
-- call email verification "administrator MFA" or issue a trusted-device
-- credential. It has deliberately not been copied into supabase/migrations.
-- Application requires an explicit database batch, backup, local transaction
-- verification and a login-flow canary.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_mfa_profiles (
  actor_id character varying(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  factor text NOT NULL DEFAULT 'email_otp' CHECK (factor = 'email_otp'),
  destination_hash character varying(64) NOT NULL,
  enabled_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  disabled_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(destination_hash) = 64)
);

CREATE TABLE IF NOT EXISTS public.admin_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('enroll','login','sensitive_operation','trust_device')),
  pending_login_nonce_hash character varying(64),
  code_hash character varying(64) NOT NULL,
  destination_hash character varying(64) NOT NULL,
  request_ip_hash character varying(64),
  user_agent_hash character varying(64),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (expires_at > created_at),
  CHECK (length(code_hash) = 64),
  CHECK (length(destination_hash) = 64),
  CHECK (pending_login_nonce_hash IS NULL OR length(pending_login_nonce_hash) = 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_mfa_pending_login_nonce_unique
  ON public.admin_mfa_challenges(pending_login_nonce_hash)
  WHERE pending_login_nonce_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_mfa_challenge_actor_active_idx
  ON public.admin_mfa_challenges(actor_id, expires_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.admin_trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id character varying(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash character varying(64) NOT NULL UNIQUE,
  user_agent_hash character varying(64) NOT NULL,
  device_label text NOT NULL DEFAULT '已验证设备',
  issued_from_challenge_id uuid NOT NULL REFERENCES public.admin_mfa_challenges(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (expires_at > created_at),
  CHECK (length(token_hash) = 64),
  CHECK (length(user_agent_hash) = 64),
  CHECK (char_length(device_label) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS admin_trusted_device_actor_active_idx
  ON public.admin_trusted_devices(actor_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.admin_mfa_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_trusted_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_mfa_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_mfa_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.admin_trusted_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_mfa_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_mfa_challenges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_trusted_devices TO service_role;

COMMENT ON TABLE public.admin_mfa_profiles IS
  'Design-only administrator email OTP MFA enrollment; stores no plaintext destination.';
COMMENT ON TABLE public.admin_mfa_challenges IS
  'Design-only single-use MFA challenge. Login challenges must be consumed before any JWT or user_auth_sessions row is issued.';
COMMENT ON TABLE public.admin_trusted_devices IS
  'Design-only random trusted-device token hashes issued only after a successful MFA challenge; IP is never an identity key.';

COMMIT;
