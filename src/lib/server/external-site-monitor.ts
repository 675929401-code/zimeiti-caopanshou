import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  EXTERNAL_SITE_MONITOR_CACHE_TTL_MS,
  EXTERNAL_SITE_MONITOR_DEFAULT_EXPECTED_INTERVAL_SECONDS,
  EXTERNAL_SITE_MONITOR_MIGRATION,
  EXTERNAL_SITE_MONITOR_MIN_READ_INTERVAL_MS,
  EXTERNAL_SITE_MONITOR_SCHEMA_VERSION,
  externalSiteProbeEvidenceInput,
  isExternalSiteMonitorResponse,
  parseExternalSiteProbePayload,
  stableExternalMonitorJson,
  type ExternalSiteMonitorActivationState,
  type ExternalSiteMonitorBrowserProbe,
  type ExternalSiteMonitorResponse,
  type ExternalSiteMonitorTargetSnapshot,
  type ExternalSiteProbePayload,
} from "@/lib/external-site-monitor-contract";
import { getServerSecret } from "@/lib/server-secrets";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type UnknownRecord = Record<string, unknown>;
type DatabaseError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null };
type ExternalSiteMonitorInternalProbe = ExternalSiteProbePayload & {
  probeId: string;
  receivedAt: string;
};

interface ExternalSiteMonitorInternalTargetSnapshot {
  hostname: string;
  tenantKey: string;
  siteKey: string;
  state: ExternalSiteMonitorActivationState;
  latestProbe: ExternalSiteMonitorInternalProbe | null;
}

interface ExternalMonitorCacheState {
  expiresAt: number;
  promise: Promise<ExternalSiteMonitorResponse>;
  settled: boolean;
  value: ExternalSiteMonitorResponse | null;
}

interface ExternalMonitorAdmissionEntry {
  inFlight: boolean;
  lastAllowedAtMs: number | null;
  lastTouchedAtMs: number;
}

export type ExternalMonitorAdmissionResult<T> =
  | { allowed: true; value: T; nextAllowedAtMs: number }
  | { allowed: false; reason: "single_flight" | "minimum_interval"; retryAfterMs: number; nextAllowedAtMs: number };

declare global {
  var __agentHubExternalSiteMonitorCacheV1: ExternalMonitorCacheState | undefined;
  var __agentHubExternalSiteMonitorAdmissionV1: ExternalSiteMonitorAdmissionGate | undefined;
}

const MAX_TARGETS = 100;
const ADMISSION_TTL_MS = 10 * 60_000;
const MAX_ADMISSION_ENTRIES = 1_024;
const SIGNATURE_MAX_SKEW_SECONDS = 300;
const PROBE_MAX_DELIVERY_DELAY_MS = 15 * 60_000;

export class ExternalSiteMonitorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly cause?: unknown) {
    super(message);
    this.name = "ExternalSiteMonitorError";
  }
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finiteInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function expectedIntervalSeconds(): number {
  return finiteInteger(
    process.env.EXTERNAL_SITE_MONITOR_EXPECTED_INTERVAL_SECONDS,
    EXTERNAL_SITE_MONITOR_DEFAULT_EXPECTED_INTERVAL_SECONDS,
    60,
    86_400,
  );
}

function expectedSchedulerId(): string | null {
  const value = process.env.EXTERNAL_SITE_MONITOR_EXPECTED_SCHEDULER_ID?.trim();
  return value && /^[A-Za-z0-9_.:-]{3,100}$/u.test(value) ? value : null;
}

export function externalSiteMonitorIngestSecret(): string | null {
  return getServerSecret("EXTERNAL_SITE_MONITOR_INGEST_SECRET");
}

export function externalSiteMonitorBodySha256(rawBody: string): string {
  return sha256(rawBody);
}

export function externalSiteMonitorSigningInput(rawBody: string, timestamp: string, nonce: string): string {
  return `${timestamp}.${nonce}.${externalSiteMonitorBodySha256(rawBody)}`;
}

