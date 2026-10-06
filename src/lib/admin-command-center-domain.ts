export const COMMAND_CENTER_SCHEMA_VERSION = 5 as const;
export const COMMAND_CENTER_DEFINITION_VERSION = "2026-10-03.v1" as const;
export const COMMAND_CENTER_POLL_INTERVAL_MS = 15_000;

export const COMMAND_CENTER_VIEWS = [
  "overview",
  "members",
  "revenue",
  "production",
  "security",
  "system",
  "evidence",
] as const;

export type CommandCenterView = (typeof COMMAND_CENTER_VIEWS)[number];
export type CommandCenterSectionId = "business" | "finance" | "tasks" | "models" | "security" | "operations" | "governance";

export type CommandCenterPermissionKey =
  | "logs.view"
  | "members.view"
  | "billing.view"
  | "models.view"
  | "security.view"
  | "announcements.manage"
  | "backups.manage"
  | "platform.settings.manage"
  | "brand.settings.manage"
  | "integrations.manage"
  | "payment.settings.manage"
  | "white_label.manage";

/**
 * One authority map is shared by the navigation, deep-link normalizer, proxy
 * policy and route-local authorization. A view is visible only when every key
 * listed for that view is granted. The API repeats the same check before any
 * source query, so hiding a button is never treated as an authorization gate.
 */
export const COMMAND_CENTER_VIEW_PERMISSION_KEYS: Readonly<Record<CommandCenterView, readonly CommandCenterPermissionKey[]>> = {
  overview: ["logs.view", "members.view", "billing.view", "models.view", "security.view"],
  members: ["members.view"],
  revenue: ["billing.view"],
  production: ["models.view"],
  security: ["security.view"],
  system: ["logs.view"],
  evidence: [
    "logs.view",
    "members.view",
    "billing.view",
    "models.view",
    "security.view",
    "announcements.manage",
    "backups.manage",
    "platform.settings.manage",
    "brand.settings.manage",
    "integrations.manage",
    "payment.settings.manage",
    "white_label.manage",
  ],
} as const;

// These five capabilities each unlock at least one bounded target view.
// Governance-only capabilities do not expose an empty dashboard by themselves.
export const COMMAND_CENTER_ENTRY_PERMISSION_KEYS = [
  "logs.view",
  "members.view",
  "billing.view",
  "models.view",
  "security.view",
] as const satisfies readonly CommandCenterPermissionKey[];

export const COMMAND_CENTER_ALL_PERMISSION_KEYS = [
  "logs.view",
  "members.view",
  "billing.view",
  "models.view",
  "security.view",
  "announcements.manage",
  "backups.manage",
  "platform.settings.manage",
  "brand.settings.manage",
  "integrations.manage",
  "payment.settings.manage",
  "white_label.manage",
] as const satisfies readonly CommandCenterPermissionKey[];

export function commandCenterPermissionKeysForView(
  view: CommandCenterView,
): readonly CommandCenterPermissionKey[] {
  return COMMAND_CENTER_VIEW_PERMISSION_KEYS[view];
}

export function visibleCommandCenterViews(
  grantedPermissionKeys: readonly string[],
  isSuperAdmin = false,
): CommandCenterView[] {
  if (isSuperAdmin) return [...COMMAND_CENTER_VIEWS];
  const granted = new Set(grantedPermissionKeys);
  return COMMAND_CENTER_VIEWS.filter((view) =>
    COMMAND_CENTER_VIEW_PERMISSION_KEYS[view].every((permissionKey) => granted.has(permissionKey)),
  );
}

export function normalizeVisibleCommandCenterView(
  value: unknown,
  visibleViews: readonly CommandCenterView[],
): CommandCenterView | null {
  const visible = new Set<CommandCenterView>(visibleViews);
  return isCommandCenterView(value) && visible.has(value)
    ? value
    : visibleViews[0] || null;
}

export interface CommandCenterViewDefinition {
  id: CommandCenterView;
  label: string;
  description: string;
  sectionIds: readonly CommandCenterSectionId[];
  querySectionIds: readonly CommandCenterSectionId[];
  pollIntervalMs: number;
  manualRefreshMinIntervalMs: number;
}

