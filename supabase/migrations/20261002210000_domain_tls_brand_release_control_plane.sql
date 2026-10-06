BEGIN;
SET LOCAL lock_timeout = '10s';

-- Phase-one domain/TLS/brand-release evidence foundation.
-- Prerequisite: 20261002200000_multitenant_brand_boundary.sql.
-- This migration does not resolve DNS, issue certificates, probe HTTPS,
-- configure a gateway, alter Nginx, or authorize requests by Host.

CREATE OR REPLACE FUNCTION public.is_valid_domain_ascii_hostname(p_hostname text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    p_hostname IS NOT NULL
    AND p_hostname = lower(p_hostname)
    AND char_length(p_hostname) BETWEEN 4 AND 253
    AND p_hostname !~ '[:/[:space:]_*@]'
    AND p_hostname !~ '\.\.'
    AND p_hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND right(p_hostname, 1) <> '.'
    AND split_part(reverse(p_hostname), '.', 1) !~ '^[0-9]+$'
$$;

CREATE OR REPLACE FUNCTION public.is_reserved_domain_ascii_hostname(p_hostname text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    p_hostname IS NULL
    OR p_hostname IN (
      'localhost',
      'example',
      'example.com',
      'example.net',
      'example.org',
      'invalid',
      'test'
    )
    OR p_hostname LIKE '%.localhost'
    OR p_hostname LIKE '%.local'
    OR p_hostname LIKE '%.internal'
    OR p_hostname LIKE '%.home'
    OR p_hostname LIKE '%.lan'
    OR p_hostname LIKE '%.test'
    OR p_hostname LIKE '%.invalid'
    OR p_hostname LIKE '%.example'
    OR p_hostname LIKE '%.example.com'
    OR p_hostname LIKE '%.example.net'
    OR p_hostname LIKE '%.example.org'
    OR p_hostname LIKE '%.onion'
    OR p_hostname LIKE '%.arpa'
$$;

CREATE TABLE IF NOT EXISTS public.domain_claims (
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text NOT NULL REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  requested_hostname text NOT NULL CHECK (char_length(requested_hostname) BETWEEN 1 AND 512),
  ascii_hostname text NOT NULL UNIQUE,
  unicode_hostname text,
  normalization_version text NOT NULL DEFAULT 'node.domainToASCII.v1'
    CHECK (normalization_version = 'node.domainToASCII.v1'),
  claim_kind text NOT NULL CHECK (claim_kind IN ('canonical','custom')),
  claim_status text NOT NULL DEFAULT 'draft'
    CHECK (claim_status IN ('draft','pending_verification','verified','rejected','revoked')),
  verification_token_hash text NOT NULL
    CHECK (verification_token_hash ~ '^[a-f0-9]{64}$'),
  verification_token_hint text NOT NULL
    CHECK (verification_token_hint ~ '^[A-Za-z0-9_-]{4,12}$'),
  expected_txt_name text NOT NULL CHECK (char_length(expected_txt_name) BETWEEN 4 AND 253),
  ownership_verified_at timestamptz,
  ownership_evidence_sha256 text
    CHECK (ownership_evidence_sha256 IS NULL OR ownership_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  rejection_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by text NOT NULL CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_claim_ascii_valid CHECK (public.is_valid_domain_ascii_hostname(ascii_hostname)),
  CONSTRAINT domain_claim_txt_name_length CHECK (char_length(ascii_hostname) <= 223),
  CONSTRAINT domain_claim_not_reserved CHECK (NOT public.is_reserved_domain_ascii_hostname(ascii_hostname)),
  CONSTRAINT domain_claim_txt_name CHECK (
    expected_txt_name = '_zimeiti-domain-verification.' || ascii_hostname
  ),
  CONSTRAINT domain_claim_verified_evidence CHECK (
    claim_status <> 'verified'
    OR (ownership_verified_at IS NOT NULL AND ownership_evidence_sha256 IS NOT NULL)
  ),
  CONSTRAINT domain_claim_rejection_shape CHECK (
    claim_status <> 'rejected'
    OR (rejection_code IS NOT NULL AND rejection_code ~ '^[A-Z][A-Z0-9_]{2,119}$')
  )
);

CREATE TABLE IF NOT EXISTS public.domain_hostnames (
  hostname_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL UNIQUE REFERENCES public.domain_claims(claim_id) ON DELETE RESTRICT,
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text NOT NULL REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  ascii_hostname text NOT NULL UNIQUE,
  hostname_kind text NOT NULL CHECK (hostname_kind IN ('canonical','custom')),
  lifecycle_status text NOT NULL DEFAULT 'claimed'
    CHECK (lifecycle_status IN ('claimed','dns_verified','tls_pending','preview_ready','published','suspended','revoked')),
  ownership_status text NOT NULL DEFAULT 'unavailable'
    CHECK (ownership_status IN ('unavailable','pending','verified','failed')),
  routing_status text NOT NULL DEFAULT 'unavailable'
    CHECK (routing_status IN ('unavailable','pending','verified','drifted','failed')),
  tls_status text NOT NULL DEFAULT 'unavailable'
    CHECK (tls_status IN ('unavailable','pending','issued','expiring','expired','failed')),
  https_status text NOT NULL DEFAULT 'unavailable'
    CHECK (https_status IN ('unavailable','pending','passed','failed')),
  gateway_connector_kind text NOT NULL DEFAULT 'none'
    CHECK (gateway_connector_kind IN ('none','cloudflare_for_saas','explicit_gateway')),
  gateway_connector_status text NOT NULL DEFAULT 'unavailable'
    CHECK (gateway_connector_status IN ('unavailable','configured','verified','failed')),
  routing_activation_enabled boolean NOT NULL DEFAULT false CHECK (routing_activation_enabled IS FALSE),
  ownership_verified_at timestamptz,
  routing_verified_at timestamptz,
  tls_not_before timestamptz,
  tls_not_after timestamptz,
  https_verified_at timestamptz,
  latest_evidence_sha256 text
    CHECK (latest_evidence_sha256 IS NULL OR latest_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_hostname_ascii_valid CHECK (public.is_valid_domain_ascii_hostname(ascii_hostname)),
  CONSTRAINT domain_hostname_not_reserved CHECK (NOT public.is_reserved_domain_ascii_hostname(ascii_hostname)),
  CONSTRAINT domain_hostname_phase_one_activation_block CHECK (
    lifecycle_status NOT IN ('preview_ready','published') AND routing_activation_enabled IS FALSE
  ),
  CONSTRAINT domain_hostname_verified_evidence CHECK (
    ownership_status <> 'verified'
    OR (ownership_verified_at IS NOT NULL AND latest_evidence_sha256 IS NOT NULL)
  ),
  CONSTRAINT domain_hostname_routing_evidence CHECK (
    routing_status <> 'verified'
    OR (routing_verified_at IS NOT NULL AND latest_evidence_sha256 IS NOT NULL)
  ),
  CONSTRAINT domain_hostname_tls_range CHECK (
    tls_not_before IS NULL OR tls_not_after IS NULL OR tls_not_after > tls_not_before
  ),
  CONSTRAINT domain_hostname_https_evidence CHECK (
    https_status <> 'passed'
    OR (https_verified_at IS NOT NULL AND latest_evidence_sha256 IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS domain_hostnames_site_idx
  ON public.domain_hostnames(tenant_key, site_key, lifecycle_status);
CREATE INDEX IF NOT EXISTS domain_hostnames_tls_expiry_idx
  ON public.domain_hostnames(tls_not_after)
  WHERE tls_not_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.domain_verification_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.domain_claims(claim_id) ON DELETE RESTRICT,
  hostname_id uuid REFERENCES public.domain_hostnames(hostname_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('txt_ownership','cname_routing')),
  attempt_status text NOT NULL DEFAULT 'unavailable'
    CHECK (attempt_status IN ('unavailable','queued','running','passed','failed')),
  expected_record_name text NOT NULL CHECK (char_length(expected_record_name) BETWEEN 1 AND 253),
  expected_value_hash text NOT NULL CHECK (expected_value_hash ~ '^[a-f0-9]{64}$'),
  observed_values_hash text CHECK (observed_values_hash IS NULL OR observed_values_hash ~ '^[a-f0-9]{64}$'),
  resolver_name text,
  attempted_at timestamptz,
  completed_at timestamptz,
  error_code text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_verification_unavailable_null CHECK (
    attempt_status <> 'unavailable'
    OR (
      observed_values_hash IS NULL AND resolver_name IS NULL AND attempted_at IS NULL
      AND completed_at IS NULL AND evidence_sha256 IS NULL
    )
  ),
  CONSTRAINT domain_verification_terminal_evidence CHECK (
    attempt_status NOT IN ('passed','failed')
    OR (attempted_at IS NOT NULL AND completed_at IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS domain_verification_claim_idx
  ON public.domain_verification_attempts(claim_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.domain_tls_probes (
  probe_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname_id uuid NOT NULL REFERENCES public.domain_hostnames(hostname_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  probe_kind text NOT NULL CHECK (probe_kind IN ('tls_handshake','https_head','https_get')),
  probe_status text NOT NULL DEFAULT 'unavailable'
    CHECK (probe_status IN ('unavailable','queued','running','passed','failed')),
  certificate_fingerprint_sha256 text
    CHECK (certificate_fingerprint_sha256 IS NULL OR certificate_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  san_set_sha256 text CHECK (san_set_sha256 IS NULL OR san_set_sha256 ~ '^[a-f0-9]{64}$'),
  certificate_not_before timestamptz,
  certificate_not_after timestamptz,
  negotiated_protocol text,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  redirect_target_hash text CHECK (redirect_target_hash IS NULL OR redirect_target_hash ~ '^[a-f0-9]{64}$'),
  attempted_at timestamptz,
  completed_at timestamptz,
  error_code text,
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_tls_probe_range CHECK (
    certificate_not_before IS NULL OR certificate_not_after IS NULL
    OR certificate_not_after > certificate_not_before
  ),
  CONSTRAINT domain_tls_probe_unavailable_null CHECK (
    probe_status <> 'unavailable'
    OR (
      certificate_fingerprint_sha256 IS NULL AND san_set_sha256 IS NULL
      AND certificate_not_before IS NULL AND certificate_not_after IS NULL
      AND negotiated_protocol IS NULL AND http_status IS NULL
      AND redirect_target_hash IS NULL AND attempted_at IS NULL
      AND completed_at IS NULL AND evidence_sha256 IS NULL
    )
  ),
  CONSTRAINT domain_tls_probe_terminal_evidence CHECK (
    probe_status NOT IN ('passed','failed')
    OR (attempted_at IS NOT NULL AND completed_at IS NOT NULL AND evidence_sha256 IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS domain_tls_probe_hostname_idx
  ON public.domain_tls_probes(hostname_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.domain_brand_release_bindings (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname_id uuid NOT NULL REFERENCES public.domain_hostnames(hostname_id) ON DELETE RESTRICT,
  brand_release_id uuid NOT NULL REFERENCES public.site_brand_releases(release_id) ON DELETE RESTRICT,
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text NOT NULL REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  binding_status text NOT NULL DEFAULT 'draft'
    CHECK (binding_status IN ('draft','blocked','preview_ready','published','retired','failed')),
  runtime_activation_enabled boolean NOT NULL DEFAULT false CHECK (runtime_activation_enabled IS FALSE),
  blocked_reason text NOT NULL DEFAULT 'DOMAIN_RUNTIME_NOT_CONNECTED'
    CHECK (char_length(blocked_reason) BETWEEN 3 AND 120 AND blocked_reason ~ '^[A-Z][A-Z0-9_]+$'),
  evidence_sha256 text CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hostname_id, brand_release_id),
  CONSTRAINT domain_brand_phase_one_activation_block CHECK (
    binding_status NOT IN ('preview_ready','published') AND runtime_activation_enabled IS FALSE
  )
);

CREATE TABLE IF NOT EXISTS public.domain_release_audits (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 240),
  claim_id uuid REFERENCES public.domain_claims(claim_id) ON DELETE RESTRICT,
  hostname_id uuid REFERENCES public.domain_hostnames(hostname_id) ON DELETE RESTRICT,
  binding_id uuid REFERENCES public.domain_brand_release_bindings(binding_id) ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 120),
  result text NOT NULL CHECK (result IN ('recorded','rejected','failed')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,119}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS domain_release_audits_hostname_idx
  ON public.domain_release_audits(hostname_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.enforce_domain_site_tenant_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_site_tenant text;
  v_claim public.domain_claims%ROWTYPE;
  v_hostname public.domain_hostnames%ROWTYPE;
  v_release public.site_brand_releases%ROWTYPE;
BEGIN
  SELECT tenant_key INTO v_site_tenant FROM public.sites WHERE site_key = NEW.site_key;
  IF v_site_tenant IS NULL OR v_site_tenant <> NEW.tenant_key THEN
    RAISE EXCEPTION 'DOMAIN_SITE_TENANT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'domain_claims' THEN
    IF EXISTS (
      SELECT 1
        FROM public.site_hostnames existing
       WHERE existing.hostname = NEW.ascii_hostname
         AND (existing.tenant_key <> NEW.tenant_key OR existing.site_key <> NEW.site_key)
    ) THEN
      RAISE EXCEPTION 'DOMAIN_HOSTNAME_EXISTING_SCOPE_CONFLICT' USING ERRCODE = '23505';
    END IF;
  ELSIF TG_TABLE_NAME = 'domain_hostnames' THEN
    SELECT * INTO v_claim FROM public.domain_claims WHERE claim_id = NEW.claim_id;
    IF NOT FOUND OR v_claim.tenant_key <> NEW.tenant_key OR v_claim.site_key <> NEW.site_key
       OR v_claim.ascii_hostname <> NEW.ascii_hostname OR v_claim.claim_kind <> NEW.hostname_kind THEN
      RAISE EXCEPTION 'DOMAIN_CLAIM_HOSTNAME_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'domain_brand_release_bindings' THEN
    SELECT * INTO v_hostname FROM public.domain_hostnames WHERE hostname_id = NEW.hostname_id;
    SELECT * INTO v_release FROM public.site_brand_releases WHERE release_id = NEW.brand_release_id;
    IF v_hostname.hostname_id IS NULL OR v_release.release_id IS NULL
       OR v_hostname.tenant_key <> NEW.tenant_key OR v_hostname.site_key <> NEW.site_key
       OR v_release.tenant_key <> NEW.tenant_key OR v_release.site_key <> NEW.site_key THEN
      RAISE EXCEPTION 'DOMAIN_BRAND_BINDING_SCOPE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS domain_claim_scope_guard ON public.domain_claims;
CREATE TRIGGER domain_claim_scope_guard
  BEFORE INSERT OR UPDATE ON public.domain_claims
  FOR EACH ROW EXECUTE FUNCTION public.enforce_domain_site_tenant_consistency();
DROP TRIGGER IF EXISTS domain_hostname_scope_guard ON public.domain_hostnames;
CREATE TRIGGER domain_hostname_scope_guard
  BEFORE INSERT OR UPDATE ON public.domain_hostnames
  FOR EACH ROW EXECUTE FUNCTION public.enforce_domain_site_tenant_consistency();
DROP TRIGGER IF EXISTS domain_brand_binding_scope_guard ON public.domain_brand_release_bindings;
CREATE TRIGGER domain_brand_binding_scope_guard
  BEFORE INSERT OR UPDATE ON public.domain_brand_release_bindings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_domain_site_tenant_consistency();

CREATE OR REPLACE FUNCTION public.reject_domain_release_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'DOMAIN_RELEASE_EVIDENCE_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS domain_verification_attempts_immutable ON public.domain_verification_attempts;
CREATE TRIGGER domain_verification_attempts_immutable
  BEFORE UPDATE OR DELETE ON public.domain_verification_attempts
  FOR EACH ROW EXECUTE FUNCTION public.reject_domain_release_evidence_mutation();
DROP TRIGGER IF EXISTS domain_tls_probes_immutable ON public.domain_tls_probes;
CREATE TRIGGER domain_tls_probes_immutable
  BEFORE UPDATE OR DELETE ON public.domain_tls_probes
  FOR EACH ROW EXECUTE FUNCTION public.reject_domain_release_evidence_mutation();
DROP TRIGGER IF EXISTS domain_release_audits_immutable ON public.domain_release_audits;
CREATE TRIGGER domain_release_audits_immutable
  BEFORE UPDATE OR DELETE ON public.domain_release_audits
  FOR EACH ROW EXECUTE FUNCTION public.reject_domain_release_evidence_mutation();

ALTER TABLE public.domain_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_hostnames ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_tls_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_brand_release_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_release_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.domain_claims FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.domain_hostnames FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.domain_verification_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.domain_tls_probes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.domain_brand_release_bindings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.domain_release_audits FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_domain_tls_brand_release_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hostnames jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.hostname), '[]'::jsonb)
    INTO v_hostnames
    FROM (
      SELECT
        h.ascii_hostname AS hostname,
        h.tenant_key AS "tenantKey",
        h.site_key AS "siteKey",
        h.lifecycle_status AS "lifecycleStatus",
        h.ownership_status AS "ownershipStatus",
        h.routing_status AS "routingStatus",
        h.tls_status AS "tlsStatus",
        h.https_status AS "httpsStatus",
        h.gateway_connector_status AS "gatewayConnectorStatus",
        false AS "routingActivationEnabled",
        h.tls_not_after AS "certificateNotAfter",
        h.updated_at AS "asOf"
      FROM public.domain_hostnames h
      ORDER BY h.ascii_hostname
      LIMIT 200
    ) rows;
  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'migration', '20261002210000',
    'asOf', clock_timestamp(),
    'phase', 'foundation_only',
    'tableCounts', jsonb_build_object(
      'claims', (SELECT count(*) FROM public.domain_claims),
      'hostnames', (SELECT count(*) FROM public.domain_hostnames),
      'verificationAttempts', (SELECT count(*) FROM public.domain_verification_attempts),
      'tlsProbes', (SELECT count(*) FROM public.domain_tls_probes),
      'brandReleaseBindings', (SELECT count(*) FROM public.domain_brand_release_bindings),
      'audits', (SELECT count(*) FROM public.domain_release_audits)
    ),
    'prerequisites', jsonb_build_object(
      'tenants', (SELECT count(*) FROM public.tenants),
      'sites', (SELECT count(*) FROM public.sites),
      'siteHostnameCandidates', (SELECT count(*) FROM public.site_hostnames),
      'siteBrandReleases', (SELECT count(*) FROM public.site_brand_releases)
    ),
    'states', jsonb_build_object(
      'verifiedClaims', (SELECT count(*) FROM public.domain_claims WHERE claim_status = 'verified'),
      'dnsOwnershipVerified', (SELECT count(*) FROM public.domain_hostnames WHERE ownership_status = 'verified'),
      'dnsRoutingVerified', (SELECT count(*) FROM public.domain_hostnames WHERE routing_status = 'verified'),
      'tlsIssued', (SELECT count(*) FROM public.domain_hostnames WHERE tls_status = 'issued'),
      'httpsPassed', (SELECT count(*) FROM public.domain_hostnames WHERE https_status = 'passed'),
      'previewReady', (SELECT count(*) FROM public.domain_hostnames WHERE lifecycle_status = 'preview_ready'),
      'published', (SELECT count(*) FROM public.domain_hostnames WHERE lifecycle_status = 'published')
    ),
    'runtimeBoundary', jsonb_build_object(
      'dnsResolverConnected', false,
      'tlsIssuerConnected', false,
      'httpsProbeWorkerConnected', false,
      'gatewayConnectorConnected', false,
      'trustedHostResolutionConnected', false,
      'unknownHostHardRejectActive', false,
      'unknownHostObservedStatus', NULL,
      'unknownHostRequiredStatus', 421,
      'brandRuntimeBindingConnected', false,
      'externalCallsEnabled', false
    ),
    'hostnames', v_hostnames
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_domain_ascii_hostname(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_reserved_domain_ascii_hostname(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_domain_site_tenant_consistency() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_domain_release_evidence_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_domain_tls_brand_release_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_domain_tls_brand_release_status() TO service_role;

COMMENT ON TABLE public.domain_claims IS 'IDNA-normalized ownership claims. Raw verification tokens are never stored.';
COMMENT ON TABLE public.domain_hostnames IS 'Domain lifecycle facts only. Phase one cannot activate Host routing.';
COMMENT ON TABLE public.domain_verification_attempts IS 'Append-only DNS evidence; no resolver is connected in phase one.';
COMMENT ON TABLE public.domain_tls_probes IS 'Append-only TLS/HTTPS evidence; no external probe worker is connected in phase one.';
COMMENT ON TABLE public.domain_brand_release_bindings IS 'Brand-release binding plans; runtime activation is blocked in phase one.';
COMMENT ON TABLE public.domain_release_audits IS 'Append-only domain release audit facts.';

NOTIFY pgrst, 'reload schema';
COMMIT;
