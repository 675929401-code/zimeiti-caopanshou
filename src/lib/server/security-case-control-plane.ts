import "server-only";

import crypto from "node:crypto";
import {
  SECURITY_CASE_RISK_LEVELS,
  SECURITY_CASE_STATUSES,
  redactSecurityCaseText,
  type SecurityCaseActionType,
  type SecurityCaseEntityType,
  type SecurityCaseRiskLevel,
  type SecurityCaseSourceKind,
  type SecurityCaseStatus,
} from "@/lib/security-case-contracts";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseError = { code?: string; message?: string; details?: string };
type RpcResult = { data: unknown; error: DatabaseError | null };
type SecurityEntity = { type: SecurityCaseEntityType; ref: string; label: string };

export interface SecurityCaseImpactPreview {
  schema: "security-case-impact/v1";
  actionType: SecurityCaseActionType;
  targetType: "session" | "user";
  targetRef: string;
  targetExists: boolean;
  currentState: string;
  affectedRowsMax: number;
  reversible: true;
  executionSupported: false;
  executorStatus: "unavailable";
  notes: string[];
}

interface NormalizedSecurityFact {
  sourceKind: SecurityCaseSourceKind;
  sourceEventId: string;
  fingerprint: string;
  eventType: string;
  riskLevel: SecurityCaseRiskLevel;
  riskScore: number;
  title: string;
  summary: string;
  occurredAt: string;
  evidence: Record<string, string | boolean | null>;
  entities: SecurityEntity[];
}

export class SecurityCaseControlError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SecurityCaseControlError";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value: unknown, maximum: number): string {
  return redactSecurityCaseText(value, maximum);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pseudonymous(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const pepper = process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || "security-case-v1";
  return sha256(`${pepper}:${raw}`).slice(0, 24);
}

function normalizeRoute(value: unknown): string {
  const raw = bounded(value, 500).split(/[?#]/u, 1)[0] || "";
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, ":uuid")
    .replace(/\/(?:\d{2,})(?=\/|$)/gu, "/:number");
}

function normalizedRisk(value: unknown, fallback: SecurityCaseRiskLevel = "medium"): SecurityCaseRiskLevel {
  const candidate = text(value) as SecurityCaseRiskLevel;
  return SECURITY_CASE_RISK_LEVELS.includes(candidate) ? candidate : fallback;
}

function riskScore(level: SecurityCaseRiskLevel, adjustment = 0): number {
  const base: Record<SecurityCaseRiskLevel, number> = { low: 15, medium: 40, high: 70, critical: 90 };
  return Math.max(0, Math.min(100, base[level] + adjustment));
}

function fingerprint(parts: Record<string, string | boolean | number | null>): string {
  return sha256(Object.keys(parts).sort().map((key) => `${key}=${String(parts[key] ?? "")}`).join("\n"));
}

function backendCode(error: DatabaseError | null): string {
  const combined = `${error?.code || ""}:${error?.message || ""}:${error?.details || ""}`;
  if (/PGRST202|function .* does not exist|schema cache/iu.test(combined)) return "SECURITY_CASE_MIGRATION_REQUIRED";
  if (/SECURITY_CASE_[A-Z0-9_]+/u.test(combined)) return combined.match(/SECURITY_CASE_[A-Z0-9_]+/u)?.[0] || "SECURITY_CASE_BACKEND_FAILURE";
  return "SECURITY_CASE_BACKEND_FAILURE";
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityCaseControlError("安全案件返回结果无效", "SECURITY_CASE_RESULT_INVALID");
  }
  return value as Record<string, unknown>;
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = getSupabaseAdminClient() as unknown as {
    rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<RpcResult>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) {
    throw new SecurityCaseControlError("安全案件数据操作失败", backendCode(error), error);
  }
  const result = resultRecord(data);
  if (result.success !== true) {
    throw new SecurityCaseControlError("安全案件操作未放行", text(result.code) || "SECURITY_CASE_OPERATION_REJECTED", result);
  }
  return result;
}

