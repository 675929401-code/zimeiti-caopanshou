import "server-only";

import crypto from "node:crypto";

import {
  ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS,
  normalizeSessionRevokeReason,
  type AdminAccountSecurityResponse,
  type AdminLoginRiskSnapshot,
  type AdminSessionItem,
} from "@/lib/admin-account-security-contract";
import { isEmailConfigured } from "@/lib/email";
import { getServerSecret, requireServerSecret } from "@/lib/server-secrets";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

interface SessionRow {
  session_id: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface AdminSecurityReadInput {
  actorId: string;
  currentSessionId: string;
  email: string | null;
  requestIp: string;
  userAgent: string;
}

export interface AdminSessionRevokeResult {
  revoked: boolean;
  alreadyInactive: boolean;
  current: boolean;
}

function sessionHandle(actorId: string, sessionId: string): string {
  return crypto
    .createHmac("sha256", requireServerSecret("JWT_SECRET"))
    .update(`admin-session-handle:v1:${actorId}:${sessionId}`)
    .digest("base64url");
}

function requestIpHash(ip: string): string {
  const pepper = getServerSecret("SECURITY_INTERNAL_KEY") || requireServerSecret("JWT_SECRET");
  return crypto.createHash("sha256").update(`${ip}${pepper}`).digest("hex").slice(0, 16);
}

function userAgentHash(userAgent: string): string {
  return crypto.createHash("sha256").update(userAgent).digest("hex").slice(0, 32);
}

function equalHandle(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return null;
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local.slice(0, 2)}…${local.slice(-1)}`;
  return `${visible}@${domain}`;
}

function statusFor(row: SessionRow, nowMs: number): AdminSessionItem["status"] {
  if (row.revoked_at) return "revoked";
  const expiry = Date.parse(row.expires_at);
  return Number.isFinite(expiry) && expiry > nowMs ? "active" : "expired";
}

async function readSessionRows(actorId: string, limit = ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS + 1): Promise<SessionRow[]> {
  const { data, error } = await getSupabaseAdminClient()
    .from("user_auth_sessions")
    .select("session_id,ip_hash,user_agent_hash,created_at,expires_at,revoked_at,revoke_reason")
    .eq("user_id", actorId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) throw new Error("ADMIN_SESSION_STORE_UNAVAILABLE");
  return (data || []) as SessionRow[];
}

async function readFailedLoginCount(actorId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count, error } = await getSupabaseAdminClient()
    .from("login_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", actorId)
    .eq("status", "failed")
    .gte("created_at", since)
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) throw new Error("ADMIN_LOGIN_RISK_SOURCE_UNAVAILABLE");
  return Number(count || 0);
}

function buildRiskSnapshot(params: {
  failedLoginCount: number | null;
  currentRow: SessionRow | null;
  requestIp: string;
  userAgent: string;
  sessionSourceReady: boolean;
}): AdminLoginRiskSnapshot {
  const signals: AdminLoginRiskSnapshot["signals"] = [];
  if (params.failedLoginCount != null && params.failedLoginCount >= 5) {
    signals.push({
      code: "REPEATED_FAILED_LOGINS",
      label: "24 小时内存在多次失败登录",
      severity: "high",
      evidence: `${params.failedLoginCount} 次与当前管理员账号关联的失败登录记录`,
    });
  } else if (params.failedLoginCount != null && params.failedLoginCount >= 2) {
    signals.push({
      code: "ELEVATED_FAILED_LOGINS",
      label: "失败登录次数上升",
      severity: "attention",
      evidence: `${params.failedLoginCount} 次与当前管理员账号关联的失败登录记录`,
    });
  }

  if (params.currentRow?.user_agent_hash && params.currentRow.user_agent_hash !== userAgentHash(params.userAgent)) {
    signals.push({
      code: "CURRENT_SESSION_USER_AGENT_CHANGED",
      label: "当前会话的浏览器指纹发生变化",
      severity: "attention",
      evidence: "本次 User-Agent 哈希与会话签发时记录不一致",
    });
  }
  if (params.currentRow?.ip_hash && params.currentRow.ip_hash !== requestIpHash(params.requestIp)) {
    signals.push({
      code: "CURRENT_SESSION_NETWORK_CHANGED",
      label: "当前会话的网络线索发生变化",
      severity: "attention",
      evidence: "本次网络地址哈希与会话签发时记录不一致；换网、代理或共享出口也会触发",
    });
  }

  const sourceCount = Number(params.failedLoginCount != null) + Number(params.sessionSourceReady);
  const level = signals.some((signal) => signal.severity === "high")
    ? "high"
    : signals.some((signal) => signal.severity === "attention")
      ? "attention"
      : sourceCount === 2
        ? "normal"
        : "unknown";
  return {
    status: sourceCount === 2 ? "ready" : sourceCount === 1 ? "partial" : "unavailable",
    level,
    failedLoginCount24h: params.failedLoginCount,
    signals,
    limitations: [
      "风险信号只说明账号或会话出现异常线索，不能据此认定具体攻击者。",
      "IP 变化可能来自换网、代理或共享出口，当前不具备可信地理定位和不可能旅行判断。",
      "登录前异常挑战尚未接入令牌签发门禁，当前信号仅用于人工复核。",
    ],
  };
}

export async function readAdminAccountSecurityCore(input: AdminSecurityReadInput): Promise<{
  sessions: AdminAccountSecurityResponse["sessions"];
  risk: AdminAccountSecurityResponse["risk"];
  mfa: AdminAccountSecurityResponse["mfa"];
}> {
  const nowMs = Date.now();
  let rows: SessionRow[] = [];
  let sessionSourceReady = false;
  try {
    rows = await readSessionRows(input.actorId);
    sessionSourceReady = true;
  } catch {
    rows = [];
  }

  const truncated = rows.length > ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS;
  const visibleRows = rows.slice(0, ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS);
  const items = visibleRows.map<AdminSessionItem>((row) => {
    const status = statusFor(row, nowMs);
    return {
      handle: sessionHandle(input.actorId, row.session_id),
      current: row.session_id === input.currentSessionId,
      status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokeReason: normalizeSessionRevokeReason(row.revoke_reason),
      deviceEvidence: row.user_agent_hash
        ? { status: "hashed_only", label: "设备指纹已记录", detail: "只保存不可逆哈希，无法还原浏览器明文" }
        : { status: "unavailable", label: "设备线索不可用", detail: "该历史会话没有设备指纹哈希" },
      networkEvidence: row.ip_hash
        ? { status: "hashed_only", label: "网络线索已记录", detail: "只保存不可逆哈希，不展示或反推原始 IP" }
        : { status: "unavailable", label: "网络线索不可用", detail: "该历史会话没有网络地址哈希" },
    };
  });
  const currentRow = visibleRows.find((row) => row.session_id === input.currentSessionId) || null;

  let failedLoginCount: number | null = null;
  try {
    failedLoginCount = await readFailedLoginCount(input.actorId);
  } catch {
    failedLoginCount = null;
  }

  let transportStatus: AdminAccountSecurityResponse["mfa"]["transportStatus"] = "unknown";
  try {
    transportStatus = await isEmailConfigured() ? "configured_unverified" : "not_configured";
  } catch {
    transportStatus = "unknown";
  }
  const destination = maskEmail(input.email);
  const mfaReason = !destination
    ? "当前管理员没有可用邮箱；且平台尚无耐久 MFA 挑战状态。"
    : transportStatus === "not_configured"
      ? "管理员邮箱已绑定，但邮件传输未配置，且平台尚无耐久 MFA 挑战状态。"
      : "邮箱验证码链可作为候选因子，但尚未接入登录发令牌前的耐久挑战与原子消费。";

  return {
    sessions: {
      status: sessionSourceReady ? "ready" : "unavailable",
      activeCount: sessionSourceReady ? items.filter((item) => item.status === "active").length : null,
      currentSessionFound: sessionSourceReady && items.some((item) => item.current),
      items,
      limit: ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS,
      truncated,
      detail: sessionSourceReady
        ? "会话由 user_auth_sessions 服务端事实源读取；原始会话 ID、IP 和 User-Agent 不进入响应。"
        : "user_auth_sessions 当前不可读，本次不会用空数组冒充没有会话。",
    },
    risk: buildRiskSnapshot({
      failedLoginCount,
      currentRow,
      requestIp: input.requestIp,
      userAgent: input.userAgent,
      sessionSourceReady,
    }),
    mfa: {
      status: "unavailable",
      code: "ADMIN_EMAIL_MFA_ENFORCEMENT_NOT_READY",
      label: "管理员邮箱 MFA 尚未启用",
      detail: mfaReason,
      nextStep: "应用 design-only 迁移后，再接入密码验证→待验证挑战→邮箱验证码原子消费→签发会话的完整登录链。",
      factor: destination ? "email_otp" : null,
      destination,
      transportStatus,
    },
  };
}

export async function revokeAdminSessionByHandle(params: {
  actorId: string;
  currentSessionId: string;
  handle: string;
  allowCurrent: boolean;
}): Promise<AdminSessionRevokeResult> {
  const rows = await readSessionRows(params.actorId, ADMIN_ACCOUNT_SECURITY_MAX_SESSIONS);
  const target = rows.find((row) => equalHandle(sessionHandle(params.actorId, row.session_id), params.handle));
  if (!target) throw new Error("ADMIN_SESSION_NOT_FOUND");
  const current = target.session_id === params.currentSessionId;
  if (current && !params.allowCurrent) throw new Error("CURRENT_SESSION_CONFIRMATION_REQUIRED");
  const inactive = Boolean(target.revoked_at) || Date.parse(target.expires_at) <= Date.now();
  if (inactive) return { revoked: false, alreadyInactive: true, current };

  const { data, error } = await getSupabaseAdminClient().rpc("revoke_user_auth_session", {
    p_user_id: params.actorId,
    p_session_id: target.session_id,
    p_reason: "administrator_revoked",
  });
  if (error || !(data as { ok?: boolean } | null)?.ok) throw new Error("ADMIN_SESSION_REVOKE_FAILED");
  const revoked = (data as { revoked?: boolean } | null)?.revoked === true;
  return { revoked, alreadyInactive: !revoked, current };
}

export async function sessionMutationAlreadyRecorded(actorId: string, requestKey: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient()
    .from("admin_governance_audit")
    .select("id")
    .eq("actor_id", actorId)
    .eq("request_key", requestKey)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("ADMIN_SESSION_AUDIT_UNAVAILABLE");
  return Boolean(data?.id);
}

export async function recentSessionMutationCount(actorId: string, since: string): Promise<number> {
  const { count, error } = await getSupabaseAdminClient()
    .from("admin_governance_audit")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", actorId)
    .eq("action", "admin_session_revoke")
    .gte("created_at", since);
  if (error) throw new Error("ADMIN_SESSION_AUDIT_UNAVAILABLE");
  return Number(count || 0);
}