export const COMMAND_CENTER_VIEW_DEFINITIONS: readonly CommandCenterViewDefinition[] = [
  {
    id: "overview",
    label: "总览",
    description: "跨用户、资金、交付、安全与运行的核心信号，只展示需要立即判断的状态。",
    sectionIds: ["business", "finance", "tasks", "security", "operations"],
    querySectionIds: ["business", "finance", "tasks", "security", "operations"],
    pollIntervalMs: 30_000,
    manualRefreshMinIntervalMs: 15_000,
  },
  {
    id: "members",
    label: "会员增长",
    description: "查看用户规模、新增与真实消费活跃，不用聊天量替代会员活跃。",
    sectionIds: ["business"],
    querySectionIds: ["business"],
    pollIntervalMs: 120_000,
    manualRefreshMinIntervalMs: 60_000,
  },
  {
    id: "revenue",
    label: "充值营收",
    description: "核对收款、退款、净入账与任务收益，保留订单和到账证据差异。",
    sectionIds: ["finance"],
    querySectionIds: ["finance"],
    pollIntervalMs: 120_000,
    manualRefreshMinIntervalMs: 60_000,
  },
  {
    id: "production",
    label: "生产交付",
    description: "查看文案、生图、视频、语音和提取任务终态，以及模型通道证据。",
    sectionIds: ["tasks", "models"],
    querySectionIds: ["tasks", "models"],
    pollIntervalMs: 30_000,
    manualRefreshMinIntervalMs: 15_000,
  },
  {
    id: "security",
    label: "安全风险",
    description: "查看高风险事件、失败登录和拦截结果，避免把被尝试账号误判为攻击者。",
    sectionIds: ["security"],
    querySectionIds: ["security"],
    pollIntervalMs: 10_000,
    manualRefreshMinIntervalMs: 5_000,
  },
  {
    id: "system",
    label: "系统运行",
    description: "查看业务请求耗时、系统错误和持久化健康状态；未接入的负载指标保持未知。",
    sectionIds: ["operations"],
    querySectionIds: ["operations"],
    pollIntervalMs: 30_000,
    manualRefreshMinIntervalMs: 15_000,
  },
  {
    id: "evidence",
    label: "数据证据",
    description: "按来源检查覆盖率、新鲜度、异常和治理闭环；此视图会读取全部已登记来源。",
    sectionIds: ["governance"],
    querySectionIds: ["business", "finance", "tasks", "models", "security", "operations", "governance"],
    pollIntervalMs: 60_000,
    manualRefreshMinIntervalMs: 30_000,
  },
] as const;

const COMMAND_CENTER_VIEW_SET = new Set<string>(COMMAND_CENTER_VIEWS);

export function isCommandCenterView(value: unknown): value is CommandCenterView {
  return typeof value === "string" && COMMAND_CENTER_VIEW_SET.has(value);
}

export function normalizeCommandCenterView(value: unknown): CommandCenterView {
  return isCommandCenterView(value) ? value : "overview";
}

export function commandCenterViewDefinition(view: CommandCenterView): CommandCenterViewDefinition {
  return COMMAND_CENTER_VIEW_DEFINITIONS.find((candidate) => candidate.id === view) || COMMAND_CENTER_VIEW_DEFINITIONS[0];
}

export interface CommandCenterViewReadGate {
  readonly querySectionIds: readonly CommandCenterSectionId[];
  requested(sectionId: CommandCenterSectionId): boolean;
  read<T>(
    sectionId: CommandCenterSectionId,
    reader: () => Promise<T>,
    skipped: () => Promise<T> | T,
  ): Promise<T>;
}

/**
 * The production snapshot builder and contract tests share this gate. Keeping
 * the reader injectable makes it possible to prove that an unrequested view
 * section does not touch its database or control-plane reader at all.
 */
export function createCommandCenterViewReadGate(view: CommandCenterView): CommandCenterViewReadGate {
  const querySectionIds = [...commandCenterViewDefinition(view).querySectionIds];
  const requestedSections = new Set<CommandCenterSectionId>(querySectionIds);
  return {
    querySectionIds,
    requested: (sectionId) => requestedSections.has(sectionId),
    read: async (sectionId, reader, skipped) => requestedSections.has(sectionId)
      ? reader()
      : skipped(),
  };
}

/**
 * Only emit an admin drilldown when the current administrator can see the
 * destination tab. Unknown, external and protocol-relative URLs fail closed.
 */
