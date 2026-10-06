import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MULTITENANT_FOUNDATION_BOUNDARY,
  MULTITENANT_SCOPE_POLICY,
  TENANT_DOMAIN_KEYS,
  TENANT_RESOURCE_DEFINITIONS,
  inspectMultitenantBoundary,
  isStableTenantKey,
  type TenantIsolationReceiptRecord,
  type TenantRecord,
  type TenantResourceIntegrationRecord,
  type TenantSiteRecord,
} from "../src/lib/multitenant-boundary-domain";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const migration = read("supabase/migrations/20261002200000_multitenant_brand_boundary.sql");
const rollback = read("supabase/rollbacks/20261002200000_multitenant_brand_boundary.rollback.sql");
const route = read("src/app/api/admin/multitenant-boundary/route.ts");
const server = read("src/lib/server/multitenant-boundary.ts");
const baseline = read("deploy/local/task-baseline.sql");
const sessionMigration = read("supabase/migrations/20260927103000_user_auth_sessions_two_device_limit.sql");
const brandMigration = read("supabase/migrations/20261002120000_platform_brand_control_plane.sql");
const messagingMigration = read("supabase/migrations/20261002150000_unified_messaging_control_plane.sql");
const proxy = read("src/proxy.ts");

const SHA = "a".repeat(64);

