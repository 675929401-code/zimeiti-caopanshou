import "server-only";

import {
  MULTITENANT_BOUNDARY_SCHEMA_VERSION,
  MULTITENANT_FOUNDATION_BOUNDARY,
  MULTITENANT_SCOPE_POLICY,
  inspectMultitenantBoundary,
  type SiteBrandReleaseRecord,
  type SiteHostnameRecord,
  type TenantAuditSummary,
  type TenantBoundaryIssue,
  type TenantIsolationReceiptRecord,
  type TenantMemberSummary,
  type TenantRecord,
  type TenantResourceIntegrationRecord,
  type TenantSiteRecord,
} from "@/lib/multitenant-boundary-domain";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseRow = Record<string, unknown>;

export interface AdminMultitenantBoundarySnapshot {
  schemaVersion: typeof MULTITENANT_BOUNDARY_SCHEMA_VERSION;
  generatedAt: string;
  migrationRequired: boolean;
  boundaryState: "unavailable" | "partial" | "verified";
  phase: "foundation_status_only";
  foundationBoundary: typeof MULTITENANT_FOUNDATION_BOUNDARY;
  scopePolicy: typeof MULTITENANT_SCOPE_POLICY;
  tenants: TenantRecord[];
  members: TenantMemberSummary[];
  sites: TenantSiteRecord[];
  hostnames: SiteHostnameRecord[];
  brandReleases: SiteBrandReleaseRecord[];
  resourceIntegrations: TenantResourceIntegrationRecord[];
  isolationReceipts: TenantIsolationReceiptRecord[];
  recentAudits: TenantAuditSummary[];
  consistency: ReturnType<typeof inspectMultitenantBoundary>;
  readOnly: true;
  legacyRowMutations: 0;
  businessWrites: 0;
  hostAuthorizationDecisions: 0;
}

const TENANT_SELECT = [
  "tenant_key", "display_name", "lifecycle_status", "operating_mode", "boundary_status",
  "status_reason", "session_claim_status", "business_read_scope_status",
  "business_write_scope_status", "cross_tenant_test_status", "isolation_verified_at",
  "isolation_evidence_uri", "isolation_evidence_sha256", "revision", "updated_at",
].join(",");

const MEMBER_SELECT = [
  "membership_id", "tenant_key", "role_key", "membership_status", "identity_link_status", "joined_at", "created_at",
].join(",");

const SITE_SELECT = [
  "site_key", "tenant_key", "display_name", "lifecycle_status", "is_default", "routing_status",
  "brand_scope_status", "status_reason", "routing_verified_at", "revision", "updated_at",
].join(",");

const HOSTNAME_SELECT = [
  "hostname", "site_key", "tenant_key", "hostname_kind", "verification_status",
  "routing_candidate_only", "authorization_eligible", "verified_at", "updated_at",
].join(",");

const BRAND_RELEASE_SELECT = [
  "release_id", "tenant_key", "site_key", "brand_profile_key", "external_revision_id",
  "release_status", "source_system", "published_at", "evidence_uri", "evidence_sha256", "updated_at",
].join(",");

const RESOURCE_SELECT = [
  "resource_key", "domain_key", "source_kind", "source_ref", "tenant_scope_status",
  "site_scope_requirement", "site_scope_status", "tenant_column", "site_column",
  "read_scope_status", "write_scope_status", "database_policy_status", "session_claim_status",
  "cross_tenant_test_status", "integration_status", "status_reason", "verified_at", "evidence_uri",
  "evidence_sha256", "source_evidence", "revision", "updated_at",
].join(",");

const RECEIPT_SELECT = [
  "receipt_id", "tenant_a_key", "tenant_b_key", "test_scope", "receipt_status",
  "cross_tenant_read_rejected", "cross_tenant_write_rejected", "zero_data_leakage",
  "tested_at", "expires_at", "evidence_uri", "evidence_sha256", "created_at",
].join(",");

