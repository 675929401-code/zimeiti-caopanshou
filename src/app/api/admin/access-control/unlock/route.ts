import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getTokenFromHeaders, verifyPassword } from "@/lib/auth";
import {
  ADMIN_STEP_UP_COOKIE,
} from "@/lib/admin-governance";
import {
  ADMIN_STEP_UP_RATE_LIMIT,
  normalizeAdminStepUpDurationMinutes,
} from "@/lib/admin-step-up-contract";
import {
  appendAdminGovernanceAudit,
  getAdminStepUpToken,
  hashAdminStepUpToken,
  readAdminAccessSnapshot,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

function responseWithClearedCookie(payload: Record<string, unknown>, status = 200) {
  const response = NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
  response.cookies.set(ADMIN_STEP_UP_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });
  }
  const access = await readAdminAccessSnapshot(authorization.actor.userId);
  if (access.authorityStatus !== "ready" || !access.integrityValid) {
    return NextResponse.json({ error: "后台授权档案不可用", code: "ADMIN_AUTHORITY_NOT_READY" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({})) as { password?: string; mode?: "auto" | "login" | "management"; durationMinutes?: number };
  const password = String(body.password || "");
  const mode = body.mode === "login" || body.mode === "management" ? body.mode : "auto";
  const durationMinutes = normalizeAdminStepUpDurationMinutes(body.durationMinutes);
  const ttlSeconds = durationMinutes * 60;
  const managementPasswordAllowed = access.adminLevel === "super_admin";
  if (!password) return NextResponse.json({ error: "请输入管理员密码" }, { status: 400 });
  if (mode === "management" && !managementPasswordAllowed) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: access.adminLevel,
      action: "admin_step_up_unlock",
      result: "denied",
      reasonCode: "ADMIN_STEP_UP_METHOD_FORBIDDEN",
      resource: "admin_console",
      request,
      metadata: { requestedMode: "management" },
    });
    return NextResponse.json({
      error: "当前管理员不能使用此验证方式",
      code: "ADMIN_STEP_UP_METHOD_FORBIDDEN",
    }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const client = getSupabaseAdminClient();
  const rateLimitScope = crypto.createHash("sha256")
    .update(`admin-step-up:${authorization.actor.userId}`)
    .digest("hex");
  const { data: atomicRateLimit, error: atomicRateLimitError } = await client.rpc("consume_security_rate_limit_atomic", {
    p_scope_hash: rateLimitScope,
    p_route_key: ADMIN_STEP_UP_RATE_LIMIT.routeKey,
    p_window_seconds: ADMIN_STEP_UP_RATE_LIMIT.windowSeconds,
    p_request_limit: ADMIN_STEP_UP_RATE_LIMIT.attemptLimit,
    p_cost: 1,
  });
  if (atomicRateLimitError || atomicRateLimit?.success !== true || typeof atomicRateLimit.allowed !== "boolean") {
    console.error("[admin-governance] atomic step-up rate limit unavailable", {
      code: atomicRateLimitError?.code || atomicRateLimit?.code || "INVALID_RESULT",
    });
    return NextResponse.json({
      error: "敏感操作验证暂不可用，请稍后重试",
      code: "ADMIN_STEP_UP_RATE_LIMIT_UNAVAILABLE",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!atomicRateLimit.allowed) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: access.adminLevel,
      action: "admin_step_up_unlock",
      result: "denied",
      reasonCode: "ADMIN_STEP_UP_RATE_LIMITED",
      resource: "admin_console",
      request,
      metadata: { limiter: "atomic_fixed_window" },
    });
    return NextResponse.json({ error: "密码验证尝试次数过多，请 15 分钟后再试", code: "ADMIN_STEP_UP_RATE_LIMITED" }, { status: 429 });
  }

  const failureWindow = new Date(Date.now() - ADMIN_STEP_UP_RATE_LIMIT.windowSeconds * 1000).toISOString();
  const { count: recentFailures, error: recentFailuresError } = await client
    .from("admin_governance_audit")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", authorization.actor.userId)
    .eq("action", "admin_step_up_unlock")
    .eq("result", "failure")
    .gte("created_at", failureWindow);
  if (recentFailuresError) {
    console.error("[admin-governance] step-up failure count unavailable", {
      code: recentFailuresError.code || "UNKNOWN",
    });
    return NextResponse.json({
      error: "敏感操作验证暂不可用，请稍后重试",
      code: "ADMIN_STEP_UP_RATE_LIMIT_UNAVAILABLE",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (Number(recentFailures || 0) >= ADMIN_STEP_UP_RATE_LIMIT.attemptLimit) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: access.adminLevel,
      action: "admin_step_up_unlock",
      result: "denied",
      reasonCode: "ADMIN_STEP_UP_RATE_LIMITED",
      resource: "admin_console",
      request,
    });
    return NextResponse.json({ error: "密码验证失败次数过多，请 15 分钟后再试", code: "ADMIN_STEP_UP_RATE_LIMITED" }, { status: 429 });
  }

  const { data: user } = await client.from("users").select("password_hash").eq("id", authorization.actor.userId).maybeSingle();
  let operationRows: Array<{ setting_key: string; setting_value: string | null }> = [];
  if (managementPasswordAllowed) {
    const { data } = await client
      .from("platform_settings")
      .select("setting_key,setting_value")
      .in("setting_key", ["operation_password", "operation_password_hash"]);
    operationRows = (data || []) as Array<{ setting_key: string; setting_value: string | null }>;
  }
  const operationHash = (operationRows || []).find((row: { setting_key: string; setting_value: string | null }) => row.setting_key === "operation_password" && row.setting_value)?.setting_value
    || (operationRows || []).find((row: { setting_key: string; setting_value: string | null }) => row.setting_key === "operation_password_hash" && row.setting_value)?.setting_value
    || "";

  let authMethod: "login_password" | "management_password" | null = null;
  if (managementPasswordAllowed && mode !== "login" && operationHash && await verifyPassword(password, operationHash)) authMethod = "management_password";
  if (!authMethod && mode !== "management" && user?.password_hash && await verifyPassword(password, user.password_hash)) authMethod = "login_password";

  if (!authMethod) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: access.adminLevel,
      action: "admin_step_up_unlock",
      result: "failure",
      reasonCode: "ADMIN_PASSWORD_INVALID",
      resource: "admin_console",
      request,
      metadata: { mode },
    });
    return NextResponse.json({ error: mode === "management" ? "管理密码错误" : "管理员密码错误", code: "ADMIN_PASSWORD_INVALID" }, { status: 401 });
  }

  const rawToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { data, error } = await client.rpc("create_admin_step_up_session", {
    p_actor_id: authorization.actor.userId,
    p_token_hash: hashAdminStepUpToken(rawToken),
    p_scope_keys: access.permissionKeys,
    p_profile_revision: access.revision,
    p_auth_method: authMethod,
    p_request_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    p_user_agent: request.headers.get("user-agent") || "",
    p_expires_at: expiresAt,
  });
  if (error || !data?.success) {
    return NextResponse.json({ error: "敏感操作解锁失败", code: data?.code || "ADMIN_STEP_UP_CREATE_FAILED" }, { status: 503 });
  }

  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: access.adminLevel,
    action: "admin_step_up_unlock",
    result: "success",
    reasonCode: authMethod,
    resource: "admin_console",
    request,
    metadata: { expiresAt, durationMinutes, scopeCount: access.permissionKeys.length },
  });

  const response = NextResponse.json({ success: true, expiresAt, authMethod, durationMinutes }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(ADMIN_STEP_UP_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSeconds,
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
  if (!authorization.ok) return responseWithClearedCookie({ success: true });
  const rawToken = getAdminStepUpToken(request);
  const { data: revokedCount, error: revokeError } = await getSupabaseAdminClient().rpc("revoke_admin_step_up_sessions", {
    p_actor_id: authorization.actor.userId,
    p_token_hash: rawToken ? hashAdminStepUpToken(rawToken) : null,
  });
  if (revokeError) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      action: "admin_step_up_lock",
      result: "failure",
      reasonCode: "ADMIN_STEP_UP_REVOKE_FAILED",
      resource: "admin_console",
      request,
    });
    return responseWithClearedCookie({
      success: false,
      error: "浏览器令牌已清除，但服务端解锁会话撤销未完成，请勿继续敏感操作并联系平台所有者",
      code: "ADMIN_STEP_UP_REVOKE_FAILED",
    }, 503);
  }
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    action: "admin_step_up_lock",
    result: "success",
    resource: "admin_console",
    request,
  });
  return responseWithClearedCookie({ success: true, revokedCount: Number(revokedCount || 0) });
}