async function normalizedSecurityEvent(sourceEventId: string): Promise<NormalizedSecurityFact> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("security_events")
    .select("id,event_type,risk_level,ip_hash,user_id,path,method,blocked,source,created_at")
    .eq("id", sourceEventId)
    .maybeSingle();
  if (error) throw new SecurityCaseControlError("安全事件读取失败", "SECURITY_CASE_SOURCE_READ_FAILED", error);
  if (!data) throw new SecurityCaseControlError("安全事件不存在", "SECURITY_CASE_SOURCE_NOT_FOUND");
  const level = normalizedRisk(data.risk_level);
  const eventType = bounded(data.event_type, 120) || "security_event";
  const route = normalizeRoute(data.path);
  const sourceLabel = bounded(data.source, 80) || "unknown";
  const userRef = pseudonymous(data.user_id);
  const ipHash = bounded(data.ip_hash, 64);
  const method = bounded(data.method, 16).toUpperCase();
  const eventFingerprint = fingerprint({
    source: "security_event",
    eventType,
    sourceLabel,
    userRef,
    ipHash,
    route,
    method,
    blocked: data.blocked === true,
  });
  const entities: SecurityEntity[] = [];
  if (text(data.user_id)) entities.push({ type: "user", ref: text(data.user_id), label: "关联账号" });
  if (ipHash) entities.push({ type: "ip_hash", ref: ipHash, label: "来源 IP 哈希" });
  if (route) entities.push({ type: "route", ref: route, label: "请求路由" });
  return {
    sourceKind: "security_event",
    sourceEventId: text(data.id),
    fingerprint: eventFingerprint,
    eventType,
    riskLevel: level,
    riskScore: riskScore(level, data.blocked === true ? 5 : 0),
    title: bounded(`安全事件：${eventType}`, 160),
    summary: bounded(`${sourceLabel} 的 ${eventType} 已${data.blocked === true ? "拦截" : "记录"}`, 500),
    occurredAt: text(data.created_at) || new Date().toISOString(),
    evidence: {
      sourceLabel,
      sourceTable: "security_events",
      path: route || null,
      method: method || null,
      blocked: data.blocked === true,
    },
    entities,
  };
}

async function normalizedPromptGuardEvent(sourceEventId: string): Promise<NormalizedSecurityFact> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("prompt_guard_logs")
    .select("id,user_id,agent_name,agent_source,risk_level,reason,blocked_at")
    .eq("id", sourceEventId)
    .maybeSingle();
  if (error) throw new SecurityCaseControlError("提示词防护事件读取失败", "SECURITY_CASE_SOURCE_READ_FAILED", error);
  if (!data) throw new SecurityCaseControlError("提示词防护事件不存在", "SECURITY_CASE_SOURCE_NOT_FOUND");
  const level = normalizedRisk(data.risk_level, "high");
  const agentName = bounded(data.agent_name, 120) || "unknown-agent";
  const sourceLabel = bounded(data.agent_source, 80) || "unknown";
  const reason = bounded(data.reason, 180) || "guard_match";
  const userRef = pseudonymous(data.user_id);
  const eventFingerprint = fingerprint({
    source: "prompt_guard_log",
    eventType: "prompt_injection",
    sourceLabel,
    agentName,
    reason: reason.toLowerCase(),
    userRef,
  });
  const entities: SecurityEntity[] = [];
  if (text(data.user_id)) entities.push({ type: "user", ref: text(data.user_id), label: "关联账号" });
  if (sourceLabel) entities.push({ type: "channel", ref: sourceLabel, label: "提示词防护来源" });
  return {
    sourceKind: "prompt_guard_log",
    sourceEventId: text(data.id),
    fingerprint: eventFingerprint,
    eventType: "prompt_injection",
    riskLevel: level,
    riskScore: riskScore(level, 5),
    title: "提示词防护命中",
    summary: bounded(`智能体 ${agentName}：${reason}`, 500),
    occurredAt: text(data.blocked_at) || new Date().toISOString(),
    evidence: {
      sourceLabel,
      sourceTable: "prompt_guard_logs",
      agentName,
      blocked: true,
    },
    entities,
  };
}

