import "server-only";

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  COMMAND_CENTER_DEFINITION_VERSION,
  type CommandCenterMetric,
  type CommandCenterView,
} from "@/lib/admin-command-center-domain";
import {
  SLO_METRIC_HISTORY_DESIGN_VERSION,
  SLO_METRIC_REGISTRY,
  SLO_METRIC_REGISTRY_REFRESH_MS,
  SLO_METRIC_REGISTRY_SCHEMA_VERSION,
  SLO_METRIC_REGISTRY_VERSION,
  sloMetricAvailability,
  type SloMetricAvailability,
  type SloMetricRegistryItem,
  type SloMetricRegistrySnapshot,
} from "@/lib/slo-metric-registry";
import { readAdminCommandCenterSnapshot } from "@/lib/server/admin-command-center";
import { readIncidentSloStatus } from "@/lib/server/incident-slo-control-plane";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type UnknownRecord = Record<string, unknown>;
type DatabaseError = { code?: string | null; message?: string | null; details?: string | null };
type DatabaseResult = { data: unknown; error: DatabaseError | null; count?: number | null };

interface DatabaseQuery extends PromiseLike<DatabaseResult> {
  select(columns: string, options?: { count?: "exact" }): DatabaseQuery;
  order(column: string, options: { ascending: boolean }): DatabaseQuery;
  limit(value: number): DatabaseQuery;
  in(column: string, values: string[]): DatabaseQuery;
}

interface RegistryDatabaseClient {
  from(table: string): DatabaseQuery;
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<DatabaseResult>;
}

interface RegistryCacheEntry {
  expiresAt: number;
  settled: boolean;
  promise: Promise<SloMetricRegistrySnapshot>;
}

interface HistoryReadResult {
  state: "available" | "unavailable";
  reasonCode: string | null;
  latestCaptureAt: string | null;
  runCount: number | null;
  pointsByMetric: Map<string, SloMetricRegistryItem["history"]["points"]>;
}

const CURRENT_VIEWS: readonly CommandCenterView[] = [
  "members",
  "revenue",
  "production",
  "security",
  "system",
  "evidence",
] as const;
const CACHE_TTL_MS = 60_000;
const MAX_REGISTRY_CACHE_ENTRIES = 32;
const MAX_REGISTRY_BUILD_CONCURRENCY = 2;
const MAX_HISTORY_POINTS = 24;
const MAX_HISTORY_ROWS = SLO_METRIC_REGISTRY.length * MAX_HISTORY_POINTS;
const registryCache = new Map<string, RegistryCacheEntry>();
const registryBuildWaiters: Array<() => void> = [];
let activeRegistryBuilds = 0;

function pruneRegistryCache(now: number): void {
  for (const [key, entry] of registryCache) {
    if (entry.settled && entry.expiresAt <= now) registryCache.delete(key);
  }
  while (registryCache.size >= MAX_REGISTRY_CACHE_ENTRIES) {
    const oldestKey = registryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    registryCache.delete(oldestKey);
  }
}

