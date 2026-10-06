export const MULTITENANT_BOUNDARY_SCHEMA_VERSION = 1 as const;

const STABLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type TenantBoundaryState = "unavailable" | "partial" | "verified";
export type TenantDomainKey = "users" | "sessions" | "orders" | "messages" | "assets" | "announcements" | "brand" | "site" | "host";
export type TenantIntegrationStatus = "unintegrated" | "partial" | "integrated";

export interface TenantRecord {
  tenantKey: string;
  displayName: string;
  lifecycleStatus: "foundation_only" | "active" | "suspended" | "archived";
  operatingMode: "single_tenant" | "multi_tenant";
  boundaryStatus: TenantBoundaryState;
  statusReason: string;
  sessionClaimStatus: "unavailable" | "configured" | "verified";
  businessReadScopeStatus: TenantBoundaryState;
  businessWriteScopeStatus: TenantBoundaryState;
  crossTenantTestStatus: "not_run" | "passed" | "failed";
  isolationVerifiedAt: string | null;
  isolationEvidenceUri: string | null;
  isolationEvidenceSha256: string | null;
  revision: number;
  updatedAt: string;
}

export interface TenantMemberSummary {
  membershipId: string;
  tenantKey: string;
  roleKey: string;
  membershipStatus: "invited" | "active" | "suspended" | "revoked";
  identityLinkStatus: "unavailable" | "recorded" | "verified" | "failed";
  joinedAt: string | null;
  createdAt: string;
}

export interface TenantSiteRecord {
  siteKey: string;
  tenantKey: string;
  displayName: string;
  lifecycleStatus: "foundation_only" | "active" | "suspended" | "archived";
  isDefault: boolean;
  routingStatus: "unavailable" | "configured" | "verified" | "failed";
  brandScopeStatus: "unavailable" | "linked" | "verified" | "failed";
  statusReason: string;
  routingVerifiedAt: string | null;
  revision: number;
  updatedAt: string;
}