const AUDIT_SELECT = [
  "audit_id", "tenant_key", "site_key", "action_key", "result", "reason_code",
  "resource_type", "resource_id", "happened_at",
].join(",");

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const normalized = text(value).trim();
  return normalized || null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function evidenceArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function tenantFromRow(row: DatabaseRow): TenantRecord {
  return {
    tenantKey: text(row.tenant_key),
    displayName: text(row.display_name),
    lifecycleStatus: row.lifecycle_status === "active" || row.lifecycle_status === "suspended" || row.lifecycle_status === "archived" ? row.lifecycle_status : "foundation_only",
    operatingMode: row.operating_mode === "multi_tenant" ? "multi_tenant" : "single_tenant",
    boundaryStatus: row.boundary_status === "verified" || row.boundary_status === "partial" ? row.boundary_status : "unavailable",
    statusReason: text(row.status_reason),
    sessionClaimStatus: row.session_claim_status === "verified" || row.session_claim_status === "configured" ? row.session_claim_status : "unavailable",
    businessReadScopeStatus: row.business_read_scope_status === "verified" || row.business_read_scope_status === "partial" ? row.business_read_scope_status : "unavailable",
    businessWriteScopeStatus: row.business_write_scope_status === "verified" || row.business_write_scope_status === "partial" ? row.business_write_scope_status : "unavailable",
    crossTenantTestStatus: row.cross_tenant_test_status === "passed" || row.cross_tenant_test_status === "failed" ? row.cross_tenant_test_status : "not_run",
    isolationVerifiedAt: nullableText(row.isolation_verified_at),
    isolationEvidenceUri: nullableText(row.isolation_evidence_uri),
    isolationEvidenceSha256: nullableText(row.isolation_evidence_sha256),
    revision: integer(row.revision, 1),
    updatedAt: text(row.updated_at),
  };
}

function memberFromRow(row: DatabaseRow): TenantMemberSummary {
  return {
    membershipId: text(row.membership_id),
    tenantKey: text(row.tenant_key),
    roleKey: text(row.role_key),
    membershipStatus: row.membership_status === "active" || row.membership_status === "suspended" || row.membership_status === "revoked" ? row.membership_status : "invited",
    identityLinkStatus: row.identity_link_status === "recorded" || row.identity_link_status === "verified" || row.identity_link_status === "failed" ? row.identity_link_status : "unavailable",
    joinedAt: nullableText(row.joined_at),
    createdAt: text(row.created_at),
  };
}

function siteFromRow(row: DatabaseRow): TenantSiteRecord {
  return {
    siteKey: text(row.site_key),
    tenantKey: text(row.tenant_key),
    displayName: text(row.display_name),
    lifecycleStatus: row.lifecycle_status === "active" || row.lifecycle_status === "suspended" || row.lifecycle_status === "archived" ? row.lifecycle_status : "foundation_only",
    isDefault: row.is_default === true,
    routingStatus: row.routing_status === "configured" || row.routing_status === "verified" || row.routing_status === "failed" ? row.routing_status : "unavailable",
    brandScopeStatus: row.brand_scope_status === "linked" || row.brand_scope_status === "verified" || row.brand_scope_status === "failed" ? row.brand_scope_status : "unavailable",
    statusReason: text(row.status_reason),
    routingVerifiedAt: nullableText(row.routing_verified_at),
    revision: integer(row.revision, 1),
    updatedAt: text(row.updated_at),
  };
}

function hostnameFromRow(row: DatabaseRow): SiteHostnameRecord {
  return {
    hostname: text(row.hostname),
    siteKey: text(row.site_key),
    tenantKey: text(row.tenant_key),
    hostnameKind: row.hostname_kind === "custom" ? "custom" : "canonical",
    verificationStatus: row.verification_status === "claimed" || row.verification_status === "verified" || row.verification_status === "failed" || row.verification_status === "revoked" ? row.verification_status : "unavailable",
    routingCandidateOnly: true,
    authorizationEligible: false,
    verifiedAt: nullableText(row.verified_at),
    updatedAt: text(row.updated_at),
  };
}

function brandReleaseFromRow(row: DatabaseRow): SiteBrandReleaseRecord {
  return {
    releaseId: text(row.release_id),
    tenantKey: text(row.tenant_key),
    siteKey: text(row.site_key),
    brandProfileKey: nullableText(row.brand_profile_key),
    externalRevisionId: nullableText(row.external_revision_id),
    releaseStatus: row.release_status === "draft" || row.release_status === "published" || row.release_status === "retired" || row.release_status === "failed" ? row.release_status : "unlinked",
    sourceSystem: text(row.source_system),
    publishedAt: nullableText(row.published_at),
    evidenceUri: nullableText(row.evidence_uri),
    evidenceSha256: nullableText(row.evidence_sha256),
    updatedAt: text(row.updated_at),
  };
}

