import "server-only";

import { createHash } from "node:crypto";

import {
  PRODUCT_USAGE_CACHE_TTL_MS,
  PRODUCT_USAGE_FEATURE_KEYS,
  PRODUCT_USAGE_MIN_COHORT_SIZE,
  PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
  buildProductUsageAnalytics,
  createUnavailableProductUsageMetrics,
  type ProductUsageAggregateEvidence,
  type ProductUsageAnalyticsResponse,
  type ProductUsageFallbackEvidence,
  type ProductUsageFeatureAdoption,
  type ProductUsageMetric,
  type ProductUsageRetentionPoint,
  type ProductUsageValuePathStage,
} from "@/lib/product-usage-contract";
import { pseudonymousUserRef } from "@/lib/operation-flight-recorder";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const QUERY_TIMEOUT_MS = 6_000;
const FALLBACK_ROW_LIMIT = 500;
const ADMISSION_ENTRY_TTL_MS = 10 * 60 * 1_000;
const MAX_ADMISSION_ENTRIES = 2_048;

interface ProductUsageCacheState {
  value: ProductUsageAnalyticsResponse;
  expiresAtMs: number;
}

interface ProductUsageAdmissionEntry {
  inFlight: boolean;
  lastAllowedAtMs: number | null;
  lastTouchedAtMs: number;
}

export type ProductUsageAdmissionResult<T> =
  | { allowed: true; value: T; admittedAtMs: number; nextAllowedAtMs: number }
  | { allowed: false; reason: "single_flight" | "minimum_interval"; retryAfterMs: number; nextAllowedAtMs: number };

declare global {
  var __agentHubProductUsageAnalyticsCacheV1: ProductUsageCacheState | undefined;
  var __agentHubProductUsageAdmissionGateV1: ProductUsageAdmissionGate | undefined;
  var __agentHubProductUsageReadInFlightV1: Promise<ProductUsageAnalyticsResponse> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function finiteRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function safeTimestamp(value: unknown): string | null {
  const text = stringOrNull(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function sourceErrorCode(error: unknown, fallback: string): string {
  if (!isRecord(error)) return fallback;
  const code = stringOrNull(error.code);
  if (code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883") {
    return "PRODUCT_USAGE_FACT_SOURCE_NOT_DEPLOYED";
  }
  return code ? `${fallback}:${code}` : fallback;
}

function privacySafeCount(value: unknown): { value: number | null; suppressed: boolean } {
  const count = finiteNonNegative(value);
  if (count == null) return { value: null, suppressed: false };
  if (count > 0 && count < PRODUCT_USAGE_MIN_COHORT_SIZE) return { value: null, suppressed: true };
  return { value: count, suppressed: false };
}

function parseMetric(value: unknown, fallbackDefinition: string, unit: "users" | "ratio"): ProductUsageMetric {
  const raw = isRecord(value) ? value : {};
  const numerator = privacySafeCount(raw.numerator);
  const denominator = privacySafeCount(raw.denominator);
  const countValue = unit === "users" ? privacySafeCount(raw.value) : { value: null, suppressed: false };
  const privacySuppressed = raw.privacySuppressed === true || numerator.suppressed || denominator.suppressed || countValue.suppressed;
  const metricValue = privacySuppressed
    ? null
    : unit === "ratio"
      ? finiteRatio(raw.value)
      : countValue.value;
  const state = raw.state === "available" || raw.state === "partial" || raw.state === "unavailable"
    ? raw.state
    : metricValue == null ? "unavailable" : "available";
  return {
    state: privacySuppressed && state === "available" ? "partial" : state,
    value: metricValue,
    numerator: privacySuppressed ? null : numerator.value,
    denominator: privacySuppressed ? null : denominator.value,
    unit,
    reasonCode: privacySuppressed ? "SMALL_COHORT_SUPPRESSED" : stringOrNull(raw.reasonCode),
    definition: stringOrNull(raw.definition) || fallbackDefinition,
    privacySuppressed,
  };
}

function parseRetention(value: unknown): ProductUsageRetentionPoint[] {
  if (!Array.isArray(value)) return [];
  const acceptedDays = new Set([1, 7, 30]);
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const day = finiteNonNegative(entry.day);
    if (!day || !acceptedDays.has(day)) return [];
    const retained = privacySafeCount(entry.retainedUsers);
    const eligible = privacySafeCount(entry.eligibleUsers);
    const privacySuppressed = entry.privacySuppressed === true || retained.suppressed || eligible.suppressed;
    const state: ProductUsageRetentionPoint["state"] = privacySuppressed
      ? "partial"
      : entry.state === "available" || entry.state === "partial"
        ? entry.state
        : "unavailable";
    return [{
      day: day as 1 | 7 | 30,
      state,
      retainedUsers: privacySuppressed ? null : retained.value,
      eligibleUsers: privacySuppressed ? null : eligible.value,
      rate: privacySuppressed ? null : finiteRatio(entry.rate),
      reasonCode: privacySuppressed ? "SMALL_COHORT_SUPPRESSED" : stringOrNull(entry.reasonCode),
      privacySuppressed,
    }];
  }).sort((left, right) => left.day - right.day);
}

const FEATURE_LABELS: Record<(typeof PRODUCT_USAGE_FEATURE_KEYS)[number], string> = {
  app_market: "应用广场",
  agent_chat: "智能体对话",
  commercial_ip: "商业 IP 定位",
  copywriting: "文案创作",
  image_generation: "图像生成",
  video_generation: "视频生成",
  voice_generation: "声音制作",
  storyboard: "分镜工作台",
  cover_studio: "封面导演台",
  media_history: "媒体历史",
  commerce: "带货工作台",
  member_center: "会员中心",
  help_center: "帮助中心",
};

function parseFeatureAdoption(value: unknown): ProductUsageFeatureAdoption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.featureKey !== "string" || !PRODUCT_USAGE_FEATURE_KEYS.includes(entry.featureKey as never)) return [];
    const featureKey = entry.featureKey as (typeof PRODUCT_USAGE_FEATURE_KEYS)[number];
    const active = privacySafeCount(entry.activeUsers);
    const mau = privacySafeCount(entry.monthlyActiveUsers);
    const completed = privacySafeCount(entry.workflowCompletedUsers);
    const privacySuppressed = entry.privacySuppressed === true || active.suppressed || mau.suppressed || completed.suppressed;
    return [{
      featureKey,
      label: FEATURE_LABELS[featureKey],
      state: privacySuppressed ? "partial" as const : entry.state === "available" || entry.state === "partial" ? entry.state : "unavailable" as const,
      activeUsers: privacySuppressed ? null : active.value,
      monthlyActiveUsers: privacySuppressed ? null : mau.value,
      adoptionRate: privacySuppressed ? null : finiteRatio(entry.adoptionRate),
      workflowCompletedUsers: privacySuppressed ? null : completed.value,
      reasonCode: privacySuppressed ? "SMALL_COHORT_SUPPRESSED" : stringOrNull(entry.reasonCode),
      privacySuppressed,
    }];
  });
}

