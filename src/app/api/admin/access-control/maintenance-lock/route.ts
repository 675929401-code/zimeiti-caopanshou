import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  authorizeAdminCapability,
  getAdminStepUpToken,
  hashAdminStepUpToken,
  readAdminMaintenanceLockSnapshot,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const NO_STORE = { "Cache-Control": "no-store" };

function requestIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

async function requireSuperAdmin(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "admin.accounts.manage", {
    requireStepUp: false,
    operation: "admin_step_up_maintenance_access",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization;
  if (authorization.access.adminLevel !== "super_admin") {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "只有超级管理员可以维护二次验证锁", code: "SUPER_ADMIN_REQUIRED" },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  return authorization;
}

export async function GET(request: NextRequest) {
  const authorization = await requireSuperAdmin(request);
  if (!authorization.ok) return authorization.response;
  const state = await readAdminMaintenanceLockSnapshot();
  if (state.status !== "ready") {
    return NextResponse.json(
      { error: "维护模式状态暂不可用", code: "MAINTENANCE_STATE_UNAVAILABLE" },
      { status: 503, headers: NO_STORE },
    );
  }
  return NextResponse.json({ state }, { headers: NO_STORE });
}

export async function PATCH(request: NextRequest) {
  const authorization = await requireSuperAdmin(request);
  if (!authorization.ok) return authorization.response;

  const body = await request.json().catch(() => ({})) as {
    enabled?: boolean;
    reason?: string;
    durationMinutes?: number;
    expectedRevision?: number;
  };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "缺少维护模式目标状态", code: "MAINTENANCE_TARGET_REQUIRED" },
      { status: 400, headers: NO_STORE },
    );
  }
  const reason = String(body.reason || "").trim();
  if (reason.length < 3 || reason.length > 300) {
    return NextResponse.json(
      { error: "请填写 3 至 300 字的维护原因", code: "MAINTENANCE_REASON_REQUIRED" },
      { status: 400, headers: NO_STORE },
    );
  }
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return NextResponse.json(
      { error: "维护模式状态已过期，请刷新后重试", code: "MAINTENANCE_REVISION_REQUIRED" },
      { status: 409, headers: NO_STORE },
    );
  }
  const durationMinutes = body.enabled ? Number(body.durationMinutes || 30) : 30;
  if (body.enabled && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 30)) {
    return NextResponse.json(
      { error: "维护模式只能开启 1 至 30 分钟", code: "MAINTENANCE_DURATION_INVALID" },
      { status: 400, headers: NO_STORE },
    );
  }

  const rawStepUpToken = getAdminStepUpToken(request);
  const requestKey = request.headers.get("idempotency-key")?.trim() || crypto.randomUUID();
  const { data, error } = await getSupabaseAdminClient().rpc("set_admin_step_up_maintenance_lock", {
    p_actor_id: authorization.actor.userId,
    p_enable: body.enabled,
    p_reason: reason,
    p_duration_minutes: durationMinutes,
    p_expected_revision: expectedRevision,
    p_step_up_token_hash: rawStepUpToken ? hashAdminStepUpToken(rawStepUpToken) : "",
    p_request_key: requestKey,
    p_request_path: request.nextUrl.pathname,
    p_request_method: request.method,
    p_request_ip: requestIp(request),
    p_user_agent: request.headers.get("user-agent") || "",
  });
  if (error) {
    console.error("[admin-governance] maintenance lock update failed", error);
    return NextResponse.json(
      { error: "维护模式状态更新失败", code: "MAINTENANCE_UPDATE_FAILED" },
      { status: 503, headers: NO_STORE },
    );
  }

  const result = (data || {}) as { success?: boolean; code?: string; state?: Record<string, unknown>; revision?: number };
  if (!result.success) {
    const status = result.code === "ADMIN_STEP_UP_REQUIRED" ? 428
      : result.code === "SUPER_ADMIN_REQUIRED" ? 403
      : result.code === "MAINTENANCE_REVISION_CONFLICT" ? 409
      : result.code === "MAINTENANCE_DURATION_INVALID" || result.code === "MAINTENANCE_REASON_REQUIRED" ? 400
      : 503;
    const message = result.code === "ADMIN_STEP_UP_REQUIRED" ? "首次开启维护模式仍需当前有效的二次验证"
      : result.code === "MAINTENANCE_REVISION_CONFLICT" ? "维护模式状态已变化，请刷新后重试"
      : result.code === "SUPER_ADMIN_REQUIRED" ? "只有超级管理员可以切换维护模式"
      : "维护模式状态更新失败";
    return NextResponse.json(
      { error: message, code: result.code || "MAINTENANCE_UPDATE_FAILED", revision: result.revision },
      { status, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    { success: true, code: result.code, state: result.state },
    { headers: NO_STORE },
  );
}

export const POST = PATCH;
