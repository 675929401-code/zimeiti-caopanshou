import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DOMAIN_RELEASE_MIGRATION,
  DomainReleaseError,
  isReservedDomainHostname,
  normalizeDomainClaim,
  normalizeDomainReleaseDatabaseStatus,
} from "../src/lib/domain-tls-brand-release-control-plane";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20261002210000_domain_tls_brand_release_control_plane.sql"),
  "utf8",
);
const rollback = readFileSync(
  resolve(root, "supabase/rollbacks/20261002210000_domain_tls_brand_release_control_plane.rollback.sql"),
  "utf8",
);
const domain = readFileSync(resolve(root, "src/lib/domain-tls-brand-release-control-plane.ts"), "utf8");
const server = readFileSync(resolve(root, "src/lib/server/domain-tls-brand-release-control-plane.ts"), "utf8");
const route = readFileSync(resolve(root, "src/app/api/admin/domain-release/status/route.ts"), "utf8");
const audit = readFileSync(resolve(root, "scripts/audit-domain-tls-brand-sources-readonly.mjs"), "utf8");
const verifier = readFileSync(resolve(root, "scripts/verify-domain-tls-brand-release-control-plane-local.mjs"), "utf8");

const tables = [
  "domain_claims",
  "domain_hostnames",
  "domain_verification_attempts",
  "domain_tls_probes",
  "domain_brand_release_bindings",
  "domain_release_audits",
] as const;

