import "server-only";

import crypto from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import {
  RUNTIME_TELEMETRY_IDLE_AFTER_MS,
  RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
  RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE,
  RUNTIME_TELEMETRY_RETENTION_SAMPLES,
  RUNTIME_TELEMETRY_SAMPLE_INTERVAL_MS,
  RUNTIME_TELEMETRY_SCHEMA_VERSION,
  RUNTIME_TELEMETRY_SCOPE,
  createRuntimeTelemetryUnavailableMetrics,
  runtimeTelemetryFreshness,
  type RuntimeTelemetryResponse,
  type RuntimeTelemetrySample,
} from "@/lib/runtime-telemetry-contract";

type EventLoopSnapshot = ReturnType<typeof performance.eventLoopUtilization>;
type EventLoopDelayHistogram = ReturnType<typeof monitorEventLoopDelay>;

interface RuntimeTelemetrySamplerState {
  startedAtMs: number;
  lastReadAtMs: number;
  nextSampleAtMs: number | null;
  previousWallAtMs: number;
  previousCpuUsage: NodeJS.CpuUsage;
  previousEventLoop: EventLoopSnapshot;
  eventLoopDelay: EventLoopDelayHistogram;
  eventLoopDelayEnabled: boolean;
  lifecycle: "running" | "idle_suspended";
  samples: RuntimeTelemetrySample[];
  timer: NodeJS.Timeout | null;
}

interface RuntimeTelemetryAdmissionEntry {
  inFlight: boolean;
  lastAllowedAtMs: number | null;
  lastTouchedAtMs: number;
}

export type RuntimeTelemetryAdmissionResult<T> =
  | {
      allowed: true;
      value: T;
      admittedAtMs: number;
      nextAllowedAtMs: number;
    }
  | {
      allowed: false;
      reason: "single_flight" | "minimum_interval";
      retryAfterMs: number;
      nextAllowedAtMs: number;
    };

declare global {
  // These process globals keep hot reloads and repeated route evaluation from
  // starting a second sampler or a second admission gate in the same process.
  var __agentHubRuntimeTelemetrySamplerV1: RuntimeTelemetrySamplerState | undefined;
  var __agentHubRuntimeTelemetryAdmissionGateV1: RuntimeTelemetryAdmissionGate | undefined;
}

const NS_PER_MS = 1_000_000;
const ADMISSION_ENTRY_TTL_MS = 10 * 60 * 1_000;
const MAX_ADMISSION_ENTRIES = 1_024;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value: number, digits = 2): number | null {
  return Number.isFinite(value) ? round(value, digits) : null;
}

