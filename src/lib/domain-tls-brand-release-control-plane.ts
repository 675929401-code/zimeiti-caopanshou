import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";

export const DOMAIN_RELEASE_MIGRATION = "20261002210000" as const;

export const DOMAIN_RELEASE_SOURCE_BOUNDARIES = [
  {
    source: "proxy_host_gate",
    state: "not_connected",
    fact: "Host is used for same-host write validation and response headers, not trusted site resolution.",
  },
  {
    source: "nginx_unknown_host_gate",
    state: "not_connected",
    fact: "The template has one server_name block and no default_server unknown-host rejection block.",
  },
  {
    source: "dns_resolver",
    state: "not_connected",
    fact: "No TXT or CNAME resolver worker is connected.",
  },
  {
    source: "tls_issuer",
    state: "not_connected",
    fact: "No certificate issuer connector is configured.",
  },
  {
    source: "https_probe_worker",
    state: "not_connected",
    fact: "No external TLS or HTTPS probe worker is configured.",
  },
  {
    source: "gateway_connector",
    state: "not_connected",
    fact: "No Cloudflare for SaaS or explicit gateway connector is configured.",
  },
  {
    source: "platform_branding",
    state: "single_profile_only",
    fact: "Published branding remains the sole default platform profile.",
  },
  {
    source: "site_config",
    state: "static_single_site",
    fact: "The public site-config route returns one static catalog without Host or site scope.",
  },
] as const;

const RESERVED_EXACT = new Set([
  "localhost",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "test",
]);

const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home",
  "lan",
  "test",
  "invalid",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "onion",
  "arpa",
] as const;

type UnknownRecord = Record<string, unknown>;

export interface NormalizedDomainClaim {
  requestedHostname: string;
  asciiHostname: string;
  unicodeHostname: string;
  expectedTxtName: string;
  normalizationVersion: "node.domainToASCII.v1";
}

export interface DomainReleaseHostnameStatus {
  hostname: string;
  tenantKey: string;
  siteKey: string;
  lifecycleStatus: string;
  ownershipStatus: string;
  routingStatus: string;
  tlsStatus: string;
  httpsStatus: string;
  gatewayConnectorStatus: string;
  routingActivationEnabled: false;
  certificateNotAfter: string | null;
  asOf: string | null;
}

export interface DomainReleaseDatabaseStatus {
  schemaVersion: 1;
  migration: typeof DOMAIN_RELEASE_MIGRATION;
  asOf: string;
  phase: "foundation_only";
  tableCounts: {
    claims: number;
    hostnames: number;
    verificationAttempts: number;
    tlsProbes: number;
    brandReleaseBindings: number;
    audits: number;
  };
  prerequisites: {
    tenants: number;
    sites: number;
    siteHostnameCandidates: number;
    siteBrandReleases: number;
  };
  states: {
    verifiedClaims: number;
    dnsOwnershipVerified: number;
    dnsRoutingVerified: number;
    tlsIssued: number;
    httpsPassed: number;
    previewReady: number;
    published: number;
  };
  runtimeBoundary: {
    dnsResolverConnected: false;
    tlsIssuerConnected: false;
    httpsProbeWorkerConnected: false;
    gatewayConnectorConnected: false;
    trustedHostResolutionConnected: false;
    unknownHostHardRejectActive: false;
    unknownHostObservedStatus: null;
    unknownHostRequiredStatus: 421;
    brandRuntimeBindingConnected: false;
    externalCallsEnabled: false;
  };
  hostnames: DomainReleaseHostnameStatus[];
}

export interface DomainReleaseStatus {
  schemaVersion: 1;
  controlPlane: "domain_tls_brand_release";
  phase: "foundation_only";
  migrationApplied: true;
  database: DomainReleaseDatabaseStatus;
  integration: {
    currentRuntimeChanged: false;
    dnsRecordsChanged: false;
    certificatesChanged: false;
    gatewayChanged: false;
    formalDomainChanged: false;
    realDomainVerificationRun: false;
    connectedSources: [];
    pendingSources: typeof DOMAIN_RELEASE_SOURCE_BOUNDARIES;
  };
  hostRoutingPolicy: {
    targetPolicy: "unknown_host_hard_reject";
    requiredStatus: 421;
    enforcementActive: false;
    observedStatus: null;
    fallbackSiteAllowed: false;
  };
}

export type DomainReleaseErrorCode =
  | "DOMAIN_HOSTNAME_REQUIRED"
  | "DOMAIN_HOSTNAME_INVALID"
  | "DOMAIN_HOSTNAME_RESERVED"
  | "DOMAIN_HOSTNAME_TOO_LONG"
  | "DOMAIN_RELEASE_SCHEMA_REQUIRED"
  | "DOMAIN_RELEASE_STATUS_INVALID"
  | "DOMAIN_RELEASE_STATUS_UNAVAILABLE";

export class DomainReleaseError extends Error {
  readonly code: DomainReleaseErrorCode;
  readonly status: number;

  constructor(code: DomainReleaseErrorCode, message: string, status = 400) {
    super(message);
    this.name = "DomainReleaseError";
    this.code = code;
    this.status = status;
  }
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isReservedDomainHostname(asciiHostname: string): boolean {
  const hostname = asciiHostname.toLowerCase();
  return RESERVED_EXACT.has(hostname)
    || RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(`.${suffix}`));
}