test("migration creates a private six-table evidence foundation", () => {
  assert.match(migration, /^BEGIN;/u);
  assert.match(migration, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS public.${table}`), `missing ${table}`);
    assert.ok(migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`), `RLS missing ${table}`);
    assert.ok(
      migration.includes(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role`),
      `direct access revoke missing ${table}`,
    );
  }
  assert.doesNotMatch(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /DOMAIN_RELEASE_EVIDENCE_IMMUTABLE/u);
});

test("IDNA normalization is strict and canonical", () => {
  const normalized = normalizeDomainClaim("BÜCHER.Codex-Boundary.Dev.");
  assert.equal(normalized.asciiHostname, "xn--bcher-kva.codex-boundary.dev");
  assert.equal(normalized.unicodeHostname, "bücher.codex-boundary.dev");
  assert.equal(
    normalized.expectedTxtName,
    "_zimeiti-domain-verification.xn--bcher-kva.codex-boundary.dev",
  );
  assert.equal(normalized.normalizationVersion, "node.domainToASCII.v1");
  for (const invalid of [
    "",
    "https://example.dev",
    "*.example.dev",
    "name@example.dev",
    "example.dev:443",
    "127.0.0.1",
    "bad_name.example.dev",
    "bad..example.dev",
    "example.123",
  ]) {
    assert.throws(
      () => normalizeDomainClaim(invalid),
      (error: unknown) => error instanceof DomainReleaseError,
      invalid,
    );
  }
});

test("reserved and duplicate domain boundaries are enforced before runtime routing", () => {
  for (const reserved of [
    "localhost",
    "child.localhost",
    "example.com",
    "child.example.net",
    "tenant.test",
    "service.internal",
    "hidden.onion",
    "reverse.arpa",
  ]) {
    assert.equal(isReservedDomainHostname(reserved), true, reserved);
    assert.throws(
      () => normalizeDomainClaim(reserved),
      (error: unknown) => error instanceof DomainReleaseError
        && error.code === "DOMAIN_HOSTNAME_RESERVED",
    );
  }
  assert.match(migration, /ascii_hostname text NOT NULL UNIQUE/u);
  assert.match(migration, /claim_id uuid NOT NULL UNIQUE/u);
  assert.match(migration, /domain_claim_not_reserved/u);
  assert.match(migration, /domain_hostname_not_reserved/u);
  assert.match(migration, /DOMAIN_HOSTNAME_EXISTING_SCOPE_CONFLICT/u);
  assert.match(verifier, /DUPLICATE_DOMAIN_MUST_FAIL/u);
  assert.match(verifier, /RESERVED_DOMAIN_MUST_FAIL/u);
  assert.match(verifier, /CROSS_SOURCE_DOMAIN_SCOPE_CONFLICT_MUST_FAIL/u);
});

test("DNS and TLS evidence default to unavailable with null observations", () => {
  assert.match(migration, /attempt_status text NOT NULL DEFAULT 'unavailable'/u);
  assert.match(migration, /probe_status text NOT NULL DEFAULT 'unavailable'/u);
  assert.match(migration, /domain_verification_unavailable_null/u);
  assert.match(migration, /domain_tls_probe_unavailable_null/u);
  assert.match(migration, /observed_values_hash IS NULL.*resolver_name IS NULL.*attempted_at IS NULL/su);
  assert.match(migration, /certificate_fingerprint_sha256 IS NULL.*http_status IS NULL.*attempted_at IS NULL/su);
});

test("phase one cannot activate Host routing or publish a domain brand binding", () => {
  assert.match(migration, /routing_activation_enabled boolean NOT NULL DEFAULT false CHECK \(routing_activation_enabled IS FALSE\)/u);
  assert.match(migration, /domain_hostname_phase_one_activation_block/u);
  assert.match(migration, /runtime_activation_enabled boolean NOT NULL DEFAULT false CHECK \(runtime_activation_enabled IS FALSE\)/u);
  assert.match(migration, /domain_brand_phase_one_activation_block/u);
  assert.match(verifier, /HOST_RUNTIME_ACTIVATION_MUST_FAIL/u);
  assert.match(verifier, /BRAND_RUNTIME_ACTIVATION_MUST_FAIL/u);
  assert.doesNotMatch(server + route, /dns\.resolve|tls\.connect|https?\.request|fetch\(|child_process|cloudflare/iu);
});

test("status API is authenticated, read-only, and honest about unknown Host enforcement", () => {
  assert.match(route, /export async function GET/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.match(route, /authorizeAdminCapability\(request, "platform\.settings\.manage"/u);
  assert.match(route, /authorizeAdminCapability\(request, "security\.view"/u);
  assert.match(route, /readDomainTlsBrandReleaseStatus/u);
  assert.match(server, /enforcementActive: false/u);
  assert.match(server, /requiredStatus: 421/u);
  assert.match(server, /observedStatus: null/u);
  assert.match(server, /realDomainVerificationRun: false/u);
  assert.match(server, /formalDomainChanged: false/u);
});

test("status normalization refuses to turn policy targets into current facts", () => {
  const status = normalizeDomainReleaseDatabaseStatus({
    schemaVersion: 1,
    migration: DOMAIN_RELEASE_MIGRATION,
    asOf: "2026-10-02T12:00:00.000Z",
    tableCounts: { claims: 1 },
    runtimeBoundary: {
      trustedHostResolutionConnected: true,
      unknownHostHardRejectActive: true,
      unknownHostObservedStatus: 421,
      externalCallsEnabled: true,
    },
    hostnames: [{
      hostname: "tenant.codex-boundary.dev",
      tenantKey: "default",
      siteKey: "default",
      lifecycleStatus: "claimed",
      ownershipStatus: "unavailable",
      routingStatus: "unavailable",
      tlsStatus: "unavailable",
      httpsStatus: "unavailable",
      gatewayConnectorStatus: "unavailable",
      routingActivationEnabled: true,
      certificateNotAfter: null,
      asOf: null,
    }],
  });
  assert.equal(status.runtimeBoundary.trustedHostResolutionConnected, false);
  assert.equal(status.runtimeBoundary.unknownHostHardRejectActive, false);
  assert.equal(status.runtimeBoundary.unknownHostObservedStatus, null);
  assert.equal(status.runtimeBoundary.externalCallsEnabled, false);
  assert.equal(status.hostnames[0].routingActivationEnabled, false);
  assert.equal(status.hostnames[0].certificateNotAfter, null);
});

test("existing runtime and deployment sources remain audit-only dependencies", () => {
  for (const source of [
    "proxy_host_gate",
    "nginx_unknown_host_gate",
    "dns_resolver",
    "tls_issuer",
    "https_probe_worker",
    "gateway_connector",
    "platform_branding",
    "site_config",
  ]) {
    assert.ok(domain.includes(`source: "${source}"`), `missing boundary ${source}`);
  }
  assert.match(audit, /BEGIN READ ONLY/u);
  assert.match(audit, /currentFormalDomainVerifiedByThisAudit: false/u);
  assert.match(audit, /externalCalls: 0/u);
  assert.match(audit, /dnsWrites: 0/u);
  assert.match(audit, /tlsWrites: 0/u);
  assert.match(audit, /gatewayWrites: 0/u);
  assert.match(audit, /formalDomainChanges: 0/u);
});

test("migration only reads task-12 boundaries and does not attach or mutate them", () => {
  const executableSql = migration.replace(/--[^\r\n]*/gu, "");
  for (const table of ["tenants", "sites", "site_hostnames", "site_brand_releases"]) {
    assert.doesNotMatch(
      executableSql,
      new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|ALTER\\s+TABLE)\\s+public\\.${table}`, "iu"),
    );
  }
  assert.match(migration, /REFERENCES public\.tenants/u);
  assert.match(migration, /REFERENCES public\.sites/u);
  assert.match(migration, /REFERENCES public\.site_brand_releases/u);
});

test("rollback refuses to erase evidence and local probe always ends with zero writes", () => {
  assert.match(rollback, /^BEGIN;/u);
  assert.match(rollback, /ROLLBACK_BLOCKED_DOMAIN_RELEASE_EVIDENCE_EXISTS/u);
  assert.match(rollback, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(rollback.includes(`SELECT 1 FROM public.${table}`), `guard missing ${table}`);
    assert.ok(rollback.includes(`DROP TABLE IF EXISTS public.${table}`), `drop missing ${table}`);
  }
  for (const fragment of [
    'runtime.localOnly, true',
    'runtime.ownerConnection?.host, "127.0.0.1"',
    'Number(runtime.ownerConnection?.port), 54322',
    'runtime.ownerConnection?.database, "zimeiti_local"',
    "--confirm-local-domain-tls-brand-release-control-plane",
    'await client.query("BEGIN")',
    'await client.query("ROLLBACK")',
    "persisted: false",
    "persistentFixtures: 0",
    "migrationLedgerWrites: 0",
    "externalCalls: 0",
    "dnsWrites: 0",
    "tlsWrites: 0",
    "gatewayWrites: 0",
    "formalDomainChanges: 0",
    "productionWrites: 0",
  ]) {
    assert.ok(verifier.includes(fragment), `verifier missing ${fragment}`);
  }
});
