import "server-only";

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminToken, type CurrentAdminUser } from "@/lib/admin-auth";
import { getTokenFromHeaders, type JWTPayload } from "@/lib/auth";
import {
  ADMIN_PERMISSION_KEYS,
  ADMIN_STEP_UP_COOKIE,
  normalizeAdminPermissionKeys,
  type AdminLevel,
} from "@/lib/admin-governance";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export interface AdminAccessSnapshot {
  authorityStatus: "ready" | "missing" | "invalid" | "disabled" | "unavailable";
  integrityValid: boolean;
  adminLevel: AdminLevel | null;
  permissionKeys: string[];
  revision: number;
  checksum: string;
  profileActive: boolean;
  updatedAt: string | null;
}

export interface AdminStepUpSnapshot {
  status: "ready" | "missing" | "invalid" | "unavailable";
  expiresAt: string | null;
  authMethod: "login_password" | "management_password" | null;
  sessionId: string | null;
}

export interface AdminMaintenanceLockSnapshot {
  status: "ready" | "unavailable";
  enabled: boolean;
  revision: number;
  enabledBy: string | null;
  enabledAt: string | null;
  expiresAt: string | null;
  enableReason: string;
  disabledBy: string | null;
  disabledAt: string | null;
  disableReason: string;
  maxDurationMinutes: number;
  updatedAt: string | null;
}

export type AdminCapabilityResult =
  | {
      ok: true;
      actor: JWTPayload;
      user: CurrentAdminUser;
      access: AdminAccessSnapshot;
      stepUp: AdminStepUpSnapshot | null;
      maintenanceLock: AdminMaintenanceLockSnapshot | null;
    }
  | { ok: false; response: NextResponse };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requestIp(request: NextRequest): string {
  return text(request.headers.get("x-forwarded-for")).split(",")[0].trim()
    || text(request.headers.get("x-real-ip"))
    || "unknown";
}

function privilegedDenialDetails(access: AdminAccessSnapshot, permissionKey: string) {
  return access.adminLevel === "super_admin" ? { requiredPermission: permissionKey } : {};
}

export function hashAdminStepUpToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function getAdminStepUpToken(request: NextRequest): string {
  return request.cookies.get(ADMIN_STEP_UP_COOKIE)?.value
    || request.headers.get("x-admin-step-up")
    || "";
}

export async function readAdminAccessSnapshot(userId: string): Promise<AdminAccessSnapshot> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("read_admin_access_snapshot", {
      p_user_id: userId,
    });
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    const status = text(row.authority_status);
    return {
      authorityStatus: status === "ready" || status === "missing" || status === "invalid" || status === "disabled"
        ? status
        : "unavailable",
      integrityValid: row.integrity_valid === true,
      adminLevel: row.admin_level === "super_admin" || row.admin_level === "admin" ? row.admin_level : null,
      permissionKeys: normalizeAdminPermissionKeys(row.permission_keys),
      revision: Number(row.revision || 0),
      checksum: text(row.checksum),
      profileActive: row.profile_active === true,
      updatedAt: text(row.updated_at) || null,
    };
  } catch (error) {
    console.error("[admin-governance] access snapshot unavailable", error);
    return {
      authorityStatus: "unavailable",
      integrityValid: false,
      adminLevel: null,
      permissionKeys: [],
      revision: 0,
      checksum: "",
      profileActive: false,
      updatedAt: null,
    };
  }
}

export async function readAdminStepUpSnapshot(
  request: NextRequest,
  actorId: string,
  permissionKey: string,
): Promise<AdminStepUpSnapshot> {
  const token = getAdminStepUpToken(request);
  if (!token) return { status: "missing", expiresAt: null, authMethod: null, sessionId: null };
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("read_admin_step_up_session", {
      p_actor_id: actorId,
      p_token_hash: hashAdminStepUpToken(token),
      p_permission_key: permissionKey,
    });
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    const status = text(row.status);
    return {
      status: status === "ready" || status === "missing" || status === "invalid" ? status : "unavailable",
      expiresAt: text(row.expires_at) || null,
      authMethod: row.auth_method === "login_password" || row.auth_method === "management_password" ? row.auth_method : null,
      sessionId: text(row.session_id) || null,
    };
  } catch (error) {
    console.error("[admin-governance] step-up snapshot unavailable", error);
    return { status: "unavailable", expiresAt: null, authMethod: null, sessionId: null };
  }
}

export async function readAdminMaintenanceLockSnapshot(): Promise<AdminMaintenanceLockSnapshot> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("read_admin_step_up_maintenance_lock");
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    return {
      status: row.status === "ready" ? "ready" : "unavailable",
      enabled: row.status === "ready" && row.enabled === true,
      revision: Number(row.revision || 0),
      enabledBy: text(row.enabled_by) || null,
      enabledAt: text(row.enabled_at) || null,
      expiresAt: text(row.expires_at) || null,
      enableReason: text(row.enable_reason),
      disabledBy: text(row.disabled_by) || null,
      disabledAt: text(row.disabled_at) || null,
      disableReason: text(row.disable_reason),
      maxDurationMinutes: Math.min(30, Math.max(1, Number(row.max_duration_minutes || 30))),
      updatedAt: text(row.updated_at) || null,
    };
  } catch (error) {
    console.error("[admin-governance] maintenance lock unavailable", error);
    return {
      status: "unavailable",
      enabled: false,
      revision: 0,
      enabledBy: null,
      enabledAt: null,
      expiresAt: null,
      enableReason: "",
      disabledBy: null,
      disabledAt: null,
      disableReason: "",
      maxDurationMinutes: 30,
      updatedAt: null,
    };
  }
}