export function createExternalSiteMonitorSignature(secret: string, rawBody: string, timestamp: string, nonce: string): string {
  const digest = createHmac("sha256", secret)
    .update(externalSiteMonitorSigningInput(rawBody, timestamp, nonce))
    .digest("hex");
  return `v1=${digest}`;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyExternalSiteMonitorSignature(input: {
  secret: string;
  rawBody: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  keyId: string | null;
  nowMs?: number;
}): { replayKey: string; keyId: string; timestampSeconds: number } {
  const timestamp = input.timestamp || "";
  const nonce = input.nonce || "";
  const signature = input.signature || "";
  const keyId = input.keyId || "";
  if (!/^\d{10}$/u.test(timestamp)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SIGNATURE_TIMESTAMP_INVALID", "探针签名时间无效", 403);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SIGNATURE_NONCE_INVALID", "探针签名随机数无效", 403);
  }
  if (!/^[A-Za-z0-9_.:-]{3,100}$/u.test(keyId)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_KEY_ID_INVALID", "探针密钥标识无效", 403);
  }
  if (!/^v1=[a-f0-9]{64}$/u.test(signature)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SIGNATURE_INVALID", "探针签名无效", 403);
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_MAX_SKEW_SECONDS) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SIGNATURE_EXPIRED", "探针签名已过期", 403);
  }
  const expected = createExternalSiteMonitorSignature(input.secret, input.rawBody, timestamp, nonce);
  if (!safeEqual(signature, expected)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SIGNATURE_MISMATCH", "探针签名不匹配", 403);
  }
  return {
    replayKey: `external-monitor:${sha256(`${keyId}.${timestamp}.${nonce}`)}`,
    keyId,
    timestampSeconds,
  };
}

function databaseErrorCode(error: DatabaseError | null): string {
  const combined = [error?.code, error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  const explicit = combined.match(/EXTERNAL_SITE_MONITOR_[A-Z0-9_]+/u)?.[0];
  if (explicit) return explicit;
  if (/PGRST202|42883|schema cache|does not exist|external_site_monitor/iu.test(combined)) {
    return "EXTERNAL_SITE_MONITOR_MIGRATION_REQUIRED";
  }
  if (/23505|duplicate key/iu.test(combined)) return "EXTERNAL_SITE_MONITOR_REPLAY_REJECTED";
  return "EXTERNAL_SITE_MONITOR_DATABASE_UNAVAILABLE";
}

function verifyEvidenceDigest(payload: ExternalSiteProbePayload): void {
  const expected = sha256(stableExternalMonitorJson(externalSiteProbeEvidenceInput(payload)));
  if (!safeEqual(expected, payload.evidenceSha256)) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_EVIDENCE_MISMATCH", "探针证据摘要不匹配", 400);
  }
}

