import { z } from "zod";

export const PRODUCT_USAGE_SCHEMA_VERSION = 1 as const;
export const PRODUCT_USAGE_MIN_COHORT_SIZE = 5;
export const PRODUCT_USAGE_CACHE_TTL_MS = 60_000;
export const PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS = 60_000;
export const PRODUCT_USAGE_MAX_REQUEST_BYTES = 6 * 1024;
export const PRODUCT_USAGE_MAX_BATCH_EVENTS = 20;
export const PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE = 120;
export const PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE = 30;

export const PRODUCT_USAGE_EVENT_TYPES = [
  "page_view",
  "session_heartbeat",
  "feature_open",
  "workflow_started",
  "workflow_completed",
  "workflow_failed",
  "value_milestone",
] as const;

export const PRODUCT_USAGE_FEATURE_KEYS = [
  "app_market",
  "agent_chat",
  "commercial_ip",
  "copywriting",
  "image_generation",
  "video_generation",
  "voice_generation",
  "storyboard",
  "cover_studio",
  "media_history",
  "commerce",
  "member_center",
  "help_center",
] as const;

export const PRODUCT_USAGE_PAGE_KEYS = [
  "home",
  "tools",
  "agent_chat",
  "commercial_ip",
  "copywriting",
  "image",
  "video",
  "voice",
  "storyboard",
  "cover",
  "media_history",
  "commerce",
  "member",
  "help",
] as const;

export const PRODUCT_USAGE_MILESTONE_KEYS = [
  "activation_completed",
  "first_workflow_completed",
  "first_project_saved",
  "first_asset_downloaded",
  "first_export_completed",
  "first_publish_completed",
] as const;

export const PRODUCT_USAGE_ENTRY_POINTS = [
  "direct",
  "navigation",
  "deep_link",
  "notification",
  "history",
  "retry",
] as const;

export type ProductUsageEventType = (typeof PRODUCT_USAGE_EVENT_TYPES)[number];
export type ProductUsageFeatureKey = (typeof PRODUCT_USAGE_FEATURE_KEYS)[number];
export type ProductUsagePageKey = (typeof PRODUCT_USAGE_PAGE_KEYS)[number];
export type ProductUsageMilestoneKey = (typeof PRODUCT_USAGE_MILESTONE_KEYS)[number];
export type ProductUsageEntryPoint = (typeof PRODUCT_USAGE_ENTRY_POINTS)[number];

const safeReasonCode = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/u);

export const productUsageEventSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  event_type: z.enum(PRODUCT_USAGE_EVENT_TYPES),
  feature_key: z.enum(PRODUCT_USAGE_FEATURE_KEYS),
  page_key: z.enum(PRODUCT_USAGE_PAGE_KEYS).nullish(),
  journey_id: z.string().uuid().nullish(),
  milestone_key: z.enum(PRODUCT_USAGE_MILESTONE_KEYS).nullish(),
  entry_point: z.enum(PRODUCT_USAGE_ENTRY_POINTS).nullish(),
  outcome_reason_code: safeReasonCode.nullish(),
  duration_ms: z.number().int().min(0).max(86_400_000).nullish(),
  step_number: z.number().int().min(0).max(1_000).nullish(),
  client_sequence: z.number().int().min(0).max(2_147_483_647).nullish(),
  occurred_at: z.string().datetime().optional(),
}).strict().superRefine((event, context) => {
  if (event.event_type === "page_view" && !event.page_key) {
    context.addIssue({ code: "custom", path: ["page_key"], message: "page_view requires page_key" });
  }
  if (event.event_type.startsWith("workflow_") && !event.journey_id) {
    context.addIssue({ code: "custom", path: ["journey_id"], message: "workflow events require journey_id" });
  }
  if (event.event_type === "value_milestone" && !event.milestone_key) {
    context.addIssue({ code: "custom", path: ["milestone_key"], message: "value_milestone requires milestone_key" });
  }
  if (event.event_type !== "workflow_failed" && event.outcome_reason_code) {
    context.addIssue({ code: "custom", path: ["outcome_reason_code"], message: "reason code is only accepted for workflow_failed" });
  }
});

