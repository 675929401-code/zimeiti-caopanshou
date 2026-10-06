import "server-only";

import { createHash } from "node:crypto";

import {
  COMMAND_CENTER_DEFINITION_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  commandCenterApplyFreshnessState,
  commandCenterDataQuality,
  commandCenterCredentialCoveragePercent,
  createCommandCenterViewReadGate,
  commandCenterFinanceCashSnapshot,
  commandCenterFreshnessSeconds,
  commandCenterMetric,
  commandCenterOverallStatus,
  commandCenterPercentage,
  commandCenterSourceAnomalies,
  commandCenterViewDefinition,
  type CommandCenterMetricStatus,
  type CommandCenterSection,
  type CommandCenterSectionId,
  type CommandCenterSnapshot,
  type CommandCenterSourceStatus,
  type CommandCenterView,
} from "@/lib/admin-command-center-domain";
import {
  readUnifiedMessagingStatus,
  type UnifiedMessagingDatabaseClient,
  type UnifiedMessagingStatus,
} from "@/lib/unified-messaging-control-plane";
import {
  readAdminBackupRestoreSnapshot,
  type AdminBackupRestoreSnapshot,
} from "@/lib/server/backup-restore-control-plane";
import {
  readIncidentSloStatus,
} from "@/lib/server/incident-slo-control-plane";
import {
  readAdminProjectRegistrySnapshot,
  type AdminProjectRegistrySnapshot,
} from "@/lib/server/project-registry";
import { getSecurityEventReliabilityStatus } from "@/lib/server/security-event-reliability";
import {
  readAdminMultitenantBoundarySnapshot,
  type AdminMultitenantBoundarySnapshot,
} from "@/lib/server/multitenant-boundary";
import { readDomainTlsBrandReleaseStatus } from "@/lib/server/domain-tls-brand-release-control-plane";
import type { IncidentSloStatus } from "@/lib/incident-slo-control-plane";
import type { DomainReleaseStatus } from "@/lib/domain-tls-brand-release-control-plane";
import { horizontalScaleReadinessSnapshot } from "@/lib/horizontal-scale-readiness-contract";
import {
  assertFreshLlmModelValidationEvidence,
  llmModelValidationConfigurationHash,
  type LlmModelValidationBinding,
  type LlmModelValidationEvidence,
} from "@/lib/llm-model-validation-gate";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseRow = Record<string, unknown>;
type ReadResult = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
  count?: number | null;
};

interface SourceDataset {
  status: CommandCenterSourceStatus;
  rows: DatabaseRow[];
}

type ControlPlaneResult<T> = PromiseSettledResult<T>;

const MAX_BUSINESS_ROWS = 5_000;
const MAX_FINANCE_ROWS = 5_000;
const MAX_TASK_ROWS_PER_SOURCE = 2_000;
const MAX_MODEL_ROWS_PER_SOURCE = 1_000;
const MAX_SECURITY_ROWS = 5_000;
const MAX_OPERATION_ROWS = 10_000;
const QUERY_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 12_000;

interface CommandCenterCacheEntry {
  expiresAt: number;
  promise: Promise<CommandCenterSnapshot>;
  settled: boolean;
}

const snapshotCache = new Map<string, CommandCenterCacheEntry>();

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sum(rows: DatabaseRow[], key: string): number {
  return rows.reduce((total, row) => total + (finiteNumber(row[key]) || 0), 0);
}

function newestTimestamp(rows: DatabaseRow[]): string | null {
  const keys = [
    "occurred_at",
    "updated_at",
    "completed_at",
    "paid_at",
    "provider_confirmed_at",
    "published_at",
    "checked_at",
    "last_success_at",
    "last_fail_at",
    "started_at",
    "created_at",
  ];
  let newest: string | null = null;
  let newestEpoch = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    for (const key of keys) {
      const raw = row[key];
      if (typeof raw !== "string" || !raw) continue;
      const epoch = Date.parse(raw);
      if (Number.isFinite(epoch) && epoch > newestEpoch) {
        newest = raw;
        newestEpoch = epoch;
      }
    }
  }
  return newest;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = String((error as Record<string, unknown>).code || "").trim();
    if (/^[A-Za-z0-9_.:-]{1,80}$/u.test(code)) return code;
  }
  return "READ_FAILED";
}

async function readRows(input: {
  id: string;
  label: string;
  source: string;
  drilldownUrl: string;
  staleAfterSeconds?: number | null;
  read: () => PromiseLike<ReadResult>;
}): Promise<SourceDataset> {
  try {
    const result = await input.read();
    if (result.error) throw result.error;
    const rows = Array.isArray(result.data) ? result.data as DatabaseRow[] : [];
    const totalRows = typeof result.count === "number" ? Math.max(0, result.count) : rows.length;
    const coverageRatio = totalRows === 0 ? 1 : Math.min(1, rows.length / totalRows);
    const partial = coverageRatio < 1;
    const asOf = new Date().toISOString();
    const latestRecordAt = newestTimestamp(rows);
    return {
      rows,
      status: {
        id: input.id,
        label: input.label,
        source: input.source,
        state: partial ? "partial" : "available",
        asOf,
        latestRecordAt,
        freshnessSeconds: commandCenterFreshnessSeconds(latestRecordAt, asOf),
        coverageRatio,
        returnedRows: rows.length,
        totalRows,
        partial,
        errorCode: null,
        drilldownUrl: input.drilldownUrl,
        staleAfterSeconds: input.staleAfterSeconds ?? null,
      },
    };
  } catch (error) {
    return {
      rows: [],
      status: {
        id: input.id,
        label: input.label,
        source: input.source,
        state: "unavailable",
        asOf: null,
        latestRecordAt: null,
        freshnessSeconds: null,
        coverageRatio: 0,
        returnedRows: 0,
        totalRows: null,
        partial: true,
        errorCode: safeErrorCode(error),
        drilldownUrl: input.drilldownUrl,
        staleAfterSeconds: input.staleAfterSeconds ?? null,
      },
    };
  }
}

async function readCount(input: {
  id: string;
  label: string;
  source: string;
  drilldownUrl: string;
  read: () => PromiseLike<ReadResult>;
}): Promise<SourceDataset> {
  try {
    const result = await input.read();
    if (result.error) throw result.error;
    const count = typeof result.count === "number" ? Math.max(0, result.count) : null;
    if (count == null) throw Object.assign(new Error("COUNT_UNAVAILABLE"), { code: "COUNT_UNAVAILABLE" });
    const asOf = new Date().toISOString();
    return {
      rows: [{ count }],
      status: {
        id: input.id,
        label: input.label,
        source: input.source,
        state: "available",
        asOf,
        latestRecordAt: null,
        freshnessSeconds: null,
        coverageRatio: 1,
        returnedRows: count,
        totalRows: count,
        partial: false,
        errorCode: null,
        drilldownUrl: input.drilldownUrl,
        staleAfterSeconds: null,
      },
    };
  } catch (error) {
    return {
      rows: [],
      status: {
        id: input.id,
        label: input.label,
        source: input.source,
        state: "unavailable",
        asOf: null,
        latestRecordAt: null,
        freshnessSeconds: null,
        coverageRatio: 0,
        returnedRows: 0,
        totalRows: null,
        partial: true,
        errorCode: safeErrorCode(error),
        drilldownUrl: input.drilldownUrl,
        staleAfterSeconds: null,
      },
    };
  }
}

