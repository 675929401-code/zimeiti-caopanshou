BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.business_ip_member_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  business_data text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_ip_member_profiles_user_name_unique UNIQUE (user_id, name),
  CONSTRAINT business_ip_member_profiles_user_id_not_blank CHECK (char_length(trim(user_id)) BETWEEN 1 AND 255),
  CONSTRAINT business_ip_member_profiles_name_not_blank CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  CONSTRAINT business_ip_member_profiles_data_not_blank CHECK (char_length(trim(business_data)) BETWEEN 1 AND 60000),
  CONSTRAINT business_ip_member_profiles_status_valid CHECK (status IN ('draft', 'safe', 'ready')),
  CONSTRAINT business_ip_member_profiles_version_valid CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS business_ip_member_profiles_active_idx
  ON public.business_ip_member_profiles (user_id, last_used_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.business_ip_conversation_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id varchar(128) NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.business_ip_member_profiles(id) ON DELETE CASCADE,
  bound_profile_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_ip_conversation_profiles_owner_unique UNIQUE (user_id, conversation_id),
  CONSTRAINT business_ip_conversation_profiles_conversation_valid CHECK (conversation_id ~ '^[a-zA-Z0-9_-]{8,128}$'),
  CONSTRAINT business_ip_conversation_profiles_version_valid CHECK (bound_profile_version >= 1)
);

CREATE INDEX IF NOT EXISTS business_ip_conversation_profiles_lookup_idx
  ON public.business_ip_conversation_profiles (user_id, conversation_id, profile_id);

ALTER TABLE public.business_ip_member_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_ip_conversation_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.business_ip_member_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.business_ip_conversation_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_ip_member_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_ip_conversation_profiles TO service_role;

COMMENT ON TABLE public.business_ip_member_profiles IS
  'Account-scoped business facts for the commercial-IP consultation assistant. Customer chat remains in its own conversation history.';
COMMENT ON TABLE public.business_ip_conversation_profiles IS
  'Member-selected binding from one customer conversation to one owned business profile. It prevents later global profile switches from changing an existing customer conversation.';

NOTIFY pgrst, 'reload schema';
COMMIT;
