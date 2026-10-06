BEGIN;
SET LOCAL lock_timeout = '10s';

-- Canonical project and product-line identities. The registry deliberately
-- separates a stable project_key from user workspace hashes and business UUIDs.
CREATE TABLE IF NOT EXISTS public.project_registry (
  project_key text PRIMARY KEY CHECK (
    length(project_key) BETWEEN 2 AND 64
    AND project_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  parent_project_key text REFERENCES public.project_registry(project_key) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  internal_name text NOT NULL UNIQUE CHECK (
    length(internal_name) BETWEEN 2 AND 80
    AND internal_name ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  primary_route text CHECK (
    primary_route IS NULL
    OR (
      length(primary_route) BETWEEN 1 AND 240
      AND primary_route LIKE '/%'
      AND primary_route !~ '[?#]'
      AND primary_route !~ '//'
    )
  ),
  responsible_owner text,
  lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'paused', 'retired')),
  registration_status text NOT NULL DEFAULT 'partial'
    CHECK (registration_status IN ('registered', 'partial', 'unavailable')),
  accepts_new_business boolean NOT NULL DEFAULT true,
  sla_profile jsonb NOT NULL DEFAULT '{"status":"unregistered"}'::jsonb CHECK (
    jsonb_typeof(sla_profile) = 'object'
    AND jsonb_typeof(sla_profile -> 'status') = 'string'
  ),
  tenant_support text NOT NULL DEFAULT 'unknown'
    CHECK (tenant_support IN ('unknown', 'unsupported', 'single_tenant', 'multi_tenant')),
  allowed_message_surfaces text[] NOT NULL DEFAULT '{}'::text[] CHECK (
    allowed_message_surfaces <@ ARRAY['modal','toast','banner','inbox','email']::text[]
  ),
  source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'array'),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_project_key IS NULL OR parent_project_key <> project_key),
  CHECK (lifecycle_status = 'active' OR accepts_new_business IS FALSE)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_registry_primary_route_unique
  ON public.project_registry(primary_route)
  WHERE primary_route IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_registry_parent_idx
  ON public.project_registry(parent_project_key, sort_order);
CREATE INDEX IF NOT EXISTS project_registry_status_idx
  ON public.project_registry(lifecycle_status, registration_status, sort_order);

CREATE TABLE IF NOT EXISTS public.project_workspace_registry (
  workspace_key text PRIMARY KEY CHECK (
    length(workspace_key) BETWEEN 2 AND 64
    AND workspace_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  project_key text NOT NULL REFERENCES public.project_registry(project_key) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  route text NOT NULL UNIQUE CHECK (
    length(route) BETWEEN 1 AND 240
    AND route LIKE '/%'
    AND route !~ '[?#]'
    AND route !~ '//'
  ),
  source_catalog text NOT NULL CHECK (length(btrim(source_catalog)) BETWEEN 1 AND 120),
  mapping_status text NOT NULL DEFAULT 'mapped' CHECK (mapping_status = 'mapped'),
  source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_evidence) = 'array'),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_workspace_registry_project_idx
  ON public.project_workspace_registry(project_key, sort_order);