export interface SiteHostnameRecord {
  hostname: string;
  siteKey: string;
  tenantKey: string;
  hostnameKind: "canonical" | "custom";
  verificationStatus: "unavailable" | "claimed" | "verified" | "failed" | "revoked";
  routingCandidateOnly: true;
  authorizationEligible: false;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface SiteBrandReleaseRecord {
  releaseId: string;
  tenantKey: string;
  siteKey: string;
  brandProfileKey: string | null;
  externalRevisionId: string | null;
  releaseStatus: "unlinked" | "draft" | "published" | "retired" | "failed";
  sourceSystem: string;
  publishedAt: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  updatedAt: string;
}

export interface TenantResourceIntegrationRecord {
  resourceKey: string;
  domainKey: TenantDomainKey;
  sourceKind: "table" | "route" | "runtime" | "claim";
  sourceRef: string;
  tenantScopeStatus: "absent" | "present_unbound" | "verified";
  siteScopeRequirement: "undecided" | "required" | "not_required";
  siteScopeStatus: "absent" | "present_unbound" | "verified" | "not_required";
  tenantColumn: string | null;
  siteColumn: string | null;
  readScopeStatus: TenantBoundaryState;
  writeScopeStatus: TenantBoundaryState;
  databasePolicyStatus: "unavailable" | "service_only" | "tenant_rls_verified";
  sessionClaimStatus: "unavailable" | "configured" | "verified";
  crossTenantTestStatus: "not_run" | "passed" | "failed";
  integrationStatus: TenantIntegrationStatus;
  statusReason: string;
  verifiedAt: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  sourceEvidence: Array<Record<string, unknown>>;
  revision: number;
  updatedAt: string;
}

export interface TenantIsolationReceiptRecord {
  receiptId: string;
  tenantAKey: string;
  tenantBKey: string;
  testScope: string;
  receiptStatus: "unavailable" | "planned" | "passed" | "failed" | "expired";
  crossTenantReadRejected: boolean | null;
  crossTenantWriteRejected: boolean | null;
  zeroDataLeakage: boolean | null;
  testedAt: string | null;
  expiresAt: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  createdAt: string;
}

export interface TenantAuditSummary {
  auditId: string;
  tenantKey: string | null;
  siteKey: string | null;
  actionKey: string;
  result: "info" | "allowed" | "denied" | "unavailable" | "failed";
  reasonCode: string;
  resourceType: string;
  resourceId: string | null;
  happenedAt: string;
}

export interface TenantBoundaryIssue {
  code: string;
  severity: "warning" | "error";
  subject: string;
  message: string;
}

export const TENANT_DOMAIN_KEYS = Object.freeze([
  "users", "sessions", "orders", "messages", "assets", "announcements", "brand", "site", "host",
] as const);

export const TENANT_RESOURCE_DEFINITIONS = Object.freeze([
  { resourceKey: "users-table", domainKey: "users", sourceRef: "public.users" },
  { resourceKey: "auth-sessions-table", domainKey: "sessions", sourceRef: "public.user_auth_sessions" },
  { resourceKey: "payment-orders-table", domainKey: "orders", sourceRef: "public.payment_orders" },
  { resourceKey: "conversation-messages-table", domainKey: "messages", sourceRef: "public.conversation_messages" },
  { resourceKey: "user-notifications-table", domainKey: "messages", sourceRef: "public.user_notifications" },
  { resourceKey: "unified-messaging-campaigns-table", domainKey: "messages", sourceRef: "public.message_campaigns" },
  { resourceKey: "user-files-table", domainKey: "assets", sourceRef: "public.user_files" },
  { resourceKey: "announcements-table", domainKey: "announcements", sourceRef: "public.announcements" },
  { resourceKey: "platform-brand-profile", domainKey: "brand", sourceRef: "public.platform_brand_profiles/default" },
  { resourceKey: "site-config-route", domainKey: "site", sourceRef: "/api/site-config" },
  { resourceKey: "public-branding-route", domainKey: "brand", sourceRef: "/api/branding" },
  { resourceKey: "proxy-host-runtime", domainKey: "host", sourceRef: "src/proxy.ts" },
  { resourceKey: "auth-routes", domainKey: "sessions", sourceRef: "/api/auth/*" },
  { resourceKey: "order-routes", domainKey: "orders", sourceRef: "/api/payment/*,/api/admin/payment-orders" },
  { resourceKey: "message-routes", domainKey: "messages", sourceRef: "/api/notifications/*,/api/conversations/*" },
  { resourceKey: "asset-routes", domainKey: "assets", sourceRef: "/api/user/assets,/api/media-history/*" },
  { resourceKey: "announcement-routes", domainKey: "announcements", sourceRef: "/api/announcements/*" },
  { resourceKey: "brand-admin-routes", domainKey: "brand", sourceRef: "/api/admin/branding/*" },
] as const satisfies readonly { resourceKey: string; domainKey: TenantDomainKey; sourceRef: string }[]);

export const MULTITENANT_FOUNDATION_BOUNDARY = Object.freeze({
  currentMode: "single_tenant" as const,
  legacyRowsAttachedToDefaultTenant: false as const,
  tenantAwareBusinessWritesEnabled: false as const,
  tenantSessionClaimVerified: false as const,
  hostBasedAuthorizationEnabled: false as const,
  crossTenantIsolationVerified: false as const,
});

export const MULTITENANT_SCOPE_POLICY = Object.freeze({
  inventoryMeaning: "audited_authoritative_sources_and_route_families" as const,
  unregisteredLegacyTableStatus: "unintegrated" as const,
  unregisteredLegacyRouteStatus: "unintegrated" as const,
  unregisteredWritePathStatus: "unavailable" as const,
  hostTextMayAuthorizeTenant: false as const,
});

export function isStableTenantKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 100
    && STABLE_KEY_PATTERN.test(value);
}

function validSha256(value: string | null): boolean {
  return Boolean(value && SHA256_PATTERN.test(value));
}

function validIntegratedResource(resource: TenantResourceIntegrationRecord): boolean {
  const validSiteScope = resource.siteScopeRequirement === "required"
    ? resource.siteScopeStatus === "verified" && Boolean(resource.siteColumn)
    : resource.siteScopeRequirement === "not_required" && resource.siteScopeStatus === "not_required";
  return resource.integrationStatus === "integrated"
    && resource.tenantScopeStatus === "verified"
    && Boolean(resource.tenantColumn)
    && validSiteScope
    && resource.readScopeStatus === "verified"
    && resource.writeScopeStatus === "verified"
    && resource.databasePolicyStatus === "tenant_rls_verified"
    && resource.sessionClaimStatus === "verified"
    && resource.crossTenantTestStatus === "passed"
    && Boolean(resource.verifiedAt && resource.evidenceUri)
    && validSha256(resource.evidenceSha256);
}