function resourceFromRow(row: DatabaseRow): TenantResourceIntegrationRecord {
  const domains = new Set(["users", "sessions", "orders", "messages", "assets", "announcements", "brand", "site", "host"]);
  return {
    resourceKey: text(row.resource_key),
    domainKey: (domains.has(text(row.domain_key)) ? text(row.domain_key) : "users") as TenantResourceIntegrationRecord["domainKey"],
    sourceKind: row.source_kind === "route" || row.source_kind === "runtime" || row.source_kind === "claim" ? row.source_kind : "table",
    sourceRef: text(row.source_ref),
    tenantScopeStatus: row.tenant_scope_status === "verified" || row.tenant_scope_status === "present_unbound" ? row.tenant_scope_status : "absent",
    siteScopeRequirement: row.site_scope_requirement === "required" || row.site_scope_requirement === "not_required" ? row.site_scope_requirement : "undecided",
    siteScopeStatus: row.site_scope_status === "verified" || row.site_scope_status === "present_unbound" || row.site_scope_status === "not_required" ? row.site_scope_status : "absent",
    tenantColumn: nullableText(row.tenant_column),
    siteColumn: nullableText(row.site_column),
    readScopeStatus: row.read_scope_status === "verified" || row.read_scope_status === "partial" ? row.read_scope_status : "unavailable",
    writeScopeStatus: row.write_scope_status === "verified" || row.write_scope_status === "partial" ? row.write_scope_status : "unavailable",
    databasePolicyStatus: row.database_policy_status === "tenant_rls_verified" || row.database_policy_status === "service_only" ? row.database_policy_status : "unavailable",
    sessionClaimStatus: row.session_claim_status === "verified" || row.session_claim_status === "configured" ? row.session_claim_status : "unavailable",
    crossTenantTestStatus: row.cross_tenant_test_status === "passed" || row.cross_tenant_test_status === "failed" ? row.cross_tenant_test_status : "not_run",
    integrationStatus: row.integration_status === "integrated" || row.integration_status === "partial" ? row.integration_status : "unintegrated",
    statusReason: text(row.status_reason),
    verifiedAt: nullableText(row.verified_at),
    evidenceUri: nullableText(row.evidence_uri),
    evidenceSha256: nullableText(row.evidence_sha256),
    sourceEvidence: evidenceArray(row.source_evidence),
    revision: integer(row.revision, 1),
    updatedAt: text(row.updated_at),
  };
}

function receiptFromRow(row: DatabaseRow): TenantIsolationReceiptRecord {
  return {
    receiptId: text(row.receipt_id),
    tenantAKey: text(row.tenant_a_key),
    tenantBKey: text(row.tenant_b_key),
    testScope: text(row.test_scope),
    receiptStatus: row.receipt_status === "planned" || row.receipt_status === "passed" || row.receipt_status === "failed" || row.receipt_status === "expired" ? row.receipt_status : "unavailable",
    crossTenantReadRejected: typeof row.cross_tenant_read_rejected === "boolean" ? row.cross_tenant_read_rejected : null,
    crossTenantWriteRejected: typeof row.cross_tenant_write_rejected === "boolean" ? row.cross_tenant_write_rejected : null,
    zeroDataLeakage: typeof row.zero_data_leakage === "boolean" ? row.zero_data_leakage : null,
    testedAt: nullableText(row.tested_at),
    expiresAt: nullableText(row.expires_at),
    evidenceUri: nullableText(row.evidence_uri),
    evidenceSha256: nullableText(row.evidence_sha256),
    createdAt: text(row.created_at),
  };
}

function auditFromRow(row: DatabaseRow): TenantAuditSummary {
  return {
    auditId: text(row.audit_id),
    tenantKey: nullableText(row.tenant_key),
    siteKey: nullableText(row.site_key),
    actionKey: text(row.action_key),
    result: row.result === "allowed" || row.result === "denied" || row.result === "unavailable" || row.result === "failed" ? row.result : "info",
    reasonCode: text(row.reason_code),
    resourceType: text(row.resource_type),
    resourceId: nullableText(row.resource_id),
    happenedAt: text(row.happened_at),
  };
}

