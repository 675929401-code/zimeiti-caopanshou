export const EXTERNAL_SITE_MONITOR_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_SITE_MONITOR_MIGRATION = "20261003113000" as const;
export const EXTERNAL_SITE_MONITOR_SCOPE = "external_vantage_only" as const;
export const EXTERNAL_SITE_MONITOR_CACHE_TTL_MS = 60_000;
export const EXTERNAL_SITE_MONITOR_MIN_READ_INTERVAL_MS = 30_000;
export const EXTERNAL_SITE_MONITOR_DEFAULT_EXPECTED_INTERVAL_SECONDS = 300;
export const EXTERNAL_SITE_MONITOR_MAX_STATIC_ASSETS = 8;
export const EXTERNAL_SITE_MONITOR_MAX_DOM_MARKERS = 8;

export type ExternalSiteProbeState = "passed" | "failed" | "unavailable";
export type ExternalSiteMonitorActivationState = "active" | "degraded" | "stale" | "unavailable";
export type ExternalSiteMonitorFreshnessState = "fresh" | "stale" | "unavailable";

export interface ExternalSiteProbeDnsCheck {
  state: ExternalSiteProbeState;
  durationMs: number | null;
  ipv4Count: number | null;
  ipv6Count: number | null;
  answerSetSha256: string | null;
  errorCode: string | null;
}

export interface ExternalSiteProbeTlsCheck {
  state: ExternalSiteProbeState;
  durationMs: number | null;
  negotiatedProtocol: string | null;
  certificateFingerprintSha256: string | null;
  sanSetSha256: string | null;
  certificateNotBefore: string | null;
  certificateNotAfter: string | null;
  daysRemaining: number | null;
  errorCode: string | null;
}

export interface ExternalSiteProbeHttpsCheck {
  state: ExternalSiteProbeState;
  durationMs: number | null;
  statusCode: number | null;
  finalUrlSha256: string | null;
  contentType: string | null;
  bytesSampled: number | null;
  errorCode: string | null;
}

export interface ExternalSiteProbeStaticAssetItem {
  path: string;
  state: ExternalSiteProbeState;
  statusCode: number | null;
  durationMs: number | null;
  contentType: string | null;
  errorCode: string | null;
}

export interface ExternalSiteProbeStaticAssetsCheck {
  state: ExternalSiteProbeState;
  discoveredCount: number | null;
  checkedCount: number | null;
  items: ExternalSiteProbeStaticAssetItem[];
  errorCode: string | null;
}

export interface ExternalSiteProbeDomMarker {
  label: string;
  present: boolean;
}

export interface ExternalSiteProbeLoginDomCheck {
  state: ExternalSiteProbeState;
  probeMode: "server_html_dom";
  durationMs: number | null;
  statusCode: number | null;
  documentSha256: string | null;
  markers: ExternalSiteProbeDomMarker[];
  errorCode: string | null;
}

export interface ExternalSiteProbePayload {
  schemaVersion: typeof EXTERNAL_SITE_MONITOR_SCHEMA_VERSION;
  monitorKind: "external_site_monitor";
  probeRunId: string;
  schedulerId: string;
  vantage: {
    kind: "external";
    id: string;
    region: string;
    provider: string | null;
  };
  target: {
    hostname: string;
    origin: string;
    loginPath: string;
  };
  startedAt: string;
  completedAt: string;
  overallStatus: "passed" | "degraded" | "failed";
  checks: {
    dns: ExternalSiteProbeDnsCheck;
    tls: ExternalSiteProbeTlsCheck;
    https: ExternalSiteProbeHttpsCheck;
    staticAssets: ExternalSiteProbeStaticAssetsCheck;
    loginDom: ExternalSiteProbeLoginDomCheck;
  };
  privacy: {
    rawResolvedAddressesIncluded: false;
    responseBodyIncluded: false;
    credentialsIncluded: false;
  };
  evidenceSha256: string;
}