CREATE TABLE IF NOT EXISTS public.project_source_registry (
  source_kind text NOT NULL CHECK (source_kind IN ('task', 'billing', 'notification')),
  source_key text NOT NULL CHECK (
    length(source_key) BETWEEN 2 AND 120
    AND source_key ~ '^[a-z][a-z0-9_.-]*$'
  ),
  project_key text REFERENCES public.project_registry(project_key) ON DELETE RESTRICT,
  mapping_status text NOT NULL CHECK (mapping_status IN ('mapped', 'unregistered', 'unavailable')),
  project_key_field text,
  evidence_path text NOT NULL CHECK (length(btrim(evidence_path)) BETWEEN 1 AND 500),
  reason_code text NOT NULL CHECK (
    length(reason_code) BETWEEN 2 AND 100
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_key),
  CHECK (
    (mapping_status = 'mapped' AND project_key IS NOT NULL AND project_key_field = 'project_key')
    OR (mapping_status <> 'mapped' AND project_key IS NULL AND project_key_field IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS project_source_registry_project_idx
  ON public.project_source_registry(project_key, source_kind, source_key);
CREATE INDEX IF NOT EXISTS project_source_registry_status_idx
  ON public.project_source_registry(mapping_status, source_kind, source_key);

ALTER TABLE public.project_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_workspace_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_source_registry ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.project_registry FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.project_workspace_registry FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.project_source_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.project_registry TO service_role;
GRANT SELECT ON TABLE public.project_workspace_registry TO service_role;
GRANT SELECT ON TABLE public.project_source_registry TO service_role;

INSERT INTO public.project_registry (
  project_key, parent_project_key, display_name, internal_name, primary_route,
  responsible_owner, lifecycle_status, registration_status,
  accepts_new_business, sla_profile, tenant_support,
  allowed_message_surfaces, source_evidence, sort_order
) VALUES (
  'zimeiti-caopanshou', NULL, '自媒体操盘手', 'zimeiti-caopanshou', NULL,
  NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown',
  '{}'::text[],
  '[{"source":"deploy/policies/release-policy.json","field":"projectId","value":"zimeiti-caopanshou"}]'::jsonb,
  0
)
ON CONFLICT (project_key) DO NOTHING;

INSERT INTO public.project_registry (
  project_key, parent_project_key, display_name, internal_name, primary_route,
  responsible_owner, lifecycle_status, registration_status,
  accepts_new_business, sla_profile, tenant_support,
  allowed_message_surfaces, source_evidence, sort_order
) VALUES
  ('marketplace', 'zimeiti-caopanshou', '应用广场', 'marketplace', '/', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"marketplace"}]'::jsonb, 10),
  ('toolbox', 'zimeiti-caopanshou', '效率工具', 'toolbox', '/tools', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"toolbox"}]'::jsonb, 11),
  ('storyboard_workbench', 'zimeiti-caopanshou', '分镜编排', 'storyboard_workbench', '/storyboard-workbench', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"storyboard_workbench"}]'::jsonb, 12),
  ('image_workbench', 'zimeiti-caopanshou', '图像生成', 'image_workbench', '/image-workbench', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"image_workbench"}]'::jsonb, 13),
  ('create', 'zimeiti-caopanshou', '视频创作', 'create', '/video', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"create"}]'::jsonb, 14),
  ('voice', 'zimeiti-caopanshou', '声音制作', 'voice', '/voice-studio/workspace', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"voice"}]'::jsonb, 15),
  ('cover', 'zimeiti-caopanshou', '封面设计', 'cover', '/cover', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"cover"}]'::jsonb, 16),
  ('youcai', 'zimeiti-caopanshou', '漫剧创作', 'youcai', '/youcai', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"youcai"}]'::jsonb, 17),
  ('commerce_agent', 'zimeiti-caopanshou', '带货创作', 'commerce_agent', '/commerce', NULL, 'active', 'partial', true, '{"status":"unregistered"}'::jsonb, 'unknown', '{}'::text[], '[{"source":"src/lib/marketplace-navigation.ts","symbol":"PRIMARY_NAVIGATION","workspaceKey":"commerce_agent"}]'::jsonb, 18)
ON CONFLICT (project_key) DO NOTHING;

INSERT INTO public.project_workspace_registry (
  workspace_key, project_key, display_name, route, source_catalog,
  source_evidence, sort_order
) VALUES
  ('marketplace', 'marketplace', '应用广场', '/', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"marketplace"}]'::jsonb, 10),
  ('toolbox', 'toolbox', '效率工具', '/tools', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"toolbox"}]'::jsonb, 11),
  ('storyboard_workbench', 'storyboard_workbench', '分镜编排', '/storyboard-workbench', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"storyboard_workbench"}]'::jsonb, 12),
  ('image_workbench', 'image_workbench', '图像生成', '/image-workbench', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"image_workbench"}]'::jsonb, 13),
  ('create', 'create', '视频创作', '/video', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"create"}]'::jsonb, 14),
  ('voice', 'voice', '声音制作', '/voice-studio/workspace', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"voice"}]'::jsonb, 15),
  ('cover', 'cover', '封面设计', '/cover', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"cover"}]'::jsonb, 16),
  ('youcai', 'youcai', '漫剧创作', '/youcai', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"youcai"}]'::jsonb, 17),
  ('commerce_agent', 'commerce_agent', '带货创作', '/commerce', 'PRIMARY_NAVIGATION', '[{"source":"src/lib/marketplace-navigation.ts","workspaceKey":"commerce_agent"}]'::jsonb, 18)
ON CONFLICT (workspace_key) DO NOTHING;