export const productUsageEventBatchSchema = z.object({
  events: z.array(productUsageEventSchema).min(1).max(PRODUCT_USAGE_MAX_BATCH_EVENTS),
}).strict();

export type ProductUsageBrowserEvent = z.infer<typeof productUsageEventSchema>;
export type ProductUsageBrowserBatch = z.infer<typeof productUsageEventBatchSchema>;

export type ProductUsageAvailability = "available" | "partial" | "unavailable";
export type ProductUsageMetricState = "available" | "partial" | "unavailable";
export type ProductUsageSourceMode =
  | "product_usage_events"
  | "operation_flight_events_limited_fallback"
  | "none";

export interface ProductUsageMetric {
  state: ProductUsageMetricState;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  unit: "users" | "ratio";
  reasonCode: string | null;
  definition: string;
  privacySuppressed: boolean;
}

export interface ProductUsageRetentionPoint {
  day: 1 | 7 | 30;
  state: ProductUsageMetricState;
  retainedUsers: number | null;
  eligibleUsers: number | null;
  rate: number | null;
  reasonCode: string | null;
  privacySuppressed: boolean;
}

export interface ProductUsageFeatureAdoption {
  featureKey: ProductUsageFeatureKey;
  label: string;
  state: ProductUsageMetricState;
  activeUsers: number | null;
  monthlyActiveUsers: number | null;
  adoptionRate: number | null;
  workflowCompletedUsers: number | null;
  reasonCode: string | null;
  privacySuppressed: boolean;
}

export interface ProductUsageValuePathStage {
  key: "active" | "feature_open" | "workflow_started" | "workflow_completed" | "value_milestone";
  label: string;
  state: ProductUsageMetricState;
  users: number | null;
  conversionFromPrevious: number | null;
  reasonCode: string | null;
  privacySuppressed: boolean;
}

export interface ProductUsageSourceStatus {
  id: "product_usage_events" | "operation_flight_events";
  label: string;
  state: ProductUsageAvailability;
  source: string;
  latestRecordAt: string | null;
  returnedRows: number | null;
  rowLimit: number | null;
  truncated: boolean;
  errorCode: string | null;
  detail: string;
}

export interface ProductUsageFallbackSignal {
  state: "partial" | "unavailable";
  eventCount: number | null;
  pseudonymousUserCount: number | null;
  errorEventCount: number | null;
  latestEventAt: string | null;
  windowHours: 24;
  disclaimer: string;
}

export interface ProductUsageAnalyticsResponse {
  ok: true;
  schemaVersion: typeof PRODUCT_USAGE_SCHEMA_VERSION;
  generatedAt: string;
  asOf: string | null;
  readOnly: true;
  availability: ProductUsageAvailability;
  sourceMode: ProductUsageSourceMode;
  freshness: {
    state: "fresh" | "stale" | "unavailable";
    ageSeconds: number | null;
    label: string;
  };
  refresh: {
    cacheStatus: "hit" | "miss";
    cacheTtlMs: number;
    nextRefreshAt: string;
    rateLimit: {
      scope: "process-local-admin";
      minimumIntervalMs: number;
      remainingMs: number;
      retryAfterSeconds: number;
    };
    providerCalls: 0;
    businessWrites: 0;
  };
  metrics: {
    dau: ProductUsageMetric;
    wau: ProductUsageMetric;
    mau: ProductUsageMetric;
    activation: ProductUsageMetric;
  };
  retention: ProductUsageRetentionPoint[];
  featureAdoption: ProductUsageFeatureAdoption[];
  valuePath: ProductUsageValuePathStage[];
  fallbackSignal: ProductUsageFallbackSignal;
  sourceStates: ProductUsageSourceStatus[];
  readBudget: {
    aggregateRpcCalls: 1;
    fallbackRowLimit: number;
    fallbackReturnedRows: number | null;
    fallbackTruncated: boolean;
  };
  privacy: {
    minimumCohortSize: typeof PRODUCT_USAGE_MIN_COHORT_SIZE;
    directIdentifiersIncluded: false;
    rawSessionIdIncluded: false;
    ipIncluded: false;
    userAgentIncluded: false;
    promptOrContentIncluded: false;
    materialUrlIncluded: false;
    emailIncluded: false;
  };
  limitations: string[];
}