async function normalizedLoginEvent(sourceEventId: string): Promise<NormalizedSecurityFact> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("login_logs")
    .select("id,user_id,status,fail_reason,login_method,created_at")
    .eq("id", sourceEventId)
    .maybeSingle();
  if (error) throw new SecurityCaseControlError("登录事件读取失败", "SECURITY_CASE_SOURCE_READ_FAILED", error);
  if (!data) throw new SecurityCaseControlError("登录事件不存在", "SECURITY_CASE_SOURCE_NOT_FOUND");
  const status = bounded(data.status, 40).toLowerCase();
  if (!status || status === "success") {
    throw new SecurityCaseControlError("成功登录不能创建安全案件", "SECURITY_CASE_SOURCE_NOT_ACTIONABLE");
  }
  const reason = bounded(data.fail_reason, 180) || "login_failed";
  const method = bounded(data.login_method, 60) || "unknown";
  const userRef = pseudonymous(data.user_id);
  const eventFingerprint = fingerprint({
    source: "login_log",
    eventType: "login_failure",
    status,
    reason: reason.toLowerCase(),
    method,
    userRef,
  });
  const entities: SecurityEntity[] = [];
  if (text(data.user_id)) entities.push({ type: "user", ref: text(data.user_id), label: "关联账号" });
  return {
    sourceKind: "login_log",
    sourceEventId: text(data.id),
    fingerprint: eventFingerprint,
    eventType: "login_failure",
    riskLevel: "medium",
    riskScore: 45,
    title: "异常登录失败",
    summary: bounded(`${method} 登录失败：${reason}`, 500),
    occurredAt: text(data.created_at) || new Date().toISOString(),
    evidence: {
      sourceLabel: method,
      sourceTable: "login_logs",
      status,
      blocked: true,
    },
    entities,
  };
}

async function normalizedOperationEvent(sourceEventId: string): Promise<NormalizedSecurityFact> {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("operation_flight_events")
    .select("id,trace_id,user_id,source,domain,operation,phase,outcome,route,error_code,error_fingerprint,occurred_at")
    .eq("id", sourceEventId)
    .maybeSingle();
  if (error) throw new SecurityCaseControlError("飞行日志事件读取失败", "SECURITY_CASE_SOURCE_READ_FAILED", error);
  if (!data) throw new SecurityCaseControlError("飞行日志事件不存在", "SECURITY_CASE_SOURCE_NOT_FOUND");
  const outcome = bounded(data.outcome, 40).toLowerCase();
  if (!new Set(["warning", "error", "unknown"]).has(outcome)) {
    throw new SecurityCaseControlError("该飞行日志不是可处置异常", "SECURITY_CASE_SOURCE_NOT_ACTIONABLE");
  }
  const operation = bounded(data.operation, 120) || "unknown_operation";
  const phase = bounded(data.phase, 80) || "unknown";
  const errorCode = bounded(data.error_code, 120);
  const route = normalizeRoute(data.route);
  const traceId = bounded(data.trace_id, 160);
  const sourceLabel = bounded(data.source, 60) || "unknown";
  const stableError = bounded(data.error_fingerprint, 64) || errorCode || `${operation}:${phase}:${outcome}`;
  const level: SecurityCaseRiskLevel = outcome === "error" ? "high" : "medium";
  const eventFingerprint = fingerprint({
    source: "operation_flight_event",
    domain: bounded(data.domain, 80),
    operation,
    phase,
    outcome,
    route,
    stableError,
    userRef: pseudonymous(data.user_id),
  });
  const entities: SecurityEntity[] = [];
  if (text(data.user_id)) entities.push({ type: "user", ref: text(data.user_id), label: "关联账号" });
  if (route) entities.push({ type: "route", ref: route, label: "运行路由" });
  if (traceId) entities.push({ type: "trace", ref: traceId, label: "Trace ID" });
  return {
    sourceKind: "operation_flight_event",
    sourceEventId: text(data.id),
    fingerprint: eventFingerprint,
    eventType: bounded(`${operation}.${outcome}`, 120),
    riskLevel: level,
    riskScore: riskScore(level),
    title: bounded(`运行异常：${operation}`, 160),
    summary: bounded(`${phase} · ${outcome}${errorCode ? ` · ${errorCode}` : ""}`, 500),
    occurredAt: text(data.occurred_at) || new Date().toISOString(),
    evidence: {
      sourceLabel,
      sourceTable: "operation_flight_events",
      path: route || null,
      traceId: traceId || null,
      errorCode: errorCode || null,
      status: outcome,
    },
    entities,
  };
}

async function loadNormalizedFact(sourceKind: SecurityCaseSourceKind, sourceEventId: string): Promise<NormalizedSecurityFact> {
  if (sourceKind === "security_event") return normalizedSecurityEvent(sourceEventId);
  if (sourceKind === "prompt_guard_log") return normalizedPromptGuardEvent(sourceEventId);
  if (sourceKind === "login_log") return normalizedLoginEvent(sourceEventId);
  return normalizedOperationEvent(sourceEventId);
}

