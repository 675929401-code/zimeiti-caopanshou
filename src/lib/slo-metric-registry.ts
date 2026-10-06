import {
  COMMAND_CENTER_DEFINITION_VERSION,
  type CommandCenterMetricStatus,
  type CommandCenterMetricValue,
  type CommandCenterSectionId,
} from "@/lib/admin-command-center-domain";

export const SLO_METRIC_REGISTRY_SCHEMA_VERSION = 1 as const;
export const SLO_METRIC_REGISTRY_VERSION = "2026-10-03.v1" as const;
export const SLO_METRIC_HISTORY_DESIGN_VERSION = "2026-10-03.design-v1" as const;
export const SLO_METRIC_REGISTRY_REFRESH_MS = 5 * 60 * 1_000;
export const SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS = 60 * 1_000;
export const SLO_METRIC_CAPTURE_MIN_INTERVAL_MS = 60 * 1_000;

export type SloMetricAvailability = "available" | "partial" | "unavailable";
export type SloMetricHistoryState = "available" | "unavailable";

export interface SloMetricAlertThreshold {
  warning: string;
  critical: string;
}

export interface SloMetricDefinition {
  id: string;
  section: CommandCenterSectionId;
  name: string;
  businessObjective: string;
  owner: string;
  formula: string;
  numerator: string;
  denominator: string;
  unit: "count" | "currency_cny" | "percent" | "milliseconds" | "seconds" | "text";
  grain: string;
  exclusions: string[];
  dataSources: string[];
  queryVersion: string;
  alertThreshold: SloMetricAlertThreshold;
  freshnessTargetSeconds: number;
  drilldownUrl: string;
}

export interface SloMetricCurrentValue {
  value: CommandCenterMetricValue;
  unit: SloMetricDefinition["unit"];
  metricStatus: CommandCenterMetricStatus;
  availability: SloMetricAvailability;
  partial: boolean;
  asOf: string | null;
  freshnessSeconds: number | null;
  coverageRatio: number | null;
  sourceIds: string[];
}

export interface SloMetricRegistryItem extends SloMetricDefinition {
  current: SloMetricCurrentValue;
  history: {
    state: SloMetricHistoryState;
    points: Array<{
      capturedAt: string;
      value: CommandCenterMetricValue;
      metricStatus: CommandCenterMetricStatus;
      availability: SloMetricAvailability;
    }>;
  };
}