export interface ExternalSiteMonitorBrowserProbe {
  completedAt: string;
  vantage: {
    region: string;
  };
  checks: {
    dns: Pick<ExternalSiteProbeDnsCheck, "state" | "durationMs" | "ipv4Count" | "ipv6Count">;
    tls: Pick<ExternalSiteProbeTlsCheck, "state" | "durationMs" | "negotiatedProtocol" | "certificateNotAfter" | "daysRemaining">;
    https: Pick<ExternalSiteProbeHttpsCheck, "state" | "durationMs" | "statusCode" | "contentType">;
    staticAssets: {
      state: ExternalSiteProbeState;
      checkedCount: number | null;
      items: Array<Pick<ExternalSiteProbeStaticAssetItem, "path" | "statusCode">>;
    };
    loginDom: {
      state: ExternalSiteProbeState;
      durationMs: number | null;
      statusCode: number | null;
      markers: Array<Pick<ExternalSiteProbeDomMarker, "present">>;
    };
  };
}

/**
 * Browser-safe read model. It intentionally excludes tenant/site identifiers,
 * raw probe envelopes, evidence digests and certificate fingerprints.
 */
export interface ExternalSiteMonitorTargetSnapshot {
  hostname: string;
  state: ExternalSiteMonitorActivationState;
  latestProbe: ExternalSiteMonitorBrowserProbe | null;
}

export interface ExternalSiteMonitorResponse {
  ok: true;
  schemaVersion: typeof EXTERNAL_SITE_MONITOR_SCHEMA_VERSION;
  nextRefreshAt: string;
  activation: {
    state: ExternalSiteMonitorActivationState;
    reasonCode: string;
    productionExternalMonitoringReady: boolean;
  };
  freshness: {
    ageSeconds: number | null;
  };
  rateLimit: {
    minimumIntervalMs: number;
  };
  expectedIntervalSeconds: number;
  targets: ExternalSiteMonitorTargetSnapshot[];
  sources: Array<{
    id: "external_scheduler" | "signed_ingest" | "domain_tls_probes";
    label: string;
    state: "available" | "stale" | "unavailable";
    detail: string;
  }>;
  limitations: string[];
}

export interface ExternalSiteMonitorRateLimitedResponse {
  ok: false;
  code: "EXTERNAL_SITE_MONITOR_RATE_LIMITED";
  error: string;
  nextRefreshAt: string;
}

type UnknownRecord = Record<string, unknown>;