async function withRegistryBuildSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRegistryBuilds >= MAX_REGISTRY_BUILD_CONCURRENCY) {
    await new Promise<void>((resolve) => registryBuildWaiters.push(resolve));
  }
  activeRegistryBuilds += 1;
  try {
    return await operation();
  } finally {
    activeRegistryBuilds -= 1;
    registryBuildWaiters.shift()?.();
  }
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.filter((row): row is UnknownRecord => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHistorySchemaUnavailable(error: DatabaseError | null): boolean {
  if (!error) return false;
  const code = String(error.code || "");
  const detail = `${error.message || ""} ${error.details || ""}`;
  return code === "42P01"
    || code === "42883"
    || code === "PGRST202"
    || code === "PGRST205"
    || /admin_metric_snapshot_(?:runs|values)|capture_admin_metric_snapshot|schema cache/u.test(detail);
}

function normalizeAvailability(value: unknown): SloMetricAvailability {
  return value === "available" || value === "partial" || value === "unavailable"
    ? value
    : "unavailable";
}

function normalizeMetricStatus(value: unknown): CommandCenterMetric["status"] {
  return value === "healthy" || value === "warning" || value === "critical" || value === "unknown" || value === "unavailable"
    ? value
    : "unavailable";
}

function normalizeMetricValue(value: unknown): CommandCenterMetric["value"] {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return null;
}

async function readHistory(pointsPerMetric: number): Promise<HistoryReadResult> {
  const empty = new Map<string, SloMetricRegistryItem["history"]["points"]>();
  if (pointsPerMetric <= 0) {
    return { state: "unavailable", reasonCode: "HISTORY_NOT_REQUESTED", latestCaptureAt: null, runCount: null, pointsByMetric: empty };
  }

  const database = getSupabaseAdminClient() as unknown as RegistryDatabaseClient;
  const runResult = await database
    .from("admin_metric_snapshot_runs")
    .select("id,captured_at,registry_version,status", { count: "exact" })
    .order("captured_at", { ascending: false })
    .limit(pointsPerMetric);
  if (runResult.error) {
    return {
      state: "unavailable",
      reasonCode: isHistorySchemaUnavailable(runResult.error) ? "HISTORY_MIGRATION_NOT_APPLIED" : "HISTORY_READ_FAILED",
      latestCaptureAt: null,
      runCount: null,
      pointsByMetric: empty,
    };
  }

  const runs = records(runResult.data);
  const runIds = runs.map((row) => stringValue(row.id)).filter((value): value is string => Boolean(value));
  const latestCaptureAt = runs.map((row) => stringValue(row.captured_at)).find(Boolean) || null;
  if (runIds.length === 0) {
    return {
      state: "available",
      reasonCode: "HISTORY_EMPTY",
      latestCaptureAt,
      runCount: typeof runResult.count === "number" ? runResult.count : 0,
      pointsByMetric: empty,
    };
  }

  const valueResult = await database
    .from("admin_metric_snapshot_values")
    .select("run_id,metric_id,value_json,metric_status,availability,captured_at")
    .in("run_id", runIds)
    .order("captured_at", { ascending: false })
    .limit(Math.min(MAX_HISTORY_ROWS, runIds.length * SLO_METRIC_REGISTRY.length));
  if (valueResult.error) {
    return {
      state: "unavailable",
      reasonCode: isHistorySchemaUnavailable(valueResult.error) ? "HISTORY_MIGRATION_NOT_APPLIED" : "HISTORY_READ_FAILED",
      latestCaptureAt,
      runCount: typeof runResult.count === "number" ? runResult.count : null,
      pointsByMetric: empty,
    };
  }

  const pointsByMetric = new Map<string, SloMetricRegistryItem["history"]["points"]>();
  for (const row of records(valueResult.data)) {
    const metricId = stringValue(row.metric_id);
    const capturedAt = stringValue(row.captured_at);
    if (!metricId || !capturedAt || !SLO_METRIC_REGISTRY.some((entry) => entry.id === metricId)) continue;
    const current = pointsByMetric.get(metricId) || [];
    if (current.length >= pointsPerMetric) continue;
    current.push({
      capturedAt,
      value: normalizeMetricValue(row.value_json),
      metricStatus: normalizeMetricStatus(row.metric_status),
      availability: normalizeAvailability(row.availability),
    });
    pointsByMetric.set(metricId, current);
  }
  return {
    state: "available",
    reasonCode: pointsByMetric.size > 0 ? null : "HISTORY_EMPTY",
    latestCaptureAt,
    runCount: typeof runResult.count === "number" ? runResult.count : runs.length,
    pointsByMetric,
  };
}

async function readCurrentMetrics(windowHours: number): Promise<{
  metrics: Map<string, CommandCenterMetric>;
  asOf: string;
}> {
  const results = await Promise.allSettled(CURRENT_VIEWS.map((view) => (
    readAdminCommandCenterSnapshot({ hours: windowHours, view })
  )));
  const metrics = new Map<string, CommandCenterMetric>();
  let latestAsOf = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const asOfEpoch = Date.parse(result.value.asOf);
    if (Number.isFinite(asOfEpoch)) latestAsOf = Math.max(latestAsOf, asOfEpoch);
    for (const entry of result.value.sections.flatMap((section) => section.metrics)) metrics.set(entry.id, entry);
  }
  return {
    metrics,
    asOf: latestAsOf > 0 ? new Date(latestAsOf).toISOString() : new Date().toISOString(),
  };
}