function copyMemoryUsage(): RuntimeTelemetrySample["memory"] {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function createWarmupSample(nowMs: number): RuntimeTelemetrySample {
  return {
    sampledAt: new Date(nowMs).toISOString(),
    intervalMs: null,
    cpuDelta: {
      status: "warming_up",
      userMicros: null,
      systemMicros: null,
      totalMicros: null,
      percentOfSingleCore: null,
    },
    memory: copyMemoryUsage(),
    eventLoop: {
      status: "warming_up",
      utilization: null,
      utilizationPercent: null,
      delayMeanMs: null,
      delayP50Ms: null,
      delayP95Ms: null,
      delayMaxMs: null,
    },
    uptimeSeconds: round(process.uptime(), 3),
  };
}

export function calculateCpuPercentOfSingleCore(totalMicros: number, intervalMs: number): number | null {
  if (!Number.isFinite(totalMicros) || totalMicros < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return round((totalMicros / (intervalMs * 1_000)) * 100, 2);
}

function collectRuntimeTelemetrySample(state: RuntimeTelemetrySamplerState, nowMs: number): RuntimeTelemetrySample {
  const intervalMs = Math.max(1, nowMs - state.previousWallAtMs);
  const cpuNow = process.cpuUsage();
  const cpuDelta = {
    user: Math.max(0, cpuNow.user - state.previousCpuUsage.user),
    system: Math.max(0, cpuNow.system - state.previousCpuUsage.system),
  };
  const totalMicros = cpuDelta.user + cpuDelta.system;

  const eventLoopNow = performance.eventLoopUtilization();
  const eventLoopDelta = performance.eventLoopUtilization(eventLoopNow, state.previousEventLoop);
  const delayHasSamples = state.eventLoopDelay.count > 0;
  const sample: RuntimeTelemetrySample = {
    sampledAt: new Date(nowMs).toISOString(),
    intervalMs,
    cpuDelta: {
      status: "available",
      userMicros: cpuDelta.user,
      systemMicros: cpuDelta.system,
      totalMicros,
      percentOfSingleCore: calculateCpuPercentOfSingleCore(totalMicros, intervalMs),
    },
    memory: copyMemoryUsage(),
    eventLoop: {
      status: "available",
      utilization: finiteOrNull(eventLoopDelta.utilization, 6),
      utilizationPercent: finiteOrNull(eventLoopDelta.utilization * 100, 2),
      delayMeanMs: delayHasSamples ? finiteOrNull(state.eventLoopDelay.mean / NS_PER_MS, 3) : null,
      delayP50Ms: delayHasSamples ? finiteOrNull(state.eventLoopDelay.percentile(50) / NS_PER_MS, 3) : null,
      delayP95Ms: delayHasSamples ? finiteOrNull(state.eventLoopDelay.percentile(95) / NS_PER_MS, 3) : null,
      delayMaxMs: delayHasSamples ? finiteOrNull(state.eventLoopDelay.max / NS_PER_MS, 3) : null,
    },
    uptimeSeconds: round(process.uptime(), 3),
  };

  state.previousWallAtMs = nowMs;
  state.previousCpuUsage = cpuNow;
  state.previousEventLoop = eventLoopNow;
  state.eventLoopDelay.reset();
  state.samples.push(sample);
  if (state.samples.length > RUNTIME_TELEMETRY_RETENTION_SAMPLES) {
    state.samples.splice(0, state.samples.length - RUNTIME_TELEMETRY_RETENTION_SAMPLES);
  }
  return sample;
}

function suspendRuntimeTelemetrySampler(state: RuntimeTelemetrySamplerState): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.nextSampleAtMs = null;
  if (state.eventLoopDelayEnabled) {
    state.eventLoopDelay.disable();
    state.eventLoopDelayEnabled = false;
  }
  state.lifecycle = "idle_suspended";
}

function scheduleRuntimeTelemetrySample(state: RuntimeTelemetrySamplerState, nowMs = Date.now()): void {
  if (state.lifecycle !== "running" || state.timer) return;
  const idleRemainingMs = state.lastReadAtMs + RUNTIME_TELEMETRY_IDLE_AFTER_MS - nowMs;
  if (idleRemainingMs <= 0) {
    suspendRuntimeTelemetrySampler(state);
    return;
  }

  const delayMs = Math.max(1, Math.min(RUNTIME_TELEMETRY_SAMPLE_INTERVAL_MS, idleRemainingMs));
  state.nextSampleAtMs = nowMs + delayMs;
  const timer = setTimeout(() => {
    state.timer = null;
    state.nextSampleAtMs = null;
    const sampledAtMs = Date.now();
    if (sampledAtMs - state.lastReadAtMs >= RUNTIME_TELEMETRY_IDLE_AFTER_MS) {
      suspendRuntimeTelemetrySampler(state);
      return;
    }
    try {
      collectRuntimeTelemetrySample(state, sampledAtMs);
    } catch (error) {
      console.error("[runtime-telemetry] background sample failed", error);
    } finally {
      scheduleRuntimeTelemetrySample(state);
    }
  }, delayMs);
  timer.unref();
  state.timer = timer;
}

function createRuntimeTelemetrySampler(): RuntimeTelemetrySamplerState {
  const nowMs = Date.now();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const state: RuntimeTelemetrySamplerState = {
    startedAtMs: nowMs,
    lastReadAtMs: nowMs,
    nextSampleAtMs: nowMs + RUNTIME_TELEMETRY_SAMPLE_INTERVAL_MS,
    previousWallAtMs: nowMs,
    previousCpuUsage: process.cpuUsage(),
    previousEventLoop: performance.eventLoopUtilization(),
    eventLoopDelay,
    eventLoopDelayEnabled: true,
    lifecycle: "running",
    samples: [createWarmupSample(nowMs)],
    timer: null,
  };
  scheduleRuntimeTelemetrySample(state);
  return state;
}

function runtimeTelemetrySampler(): RuntimeTelemetrySamplerState {
  if (!globalThis.__agentHubRuntimeTelemetrySamplerV1) {
    globalThis.__agentHubRuntimeTelemetrySamplerV1 = createRuntimeTelemetrySampler();
  }
  return globalThis.__agentHubRuntimeTelemetrySamplerV1;
}

function recordRuntimeTelemetryRead(state: RuntimeTelemetrySamplerState, nowMs: number): boolean {
  if (state.lifecycle === "running" && nowMs - state.lastReadAtMs >= RUNTIME_TELEMETRY_IDLE_AFTER_MS) {
    suspendRuntimeTelemetrySampler(state);
  }
  const resumedOnThisRead = state.lifecycle === "idle_suspended";
  state.lastReadAtMs = nowMs;
  if (resumedOnThisRead) {
    state.previousWallAtMs = nowMs;
    state.previousCpuUsage = process.cpuUsage();
    state.previousEventLoop = performance.eventLoopUtilization();
    state.eventLoopDelay.reset();
    state.eventLoopDelay.enable();
    state.eventLoopDelayEnabled = true;
    state.lifecycle = "running";
  }
  scheduleRuntimeTelemetrySample(state, nowMs);
  return resumedOnThisRead;
}

export function evaluateRuntimeTelemetryIdleState(nowMs = Date.now()): "running" | "idle_suspended" {
  const state = runtimeTelemetrySampler();
  if (state.lifecycle === "running" && nowMs - state.lastReadAtMs >= RUNTIME_TELEMETRY_IDLE_AFTER_MS) {
    suspendRuntimeTelemetrySampler(state);
  }
  return state.lifecycle;
}

export function readRuntimeTelemetrySnapshot(options: {
  nowMs?: number;
  nextRefreshAtMs?: number;
  rateLimitRemainingMs?: number;
  touchActivity?: boolean;
} = {}): RuntimeTelemetryResponse {
  const state = runtimeTelemetrySampler();
  const nowMs = options.nowMs ?? Date.now();
  let resumedOnThisRead = false;
  if (options.touchActivity === false) evaluateRuntimeTelemetryIdleState(nowMs);
  else resumedOnThisRead = recordRuntimeTelemetryRead(state, nowMs);
  const current = state.samples.at(-1) ?? null;
  const asOf = current?.sampledAt ?? null;
  const measuredFreshness = runtimeTelemetryFreshness(asOf, nowMs);
  const freshness = current?.cpuDelta.status === "warming_up"
    ? { ...measuredFreshness, state: "warming_up" as const }
    : measuredFreshness;
  const remainingMs = Math.max(0, Math.round(options.rateLimitRemainingMs ?? RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS));
  const nextRefreshAtMs = options.nextRefreshAtMs ?? nowMs + remainingMs;

  return {
    ok: true,
    schemaVersion: RUNTIME_TELEMETRY_SCHEMA_VERSION,
    scope: RUNTIME_TELEMETRY_SCOPE,
    readOnly: true,
    asOf,
    freshness,
    nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
    cacheStatus: state.lifecycle === "idle_suspended"
      ? "background_sampler_idle_suspended"
      : resumedOnThisRead
        ? "background_sampler_resumed"
        : current?.cpuDelta.status === "available"
          ? "background_sample_hit"
          : "background_sampler_warming_up",
    rateLimit: {
      scope: RUNTIME_TELEMETRY_RATE_LIMIT_SCOPE,
      policy: "authenticated_admin_process_memory",
      minimumIntervalMs: RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
      remainingMs,
      retryAfterSeconds: Math.ceil(remainingMs / 1_000),
    },
    idlePolicy: {
      idleAfterMs: RUNTIME_TELEMETRY_IDLE_AFTER_MS,
      state: state.lifecycle,
      lastReadAt: new Date(state.lastReadAtMs).toISOString(),
      idleAt: new Date(state.lastReadAtMs + RUNTIME_TELEMETRY_IDLE_AFTER_MS).toISOString(),
      suspendsTimer: true,
      disablesEventLoopDelay: true,
      resumesOnRead: true,
      resumedOnThisRead,
    },
    sampling: {
      intervalMs: RUNTIME_TELEMETRY_SAMPLE_INTERVAL_MS,
      retentionSamples: RUNTIME_TELEMETRY_RETENTION_SAMPLES,
      retainedSamples: state.samples.length,
      persistence: "process_memory_only",
      startedAt: new Date(state.startedAtMs).toISOString(),
    },
    current,
    series: state.samples.slice(),
    unavailable: createRuntimeTelemetryUnavailableMetrics(),
    privacy: {
      includesSecrets: false,
      includesUserData: false,
      includesRoutes: false,
      includesHostIdentity: false,
    },
  };
}

export class RuntimeTelemetryAdmissionGate {
  private readonly entries = new Map<string, RuntimeTelemetryAdmissionEntry>();

  constructor(private readonly minimumIntervalMs = RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS) {}

  private sweep(nowMs: number): void {
    if (this.entries.size <= MAX_ADMISSION_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && nowMs - entry.lastTouchedAtMs > ADMISSION_ENTRY_TTL_MS) this.entries.delete(key);
    }
  }

  async run<T>(
    actorKey: string,
    producer: () => Promise<T>,
    nowMs = Date.now(),
  ): Promise<RuntimeTelemetryAdmissionResult<T>> {
    this.sweep(nowMs);
    const entry = this.entries.get(actorKey) ?? {
      inFlight: false,
      lastAllowedAtMs: null,
      lastTouchedAtMs: nowMs,
    };
    entry.lastTouchedAtMs = nowMs;
    this.entries.set(actorKey, entry);

    const elapsedMs = entry.lastAllowedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - entry.lastAllowedAtMs;
    const intervalRemainingMs = Number.isFinite(elapsedMs)
      ? Math.max(0, this.minimumIntervalMs - elapsedMs)
      : 0;
    if (entry.inFlight) {
      const retryAfterMs = Math.max(1_000, intervalRemainingMs || this.minimumIntervalMs);
      return {
        allowed: false,
        reason: "single_flight",
        retryAfterMs,
        nextAllowedAtMs: nowMs + retryAfterMs,
      };
    }
    if (intervalRemainingMs > 0) {
      return {
        allowed: false,
        reason: "minimum_interval",
        retryAfterMs: intervalRemainingMs,
        nextAllowedAtMs: nowMs + intervalRemainingMs,
      };
    }

    entry.inFlight = true;
    entry.lastAllowedAtMs = nowMs;
    try {
      const value = await producer();
      return {
        allowed: true,
        value,
        admittedAtMs: nowMs,
        nextAllowedAtMs: nowMs + this.minimumIntervalMs,
      };
    } finally {
      entry.inFlight = false;
      entry.lastTouchedAtMs = Date.now();
    }
  }
}

function runtimeTelemetryAdmissionGate(): RuntimeTelemetryAdmissionGate {
  if (!globalThis.__agentHubRuntimeTelemetryAdmissionGateV1) {
    globalThis.__agentHubRuntimeTelemetryAdmissionGateV1 = new RuntimeTelemetryAdmissionGate();
  }
  return globalThis.__agentHubRuntimeTelemetryAdmissionGateV1;
}

function actorAdmissionKey(actorId: string): string {
  return crypto.createHash("sha256").update(actorId).digest("hex");
}

export async function readRuntimeTelemetryForAdmin(
  actorId: string,
  nowMs = Date.now(),
): Promise<RuntimeTelemetryAdmissionResult<RuntimeTelemetryResponse>> {
  return runtimeTelemetryAdmissionGate().run(actorAdmissionKey(actorId), async () => {
    // Hold the single-flight window across one event-loop turn so concurrent
    // route handlers cannot all pass before the first read finishes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return readRuntimeTelemetrySnapshot({
      nowMs: Date.now(),
      nextRefreshAtMs: nowMs + RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
      rateLimitRemainingMs: RUNTIME_TELEMETRY_MIN_REQUEST_INTERVAL_MS,
    });
  }, nowMs);
}
