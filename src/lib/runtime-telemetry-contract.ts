export const RUNTIME_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const RUNTIME_TELEMETRY_SCOPE = "current_web_process" as const;
export const RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE = "process-local-admin" as const;
export const RUNTIME_TELEMETRY_SAMPLE_INTERVAL_MS = 5_000;
export const RUNTIME_TELEMETRY_STALE_AFTER_MS = 15_000;
export const RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS = 15_000;
export const RUNTIME_TELEMETRY_RETENTION_SAMPLES = 60;
export const RUNTIME_TELEMETRY_IDLE_AFTER_MS = 5 * 60 * 1_000;

export type RuntimeTelemetryFreshnessState = "warming_up" | "fresh" | "stale";
export type RuntimeTelemetryCacheStatus =
  | "background_sampler_warming_up"
  | "background_sample_hit"
  | "background_sampler_resumed"
  | "background_sampler_idle_suspended"
  | "rate_limited";

export interface RuntimeTelemetryCpuDelta {
  status: "warming_up" | "available";
  userMicros: number | null;
  systemMicros: number | null;
  totalMicros: number | null;
  percentOfSingleCore: number | null;
}

export interface RuntimeTelemetryMemory {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface RuntimeTelemetryEventLoop {
  status: "warming_up" | "available";
  utilization: number | null;
  utilizationPercent: number | null;
  delayMeanMs: number | null;
  delayP50Ms: number | null;
  delayP95Ms: number | null;
  delayMaxMs: number | null;
}

export interface RuntimeTelemetrySample {
  sampledAt: string;
  intervalMs: number | null;
  cpuDelta: RuntimeTelemetryCpuDelta;
  memory: RuntimeTelemetryMemory;
  eventLoop: RuntimeTelemetryEventLoop;
  uptimeSeconds: number;
}

export interface RuntimeTelemetryFreshness {
  state: RuntimeTelemetryFreshnessState;
  ageMs: number | null;
  staleAfterMs: number;
}

export interface RuntimeTelemetryRateLimit {
  scope: typeof RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE;
  policy: "authenticated_admin_process_memory";
  minimumIntervalMs: number;
  remainingMs: number;
  retryAfterSeconds: number;
}

export interface RuntimeTelemetryIdlePolicy {
  idleAfterMs: number;
  state: "running" | "idle_suspended";
  lastReadAt: string;
  idleAt: string;
  suspendsTimer: true;
  disablesEventLoopDelay: true;
  resumesOnRead: true;
  resumedOnThisRead: boolean;
}

export interface RuntimeTelemetryUnavailableMetric {
  status: "unavailable";
  reason: "not_collected_in_phase_1";
  scope: "host" | "storage" | "network" | "database" | "shared_worker";
  label: string;
}

export interface RuntimeTelemetryUnavailableMetrics {
  hostCpuTotal: RuntimeTelemetryUnavailableMetric;
  hostMemoryTotal: RuntimeTelemetryUnavailableMetric;
  disk: RuntimeTelemetryUnavailableMetric;
  network: RuntimeTelemetryUnavailableMetric;
  databasePool: RuntimeTelemetryUnavailableMetric;
  sharedWorkerHeartbeat: RuntimeTelemetryUnavailableMetric;
}

export interface RuntimeTelemetryResponse {
  ok: true;
  schemaVersion: typeof RUNTIME_TELEMETRY_SCHEMA_VERSION;
  scope: typeof RUNTIME_TELEMETRY_SCOPE;
  readOnly: true;
  asOf: string | null;
  freshness: RuntimeTelemetryFreshness;
  nextRefreshAt: string;
  cacheStatus: Exclude<RuntimeTelemetryCacheStatus, "rate_limited">;
  rateLimit: RuntimeTelemetryRateLimit;
  idlePolicy: RuntimeTelemetryIdlePolicy;
  sampling: {
    intervalMs: number;
    retentionSamples: number;
    retainedSamples: number;
    persistence: "process_memory_only";
    startedAt: string;
  };
  current: RuntimeTelemetrySample | null;
  series: RuntimeTelemetrySample[];
  unavailable: RuntimeTelemetryUnavailableMetrics;
  privacy: {
    includesSecrets: false;
    includesUserData: false;
    includesRoutes: false;
    includesHostIdentity: false;
  };
}

export interface RuntimeTelemetryRateLimitedResponse {
  ok: false;
  code: "RUNTIME_TELEMETRY_RATE_LIMITED";
  error: string;
  scope: typeof RUNTIME_TELEMETRY_SCOPE;
  asOf: string | null;
  freshness: RuntimeTelemetryFreshness;
  nextRefreshAt: string;
  cacheStatus: "rate_limited";
  rateLimit: RuntimeTelemetryRateLimit;
  idlePolicy: RuntimeTelemetryIdlePolicy;
}

export function createRuntimeTelemetryUnavailableMetrics(): RuntimeTelemetryUnavailableMetrics {
  return {
    hostCpuTotal: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "host",
      label: "宿主机 CPU 总量",
    },
    hostMemoryTotal: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "host",
      label: "宿主机总内存",
    },
    disk: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "storage",
      label: "磁盘容量与吞吐",
    },
    network: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "network",
      label: "主机网络流量",
    },
    databasePool: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "database",
      label: "数据库连接池",
    },
    sharedWorkerHeartbeat: {
      status: "unavailable",
      reason: "not_collected_in_phase_1",
      scope: "shared_worker",
      label: "共享 Worker 心跳",
    },
  };
}

