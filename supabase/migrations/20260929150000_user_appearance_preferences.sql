BEGIN;

CREATE TABLE IF NOT EXISTS public.user_appearance_preferences (
  user_id character varying(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  theme_key character varying(32) NOT NULL,
  mode_preference character varying(16) NOT NULL,
  ip_hash character varying(64) NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_appearance_preferences_theme_check
    CHECK (theme_key IN ('lattice', 'soft-white', 'crystal-aurora', 'stellar-blue')),
  CONSTRAINT user_appearance_preferences_mode_check
    CHECK (mode_preference IN ('system', 'light', 'dark'))
);

CREATE INDEX IF NOT EXISTS user_appearance_preferences_expires_at_idx
  ON public.user_appearance_preferences(expires_at);

ALTER TABLE public.user_appearance_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_appearance_preferences FROM anon, authenticated;
GRANT ALL ON TABLE public.user_appearance_preferences TO service_role;

COMMENT ON TABLE public.user_appearance_preferences IS
  'Seven-day user appearance choices scoped to a server-side HMAC of the current IP; plaintext IP is never stored.';

COMMIT;