const VALUE_PATH_LABELS: Record<ProductUsageValuePathStage["key"], string> = {
  active: "产生合规行为",
  feature_open: "打开核心功能",
  workflow_started: "启动工作流",
  workflow_completed: "完成工作流",
  value_milestone: "到达价值里程碑",
};

function parseValuePath(value: unknown): ProductUsageValuePathStage[] {
  if (!Array.isArray(value)) return [];
  const keys = Object.keys(VALUE_PATH_LABELS) as ProductUsageValuePathStage["key"][];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !keys.includes(entry.key as ProductUsageValuePathStage["key"])) return [];
    const key = entry.key as ProductUsageValuePathStage["key"];
    const users = privacySafeCount(entry.users);
    const privacySuppressed = entry.privacySuppressed === true || users.suppressed;
    return [{
      key,
      label: VALUE_PATH_LABELS[key],
      state: privacySuppressed ? "partial" as const : entry.state === "available" || entry.state === "partial" ? entry.state : "unavailable" as const,
      users: privacySuppressed ? null : users.value,
      conversionFromPrevious: privacySuppressed ? null : finiteRatio(entry.conversionFromPrevious),
      reasonCode: privacySuppressed ? "SMALL_COHORT_SUPPRESSED" : stringOrNull(entry.reasonCode),
      privacySuppressed,
    }];
  });
}