function unavailableSnapshot(generatedAt: string, issue: TenantBoundaryIssue): AdminMultitenantBoundarySnapshot {
  const consistency = inspectMultitenantBoundary({
    tenants: [], members: [], sites: [], hostnames: [], brandReleases: [], resources: [], isolationReceipts: [], audits: [],
  });
  consistency.issues.unshift(issue);
  return {
    schemaVersion: MULTITENANT_BOUNDARY_SCHEMA_VERSION,
    generatedAt,
    migrationRequired: true,
    boundaryState: "unavailable",
    phase: "foundation_status_only",
    foundationBoundary: MULTITENANT_FOUNDATION_BOUNDARY,
    scopePolicy: MULTITENANT_SCOPE_POLICY,
    tenants: [], members: [], sites: [], hostnames: [], brandReleases: [], resourceIntegrations: [], isolationReceipts: [], recentAudits: [],
    consistency,
    readOnly: true,
    legacyRowMutations: 0,
    businessWrites: 0,
    hostAuthorizationDecisions: 0,
  };
}

export async function readAdminMultitenantBoundarySnapshot(): Promise<AdminMultitenantBoundarySnapshot> {
  const generatedAt = new Date().toISOString();
  try {
    const database = getSupabaseAdminClient();
    const [tenantResult, memberResult, siteResult, hostnameResult, brandResult, resourceResult, receiptResult, auditResult] = await Promise.all([
      database.from("tenants").select(TENANT_SELECT).order("tenant_key", { ascending: true }),
      database.from("tenant_members").select(MEMBER_SELECT).order("created_at", { ascending: false }).limit(200),
      database.from("sites").select(SITE_SELECT).order("site_key", { ascending: true }),
      database.from("site_hostnames").select(HOSTNAME_SELECT).order("hostname", { ascending: true }),
      database.from("site_brand_releases").select(BRAND_RELEASE_SELECT).order("created_at", { ascending: false }).limit(200),
      database.from("tenant_resource_integrations").select(RESOURCE_SELECT).order("domain_key", { ascending: true }).order("resource_key", { ascending: true }),
      database.from("tenant_isolation_receipts").select(RECEIPT_SELECT).order("created_at", { ascending: false }).limit(100),
      database.from("tenant_audits").select(AUDIT_SELECT).order("happened_at", { ascending: false }).limit(100),
    ]);
    const error = tenantResult.error || memberResult.error || siteResult.error || hostnameResult.error
      || brandResult.error || resourceResult.error || receiptResult.error || auditResult.error;
    if (error) {
      return unavailableSnapshot(generatedAt, {
        code: "MULTITENANT_BOUNDARY_SCHEMA_UNAVAILABLE",
        severity: "error",
        subject: "multitenant_boundary",
        message: "多租户边界迁移尚未可读；未回退为静态成功或伪造租户状态。",
      });
    }

    const tenants = (tenantResult.data || []).map((row: unknown) => tenantFromRow(row as DatabaseRow));
    const members = (memberResult.data || []).map((row: unknown) => memberFromRow(row as DatabaseRow));
    const sites = (siteResult.data || []).map((row: unknown) => siteFromRow(row as DatabaseRow));
    const hostnames = (hostnameResult.data || []).map((row: unknown) => hostnameFromRow(row as DatabaseRow));
    const brandReleases = (brandResult.data || []).map((row: unknown) => brandReleaseFromRow(row as DatabaseRow));
    const resourceIntegrations = (resourceResult.data || []).map((row: unknown) => resourceFromRow(row as DatabaseRow));
    const isolationReceipts = (receiptResult.data || []).map((row: unknown) => receiptFromRow(row as DatabaseRow));
    const recentAudits = (auditResult.data || []).map((row: unknown) => auditFromRow(row as DatabaseRow));
    const consistency = inspectMultitenantBoundary({
      tenants, members, sites, hostnames, brandReleases,
      resources: resourceIntegrations, isolationReceipts, audits: recentAudits,
    });

    return {
      schemaVersion: MULTITENANT_BOUNDARY_SCHEMA_VERSION,
      generatedAt,
      migrationRequired: false,
      boundaryState: consistency.boundaryState,
      phase: "foundation_status_only",
      foundationBoundary: MULTITENANT_FOUNDATION_BOUNDARY,
      scopePolicy: MULTITENANT_SCOPE_POLICY,
      tenants,
      members,
      sites,
      hostnames,
      brandReleases,
      resourceIntegrations,
      isolationReceipts,
      recentAudits,
      consistency,
      readOnly: true,
      legacyRowMutations: 0,
      businessWrites: 0,
      hostAuthorizationDecisions: 0,
    };
  } catch {
    return unavailableSnapshot(generatedAt, {
      code: "MULTITENANT_BOUNDARY_READ_FAILED",
      severity: "error",
      subject: "multitenant_boundary",
      message: "多租户边界状态读取失败，当前隔离状态不可用。",
    });
  }
}
