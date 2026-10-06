BEGIN;
SET LOCAL lock_timeout = '10s';

-- Phase one is an evidence/status foundation. It deliberately does not attach
-- legacy business rows or writers to a default tenant and does not use Host as
-- an authorization claim.
CREATE TABLE IF NOT EXISTS public.tenants (
  tenant_key text PRIMARY KEY CHECK (
    length(tenant_key) BETWEEN 2 AND 80
    AND tenant_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  lifecycle_status text NOT NULL DEFAULT 'foundation_only'
    CHECK (lifecycle_status IN ('foundation_only','active','suspended','archived')),
  operating_mode text NOT NULL DEFAULT 'single_tenant'
    CHECK (operating_mode IN ('single_tenant','multi_tenant')),
  boundary_status text NOT NULL DEFAULT 'unavailable'
    CHECK (boundary_status IN ('unavailable','partial','verified')),
  status_reason text NOT NULL DEFAULT 'CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED'
    CHECK (length(status_reason) BETWEEN 2 AND 120 AND status_reason ~ '^[A-Z][A-Z0-9_]*$'),
  session_claim_status text NOT NULL DEFAULT 'unavailable'
    CHECK (session_claim_status IN ('unavailable','configured','verified')),
  business_read_scope_status text NOT NULL DEFAULT 'unavailable'
    CHECK (business_read_scope_status IN ('unavailable','partial','verified')),
  business_write_scope_status text NOT NULL DEFAULT 'unavailable'
    CHECK (business_write_scope_status IN ('unavailable','partial','verified')),
  cross_tenant_test_status text NOT NULL DEFAULT 'not_run'
    CHECK (cross_tenant_test_status IN ('not_run','passed','failed')),
  isolation_verified_at timestamptz,
  isolation_evidence_uri text,
  isolation_evidence_sha256 text CHECK (
    isolation_evidence_sha256 IS NULL OR isolation_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    boundary_status <> 'verified'
    OR (
      operating_mode = 'multi_tenant'
      AND session_claim_status = 'verified'
      AND business_read_scope_status = 'verified'
      AND business_write_scope_status = 'verified'
      AND cross_tenant_test_status = 'passed'
      AND isolation_verified_at IS NOT NULL
      AND isolation_evidence_uri IS NOT NULL
      AND isolation_evidence_sha256 IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.tenant_members (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  user_id text NOT NULL CHECK (length(btrim(user_id)) BETWEEN 1 AND 80),
  role_key text NOT NULL CHECK (
    length(role_key) BETWEEN 2 AND 80
    AND role_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  membership_status text NOT NULL DEFAULT 'invited'
    CHECK (membership_status IN ('invited','active','suspended','revoked')),
  identity_link_status text NOT NULL DEFAULT 'unavailable'
    CHECK (identity_link_status IN ('unavailable','recorded','verified','failed')),
  identity_source text NOT NULL DEFAULT 'public.users'
    CHECK (length(btrim(identity_source)) BETWEEN 2 AND 200),
  joined_at timestamptz,
  revoked_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, user_id),
  CHECK (
    membership_status <> 'active'
    OR (
      identity_link_status = 'verified'
      AND joined_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  ),
  CHECK (membership_status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS tenant_members_user_idx
  ON public.tenant_members(user_id, tenant_key);

CREATE TABLE IF NOT EXISTS public.sites (
  site_key text PRIMARY KEY CHECK (
    length(site_key) BETWEEN 2 AND 80
    AND site_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  lifecycle_status text NOT NULL DEFAULT 'foundation_only'
    CHECK (lifecycle_status IN ('foundation_only','active','suspended','archived')),
  is_default boolean NOT NULL DEFAULT false,
  routing_status text NOT NULL DEFAULT 'unavailable'
    CHECK (routing_status IN ('unavailable','configured','verified','failed')),
  brand_scope_status text NOT NULL DEFAULT 'unavailable'
    CHECK (brand_scope_status IN ('unavailable','linked','verified','failed')),
  status_reason text NOT NULL DEFAULT 'STATIC_SINGLE_SITE_ONLY'
    CHECK (length(status_reason) BETWEEN 2 AND 120 AND status_reason ~ '^[A-Z][A-Z0-9_]*$'),
  routing_verified_at timestamptz,
  routing_evidence_uri text,
  routing_evidence_sha256 text CHECK (
    routing_evidence_sha256 IS NULL OR routing_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, site_key),
  CHECK (
    routing_status <> 'verified'
    OR (
      routing_verified_at IS NOT NULL
      AND routing_evidence_uri IS NOT NULL
      AND routing_evidence_sha256 IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sites_one_default_per_tenant_idx
  ON public.sites(tenant_key) WHERE is_default;
CREATE INDEX IF NOT EXISTS sites_tenant_idx
  ON public.sites(tenant_key, site_key);

CREATE TABLE IF NOT EXISTS public.site_hostnames (
  hostname text PRIMARY KEY CHECK (
    hostname = lower(hostname)
    AND length(hostname) BETWEEN 1 AND 253
    AND position(':' IN hostname) = 0
    AND position('/' IN hostname) = 0
    AND hostname !~ '[[:space:]]'
    AND hostname ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  ),
  site_key text NOT NULL,
  tenant_key text NOT NULL,
  hostname_kind text NOT NULL CHECK (hostname_kind IN ('canonical','custom')),
  verification_status text NOT NULL DEFAULT 'unavailable'
    CHECK (verification_status IN ('unavailable','claimed','verified','failed','revoked')),
  routing_candidate_only boolean NOT NULL DEFAULT true CHECK (routing_candidate_only IS TRUE),
  authorization_eligible boolean NOT NULL DEFAULT false CHECK (authorization_eligible IS FALSE),
  verified_at timestamptz,
  ownership_evidence_uri text,
  ownership_evidence_sha256 text CHECK (
    ownership_evidence_sha256 IS NULL OR ownership_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  tls_evidence_uri text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_key, site_key) REFERENCES public.sites(tenant_key, site_key) ON DELETE RESTRICT,
  CHECK (
    verification_status <> 'verified'
    OR (
      verified_at IS NOT NULL
      AND ownership_evidence_uri IS NOT NULL
      AND ownership_evidence_sha256 IS NOT NULL
      AND tls_evidence_uri IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS site_hostnames_site_idx
  ON public.site_hostnames(site_key, verification_status);

CREATE TABLE IF NOT EXISTS public.site_brand_releases (
  release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  site_key text NOT NULL,
  brand_profile_key text,
  external_revision_id text,
  release_status text NOT NULL DEFAULT 'unlinked'
    CHECK (release_status IN ('unlinked','draft','published','retired','failed')),
  source_system text NOT NULL DEFAULT 'public.platform_brand_profiles'
    CHECK (length(btrim(source_system)) BETWEEN 2 AND 200),
  published_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_key, site_key) REFERENCES public.sites(tenant_key, site_key) ON DELETE RESTRICT,
  CHECK (
    release_status <> 'published'
    OR (
      brand_profile_key IS NOT NULL
      AND external_revision_id IS NOT NULL
      AND published_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS site_brand_releases_site_idx
  ON public.site_brand_releases(site_key, published_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS site_brand_one_published_idx
  ON public.site_brand_releases(site_key) WHERE release_status = 'published';

CREATE TABLE IF NOT EXISTS public.tenant_resource_integrations (
  resource_key text PRIMARY KEY CHECK (
    length(resource_key) BETWEEN 2 AND 100
    AND resource_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  domain_key text NOT NULL
    CHECK (domain_key IN ('users','sessions','orders','messages','assets','announcements','brand','site','host')),
  source_kind text NOT NULL CHECK (source_kind IN ('table','route','runtime','claim')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 2 AND 300),
  tenant_scope_status text NOT NULL DEFAULT 'absent'
    CHECK (tenant_scope_status IN ('absent','present_unbound','verified')),
  site_scope_requirement text NOT NULL DEFAULT 'undecided'
    CHECK (site_scope_requirement IN ('undecided','required','not_required')),
  site_scope_status text NOT NULL DEFAULT 'absent'
    CHECK (site_scope_status IN ('absent','present_unbound','verified','not_required')),
  tenant_column text,
  site_column text,
  read_scope_status text NOT NULL DEFAULT 'unavailable'
    CHECK (read_scope_status IN ('unavailable','partial','verified')),
  write_scope_status text NOT NULL DEFAULT 'unavailable'
    CHECK (write_scope_status IN ('unavailable','partial','verified')),
  database_policy_status text NOT NULL DEFAULT 'unavailable'
    CHECK (database_policy_status IN ('unavailable','service_only','tenant_rls_verified')),
  session_claim_status text NOT NULL DEFAULT 'unavailable'
    CHECK (session_claim_status IN ('unavailable','configured','verified')),
  cross_tenant_test_status text NOT NULL DEFAULT 'not_run'
    CHECK (cross_tenant_test_status IN ('not_run','passed','failed')),
  integration_status text NOT NULL DEFAULT 'unintegrated'
    CHECK (integration_status IN ('unintegrated','partial','integrated')),
  status_reason text NOT NULL CHECK (
    length(status_reason) BETWEEN 2 AND 120 AND status_reason ~ '^[A-Z][A-Z0-9_]*$'
  ),
  verified_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_evidence) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tenant_scope_status <> 'verified' OR tenant_column IS NOT NULL),
  CHECK (
    site_scope_requirement <> 'required'
    OR site_scope_status <> 'verified'
    OR site_column IS NOT NULL
  ),
  CHECK (
    integration_status <> 'integrated'
    OR (
      tenant_scope_status = 'verified'
      AND site_scope_requirement <> 'undecided'
      AND (
        (site_scope_requirement = 'required' AND site_scope_status = 'verified')
        OR (site_scope_requirement = 'not_required' AND site_scope_status = 'not_required')
      )
      AND read_scope_status = 'verified'
      AND write_scope_status = 'verified'
      AND database_policy_status = 'tenant_rls_verified'
      AND session_claim_status = 'verified'
      AND cross_tenant_test_status = 'passed'
      AND verified_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS tenant_resource_integrations_domain_idx
  ON public.tenant_resource_integrations(domain_key, integration_status);

CREATE TABLE IF NOT EXISTS public.tenant_isolation_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_a_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  tenant_b_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  test_scope text NOT NULL CHECK (length(btrim(test_scope)) BETWEEN 2 AND 300),
  receipt_status text NOT NULL DEFAULT 'unavailable'
    CHECK (receipt_status IN ('unavailable','planned','passed','failed','expired')),
  cross_tenant_read_rejected boolean,
  cross_tenant_write_rejected boolean,
  zero_data_leakage boolean,
  tested_at timestamptz,
  expires_at timestamptz,
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tenant_a_key <> tenant_b_key),
  CHECK (
    receipt_status <> 'passed'
    OR (
      cross_tenant_read_rejected IS TRUE
      AND cross_tenant_write_rejected IS TRUE
      AND zero_data_leakage IS TRUE
      AND tested_at IS NOT NULL
      AND evidence_uri IS NOT NULL
      AND evidence_sha256 IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS tenant_isolation_receipts_tenant_idx
  ON public.tenant_isolation_receipts(tenant_a_key, tenant_b_key, tested_at DESC);

CREATE TABLE IF NOT EXISTS public.tenant_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  actor_id text,
  action_key text NOT NULL CHECK (
    length(action_key) BETWEEN 2 AND 100
    AND action_key ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$'
  ),
  result text NOT NULL CHECK (result IN ('info','allowed','denied','unavailable','failed')),
  reason_code text NOT NULL CHECK (
    length(reason_code) BETWEEN 2 AND 120 AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  resource_type text NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 2 AND 100),
  resource_id text,
  happened_at timestamptz NOT NULL DEFAULT now(),
  evidence_uri text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (site_key IS NULL OR tenant_key IS NOT NULL),
  FOREIGN KEY (tenant_key, site_key) REFERENCES public.sites(tenant_key, site_key) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tenant_audits_scope_idx
  ON public.tenant_audits(tenant_key, site_key, happened_at DESC);

CREATE OR REPLACE FUNCTION public.reject_tenant_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'TENANT_AUDIT_IMMUTABLE';
END;
$$;

CREATE OR REPLACE FUNCTION public.bump_multitenant_record_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_revision_bump ON public.tenants;
CREATE TRIGGER tenants_revision_bump
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.bump_multitenant_record_revision();

DROP TRIGGER IF EXISTS sites_revision_bump ON public.sites;
CREATE TRIGGER sites_revision_bump
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.bump_multitenant_record_revision();

DROP TRIGGER IF EXISTS tenant_resource_integrations_revision_bump ON public.tenant_resource_integrations;
CREATE TRIGGER tenant_resource_integrations_revision_bump
  BEFORE UPDATE ON public.tenant_resource_integrations
  FOR EACH ROW EXECUTE FUNCTION public.bump_multitenant_record_revision();

DROP TRIGGER IF EXISTS tenant_audits_immutable ON public.tenant_audits;
CREATE TRIGGER tenant_audits_immutable
  BEFORE UPDATE OR DELETE ON public.tenant_audits
  FOR EACH ROW EXECUTE FUNCTION public.reject_tenant_audit_mutation();

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_hostnames ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_brand_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_resource_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_isolation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenants FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sites FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.site_hostnames FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.site_brand_releases FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_resource_integrations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_isolation_receipts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_audits FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.tenants TO service_role;
GRANT SELECT ON TABLE public.tenant_members TO service_role;
GRANT SELECT ON TABLE public.sites TO service_role;
GRANT SELECT ON TABLE public.site_hostnames TO service_role;
GRANT SELECT ON TABLE public.site_brand_releases TO service_role;
GRANT SELECT ON TABLE public.tenant_resource_integrations TO service_role;
GRANT SELECT ON TABLE public.tenant_isolation_receipts TO service_role;
GRANT SELECT ON TABLE public.tenant_audits TO service_role;

REVOKE ALL ON FUNCTION public.reject_tenant_audit_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bump_multitenant_record_revision() FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.tenants (
  tenant_key, display_name, lifecycle_status, operating_mode, boundary_status,
  status_reason, session_claim_status, business_read_scope_status,
  business_write_scope_status, cross_tenant_test_status, metadata
) VALUES (
  'default', '当前单站点平台', 'foundation_only', 'single_tenant', 'unavailable',
  'CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED', 'unavailable', 'unavailable',
  'unavailable', 'not_run',
  '{"fact":"current_platform_is_single_tenant","legacyRowsAttached":false}'::jsonb
)
ON CONFLICT (tenant_key) DO NOTHING;

INSERT INTO public.sites (
  site_key, tenant_key, display_name, lifecycle_status, is_default,
  routing_status, brand_scope_status, status_reason, metadata
) VALUES (
  'default', 'default', '当前默认站点', 'foundation_only', true,
  'unavailable', 'unavailable', 'STATIC_SINGLE_SITE_ONLY',
  '{"fact":"platform_brand_profile_is_fixed_to_default","hostAuthorizationEnabled":false}'::jsonb
)
ON CONFLICT (site_key) DO NOTHING;

INSERT INTO public.tenant_resource_integrations (
  resource_key, domain_key, source_kind, source_ref,
  tenant_scope_status, site_scope_requirement, site_scope_status,
  tenant_column, site_column, read_scope_status, write_scope_status,
  database_policy_status, session_claim_status, cross_tenant_test_status,
  integration_status, status_reason, source_evidence
) VALUES
  ('users-table','users','table','public.users','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"deploy/local/task-baseline.sql","fact":"users has no tenant_id or site_id"}]'::jsonb),
  ('auth-sessions-table','sessions','table','public.user_auth_sessions','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"supabase/migrations/20260927103000_user_auth_sessions_two_device_limit.sql","fact":"session authority uses user_id only"}]'::jsonb),
  ('payment-orders-table','orders','table','public.payment_orders','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"deploy/local/task-baseline.sql","fact":"payment_orders has no tenant_id or site_id"}]'::jsonb),
  ('conversation-messages-table','messages','table','public.conversation_messages','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"deploy/local/task-baseline.sql","fact":"conversation_messages has no tenant_id or site_id"}]'::jsonb),
  ('user-notifications-table','messages','table','public.user_notifications','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"src/lib/user-notification-server.ts","fact":"notification scope is user_id only"}]'::jsonb),
  ('unified-messaging-campaigns-table','messages','table','public.message_campaigns','present_unbound','undecided','present_unbound','tenant_key','site_key','partial','partial','service_only','unavailable','not_run','unintegrated','CANONICAL_TENANT_FK_ABSENT','[{"path":"supabase/migrations/20261002150000_unified_messaging_control_plane.sql","fact":"tenant_key and site_key have no canonical boundary foreign key or session claim"}]'::jsonb),
  ('user-files-table','assets','table','public.user_files','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"deploy/local/task-baseline.sql","fact":"user_files has no tenant_id or site_id"}]'::jsonb),
  ('announcements-table','announcements','table','public.announcements','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','TENANT_COLUMN_ABSENT','[{"path":"deploy/local/task-baseline.sql","fact":"announcements has no tenant_id or site_id"}]'::jsonb),
  ('platform-brand-profile','brand','runtime','public.platform_brand_profiles/default','absent','required','absent',NULL,NULL,'unavailable','unavailable','service_only','unavailable','not_run','unintegrated','STATIC_SINGLE_SITE_CONTRACT','[{"path":"supabase/migrations/20261002120000_platform_brand_control_plane.sql","fact":"profile key and RPCs are fixed to default"}]'::jsonb),
  ('site-config-route','site','route','/api/site-config','absent','required','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','STATIC_SINGLE_SITE_CONTRACT','[{"path":"src/app/api/site-config/route.ts","fact":"route returns one static public catalog"}]'::jsonb),
  ('public-branding-route','brand','route','/api/branding','absent','required','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','STATIC_SINGLE_SITE_CONTRACT','[{"path":"src/app/api/branding/route.ts","fact":"route reads the sole published platform brand"}]'::jsonb),
  ('proxy-host-runtime','host','runtime','src/proxy.ts','absent','required','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','TRUSTED_HOST_SITE_RESOLUTION_ABSENT','[{"path":"src/proxy.ts","fact":"Host is used for response security behavior, not tenant authorization"}]'::jsonb),
  ('auth-routes','sessions','route','/api/auth/*','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','SESSION_CLAIM_ABSENT','[{"path":"src/lib/auth-session-store.ts","fact":"session contract has no tenant claim"}]'::jsonb),
  ('order-routes','orders','route','/api/payment/*,/api/admin/payment-orders','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','TENANT_CONTEXT_PROPAGATION_ABSENT','[{"path":"src/app/api/payment/create/route.ts"},{"path":"src/app/api/admin/payment-orders/route.ts"}]'::jsonb),
  ('message-routes','messages','route','/api/notifications/*,/api/conversations/*','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','TENANT_CONTEXT_PROPAGATION_ABSENT','[{"path":"src/app/api/notifications/user/route.ts"},{"path":"src/app/api/conversations/history/route.ts"}]'::jsonb),
  ('asset-routes','assets','route','/api/user/assets,/api/media-history/*','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','TENANT_CONTEXT_PROPAGATION_ABSENT','[{"path":"src/app/api/user/assets/route.ts"},{"path":"src/app/api/media-history/route.ts"}]'::jsonb),
  ('announcement-routes','announcements','route','/api/announcements/*','absent','undecided','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','TENANT_CONTEXT_PROPAGATION_ABSENT','[{"path":"src/app/api/announcements/route.ts"},{"path":"src/app/api/announcements/inbox/route.ts"}]'::jsonb),
  ('brand-admin-routes','brand','route','/api/admin/branding/*','absent','required','absent',NULL,NULL,'unavailable','unavailable','unavailable','unavailable','not_run','unintegrated','STATIC_SINGLE_SITE_CONTRACT','[{"path":"src/app/api/admin/branding/route.ts","fact":"admin writes the sole default platform profile"}]'::jsonb)
ON CONFLICT (resource_key) DO NOTHING;

COMMENT ON TABLE public.tenants IS 'Phase-one tenant registry. The seeded default row records current single-tenant reality and is not a legacy-row assignment.';
COMMENT ON TABLE public.site_hostnames IS 'Verified routing candidates only. Host text is explicitly ineligible as an authorization claim.';
COMMENT ON TABLE public.tenant_resource_integrations IS 'Audited authoritative sources and route families. Every unregistered legacy table, route, or writer remains unintegrated; integrated requires claim, read/write propagation, tenant RLS, and cross-tenant rejection evidence.';
COMMENT ON TABLE public.tenant_isolation_receipts IS 'Two-distinct-tenant read/write rejection and zero-leakage receipts.';
COMMENT ON TABLE public.tenant_audits IS 'Append-only tenant boundary audit events; phase one exposes no mutation API.';

NOTIFY pgrst, 'reload schema';
COMMIT;