export async function appendAdminGovernanceAudit(params: {
  actorId?: string | null;
  actorLevel?: string | null;
  targetUserId?: string | null;
  permissionKey?: string | null;
  action: string;
  result: "allowed" | "denied" | "success" | "failure";
  reasonCode?: string;
  resource?: string;
  request?: NextRequest;
  requestKey?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const request = params.request;
    const { error } = await getSupabaseAdminClient().rpc("append_admin_governance_audit", {
      p_actor_id: params.actorId || "",
      p_actor_level: params.actorLevel || "",
      p_target_user_id: params.targetUserId || "",
      p_permission_key: params.permissionKey || "",
      p_action: params.action,
      p_result: params.result,
      p_reason_code: params.reasonCode || "",
      p_resource: params.resource || "",
      p_request_path: request?.nextUrl.pathname || "",
      p_request_method: request?.method || "",
      p_request_key: params.requestKey || "",
      p_request_ip: request ? requestIp(request) : "",
      p_user_agent: request?.headers.get("user-agent") || "",
      p_metadata: params.metadata || {},
    });
    if (error) throw error;
    return true;
  } catch (error) {
    // Audit failure must never grant access. Callers use this only after their
    // authority decision; failure is surfaced in server logs for operations.
    console.error("[admin-governance] audit append failed", error);
    return false;
  }
}

export async function authorizeAdminCapability(
  request: NextRequest,
  permissionKey: string,
  options: { requireStepUp?: boolean; operation?: string; auditAllowed?: boolean } = {},
): Promise<AdminCapabilityResult> {
  const token = getTokenFromHeaders(request.headers);
  const admin = await authorizeAdminToken(token);
  if (!admin.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: admin.error, code: admin.code }, { status: admin.status }),
    };
  }

  const access = await readAdminAccessSnapshot(admin.actor.userId);
  if (access.authorityStatus !== "ready" || !access.integrityValid) {
    await appendAdminGovernanceAudit({
      actorId: admin.actor.userId,
      actorLevel: access.adminLevel,
      permissionKey,
      action: options.operation || "admin_capability_check",
      result: "denied",
      reasonCode: `AUTHORITY_${access.authorityStatus.toUpperCase()}`,
      resource: request.nextUrl.pathname,
      request,
    });
    return {
      ok: false,
      response: NextResponse.json(
        { error: "后台授权档案不可用或完整性校验失败，本次操作未放行", code: "ADMIN_AUTHORITY_NOT_READY" },
        { status: 503 },
      ),
    };
  }

  if (!ADMIN_PERMISSION_KEYS.includes(permissionKey) || !access.permissionKeys.includes(permissionKey)) {
    await appendAdminGovernanceAudit({
      actorId: admin.actor.userId,
      actorLevel: access.adminLevel,
      permissionKey,
      action: options.operation || "admin_capability_check",
      result: "denied",
      reasonCode: "ADMIN_PERMISSION_DENIED",
      resource: request.nextUrl.pathname,
      request,
    });
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "当前管理员未获此项后台权限",
          code: "ADMIN_PERMISSION_DENIED",
          ...privilegedDenialDetails(access, permissionKey),
        },
        { status: 403 },
      ),
    };
  }

  let stepUp: AdminStepUpSnapshot | null = null;
  let maintenanceLock: AdminMaintenanceLockSnapshot | null = null;
  if (options.requireStepUp) {
    maintenanceLock = await readAdminMaintenanceLockSnapshot();
    if (!maintenanceLock.enabled) {
      stepUp = await readAdminStepUpSnapshot(request, admin.actor.userId, permissionKey);
    }
    if (!maintenanceLock.enabled && stepUp?.status !== "ready") {
      await appendAdminGovernanceAudit({
        actorId: admin.actor.userId,
        actorLevel: access.adminLevel,
        permissionKey,
        action: options.operation || "admin_sensitive_operation",
        result: "denied",
        reasonCode: stepUp?.status === "unavailable" ? "ADMIN_STEP_UP_UNAVAILABLE" : "ADMIN_STEP_UP_REQUIRED",
        resource: request.nextUrl.pathname,
        request,
      });
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: stepUp?.status === "unavailable" ? "敏感操作解锁校验暂不可用" : "该操作需要重新验证管理员密码",
            code: stepUp?.status === "unavailable" ? "ADMIN_STEP_UP_UNAVAILABLE" : "ADMIN_STEP_UP_REQUIRED",
            ...privilegedDenialDetails(access, permissionKey),
          },
          { status: stepUp?.status === "unavailable" ? 503 : 428 },
        ),
      };
    }
  }

  if (options.auditAllowed || options.requireStepUp) {
    await appendAdminGovernanceAudit({
      actorId: admin.actor.userId,
      actorLevel: access.adminLevel,
      permissionKey,
      action: options.operation || "admin_capability_check",
      result: "allowed",
      reasonCode: options.requireStepUp
        ? maintenanceLock?.enabled ? "MAINTENANCE_STEP_UP_BYPASS" : "STEP_UP_VALID"
        : "PERMISSION_VALID",
      resource: request.nextUrl.pathname,
      request,
      metadata: maintenanceLock?.enabled
        ? { maintenanceRevision: maintenanceLock.revision, maintenanceExpiresAt: maintenanceLock.expiresAt }
        : {},
    });
  }

  return { ok: true, actor: admin.actor, user: admin.user, access, stepUp, maintenanceLock };
}