export async function ingestExternalSiteProbe(input: {
  payload: unknown;
  replayKey: string;
  keyId: string;
  nowMs?: number;
}): Promise<{ accepted: true; duplicate: boolean; probeId: string; hostname: string; receivedAt: string }> {
  const payload = parseExternalSiteProbePayload(input.payload);
  verifyEvidenceDigest(payload);
  const nowMs = input.nowMs ?? Date.now();
  const completedAtMs = Date.parse(payload.completedAt);
  if (completedAtMs > nowMs + 60_000 || nowMs - completedAtMs > PROBE_MAX_DELIVERY_DELAY_MS) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_RESULT_WINDOW_INVALID", "探针结果不是当前观测窗口", 400);
  }
  const configuredScheduler = expectedSchedulerId();
  if (configuredScheduler && configuredScheduler !== payload.schedulerId) {
    throw new ExternalSiteMonitorError("EXTERNAL_MONITOR_SCHEDULER_MISMATCH", "探针调度器身份不匹配", 403);
  }

  const client = getSupabaseAdminClient() as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: DatabaseError | null }>;
  };
  const { data, error } = await client.rpc("ingest_external_site_monitor_probe", {
    p_hostname: payload.target.hostname,
    p_idempotency_key: input.replayKey,
    p_probe_run_id: payload.probeRunId,
    p_scheduler_id: payload.schedulerId,
    p_key_id: input.keyId,
    p_probe_status: payload.overallStatus === "failed" ? "failed" : "passed",
    p_certificate_fingerprint_sha256: payload.checks.tls.certificateFingerprintSha256,
    p_san_set_sha256: payload.checks.tls.sanSetSha256,
    p_certificate_not_before: payload.checks.tls.certificateNotBefore,
    p_certificate_not_after: payload.checks.tls.certificateNotAfter,
    p_negotiated_protocol: payload.checks.tls.negotiatedProtocol,
    p_http_status: payload.checks.https.statusCode,
    p_attempted_at: payload.startedAt,
    p_completed_at: payload.completedAt,
    p_error_code: payload.overallStatus === "failed" ? "EXTERNAL_SITE_PROBE_FAILED" : null,
    p_evidence_sha256: payload.evidenceSha256,
    p_details: {
      monitorKind: "external_site_monitor",
      contractVersion: EXTERNAL_SITE_MONITOR_SCHEMA_VERSION,
      keyId: input.keyId,
      payload,
    },
  });
  if (error) {
    const code = databaseErrorCode(error);
    throw new ExternalSiteMonitorError(
      code,
      code === "EXTERNAL_SITE_MONITOR_MIGRATION_REQUIRED"
        ? "外部站点监测迁移尚未应用"
        : code === "EXTERNAL_SITE_MONITOR_REPLAY_REJECTED"
          ? "重复探针请求已拒绝"
          : "外部站点监测证据暂时无法持久化",
      code.includes("REPLAY") ? 409 : 503,
      error,
    );
  }
  const result = record(data);
  if (!result || result.accepted !== true || typeof result.probeId !== "string") {
    throw new ExternalSiteMonitorError("EXTERNAL_SITE_MONITOR_INGEST_RESULT_INVALID", "探针摄取回执无效", 503);
  }
  invalidateExternalSiteMonitorCache();
  return {
    accepted: true,
    duplicate: result.duplicate === true,
    probeId: result.probeId,
    hostname: payload.target.hostname,
    receivedAt: typeof result.receivedAt === "string" ? result.receivedAt : new Date(nowMs).toISOString(),
  };
}

function parseLatestPayload(row: UnknownRecord): ExternalSiteMonitorInternalProbe | null {
  const latest = record(row.latestProbe);
  if (!latest) return null;
  const details = record(latest.details);
  if (!details || details.monitorKind !== "external_site_monitor") return null;
  try {
    const payload = parseExternalSiteProbePayload(details.payload);
    verifyEvidenceDigest(payload);
    return {
      ...payload,
      probeId: typeof latest.probeId === "string" ? latest.probeId : "unknown",
      receivedAt: typeof latest.receivedAt === "string" ? latest.receivedAt : payload.completedAt,
    };
  } catch {
    return null;
  }
}

function targetState(payload: ExternalSiteMonitorInternalProbe | null, nowMs: number, staleAfterSeconds: number): ExternalSiteMonitorActivationState {
  if (!payload) return "unavailable";
  if (nowMs - Date.parse(payload.completedAt) > staleAfterSeconds * 1_000) return "stale";
  return payload.overallStatus === "passed" ? "active" : "degraded";
}

function storedHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 4
    || normalized.length > 253
    || normalized.includes("..")
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/u.test(normalized)) return null;
  return normalized;
}

function projectProbeForBrowser(payload: ExternalSiteMonitorInternalProbe): ExternalSiteMonitorBrowserProbe {
  return {
    completedAt: payload.completedAt,
    vantage: {
      region: payload.vantage.region,
    },
    checks: {
      dns: {
        state: payload.checks.dns.state,
        durationMs: payload.checks.dns.durationMs,
        ipv4Count: payload.checks.dns.ipv4Count,
        ipv6Count: payload.checks.dns.ipv6Count,
      },
      tls: {
        state: payload.checks.tls.state,
        durationMs: payload.checks.tls.durationMs,
        negotiatedProtocol: payload.checks.tls.negotiatedProtocol,
        certificateNotAfter: payload.checks.tls.certificateNotAfter,
        daysRemaining: payload.checks.tls.daysRemaining,
      },
      https: {
        state: payload.checks.https.state,
        durationMs: payload.checks.https.durationMs,
        statusCode: payload.checks.https.statusCode,
        contentType: payload.checks.https.contentType,
      },
      staticAssets: {
        state: payload.checks.staticAssets.state,
        checkedCount: payload.checks.staticAssets.checkedCount,
        items: payload.checks.staticAssets.items.map((item) => ({
          path: item.path,
          statusCode: item.statusCode,
        })),
      },
      loginDom: {
        state: payload.checks.loginDom.state,
        durationMs: payload.checks.loginDom.durationMs,
        statusCode: payload.checks.loginDom.statusCode,
        markers: payload.checks.loginDom.markers.map((marker) => ({ present: marker.present })),
      },
    },
  };
}