export class ExternalSiteMonitorValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExternalSiteMonitorValidationError";
  }
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown, field: string, minimum = 1, maximum = 200): string {
  if (typeof value !== "string") throw new ExternalSiteMonitorValidationError("INVALID_STRING", `${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ExternalSiteMonitorValidationError("INVALID_STRING_LENGTH", `${field} 长度无效`);
  }
  return normalized;
}

function nullableText(value: unknown, field: string, maximum = 300): string | null {
  if (value === null) return null;
  return text(value, field, 1, maximum);
}

function state(value: unknown, field: string): ExternalSiteProbeState {
  if (value === "passed" || value === "failed" || value === "unavailable") return value;
  throw new ExternalSiteMonitorValidationError("INVALID_CHECK_STATE", `${field} 状态无效`);
}

function numberOrNull(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ExternalSiteMonitorValidationError("INVALID_NUMBER", `${field} 数值无效`);
  }
  return Math.round(value * 100) / 100;
}

function integerOrNull(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = numberOrNull(value, field, minimum, maximum);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(parsed)) throw new ExternalSiteMonitorValidationError("INVALID_INTEGER", `${field} 必须是整数`);
  return parsed;
}

function isoOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  return iso(value, field);
}

function iso(value: unknown, field: string): string {
  const raw = text(value, field, 20, 40);
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch)) throw new ExternalSiteMonitorValidationError("INVALID_TIMESTAMP", `${field} 时间无效`);
  return new Date(epoch).toISOString();
}

function sha256OrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  return sha256(value, field);
}

function sha256(value: unknown, field: string): string {
  const raw = text(value, field, 64, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(raw)) throw new ExternalSiteMonitorValidationError("INVALID_SHA256", `${field} 摘要无效`);
  return raw;
}

function errorCode(value: unknown, field: string): string | null {
  const raw = nullableText(value, field, 100);
  if (raw !== null && !/^[A-Z][A-Z0-9_]{2,99}$/u.test(raw)) {
    throw new ExternalSiteMonitorValidationError("INVALID_ERROR_CODE", `${field} 错误码无效`);
  }
  return raw;
}

function parseDuration(value: unknown, field: string): number | null {
  return numberOrNull(value, field, 0, 120_000);
}

function parseDns(value: unknown): ExternalSiteProbeDnsCheck {
  const row = record(value);
  if (!row) throw new ExternalSiteMonitorValidationError("INVALID_DNS_CHECK", "DNS 检查缺失");
  return {
    state: state(row.state, "checks.dns.state"),
    durationMs: parseDuration(row.durationMs, "checks.dns.durationMs"),
    ipv4Count: integerOrNull(row.ipv4Count, "checks.dns.ipv4Count", 0, 128),
    ipv6Count: integerOrNull(row.ipv6Count, "checks.dns.ipv6Count", 0, 128),
    answerSetSha256: sha256OrNull(row.answerSetSha256, "checks.dns.answerSetSha256"),
    errorCode: errorCode(row.errorCode, "checks.dns.errorCode"),
  };
}

function parseTls(value: unknown): ExternalSiteProbeTlsCheck {
  const row = record(value);
  if (!row) throw new ExternalSiteMonitorValidationError("INVALID_TLS_CHECK", "TLS 检查缺失");
  return {
    state: state(row.state, "checks.tls.state"),
    durationMs: parseDuration(row.durationMs, "checks.tls.durationMs"),
    negotiatedProtocol: nullableText(row.negotiatedProtocol, "checks.tls.negotiatedProtocol", 40),
    certificateFingerprintSha256: sha256OrNull(row.certificateFingerprintSha256, "checks.tls.certificateFingerprintSha256"),
    sanSetSha256: sha256OrNull(row.sanSetSha256, "checks.tls.sanSetSha256"),
    certificateNotBefore: isoOrNull(row.certificateNotBefore, "checks.tls.certificateNotBefore"),
    certificateNotAfter: isoOrNull(row.certificateNotAfter, "checks.tls.certificateNotAfter"),
    daysRemaining: numberOrNull(row.daysRemaining, "checks.tls.daysRemaining", -3650, 3650),
    errorCode: errorCode(row.errorCode, "checks.tls.errorCode"),
  };
}

function parseHttps(value: unknown): ExternalSiteProbeHttpsCheck {
  const row = record(value);
  if (!row) throw new ExternalSiteMonitorValidationError("INVALID_HTTPS_CHECK", "HTTPS 检查缺失");
  return {
    state: state(row.state, "checks.https.state"),
    durationMs: parseDuration(row.durationMs, "checks.https.durationMs"),
    statusCode: integerOrNull(row.statusCode, "checks.https.statusCode", 100, 599),
    finalUrlSha256: sha256OrNull(row.finalUrlSha256, "checks.https.finalUrlSha256"),
    contentType: nullableText(row.contentType, "checks.https.contentType", 120),
    bytesSampled: integerOrNull(row.bytesSampled, "checks.https.bytesSampled", 0, 1_048_576),
    errorCode: errorCode(row.errorCode, "checks.https.errorCode"),
  };
}

function safePath(value: unknown, field: string, allowHashedQuery = false): string {
  const raw = text(value, field, 1, 300);
  const queryAllowed = allowHashedQuery && /\?query-sha256=[a-f0-9]{64}$/u.test(raw);
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\r\n\\#]/u.test(raw) || (raw.includes("?") && !queryAllowed)) {
    throw new ExternalSiteMonitorValidationError("INVALID_PATH", `${field} 路径无效`);
  }
  return raw;
}

function parseStaticAssets(value: unknown): ExternalSiteProbeStaticAssetsCheck {
  const row = record(value);
  if (!row || !Array.isArray(row.items) || row.items.length > EXTERNAL_SITE_MONITOR_MAX_STATIC_ASSETS) {
    throw new ExternalSiteMonitorValidationError("INVALID_STATIC_ASSETS_CHECK", "静态资源检查无效");
  }
  const items = row.items.map((item, index): ExternalSiteProbeStaticAssetItem => {
    const candidate = record(item);
    if (!candidate) throw new ExternalSiteMonitorValidationError("INVALID_STATIC_ASSET", `静态资源 ${index + 1} 无效`);
    return {
      path: safePath(candidate.path, `checks.staticAssets.items.${index}.path`, true),
      state: state(candidate.state, `checks.staticAssets.items.${index}.state`),
      statusCode: integerOrNull(candidate.statusCode, `checks.staticAssets.items.${index}.statusCode`, 100, 599),
      durationMs: parseDuration(candidate.durationMs, `checks.staticAssets.items.${index}.durationMs`),
      contentType: nullableText(candidate.contentType, `checks.staticAssets.items.${index}.contentType`, 120),
      errorCode: errorCode(candidate.errorCode, `checks.staticAssets.items.${index}.errorCode`),
    };
  });
  return {
    state: state(row.state, "checks.staticAssets.state"),
    discoveredCount: integerOrNull(row.discoveredCount, "checks.staticAssets.discoveredCount", 0, 10_000),
    checkedCount: integerOrNull(row.checkedCount, "checks.staticAssets.checkedCount", 0, EXTERNAL_SITE_MONITOR_MAX_STATIC_ASSETS),
    items,
    errorCode: errorCode(row.errorCode, "checks.staticAssets.errorCode"),
  };
}

function parseLoginDom(value: unknown): ExternalSiteProbeLoginDomCheck {
  const row = record(value);
  if (!row || row.probeMode !== "server_html_dom" || !Array.isArray(row.markers) || row.markers.length > EXTERNAL_SITE_MONITOR_MAX_DOM_MARKERS) {
    throw new ExternalSiteMonitorValidationError("INVALID_LOGIN_DOM_CHECK", "登录入口 DOM 检查无效");
  }
  const markers = row.markers.map((marker, index): ExternalSiteProbeDomMarker => {
    const candidate = record(marker);
    if (!candidate || typeof candidate.present !== "boolean") {
      throw new ExternalSiteMonitorValidationError("INVALID_DOM_MARKER", `DOM 标记 ${index + 1} 无效`);
    }
    return {
      label: text(candidate.label, `checks.loginDom.markers.${index}.label`, 1, 80),
      present: candidate.present,
    };
  });
  return {
    state: state(row.state, "checks.loginDom.state"),
    probeMode: "server_html_dom",
    durationMs: parseDuration(row.durationMs, "checks.loginDom.durationMs"),
    statusCode: integerOrNull(row.statusCode, "checks.loginDom.statusCode", 100, 599),
    documentSha256: sha256OrNull(row.documentSha256, "checks.loginDom.documentSha256"),
    markers,
    errorCode: errorCode(row.errorCode, "checks.loginDom.errorCode"),
  };
}

export function stableExternalMonitorJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableExternalMonitorJson).join(",")}]`;
  const row = value as UnknownRecord;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableExternalMonitorJson(row[key])}`).join(",")}}`;
}