export async function ingestSecurityCaseEvent(params: {
  sourceKind: SecurityCaseSourceKind;
  sourceEventId: string;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  const fact = await loadNormalizedFact(params.sourceKind, params.sourceEventId);
  return callRpc("ingest_security_case_event_atomic", {
    p_event_fingerprint: fact.fingerprint,
    p_source_kind: fact.sourceKind,
    p_source_event_id: fact.sourceEventId,
    p_event_type: fact.eventType,
    p_risk_level: fact.riskLevel,
    p_risk_score: fact.riskScore,
    p_title: fact.title,
    p_summary: fact.summary,
    p_occurred_at: fact.occurredAt,
    p_actor_id: params.actorId,
    p_evidence: fact.evidence,
    p_entities: fact.entities,
    p_request_key: params.requestKey,
  });
}

export async function listSecurityCases(params: {
  page: number;
  pageSize: number;
  status?: string;
  riskLevel?: string;
  assignedTo?: string;
}) {
  if (params.status && !SECURITY_CASE_STATUSES.includes(params.status as SecurityCaseStatus)) {
    throw new SecurityCaseControlError("案件状态筛选无效", "SECURITY_CASE_FILTER_INVALID");
  }
  if (params.riskLevel && !SECURITY_CASE_RISK_LEVELS.includes(params.riskLevel as SecurityCaseRiskLevel)) {
    throw new SecurityCaseControlError("风险等级筛选无效", "SECURITY_CASE_FILTER_INVALID");
  }
  const client = getSupabaseAdminClient();
  let query = client
    .from("security_cases")
    .select("id,fingerprint,title,summary,risk_level,risk_score,status,assigned_to,revision,event_count,first_seen_at,last_seen_at,closed_at,created_at,updated_at", { count: "exact" })
    .order("risk_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .range((params.page - 1) * params.pageSize, params.page * params.pageSize - 1);
  if (params.status) query = query.eq("status", params.status);
  if (params.riskLevel) query = query.eq("risk_level", params.riskLevel);
  if (params.assignedTo) query = query.eq("assigned_to", params.assignedTo);
  const { data, error, count } = await query;
  if (error) throw new SecurityCaseControlError("安全案件列表暂不可用", backendCode(error), error);
  return { cases: data || [], page: params.page, pageSize: params.pageSize, total: count || 0 };
}

export async function readSecurityCaseDetail(caseId: string) {
  const client = getSupabaseAdminClient();
  const [caseResult, eventsResult, linksResult, actionsResult, auditResult] = await Promise.all([
    client.from("security_cases").select("id,fingerprint,title,summary,risk_level,risk_score,status,assigned_to,revision,event_count,first_seen_at,last_seen_at,closed_at,created_at,updated_at").eq("id", caseId).maybeSingle(),
    client.from("security_case_events").select("id,source_kind,source_event_id,event_fingerprint,event_type,risk_level,risk_score,summary,evidence,occurred_at,linked_at,linked_by").eq("case_id", caseId).order("occurred_at", { ascending: false }).limit(200),
    client.from("security_case_links").select("id,entity_type,entity_ref,entity_label,linked_by,linked_at").eq("case_id", caseId).order("linked_at", { ascending: false }).limit(200),
    client.from("security_case_actions").select("id,action_type,target_type,target_ref,status,revision,execution_supported,impact_preview,reason,requested_by,request_key,requested_at,cancelled_by,cancelled_at,cancellation_reason").eq("case_id", caseId).order("requested_at", { ascending: false }).limit(100),
    client.from("security_case_audit").select("id,action_id,actor_id,event_type,from_status,to_status,reason_code,reason,request_key,details,created_at").eq("case_id", caseId).order("id", { ascending: false }).limit(300),
  ]);
  const firstError = caseResult.error || eventsResult.error || linksResult.error || actionsResult.error || auditResult.error;
  if (firstError) throw new SecurityCaseControlError("安全案件详情暂不可用", backendCode(firstError), firstError);
  if (!caseResult.data) throw new SecurityCaseControlError("安全案件不存在", "SECURITY_CASE_NOT_FOUND");
  return {
    case: caseResult.data,
    events: eventsResult.data || [],
    links: linksResult.data || [],
    actions: actionsResult.data || [],
    audit: auditResult.data || [],
    executionPolicy: {
      executorAvailable: false,
      supportedRequests: ["revoke_session", "disable_user"],
      destructiveExecutionEnabled: false,
    },
  };
}

export function transitionSecurityCase(params: {
  caseId: string;
  expectedRevision: number;
  targetStatus: SecurityCaseStatus;
  actorId: string;
  reason: string;
  requestKey: string;
}) {
  return callRpc("transition_security_case_atomic", {
    p_case_id: params.caseId,
    p_expected_revision: params.expectedRevision,
    p_target_status: params.targetStatus,
    p_actor_id: params.actorId,
    p_reason: params.reason,
    p_request_key: params.requestKey,
  });
}

export function claimSecurityCase(params: {
  caseId: string;
  expectedRevision: number;
  actorId: string;
  reason: string;
  requestKey: string;
}) {
  return callRpc("claim_security_case_atomic", {
    p_case_id: params.caseId,
    p_expected_revision: params.expectedRevision,
    p_actor_id: params.actorId,
    p_reason: params.reason,
    p_request_key: params.requestKey,
  });
}

export function linkSecurityCaseEntity(params: {
  caseId: string;
  expectedRevision: number;
  entityType: SecurityCaseEntityType;
  entityRef: string;
  entityLabel: string;
  actorId: string;
  reason: string;
  requestKey: string;
}) {
  return callRpc("link_security_case_entity_atomic", {
    p_case_id: params.caseId,
    p_expected_revision: params.expectedRevision,
    p_entity_type: params.entityType,
    p_entity_ref: params.entityRef,
    p_entity_label: params.entityLabel,
    p_actor_id: params.actorId,
    p_reason: params.reason,
    p_request_key: params.requestKey,
  });
}

export async function previewSecurityCaseAction(params: {
  caseId: string;
  expectedRevision: number;
  actionType: SecurityCaseActionType;
  targetRef: string;
}): Promise<SecurityCaseImpactPreview> {
  const targetType = params.actionType === "revoke_session" ? "session" : "user";
  const client = getSupabaseAdminClient();
  const [caseResult, linkResult] = await Promise.all([
    client.from("security_cases").select("id,status,revision,assigned_to").eq("id", params.caseId).maybeSingle(),
    client.from("security_case_links").select("id").eq("case_id", params.caseId).eq("entity_type", targetType).eq("entity_ref", params.targetRef).maybeSingle(),
  ]);
  if (caseResult.error || linkResult.error) {
    const error = caseResult.error || linkResult.error;
    throw new SecurityCaseControlError("处置影响预演暂不可用", backendCode(error), error);
  }
  if (!caseResult.data) throw new SecurityCaseControlError("安全案件不存在", "SECURITY_CASE_NOT_FOUND");
  if (Number(caseResult.data.revision) !== params.expectedRevision) {
    throw new SecurityCaseControlError("案件已被其他管理员更新", "SECURITY_CASE_REVISION_CONFLICT", caseResult.data);
  }
  if (new Set(["resolved", "false_positive"]).has(String(caseResult.data.status))) {
    throw new SecurityCaseControlError("已关闭案件不能申请处置", "SECURITY_CASE_CLOSED");
  }
  if (!linkResult.data) {
    throw new SecurityCaseControlError("处置目标必须先关联到案件", "SECURITY_CASE_ACTION_TARGET_NOT_LINKED");
  }

  if (params.actionType === "revoke_session") {
    const { data, error } = await client
      .from("user_auth_sessions")
      .select("session_id,user_id,revoked_at,expires_at")
      .eq("session_id", params.targetRef)
      .maybeSingle();
    if (error) throw new SecurityCaseControlError("会话影响预演失败", "SECURITY_CASE_PREVIEW_FAILED", error);
    const active = Boolean(data && !data.revoked_at && new Date(String(data.expires_at)).getTime() > Date.now());
    return {
      schema: "security-case-impact/v1",
      actionType: params.actionType,
      targetType,
      targetRef: params.targetRef,
      targetExists: Boolean(data),
      currentState: !data ? "missing" : active ? "active" : data.revoked_at ? "revoked" : "expired",
      affectedRowsMax: data ? 1 : 0,
      reversible: true,
      executionSupported: false,
      executorStatus: "unavailable",
      notes: ["只针对这一条会话", "当前阶段只保存请求，不执行撤销", "用户仍可重新登录建立新会话"],
    };
  }

  const [{ data, error }, sessions] = await Promise.all([
    client.from("users").select("id,role,status,is_active").eq("id", params.targetRef).maybeSingle(),
    client.from("user_auth_sessions").select("session_id", { count: "exact", head: true }).eq("user_id", params.targetRef).is("revoked_at", null),
  ]);
  if (error || sessions.error) throw new SecurityCaseControlError("账号影响预演失败", "SECURITY_CASE_PREVIEW_FAILED", error || sessions.error);
  const disabled = Boolean(data && (data.is_active === false || new Set(["suspended", "blocked", "disabled"]).has(String(data.status || "").toLowerCase())));
  return {
    schema: "security-case-impact/v1",
    actionType: params.actionType,
    targetType,
    targetRef: params.targetRef,
    targetExists: Boolean(data),
    currentState: !data ? "missing" : data.role === "admin" ? "admin_requires_governance" : disabled ? "disabled" : "active",
    affectedRowsMax: data ? 1 + Number(sessions.count || 0) : 0,
    reversible: true,
    executionSupported: false,
    executorStatus: "unavailable",
    notes: ["预期暂停目标账号并结束其活动会话", "当前阶段只保存请求，不修改账号或会话", "管理员账号必须走管理员治理链"],
  };
}

export async function requestSecurityCaseAction(params: {
  caseId: string;
  expectedRevision: number;
  actionType: SecurityCaseActionType;
  targetRef: string;
  actorId: string;
  reason: string;
  requestKey: string;
  impactPreview: SecurityCaseImpactPreview;
}) {
  if (!params.impactPreview.targetExists) {
    throw new SecurityCaseControlError("处置目标不存在，不能创建请求", "SECURITY_CASE_ACTION_TARGET_NOT_FOUND");
  }
  if (params.impactPreview.currentState === "admin_requires_governance") {
    throw new SecurityCaseControlError("管理员账号必须走管理员治理链", "SECURITY_CASE_ADMIN_TARGET_REQUIRES_GOVERNANCE");
  }
  if (new Set(["revoked", "expired", "disabled"]).has(params.impactPreview.currentState)) {
    throw new SecurityCaseControlError("目标已经处于预期终态", "SECURITY_CASE_ACTION_ALREADY_EFFECTIVE");
  }
  return callRpc("request_security_case_action_atomic", {
    p_case_id: params.caseId,
    p_expected_revision: params.expectedRevision,
    p_action_type: params.actionType,
    p_target_type: params.actionType === "revoke_session" ? "session" : "user",
    p_target_ref: params.targetRef,
    p_impact_preview: params.impactPreview,
    p_actor_id: params.actorId,
    p_reason: params.reason,
    p_request_key: params.requestKey,
  });
}

export function cancelSecurityCaseAction(params: {
  caseId: string;
  actionId: string;
  expectedActionRevision: number;
  actorId: string;
  reason: string;
  requestKey: string;
}) {
  return callRpc("cancel_security_case_action_atomic", {
    p_action_id: params.actionId,
    p_case_id: params.caseId,
    p_expected_action_revision: params.expectedActionRevision,
    p_actor_id: params.actorId,
    p_reason: params.reason,
    p_request_key: params.requestKey,
  });
}

export function securityCaseControlErrorStatus(error: unknown): number {
  if (!(error instanceof SecurityCaseControlError)) return 500;
  if (error.code.endsWith("_NOT_FOUND")) return 404;
  if (error.code.includes("CONFLICT") || error.code.includes("NOT_AVAILABLE") || error.code.includes("CLOSED") || error.code.includes("REQUIRES_ASSIGNEE") || error.code.includes("NOT_CANCELLABLE") || error.code.includes("ALREADY_EFFECTIVE")) return 409;
  if (error.code === "SECURITY_CASE_MIGRATION_REQUIRED") return 503;
  if (error.code.includes("READ_FAILED") || error.code.includes("PREVIEW_FAILED") || error.code.includes("BACKEND_FAILURE")) return 503;
  if (error.code.includes("INVALID") || error.code.includes("NOT_ACTIONABLE") || error.code.includes("NOT_ALLOWED") || error.code.includes("TARGET_NOT_LINKED") || error.code.includes("REQUIRES_GOVERNANCE")) return 400;
  if (error.code.includes("DENIED")) return 403;
  return 500;
}
