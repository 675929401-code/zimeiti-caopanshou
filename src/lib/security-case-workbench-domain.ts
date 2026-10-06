import {
  SECURITY_CASE_ACTION_TYPES,
  SECURITY_CASE_ENTITY_TYPES,
  SECURITY_CASE_RISK_LEVELS,
  SECURITY_CASE_SOURCE_KINDS,
  SECURITY_CASE_STATUSES,
  type SecurityCaseActionType,
  type SecurityCaseEntityType,
  type SecurityCaseRiskLevel,
  type SecurityCaseSourceKind,
  type SecurityCaseStatus,
} from "@/lib/security-case-contracts";
// UI DTOs mirror the existing API and reject silent changes to the phase-1 execution boundary.

export const SECURITY_CASE_WORKBENCH_PAGE_SIZE = 20;
export const SECURITY_CASE_READ_COOLDOWN_MS = 15_000;
export const SECURITY_CASE_AUTO_REFRESH_MS = 30_000;

export const SECURITY_CASE_STATUS_LABELS: Record<SecurityCaseStatus, string> = {
  open: "待研判",
  triaged: "已研判",
  assigned: "已认领",
  mitigating: "处置中",
  monitoring: "观察中",
  resolved: "已解决",
  false_positive: "误报关闭",
};

export const SECURITY_CASE_RISK_LABELS: Record<SecurityCaseRiskLevel, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "严重风险",
};

export const SECURITY_CASE_SOURCE_LABELS: Record<SecurityCaseSourceKind, string> = {
  security_event: "安全事件",
  prompt_guard_log: "提示词防护",
  login_log: "登录异常",
  operation_flight_event: "运行飞行日志",
};

export const SECURITY_CASE_ENTITY_LABELS: Record<SecurityCaseEntityType, string> = {
  user: "用户",
  session: "会话",
  ip_hash: "IP 哈希",
  route: "路由",
  trace: "Trace",
  credential: "凭据指纹",
  channel: "来源通道",
};

export const SECURITY_CASE_ACTION_LABELS: Record<SecurityCaseActionType, string> = {
  revoke_session: "申请撤销会话",
  disable_user: "申请停用账号",
};