function projectTargetForBrowser(target: ExternalSiteMonitorInternalTargetSnapshot): ExternalSiteMonitorTargetSnapshot {
  return {
    hostname: target.hostname,
    state: target.state,
    latestProbe: target.latestProbe ? projectProbeForBrowser(target.latestProbe) : null,
  };
}

export function buildExternalSiteMonitorSnapshot(input: {
  rawStatus: unknown;
  migrationApplied: boolean;
  ingestSecretConfigured: boolean;
  expectedSchedulerId: string | null;
  expectedIntervalSeconds: number;
  now?: string;
}): ExternalSiteMonitorResponse {
  const requestedNowMs = input.now ? Date.parse(input.now) : Date.now();
  const nowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
  const staleAfterSeconds = Math.max(3 * input.expectedIntervalSeconds, 15 * 60);
  const root = record(input.rawStatus);
  const rows = root && Array.isArray(root.hostnames) ? root.hostnames.slice(0, MAX_TARGETS) : [];
  const internalTargets = rows.flatMap((item): ExternalSiteMonitorInternalTargetSnapshot[] => {
    const row = record(item);
    const hostname = storedHostname(row?.hostname);
    if (!row || !hostname) return [];
    const parsedProbe = parseLatestPayload(row);
    const latestProbe = parsedProbe?.target.hostname === hostname ? parsedProbe : null;
    return [{
      hostname,
      tenantKey: typeof row.tenantKey === "string" ? row.tenantKey : "",
      siteKey: typeof row.siteKey === "string" ? row.siteKey : "",
      state: targetState(latestProbe, nowMs, staleAfterSeconds),
      latestProbe,
    }];
  });
  const latestEpoch = internalTargets.reduce((maximum, target) => {
    const epoch = target.latestProbe ? Date.parse(target.latestProbe.completedAt) : Number.NEGATIVE_INFINITY;
    return Number.isFinite(epoch) ? Math.max(maximum, epoch) : maximum;
  }, Number.NEGATIVE_INFINITY);
  const latestAt = Number.isFinite(latestEpoch) ? new Date(latestEpoch).toISOString() : null;
  const ageSeconds = latestAt ? Math.max(0, Math.floor((nowMs - Date.parse(latestAt)) / 1_000)) : null;
  const schedulerMatches = internalTargets.some((target) => (
    target.latestProbe !== null
    && (!input.expectedSchedulerId || target.latestProbe.schedulerId === input.expectedSchedulerId)
  ));
  const recentTargets = internalTargets.filter((target) => target.state === "active" || target.state === "degraded");
  const observed = recentTargets.length > 0 && schedulerMatches;

  let activationState: ExternalSiteMonitorActivationState = "unavailable";
  let reasonCode = "EXTERNAL_MONITOR_NOT_ACTIVATED";
  if (!input.migrationApplied) reasonCode = "EXTERNAL_SITE_MONITOR_MIGRATION_REQUIRED";
  else if (!input.ingestSecretConfigured) reasonCode = "EXTERNAL_SITE_MONITOR_INGEST_SECRET_REQUIRED";
  else if (!input.expectedSchedulerId) reasonCode = "EXTERNAL_SITE_MONITOR_SCHEDULER_ID_REQUIRED";
  else if (internalTargets.length === 0) reasonCode = "EXTERNAL_SITE_MONITOR_TARGETS_REQUIRED";
  else if (!latestAt) reasonCode = "EXTERNAL_SITE_MONITOR_EXTERNAL_SAMPLE_REQUIRED";
  else if (recentTargets.length === 0) {
    activationState = "stale";
    reasonCode = "EXTERNAL_SITE_MONITOR_SAMPLE_STALE";
  } else if (recentTargets.some((target) => target.state === "degraded") || recentTargets.length < internalTargets.length) {
    activationState = "degraded";
    reasonCode = "EXTERNAL_SITE_MONITOR_DEGRADED";
  } else {
    activationState = "active";
    reasonCode = "EXTERNAL_SITE_MONITOR_ACTIVE";
  }

  const productionReady = activationState === "active"
    && input.migrationApplied
    && input.ingestSecretConfigured
    && Boolean(input.expectedSchedulerId)
    && observed;
  const nextRefreshAt = latestAt
    ? new Date(Date.parse(latestAt) + input.expectedIntervalSeconds * 1_000).toISOString()
    : new Date(nowMs + input.expectedIntervalSeconds * 1_000).toISOString();
  const response: ExternalSiteMonitorResponse = {
    ok: true,
    schemaVersion: EXTERNAL_SITE_MONITOR_SCHEMA_VERSION,
    nextRefreshAt,
    activation: {
      state: activationState,
      reasonCode,
      productionExternalMonitoringReady: productionReady,
    },
    freshness: {
      ageSeconds,
    },
    rateLimit: {
      minimumIntervalMs: EXTERNAL_SITE_MONITOR_MIN_READ_INTERVAL_MS,
    },
    expectedIntervalSeconds: input.expectedIntervalSeconds,
    targets: internalTargets.map(projectTargetForBrowser),
    sources: [
      {
        id: "external_scheduler",
        label: "独立主机调度器",
        state: observed ? "available" : latestAt ? "stale" : "unavailable",
        detail: observed ? "已收到当前外部观测点签名样本" : "尚未收到满足新鲜度门槛的外部观测样本",
      },
      {
        id: "signed_ingest",
        label: "HMAC 签名摄取",
        state: input.ingestSecretConfigured ? "available" : "unavailable",
        detail: input.ingestSecretConfigured ? "服务端摄取密钥已配置，不会回显" : "摄取密钥未配置，普通管理员不能写入探针结果",
      },
      {
        id: "domain_tls_probes",
        label: "域名与 TLS 证据表",
        state: input.migrationApplied ? "available" : "unavailable",
        detail: input.migrationApplied ? "复用 append-only domain_tls_probes" : "外部监测扩展迁移尚未应用",
      },
    ],
    limitations: [
      "后台读取端点不会从应用服务器内部探测自身，也不会把内部 200 冒充外部可用性。",
      "登录入口只核对服务端 HTML 的关键 DOM 标记，不执行登录、不提交账号密码。",
      "探针仅持久化 DNS 地址集合摘要和检查元数据，不保存原始解析 IP、响应正文或凭据。",
      "自动告警、跨地域多数决、故障切换和恢复执行器尚未接入。",
    ],
  };
  if (!isExternalSiteMonitorResponse(response)) {
    throw new ExternalSiteMonitorError(
      "EXTERNAL_SITE_MONITOR_BROWSER_DTO_INVALID",
      "外部站点监测浏览器响应未通过安全合同校验",
      503,
    );
  }
  return response;
}