async function buildSnapshot(windowHours: number, historyPoints: number): Promise<SloMetricRegistrySnapshot> {
  const startedAt = performance.now();
  const [current, history, incidentResult] = await Promise.all([
    readCurrentMetrics(windowHours),
    readHistory(historyPoints),
    readIncidentSloStatus().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const, value: null })),
  ]);

  const metrics = SLO_METRIC_REGISTRY.map((definition): SloMetricRegistryItem => {
    const value = current.metrics.get(definition.id);
    const sourceIds = value?.sourceIds || [];
    const availability = value
      ? sloMetricAvailability({ value: value.value, status: value.status, partial: value.partial, sourceIds })
      : "unavailable";
    const points = history.pointsByMetric.get(definition.id) || [];
    return {
      ...definition,
      current: {
        value: value?.value ?? null,
        unit: definition.unit,
        metricStatus: value?.status || "unavailable",
        availability,
        partial: value?.partial ?? true,
        asOf: value?.asOf ?? null,
        freshnessSeconds: value?.freshnessSeconds ?? null,
        coverageRatio: value?.coverageRatio ?? null,
        sourceIds,
      },
      history: {
        state: history.state,
        points,
      },
    };
  });

  const available = metrics.filter((entry) => entry.current.availability === "available").length;
  const partial = metrics.filter((entry) => entry.current.availability === "partial").length;
  const unavailable = metrics.filter((entry) => entry.current.availability === "unavailable").length;
  const historyConnected = metrics.filter((entry) => entry.history.points.length > 0).length;
  const incident = incidentResult.ok ? incidentResult.value : null;
  const incidentDefinitions = incident?.database.definitions.length ?? null;
  const incidentAvailable = incident?.database.measurements.available ?? null;
  const incidentCollectorsConnected = Boolean(incident?.integration.collectorsConnected);
  const buildDurationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const deliveredAt = new Date();

  return {
    schemaVersion: SLO_METRIC_REGISTRY_SCHEMA_VERSION,
    registryVersion: SLO_METRIC_REGISTRY_VERSION,
    commandCenterDefinitionVersion: COMMAND_CENTER_DEFINITION_VERSION,
    asOf: current.asOf,
    freshnessSeconds: Math.max(0, Math.floor((deliveredAt.getTime() - Date.parse(current.asOf)) / 1_000)),
    windowHours,
    summary: {
      registered: metrics.length,
      expected: 41,
      coverageRatio: metrics.length / 41,
      available,
      partial,
      unavailable,
      historyConnected,
    },
    historyPersistence: {
      state: history.state,
      designVersion: SLO_METRIC_HISTORY_DESIGN_VERSION,
      reasonCode: history.reasonCode,
      latestCaptureAt: history.latestCaptureAt,
      runCount: history.runCount,
      boundedPointsPerMetric: historyPoints,
    },
    incidentSlo: {
      state: incident && incidentCollectorsConnected ? "available" : "unavailable",
      migrationApplied: incident?.migrationApplied ?? null,
      collectorsConnected: incidentCollectorsConnected,
      definitions: incidentDefinitions,
      availableMeasurements: incidentAvailable,
      note: incidentCollectorsConnected
        ? "事故与 SLO 采集器已接入；注册表历史仍以独立快照表为准。"
        : "事故与 SLO 控制面尚未接入采集器，不会把空测量解释为 0 或健康。",
    },
    metrics,
    readBudget: {
      commandCenterViews: CURRENT_VIEWS.length,
      maximumHistoryRuns: historyPoints,
      maximumHistoryRows: Math.min(MAX_HISTORY_ROWS, historyPoints * SLO_METRIC_REGISTRY.length),
      providerCalls: 0,
      businessWrites: 0,
    },
    refresh: {
      pollIntervalMs: SLO_METRIC_REGISTRY_REFRESH_MS,
      nextRefreshAt: new Date(deliveredAt.getTime() + SLO_METRIC_REGISTRY_REFRESH_MS).toISOString(),
      cacheStatus: "miss",
      buildDurationMs,
      rateLimit: {
        scope: "process-local-admin",
        limit: 1,
        intervalMs: 60_000,
        remaining: 1,
        retryAfterSeconds: 0,
        nextAllowedAt: deliveredAt.toISOString(),
      },
      readOnly: true,
    },
  };
}