-- These sources are intentionally unregistered. Their current row contracts do
-- not carry project_key, so assigning historical rows from table/type names
-- would fabricate attribution.
INSERT INTO public.project_source_registry (
  source_kind, source_key, project_key, mapping_status, project_key_field,
  evidence_path, reason_code
) VALUES
  ('task', 'llm_request_attempts', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('task', 'image_generation_requests', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('task', 'video_tasks', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('task', 'voice_generation_requests', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('task', 'extraction_attempts', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('billing', 'revenue_records', NULL, 'unregistered', NULL, 'src/lib/server/admin-command-center.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('billing', 'credit_transactions', NULL, 'unregistered', NULL, 'src/lib/billing-source-catalog.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('billing', 'cash_transactions', NULL, 'unregistered', NULL, 'src/lib/billing.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('notification', 'user_notifications', NULL, 'unregistered', NULL, 'src/lib/user-notification-server.ts', 'SOURCE_HAS_NO_PROJECT_KEY'),
  ('notification', 'announcements', NULL, 'unregistered', NULL, 'src/lib/announcement-delivery-server.ts', 'SOURCE_HAS_NO_PROJECT_KEY')
ON CONFLICT (source_kind, source_key) DO NOTHING;

-- Idempotence must not hide drift. If an object already existed with one of the
-- seed keys, require its identity to match the audited source contract exactly.
DO $project_registry_seed_guard$
BEGIN
  IF EXISTS (
    WITH expected(project_key,parent_project_key,display_name,internal_name,primary_route,sort_order) AS (VALUES
      ('zimeiti-caopanshou',NULL::text,'自媒体操盘手','zimeiti-caopanshou',NULL::text,0),
      ('marketplace','zimeiti-caopanshou','应用广场','marketplace','/',10),
      ('toolbox','zimeiti-caopanshou','效率工具','toolbox','/tools',11),
      ('storyboard_workbench','zimeiti-caopanshou','分镜编排','storyboard_workbench','/storyboard-workbench',12),
      ('image_workbench','zimeiti-caopanshou','图像生成','image_workbench','/image-workbench',13),
      ('create','zimeiti-caopanshou','视频创作','create','/video',14),
      ('voice','zimeiti-caopanshou','声音制作','voice','/voice-studio/workspace',15),
      ('cover','zimeiti-caopanshou','封面设计','cover','/cover',16),
      ('youcai','zimeiti-caopanshou','漫剧创作','youcai','/youcai',17),
      ('commerce_agent','zimeiti-caopanshou','带货创作','commerce_agent','/commerce',18)
    )
    SELECT 1
      FROM expected e
      LEFT JOIN public.project_registry p ON p.project_key=e.project_key
     WHERE p.project_key IS NULL
        OR p.parent_project_key IS DISTINCT FROM e.parent_project_key
        OR p.display_name IS DISTINCT FROM e.display_name
        OR p.internal_name IS DISTINCT FROM e.internal_name
        OR p.primary_route IS DISTINCT FROM e.primary_route
        OR p.lifecycle_status <> 'active'
        OR p.registration_status <> 'partial'
        OR p.accepts_new_business IS NOT TRUE
        OR p.sort_order <> e.sort_order
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PROJECT_REGISTRY_PROJECT_SEED_CONFLICT';
  END IF;

  IF EXISTS (
    WITH expected(workspace_key,project_key,display_name,route,sort_order) AS (VALUES
      ('marketplace','marketplace','应用广场','/',10),
      ('toolbox','toolbox','效率工具','/tools',11),
      ('storyboard_workbench','storyboard_workbench','分镜编排','/storyboard-workbench',12),
      ('image_workbench','image_workbench','图像生成','/image-workbench',13),
      ('create','create','视频创作','/video',14),
      ('voice','voice','声音制作','/voice-studio/workspace',15),
      ('cover','cover','封面设计','/cover',16),
      ('youcai','youcai','漫剧创作','/youcai',17),
      ('commerce_agent','commerce_agent','带货创作','/commerce',18)
    )
    SELECT 1
      FROM expected e
      LEFT JOIN public.project_workspace_registry w ON w.workspace_key=e.workspace_key
     WHERE w.workspace_key IS NULL
        OR w.project_key IS DISTINCT FROM e.project_key
        OR w.display_name IS DISTINCT FROM e.display_name
        OR w.route IS DISTINCT FROM e.route
        OR w.source_catalog <> 'PRIMARY_NAVIGATION'
        OR w.mapping_status <> 'mapped'
        OR w.sort_order <> e.sort_order
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PROJECT_REGISTRY_WORKSPACE_SEED_CONFLICT';
  END IF;

  IF EXISTS (
    WITH expected(source_kind,source_key,evidence_path) AS (VALUES
      ('task','llm_request_attempts','src/lib/server/admin-command-center.ts'),
      ('task','image_generation_requests','src/lib/server/admin-command-center.ts'),
      ('task','video_tasks','src/lib/server/admin-command-center.ts'),
      ('task','voice_generation_requests','src/lib/server/admin-command-center.ts'),
      ('task','extraction_attempts','src/lib/server/admin-command-center.ts'),
      ('billing','revenue_records','src/lib/server/admin-command-center.ts'),
      ('billing','credit_transactions','src/lib/billing-source-catalog.ts'),
      ('billing','cash_transactions','src/lib/billing.ts'),
      ('notification','user_notifications','src/lib/user-notification-server.ts'),
      ('notification','announcements','src/lib/announcement-delivery-server.ts')
    )
    SELECT 1
      FROM expected e
      LEFT JOIN public.project_source_registry s
        ON s.source_kind=e.source_kind AND s.source_key=e.source_key
     WHERE s.source_key IS NULL
        OR s.mapping_status <> 'unregistered'
        OR s.project_key IS NOT NULL
        OR s.project_key_field IS NOT NULL
        OR s.evidence_path IS DISTINCT FROM e.evidence_path
        OR s.reason_code <> 'SOURCE_HAS_NO_PROJECT_KEY'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'PROJECT_REGISTRY_SOURCE_SEED_CONFLICT';
  END IF;
END;
$project_registry_seed_guard$;

COMMENT ON TABLE public.project_registry IS
  'Canonical project/product-line identities; pausing new business never deletes historical facts.';
COMMENT ON TABLE public.project_workspace_registry IS
  'Exactly-once mapping from stable visible workspace keys to canonical project keys.';
COMMENT ON TABLE public.project_source_registry IS
  'Audited task, billing, and notification source attribution state; unregistered means no row-level project_key evidence.';

NOTIFY pgrst, 'reload schema';
COMMIT;