export function externalSiteProbeEvidenceInput(payload: ExternalSiteProbePayload): Omit<ExternalSiteProbePayload, "evidenceSha256"> {
  const evidence = { ...payload };
  Reflect.deleteProperty(evidence, "evidenceSha256");
  return evidence;
}

export function parseExternalSiteProbePayload(value: unknown): ExternalSiteProbePayload {
  const root = record(value);
  if (!root || root.schemaVersion !== EXTERNAL_SITE_MONITOR_SCHEMA_VERSION || root.monitorKind !== "external_site_monitor") {
    throw new ExternalSiteMonitorValidationError("INVALID_SCHEMA", "外部探针合同版本无效");
  }
  const vantage = record(root.vantage);
  const target = record(root.target);
  const checks = record(root.checks);
  const privacy = record(root.privacy);
  if (!vantage || vantage.kind !== "external") {
    throw new ExternalSiteMonitorValidationError("EXTERNAL_VANTAGE_REQUIRED", "探针必须声明独立外部观测点");
  }
  if (!target || !checks || !privacy) {
    throw new ExternalSiteMonitorValidationError("INVALID_PAYLOAD", "外部探针载荷缺少必填字段");
  }
  const hostname = text(target.hostname, "target.hostname", 4, 253).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(hostname) || hostname.includes("..")) {
    throw new ExternalSiteMonitorValidationError("INVALID_HOSTNAME", "监测域名格式无效");
  }
  const origin = text(target.origin, "target.origin", 8, 300);
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new ExternalSiteMonitorValidationError("INVALID_ORIGIN", "监测 Origin 无效");
  }
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.hostname !== hostname || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.port) {
    throw new ExternalSiteMonitorValidationError("INVALID_ORIGIN", "监测 Origin 必须是域名对应的标准 HTTPS Origin");
  }
  const startedAt = iso(root.startedAt, "startedAt");
  const completedAt = iso(root.completedAt, "completedAt");
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  if (duration < 0 || duration > 5 * 60_000) {
    throw new ExternalSiteMonitorValidationError("INVALID_PROBE_WINDOW", "探针执行时间窗口无效");
  }
  if (root.overallStatus !== "passed" && root.overallStatus !== "degraded" && root.overallStatus !== "failed") {
    throw new ExternalSiteMonitorValidationError("INVALID_OVERALL_STATUS", "探针总状态无效");
  }
  if (privacy.rawResolvedAddressesIncluded !== false || privacy.responseBodyIncluded !== false || privacy.credentialsIncluded !== false) {
    throw new ExternalSiteMonitorValidationError("PRIVACY_BOUNDARY_VIOLATION", "探针载荷包含禁止持久化的原始数据");
  }
  return {
    schemaVersion: EXTERNAL_SITE_MONITOR_SCHEMA_VERSION,
    monitorKind: "external_site_monitor",
    probeRunId: text(root.probeRunId, "probeRunId", 8, 100),
    schedulerId: text(root.schedulerId, "schedulerId", 3, 100),
    vantage: {
      kind: "external",
      id: text(vantage.id, "vantage.id", 3, 100),
      region: text(vantage.region, "vantage.region", 2, 100),
      provider: nullableText(vantage.provider, "vantage.provider", 100),
    },
    target: {
      hostname,
      origin: parsedOrigin.origin,
      loginPath: safePath(target.loginPath, "target.loginPath"),
    },
    startedAt,
    completedAt,
    overallStatus: root.overallStatus,
    checks: {
      dns: parseDns(checks.dns),
      tls: parseTls(checks.tls),
      https: parseHttps(checks.https),
      staticAssets: parseStaticAssets(checks.staticAssets),
      loginDom: parseLoginDom(checks.loginDom),
    },
    privacy: {
      rawResolvedAddressesIncluded: false,
      responseBodyIncluded: false,
      credentialsIncluded: false,
    },
    evidenceSha256: sha256(root.evidenceSha256, "evidenceSha256"),
  };
}