export function parseProductUsageAggregate(value: unknown): ProductUsageAggregateEvidence {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!isRecord(raw)) {
    return {
      state: "unavailable",
      latestRecordAt: null,
      eventCount: null,
      instrumentationStartedAt: null,
      metrics: null,
      retention: [],
      featureAdoption: [],
      valuePath: [],
      errorCode: "PRODUCT_USAGE_AGGREGATE_INVALID",
    };
  }
  const instrumentation = isRecord(raw.instrumentation) ? raw.instrumentation : {};
  const metrics = isRecord(raw.metrics) ? raw.metrics : null;
  const eventCount = finiteNonNegative(instrumentation.eventCount);
  const parsedMetrics = metrics ? {
    dau: parseMetric(metrics.dau, "统计日内至少产生一次合规产品事件的去重会员数。", "users"),
    wau: parseMetric(metrics.wau, "含统计日在内最近 7 个自然日至少产生一次合规产品事件的去重会员数。", "users"),
    mau: parseMetric(metrics.mau, "含统计日在内最近 30 个自然日至少产生一次合规产品事件的去重会员数。", "users"),
    activation: parseMetric(metrics.activation, "注册后 7 天内完成至少一次工作流的新会员占同期符合条件新会员的比例。", "ratio"),
  } : null;
  const metricStates = parsedMetrics ? Object.values(parsedMetrics).map((metric) => metric.state) : [];
  return {
    state: parsedMetrics && metricStates.every((state) => state === "available") ? "available" : "partial",
    latestRecordAt: safeTimestamp(instrumentation.latestRecordAt),
    eventCount,
    instrumentationStartedAt: safeTimestamp(instrumentation.startedAt),
    metrics: parsedMetrics,
    retention: parseRetention(raw.retention),
    featureAdoption: parseFeatureAdoption(raw.featureAdoption),
    valuePath: parseValuePath(raw.valuePath),
    errorCode: parsedMetrics ? null : "PRODUCT_USAGE_AGGREGATE_INCOMPLETE",
  };
}

async function readAggregateEvidence(now: string): Promise<ProductUsageAggregateEvidence> {
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client.rpc("read_admin_product_usage_snapshot_v1", {
      p_window_days: 90,
      p_min_cohort_size: PRODUCT_USAGE_MIN_COHORT_SIZE,
      p_as_of: now,
    }).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error) {
      return {
        state: "unavailable",
        latestRecordAt: null,
        eventCount: null,
        instrumentationStartedAt: null,
        metrics: null,
        retention: [],
        featureAdoption: [],
        valuePath: [],
        errorCode: sourceErrorCode(error, "PRODUCT_USAGE_AGGREGATE_READ_FAILED"),
      };
    }
    return parseProductUsageAggregate(data);
  } catch (error) {
    return {
      state: "unavailable",
      latestRecordAt: null,
      eventCount: null,
      instrumentationStartedAt: null,
      metrics: null,
      retention: [],
      featureAdoption: [],
      valuePath: [],
      errorCode: sourceErrorCode(error, "PRODUCT_USAGE_AGGREGATE_READ_FAILED"),
    };
  }
}

async function readFallbackEvidence(now: string): Promise<ProductUsageFallbackEvidence> {
  const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1_000).toISOString();
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client
      .from("operation_flight_events")
      .select("id,user_id,outcome,occurred_at")
      .gte("occurred_at", since)
      .lte("occurred_at", now)
      .order("occurred_at", { ascending: false })
      .limit(FALLBACK_ROW_LIMIT + 1)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error) {
      return { state: "unavailable", rows: [], rowLimit: FALLBACK_ROW_LIMIT, truncated: false, errorCode: sourceErrorCode(error, "OPERATION_FLIGHT_FALLBACK_READ_FAILED") };
    }
    const sourceRows = Array.isArray(data) ? data : [];
    const truncated = sourceRows.length > FALLBACK_ROW_LIMIT;
    const rows = sourceRows.slice(0, FALLBACK_ROW_LIMIT).flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row.id !== "string") return [];
      return [{
        id: row.id,
        pseudonymousUserRef: pseudonymousUserRef(row.user_id),
        outcome: stringOrNull(row.outcome),
        occurredAt: safeTimestamp(row.occurred_at),
      }];
    });
    return { state: "available", rows, rowLimit: FALLBACK_ROW_LIMIT, truncated, errorCode: null };
  } catch (error) {
    return { state: "unavailable", rows: [], rowLimit: FALLBACK_ROW_LIMIT, truncated: false, errorCode: sourceErrorCode(error, "OPERATION_FLIGHT_FALLBACK_READ_FAILED") };
  }
}

function withCacheStatus(value: ProductUsageAnalyticsResponse, cacheStatus: "hit" | "miss", nowMs = Date.now()): ProductUsageAnalyticsResponse {
  return {
    ...value,
    refresh: {
      ...value.refresh,
      cacheStatus,
      nextRefreshAt: new Date(nowMs + PRODUCT_USAGE_CACHE_TTL_MS).toISOString(),
    },
  };
}