export interface ProductUsageRateLimitedResponse {
  ok: false;
  code: "PRODUCT_USAGE_ANALYTICS_RATE_LIMITED";
  error: string;
  asOf: string | null;
  nextRefreshAt: string;
  cacheStatus: "rate_limited";
  rateLimit: ProductUsageAnalyticsResponse["refresh"]["rateLimit"];
}

const productUsageAvailabilitySchema = z.enum(["available", "partial", "unavailable"]);
const productUsageMetricStateSchema = z.enum(["available", "partial", "unavailable"]);
const productUsageNullableCountSchema = z.number().int().nonnegative().nullable();
const productUsageNullableRatioSchema = z.number().min(0).max(1).nullable();
const productUsageNullableTimestampSchema = z.string().datetime().nullable();
const productUsageNullableReasonCodeSchema = z.string().trim().min(1).max(200).nullable();

const productUsageMetricSchema = z.object({
  state: productUsageMetricStateSchema,
  value: z.number().nonnegative().nullable(),
  numerator: productUsageNullableCountSchema,
  denominator: productUsageNullableCountSchema,
  unit: z.enum(["users", "ratio"]),
  reasonCode: productUsageNullableReasonCodeSchema,
  definition: z.string().trim().min(1).max(500),
  privacySuppressed: z.boolean(),
}).strict().superRefine((metric, context) => {
  if (metric.unit === "users" && metric.value != null && !Number.isInteger(metric.value)) {
    context.addIssue({ code: "custom", path: ["value"], message: "user metrics require integer values" });
  }
  if (metric.unit === "ratio" && metric.value != null && metric.value > 1) {
    context.addIssue({ code: "custom", path: ["value"], message: "ratio metrics must be between zero and one" });
  }
  if (metric.privacySuppressed && (metric.value != null || metric.numerator != null || metric.denominator != null)) {
    context.addIssue({ code: "custom", message: "privacy-suppressed metrics must not expose counts or values" });
  }
  if (metric.state === "unavailable" && metric.value != null) {
    context.addIssue({ code: "custom", path: ["value"], message: "unavailable metrics must not expose a value" });
  }
});

const productUsageRetentionPointSchema = z.object({
  day: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  state: productUsageMetricStateSchema,
  retainedUsers: productUsageNullableCountSchema,
  eligibleUsers: productUsageNullableCountSchema,
  rate: productUsageNullableRatioSchema,
  reasonCode: productUsageNullableReasonCodeSchema,
  privacySuppressed: z.boolean(),
}).strict().superRefine((point, context) => {
  if (point.privacySuppressed && (point.retainedUsers != null || point.eligibleUsers != null || point.rate != null)) {
    context.addIssue({ code: "custom", message: "privacy-suppressed retention must not expose cohort values" });
  }
  if (point.state === "unavailable" && point.rate != null) {
    context.addIssue({ code: "custom", path: ["rate"], message: "unavailable retention must not expose a rate" });
  }
});

const productUsageFeatureAdoptionSchema = z.object({
  featureKey: z.enum(PRODUCT_USAGE_FEATURE_KEYS),
  label: z.string().trim().min(1).max(120),
  state: productUsageMetricStateSchema,
  activeUsers: productUsageNullableCountSchema,
  monthlyActiveUsers: productUsageNullableCountSchema,
  adoptionRate: productUsageNullableRatioSchema,
  workflowCompletedUsers: productUsageNullableCountSchema,
  reasonCode: productUsageNullableReasonCodeSchema,
  privacySuppressed: z.boolean(),
}).strict().superRefine((feature, context) => {
  if (feature.privacySuppressed && (
    feature.activeUsers != null
    || feature.monthlyActiveUsers != null
    || feature.adoptionRate != null
    || feature.workflowCompletedUsers != null
  )) {
    context.addIssue({ code: "custom", message: "privacy-suppressed adoption must not expose cohort values" });
  }
  if (feature.state === "unavailable" && feature.adoptionRate != null) {
    context.addIssue({ code: "custom", path: ["adoptionRate"], message: "unavailable adoption must not expose a rate" });
  }
});