export function commandCenterAuthorizedDrilldownUrl(
  value: unknown,
  allowedAdminTabs: readonly string[],
): string | null {
  if (typeof value !== "string" || !value.startsWith("/admin")) return null;
  try {
    const base = "https://command-center.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base || parsed.pathname !== "/admin") return null;
    const tab = parsed.searchParams.get("tab");
    if (!tab || !new Set(allowedAdminTabs).has(tab)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export type CommandCenterMetricStatus = "healthy" | "warning" | "critical" | "unknown" | "unavailable";
export type CommandCenterSourceState = "available" | "partial" | "stale" | "unavailable";
export type CommandCenterMetricValue = number | string | null;

export interface CommandCenterSourceStatus {
  id: string;
  label: string;
  source: string;
  state: CommandCenterSourceState;
  asOf: string | null;
  latestRecordAt: string | null;
  freshnessSeconds: number | null;
  coverageRatio: number | null;
  returnedRows: number;
  totalRows: number | null;
  partial: boolean;
  errorCode: string | null;
  drilldownUrl: string;
  staleAfterSeconds: number | null;
}

export interface CommandCenterMetric {
  id: string;
  label: string;
  value: CommandCenterMetricValue;
  unit: "count" | "currency_cny" | "percent" | "milliseconds" | "seconds" | "text";
  definition: string;
  source: string[];
  sourceIds: string[];
  asOf: string | null;
  freshnessSeconds: number | null;
  coverageRatio: number | null;
  partial: boolean;
  status: CommandCenterMetricStatus;
  drilldownUrl: string;
}

export interface CommandCenterDataQuality {
  totalSources: number;
  availableSources: number;
  partialSources: number;
  unavailableSources: number;
  staleSources: number;
  sourceAnomalyCount: number;
  oldestRecordAgeSeconds: number | null;
}

export interface CommandCenterSection {
  id: CommandCenterSectionId;
  title: string;
  description: string;
  metrics: CommandCenterMetric[];
}

export interface CommandCenterSourceAnomaly {
  id: string;
  sourceId: string;
  severity: "warning" | "critical";
  title: string;
  description: string;
  detectedAt: string;
  drilldownUrl: string;
}

export interface CommandCenterSnapshot {
  schemaVersion: typeof COMMAND_CENTER_SCHEMA_VERSION;
  definitionVersion: typeof COMMAND_CENTER_DEFINITION_VERSION;
  snapshotId: string;
  generatedAt: string;
  asOf: string;
  freshnessSeconds: number;
  view: CommandCenterView;
  includedSectionIds: CommandCenterSectionId[];
  window: {
    hours: number;
    from: string;
    to: string;
    timeZone: "Asia/Shanghai";
  };
  overallStatus: CommandCenterMetricStatus;
  sections: CommandCenterSection[];
  sources: CommandCenterSourceStatus[];
  sourceAnomalies: CommandCenterSourceAnomaly[];
  dataQuality: CommandCenterDataQuality;
  refresh: {
    pollIntervalMs: number;
    nextRefreshAt: string;
    cacheStatus: "hit" | "miss" | "shared";
    buildDurationMs: number;
    rateLimit: {
      scope: "process-local-admin-view";
      limit: 1;
      intervalMs: number;
      remaining: 0 | 1;
      retryAfterSeconds: number;
      nextAllowedAt: string;
    };
    readOnly: true;
    providerCalls: 0;
    businessWrites: 0;
  };
}

function clampRatio(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

export function commandCenterPercentage(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const percentage = (numerator / denominator) * 100;
  return Math.round(Math.min(100, Math.max(0, percentage)) * 10) / 10;
}

export function commandCenterCredentialCoveragePercent(
  visibleModelKeys: Iterable<string>,
  boundModelKeys: Iterable<string>,
): number | null {
  const visible = new Set(Array.from(visibleModelKeys, (value) => value.trim()).filter(Boolean));
  if (visible.size === 0) return null;
  const bound = new Set(Array.from(boundModelKeys, (value) => value.trim()).filter(Boolean));
  const matched = Array.from(visible).filter((modelKey) => bound.has(modelKey)).length;
  return commandCenterPercentage(matched, visible.size);
}

export function commandCenterFreshnessSeconds(
  latestRecordAt: string | null,
  observedAt: string,
): number | null {
  if (!latestRecordAt) return null;
  const latestEpoch = Date.parse(latestRecordAt);
  const observedEpoch = Date.parse(observedAt);
  if (!Number.isFinite(latestEpoch) || !Number.isFinite(observedEpoch)) return null;
  return Math.max(0, Math.floor((observedEpoch - latestEpoch) / 1_000));
}

export interface CommandCenterFinanceCashInput {
  onlineOrders: ReadonlyArray<{ amount?: unknown; provider_paid_amount?: unknown }>;
  offlineReceipts: ReadonlyArray<{ amount?: unknown }>;
  refundAttempts: ReadonlyArray<{
    state?: unknown;
    paid_amount?: unknown;
    provider_refund_amount?: unknown;
  }>;
}

export interface CommandCenterFinanceCashSnapshot {
  grossCashReceived: number;
  completedRefundAmount: number;
  netCashReceived: number;
  reconciliationRequiredExposure: number;
}

function positiveMoney(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function commandCenterFinanceCashSnapshot(
  input: CommandCenterFinanceCashInput,
): CommandCenterFinanceCashSnapshot {
  const onlineGross = input.onlineOrders.reduce((total, row) => {
    const providerAmount = positiveMoney(row.provider_paid_amount);
    return total + (providerAmount > 0 ? providerAmount : positiveMoney(row.amount));
  }, 0);
  const offlineGross = input.offlineReceipts.reduce((total, row) => total + positiveMoney(row.amount), 0);
  const completedRefundAmount = input.refundAttempts.reduce((total, row) => (
    String(row.state || "").trim().toLowerCase() === "completed"
      ? total + positiveMoney(row.provider_refund_amount)
      : total
  ), 0);
  const reconciliationRequiredExposure = input.refundAttempts.reduce((total, row) => (
    String(row.state || "").trim().toLowerCase() === "reconciliation_required"
      ? total + positiveMoney(row.paid_amount)
      : total
  ), 0);
  const grossCashReceived = roundCurrency(onlineGross + offlineGross);
  const completedRefund = roundCurrency(completedRefundAmount);
  return {
    grossCashReceived,
    completedRefundAmount: completedRefund,
    netCashReceived: roundCurrency(grossCashReceived - completedRefund),
    reconciliationRequiredExposure: roundCurrency(reconciliationRequiredExposure),
  };
}

function latestIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestEpoch = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const epoch = Date.parse(value);
    if (Number.isFinite(epoch) && epoch > latestEpoch) {
      latest = value;
      latestEpoch = epoch;
    }
  }
  return latest;
}

function worstFreshness(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function combinedCoverage(sources: CommandCenterSourceStatus[]): number | null {
  if (sources.length === 0) return null;
  const ratios = sources.map((source) => source.state === "unavailable" ? 0 : source.coverageRatio);
  if (ratios.some((ratio) => ratio == null)) return null;
  const finiteRatios = ratios as number[];
  return clampRatio(finiteRatios.reduce((sum, ratio) => sum + ratio, 0) / finiteRatios.length);
}

export function commandCenterMetric(input: {
  id: string;
  label: string;
  value: Exclude<CommandCenterMetricValue, null> | null;
  unit: CommandCenterMetric["unit"];
  definition: string;
  sources: CommandCenterSourceStatus[];
  status?: Exclude<CommandCenterMetricStatus, "unavailable">;
  drilldownUrl: string;
  partial?: boolean;
}): CommandCenterMetric {
  const availableSources = input.sources.filter((source) => source.state !== "unavailable");
  const unavailable = input.sources.length === 0 || availableSources.length === 0;
  const valueUnknown = input.value === null;
  const hasStaleSource = input.sources.some((source) => (
    source.state === "stale"
    || (
      source.staleAfterSeconds != null
      && source.freshnessSeconds != null
      && source.freshnessSeconds > source.staleAfterSeconds
    )
  ));
  const partial = unavailable
    || valueUnknown
    || hasStaleSource
    || input.partial === true
    || input.sources.some((source) => source.partial || source.state !== "available" || (source.coverageRatio != null && source.coverageRatio < 1));
  const status = unavailable
    ? "unavailable"
    : valueUnknown
      ? "unknown"
    : partial && (!input.status || input.status === "healthy")
      ? "warning"
      : input.status || "healthy";

  return {
    id: input.id,
    label: input.label,
    value: unavailable ? null : input.value,
    unit: input.unit,
    definition: input.definition,
    source: input.sources.map((source) => source.source),
    sourceIds: input.sources.map((source) => source.id),
    asOf: unavailable ? null : latestIso(availableSources.map((source) => source.asOf)),
    freshnessSeconds: unavailable ? null : worstFreshness(availableSources.map((source) => source.freshnessSeconds)),
    coverageRatio: unavailable ? 0 : combinedCoverage(input.sources),
    partial,
    status,
    drilldownUrl: input.drilldownUrl,
  };
}

export function commandCenterDataQuality(
  sources: CommandCenterSourceStatus[],
  anomalies: CommandCenterSourceAnomaly[],
): CommandCenterDataQuality {
  const freshnessValues = sources
    .map((source) => source.freshnessSeconds)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
  return {
    totalSources: sources.length,
    availableSources: sources.filter((source) => source.state === "available").length,
    partialSources: sources.filter((source) => source.state === "partial").length,
    unavailableSources: sources.filter((source) => source.state === "unavailable").length,
    staleSources: sources.filter((source) => source.state === "stale").length,
    sourceAnomalyCount: anomalies.length,
    oldestRecordAgeSeconds: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
  };
}

export function commandCenterApplyFreshnessState(
  sources: CommandCenterSourceStatus[],
): CommandCenterSourceStatus[] {
  return sources.map((source) => {
    if (
      source.state !== "unavailable"
      && source.staleAfterSeconds != null
      && source.freshnessSeconds != null
      && source.freshnessSeconds > source.staleAfterSeconds
    ) {
      return { ...source, state: "stale" };
    }
    return source;
  });
}

function isCriticalSource(sourceId: string): boolean {
  return /^(finance\.(?:revenue|payments|refunds)|security\.events|operations\.flight|operations\.health|tasks\.)/u.test(sourceId);
}

export function commandCenterSourceAnomalies(
  sources: CommandCenterSourceStatus[],
  generatedAt: string,
): CommandCenterSourceAnomaly[] {
  const generatedEpoch = Date.parse(generatedAt);
  const anomalies: CommandCenterSourceAnomaly[] = [];
  for (const source of sources) {
    if (source.state === "unavailable") {
      anomalies.push({
        id: `${source.id}:unavailable`,
        sourceId: source.id,
        severity: isCriticalSource(source.id) ? "critical" : "warning",
        title: `${source.label}不可用`,
        description: `本次读取失败（${source.errorCode || "READ_FAILED"}），相关指标显示不可用，不会回退为 0。`,
        detectedAt: generatedAt,
        drilldownUrl: source.drilldownUrl,
      });
      continue;
    }
    if (source.partial) {
      const coverage = source.coverageRatio == null ? "未知" : `${(source.coverageRatio * 100).toFixed(1)}%`;
      anomalies.push({
        id: `${source.id}:partial`,
        sourceId: source.id,
        severity: "warning",
        title: `${source.label}仅部分覆盖`,
        description: `有界读取覆盖率 ${coverage}；指标仅代表部分样本或部分覆盖，不得当作精确总量。`,
        detectedAt: generatedAt,
        drilldownUrl: source.drilldownUrl,
      });
    }
    if (source.staleAfterSeconds && source.latestRecordAt && Number.isFinite(generatedEpoch)) {
      const latestEpoch = Date.parse(source.latestRecordAt);
      const ageSeconds = Number.isFinite(latestEpoch) ? Math.max(0, Math.floor((generatedEpoch - latestEpoch) / 1_000)) : 0;
      if (ageSeconds > source.staleAfterSeconds) {
        anomalies.push({
          id: `${source.id}:stale`,
          sourceId: source.id,
          severity: isCriticalSource(source.id) ? "critical" : "warning",
          title: `${source.label}长时间无新记录`,
          description: `最后一条记录距今 ${ageSeconds} 秒，超过 ${source.staleAfterSeconds} 秒的新鲜度目标。`,
          detectedAt: generatedAt,
          drilldownUrl: source.drilldownUrl,
        });
      }
    }
  }
  return anomalies;
}

export function commandCenterOverallStatus(
  sections: CommandCenterSection[],
  anomalies: CommandCenterSourceAnomaly[],
): CommandCenterMetricStatus {
  if (anomalies.some((anomaly) => anomaly.severity === "critical") || sections.some((section) => section.metrics.some((metric) => metric.status === "critical"))) return "critical";
  if (anomalies.length > 0 || sections.some((section) => section.metrics.some((metric) => metric.status === "warning" || metric.status === "unavailable"))) return "warning";
  if (sections.some((section) => section.metrics.some((metric) => metric.status === "unknown"))) return "unknown";
  return "healthy";
}

export function clampCommandCenterWindowHours(value: unknown): number {
  if (value == null || String(value).trim() === "") return 24;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(24 * 7, Math.max(1, Math.round(parsed)));
}