function controlPlaneSource(input: {
  id: string;
  label: string;
  source: string;
  state: CommandCenterSourceStatus["state"];
  asOf: string | null;
  latestRecordAt?: string | null;
  coverageRatio: number | null;
  returnedRows: number;
  totalRows: number | null;
  errorCode?: string | null;
  drilldownUrl: string;
  staleAfterSeconds?: number | null;
}): CommandCenterSourceStatus {
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    state: input.state,
    asOf: input.asOf,
    latestRecordAt: input.latestRecordAt ?? input.asOf,
    freshnessSeconds: input.asOf ? Math.max(0, Math.floor((Date.now() - Date.parse(input.asOf)) / 1_000)) : null,
    coverageRatio: input.coverageRatio,
    returnedRows: input.returnedRows,
    totalRows: input.totalRows,
    partial: input.state !== "available" || (input.coverageRatio != null && input.coverageRatio < 1),
    errorCode: input.errorCode ?? null,
    drilldownUrl: input.drilldownUrl,
    staleAfterSeconds: input.staleAfterSeconds ?? null,
  };
}

function unavailableControlPlaneSource(input: {
  id: string;
  label: string;
  source: string;
  drilldownUrl: string;
  errorCode: string;
}): CommandCenterSourceStatus {
  return controlPlaneSource({
    ...input,
    state: "unavailable",
    asOf: null,
    coverageRatio: 0,
    returnedRows: 0,
    totalRows: null,
  });
}