export function runtimeTelemetryFreshness(
  asOf: string | null,
  nowMs: number,
  staleAfterMs = RUNTIME_TELEMETRY_STALE_AFTER_MS,
): RuntimeTelemetryFreshness {
  if (!asOf) return { state: "warming_up", ageMs: null, staleAfterMs };
  const sampledAtMs = Date.parse(asOf);
  if (!Number.isFinite(sampledAtMs)) return { state: "stale", ageMs: null, staleAfterMs };
  const ageMs = Math.max(0, Math.round(nowMs - sampledAtMs));
  return {
    state: ageMs <= staleAfterMs ? "fresh" : "stale",
    ageMs,
    staleAfterMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isRuntimeTelemetrySample(value: unknown): value is RuntimeTelemetrySample {
  if (!isRecord(value) || typeof value.sampledAt !== "string") return false;
  if (!isNullableFiniteNumber(value.intervalMs) || !isFiniteNumber(value.uptimeSeconds)) return false;
  if (!isRecord(value.cpuDelta) || !isRecord(value.memory) || !isRecord(value.eventLoop)) return false;
  if (value.cpuDelta.status !== "warming_up" && value.cpuDelta.status !== "available") return false;
  for (const field of ["userMicros", "systemMicros", "totalMicros", "percentOfSingleCore"] as const) {
    if (!isNullableFiniteNumber(value.cpuDelta[field])) return false;
  }
  for (const field of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const) {
    if (!isFiniteNumber(value.memory[field])) return false;
  }
  if (value.eventLoop.status !== "warming_up" && value.eventLoop.status !== "available") return false;
  for (const field of ["utilization", "utilizationPercent", "delayMeanMs", "delayP50Ms", "delayP95Ms", "delayMaxMs"] as const) {
    if (!isNullableFiniteNumber(value.eventLoop[field])) return false;
  }
  return true;
}

export function isRuntimeTelemetryResponse(value: unknown): value is RuntimeTelemetryResponse {
  if (!isRecord(value) || value.ok !== true) return false;
  if (value.schemaVersion !== RUNTIME_TELEMETRY_SCHEMA_VERSION || value.scope !== RUNTIME_TELEMETRY_SCOPE) return false;
  if (value.asOf !== null && typeof value.asOf !== "string") return false;
  if (value.readOnly !== true || typeof value.nextRefreshAt !== "string") return false;
  if (
    value.cacheStatus !== "background_sampler_warming_up"
    && value.cacheStatus !== "background_sample_hit"
    && value.cacheStatus !== "background_sampler_resumed"
    && value.cacheStatus !== "background_sampler_idle_suspended"
  ) return false;
  if (!isRecord(value.freshness) || !isRecord(value.rateLimit) || !isRecord(value.idlePolicy) || !isRecord(value.sampling)) return false;
  if (value.freshness.state !== "warming_up" && value.freshness.state !== "fresh" && value.freshness.state !== "stale") return false;
  if (!isNullableFiniteNumber(value.freshness.ageMs) || !isFiniteNumber(value.freshness.staleAfterMs)) return false;
  if (
    value.rateLimit.scope !== RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE
    || value.rateLimit.policy !== "authenticated_admin_process_memory"
  ) return false;
  if (!isFiniteNumber(value.rateLimit.minimumIntervalMs) || value.rateLimit.minimumIntervalMs < RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS) return false;
  if (!isFiniteNumber(value.rateLimit.remainingMs) || !isFiniteNumber(value.rateLimit.retryAfterSeconds)) return false;
  if (value.idlePolicy.state !== "running" && value.idlePolicy.state !== "idle_suspended") return false;
  if (!isFiniteNumber(value.idlePolicy.idleAfterMs) || value.idlePolicy.idleAfterMs < RUNTIME_TELEMETRY_IDLE_AFTER_MS) return false;
  if (typeof value.idlePolicy.lastReadAt !== "string" || typeof value.idlePolicy.idleAt !== "string") return false;
  if (value.idlePolicy.suspendsTimer !== true || value.idlePolicy.disablesEventLoopDelay !== true || value.idlePolicy.resumesOnRead !== true) return false;
  if (typeof value.idlePolicy.resumedOnThisRead !== "boolean") return false;
  if (!isFiniteNumber(value.sampling.intervalMs) || !isFiniteNumber(value.sampling.retentionSamples) || !isFiniteNumber(value.sampling.retainedSamples)) return false;
  if (value.sampling.persistence !== "process_memory_only" || typeof value.sampling.startedAt !== "string") return false;
  if (!Array.isArray(value.series) || !value.series.every(isRuntimeTelemetrySample)) return false;
  if (value.current !== null && !isRuntimeTelemetrySample(value.current)) return false;
  if (!isRecord(value.unavailable)) return false;
  for (const key of ["hostCpuTotal", "hostMemoryTotal", "disk", "network", "databasePool", "sharedWorkerHeartbeat"] as const) {
    const metric = value.unavailable[key];
    if (!isRecord(metric) || metric.status !== "unavailable" || metric.reason !== "not_collected_in_phase_1" || typeof metric.label !== "string") return false;
  }
  if (!isRecord(value.privacy)) return false;
  for (const field of ["includesSecrets", "includesUserData", "includesRoutes", "includesHostIdentity"] as const) {
    if (value.privacy[field] !== false) return false;
  }
  return true;
}