export interface SecurityCaseSummary {
  id: string;
  fingerprint: string;
  title: string;
  summary: string;
  risk_level: SecurityCaseRiskLevel;
  risk_score: number;
  status: SecurityCaseStatus;
  assigned_to: string | null;
  revision: number;
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecurityCaseEvidenceEvent {
  id: string;
  source_kind: SecurityCaseSourceKind;
  source_event_id: string;
  event_fingerprint: string;
  event_type: string;
  risk_level: SecurityCaseRiskLevel;
  risk_score: number;
  summary: string;
  evidence: Record<string, unknown> | null;
  occurred_at: string;
  linked_at: string;
  linked_by: string | null;
}

export interface SecurityCaseLink {
  id: string;
  entity_type: SecurityCaseEntityType;
  entity_ref: string;
  entity_label: string | null;
  linked_by: string | null;
  linked_at: string;
}

export interface SecurityCaseAction {
  id: string;
  action_type: SecurityCaseActionType;
  target_type: "session" | "user";
  target_ref: string;
  status: "pending_executor" | "executing" | "succeeded" | "failed" | "cancelled";
  revision: number;
  execution_supported: boolean;
  impact_preview: Record<string, unknown> | null;
  reason: string;
  requested_by: string;
  request_key: string;
  requested_at: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface SecurityCaseAuditEntry {
  id: number | string;
  action_id: string | null;
  actor_id: string | null;
  event_type: string;
  from_status: SecurityCaseStatus | null;
  to_status: SecurityCaseStatus | null;
  reason_code: string;
  reason: string;
  request_key: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface SecurityCaseExecutionPolicy {
  executorAvailable: boolean;
  destructiveExecutionEnabled: boolean;
  supportedRequests?: SecurityCaseActionType[];
}

export interface SecurityCaseReadMetadata {
  asOf: string;
  freshnessSeconds: number;
  nextRefreshAt: string;
  cacheStatus: "miss" | "hit" | "shared";
  rateLimit: {
    scope: "per_admin_query";
    backend: "process_memory";
    limit: number;
    windowSeconds: number;
    remaining: number;
  };
}

export interface SecurityCaseListResponse extends SecurityCaseReadMetadata {
  ok: true;
  cases: SecurityCaseSummary[];
  page: number;
  pageSize: number;
  total: number;
  executionPolicy: SecurityCaseExecutionPolicy;
}

export interface SecurityCaseDetailResponse extends SecurityCaseReadMetadata {
  ok: true;
  case: SecurityCaseSummary;
  events: SecurityCaseEvidenceEvent[];
  links: SecurityCaseLink[];
  actions: SecurityCaseAction[];
  audit: SecurityCaseAuditEntry[];
  executionPolicy: SecurityCaseExecutionPolicy;
}

export interface SecurityCaseActionPreview {
  schema: string;
  actionType: SecurityCaseActionType;
  targetType: "session" | "user";
  targetRef: string;
  targetExists: boolean;
  currentState: string;
  affectedRowsMax: number;
  reversible: boolean;
  executionSupported: false;
  executorStatus: "unavailable";
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCaseSummary(value: unknown): value is SecurityCaseSummary {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.summary === "string"
    && typeof value.revision === "number"
    && typeof value.event_count === "number"
    && typeof value.risk_score === "number"
    && SECURITY_CASE_RISK_LEVELS.includes(value.risk_level as SecurityCaseRiskLevel)
    && SECURITY_CASE_STATUSES.includes(value.status as SecurityCaseStatus);
}

function isExecutionPolicy(value: unknown): value is SecurityCaseExecutionPolicy {
  return isRecord(value)
    && value.executorAvailable === false
    && value.destructiveExecutionEnabled === false;
}

function hasReadMetadata(value: Record<string, unknown>): boolean {
  return typeof value.asOf === "string"
    && typeof value.freshnessSeconds === "number"
    && typeof value.nextRefreshAt === "string"
    && new Set(["miss", "hit", "shared"]).has(String(value.cacheStatus))
    && isRecord(value.rateLimit)
    && value.rateLimit.scope === "per_admin_query"
    && value.rateLimit.backend === "process_memory"
    && typeof value.rateLimit.windowSeconds === "number";
}

function isEvidenceEvent(value: unknown): value is SecurityCaseEvidenceEvent {
  return isRecord(value)
    && typeof value.id === "string"
    && SECURITY_CASE_SOURCE_KINDS.includes(value.source_kind as SecurityCaseSourceKind)
    && SECURITY_CASE_RISK_LEVELS.includes(value.risk_level as SecurityCaseRiskLevel)
    && typeof value.event_type === "string"
    && typeof value.summary === "string"
    && typeof value.occurred_at === "string"
    && (value.evidence == null || isRecord(value.evidence));
}

function isCaseLink(value: unknown): value is SecurityCaseLink {
  return isRecord(value)
    && typeof value.id === "string"
    && SECURITY_CASE_ENTITY_TYPES.includes(value.entity_type as SecurityCaseEntityType)
    && typeof value.entity_ref === "string"
    && typeof value.linked_at === "string";
}

function isCaseAction(value: unknown): value is SecurityCaseAction {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && SECURITY_CASE_ACTION_TYPES.includes(value.action_type as SecurityCaseActionType)
    && new Set(["pending_executor", "executing", "succeeded", "failed", "cancelled"]).has(String(value.status))
    && typeof value.revision === "number"
    && value.execution_supported === false
    && typeof value.target_ref === "string"
    && typeof value.reason === "string"
    && typeof value.requested_at === "string";
}

function isAuditEntry(value: unknown): value is SecurityCaseAuditEntry {
  return isRecord(value)
    && (typeof value.id === "number" || typeof value.id === "string")
    && typeof value.event_type === "string"
    && typeof value.reason_code === "string"
    && typeof value.reason === "string"
    && typeof value.created_at === "string";
}

export function isSecurityCaseListResponse(value: unknown): value is SecurityCaseListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.cases)) return false;
  return value.cases.every(isCaseSummary)
    && typeof value.page === "number"
    && typeof value.pageSize === "number"
    && typeof value.total === "number"
    && isExecutionPolicy(value.executionPolicy)
    && hasReadMetadata(value);
}

export function isSecurityCaseDetailResponse(value: unknown): value is SecurityCaseDetailResponse {
  if (!isRecord(value) || value.ok !== true || !isCaseSummary(value.case)) return false;
  return Array.isArray(value.events) && value.events.every(isEvidenceEvent)
    && Array.isArray(value.links) && value.links.every(isCaseLink)
    && Array.isArray(value.actions) && value.actions.every(isCaseAction)
    && Array.isArray(value.audit) && value.audit.every(isAuditEntry)
    && isExecutionPolicy(value.executionPolicy)
    && hasReadMetadata(value);
}

export function isSecurityCaseActionPreview(value: unknown): value is SecurityCaseActionPreview {
  if (!isRecord(value)) return false;
  return value.schema === "security-case-impact/v1"
    && value.executionSupported === false
    && value.executorStatus === "unavailable"
    && typeof value.targetRef === "string"
    && typeof value.targetExists === "boolean"
    && typeof value.currentState === "string"
    && typeof value.affectedRowsMax === "number"
    && Array.isArray(value.notes);
}

export function nextSecurityCaseStatuses(status: SecurityCaseStatus): SecurityCaseStatus[] {
  if (status === "open") return ["triaged", "false_positive"];
  if (status === "assigned") return ["mitigating", "false_positive"];
  if (status === "mitigating") return ["monitoring", "false_positive"];
  if (status === "monitoring") return ["resolved", "false_positive"];
  return [];
}

export function securityCaseActionStatusLabel(status: SecurityCaseAction["status"]): string {
  if (status === "pending_executor") return "待执行 · 执行器未接入";
  if (status === "cancelled") return "已取消";
  if (status === "executing") return "执行中（事实源状态）";
  if (status === "succeeded") return "已完成（事实源状态）";
  return "失败（事实源状态）";
}

export function retryAfterDeadlineMs(
  retryAfter: string | null,
  nextRefreshAt: unknown,
  nowMs: number,
  fallbackMs = SECURITY_CASE_READ_COOLDOWN_MS,
): number {
  if (typeof nextRefreshAt === "string") {
    const parsed = Date.parse(nextRefreshAt);
    if (Number.isFinite(parsed) && parsed > nowMs) return parsed;
  }
  const seconds = Number(retryAfter || 0);
  if (Number.isFinite(seconds) && seconds > 0) return nowMs + Math.ceil(seconds * 1_000);
  return nowMs + fallbackMs;
}

export function createSecurityCaseRequestKey(prefix: string, caseId: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${caseId}:${random}`.slice(0, 200);
}