const productUsageValuePathStageSchema = z.object({
  key: z.enum(["active", "feature_open", "workflow_started", "workflow_completed", "value_milestone"]),
  label: z.string().trim().min(1).max(120),
  state: productUsageMetricStateSchema,
  users: productUsageNullableCountSchema,
  conversionFromPrevious: productUsageNullableRatioSchema,
  reasonCode: productUsageNullableReasonCodeSchema,
  privacySuppressed: z.boolean(),
}).strict().superRefine((stage, context) => {
  if (stage.privacySuppressed && (stage.users != null || stage.conversionFromPrevious != null)) {
    context.addIssue({ code: "custom", message: "privacy-suppressed value-path stages must not expose cohort values" });
  }
  if (stage.state === "unavailable" && stage.conversionFromPrevious != null) {
    context.addIssue({ code: "custom", path: ["conversionFromPrevious"], message: "unavailable value-path stages must not expose conversion" });
  }
});

const productUsageSourceStatusSchema = z.object({
  id: z.enum(["product_usage_events", "operation_flight_events"]),
  label: z.string().trim().min(1).max(160),
  state: productUsageAvailabilitySchema,
  source: z.string().trim().min(1).max(300),
  latestRecordAt: productUsageNullableTimestampSchema,
  returnedRows: productUsageNullableCountSchema,
  rowLimit: productUsageNullableCountSchema,
  truncated: z.boolean(),
  errorCode: productUsageNullableReasonCodeSchema,
  detail: z.string().trim().min(1).max(1_000),
}).strict();