function baselineTenant(): TenantRecord {
  return {
    tenantKey: "default",
    displayName: "当前单站点平台",
    lifecycleStatus: "foundation_only",
    operatingMode: "single_tenant",
    boundaryStatus: "unavailable",
    statusReason: "CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED",
    sessionClaimStatus: "unavailable",
    businessReadScopeStatus: "unavailable",
    businessWriteScopeStatus: "unavailable",
    crossTenantTestStatus: "not_run",
    isolationVerifiedAt: null,
    isolationEvidenceUri: null,
    isolationEvidenceSha256: null,
    revision: 1,
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

function baselineSite(): TenantSiteRecord {
  return {
    siteKey: "default",
    tenantKey: "default",
    displayName: "当前默认站点",
    lifecycleStatus: "foundation_only",
    isDefault: true,
    routingStatus: "unavailable",
    brandScopeStatus: "unavailable",
    statusReason: "STATIC_SINGLE_SITE_ONLY",
    routingVerifiedAt: null,
    revision: 1,
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

function resource(definition: typeof TENANT_RESOURCE_DEFINITIONS[number]): TenantResourceIntegrationRecord {
  return {
    resourceKey: definition.resourceKey,
    domainKey: definition.domainKey,
    sourceKind: definition.resourceKey.endsWith("table") ? "table" : "route",
    sourceRef: definition.sourceRef,
    tenantScopeStatus: "absent",
    siteScopeRequirement: "undecided",
    siteScopeStatus: "absent",
    tenantColumn: null,
    siteColumn: null,
    readScopeStatus: "unavailable",
    writeScopeStatus: "unavailable",
    databasePolicyStatus: "unavailable",
    sessionClaimStatus: "unavailable",
    crossTenantTestStatus: "not_run",
    integrationStatus: "unintegrated",
    statusReason: "TENANT_CONTEXT_PROPAGATION_ABSENT",
    verifiedAt: null,
    evidenceUri: null,
    evidenceSha256: null,
    sourceEvidence: [],
    revision: 1,
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
}

function integratedResource(definition: typeof TENANT_RESOURCE_DEFINITIONS[number]): TenantResourceIntegrationRecord {
  return {
    ...resource(definition),
    tenantScopeStatus: "verified",
    siteScopeRequirement: "required",
    siteScopeStatus: "verified",
    tenantColumn: "tenant_id",
    siteColumn: "site_id",
    readScopeStatus: "verified",
    writeScopeStatus: "verified",
    databasePolicyStatus: "tenant_rls_verified",
    sessionClaimStatus: "verified",
    crossTenantTestStatus: "passed",
    integrationStatus: "integrated",
    statusReason: "VERIFIED",
    verifiedAt: "2026-10-02T00:00:00.000Z",
    evidenceUri: "evidence://resource",
    evidenceSha256: SHA,
  };
}

function verifiedTenant(tenantKey: string): TenantRecord {
  return {
    ...baselineTenant(),
    tenantKey,
    displayName: tenantKey,
    lifecycleStatus: "active",
    operatingMode: "multi_tenant",
    boundaryStatus: "verified",
    statusReason: "VERIFIED",
    sessionClaimStatus: "verified",
    businessReadScopeStatus: "verified",
    businessWriteScopeStatus: "verified",
    crossTenantTestStatus: "passed",
    isolationVerifiedAt: "2026-10-02T00:00:00.000Z",
    isolationEvidenceUri: "evidence://tenant",
    isolationEvidenceSha256: SHA,
  };
}

const emptyRelations = { members: [], hostnames: [], brandReleases: [], audits: [] } as const;
const baselineInspection = inspectMultitenantBoundary({
  tenants: [baselineTenant()],
  sites: [baselineSite()],
  resources: TENANT_RESOURCE_DEFINITIONS.map(resource),
  isolationReceipts: [],
  ...emptyRelations,
});
assert.equal(baselineInspection.boundaryState, "unavailable");
assert.equal(baselineInspection.operatingMode, "single_tenant");
assert.equal(baselineInspection.truths.currentSingleTenant, true);
assert.equal(baselineInspection.truths.legacyRowsAttachedToDefaultTenant, false);
assert.equal(baselineInspection.truths.hostBasedAuthorizationEnabled, false);
assert.equal(baselineInspection.truths.crossTenantIsolationVerified, false);
assert.equal(baselineInspection.coverage.resources.expected, 18);
assert.equal(baselineInspection.coverage.resources.registered, 18);
assert.equal(baselineInspection.coverage.resources.integrated, 0);
assert.ok(baselineInspection.issues.some((issue) => issue.code === "CROSS_TENANT_ISOLATION_UNAVAILABLE"));
assert.deepEqual(MULTITENANT_FOUNDATION_BOUNDARY, {
  currentMode: "single_tenant",
  legacyRowsAttachedToDefaultTenant: false,
  tenantAwareBusinessWritesEnabled: false,
  tenantSessionClaimVerified: false,
  hostBasedAuthorizationEnabled: false,
  crossTenantIsolationVerified: false,
});
assert.deepEqual(MULTITENANT_SCOPE_POLICY, {
  inventoryMeaning: "audited_authoritative_sources_and_route_families",
  unregisteredLegacyTableStatus: "unintegrated",
  unregisteredLegacyRouteStatus: "unintegrated",
  unregisteredWritePathStatus: "unavailable",
  hostTextMayAuthorizeTenant: false,
});
assert.deepEqual([...TENANT_DOMAIN_KEYS], ["users", "sessions", "orders", "messages", "assets", "announcements", "brand", "site", "host"]);
assert.equal(new Set(TENANT_RESOURCE_DEFINITIONS.map((item) => item.resourceKey)).size, TENANT_RESOURCE_DEFINITIONS.length);
assert.ok(TENANT_RESOURCE_DEFINITIONS.every((item) => isStableTenantKey(item.resourceKey)));
assert.equal(isStableTenantKey("Bad/Key"), false);

const partialResources = TENANT_RESOURCE_DEFINITIONS.map(resource);
partialResources[0] = { ...partialResources[0], tenantScopeStatus: "present_unbound", integrationStatus: "partial" };
const partialInspection = inspectMultitenantBoundary({
  tenants: [baselineTenant()], sites: [baselineSite()], resources: partialResources, isolationReceipts: [], ...emptyRelations,
});
assert.equal(partialInspection.boundaryState, "unavailable", "an unbound tenant column must not count as isolation progress");
assert.equal(partialInspection.coverage.resources.integrated, 0);

const receipt: TenantIsolationReceiptRecord = {
  receiptId: "11111111-1111-4111-8111-111111111111",
  tenantAKey: "tenant-a",
  tenantBKey: "tenant-b",
  testScope: "all expected resources",
  receiptStatus: "passed",
  crossTenantReadRejected: true,
  crossTenantWriteRejected: true,
  zeroDataLeakage: true,
  testedAt: "2026-10-02T00:00:00.000Z",
  expiresAt: null,
  evidenceUri: "evidence://isolation",
  evidenceSha256: SHA,
  createdAt: "2026-10-02T00:00:00.000Z",
};
const verifiedInspection = inspectMultitenantBoundary({
  tenants: [baselineTenant(), verifiedTenant("tenant-a"), verifiedTenant("tenant-b")],
  sites: [baselineSite()],
  resources: TENANT_RESOURCE_DEFINITIONS.map(integratedResource),
  isolationReceipts: [receipt],
  ...emptyRelations,
});
assert.equal(verifiedInspection.boundaryState, "verified");
assert.equal(verifiedInspection.operatingMode, "multi_tenant");
assert.equal(verifiedInspection.truths.crossTenantIsolationVerified, true);

for (const table of ["tenants", "tenant_members", "sites", "site_hostnames", "site_brand_releases", "tenant_resource_integrations", "tenant_isolation_receipts", "tenant_audits"]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`));
  assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated, service_role`));
  assert.match(migration, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO service_role`));
  assert.doesNotMatch(migration, new RegExp(`GRANT (?:INSERT|UPDATE|DELETE|SELECT, INSERT).*public\\.${table} TO service_role`));
  assert.match(rollback, new RegExp(`DROP TABLE public\\.${table}`));
}
assert.match(migration, /authorization_eligible boolean NOT NULL DEFAULT false CHECK \(authorization_eligible IS FALSE\)/u);
assert.match(migration, /routing_candidate_only boolean NOT NULL DEFAULT true CHECK \(routing_candidate_only IS TRUE\)/u);
assert.match(migration, /UNIQUE \(tenant_key, site_key\)/u);
assert.equal((migration.match(/FOREIGN KEY \(tenant_key, site_key\) REFERENCES public\.sites\(tenant_key, site_key\)/gu) || []).length, 3);
assert.match(migration, /legacyRowsAttached":false/u);
assert.match(migration, /CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED/u);
assert.match(migration, /ON CONFLICT \(resource_key\) DO NOTHING/u);
assert.match(migration, /CREATE TRIGGER tenant_audits_immutable/u);
assert.match(migration, /CREATE TRIGGER tenant_resource_integrations_revision_bump/u);
assert.match(rollback, /MULTITENANT_ROLLBACK_REFUSED_EVIDENCE_EXISTS/u);
assert.match(rollback, /MULTITENANT_ROLLBACK_REFUSED_INTEGRATION_EVIDENCE_EXISTS/u);
assert.doesNotMatch(migration, /ALTER TABLE public\.(?:users|user_auth_sessions|payment_orders|user_files|announcements|conversation_messages)\s+ADD/iu);
assert.doesNotMatch(migration, /INSERT INTO public\.(?:users|user_auth_sessions|payment_orders|user_files|announcements|conversation_messages)/iu);

assert.match(route, /export async function GET/u);
assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
assert.match(route, /authorizeAdminCapability\(request, "white_label\.manage"/u);
assert.match(route, /snapshot\.migrationRequired \? 503 : 200/u);
assert.match(route, /Vary: "Authorization, Cookie"/u);
assert.match(server, /phase: "foundation_status_only"/u);
assert.match(server, /scopePolicy: MULTITENANT_SCOPE_POLICY/u);
assert.match(server, /legacyRowMutations: 0/u);
assert.match(server, /businessWrites: 0/u);
assert.match(server, /hostAuthorizationDecisions: 0/u);
assert.match(server, /未回退为静态成功或伪造租户状态/u);

function tableBlock(sql: string, tableName: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE public\\."${tableName}" \\([\\s\\S]*?\\n\\);`, "u"));
  assert.ok(match, `missing baseline table ${tableName}`);
  return match[0];
}

for (const table of ["users", "payment_orders", "user_files", "announcements", "conversation_messages"]) {
  const block = tableBlock(baseline, table);
  assert.doesNotMatch(block, /\btenant_id\b|\bsite_id\b/u, `${table} must remain reported as unintegrated`);
}
const sessionBlock = sessionMigration.match(/CREATE TABLE IF NOT EXISTS public\.user_auth_sessions \([\s\S]*?\n\);/u)?.[0] || "";
assert.ok(sessionBlock);
assert.doesNotMatch(sessionBlock, /\btenant_id\b|\bsite_id\b/u);
assert.match(brandMigration, /id text PRIMARY KEY CHECK \(id = 'default'\)/u);
assert.match(brandMigration, /platform-brand:default/u);
assert.match(messagingMigration, /CREATE TABLE IF NOT EXISTS public\.message_campaigns/u);
assert.match(messagingMigration, /tenant_key text/u);
assert.match(messagingMigration, /site_key text/u);
assert.doesNotMatch(messagingMigration, /tenant_key text[^\n]*REFERENCES public\.tenants/u);
assert.match(proxy, /request\.headers\.get\("host"\)/u);

process.stdout.write(`${JSON.stringify({
  passed: true,
  schemaVersion: 1,
  expectedResources: TENANT_RESOURCE_DEFINITIONS.length,
  domains: TENANT_DOMAIN_KEYS.length,
  baselineBoundaryState: baselineInspection.boundaryState,
  verifiedFixtureBoundaryState: verifiedInspection.boundaryState,
  staticAudit: {
    currentMode: "single_tenant",
    legacyTablesMutated: false,
    hostAuthorizationEnabled: false,
    migrationApplied: false,
  },
}, null, 2)}\n`);