async function readDatabaseStatus(): Promise<{ migrationApplied: boolean; rawStatus: unknown }> {
  const client = getSupabaseAdminClient() as unknown as {
    rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: DatabaseError | null }>;
  };
  try {
    const { data, error } = await client.rpc("get_external_site_monitor_status", { p_limit: MAX_TARGETS });
    if (error) {
      const code = databaseErrorCode(error);
      if (code === "EXTERNAL_SITE_MONITOR_MIGRATION_REQUIRED") return { migrationApplied: false, rawStatus: null };
      throw new ExternalSiteMonitorError(code, "外部站点监测证据源暂不可用", 503, error);
    }
    const root = record(data);
    if (root?.migration !== EXTERNAL_SITE_MONITOR_MIGRATION) {
      return { migrationApplied: false, rawStatus: null };
    }
    return { migrationApplied: true, rawStatus: data };
  } catch (error) {
    if (error instanceof ExternalSiteMonitorError) throw error;
    const code = databaseErrorCode(record(error) as DatabaseError | null);
    if (code === "EXTERNAL_SITE_MONITOR_MIGRATION_REQUIRED") return { migrationApplied: false, rawStatus: null };
    throw new ExternalSiteMonitorError(code, "外部站点监测证据源暂不可用", 503, error);
  }
}

function cacheState(): ExternalMonitorCacheState | undefined {
  return globalThis.__agentHubExternalSiteMonitorCacheV1;
}