export const productUsageAnalyticsResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(PRODUCT_USAGE_SCHEMA_VERSION),
  generatedAt: z.string().datetime(),
  asOf: productUsageNullableTimestampSchema,
  readOnly: z.literal(true),
  availability: productUsageAvailabilitySchema,
  sourceMode: z.enum(["product_usage_events", "operation_flight_events_limited_fallback", "none"]),
  freshness: z.object({
    state: z.enum(["fresh", "stale", "unavailable"]),
    ageSeconds: productUsageNullableCountSchema,
    label: z.string().trim().min(1).max(300),
  }).strict(),
  refresh: z.object({
    cacheStatus: z.enum(["hit", "miss"]),
    cacheTtlMs: z.number().int().positive(),
    nextRefreshAt: z.string().datetime(),
    rateLimit: z.object({
      scope: z.literal("process-local-admin"),
      minimumIntervalMs: z.number().int().positive(),
      remainingMs: z.number().int().nonnegative(),
      retryAfterSeconds: z.number().int().nonnegative(),
    }).strict(),
    providerCalls: z.literal(0),
    businessWrites: z.literal(0),
  }).strict(),
  metrics: z.object({
    dau: productUsageMetricSchema,
    wau: productUsageMetricSchema,
    mau: productUsageMetricSchema,
    activation: productUsageMetricSchema,
  }).strict().superRefine((metrics, context) => {
    for (const key of ["dau", "wau", "mau"] as const) {
      if (metrics[key].unit !== "users") {
        context.addIssue({ code: "custom", path: [key, "unit"], message: `${key} must use users` });
      }
    }
    if (metrics.activation.unit !== "ratio") {
      context.addIssue({ code: "custom", path: ["activation", "unit"], message: "activation must use ratio" });
    }
  }),
  retention: z.array(productUsageRetentionPointSchema).max(3).superRefine((points, context) => {
    if (new Set(points.map((point) => point.day)).size !== points.length) {
      context.addIssue({ code: "custom", message: "retention days must be unique" });
    }
  }),
  featureAdoption: z.array(productUsageFeatureAdoptionSchema).max(PRODUCT_USAGE_FEATURE_KEYS.length).superRefine((features, context) => {
    if (new Set(features.map((feature) => feature.featureKey)).size !== features.length) {
      context.addIssue({ code: "custom", message: "feature adoption keys must be unique" });
    }
  }),
  valuePath: z.array(productUsageValuePathStageSchema).max(5).superRefine((stages, context) => {
    if (new Set(stages.map((stage) => stage.key)).size !== stages.length) {
      context.addIssue({ code: "custom", message: "value-path stage keys must be unique" });
    }
  }),
  fallbackSignal: z.object({
    state: z.enum(["partial", "unavailable"]),
    eventCount: productUsageNullableCountSchema,
    pseudonymousUserCount: productUsageNullableCountSchema,
    errorEventCount: productUsageNullableCountSchema,
    latestEventAt: productUsageNullableTimestampSchema,
    windowHours: z.literal(24),
    disclaimer: z.string().trim().min(1).max(1_000),
  }).strict().superRefine((fallback, context) => {
    if (fallback.state === "unavailable" && (
      fallback.eventCount != null
      || fallback.pseudonymousUserCount != null
      || fallback.errorEventCount != null
      || fallback.latestEventAt != null
    )) {
      context.addIssue({ code: "custom", message: "unavailable fallback must not expose event facts" });
    }
  }),
  sourceStates: z.array(productUsageSourceStatusSchema).length(2).superRefine((sources, context) => {
    const ids = new Set(sources.map((source) => source.id));
    if (ids.size !== 2 || !ids.has("product_usage_events") || !ids.has("operation_flight_events")) {
      context.addIssue({ code: "custom", message: "both product and operational source states are required" });
    }
  }),
  readBudget: z.object({
    aggregateRpcCalls: z.literal(1),
    fallbackRowLimit: z.number().int().nonnegative(),
    fallbackReturnedRows: productUsageNullableCountSchema,
    fallbackTruncated: z.boolean(),
  }).strict(),
  privacy: z.object({
    minimumCohortSize: z.literal(PRODUCT_USAGE_MIN_COHORT_SIZE),
    directIdentifiersIncluded: z.literal(false),
    rawSessionIdIncluded: z.literal(false),
    ipIncluded: z.literal(false),
    userAgentIncluded: z.literal(false),
    promptOrContentIncluded: z.literal(false),
    materialUrlIncluded: z.literal(false),
    emailIncluded: z.literal(false),
  }).strict(),
  limitations: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
}).strict() satisfies z.ZodType<ProductUsageAnalyticsResponse>;

export interface ProductUsageAggregateEvidence {
  state: ProductUsageAvailability;
  latestRecordAt: string | null;
  eventCount: number | null;
  instrumentationStartedAt: string | null;
  metrics: ProductUsageAnalyticsResponse["metrics"] | null;
  retention: ProductUsageRetentionPoint[];
  featureAdoption: ProductUsageFeatureAdoption[];
  valuePath: ProductUsageValuePathStage[];
  errorCode: string | null;
}

export interface ProductUsageFallbackEvidence {
  state: "available" | "unavailable";
  rows: Array<{
    id: string;
    pseudonymousUserRef: string | null;
    outcome: string | null;
    occurredAt: string | null;
  }>;
  rowLimit: number;
  truncated: boolean;
  errorCode: string | null;
}

export interface ProductUsageBuildInput {
  now: string;
  aggregate: ProductUsageAggregateEvidence;
  fallback: ProductUsageFallbackEvidence;
  cacheStatus?: "hit" | "miss";
}

const unavailableMetric = (definition: string, reasonCode: string): ProductUsageMetric => ({
  state: "unavailable",
  value: null,
  numerator: null,
  denominator: null,
  unit: "users",
  reasonCode,
  definition,
  privacySuppressed: false,
});

