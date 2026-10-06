BEGIN;

CREATE TABLE IF NOT EXISTS public.user_profile_avatars (
  user_id character varying(36) PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  avatar_url text NOT NULL,
  storage_provider character varying(32),
  storage_key text,
  source character varying(16) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_profile_avatars_source_check CHECK (source IN ('preset', 'upload')),
  CONSTRAINT user_profile_avatars_url_length_check CHECK (char_length(avatar_url) BETWEEN 1 AND 2048),
  CONSTRAINT user_profile_avatars_storage_pair_check CHECK (
    (source = 'preset' AND storage_provider IS NULL AND storage_key IS NULL)
    OR
    (source = 'upload' AND storage_provider IS NOT NULL AND storage_key IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_profile_avatars_storage_key_unique
  ON public.user_profile_avatars(storage_provider, storage_key)
  WHERE storage_key IS NOT NULL;

ALTER TABLE public.user_profile_avatars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_profile_avatars FROM anon, authenticated;
GRANT ALL ON TABLE public.user_profile_avatars TO service_role;

COMMENT ON TABLE public.user_profile_avatars IS
  'Current user profile avatar. Uploaded objects retain provider and key for safe replacement cleanup.';

COMMIT;