export interface SloMetricRegistrySnapshot {
  schemaVersion: typeof SLO_METRIC_REGISTRY_SCHEMA_VERSION;
  registryVersion: typeof SLO_METRIC_REGISTRY_VERSION;
  commandCenterDefinitionVersion: typeof COMMAND_CENTER_DEFINITION_VERSION;
  asOf: string;
  freshnessSeconds: number;
  windowHours: number;
  summary: {
    registered: number;
    expected: number;
    coverageRatio: number;
    available: number;
    partial: number;
    unavailable: number;
    historyConnected: number;
  };
  historyPersistence: {
    state: SloMetricHistoryState;
    designVersion: typeof SLO_METRIC_HISTORY_DESIGN_VERSION;
    reasonCode: string | null;
    latestCaptureAt: string | null;
    runCount: number | null;
    boundedPointsPerMetric: number;
  };
  incidentSlo: {
    state: SloMetricAvailability;
    migrationApplied: boolean | null;
    collectorsConnected: boolean;
    definitions: number | null;
    availableMeasurements: number | null;
    note: string;
  };
  metrics: SloMetricRegistryItem[];
  readBudget: {
    commandCenterViews: number;
    maximumHistoryRuns: number;
    maximumHistoryRows: number;
    providerCalls: 0;
    businessWrites: 0;
  };
  refresh: {
    pollIntervalMs: number;
    nextRefreshAt: string;
    cacheStatus: "hit" | "miss" | "shared";
    buildDurationMs: number;
    rateLimit: {
      scope: "process-local-admin";
      limit: 1;
      intervalMs: number;
      remaining: 0 | 1;
      retryAfterSeconds: number;
      nextAllowedAt: string;
    };
    readOnly: true;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isMetricValue(value: unknown): value is CommandCenterMetricValue {
  return value === null || typeof value === "string" || isFiniteNumber(value);
}

function isRegistryItem(value: unknown): value is SloMetricRegistryItem {
  if (!isRecord(value) || !isRecord(value.alertThreshold) || !isRecord(value.current) || !isRecord(value.history)) return false;
  const current = value.current;
  const history = value.history;
  const units = new Set(["count", "currency_cny", "percent", "milliseconds", "seconds", "text"]);
  const sections = new Set(["business", "finance", "tasks", "models", "security", "operations", "governance"]);
  const statuses = new Set(["healthy", "warning", "critical", "unknown", "unavailable"]);
  const availabilities = new Set(["available", "partial", "unavailable"]);
  return [
    value.id,
    value.name,
    value.businessObjective,
    value.owner,
    value.formula,
    value.numerator,
    value.denominator,
    value.grain,
    value.queryVersion,
    value.drilldownUrl,
  ].every((entry) => typeof entry === "string")
    && typeof value.section === "string" && sections.has(value.section)
    && typeof value.unit === "string" && units.has(value.unit)
    && isStringArray(value.exclusions)
    && isStringArray(value.dataSources)
    && typeof value.alertThreshold.warning === "string"
    && typeof value.alertThreshold.critical === "string"
    && isFiniteNumber(value.freshnessTargetSeconds)
    && isMetricValue(current.value)
    && typeof current.unit === "string" && units.has(current.unit)
    && typeof current.metricStatus === "string" && statuses.has(current.metricStatus)
    && typeof current.availability === "string" && availabilities.has(current.availability)
    && typeof current.partial === "boolean"
    && (current.asOf === null || typeof current.asOf === "string")
    && isNullableFiniteNumber(current.freshnessSeconds)
    && isNullableFiniteNumber(current.coverageRatio)
    && isStringArray(current.sourceIds)
    && (history.state === "available" || history.state === "unavailable")
    && Array.isArray(history.points)
    && history.points.every((point) => isRecord(point)
      && typeof point.capturedAt === "string"
      && isMetricValue(point.value)
      && typeof point.metricStatus === "string" && statuses.has(point.metricStatus)
      && typeof point.availability === "string" && availabilities.has(point.availability));
}

export function isSloMetricRegistrySnapshot(value: unknown): value is SloMetricRegistrySnapshot {
  if (
    !isRecord(value)
    || !isRecord(value.summary)
    || !isRecord(value.historyPersistence)
    || !isRecord(value.incidentSlo)
    || !isRecord(value.readBudget)
    || !isRecord(value.refresh)
    || !Array.isArray(value.metrics)
  ) return false;
  const { summary, historyPersistence, incidentSlo, readBudget, refresh } = value;
  const rateLimit = refresh.rateLimit;
  if (!isRecord(rateLimit)) return false;
  return value.schemaVersion === SLO_METRIC_REGISTRY_SCHEMA_VERSION
    && value.registryVersion === SLO_METRIC_REGISTRY_VERSION
    && value.commandCenterDefinitionVersion === COMMAND_CENTER_DEFINITION_VERSION
    && typeof value.asOf === "string"
    && isFiniteNumber(value.freshnessSeconds)
    && isFiniteNumber(value.windowHours)
    && [summary.registered, summary.expected, summary.coverageRatio, summary.available, summary.partial, summary.unavailable, summary.historyConnected].every(isFiniteNumber)
    && (historyPersistence.state === "available" || historyPersistence.state === "unavailable")
    && historyPersistence.designVersion === SLO_METRIC_HISTORY_DESIGN_VERSION
    && (historyPersistence.reasonCode === null || typeof historyPersistence.reasonCode === "string")
    && (historyPersistence.latestCaptureAt === null || typeof historyPersistence.latestCaptureAt === "string")
    && isNullableFiniteNumber(historyPersistence.runCount)
    && isFiniteNumber(historyPersistence.boundedPointsPerMetric)
    && (incidentSlo.state === "available" || incidentSlo.state === "partial" || incidentSlo.state === "unavailable")
    && (incidentSlo.migrationApplied === null || typeof incidentSlo.migrationApplied === "boolean")
    && typeof incidentSlo.collectorsConnected === "boolean"
    && isNullableFiniteNumber(incidentSlo.definitions)
    && isNullableFiniteNumber(incidentSlo.availableMeasurements)
    && typeof incidentSlo.note === "string"
    && value.metrics.length === SLO_METRIC_REGISTRY.length
    && value.metrics.every(isRegistryItem)
    && isFiniteNumber(readBudget.commandCenterViews)
    && isFiniteNumber(readBudget.maximumHistoryRuns)
    && isFiniteNumber(readBudget.maximumHistoryRows)
    && readBudget.providerCalls === 0
    && readBudget.businessWrites === 0
    && isFiniteNumber(refresh.pollIntervalMs)
    && typeof refresh.nextRefreshAt === "string"
    && (refresh.cacheStatus === "hit" || refresh.cacheStatus === "miss" || refresh.cacheStatus === "shared")
    && isFiniteNumber(refresh.buildDurationMs)
    && rateLimit.scope === "process-local-admin"
    && rateLimit.limit === 1
    && isFiniteNumber(rateLimit.intervalMs)
    && (rateLimit.remaining === 0 || rateLimit.remaining === 1)
    && isFiniteNumber(rateLimit.retryAfterSeconds)
    && typeof rateLimit.nextAllowedAt === "string"
    && refresh.readOnly === true;
}

type MetricSeed = Omit<SloMetricDefinition, "queryVersion">;

function metric(seed: MetricSeed): SloMetricDefinition {
  return {
    ...seed,
    queryVersion: `command-center:${COMMAND_CENTER_DEFINITION_VERSION}:${seed.id}:v1`,
  };
}

const SOURCE_OR_FRESHNESS_WARNING = "任一来源部分覆盖、过期或读取失败";
const SOURCE_UNAVAILABLE_CRITICAL = "关键来源全部不可用，指标值必须为空";
const WINDOW_EXCLUSIONS = ["统计窗口外记录", "无可验证时间戳的记录"];
const TASK_SOURCES = [
  "llm_request_attempts",
  "image_generation_requests",
  "video_tasks",
  "voice_generation_requests",
  "extraction_attempts",
];

export const SLO_METRIC_REGISTRY: readonly SloMetricDefinition[] = [
  metric({
    id: "business.total-users", section: "business", name: "平台注册用户", businessObjective: "掌握可服务会员基数", owner: "会员运营",
    formula: "role=student 的用户精确计数", numerator: "student 用户数", denominator: "不适用", unit: "count", grain: "当前状态",
    exclusions: ["管理员账号", "非 student 角色"], dataSources: ["users"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=users",
  }),
  metric({
    id: "business.new-users", section: "business", name: "新增用户", businessObjective: "判断注册增长是否持续", owner: "会员运营",
    formula: "窗口内 role=student 且 created_at>=窗口起点的精确计数", numerator: "窗口内新增 student 用户数", denominator: "不适用", unit: "count", grain: "统计窗口",
    exclusions: ["管理员账号", ...WINDOW_EXCLUSIONS], dataSources: ["users"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=users",
  }),
  metric({
    id: "business.active-users", section: "business", name: "消费活跃用户", businessObjective: "用真实消费行为衡量有效活跃", owner: "会员运营",
    formula: "窗口内 consume 积分流水的去重 user_id", numerator: "至少一笔 consume 流水的去重用户数", denominator: "不适用", unit: "count", grain: "统计窗口/用户去重",
    exclusions: ["非 consume 流水", "缺失 user_id 的流水", ...WINDOW_EXCLUSIONS], dataSources: ["credit_transactions"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),

  metric({
    id: "finance.cash-received", section: "finance", name: "实际收款（毛额）", businessObjective: "核对真实到账规模", owner: "财务运营",
    formula: "线上已确认原始实付金额 + 已确认线下收款", numerator: "窗口内确认收款金额总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["未确认订单", "退款扣减", ...WINDOW_EXCLUSIONS], dataSources: ["payment_orders", "offline_payment_receipts"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.completed-refunds", section: "finance", name: "已完成退款", businessObjective: "仅按供应商完成证据确认退款", owner: "财务运营",
    formula: "state=completed 的 provider_refund_amount 求和", numerator: "已完成退款金额总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["退款请求意图", "reconciliation_required", "无供应商金额证据", ...WINDOW_EXCLUSIONS], dataSources: ["payment_refund_attempts"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.net-cash-received", section: "finance", name: "净收款快照", businessObjective: "观察窗口内可解释净到账", owner: "财务运营",
    formula: "毛收款 - 同窗口 completed 退款", numerator: "毛收款减已完成退款", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["未完成退款", "税费与其他会计调整", ...WINDOW_EXCLUSIONS], dataSources: ["payment_orders", "offline_payment_receipts", "payment_refund_attempts"], alertThreshold: { warning: "净额为负或来源部分覆盖", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.refund-frozen-exposure", section: "finance", name: "退款冻结敞口", businessObjective: "及时发现需人工对账的资金风险", owner: "财务运营",
    formula: "state=reconciliation_required 的原 paid_amount 求和", numerator: "待对账原支付金额总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["completed 退款", "未进入对账态的请求", ...WINDOW_EXCLUSIONS], dataSources: ["payment_refund_attempts"], alertThreshold: { warning: ">0 元", critical: "来源不可用或敞口超过人工设定资金上限" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.usage-revenue", section: "finance", name: "使用收入", businessObjective: "观察任务计费收入", owner: "财务运营",
    formula: "非免单 revenue_records.selling_price 求和", numerator: "任务售价快照总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["免单任务", "退款与税费", "未入 revenue_records 的任务", ...WINDOW_EXCLUSIONS], dataSources: ["revenue_records"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.provider-cost", section: "finance", name: "已配置供应商成本快照", businessObjective: "观察已记录的模型成本", owner: "财务运营",
    formula: "非免单 revenue_records.cost_price 求和", numerator: "已记录供应商成本总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["未入表成本", "退款、税费及运营成本", "免单任务", ...WINDOW_EXCLUSIONS], dataSources: ["revenue_records"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),
  metric({
    id: "finance.gross-profit", section: "finance", name: "任务毛利快照", businessObjective: "发现任务级负毛利", owner: "财务运营",
    formula: "revenue_records.profit 求和", numerator: "任务利润快照总和", denominator: "不适用", unit: "currency_cny", grain: "统计窗口/人民币元",
    exclusions: ["退款、税费与平台运营成本", "未入表任务", ...WINDOW_EXCLUSIONS], dataSources: ["revenue_records"], alertThreshold: { warning: "毛利<0 或来源部分覆盖", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=credits",
  }),

  metric({
    id: "tasks.observed", section: "tasks", name: "任务记录", businessObjective: "掌握五类生产任务的可观测覆盖", owner: "AI 生产运维",
    formula: "五类耐久任务表窗口内有界记录数之和", numerator: "有界读取到的任务记录数", denominator: "不适用", unit: "count", grain: "统计窗口/任务",
    exclusions: ["窗口外任务", "未耐久落库的浏览器状态"], dataSources: TASK_SOURCES, alertThreshold: { warning: "任一任务源部分覆盖", critical: "任一关键任务源全部不可用" }, freshnessTargetSeconds: 180, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "tasks.success-rate", section: "tasks", name: "明确终态成功率", businessObjective: "衡量已有明确终态的交付成功率", owner: "AI 生产运维",
    formula: "明确成功 ÷（明确成功 + 明确失败）×100%", numerator: "succeeded/completed/delivered/success 且未 held 的任务", denominator: "明确成功 + failed/error", unit: "percent", grain: "统计窗口/任务终态",
    exclusions: ["unknown", "failed_unknown", "reconciliation_required", "recovery_required", "completed+held"], dataSources: TASK_SOURCES, alertThreshold: { warning: "<98%", critical: "<90% 或关键来源不可用" }, freshnessTargetSeconds: 180, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "tasks.failed", section: "tasks", name: "明确失败任务", businessObjective: "发现可确认失败的交付", owner: "AI 生产运维",
    formula: "state/status 为 failed 或 error 的任务数", numerator: "明确失败任务数", denominator: "不适用", unit: "count", grain: "统计窗口/任务",
    exclusions: ["未知终态", "需对账或恢复的任务"], dataSources: TASK_SOURCES, alertThreshold: { warning: ">=1", critical: ">=10" }, freshnessTargetSeconds: 180, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "tasks.needs-attention", section: "tasks", name: "待核对/待交付", businessObjective: "聚合必须人工跟进的任务", owner: "AI 生产运维",
    formula: "特殊未知态 + completed 且 delivery_state=held", numerator: "需人工跟进任务数", denominator: "不适用", unit: "count", grain: "统计窗口/任务",
    exclusions: ["明确成功且已交付", "明确失败"], dataSources: TASK_SOURCES, alertThreshold: { warning: ">=1", critical: ">=5" }, freshnessTargetSeconds: 180, drilldownUrl: "/admin?tab=health",
  }),

  metric({
    id: "models.visible", section: "models", name: "可见模型", businessObjective: "掌握可供用户选择的模型目录", owner: "模型平台主管",
    formula: "三个模型目录中未隐藏且未显式停用的模型去重计数", numerator: "可见启用模型键数", denominator: "不适用", unit: "count", grain: "当前模型配置",
    exclusions: ["隐藏模型", "显式停用模型", "重复模型键"], dataSources: ["llm_models", "cover_models", "video_models"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=models",
  }),
  metric({
    id: "models.credential-coverage", section: "models", name: "独立凭据绑定覆盖率", businessObjective: "确保启用模型具备隔离凭据", owner: "模型平台主管",
    formula: "已绑定凭据的可见启用模型键 ÷ 可见启用模型键 ×100%", numerator: "可见启用且匹配绑定的模型键数", denominator: "全部可见启用模型键数", unit: "percent", grain: "当前模型配置",
    exclusions: ["隐藏或停用模型", "无关绑定", "重复绑定"], dataSources: ["llm_models", "cover_models", "video_models", "platform_model_credential_bindings"], alertThreshold: { warning: "<100%", critical: "<80% 或凭据源不可用" }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=models",
  }),
  metric({
    id: "models.verified", section: "models", name: "真实验收模型", businessObjective: "区分目录可见与真实链路验收", owner: "模型平台主管",
    formula: "新鲜 LLM 通路证据 + 已发布图像验收 + 有成功记录的视频通道的去重数量", numerator: "满足各自验收门禁的模型数", denominator: "不适用", unit: "count", grain: "当前配置与七天验收窗口",
    exclusions: ["过期或未来时间证据", "配置/凭据不一致证据", "仅连接检查"], dataSources: ["llm_models", "llm_model_validation_evidence", "image_model_validations", "video_channel_health"], alertThreshold: { warning: "验收来源部分覆盖", critical: "验收证据源不可用" }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=models",
  }),
  metric({
    id: "models.unhealthy-video-channels", section: "models", name: "异常视频通道", businessObjective: "识别有真实调用历史的异常视频通道", owner: "模型平台主管",
    formula: "is_healthy=false 且存在调用或失败时间的通道计数", numerator: "异常且有调用证据的通道数", denominator: "不适用", unit: "count", grain: "当前通道状态",
    exclusions: ["从未调用且无失败记录的通道"], dataSources: ["video_channel_health"], alertThreshold: { warning: ">=1", critical: ">=3" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=models",
  }),

  metric({
    id: "security.events", section: "security", name: "安全事件", businessObjective: "掌握安全事件总量", owner: "安全运营",
    formula: "窗口内 security_events 精确计数", numerator: "窗口内安全事件数", denominator: "不适用", unit: "count", grain: "统计窗口/事件",
    exclusions: WINDOW_EXCLUSIONS, dataSources: ["security_events"], alertThreshold: { warning: SOURCE_OR_FRESHNESS_WARNING, critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "security.high-risk", section: "security", name: "高危/严重事件", businessObjective: "优先处置高风险安全事件", owner: "安全运营",
    formula: "risk_level in (high,critical) 的事件计数", numerator: "高危与严重事件数", denominator: "不适用", unit: "count", grain: "统计窗口/事件",
    exclusions: ["low/medium 事件", ...WINDOW_EXCLUSIONS], dataSources: ["security_events"], alertThreshold: { warning: "high 事件>=1 或总数>=10", critical: "critical 事件>=1 或来源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "security.blocked-rate", section: "security", name: "事件拦截率", businessObjective: "观察防护动作覆盖，不把它解释为攻击成功率", owner: "安全运营",
    formula: "blocked=true 事件 ÷ 有界安全事件 ×100%", numerator: "blocked=true 的安全事件数", denominator: "有界安全事件总数", unit: "percent", grain: "统计窗口/事件",
    exclusions: ["未写入 security_events 的请求", ...WINDOW_EXCLUSIONS], dataSources: ["security_events"], alertThreshold: { warning: "分母为 0 或来源部分覆盖时未知", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "security.failed-logins", section: "security", name: "失败登录", businessObjective: "识别凭据攻击与用户登录异常", owner: "安全运营",
    formula: "窗口内 login_logs.status=failed 的精确计数", numerator: "失败登录记录数", denominator: "不适用", unit: "count", grain: "统计窗口/登录尝试",
    exclusions: ["成功登录", ...WINDOW_EXCLUSIONS], dataSources: ["login_logs"], alertThreshold: { warning: ">=1", critical: ">=20 或来源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=login-logs",
  }),

  metric({
    id: "operations.error-rate", section: "operations", name: "运行错误率", businessObjective: "监测跨业务请求错误比例", owner: "平台运维",
    formula: "outcome=error 的飞行事件 ÷ 有界飞行事件 ×100%", numerator: "错误飞行事件数", denominator: "有界飞行事件总数", unit: "percent", grain: "统计窗口/飞行事件",
    exclusions: ["无耐久飞行事件的请求", ...WINDOW_EXCLUSIONS], dataSources: ["operation_flight_events"], alertThreshold: { warning: ">=1%", critical: ">=5% 或来源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "operations.p95-duration", section: "operations", name: "P95 业务耗时", businessObjective: "发现影响用户感知的慢请求", owner: "平台运维",
    formula: "有 duration_ms 飞行事件的 95 分位", numerator: "排序后的第 95 百分位耗时", denominator: "有 duration_ms 的事件集合", unit: "milliseconds", grain: "统计窗口/飞行事件",
    exclusions: ["缺少 duration_ms 的事件", ...WINDOW_EXCLUSIONS], dataSources: ["operation_flight_events"], alertThreshold: { warning: ">=3000ms", critical: ">=10000ms 或来源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "operations.system-errors", section: "operations", name: "系统错误日志", businessObjective: "监测服务端 error/critical 日志", owner: "平台运维",
    formula: "窗口内 level in (error,critical) 的 system_logs 精确计数", numerator: "系统错误日志数", denominator: "不适用", unit: "count", grain: "统计窗口/日志",
    exclusions: ["info/warn 日志", ...WINDOW_EXCLUSIONS], dataSources: ["system_logs"], alertThreshold: { warning: ">=1", critical: ">=10 或来源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "operations.health-state", section: "operations", name: "最近健康检查", businessObjective: "展示最近一次耐久健康诊断", owner: "平台运维",
    formula: "health_checks 按 checked_at 倒序的首条状态", numerator: "最近健康状态", denominator: "不适用", unit: "text", grain: "最近一条耐久检查",
    exclusions: ["当前请求临时探针", "未持久化健康判断"], dataSources: ["health_checks"], alertThreshold: { warning: "状态非 healthy/ok", critical: "状态=unhealthy 或来源不可用" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "operations.horizontal-scale-readiness", section: "operations", name: "横向扩展就绪度", businessObjective: "明确扩展基础与未验证边界", owner: "平台架构",
    formula: "源码审计中 partial 维度数/总维度数，仅作就绪度文本", numerator: "具备局部基础的扩展维度数", denominator: "审计维度总数", unit: "text", grain: "版本化源码审计",
    exclusions: ["未经压测的容量", "实例数与吞吐量推断"], dataSources: ["horizontal_scale_readiness_source_audit"], alertThreshold: { warning: "任何维度仍为 partial", critical: "审计源不可用" }, freshnessTargetSeconds: 86_400, drilldownUrl: "/admin?tab=health",
  }),

  metric({
    id: "governance.project-workspaces", section: "governance", name: "工作区项目归属", businessObjective: "保证业务数据能追溯到项目", owner: "平台治理",
    formula: "已映射工作区数/应登记工作区数", numerator: "已验证映射工作区数", denominator: "应登记工作区数", unit: "text", grain: "当前控制平面",
    exclusions: ["无法核验的推测映射"], dataSources: ["project_registry_control_plane"], alertThreshold: { warning: "存在未映射工作区", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=dashboard",
  }),
  metric({
    id: "governance.unregistered-sources", section: "governance", name: "未登记项目来源", businessObjective: "阻止无法归属的任务、账单与通知", owner: "平台治理",
    formula: "缺少可验证 project_key 的来源计数", numerator: "未登记来源数", denominator: "不适用", unit: "count", grain: "当前控制平面",
    exclusions: ["仅按表名推断的来源"], dataSources: ["project_registry_control_plane"], alertThreshold: { warning: ">=1", critical: "来源不可用或未登记规模超过治理阈值" }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=dashboard",
  }),
  metric({
    id: "governance.message-integration", section: "governance", name: "消息链统一进度", businessObjective: "把公告、账单与会员通知纳入统一投递证据链", owner: "消息平台主管",
    formula: "已接入统一链的消息系统数/已识别消息系统总数", numerator: "已接入消息链数", denominator: "已识别消息链总数", unit: "text", grain: "当前控制平面",
    exclusions: ["仅有基础表但消费端未接入的链路"], dataSources: ["unified_messaging_control_plane"], alertThreshold: { warning: "接入数<总数", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=announcements",
  }),
  metric({
    id: "governance.message-dead-letters", section: "governance", name: "消息开放死信", businessObjective: "及时处理未成功投递的统一消息", owner: "消息平台主管",
    formula: "统一消息控制平面中 open 死信计数", numerator: "开放死信数", denominator: "不适用", unit: "count", grain: "当前控制平面",
    exclusions: ["尚未接入统一消息链的旧消息"], dataSources: ["unified_messaging_control_plane"], alertThreshold: { warning: ">=1", critical: "达到人工严重阈值或来源不可用" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=announcements",
  }),
  metric({
    id: "governance.open-security-cases", section: "governance", name: "开放安全案件", businessObjective: "追踪尚未结案的安全处置", owner: "安全运营",
    formula: "status not in (resolved,false_positive) 的案件计数", numerator: "开放案件数", denominator: "不适用", unit: "count", grain: "当前案件状态",
    exclusions: ["已解决案件", "误报案件"], dataSources: ["security_cases"], alertThreshold: { warning: ">=1", critical: ">=5 或案件源不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "governance.security-event-durability", section: "governance", name: "安全事件可靠链", businessObjective: "验证安全事件从生产端到清理的耐久闭环", owner: "安全平台",
    formula: "六项可靠链检查通过数/6", numerator: "通过的可靠性检查数", denominator: "固定六项检查", unit: "text", grain: "当前控制平面",
    exclusions: ["仅接收端有 outbox 的不完整链路"], dataSources: ["security_event_reliability_control_plane"], alertThreshold: { warning: "通过数<6", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "governance.security-event-dead-letters", section: "governance", name: "安全事件死信", businessObjective: "发现可靠接收端无法处理的安全事件", owner: "安全平台",
    formula: "接收端 outbox 中 dead_letter 唯一事件数", numerator: "安全事件死信数", denominator: "不适用", unit: "count", grain: "当前控制平面",
    exclusions: ["未接入 proxy 生产端的不可观测损失"], dataSources: ["security_event_reliability_control_plane"], alertThreshold: { warning: ">=1", critical: "达到人工严重阈值或来源不可用" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=security",
  }),
  metric({
    id: "governance.tenant-isolation", section: "governance", name: "租户资源隔离", businessObjective: "支撑贴牌租户之间的数据和权限隔离", owner: "平台架构",
    formula: "已完成租户隔离的资源数/应隔离资源数", numerator: "已验证隔离资源数", denominator: "应隔离资源数", unit: "text", grain: "当前控制平面",
    exclusions: ["仅有单租户基础表", "无拒绝回执的声明"], dataSources: ["multitenant_brand_boundary"], alertThreshold: { warning: "边界未 verified", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=general",
  }),
  metric({
    id: "governance.domain-release", section: "governance", name: "域名贴牌发布", businessObjective: "确保每个贴牌域名有完整发布证据", owner: "站点运维",
    formula: "证据完整且已发布域名数/已认领域名数", numerator: "已发布且证据完整域名数", denominator: "已认领域名数", unit: "text", grain: "当前控制平面",
    exclusions: ["未执行真实外部探测的目标策略"], dataSources: ["domain_tls_brand_release_control_plane"], alertThreshold: { warning: "已发布数<已认领域名数", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 900, drilldownUrl: "/admin?tab=general",
  }),
  metric({
    id: "governance.unknown-host-gate", section: "governance", name: "未知 Host 硬拒绝", businessObjective: "阻止未知域名绕过站点绑定", owner: "站点运维",
    formula: "可信 Host 路由硬门禁的运行时启用状态", numerator: "门禁状态", denominator: "不适用", unit: "text", grain: "当前运行策略",
    exclusions: ["未生效的目标设计"], dataSources: ["domain_tls_brand_release_control_plane"], alertThreshold: { warning: "未接入", critical: "来源不可用" }, freshnessTargetSeconds: 300, drilldownUrl: "/admin?tab=general",
  }),
  metric({
    id: "governance.active-incidents", section: "governance", name: "活动事故", businessObjective: "掌握尚未关闭的平台事故", owner: "可靠性工程",
    formula: "采集器接入后 incident_slo 活动事故计数", numerator: "活动事故数", denominator: "不适用", unit: "count", grain: "当前事故状态",
    exclusions: ["采集器未接入时的推测值"], dataSources: ["incident_slo_control_plane"], alertThreshold: { warning: ">=1", critical: "达到严重级别事故或控制面不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "governance.slo-coverage", section: "governance", name: "可用 SLO 覆盖率", businessObjective: "衡量 SLO 是否有真实测量窗口", owner: "可靠性工程",
    formula: "有可用测量窗口的 SLO 定义 ÷ 全部 SLO 定义 ×100%", numerator: "可用测量 SLO 数", denominator: "全部 SLO 定义数", unit: "percent", grain: "当前控制平面",
    exclusions: ["仅有定义但无采集器的 SLO"], dataSources: ["incident_slo_control_plane"], alertThreshold: { warning: "<100%", critical: "<80% 或控制面不可用" }, freshnessTargetSeconds: 60, drilldownUrl: "/admin?tab=health",
  }),
  metric({
    id: "governance.verified-backups", section: "governance", name: "已核验备份目标", businessObjective: "确认关键数据具备可核验备份", owner: "灾备负责人",
    formula: "有恢复点、manifest、校验和与产物回执的目标数/应备份目标数", numerator: "已核验备份目标数", denominator: "应备份目标数", unit: "text", grain: "当前灾备证据",
    exclusions: ["只有政策目标而无产物证据的备份"], dataSources: ["backup_restore_control_plane"], alertThreshold: { warning: "已核验数<目标数", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 86_400, drilldownUrl: "/admin?tab=backup",
  }),
  metric({
    id: "governance.verified-restore-drills", section: "governance", name: "已核验隔离恢复", businessObjective: "用隔离恢复演练证明备份可用", owner: "灾备负责人",
    formula: "满足隔离、零生产写入、关键数据与 RPO/RTO 回执的目标数/应演练目标数", numerator: "已核验恢复演练目标数", denominator: "应演练目标数", unit: "text", grain: "当前灾备证据",
    exclusions: ["未隔离演练", "缺少 RPO/RTO 回执的演练"], dataSources: ["backup_restore_control_plane"], alertThreshold: { warning: "已核验数<目标数", critical: SOURCE_UNAVAILABLE_CRITICAL }, freshnessTargetSeconds: 86_400, drilldownUrl: "/admin?tab=backup",
  }),
] as const;

export function expectedSloMetricIds(): string[] {
  return SLO_METRIC_REGISTRY.map((entry) => entry.id);
}

export function sloMetricAvailability(input: {
  value: CommandCenterMetricValue;
  status: CommandCenterMetricStatus;
  partial: boolean;
  sourceIds: string[];
}): SloMetricAvailability {
  if (input.value == null || input.status === "unavailable" || input.sourceIds.length === 0) return "unavailable";
  if (input.partial || input.status === "unknown") return "partial";
  return "available";
}