function validIsolationReceipt(receipt: TenantIsolationReceiptRecord): boolean {
  return receipt.receiptStatus === "passed"
    && receipt.tenantAKey !== receipt.tenantBKey
    && receipt.crossTenantReadRejected === true
    && receipt.crossTenantWriteRejected === true
    && receipt.zeroDataLeakage === true
    && Boolean(receipt.testedAt && receipt.evidenceUri)
    && validSha256(receipt.evidenceSha256);
}

export function inspectMultitenantBoundary(input: {
  tenants: readonly TenantRecord[];
  members: readonly TenantMemberSummary[];
  sites: readonly TenantSiteRecord[];
  hostnames: readonly SiteHostnameRecord[];
  brandReleases: readonly SiteBrandReleaseRecord[];
  resources: readonly TenantResourceIntegrationRecord[];
  isolationReceipts: readonly TenantIsolationReceiptRecord[];
  audits: readonly TenantAuditSummary[];
}) {
  const issues: TenantBoundaryIssue[] = [];
  const resourcesByKey = new Map<string, TenantResourceIntegrationRecord[]>();
  for (const resource of input.resources) {
    resourcesByKey.set(resource.resourceKey, [...(resourcesByKey.get(resource.resourceKey) || []), resource]);
    if (!isStableTenantKey(resource.resourceKey)) {
      issues.push({ code: "TENANT_RESOURCE_KEY_INVALID", severity: "error", subject: resource.resourceKey, message: "租户接入资源 key 不稳定。" });
    }
  }

  const registeredKeys = new Set<string>();
  const integratedKeys = new Set<string>();
  for (const expected of TENANT_RESOURCE_DEFINITIONS) {
    const matches = resourcesByKey.get(expected.resourceKey) || [];
    if (matches.length !== 1) {
      issues.push({
        code: matches.length === 0 ? "TENANT_RESOURCE_MISSING" : "TENANT_RESOURCE_DUPLICATED",
        severity: "error",
        subject: expected.resourceKey,
        message: matches.length === 0 ? "审计范围缺少该资源。" : "审计范围出现重复资源 key。",
      });
      continue;
    }
    const resource = matches[0];
    registeredKeys.add(resource.resourceKey);
    if (resource.domainKey !== expected.domainKey || resource.sourceRef !== expected.sourceRef) {
      issues.push({ code: "TENANT_RESOURCE_IDENTITY_MISMATCH", severity: "error", subject: resource.resourceKey, message: "资源稳定身份与合同不一致。" });
    }
    if (validIntegratedResource(resource)) {
      integratedKeys.add(resource.resourceKey);
    } else {
      issues.push({
        code: "TENANT_RESOURCE_UNINTEGRATED",
        severity: "warning",
        subject: resource.resourceKey,
        message: "该表、路由或运行时尚无完整租户 claim、读写传播、租户 RLS 和跨租户拒绝回执。",
      });
    }
  }

  const defaultTenants = input.tenants.filter((tenant) => tenant.tenantKey === "default");
  const defaultSites = input.sites.filter((site) => site.siteKey === "default" && site.tenantKey === "default" && site.isDefault);
  if (defaultTenants.length !== 1) {
    issues.push({ code: "DEFAULT_TENANT_FACT_INVALID", severity: "error", subject: "default", message: "当前单租户事实行缺失或重复。" });
  }
  if (defaultSites.length !== 1) {
    issues.push({ code: "DEFAULT_SITE_FACT_INVALID", severity: "error", subject: "default", message: "当前默认站点事实行缺失或重复。" });
  }

  const verifiedTenantKeys = new Set(input.tenants.filter((tenant) => (
    tenant.operatingMode === "multi_tenant"
    && tenant.boundaryStatus === "verified"
    && tenant.sessionClaimStatus === "verified"
    && tenant.businessReadScopeStatus === "verified"
    && tenant.businessWriteScopeStatus === "verified"
    && tenant.crossTenantTestStatus === "passed"
    && Boolean(tenant.isolationVerifiedAt && tenant.isolationEvidenceUri)
    && validSha256(tenant.isolationEvidenceSha256)
  )).map((tenant) => tenant.tenantKey));
  const validReceipts = input.isolationReceipts.filter(validIsolationReceipt);
  const hasVerifiedTenantPair = validReceipts.some((receipt) => (
    verifiedTenantKeys.has(receipt.tenantAKey) && verifiedTenantKeys.has(receipt.tenantBKey)
  ));

  const verifiedHostnames = input.hostnames.filter((hostname) => hostname.verificationStatus === "verified");
  const authorizationEligibleHosts = input.hostnames.filter((hostname) => hostname.authorizationEligible);
  if (authorizationEligibleHosts.length > 0) {
    issues.push({ code: "HOST_AUTHORIZATION_BOUNDARY_VIOLATED", severity: "error", subject: "site_hostnames", message: "Host 文本不得直接成为租户授权依据。" });
  }

  const publishedBrandReleases = input.brandReleases.filter((release) => (
    release.releaseStatus === "published"
    && Boolean(release.brandProfileKey && release.externalRevisionId && release.publishedAt && release.evidenceUri)
    && validSha256(release.evidenceSha256)
  ));
  const hasHardFailure = issues.some((issue) => issue.severity === "error");
  const fullyIntegrated = integratedKeys.size === TENANT_RESOURCE_DEFINITIONS.length;
  const boundaryState: TenantBoundaryState = !hasHardFailure
    && fullyIntegrated
    && verifiedTenantKeys.size >= 2
    && hasVerifiedTenantPair
    ? "verified"
    : integratedKeys.size > 0 || verifiedTenantKeys.size > 0 || validReceipts.length > 0
      ? "partial"
      : "unavailable";

  if (boundaryState !== "verified") {
    issues.push({
      code: "CROSS_TENANT_ISOLATION_UNAVAILABLE",
      severity: "warning",
      subject: "control_plane",
      message: "当前仍是单租户基础状态，没有两租户并发读写拒绝和零泄漏回执。",
    });
  }

  const domainCoverage = Object.fromEntries(TENANT_DOMAIN_KEYS.map((domainKey) => {
    const expected = TENANT_RESOURCE_DEFINITIONS.filter((resource) => resource.domainKey === domainKey);
    return [domainKey, {
      expected: expected.length,
      registered: expected.filter((resource) => registeredKeys.has(resource.resourceKey)).length,
      integrated: expected.filter((resource) => integratedKeys.has(resource.resourceKey)).length,
    }];
  })) as Record<TenantDomainKey, { expected: number; registered: number; integrated: number }>;

  return {
    boundaryState,
    operatingMode: boundaryState === "verified" ? "multi_tenant" as const : "single_tenant" as const,
    truths: {
      currentSingleTenant: boundaryState !== "verified",
      legacyRowsAttachedToDefaultTenant: false,
      tenantAwareBusinessWritesEnabled: fullyIntegrated && boundaryState === "verified",
      tenantSessionClaimVerified: boundaryState === "verified",
      hostBasedAuthorizationEnabled: false,
      crossTenantIsolationVerified: boundaryState === "verified",
    },
    coverage: {
      tenants: { registered: input.tenants.length, verified: verifiedTenantKeys.size, minimumForIsolation: 2 },
      sites: { registered: input.sites.length, routingVerified: input.sites.filter((site) => site.routingStatus === "verified").length },
      resources: { expected: TENANT_RESOURCE_DEFINITIONS.length, registered: registeredKeys.size, integrated: integratedKeys.size },
      domains: domainCoverage,
      members: { recorded: input.members.length, active: input.members.filter((member) => member.membershipStatus === "active" && member.identityLinkStatus === "verified").length },
      hostnames: { recorded: input.hostnames.length, verifiedRoutingCandidates: verifiedHostnames.length, authorizationEligible: 0 },
      brandReleases: { recorded: input.brandReleases.length, publishedWithEvidence: publishedBrandReleases.length },
      isolationReceipts: { recorded: input.isolationReceipts.length, passed: validReceipts.length, verifiedTenantPair: hasVerifiedTenantPair },
      audits: { recorded: input.audits.length },
    },
    issues,
  };
}
