import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  ADMIN_ACCOUNT_SECURITY_CACHE_TTL_MS,
  ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION,
  ADMIN_ACCOUNT_SECURITY_WRITE_LIMIT,
  ADMIN_ACCOUNT_SECURITY_WRITE_WINDOW_MS,
  type AdminAccountSecurityResponse,
} from "@/lib/admin-account-security-contract";
import { ADMIN_STEP_UP_COOKIE } from "@/lib/admin-governance";
import { getClientIP } from "@/lib/security";
import { validateBrowserWriteSource } from "@/lib/security-edge";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  readAdminStepUpSnapshot,
} from "@/lib/server/admin-governance-authority";
import {
  readAdminAccountSecurityCore,
  recentSessionMutationCount,
  revokeAdminSessionByHandle,
  sessionMutationAlreadyRecorded,
} from "@/lib/server/admin-account-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  Vary: "Authorization, Cookie",
};
const READ_WINDOW_MS = 60_000;
const READ_LIMIT = 30;
const MAX_BODY_BYTES = 4_096;

interface CoreCacheEntry {
  asOf: string;
  expiresAtMs: number;
  core: Awaited<ReturnType<typeof readAdminAccountSecurityCore>>;
}

interface RequestWindow {
  startedAtMs: number;
  count: number;
}

const processState = globalThis as typeof globalThis & {
  __adminAccountSecurityCache?: Map<string, CoreCacheEntry>;
  __adminAccountSecurityInFlight?: Map<string, Promise<CoreCacheEntry>>;
  __adminAccountSecurityReadWindows?: Map<string, RequestWindow>;
  __adminAccountSecurityMutationLocks?: Set<string>;
};
const cache = processState.__adminAccountSecurityCache ??= new Map<string, CoreCacheEntry>();
const inFlight = processState.__adminAccountSecurityInFlight ??= new Map<string, Promise<CoreCacheEntry>>();
const readWindows = processState.__adminAccountSecurityReadWindows ??= new Map<string, RequestWindow>();
const mutationLocks = processState.__adminAccountSecurityMutationLocks ??= new Set<string>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function cacheKey(request: NextRequest, actorId: string, sessionId: string): string {
  const requestEvidence = crypto.createHash("sha256")
    .update(`${getClientIP(request)}\u0000${request.headers.get("user-agent") || ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${actorId}:${sessionId}:${requestEvidence}`;
}

function checkReadRateLimit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  const current = readWindows.get(key);
  if (!current || now - current.startedAtMs >= READ_WINDOW_MS) {
    readWindows.set(key, { startedAtMs: now, count: 1 });
    return { allowed: true };
  }
  current.count += 1;
  if (current.count <= READ_LIMIT) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((READ_WINDOW_MS - (now - current.startedAtMs)) / 1_000)) };
}

async function readCore(
  request: NextRequest,
  actorId: string,
  sessionId: string,
  email: string | null,
): Promise<{ entry: CoreCacheEntry; cacheStatus: AdminAccountSecurityResponse["cacheStatus"] }> {
  const key = cacheKey(request, actorId, sessionId);
  const existing = cache.get(key);
  if (existing && existing.expiresAtMs > Date.now()) return { entry: existing, cacheStatus: "hit" };
  const shared = inFlight.get(key);
  if (shared) return { entry: await shared, cacheStatus: "shared" };

  const requestPromise = (async () => {
    const asOf = new Date().toISOString();
    const core = await readAdminAccountSecurityCore({
      actorId,
      currentSessionId: sessionId,
      email,
      requestIp: getClientIP(request),
      userAgent: request.headers.get("user-agent") || "unknown",
    });
    const entry = { asOf, expiresAtMs: Date.now() + ADMIN_ACCOUNT_SECURITY_CACHE_TTL_MS, core };
    cache.set(key, entry);
    return entry;
  })();
  inFlight.set(key, requestPromise);
  try {
    return { entry: await requestPromise, cacheStatus: "miss" };
  } finally {
    inFlight.delete(key);
  }
}