async function produceProductUsageAnalytics(nowMs = Date.now()): Promise<ProductUsageAnalyticsResponse> {
  const now = new Date(nowMs).toISOString();
  const [aggregate, fallback] = await Promise.all([
    readAggregateEvidence(now),
    readFallbackEvidence(now),
  ]);
  const value = buildProductUsageAnalytics({ now, aggregate, fallback, cacheStatus: "miss" });
  globalThis.__agentHubProductUsageAnalyticsCacheV1 = {
    value,
    expiresAtMs: nowMs + PRODUCT_USAGE_CACHE_TTL_MS,
  };
  return value;
}

export function readCachedProductUsageAnalytics(nowMs = Date.now()): ProductUsageAnalyticsResponse | null {
  const cached = globalThis.__agentHubProductUsageAnalyticsCacheV1;
  if (!cached || cached.expiresAtMs <= nowMs) return null;
  return withCacheStatus(cached.value, "hit", nowMs);
}

export async function readProductUsageAnalytics(nowMs = Date.now()): Promise<ProductUsageAnalyticsResponse> {
  const cached = readCachedProductUsageAnalytics(nowMs);
  if (cached) return cached;
  if (globalThis.__agentHubProductUsageReadInFlightV1) return globalThis.__agentHubProductUsageReadInFlightV1;
  const inFlight = produceProductUsageAnalytics(nowMs).finally(() => {
    if (globalThis.__agentHubProductUsageReadInFlightV1 === inFlight) {
      globalThis.__agentHubProductUsageReadInFlightV1 = undefined;
    }
  });
  globalThis.__agentHubProductUsageReadInFlightV1 = inFlight;
  return inFlight;
}

export class ProductUsageAdmissionGate {
  private readonly entries = new Map<string, ProductUsageAdmissionEntry>();

  constructor(private readonly minimumIntervalMs = PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS) {}

  private sweep(nowMs: number): void {
    if (this.entries.size <= MAX_ADMISSION_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && nowMs - entry.lastTouchedAtMs > ADMISSION_ENTRY_TTL_MS) this.entries.delete(key);
      if (this.entries.size <= MAX_ADMISSION_ENTRIES) break;
    }
  }

  async run<T>(actorKey: string, producer: () => Promise<T>, nowMs = Date.now()): Promise<ProductUsageAdmissionResult<T>> {
    this.sweep(nowMs);
    const entry = this.entries.get(actorKey) ?? { inFlight: false, lastAllowedAtMs: null, lastTouchedAtMs: nowMs };
    entry.lastTouchedAtMs = nowMs;
    this.entries.set(actorKey, entry);
    const elapsedMs = entry.lastAllowedAtMs == null ? Number.POSITIVE_INFINITY : nowMs - entry.lastAllowedAtMs;
    const remainingMs = Number.isFinite(elapsedMs) ? Math.max(0, this.minimumIntervalMs - elapsedMs) : 0;
    if (entry.inFlight) {
      const retryAfterMs = Math.max(1_000, remainingMs || this.minimumIntervalMs);
      return { allowed: false, reason: "single_flight", retryAfterMs, nextAllowedAtMs: nowMs + retryAfterMs };
    }
    if (remainingMs > 0) {
      return { allowed: false, reason: "minimum_interval", retryAfterMs: remainingMs, nextAllowedAtMs: nowMs + remainingMs };
    }
    entry.inFlight = true;
    entry.lastAllowedAtMs = nowMs;
    try {
      return { allowed: true, value: await producer(), admittedAtMs: nowMs, nextAllowedAtMs: nowMs + this.minimumIntervalMs };
    } finally {
      entry.inFlight = false;
      entry.lastTouchedAtMs = Date.now();
    }
  }
}

function admissionGate(): ProductUsageAdmissionGate {
  if (!globalThis.__agentHubProductUsageAdmissionGateV1) {
    globalThis.__agentHubProductUsageAdmissionGateV1 = new ProductUsageAdmissionGate();
  }
  return globalThis.__agentHubProductUsageAdmissionGateV1;
}

export async function readProductUsageAnalyticsForAdmin(actorId: string, nowMs = Date.now()): Promise<ProductUsageAdmissionResult<ProductUsageAnalyticsResponse>> {
  const actorKey = createHash("sha256").update(actorId).digest("hex");
  return admissionGate().run(actorKey, () => readProductUsageAnalytics(Date.now()), nowMs);
}

export function createUnavailableAggregateEvidence(code = "PRODUCT_USAGE_FACT_SOURCE_NOT_DEPLOYED"): ProductUsageAggregateEvidence {
  return {
    state: "unavailable",
    latestRecordAt: null,
    eventCount: null,
    instrumentationStartedAt: null,
    metrics: createUnavailableProductUsageMetrics(code),
    retention: [],
    featureAdoption: [],
    valuePath: [],
    errorCode: code,
  };
}