export function normalizeDomainClaim(value: unknown): NormalizedDomainClaim {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_REQUIRED", "域名不能为空");
  }
  const requestedHostname = value.trim().normalize("NFC");
  if (
    requestedHostname.length > 512
    || /[/?#@\\\s_*]/u.test(requestedHostname)
    || requestedHostname.includes("://")
    || requestedHostname.includes(":")
  ) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_INVALID", "域名格式无效");
  }
  const withoutRootDot = requestedHostname.endsWith(".")
    ? requestedHostname.slice(0, -1)
    : requestedHostname;
  if (!withoutRootDot || withoutRootDot.endsWith(".")) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_INVALID", "域名格式无效");
  }
  const asciiHostname = domainToASCII(withoutRootDot).toLowerCase();
  if (!asciiHostname) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_INVALID", "域名无法完成 IDNA 规范化");
  }
  if (asciiHostname.length > 223) {
    throw new DomainReleaseError(
      "DOMAIN_HOSTNAME_TOO_LONG",
      "域名过长，无法生成有效 TXT 验证记录名",
    );
  }
  if (isIP(asciiHostname) !== 0) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_INVALID", "不接受 IP 地址作为站点域名");
  }
  if (isReservedDomainHostname(asciiHostname)) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_RESERVED", "保留域名不能被认领");
  }
  const labels = asciiHostname.split(".");
  if (
    labels.length < 2
    || labels.some((label) => (
      label.length < 1
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ))
    || /^\d+$/u.test(labels.at(-1) || "")
  ) {
    throw new DomainReleaseError("DOMAIN_HOSTNAME_INVALID", "域名标签格式无效");
  }
  return {
    requestedHostname,
    asciiHostname,
    unicodeHostname: domainToUnicode(asciiHostname),
    expectedTxtName: `_zimeiti-domain-verification.${asciiHostname}`,
    normalizationVersion: "node.domainToASCII.v1",
  };
}

function hostnameStatus(value: unknown): DomainReleaseHostnameStatus | null {
  const row = record(value);
  if (!row || typeof row.hostname !== "string") return null;
  return {
    hostname: row.hostname,
    tenantKey: typeof row.tenantKey === "string" ? row.tenantKey : "",
    siteKey: typeof row.siteKey === "string" ? row.siteKey : "",
    lifecycleStatus: typeof row.lifecycleStatus === "string" ? row.lifecycleStatus : "claimed",
    ownershipStatus: typeof row.ownershipStatus === "string" ? row.ownershipStatus : "unavailable",
    routingStatus: typeof row.routingStatus === "string" ? row.routingStatus : "unavailable",
    tlsStatus: typeof row.tlsStatus === "string" ? row.tlsStatus : "unavailable",
    httpsStatus: typeof row.httpsStatus === "string" ? row.httpsStatus : "unavailable",
    gatewayConnectorStatus: typeof row.gatewayConnectorStatus === "string"
      ? row.gatewayConnectorStatus
      : "unavailable",
    routingActivationEnabled: false,
    certificateNotAfter: nullableString(row.certificateNotAfter),
    asOf: nullableString(row.asOf),
  };
}

export function normalizeDomainReleaseDatabaseStatus(value: unknown): DomainReleaseDatabaseStatus {
  const root = record(value);
  if (!root || Number(root.schemaVersion) !== 1 || root.migration !== DOMAIN_RELEASE_MIGRATION) {
    throw new DomainReleaseError(
      "DOMAIN_RELEASE_STATUS_INVALID",
      "域名与贴牌发布控制平面状态回执无效",
      503,
    );
  }
  const tableCounts = record(root.tableCounts) || {};
  const prerequisites = record(root.prerequisites) || {};
  const states = record(root.states) || {};
  const hostnames = Array.isArray(root.hostnames)
    ? root.hostnames.map(hostnameStatus).filter((item): item is DomainReleaseHostnameStatus => item !== null)
    : [];
  return {
    schemaVersion: 1,
    migration: DOMAIN_RELEASE_MIGRATION,
    asOf: typeof root.asOf === "string" ? root.asOf : new Date().toISOString(),
    phase: "foundation_only",
    tableCounts: {
      claims: count(tableCounts.claims),
      hostnames: count(tableCounts.hostnames),
      verificationAttempts: count(tableCounts.verificationAttempts),
      tlsProbes: count(tableCounts.tlsProbes),
      brandReleaseBindings: count(tableCounts.brandReleaseBindings),
      audits: count(tableCounts.audits),
    },
    prerequisites: {
      tenants: count(prerequisites.tenants),
      sites: count(prerequisites.sites),
      siteHostnameCandidates: count(prerequisites.siteHostnameCandidates),
      siteBrandReleases: count(prerequisites.siteBrandReleases),
    },
    states: {
      verifiedClaims: count(states.verifiedClaims),
      dnsOwnershipVerified: count(states.dnsOwnershipVerified),
      dnsRoutingVerified: count(states.dnsRoutingVerified),
      tlsIssued: count(states.tlsIssued),
      httpsPassed: count(states.httpsPassed),
      previewReady: count(states.previewReady),
      published: count(states.published),
    },
    runtimeBoundary: {
      dnsResolverConnected: false,
      tlsIssuerConnected: false,
      httpsProbeWorkerConnected: false,
      gatewayConnectorConnected: false,
      trustedHostResolutionConnected: false,
      unknownHostHardRejectActive: false,
      unknownHostObservedStatus: null,
      unknownHostRequiredStatus: 421,
      brandRuntimeBindingConnected: false,
      externalCallsEnabled: false,
    },
    hostnames,
  };
}

export function domainReleaseSchemaUnavailable(error: unknown): boolean {
  const detail = record(error) || {};
  const code = typeof detail.code === "string" ? detail.code : "";
  const message = [detail.message, detail.details, detail.hint]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return ["42P01", "42883", "PGRST202", "PGRST204"].includes(code)
    || /get_domain_tls_brand_release_status|domain_(?:claims|hostnames|verification_attempts|tls_probes|brand_release_bindings|release_audits)/iu.test(message);
}