function deliveredSnapshot(
  snapshot: SloMetricRegistrySnapshot,
  cacheStatus: SloMetricRegistrySnapshot["refresh"]["cacheStatus"],
): SloMetricRegistrySnapshot {
  const deliveredAt = Date.now();
  const asOfEpoch = Date.parse(snapshot.asOf);
  return {
    ...snapshot,
    freshnessSeconds: Number.isFinite(asOfEpoch) ? Math.max(0, Math.floor((deliveredAt - asOfEpoch) / 1_000)) : 0,
    refresh: {
      ...snapshot.refresh,
      cacheStatus,
      nextRefreshAt: new Date(deliveredAt + SLO_METRIC_REGISTRY_REFRESH_MS).toISOString(),
    },
  };
}

export async function readSloMetricRegistrySnapshot(options: {
  windowHours: number;
  historyPoints: number;
  bypassCache?: boolean;
}): Promise<SloMetricRegistrySnapshot> {
  const windowHours = Math.min(24 * 7, Math.max(1, Math.round(options.windowHours)));
  const historyPoints = Math.min(MAX_HISTORY_POINTS, Math.max(0, Math.round(options.historyPoints)));
  const key = `${windowHours}:${historyPoints}`;
  const now = Date.now();
  const cached = registryCache.get(key);
  if (cached && !cached.settled) return deliveredSnapshot(await cached.promise, "shared");
  if (!options.bypassCache && cached && cached.expiresAt > now) return deliveredSnapshot(await cached.promise, "hit");

  const entry: RegistryCacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    settled: false,
    promise: Promise.resolve(null as unknown as SloMetricRegistrySnapshot),
  };
  entry.promise = withRegistryBuildSlot(() => buildSnapshot(windowHours, historyPoints))
    .catch((error) => {
      if (registryCache.get(key) === entry) registryCache.delete(key);
      throw error;
    })
    .finally(() => {
      entry.settled = true;
    });
  pruneRegistryCache(now);
  registryCache.set(key, entry);
  return deliveredSnapshot(await entry.promise, "miss");
}

export function sloMetricCapturePayload(snapshot: SloMetricRegistrySnapshot): {
  sourceDigest: string;
  metrics: Array<Record<string, unknown>>;
} {
  const metrics = snapshot.metrics.map((entry) => ({
    metricId: entry.id,
    value: entry.current.value,
    unit: entry.current.unit,
    metricStatus: entry.current.metricStatus,
    availability: entry.current.availability,
    partial: entry.current.partial,
    asOf: entry.current.asOf,
    freshnessSeconds: entry.current.freshnessSeconds,
    coverageRatio: entry.current.coverageRatio,
    sourceIds: entry.current.sourceIds,
  }));
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ registryVersion: snapshot.registryVersion, asOf: snapshot.asOf, metrics }))
    .digest("hex");
  return { sourceDigest, metrics };
}

export async function persistSloMetricSnapshot(input: {
  requestKey: string;
  actor: string;
  snapshot: SloMetricRegistrySnapshot;
}): Promise<unknown> {
  const database = getSupabaseAdminClient() as unknown as RegistryDatabaseClient;
  const payload = sloMetricCapturePayload(input.snapshot);
  const result = await database.rpc("capture_admin_metric_snapshot", {
    p_capture_key: input.requestKey,
    p_registry_version: input.snapshot.registryVersion,
    p_window_hours: input.snapshot.windowHours,
    p_captured_at: input.snapshot.asOf,
    p_source_digest: payload.sourceDigest,
    p_metrics: payload.metrics,
    p_actor: input.actor,
  });
  if (result.error) {
    const code = isHistorySchemaUnavailable(result.error)
      ? "HISTORY_MIGRATION_NOT_APPLIED"
      : "HISTORY_CAPTURE_FAILED";
    throw Object.assign(new Error(code), { code });
  }
  return result.data;
}