export function invalidateExternalSiteMonitorCache(): void {
  globalThis.__agentHubExternalSiteMonitorCacheV1 = undefined;
}

export function readCachedExternalSiteMonitorSnapshot(): ExternalSiteMonitorResponse | null {
  return cacheState()?.value || null;
}

export async function readExternalSiteMonitorSnapshot(nowMs = Date.now()): Promise<ExternalSiteMonitorResponse> {
  const cached = cacheState();
  if (cached && cached.expiresAt > nowMs) {
    return cached.value || await cached.promise;
  }
  const promise = (async () => {
    const database = await readDatabaseStatus();
    return buildExternalSiteMonitorSnapshot({
      rawStatus: database.rawStatus,
      migrationApplied: database.migrationApplied,
      ingestSecretConfigured: Boolean(externalSiteMonitorIngestSecret()),
      expectedSchedulerId: expectedSchedulerId(),
      expectedIntervalSeconds: expectedIntervalSeconds(),
      now: new Date(nowMs).toISOString(),
    });
  })();
  const next: ExternalMonitorCacheState = {
    expiresAt: nowMs + EXTERNAL_SITE_MONITOR_CACHE_TTL_MS,
    promise,
    settled: false,
    value: null,
  };
  globalThis.__agentHubExternalSiteMonitorCacheV1 = next;
  try {
    const value = await promise;
    next.settled = true;
    next.value = value;
    return value;
  } catch (error) {
    if (globalThis.__agentHubExternalSiteMonitorCacheV1 === next) {
      globalThis.__agentHubExternalSiteMonitorCacheV1 = undefined;
    }
    throw error;
  }
}

export class ExternalSiteMonitorAdmissionGate {
  private readonly entries = new Map<string, ExternalMonitorAdmissionEntry>();

  constructor(private readonly minimumIntervalMs = EXTERNAL_SITE_MONITOR_MIN_READ_INTERVAL_MS) {}

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && nowMs - entry.lastTouchedAtMs > ADMISSION_TTL_MS) this.entries.delete(key);
    }
    if (this.entries.size <= MAX_ADMISSION_ENTRIES) return;
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => !entry.inFlight)
      .sort((left, right) => left[1].lastTouchedAtMs - right[1].lastTouchedAtMs);
    for (const [key] of candidates.slice(0, this.entries.size - MAX_ADMISSION_ENTRIES)) this.entries.delete(key);
  }

  async run<T>(actorId: string, action: () => Promise<T>, nowMs = Date.now()): Promise<ExternalMonitorAdmissionResult<T>> {
    this.prune(nowMs);
    const entry = this.entries.get(actorId) || { inFlight: false, lastAllowedAtMs: null, lastTouchedAtMs: nowMs };
    entry.lastTouchedAtMs = nowMs;
    this.entries.set(actorId, entry);
    if (entry.inFlight) {
      return { allowed: false, reason: "single_flight", retryAfterMs: 1_000, nextAllowedAtMs: nowMs + 1_000 };
    }
    if (entry.lastAllowedAtMs !== null) {
      const nextAllowedAtMs = entry.lastAllowedAtMs + this.minimumIntervalMs;
      if (nowMs < nextAllowedAtMs) {
        return { allowed: false, reason: "minimum_interval", retryAfterMs: nextAllowedAtMs - nowMs, nextAllowedAtMs };
      }
    }
    entry.inFlight = true;
    entry.lastAllowedAtMs = nowMs;
    try {
      const value = await action();
      return { allowed: true, value, nextAllowedAtMs: nowMs + this.minimumIntervalMs };
    } finally {
      entry.inFlight = false;
      entry.lastTouchedAtMs = Date.now();
    }
  }
}

function admissionGate(): ExternalSiteMonitorAdmissionGate {
  if (!globalThis.__agentHubExternalSiteMonitorAdmissionV1) {
    globalThis.__agentHubExternalSiteMonitorAdmissionV1 = new ExternalSiteMonitorAdmissionGate();
  }
  return globalThis.__agentHubExternalSiteMonitorAdmissionV1;
}

export async function readExternalSiteMonitorForAdmin(actorId: string) {
  return admissionGate().run(actorId, () => readExternalSiteMonitorSnapshot());
}