function invalidateActorCache(actorId: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${actorId}:`)) cache.delete(key);
  }
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "security.view", {
    operation: "admin_account_security_view",
  });
  if (!authorization.ok) return authorization.response;
  const sessionId = authorization.actor.sessionId || "";
  if (!sessionId) return json({ error: "当前管理员会话缺少服务端标识", code: "ADMIN_SESSION_ID_MISSING" }, 401);

  const rate = checkReadRateLimit(`${authorization.actor.userId}:${sessionId}`);
  if (!rate.allowed) {
    return json(
      { error: "会话安全状态读取过于频繁，请稍后再试", code: "ADMIN_ACCOUNT_SECURITY_RATE_LIMITED" },
      429,
      { "Retry-After": String(rate.retryAfterSeconds) },
    );
  }

  try {
    const [{ entry, cacheStatus }, stepUp] = await Promise.all([
      readCore(request, authorization.actor.userId, sessionId, authorization.user.email),
      readAdminStepUpSnapshot(request, authorization.actor.userId, "security.view"),
    ]);
    const asOfMs = Date.parse(entry.asOf);
    const nextRefreshAt = new Date(entry.expiresAtMs).toISOString();
    const response: AdminAccountSecurityResponse = {
      schemaVersion: ADMIN_ACCOUNT_SECURITY_SCHEMA_VERSION,
      asOf: entry.asOf,
      nextRefreshAt,
      freshnessSeconds: Number.isFinite(asOfMs) ? Math.max(0, Math.floor((Date.now() - asOfMs) / 1_000)) : 0,
      cacheStatus,
      scope: "current_admin_account",
      sessions: entry.core.sessions,
      risk: entry.core.risk,
      mfa: entry.core.mfa,
      trustedDevices: {
        status: "unavailable",
        code: "ADMIN_TRUSTED_DEVICE_STORE_NOT_READY",
        label: "可信设备尚未启用",
        detail: "现有会话只保存网络与 User-Agent 的不可逆哈希；它们不是可信设备凭据，不能绕过验证。",
        nextStep: "应用并验收可信设备随机令牌哈希存储、到期、撤销与 MFA 后签发流程。",
      },
      anomalyChallenge: {
        status: "partial",
        code: "ADMIN_ANOMALY_CHALLENGE_MONITORING_ONLY",
        label: "异常登录目前仅监测",
        detail: "系统可读取失败登录和当前会话指纹变化，但尚未在登录发令牌前强制邮箱挑战。",
        nextStep: "将风险判定接入 pending-login 挑战；挑战成功前不得创建 user_auth_sessions 或 JWT。",
      },
      stepUp: {
        status: stepUp.status,
        expiresAt: stepUp.status === "ready" ? stepUp.expiresAt : null,
        authMethod: stepUp.status === "ready" ? stepUp.authMethod : null,
      },
      permissions: {
        read: "security.view",
        write: "security.view",
        writeRequiresStepUp: true,
      },
      privacy: {
        rawSessionIdsExposed: false,
        rawIpExposed: false,
        rawUserAgentExposed: false,
        notes: [
          "会话操作使用服务端 HMAC 句柄，客户端拿不到原始 session_id。",
          "IP 和 User-Agent 只参与服务端风险比对，列表仅返回是否存在哈希证据。",
        ],
      },
      rateLimit: {
        readCacheSeconds: ADMIN_ACCOUNT_SECURITY_CACHE_TTL_MS / 1_000,
        writeLimit: ADMIN_ACCOUNT_SECURITY_WRITE_LIMIT,
        writeWindowSeconds: ADMIN_ACCOUNT_SECURITY_WRITE_WINDOW_MS / 1_000,
      },
    };
    return json(response, 200, { "X-Cache-Status": cacheStatus });
  } catch (error) {
    console.error("[admin-account-security] read failed", error);
    return json({ error: "管理员会话安全状态暂不可用", code: "ADMIN_ACCOUNT_SECURITY_UNAVAILABLE" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const source = validateBrowserWriteSource(request.method, request.headers);
  if (!source.allowed) {
    return json({ error: "请求来源校验失败", code: "ADMIN_ACCOUNT_SECURITY_CSRF_REJECTED" }, 403);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "只接受 JSON 请求", code: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: "请求内容过大", code: "PAYLOAD_TOO_LARGE" }, 413);
  }

  const authorization = await authorizeAdminCapability(request, "security.view", {
    requireStepUp: true,
    operation: "admin_account_security_write",
  });
  if (!authorization.ok) return authorization.response;
  const currentSessionId = authorization.actor.sessionId || "";
  if (!currentSessionId) return json({ error: "当前管理员会话缺少服务端标识", code: "ADMIN_SESSION_ID_MISSING" }, 401);

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ error: "请求内容过大", code: "PAYLOAD_TOO_LARGE" }, 413);
  }
  let body: { action?: string; sessionHandle?: string; allowCurrent?: boolean };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "请求内容不是有效 JSON", code: "INVALID_JSON" }, 400);
  }

  if (body.action === "enable_email_mfa") {
    return json({
      error: "邮箱 MFA 耐久挑战与登录前门禁尚未应用，未发送验证码",
      code: "ADMIN_EMAIL_MFA_ENFORCEMENT_NOT_READY",
    }, 503);
  }
  if (body.action === "trust_current_device") {
    return json({
      error: "可信设备随机凭据存储尚未应用，本次没有签发设备凭据",
      code: "ADMIN_TRUSTED_DEVICE_STORE_NOT_READY",
    }, 503);
  }
  if (body.action !== "revoke_session") {
    return json({ error: "不支持的会话安全操作", code: "INVALID_ADMIN_ACCOUNT_SECURITY_ACTION" }, 400);
  }

  const handle = String(body.sessionHandle || "");
  if (!/^[A-Za-z0-9_-]{40,64}$/u.test(handle)) {
    return json({ error: "会话句柄无效", code: "INVALID_ADMIN_SESSION_HANDLE" }, 400);
  }
  const requestKey = String(request.headers.get("idempotency-key") || "").trim();
  if (!/^[A-Za-z0-9:_-]{16,96}$/u.test(requestKey)) {
    return json({ error: "缺少有效的幂等请求标识", code: "INVALID_IDEMPOTENCY_KEY" }, 400);
  }

  const lockKey = `${authorization.actor.userId}:${requestKey}`;
  if (mutationLocks.has(lockKey)) {
    return json({ error: "相同请求正在处理，请勿重复提交", code: "ADMIN_SESSION_REQUEST_IN_FLIGHT" }, 409);
  }
  mutationLocks.add(lockKey);
  try {
    const since = new Date(Date.now() - ADMIN_ACCOUNT_SECURITY_WRITE_WINDOW_MS).toISOString();
    const [alreadyRecorded, recentCount] = await Promise.all([
      sessionMutationAlreadyRecorded(authorization.actor.userId, requestKey),
      recentSessionMutationCount(authorization.actor.userId, since),
    ]);
    if (alreadyRecorded) {
      return json({ error: "该请求已处理，未重复执行", code: "ADMIN_SESSION_REPLAY_REJECTED" }, 409);
    }
    if (recentCount >= ADMIN_ACCOUNT_SECURITY_WRITE_LIMIT) {
      return json(
        { error: "会话撤销操作过于频繁，请稍后再试", code: "ADMIN_SESSION_REVOKE_RATE_LIMITED" },
        429,
        { "Retry-After": String(Math.ceil(ADMIN_ACCOUNT_SECURITY_WRITE_WINDOW_MS / 1_000)) },
      );
    }

    const intentRecorded = await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "security.view",
      action: "admin_session_revoke_intent",
      result: "allowed",
      reasonCode: "STEP_UP_VALID",
      resource: "user_auth_sessions",
      request,
      requestKey: `${requestKey}:intent`,
      metadata: { allowCurrent: body.allowCurrent === true },
    });
    if (!intentRecorded) {
      return json({ error: "审计记录不可用，本次未执行会话撤销", code: "ADMIN_SESSION_AUDIT_UNAVAILABLE" }, 503);
    }

    let result;
    try {
      result = await revokeAdminSessionByHandle({
        actorId: authorization.actor.userId,
        currentSessionId,
        handle,
        allowCurrent: body.allowCurrent === true,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "ADMIN_SESSION_REVOKE_FAILED";
      const status = code === "ADMIN_SESSION_NOT_FOUND" ? 404 : code === "CURRENT_SESSION_CONFIRMATION_REQUIRED" ? 409 : 503;
      await appendAdminGovernanceAudit({
        actorId: authorization.actor.userId,
        actorLevel: authorization.access.adminLevel,
        permissionKey: "security.view",
        action: "admin_session_revoke",
        result: "failure",
        reasonCode: code,
        resource: "user_auth_sessions",
        request,
        requestKey,
      });
      return json({
        error: code === "ADMIN_SESSION_NOT_FOUND"
          ? "会话不存在或已超出当前可管理范围"
          : code === "CURRENT_SESSION_CONFIRMATION_REQUIRED"
            ? "退出当前设备需要再次确认"
            : "会话撤销暂不可用",
        code,
      }, status);
    }

    const auditRecorded = await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "security.view",
      action: "admin_session_revoke",
      result: "success",
      reasonCode: result.alreadyInactive ? "SESSION_ALREADY_INACTIVE" : "SESSION_REVOKED",
      resource: "user_auth_sessions",
      request,
      requestKey,
      metadata: { current: result.current, revoked: result.revoked },
    });
    invalidateActorCache(authorization.actor.userId);

    const response = json({
      success: true,
      action: "revoke_session",
      revoked: result.revoked,
      alreadyInactive: result.alreadyInactive,
      signedOut: result.current && result.revoked,
      auditRecorded,
    });
    if (result.current && result.revoked) {
      response.cookies.set("auth_token", "", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
      });
      response.cookies.set(ADMIN_STEP_UP_COOKIE, "", {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
      });
    }
    return response;
  } catch (error) {
    console.error("[admin-account-security] mutation failed", error);
    return json({ error: "会话安全操作暂不可用", code: "ADMIN_ACCOUNT_SECURITY_WRITE_UNAVAILABLE" }, 503);
  } finally {
    mutationLocks.delete(lockKey);
  }
}
