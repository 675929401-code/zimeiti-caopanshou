BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Commerce homepage display catalog: admin-editable overlays for the baseline
-- scenario cards, image skill cards and quick tools. Functional contracts
-- (entry ids, material slots, routes) stay in code; this table only carries
-- display fields plus ordering and visibility. Draft/published split keeps
-- member-facing output stable until an explicit publish.

CREATE TABLE IF NOT EXISTS public.commerce_home_catalog_entries (
  entry_kind text NOT NULL CHECK (entry_kind IN ('scenario','image_skill','quick_tool')),
  entry_key text NOT NULL CHECK (entry_key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  draft_payload jsonb,
  published_payload jsonb,
  published_version integer NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  change_note text NOT NULL DEFAULT '',
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (entry_kind, entry_key)
);

COMMENT ON TABLE public.commerce_home_catalog_entries IS 'Commerce homepage display catalog overlays. Baseline contracts remain in code; drafts become member-visible only after publish.';

REVOKE ALL ON public.commerce_home_catalog_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_home_catalog_entries TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