export function createUnavailableProductUsageMetrics(reasonCode: string): ProductUsageAnalyticsResponse["metrics"] {
  return {
    dau: unavailableMetric("统计日内至少产生一次合规产品事件的去重会员数。", reasonCode),
    wau: unavailableMetric("含统计日在内最近 7 个自然日至少产生一次合规产品事件的去重会员数。", reasonCode),
    mau: unavailableMetric("含统计日在内最近 30 个自然日至少产生一次合规产品事件的去重会员数。", reasonCode),
    activation: {
      ...unavailableMetric("注册后 7 天内完成至少一次工作流的新会员占同期符合条件新会员的比例。", reasonCode),
      unit: "ratio",
    },
  };
}

function validTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function privacyCount(value: number, minimum = PRODUCT_USAGE_MIN_COHORT_SIZE): number | null {
  return value > 0 && value < minimum ? null : value;
}

export function buildProductUsageAnalytics(input: ProductUsageBuildInput): ProductUsageAnalyticsResponse {
  const nowMs = Date.parse(input.now);
  const aggregateSourceReadable = input.aggregate.state !== "unavailable";
  const aggregateAvailable = aggregateSourceReadable
    && input.aggregate.metrics !== null
    && (input.aggregate.eventCount ?? 0) > 0;
  const fallbackAvailable = input.fallback.state === "available";
  const latestAggregateMs = validTime(input.aggregate.latestRecordAt);
  const asOf = aggregateAvailable ? input.aggregate.latestRecordAt : null;
  const ageSeconds = aggregateAvailable && latestAggregateMs != null && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - latestAggregateMs) / 1_000))
    : null;
  const fallbackEvents = input.fallback.rows;
  const fallbackUserSet = new Set(fallbackEvents.map((row) => row.pseudonymousUserRef).filter(Boolean));
  const fallbackUserCount = privacyCount(fallbackUserSet.size);
  const latestFallback = fallbackEvents
    .map((row) => row.occurredAt)
    .filter((value): value is string => validTime(value) != null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const sourceMode: ProductUsageSourceMode = aggregateSourceReadable
    ? "product_usage_events"
    : fallbackAvailable
      ? "operation_flight_events_limited_fallback"
      : "none";
  const availability: ProductUsageAvailability = aggregateSourceReadable
    ? aggregateAvailable ? input.aggregate.state : "partial"
    : fallbackAvailable
      ? "partial"
      : "unavailable";
  const unavailableReason = input.aggregate.errorCode || "PRODUCT_USAGE_FACT_SOURCE_NOT_DEPLOYED";

  return {
    ok: true,
    schemaVersion: PRODUCT_USAGE_SCHEMA_VERSION,
    generatedAt: input.now,
    asOf,
    readOnly: true,
    availability,
    sourceMode,
    freshness: aggregateAvailable
      ? {
          state: ageSeconds != null && ageSeconds <= 24 * 60 * 60 ? "fresh" : "stale",
          ageSeconds,
          label: ageSeconds != null && ageSeconds <= 24 * 60 * 60 ? "产品事件事实源已接入" : "产品事件事实源已超过 24 小时未更新",
        }
      : { state: "unavailable", ageSeconds: null, label: "完整产品事件事实源未接入" },
    refresh: {
      cacheStatus: input.cacheStatus ?? "miss",
      cacheTtlMs: PRODUCT_USAGE_CACHE_TTL_MS,
      nextRefreshAt: new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + PRODUCT_USAGE_CACHE_TTL_MS).toISOString(),
      rateLimit: {
        scope: "process-local-admin",
        minimumIntervalMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
        remainingMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
        retryAfterSeconds: Math.ceil(PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS / 1_000),
      },
      providerCalls: 0,
      businessWrites: 0,
    },
    metrics: aggregateAvailable && input.aggregate.metrics
      ? input.aggregate.metrics
      : createUnavailableProductUsageMetrics(unavailableReason),
    retention: aggregateAvailable ? input.aggregate.retention : [1, 7, 30].map((day) => ({
      day: day as 1 | 7 | 30,
      state: "unavailable" as const,
      retainedUsers: null,
      eligibleUsers: null,
      rate: null,
      reasonCode: unavailableReason,
      privacySuppressed: false,
    })),
    featureAdoption: aggregateAvailable ? input.aggregate.featureAdoption : [],
    valuePath: aggregateAvailable ? input.aggregate.valuePath : [],
    fallbackSignal: fallbackAvailable
      ? {
          state: "partial",
          eventCount: fallbackEvents.length,
          pseudonymousUserCount: fallbackUserCount,
          errorEventCount: fallbackEvents.filter((row) => row.outcome === "error").length,
          latestEventAt: latestFallback,
          windowHours: 24,
          disclaimer: "这里只显示最近 24 小时有限运行事实，不能用于计算 DAU、激活、留存、功能采用或价值路径。",
        }
      : {
          state: "unavailable",
          eventCount: null,
          pseudonymousUserCount: null,
          errorEventCount: null,
          latestEventAt: null,
          windowHours: 24,
          disclaimer: "运行事实源当前也不可读；本次不以 0 替代缺失。",
        },
    sourceStates: [
      {
        id: "product_usage_events",
        label: "统一产品使用事件",
        state: aggregateSourceReadable ? input.aggregate.state : "unavailable",
        source: "product_usage_events + read_admin_product_usage_snapshot_v1",
        latestRecordAt: aggregateAvailable ? input.aggregate.latestRecordAt : null,
        returnedRows: null,
        rowLimit: null,
        truncated: false,
        errorCode: aggregateSourceReadable ? input.aggregate.errorCode : unavailableReason,
        detail: aggregateAvailable
          ? "使用服务端归属会员、匿名会话和白名单事件计算产品指标。"
          : aggregateSourceReadable
            ? "耐久表与聚合函数可读，但目前没有足够的合规产品事件，完整指标保持不可用。"
          : "设计与代码链已就绪，但耐久表/聚合函数未部署时不能生成完整产品指标。",
      },
      {
        id: "operation_flight_events",
        label: "操作飞行记录",
        state: fallbackAvailable ? "partial" : "unavailable",
        source: "operation_flight_events (read-only bounded fallback)",
        latestRecordAt: latestFallback,
        returnedRows: fallbackAvailable ? fallbackEvents.length : null,
        rowLimit: input.fallback.rowLimit,
        truncated: input.fallback.truncated,
        errorCode: input.fallback.errorCode,
        detail: fallbackAvailable
          ? "只用于确认运行事实采集是否活跃；它不是完整产品分析事件。"
          : "有限运行事实当前不可读。",
      },
    ],
    readBudget: {
      aggregateRpcCalls: 1,
      fallbackRowLimit: input.fallback.rowLimit,
      fallbackReturnedRows: fallbackAvailable ? fallbackEvents.length : null,
      fallbackTruncated: input.fallback.truncated,
    },
    privacy: {
      minimumCohortSize: PRODUCT_USAGE_MIN_COHORT_SIZE,
      directIdentifiersIncluded: false,
      rawSessionIdIncluded: false,
      ipIncluded: false,
      userAgentIncluded: false,
      promptOrContentIncluded: false,
      materialUrlIncluded: false,
      emailIncluded: false,
    },
    limitations: [
      "新事实表部署前，DAU/WAU/MAU、激活、留存、功能采用和价值路径保持不可用。",
      "浏览器事件是产品行为信号，不替代支付到账、模型终态或内容质量等服务端业务事实。",
      `人数少于 ${PRODUCT_USAGE_MIN_COHORT_SIZE} 的群组必须隐藏精确数值。`,
      "飞行记录只覆盖已接入的请求/任务链，不能回填为完整历史产品行为。",
    ],
  };
}

export function parseProductUsageAnalyticsResponse(value: unknown): ProductUsageAnalyticsResponse | null {
  const parsed = productUsageAnalyticsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isProductUsageAnalyticsResponse(value: unknown): value is ProductUsageAnalyticsResponse {
  return parseProductUsageAnalyticsResponse(value) !== null;
}
