BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.agent_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_id varchar NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_favorites_user_agent_unique UNIQUE (user_id, agent_id),
  CONSTRAINT agent_favorites_user_id_not_blank CHECK (char_length(trim(user_id)) BETWEEN 1 AND 255),
  CONSTRAINT agent_favorites_agent_id_not_blank CHECK (char_length(trim(agent_id)) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS agent_favorites_user_created_idx
  ON public.agent_favorites (user_id, created_at DESC);

ALTER TABLE public.agent_favorites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_favorites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.agent_favorites TO service_role;

COMMENT ON TABLE public.agent_favorites IS
  'Account-scoped agent favorites. Persistent business data; preserved independently from release source and build artifacts.';

NOTIFY pgrst, 'reload schema';
COMMIT;