export function isExternalSiteProbePayload(value: unknown): value is ExternalSiteProbePayload {
  try {
    parseExternalSiteProbePayload(value);
    return true;
  } catch {
    return false;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): UnknownRecord | null {
  const row = record(value);
  if (!row) return null;
  const actual = Object.keys(row);
  if (actual.length !== keys.length) return null;
  const allowed = new Set(keys);
  return actual.every((key) => allowed.has(key)) ? row : null;
}

function shortString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= minimum
    && value.length <= maximum;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function nullableNumber(value: unknown, minimum: number, maximum: number): value is number | null {
  return value === null || finiteNumber(value, minimum, maximum);
}

function nullableInteger(value: unknown, minimum: number, maximum: number): value is number | null {
  return value === null || (Number.isSafeInteger(value) && finiteNumber(value, minimum, maximum));
}

function nullableBrowserText(value: unknown, maximum: number): value is string | null {
  return value === null || shortString(value, 1, maximum);
}

function probeState(value: unknown): value is ExternalSiteProbeState {
  return value === "passed" || value === "failed" || value === "unavailable";
}

function activationState(value: unknown): value is ExternalSiteMonitorActivationState {
  return value === "active" || value === "degraded" || value === "stale" || value === "unavailable";
}

function browserPath(value: unknown): value is string {
  return shortString(value, 1, 300)
    && value.startsWith("/")
    && !value.startsWith("//")
    && !/[\r\n\\#]/u.test(value)
    && (!value.includes("?") || /\?query-sha256=[a-f0-9]{64}$/u.test(value));
}

function browserHostname(value: unknown): value is string {
  return shortString(value, 4, 253)
    && value === value.toLowerCase()
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(value)
    && !value.includes("..");
}

function browserDnsCheck(value: unknown): boolean {
  const row = exactRecord(value, ["state", "durationMs", "ipv4Count", "ipv6Count"]);
  return Boolean(row
    && probeState(row.state)
    && nullableNumber(row.durationMs, 0, 120_000)
    && nullableInteger(row.ipv4Count, 0, 128)
    && nullableInteger(row.ipv6Count, 0, 128));
}

function browserTlsCheck(value: unknown): boolean {
  const row = exactRecord(value, ["state", "durationMs", "negotiatedProtocol", "certificateNotAfter", "daysRemaining"]);
  return Boolean(row
    && probeState(row.state)
    && nullableNumber(row.durationMs, 0, 120_000)
    && nullableBrowserText(row.negotiatedProtocol, 40)
    && (row.certificateNotAfter === null || canonicalIso(row.certificateNotAfter))
    && nullableNumber(row.daysRemaining, -3_650, 3_650));
}

function browserHttpsCheck(value: unknown): boolean {
  const row = exactRecord(value, ["state", "durationMs", "statusCode", "contentType"]);
  return Boolean(row
    && probeState(row.state)
    && nullableNumber(row.durationMs, 0, 120_000)
    && nullableInteger(row.statusCode, 100, 599)
    && nullableBrowserText(row.contentType, 120));
}

function browserStaticAssetsCheck(value: unknown): boolean {
  const row = exactRecord(value, ["state", "checkedCount", "items"]);
  if (!row || !probeState(row.state) || !nullableInteger(row.checkedCount, 0, EXTERNAL_SITE_MONITOR_MAX_STATIC_ASSETS)) return false;
  if (!Array.isArray(row.items) || row.items.length > EXTERNAL_SITE_MONITOR_MAX_STATIC_ASSETS) return false;
  return row.items.every((item) => {
    const candidate = exactRecord(item, ["path", "statusCode"]);
    return Boolean(candidate
      && browserPath(candidate.path)
      && nullableInteger(candidate.statusCode, 100, 599));
  });
}

function browserLoginDomCheck(value: unknown): boolean {
  const row = exactRecord(value, ["state", "durationMs", "statusCode", "markers"]);
  if (!row
    || !probeState(row.state)
    || !nullableNumber(row.durationMs, 0, 120_000)
    || !nullableInteger(row.statusCode, 100, 599)
    || !Array.isArray(row.markers)
    || row.markers.length > EXTERNAL_SITE_MONITOR_MAX_DOM_MARKERS) return false;
  return row.markers.every((marker) => {
    const candidate = exactRecord(marker, ["present"]);
    return Boolean(candidate && typeof candidate.present === "boolean");
  });
}

function browserProbe(value: unknown): boolean {
  const row = exactRecord(value, ["completedAt", "vantage", "checks"]);
  if (!row || !canonicalIso(row.completedAt)) return false;
  const vantage = exactRecord(row.vantage, ["region"]);
  const checks = exactRecord(row.checks, ["dns", "tls", "https", "staticAssets", "loginDom"]);
  return Boolean(vantage
    && shortString(vantage.region, 2, 100)
    && checks
    && browserDnsCheck(checks.dns)
    && browserTlsCheck(checks.tls)
    && browserHttpsCheck(checks.https)
    && browserStaticAssetsCheck(checks.staticAssets)
    && browserLoginDomCheck(checks.loginDom));
}

function browserTarget(value: unknown): boolean {
  const row = exactRecord(value, ["hostname", "state", "latestProbe"]);
  return Boolean(row
    && browserHostname(row.hostname)
    && activationState(row.state)
    && (row.latestProbe === null || browserProbe(row.latestProbe)));
}

export function isExternalSiteMonitorResponse(value: unknown): value is ExternalSiteMonitorResponse {
  const row = exactRecord(value, [
    "ok",
    "schemaVersion",
    "nextRefreshAt",
    "activation",
    "freshness",
    "rateLimit",
    "expectedIntervalSeconds",
    "targets",
    "sources",
    "limitations",
  ]);
  if (!row
    || row.ok !== true
    || row.schemaVersion !== EXTERNAL_SITE_MONITOR_SCHEMA_VERSION
    || !canonicalIso(row.nextRefreshAt)
    || !Number.isSafeInteger(row.expectedIntervalSeconds)
    || !finiteNumber(row.expectedIntervalSeconds, 60, 86_400)) return false;

  const activation = exactRecord(row.activation, ["state", "reasonCode", "productionExternalMonitoringReady"]);
  const freshness = exactRecord(row.freshness, ["ageSeconds"]);
  const rateLimit = exactRecord(row.rateLimit, ["minimumIntervalMs"]);
  if (!activation
    || !activationState(activation.state)
    || !shortString(activation.reasonCode, 3, 100)
    || !/^[A-Z][A-Z0-9_]{2,99}$/u.test(activation.reasonCode)
    || typeof activation.productionExternalMonitoringReady !== "boolean"
    || !freshness
    || !nullableInteger(freshness.ageSeconds, 0, Number.MAX_SAFE_INTEGER)
    || !rateLimit
    || !Number.isSafeInteger(rateLimit.minimumIntervalMs)
    || !finiteNumber(rateLimit.minimumIntervalMs, 1_000, 3_600_000)) return false;

  if (!Array.isArray(row.targets) || row.targets.length > 100 || !row.targets.every(browserTarget)) return false;
  if (!Array.isArray(row.sources) || row.sources.length > 3) return false;
  const sourceIds = new Set<string>();
  for (const source of row.sources) {
    const candidate = exactRecord(source, ["id", "label", "state", "detail"]);
    if (!candidate
      || (candidate.id !== "external_scheduler" && candidate.id !== "signed_ingest" && candidate.id !== "domain_tls_probes")
      || sourceIds.has(candidate.id)
      || !shortString(candidate.label, 1, 80)
      || (candidate.state !== "available" && candidate.state !== "stale" && candidate.state !== "unavailable")
      || !shortString(candidate.detail, 1, 300)) return false;
    sourceIds.add(candidate.id);
  }
  return Array.isArray(row.limitations)
    && row.limitations.length <= 16
    && row.limitations.every((item) => shortString(item, 1, 500));
}