function sourceCount(dataset: SourceDataset): number | null {
  return dataset.status.state === "unavailable" ? null : dataset.status.totalRows;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rateStatus(
  value: number | null,
  warningBelow: number,
  criticalBelow: number,
): Exclude<CommandCenterMetricStatus, "unavailable"> {
  if (value == null) return "unknown";
  if (value < criticalBelow) return "critical";
  if (value < warningBelow) return "warning";
  return "healthy";
}

function countStatus(
  value: number | null,
  criticalAt: number,
  warningAt = 1,
): Exclude<CommandCenterMetricStatus, "unavailable"> {
  if (value == null) return "unknown";
  if (value >= criticalAt) return "critical";
  if (value >= warningAt) return "warning";
  return "healthy";
}

function taskState(row: DatabaseRow): string {
  return String(row.state || row.status || "unknown").trim().toLowerCase();
}

function visibleModel(row: DatabaseRow): boolean {
  return row.is_active !== false && row.is_hidden !== true;
}

function freshValidatedLlmModelIds(
  models: SourceDataset,
  evidenceDataset: SourceDataset,
  now: number,
): Set<string> {
  const accepted = new Set<string>();
  if (models.status.state === "unavailable" || evidenceDataset.status.state === "unavailable") return accepted;

  const evidenceByConfiguration = new Map<string, LlmModelValidationEvidence>();
  for (const row of evidenceDataset.rows) {
    const modelId = String(row.model_id || "").trim();
    const configurationHash = String(row.configuration_hash || "").trim();
    if (modelId && configurationHash) {
      evidenceByConfiguration.set(`${modelId}:${configurationHash}`, row as LlmModelValidationEvidence);
    }
  }

  for (const row of models.rows) {
    const modelId = String(row.id || "").trim();
    if (!modelId) continue;
    let resolvedSecret = "";
    try {
      resolvedSecret = resolveProviderSecret(String(row.api_key || "")).trim();
    } catch {
      continue;
    }
    if (!resolvedSecret) continue;
    const binding = row as LlmModelValidationBinding;
    const configurationHash = llmModelValidationConfigurationHash(binding, resolvedSecret);
    const evidence = evidenceByConfiguration.get(`${modelId}:${configurationHash}`);
    try {
      assertFreshLlmModelValidationEvidence(binding, resolvedSecret, evidence, now);
      accepted.add(modelId);
    } catch {
      // Missing, stale, future-dated or configuration-mismatched evidence is fail-closed.
    }
  }
  return accepted;
}

function skippedDataset(input: {
  id: string;
  label: string;
  source: string;
  drilldownUrl: string;
  staleAfterSeconds?: number | null;
}): SourceDataset {
  return {
    rows: [],
    status: {
      id: input.id,
      label: input.label,
      source: input.source,
      state: "unavailable",
      asOf: null,
      latestRecordAt: null,
      freshnessSeconds: null,
      coverageRatio: 0,
      returnedRows: 0,
      totalRows: null,
      partial: true,
      errorCode: "VIEW_NOT_REQUESTED",
      drilldownUrl: input.drilldownUrl,
      staleAfterSeconds: input.staleAfterSeconds ?? null,
    },
  };
}

async function buildSnapshot(hours: number, view: CommandCenterView): Promise<CommandCenterSnapshot> {
  const buildStartedAt = performance.now();
  const generatedAt = new Date().toISOString();
  const from = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
  const db = getSupabaseAdminClient();
  const viewDefinition = commandCenterViewDefinition(view);
  const viewReadGate = createCommandCenterViewReadGate(view);
  const readCountFor = (
    sectionId: CommandCenterSectionId,
    input: Parameters<typeof readCount>[0],
  ) => viewReadGate.read(sectionId, () => readCount(input), () => skippedDataset(input));
  const readRowsFor = (
    sectionId: CommandCenterSectionId,
    input: Parameters<typeof readRows>[0],
  ) => viewReadGate.read(sectionId, () => readRows(input), () => skippedDataset(input));

  const readControlPlaneFor = <T>(
    sectionId: CommandCenterSectionId,
    reader: () => Promise<T>,
  ): Promise<T> => viewReadGate.read(
    sectionId,
    reader,
    () => Promise.reject(Object.assign(new Error("VIEW_NOT_REQUESTED"), { code: "VIEW_NOT_REQUESTED" })),
  );

  const [
    totalUsers,
    newUsers,
    activeUsers,
    paymentReceipts,
    offlineReceipts,
    refundAttempts,
    revenue,
    llmTasks,
    imageTasks,
    videoTasks,
    voiceTasks,
    extractionTasks,
    llmModels,
    imageModels,
    videoModels,
    credentialBindings,
    llmValidations,
    imageValidations,
    videoHealth,
    securityEvents,
    failedLogins,
    securityCases,
    flightEvents,
    systemErrors,
    latestHealth,
  ] = await Promise.all([
    readCountFor("business", {
      id: "business.users.total",
      label: "平台注册用户",
      source: "users",
      drilldownUrl: "/admin?tab=users",
      read: () => db.from("users").select("id", { count: "exact", head: true }).eq("role", "student").abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readCountFor("business", {
      id: "business.users.new",
      label: "窗口内新增用户",
      source: "users",
      drilldownUrl: "/admin?tab=users",
      read: () => db.from("users").select("id", { count: "exact", head: true }).eq("role", "student").gte("created_at", from).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("business", {
      id: "business.active-users",
      label: "窗口内消费活跃用户",
      source: "credit_transactions",
      drilldownUrl: "/admin?tab=credits",
      read: () => db.from("credit_transactions")
        .select("user_id,created_at", { count: "exact" })
        .eq("type", "consume")
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_BUSINESS_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("finance", {
      id: "finance.payments",
      label: "线上已支付订单",
      source: "payment_orders",
      drilldownUrl: "/admin?tab=credits",
      read: () => db.from("payment_orders")
        .select("amount,provider_paid_amount,status,paid_at,provider_confirmed_at,created_at", { count: "exact" })
        .in("status", ["paid", "refunded"])
        .gte("paid_at", from)
        .order("paid_at", { ascending: false })
        .limit(MAX_FINANCE_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("finance", {
      id: "finance.offline-receipts",
      label: "已确认线下收款",
      source: "offline_payment_receipts",
      drilldownUrl: "/admin?tab=offline-payments",
      read: () => db.from("offline_payment_receipts")
        .select("amount,status,paid_at,created_at", { count: "exact" })
        .eq("status", "confirmed")
        .gte("paid_at", from)
        .order("paid_at", { ascending: false })
        .limit(MAX_FINANCE_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("finance", {
      id: "finance.refunds",
      label: "退款执行证据",
      source: "payment_refund_attempts",
      drilldownUrl: "/admin?tab=credits",
      read: () => db.from("payment_refund_attempts")
        .select("state,paid_amount,provider_refund_amount,created_at,updated_at,completed_at", { count: "exact" })
        .in("state", ["completed", "reconciliation_required"])
        .gte("updated_at", from)
        .order("updated_at", { ascending: false })
        .limit(MAX_FINANCE_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("finance", {
      id: "finance.revenue",
      label: "任务收益快照",
      source: "revenue_records",
      drilldownUrl: "/admin?tab=credits",
      read: () => db.from("revenue_records")
        .select("selling_price,cost_price,profit,record_type,task_id,created_at", { count: "exact" })
        .eq("billing_exempt", false)
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_FINANCE_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("tasks", {
      id: "tasks.llm",
      label: "对话任务",
      source: "llm_request_attempts",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("llm_request_attempts")
        .select("record_id,state,created_at,updated_at", { count: "exact" })
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_TASK_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("tasks", {
      id: "tasks.image",
      label: "生图任务",
      source: "image_generation_requests",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("image_generation_requests")
        .select("record_id,state,delivery_state,created_at,updated_at", { count: "exact" })
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_TASK_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("tasks", {
      id: "tasks.video",
      label: "视频任务",
      source: "video_tasks",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("video_tasks")
        .select("id,status,billing_state,created_at,completed_at", { count: "exact" })
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_TASK_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("tasks", {
      id: "tasks.voice",
      label: "语音任务",
      source: "voice_generation_requests",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("voice_generation_requests")
        .select("id,state,started_at,updated_at,completed_at", { count: "exact" })
        .gte("started_at", from)
        .order("started_at", { ascending: false })
        .limit(MAX_TASK_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("tasks", {
      id: "tasks.extraction",
      label: "提取任务",
      source: "extraction_attempts",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("extraction_attempts")
        .select("record_id,state,created_at,updated_at", { count: "exact" })
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_TASK_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.llm-catalog",
      label: "对话模型目录",
      source: "llm_models",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("llm_models")
        .select("id,model_name,api_endpoint,proxy_url,api_key,billing_mode,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,deep_thinking_type,enable_web_search,api_protocol_config,is_active,is_hidden,updated_at", { count: "exact" })
        .limit(MAX_MODEL_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.image-catalog",
      label: "图像模型目录",
      source: "cover_models",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("cover_models").select("id,is_active,is_hidden,updated_at", { count: "exact" }).limit(MAX_MODEL_ROWS_PER_SOURCE).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.video-catalog",
      label: "视频模型目录",
      source: "video_models",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("video_models").select("id,is_active,is_hidden", { count: "exact" }).limit(MAX_MODEL_ROWS_PER_SOURCE).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.credential-bindings",
      label: "独立凭据绑定",
      source: "platform_model_credential_bindings",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("platform_model_credential_bindings").select("model_key,updated_at", { count: "exact" }).limit(MAX_MODEL_ROWS_PER_SOURCE * 3).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.llm-validations",
      label: "对话模型通路验收证据",
      source: "llm_model_validation_evidence",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("llm_model_validation_evidence")
        .select("model_id,configuration_hash,checked_at", { count: "exact" })
        .order("checked_at", { ascending: false })
        .limit(MAX_MODEL_ROWS_PER_SOURCE * 2)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.image-validations",
      label: "图像真实验收",
      source: "image_model_validations",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("image_model_validations").select("model_id,state,published_at,updated_at", { count: "exact" }).limit(MAX_MODEL_ROWS_PER_SOURCE * 2).abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("models", {
      id: "models.video-health",
      label: "视频通道健康",
      source: "video_channel_health",
      drilldownUrl: "/admin?tab=models",
      read: () => db.from("video_channel_health")
        .select("channel_id,is_healthy,total_requests,consecutive_failures,last_success_at,last_fail_at,updated_at", { count: "exact" })
        .limit(MAX_MODEL_ROWS_PER_SOURCE)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("security", {
      id: "security.events",
      label: "安全事件",
      source: "security_events",
      drilldownUrl: "/admin?tab=security",
      read: () => db.from("security_events")
        .select("event_type,risk_level,blocked,created_at", { count: "exact" })
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_SECURITY_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("security", {
      id: "security.failed-logins",
      label: "失败登录",
      source: "login_logs",
      drilldownUrl: "/admin?tab=login-logs",
      read: () => db.from("login_logs")
        .select("status,created_at", { count: "exact" })
        .eq("status", "failed")
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_SECURITY_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("security", {
      id: "security.cases",
      label: "安全案件",
      source: "security_cases",
      drilldownUrl: "/admin?tab=security",
      read: () => db.from("security_cases")
        .select("status,risk_level,risk_score,event_count,last_seen_at,updated_at", { count: "exact" })
        .order("updated_at", { ascending: false })
        .limit(MAX_SECURITY_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("operations", {
      id: "operations.flight",
      label: "运行飞行事件",
      source: "operation_flight_events",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("operation_flight_events")
        .select("outcome,duration_ms,domain,source,occurred_at", { count: "exact" })
        .gte("occurred_at", from)
        .order("occurred_at", { ascending: false })
        .limit(MAX_OPERATION_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("operations", {
      id: "operations.system-errors",
      label: "系统错误日志",
      source: "system_logs",
      drilldownUrl: "/admin?tab=health",
      read: () => db.from("system_logs")
        .select("level,created_at", { count: "exact" })
        .in("level", ["error", "critical"])
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(MAX_OPERATION_ROWS)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
    readRowsFor("operations", {
      id: "operations.health",
      label: "持久化健康检查",
      source: "health_checks",
      drilldownUrl: "/admin?tab=health",
      staleAfterSeconds: 60 * 60,
      read: () => db.from("health_checks")
        .select("status,error_count,warning_count,created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    }),
  ]);

  const [
    projectRegistryResult,
    unifiedMessagingResult,
    incidentSloResult,
    backupRestoreResult,
    securityReliabilityResult,
    multitenantBoundaryResult,
    domainReleaseResult,
  ] = await Promise.allSettled([
    readControlPlaneFor("governance", () => readAdminProjectRegistrySnapshot()),
    readControlPlaneFor("governance", () => readUnifiedMessagingStatus(db as unknown as UnifiedMessagingDatabaseClient)),
    readControlPlaneFor("governance", () => readIncidentSloStatus()),
    readControlPlaneFor("governance", () => readAdminBackupRestoreSnapshot()),
    readControlPlaneFor("governance", () => getSecurityEventReliabilityStatus()),
    readControlPlaneFor("governance", () => readAdminMultitenantBoundarySnapshot()),
    readControlPlaneFor("governance", () => readDomainTlsBrandReleaseStatus()),
  ]) as [
    ControlPlaneResult<AdminProjectRegistrySnapshot>,
    ControlPlaneResult<UnifiedMessagingStatus>,
    ControlPlaneResult<IncidentSloStatus>,
    ControlPlaneResult<AdminBackupRestoreSnapshot>,
    ControlPlaneResult<Record<string, unknown>>,
    ControlPlaneResult<AdminMultitenantBoundarySnapshot>,
    ControlPlaneResult<DomainReleaseStatus>,
  ];

  const horizontalScale = horizontalScaleReadinessSnapshot();
  const horizontalScalePartialDimensions = horizontalScale.dimensions.filter((dimension) => dimension.state === "partial").length;
  const horizontalScaleSource = controlPlaneSource({
    id: "operations.horizontal-scale-readiness",
    label: "横向扩展就绪度",
    source: "horizontal_scale_readiness_source_audit",
    state: "partial",
    asOf: generatedAt,
    coverageRatio: horizontalScalePartialDimensions / horizontalScale.dimensions.length,
    returnedRows: horizontalScale.dimensions.length,
    totalRows: horizontalScale.dimensions.length,
    drilldownUrl: "/admin?tab=health",
  });

  const businessSources = [totalUsers.status, newUsers.status, activeUsers.status];
  const activeUserCount = activeUsers.status.state === "unavailable"
    ? null
    : new Set(activeUsers.rows.map((row) => String(row.user_id || "")).filter(Boolean)).size;
  const business: CommandCenterSection = {
    id: "business",
    title: "用户与经营",
    description: `统计窗口 ${hours} 小时；活跃用户以发生真实积分消费为准。`,
    metrics: [
      commandCenterMetric({
        id: "business.total-users",
        label: "平台注册用户",
        value: sourceCount(totalUsers),
        unit: "count",
        definition: "当前角色为 student 的平台注册账号总数。",
        sources: [totalUsers.status],
        drilldownUrl: "/admin?tab=users",
      }),
      commandCenterMetric({
        id: "business.new-users",
        label: "新增用户",
        value: sourceCount(newUsers),
        unit: "count",
        definition: `最近 ${hours} 小时创建的 student 账号数。`,
        sources: [newUsers.status],
        drilldownUrl: "/admin?tab=users",
      }),
      commandCenterMetric({
        id: "business.active-users",
        label: "消费活跃用户",
        value: activeUserCount,
        unit: "count",
        definition: `最近 ${hours} 小时至少发生一笔 consume 积分流水的去重用户数。`,
        sources: [activeUsers.status],
        drilldownUrl: "/admin?tab=credits",
      }),
    ],
  };

  const cashSnapshot = commandCenterFinanceCashSnapshot({
    onlineOrders: paymentReceipts.rows,
    offlineReceipts: offlineReceipts.rows,
    refundAttempts: refundAttempts.rows,
  });
  const receiptSources = [paymentReceipts.status, offlineReceipts.status];
  const netReceiptSources = [...receiptSources, refundAttempts.status];
  const finance: CommandCenterSection = {
    id: "finance",
    title: "资金与收益",
    description: "毛收款、已完成退款、净收款与退款冻结敞口分开呈现；任务计费快照不代表全平台会计利润。",
    metrics: [
      commandCenterMetric({
        id: "finance.cash-received",
        label: "实际收款（毛额）",
        value: cashSnapshot.grossCashReceived,
        unit: "currency_cny",
        definition: `最近 ${hours} 小时 paid 与 refunded 线上订单的原始确认金额（供应商实付快照优先）加已确认线下收款；这是毛收款，尚未扣除退款。`,
        sources: receiptSources,
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.completed-refunds",
        label: "已完成退款",
        value: cashSnapshot.completedRefundAmount,
        unit: "currency_cny",
        definition: `最近 ${hours} 小时 payment_refund_attempts 中 state=completed 且由供应商退款金额固化的证据之和；不以订单状态或请求意图替代完成证据。`,
        sources: [refundAttempts.status],
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.net-cash-received",
        label: "净收款快照",
        value: refundAttempts.status.state === "unavailable" ? null : cashSnapshot.netCashReceived,
        unit: "currency_cny",
        definition: `毛收款减去同一统计窗口内有 completed 持久化证据的退款；不扣除 reconciliation_required，因为其供应商终态仍未知。`,
        sources: netReceiptSources,
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.refund-frozen-exposure",
        label: "退款冻结敞口",
        value: cashSnapshot.reconciliationRequiredExposure,
        unit: "currency_cny",
        definition: `最近 ${hours} 小时 payment_refund_attempts 中 reconciliation_required 的原支付金额之和；该金额保持冻结并等待人工对账，不计入已完成退款或净收款扣减。`,
        sources: [refundAttempts.status],
        status: cashSnapshot.reconciliationRequiredExposure > 0 ? "warning" : "healthy",
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.usage-revenue",
        label: "使用收入",
        value: round(sum(revenue.rows, "selling_price")),
        unit: "currency_cny",
        definition: `最近 ${hours} 小时非免单任务的不可变 selling_price 收益快照之和，不从积分或当前兑换率反推。`,
        sources: [revenue.status],
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.provider-cost",
        label: "已配置供应商成本快照",
        value: round(sum(revenue.rows, "cost_price")),
        unit: "currency_cny",
        definition: `最近 ${hours} 小时 revenue_records 已记录的非免单任务 cost_price 快照之和；未入表、退款、税费及其他运营成本不在此数中。`,
        sources: [revenue.status],
        drilldownUrl: "/admin?tab=credits",
      }),
      commandCenterMetric({
        id: "finance.gross-profit",
        label: "任务毛利快照",
        value: round(sum(revenue.rows, "profit")),
        unit: "currency_cny",
        definition: `最近 ${hours} 小时 revenue_records 已记录任务的 profit 快照之和；仅用于任务计费观察，不等同财务报表毛利。`,
        sources: [revenue.status],
        status: sum(revenue.rows, "profit") < 0 ? "warning" : "healthy",
        drilldownUrl: "/admin?tab=credits",
      }),
    ],
  };

  const taskDatasets = [llmTasks, imageTasks, videoTasks, voiceTasks, extractionTasks];
  const taskSources = taskDatasets.map((dataset) => dataset.status);
  const taskRows = taskDatasets.flatMap((dataset) => dataset.rows);
  const successfulStates = new Set(["succeeded", "completed", "delivered", "success"]);
  const failedStates = new Set(["failed", "error"]);
  const attentionStates = new Set(["failed_unknown", "reconciliation_required", "recovery_required", "unknown"]);
  const succeeded = taskRows.filter((row) => successfulStates.has(taskState(row)) && !(taskState(row) === "completed" && row.delivery_state === "held")).length;
  const failed = taskRows.filter((row) => failedStates.has(taskState(row))).length;
  const needsAttention = taskRows.filter((row) => attentionStates.has(taskState(row)) || (taskState(row) === "completed" && row.delivery_state === "held")).length;
  const terminal = succeeded + failed;
  const successRate = commandCenterPercentage(succeeded, terminal);
  const tasks: CommandCenterSection = {
    id: "tasks",
    title: "任务与交付",
    description: "直接读取五类耐久任务表；未知终态和待交付结果不并入成功。",
    metrics: [
      commandCenterMetric({
        id: "tasks.observed",
        label: "任务记录",
        value: taskRows.length,
        unit: "count",
        definition: `最近 ${hours} 小时有界读取到的对话、生图、视频、语音和提取任务记录数。`,
        sources: taskSources,
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "tasks.success-rate",
        label: "明确终态成功率",
        value: successRate,
        unit: "percent",
        definition: "明确成功任务 ÷（明确成功 + 明确失败）；未知、需对账和待交付不进入分母。",
        sources: taskSources,
        status: rateStatus(successRate, 98, 90),
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "tasks.failed",
        label: "明确失败任务",
        value: failed,
        unit: "count",
        definition: "耐久任务状态为 failed 或 error 的记录数。",
        sources: taskSources,
        status: countStatus(failed, 10),
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "tasks.needs-attention",
        label: "待核对/待交付",
        value: needsAttention,
        unit: "count",
        definition: "failed_unknown、reconciliation_required、recovery_required、unknown，以及生成完成但交付仍 held 的记录数。",
        sources: taskSources,
        status: countStatus(needsAttention, 5),
        drilldownUrl: "/admin?tab=health",
      }),
    ],
  };

  const catalogDatasets = [llmModels, imageModels, videoModels];
  const catalogSources = catalogDatasets.map((dataset) => dataset.status);
  const visibleModelKeys = new Set<string>();
  for (const [table, dataset] of [
    ["llm_models", llmModels],
    ["cover_models", imageModels],
    ["video_models", videoModels],
  ] as const) {
    for (const row of dataset.rows.filter(visibleModel)) {
      const modelId = String(row.id || "").trim();
      if (modelId) visibleModelKeys.add(`${table}:${modelId}`);
    }
  }
  const boundModelKeys = new Set(credentialBindings.rows.map((row) => String(row.model_key || "")).filter(Boolean));
  const credentialCoverage = commandCenterCredentialCoveragePercent(visibleModelKeys, boundModelKeys);
  const validatedLlmModels = freshValidatedLlmModelIds(llmModels, llmValidations, Date.parse(generatedAt));
  const publishedImageModels = new Set(imageValidations.rows.filter((row) => row.state === "published").map((row) => String(row.model_id || "")).filter(Boolean));
  const successfulVideoModels = new Set(videoHealth.rows.filter((row) => Boolean(row.last_success_at)).map((row) => String(row.channel_id || "")).filter(Boolean));
  const unhealthyVideoChannels = videoHealth.rows.filter((row) => row.is_healthy === false && ((finiteNumber(row.total_requests) || 0) > 0 || Boolean(row.last_fail_at))).length;
  const models: CommandCenterSection = {
    id: "models",
    title: "模型与通道",
    description: "目录可见、凭据隔离和真实验收分别统计；未接入供应商只读余额时不展示余额数字。",
    metrics: [
      commandCenterMetric({
        id: "models.visible",
        label: "可见模型",
        value: visibleModelKeys.size,
        unit: "count",
        definition: "对话、图像、视频目录中未隐藏且未显式停用的模型数。",
        sources: catalogSources,
        drilldownUrl: "/admin?tab=models",
      }),
      commandCenterMetric({
        id: "models.credential-coverage",
        label: "独立凭据绑定覆盖率",
        value: credentialCoverage,
        unit: "percent",
        definition: "可见且启用模型键与 platform_model_credential_bindings 绑定键的交集 ÷ 可见且启用模型键数；无关、隐藏、停用或重复绑定不会扩大覆盖率，结果限定在 0–100%。",
        sources: [...catalogSources, credentialBindings.status],
        status: rateStatus(credentialCoverage, 100, 80),
        drilldownUrl: "/admin?tab=models",
      }),
      commandCenterMetric({
        id: "models.verified",
        label: "真实验收模型",
        value: validatedLlmModels.size + publishedImageModels.size + successfulVideoModels.size,
        unit: "count",
        definition: "对话模型仅计入当前配置与可解析服务端凭据一致、且通过统一七天与未来时间门禁的持久化通路指令证据；另计入发布图像验收或视频通道真实成功记录。通路指令验收不等于业务质量。",
        sources: [llmModels.status, llmValidations.status, imageValidations.status, videoHealth.status],
        drilldownUrl: "/admin?tab=models",
      }),
      commandCenterMetric({
        id: "models.unhealthy-video-channels",
        label: "异常视频通道",
        value: unhealthyVideoChannels,
        unit: "count",
        definition: "已有调用或失败记录且当前 is_healthy=false 的视频通道数。",
        sources: [videoHealth.status],
        status: countStatus(unhealthyVideoChannels, 3),
        drilldownUrl: "/admin?tab=models",
      }),
    ],
  };

  const highRiskEvents = securityEvents.rows.filter((row) => row.risk_level === "high" || row.risk_level === "critical").length;
  const criticalEvents = securityEvents.rows.filter((row) => row.risk_level === "critical").length;
  const blockedEvents = securityEvents.rows.filter((row) => row.blocked === true).length;
  const securityTotal = sourceCount(securityEvents);
  const blockedRate = commandCenterPercentage(blockedEvents, securityEvents.rows.length);
  const failedLoginCount = sourceCount(failedLogins);
  const security: CommandCenterSection = {
    id: "security",
    title: "安全态势",
    description: "安全事件与失败登录分源呈现；事件记录失败不会被解释为零风险。",
    metrics: [
      commandCenterMetric({
        id: "security.events",
        label: "安全事件",
        value: securityTotal,
        unit: "count",
        definition: `最近 ${hours} 小时 security_events 的精确记录数。`,
        sources: [securityEvents.status],
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "security.high-risk",
        label: "高危/严重事件",
        value: highRiskEvents,
        unit: "count",
        definition: "有界事件窗口中 risk_level 为 high 或 critical 的记录数。",
        sources: [securityEvents.status],
        status: criticalEvents > 0 ? "critical" : countStatus(highRiskEvents, 10),
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "security.blocked-rate",
        label: "事件拦截率",
        value: blockedRate,
        unit: "percent",
        definition: "有界安全事件中 blocked=true 的占比；它表示防护动作，不等于攻击成功率。",
        sources: [securityEvents.status],
        status: blockedRate == null ? "unknown" : "healthy",
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "security.failed-logins",
        label: "失败登录",
        value: failedLoginCount,
        unit: "count",
        definition: `最近 ${hours} 小时 login_logs 中 status=failed 的精确记录数。`,
        sources: [failedLogins.status],
        status: countStatus(failedLoginCount, 20),
        drilldownUrl: "/admin?tab=login-logs",
      }),
    ],
  };

  const flightErrors = flightEvents.rows.filter((row) => row.outcome === "error").length;
  const flightTotal = flightEvents.rows.length;
  const flightErrorRate = commandCenterPercentage(flightErrors, flightTotal);
  const durations = flightEvents.rows.map((row) => finiteNumber(row.duration_ms)).filter((value): value is number => value != null && value >= 0);
  const p95 = percentile(durations, 0.95);
  const systemErrorCount = sourceCount(systemErrors);
  const healthRow = latestHealth.rows[0];
  const healthValue = healthRow ? String(healthRow.status || "unknown") : "尚无持久化检查";
  const healthStatus: CommandCenterMetricStatus = !healthRow
    ? "unknown"
    : healthValue === "healthy" || healthValue === "ok"
      ? "healthy"
      : healthValue === "unhealthy"
        ? "critical"
        : "warning";
  const operations: CommandCenterSection = {
    id: "operations",
    title: "系统运维",
    description: "飞行日志、系统错误与持久化健康检查互相独立，任一缺源都会明确显示。",
    metrics: [
      commandCenterMetric({
        id: "operations.error-rate",
        label: "运行错误率",
        value: flightErrorRate,
        unit: "percent",
        definition: `最近 ${hours} 小时有界 operation_flight_events 中 outcome=error 的占比。`,
        sources: [flightEvents.status],
        status: flightErrorRate == null ? "unknown" : flightErrorRate >= 5 ? "critical" : flightErrorRate >= 1 ? "warning" : "healthy",
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "operations.p95-duration",
        label: "P95 业务耗时",
        value: p95,
        unit: "milliseconds",
        definition: "有 duration_ms 的飞行事件 P95；不含缺少耗时证据的事件。",
        sources: [flightEvents.status],
        status: p95 == null ? "unknown" : p95 >= 10_000 ? "critical" : p95 >= 3_000 ? "warning" : "healthy",
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "operations.system-errors",
        label: "系统错误日志",
        value: systemErrorCount,
        unit: "count",
        definition: `最近 ${hours} 小时 system_logs 中 error 或 critical 的精确记录数。`,
        sources: [systemErrors.status],
        status: countStatus(systemErrorCount, 10),
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "operations.health-state",
        label: "最近健康检查",
        value: healthValue,
        unit: "text",
        definition: "health_checks 最近一条持久化诊断状态；不是当前请求临时生成的假健康值。",
        sources: [latestHealth.status],
        status: healthStatus,
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "operations.horizontal-scale-readiness",
        label: "横向扩展就绪度",
        value: `${horizontalScalePartialDimensions}/${horizontalScale.dimensions.length} 局部基础`,
        unit: "text",
        definition: "源码审计中仅部分具备基础的扩展维度数；当前仍是单 Web，容量目标尚未压测，不能解释为可扩容实例数或吞吐能力。",
        sources: [horizontalScaleSource],
        status: "warning",
        drilldownUrl: "/admin?tab=health",
      }),
    ],
  };

  const projectRegistry = projectRegistryResult.status === "fulfilled" ? projectRegistryResult.value : null;
  const projectSourceCoverage = projectRegistry?.consistency.sourceCoverage;
  const projectCoverageRatio = projectSourceCoverage && projectSourceCoverage.expected > 0
    ? projectSourceCoverage.mapped / projectSourceCoverage.expected
    : null;
  const projectControlSource = projectRegistry
    ? controlPlaneSource({
        id: "governance.project-registry",
        label: "项目注册表",
        source: "project_registry_control_plane",
        state: projectRegistry.registryState,
        asOf: projectRegistry.generatedAt,
        coverageRatio: projectCoverageRatio,
        returnedRows: projectRegistry.projects.length + projectRegistry.workspaces.length + projectRegistry.sourceMappings.length,
        totalRows: projectRegistry.projects.length + projectRegistry.workspaces.length + projectRegistry.sourceMappings.length,
        drilldownUrl: "/admin?tab=dashboard",
      })
    : unavailableControlPlaneSource({
        id: "governance.project-registry",
        label: "项目注册表",
        source: "project_registry_control_plane",
        drilldownUrl: "/admin?tab=dashboard",
        errorCode: "PROJECT_REGISTRY_READ_FAILED",
      });

  const unifiedMessaging = unifiedMessagingResult.status === "fulfilled" ? unifiedMessagingResult.value : null;
  const connectedMessageChains = unifiedMessaging?.integration.connectedLegacyChains.length || 0;
  const totalMessageChains = connectedMessageChains + (unifiedMessaging?.integration.pendingLegacyChains.length || 0);
  const messageCoverageRatio = totalMessageChains > 0 ? connectedMessageChains / totalMessageChains : null;
  const messagingControlSource = unifiedMessaging
    ? controlPlaneSource({
        id: "governance.unified-messaging",
        label: "统一消息控制平面",
        source: "unified_messaging_control_plane",
        state: unifiedMessaging.integration.endUserSurfacesConnected ? "available" : "partial",
        asOf: unifiedMessaging.database.asOf,
        coverageRatio: messageCoverageRatio,
        returnedRows: Object.values(unifiedMessaging.database.tableCounts).reduce((total, value) => total + value, 0),
        totalRows: null,
        drilldownUrl: "/admin?tab=announcements",
      })
    : unavailableControlPlaneSource({
        id: "governance.unified-messaging",
        label: "统一消息控制平面",
        source: "unified_messaging_control_plane",
        drilldownUrl: "/admin?tab=announcements",
        errorCode: "UNIFIED_MESSAGING_STATUS_UNAVAILABLE",
      });

  const incidentSlo = incidentSloResult.status === "fulfilled" ? incidentSloResult.value : null;
  const sloDefinitionCount = incidentSlo?.database.definitions.length || 0;
  const availableSloCount = incidentSlo?.database.measurements.available || 0;
  const sloCoverageRatio = sloDefinitionCount > 0 ? availableSloCount / sloDefinitionCount : null;
  const incidentControlSource = incidentSlo
    ? controlPlaneSource({
        id: "governance.incident-slo",
        label: "事故与 SLO 控制平面",
        source: "incident_slo_control_plane",
        state: incidentSlo.integration.collectorsConnected ? "available" : "partial",
        asOf: incidentSlo.database.asOf,
        coverageRatio: sloCoverageRatio,
        returnedRows: Object.values(incidentSlo.database.tableCounts).reduce((total, value) => total + value, 0),
        totalRows: null,
        drilldownUrl: "/admin?tab=health",
      })
    : unavailableControlPlaneSource({
        id: "governance.incident-slo",
        label: "事故与 SLO 控制平面",
        source: "incident_slo_control_plane",
        drilldownUrl: "/admin?tab=health",
        errorCode: "INCIDENT_SLO_STATUS_UNAVAILABLE",
      });

  const backupRestore = backupRestoreResult.status === "fulfilled" ? backupRestoreResult.value : null;
  const backupCoverage = backupRestore?.consistency.backupRunCoverage;
  const backupCoverageRatio = backupCoverage && backupCoverage.expectedTargets > 0
    ? backupCoverage.verifiedTargets / backupCoverage.expectedTargets
    : null;
  const backupControlSource = backupRestore && backupRestore.schemaState === "available"
    ? controlPlaneSource({
        id: "governance.backup-restore",
        label: "备份与恢复证据",
        source: "backup_restore_control_plane",
        state: backupRestore.evidenceState === "available" ? "available" : "partial",
        asOf: backupRestore.generatedAt,
        coverageRatio: backupCoverageRatio,
        returnedRows: backupRestore.targets.length + backupRestore.runs.length + backupRestore.drills.length,
        totalRows: null,
        drilldownUrl: "/admin?tab=backup",
      })
    : unavailableControlPlaneSource({
        id: "governance.backup-restore",
        label: "备份与恢复证据",
        source: "backup_restore_control_plane",
        drilldownUrl: "/admin?tab=backup",
        errorCode: "BACKUP_RESTORE_STATUS_UNAVAILABLE",
      });

  const securityReliability = securityReliabilityResult.status === "fulfilled"
    ? securityReliabilityResult.value
    : null;
  const reliabilityCheckpoints = securityReliability
    ? [
        securityReliability.producerDeliveryDurable === true,
        securityReliability.preReceiverLossObservable === true,
        securityReliability.receiverInlineDrainEnabled === true,
        securityReliability.retryWorkerScheduled === true,
        securityReliability.retentionPolicyConfigured === true,
        securityReliability.retentionPurgeExecutorAvailable === true,
      ]
    : [];
  const reliableCheckpointCount = reliabilityCheckpoints.filter(Boolean).length;
  const securityReliabilitySource = securityReliability
    ? controlPlaneSource({
        id: "governance.security-event-reliability",
        label: "安全事件可靠链",
        source: "security_event_reliability_control_plane",
        state: reliableCheckpointCount === reliabilityCheckpoints.length ? "available" : "partial",
        asOf: generatedAt,
        coverageRatio: reliableCheckpointCount / reliabilityCheckpoints.length,
        returnedRows: finiteNumber(securityReliability.acceptedUnique) || 0,
        totalRows: null,
        drilldownUrl: "/admin?tab=security",
      })
    : unavailableControlPlaneSource({
        id: "governance.security-event-reliability",
        label: "安全事件可靠链",
        source: "security_event_reliability_control_plane",
        drilldownUrl: "/admin?tab=security",
        errorCode: "SECURITY_EVENT_RELIABILITY_STATUS_UNAVAILABLE",
      });

  const multitenantBoundary = multitenantBoundaryResult.status === "fulfilled"
    ? multitenantBoundaryResult.value
    : null;
  const tenantResourceCoverage = multitenantBoundary?.consistency.coverage.resources;
  const tenantCoverageRatio = tenantResourceCoverage && tenantResourceCoverage.expected > 0
    ? tenantResourceCoverage.integrated / tenantResourceCoverage.expected
    : null;
  const multitenantBoundarySource = multitenantBoundary && !multitenantBoundary.migrationRequired
    ? controlPlaneSource({
        id: "governance.multitenant-boundary",
        label: "多租户隔离边界",
        source: "multitenant_brand_boundary",
        state: multitenantBoundary.boundaryState === "verified" ? "available" : "partial",
        asOf: multitenantBoundary.generatedAt,
        coverageRatio: tenantCoverageRatio,
        returnedRows: multitenantBoundary.tenants.length
          + multitenantBoundary.sites.length
          + multitenantBoundary.resourceIntegrations.length
          + multitenantBoundary.isolationReceipts.length,
        totalRows: null,
        drilldownUrl: "/admin?tab=general",
      })
    : unavailableControlPlaneSource({
        id: "governance.multitenant-boundary",
        label: "多租户隔离边界",
        source: "multitenant_brand_boundary",
        drilldownUrl: "/admin?tab=general",
        errorCode: "MULTITENANT_BOUNDARY_STATUS_UNAVAILABLE",
      });

  const domainRelease = domainReleaseResult.status === "fulfilled" ? domainReleaseResult.value : null;
  const domainConnectedSources = domainRelease?.integration.connectedSources.length || 0;
  const domainPendingSources = domainRelease?.integration.pendingSources.length || 0;
  const domainSourceTotal = domainConnectedSources + domainPendingSources;
  const domainCoverageRatio = domainSourceTotal > 0 ? domainConnectedSources / domainSourceTotal : null;
  const domainReleaseSource = domainRelease
    ? controlPlaneSource({
        id: "governance.domain-release",
        label: "域名、TLS 与贴牌发布",
        source: "domain_tls_brand_release_control_plane",
        state: domainPendingSources === 0 && domainSourceTotal > 0 ? "available" : "partial",
        asOf: domainRelease.database.asOf,
        coverageRatio: domainCoverageRatio,
        returnedRows: Object.values(domainRelease.database.tableCounts).reduce((total, value) => total + value, 0),
        totalRows: null,
        drilldownUrl: "/admin?tab=general",
      })
    : unavailableControlPlaneSource({
        id: "governance.domain-release",
        label: "域名、TLS 与贴牌发布",
        source: "domain_tls_brand_release_control_plane",
        drilldownUrl: "/admin?tab=general",
        errorCode: "DOMAIN_RELEASE_STATUS_UNAVAILABLE",
      });

  const securityCaseControlSource: CommandCenterSourceStatus = securityCases.status.state === "unavailable"
    ? securityCases.status
    : {
        ...securityCases.status,
        state: "partial",
        partial: true,
        coverageRatio: 0,
      };
  const activeSecurityCases = securityCases.status.state === "unavailable"
    ? null
    : securityCases.rows.filter((row) => !new Set(["resolved", "false_positive"]).has(String(row.status || ""))).length;
  const messageDeadLetters = unifiedMessaging?.database.deadLetters.open ?? null;
  const securityDeadLetters = securityReliability ? finiteNumber(securityReliability.deadLetterUnique) : null;
  const incidentCollectorsConnected = Boolean(incidentSlo?.integration.collectorsConnected);
  const verifiedBackups = backupRestore?.consistency.backupRunCoverage.verifiedTargets ?? null;
  const verifiedRestoreDrills = backupRestore?.consistency.restoreDrillCoverage.verifiedTargets ?? null;
  const governance: CommandCenterSection = {
    id: "governance",
    title: "治理与闭环",
    description: "项目、消息、安全案件、SLO/事故和灾备采用独立控制平面；未接入生产者或采集器时保持部分覆盖或不可用。",
    metrics: [
      commandCenterMetric({
        id: "governance.project-workspaces",
        label: "工作区项目归属",
        value: projectRegistry ? `${projectRegistry.consistency.workspaceCoverage.mapped}/${projectRegistry.consistency.workspaceCoverage.expected}` : null,
        unit: "text",
        definition: "已验证工作区路由映射数 ÷ 目录中应登记工作区数。",
        sources: [projectControlSource],
        status: projectRegistry?.consistency.workspaceCoverage.unavailable === 0 ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=dashboard",
      }),
      commandCenterMetric({
        id: "governance.unregistered-sources",
        label: "未登记项目来源",
        value: projectSourceCoverage?.unregistered ?? null,
        unit: "count",
        definition: "任务、账单或通知来源缺少可验证 project_key 的数量；不会按表名猜测归属。",
        sources: [projectControlSource],
        status: countStatus(projectSourceCoverage?.unregistered ?? null, 1),
        drilldownUrl: "/admin?tab=dashboard",
      }),
      commandCenterMetric({
        id: "governance.message-integration",
        label: "消息链统一进度",
        value: unifiedMessaging ? `${connectedMessageChains}/${totalMessageChains}` : null,
        unit: "text",
        definition: "已接入统一 outbox/投递/事件链的历史消息系统数；基础表存在不等于消费端已闭环。",
        sources: [messagingControlSource],
        status: connectedMessageChains === totalMessageChains && totalMessageChains > 0 ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=announcements",
      }),
      commandCenterMetric({
        id: "governance.message-dead-letters",
        label: "消息开放死信",
        value: messageDeadLetters,
        unit: "count",
        definition: "统一消息控制平面中尚未解决的死信；旧消息链未接入部分不计入该数字。",
        sources: [messagingControlSource],
        status: countStatus(messageDeadLetters, 1),
        drilldownUrl: "/admin?tab=announcements",
      }),
      commandCenterMetric({
        id: "governance.open-security-cases",
        label: "开放安全案件",
        value: activeSecurityCases,
        unit: "count",
        definition: "状态不是 resolved/false_positive 的案件数；自动事件接入尚未完整时明确标记部分覆盖。",
        sources: [securityCaseControlSource],
        status: countStatus(activeSecurityCases, 5),
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "governance.security-event-durability",
        label: "安全事件可靠链",
        value: securityReliability ? `${reliableCheckpointCount}/${reliabilityCheckpoints.length}` : null,
        unit: "text",
        definition: "生产端耐久投递、接收前丢失可观测、接收端落盘、重试 worker、保留策略和清理执行器六项闭环检查；仅接收端有 outbox 不等于全链可靠。",
        sources: [securityReliabilitySource],
        status: reliableCheckpointCount === reliabilityCheckpoints.length && reliabilityCheckpoints.length > 0 ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "governance.security-event-dead-letters",
        label: "安全事件死信",
        value: securityDeadLetters,
        unit: "count",
        definition: "可靠接收端 outbox 中进入 dead_letter 的唯一安全事件数；尚未接入的 proxy 生产端损失不计入该数字。",
        sources: [securityReliabilitySource],
        status: countStatus(securityDeadLetters, 1),
        drilldownUrl: "/admin?tab=security",
      }),
      commandCenterMetric({
        id: "governance.tenant-isolation",
        label: "租户资源隔离",
        value: tenantResourceCoverage ? `${tenantResourceCoverage.integrated}/${tenantResourceCoverage.expected}` : null,
        unit: "text",
        definition: "已具备 tenant/site 字段、会话 claim、读写传播、租户 RLS 和跨租户拒绝回执的资源数；当前单租户基础表不计为隔离完成。",
        sources: [multitenantBoundarySource],
        status: multitenantBoundary?.boundaryState === "verified" ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=general",
      }),
      commandCenterMetric({
        id: "governance.domain-release",
        label: "域名贴牌发布",
        value: domainRelease
          ? `${domainRelease.database.states.published}/${domainRelease.database.tableCounts.hostnames}`
          : null,
        unit: "text",
        definition: "有完整 DNS、TLS、HTTPS、网关和品牌绑定证据的已发布域名数 ÷ 已认领域名数；未执行真实外部探测时保持部分覆盖。",
        sources: [domainReleaseSource],
        status: domainPendingSources === 0 && domainSourceTotal > 0 ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=general",
      }),
      commandCenterMetric({
        id: "governance.unknown-host-gate",
        label: "未知 Host 硬拒绝",
        value: domainRelease
          ? domainRelease.hostRoutingPolicy.enforcementActive ? "已启用" : "未接入"
          : null,
        unit: "text",
        definition: "可信 Host→site 解析和未知 Host 421/404 拒绝的运行时证据；目标策略不能冒充当前生效状态。",
        sources: [domainReleaseSource],
        status: domainRelease?.hostRoutingPolicy.enforcementActive ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=general",
      }),
      commandCenterMetric({
        id: "governance.active-incidents",
        label: "活动事故",
        value: incidentCollectorsConnected ? incidentSlo?.database.incidents.active ?? null : null,
        unit: "count",
        definition: "SLO 采集器接入后才显示活动事故；当前仅有控制面时不以 0 冒充无事故。",
        sources: [incidentControlSource],
        status: incidentCollectorsConnected ? countStatus(incidentSlo?.database.incidents.active ?? null, 1) : "warning",
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "governance.slo-coverage",
        label: "可用 SLO 覆盖率",
        value: incidentCollectorsConnected && sloCoverageRatio != null ? round(sloCoverageRatio * 100, 1) : null,
        unit: "percent",
        definition: "有可用测量窗口的 SLO 定义 ÷ 全部 SLO 定义；未接采集器时显示不可用。",
        sources: [incidentControlSource],
        status: incidentCollectorsConnected ? rateStatus(sloCoverageRatio == null ? null : sloCoverageRatio * 100, 100, 80) : "warning",
        drilldownUrl: "/admin?tab=health",
      }),
      commandCenterMetric({
        id: "governance.verified-backups",
        label: "已核验备份目标",
        value: backupRestore && backupCoverage ? `${verifiedBackups}/${backupCoverage.expectedTargets}` : null,
        unit: "text",
        definition: "具有恢复点、manifest、校验和和产物回执的目标数；政策目标不计为完成。",
        sources: [backupControlSource],
        status: verifiedBackups === backupCoverage?.expectedTargets && verifiedBackups !== null ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=backup",
      }),
      commandCenterMetric({
        id: "governance.verified-restore-drills",
        label: "已核验隔离恢复",
        value: backupRestore ? `${verifiedRestoreDrills}/${backupRestore.consistency.restoreDrillCoverage.expectedTargets}` : null,
        unit: "text",
        definition: "完成隔离、零生产写入、关键数据检查和 RPO/RTO 回执的目标数。",
        sources: [backupControlSource],
        status: verifiedRestoreDrills === backupRestore?.consistency.restoreDrillCoverage.expectedTargets && verifiedRestoreDrills !== null ? "healthy" : "warning",
        drilldownUrl: "/admin?tab=backup",
      }),
    ],
  };

  const allSections = [business, finance, tasks, models, security, operations, governance];
  const sections = allSections.filter((section) => viewDefinition.sectionIds.includes(section.id));
  const referencedSourceIds = new Set(sections.flatMap((section) => section.metrics.flatMap((metric) => metric.sourceIds)));
  const allSources = commandCenterApplyFreshnessState([
    ...businessSources,
    ...receiptSources,
    refundAttempts.status,
    revenue.status,
    ...taskSources,
    ...catalogSources,
    credentialBindings.status,
    llmValidations.status,
    imageValidations.status,
    videoHealth.status,
    securityEvents.status,
    failedLogins.status,
    securityCaseControlSource,
    flightEvents.status,
    systemErrors.status,
    latestHealth.status,
    horizontalScaleSource,
    projectControlSource,
    messagingControlSource,
    incidentControlSource,
    backupControlSource,
    securityReliabilitySource,
    multitenantBoundarySource,
    domainReleaseSource,
  ]);
  const sources = allSources.filter((source) => (
    source.errorCode !== "VIEW_NOT_REQUESTED"
    && (view === "evidence" || referencedSourceIds.has(source.id))
  ));
  const sourceAnomalies = commandCenterSourceAnomalies(sources, generatedAt);
  const dataQuality = commandCenterDataQuality(sources, sourceAnomalies);
  const snapshotHasher = createHash("sha256");
  snapshotHasher.write(JSON.stringify({
    definitionVersion: COMMAND_CENTER_DEFINITION_VERSION,
    generatedAt,
    hours,
    view,
    sections,
    sources,
    sourceAnomalies,
  }));
  snapshotHasher.end();
  const snapshotId = `cc-${snapshotHasher.digest("hex").slice(0, 16)}`;
  const buildDurationMs = Math.max(0, Math.round(performance.now() - buildStartedAt));
  const nextRefreshAt = new Date(Date.parse(generatedAt) + viewDefinition.pollIntervalMs).toISOString();
  return {
    schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
    definitionVersion: COMMAND_CENTER_DEFINITION_VERSION,
    snapshotId,
    generatedAt,
    asOf: generatedAt,
    freshnessSeconds: 0,
    view,
    includedSectionIds: sections.map((section) => section.id),
    window: { hours, from, to: generatedAt, timeZone: "Asia/Shanghai" },
    overallStatus: commandCenterOverallStatus(sections, sourceAnomalies),
    sections,
    sources,
    sourceAnomalies,
    dataQuality,
    refresh: {
      pollIntervalMs: viewDefinition.pollIntervalMs,
      nextRefreshAt,
      cacheStatus: "miss",
      buildDurationMs,
      rateLimit: {
        scope: "process-local-admin-view",
        limit: 1,
        intervalMs: viewDefinition.manualRefreshMinIntervalMs,
        remaining: 1,
        retryAfterSeconds: 0,
        nextAllowedAt: generatedAt,
      },
      readOnly: true,
      providerCalls: 0,
      businessWrites: 0,
    },
  };
}

function deliverSnapshot(
  snapshot: CommandCenterSnapshot,
  cacheStatus: CommandCenterSnapshot["refresh"]["cacheStatus"],
  deliveredAtEpoch: number,
): CommandCenterSnapshot {
  const generatedAtEpoch = Date.parse(snapshot.generatedAt);
  const freshnessSeconds = Number.isFinite(generatedAtEpoch)
    ? Math.max(0, Math.floor((deliveredAtEpoch - generatedAtEpoch) / 1_000))
    : 0;
  return {
    ...snapshot,
    asOf: snapshot.generatedAt,
    freshnessSeconds,
    refresh: {
      ...snapshot.refresh,
      cacheStatus,
      nextRefreshAt: new Date(deliveredAtEpoch + snapshot.refresh.pollIntervalMs).toISOString(),
    },
  };
}

export async function readAdminCommandCenterSnapshot(options: {
  hours: number;
  view: CommandCenterView;
  bypassCache?: boolean;
}): Promise<CommandCenterSnapshot> {
  const now = Date.now();
  const cacheKey = `${options.view}:${options.hours}`;
  const cached = snapshotCache.get(cacheKey);
  if (cached && !cached.settled) {
    return deliverSnapshot(await cached.promise, "shared", Date.now());
  }
  if (!options.bypassCache && cached && cached.expiresAt > now) {
    return deliverSnapshot(await cached.promise, "hit", Date.now());
  }

  const entry: CommandCenterCacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    settled: false,
    promise: Promise.resolve(null as unknown as CommandCenterSnapshot),
  };
  entry.promise = buildSnapshot(options.hours, options.view)
    .catch((error) => {
      if (snapshotCache.get(cacheKey) === entry) snapshotCache.delete(cacheKey);
      throw error;
    })
    .finally(() => {
      entry.settled = true;
    });
  snapshotCache.set(cacheKey, entry);
  return deliverSnapshot(await entry.promise, "miss", Date.now());
}
