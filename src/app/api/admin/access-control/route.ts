import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminPasswordError } from "@/lib/admin-password-policy";
import { hashPassword, logPasswordAudit } from "@/lib/auth";
import {
  ADMIN_PERMISSION_CATALOG,
  normalizeAdminPermissionKeys,
} from "@/lib/admin-governance";
import {
  normalizeDelegableAdminPermissionKeys,
  ownerOnlyAdminPermissionKeys,
} from "@/lib/admin-permission-design";
import { summarizeAdminPermissionCatalogCoverage } from "@/lib/admin-permission-catalog-coverage";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

function requestKey(request: NextRequest): string {
  return request.headers.get("idempotency-key")?.trim() || crypto.randomUUID();
}

async function requireSuperAdmin(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "admin.accounts.manage", {
    requireStepUp: true,
    operation: "super_admin_control_plane",
  });
  if (!authorization.ok) return authorization;
  if (authorization.access.adminLevel !== "super_admin") {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "仅超级管理员可以进入此页面", code: "SUPER_ADMIN_REQUIRED" }, { status: 403 }),
    };
  }
  return authorization;
}

export async function GET(request: NextRequest) {
  const authorization = await requireSuperAdmin(request);
  if (!authorization.ok) return authorization.response;
  const client = getSupabaseAdminClient();
  const [
    { data: profiles, error: profileError },
    { data: audits, error: auditError },
    { data: health, error: healthError },
    { data: candidateUsers, error: candidateError },
    { data: databaseCatalog, error: catalogError },
  ] = await Promise.all([
    client.from("admin_access_profiles").select("user_id,admin_level,permission_keys,revision,checksum,is_active,created_at,updated_at,created_by,updated_by").order("created_at", { ascending: true }),
    client.from("admin_governance_audit").select("id,actor_id,actor_level,target_user_id,permission_key,action,result,reason_code,resource,request_path,request_method,request_ip,metadata,created_at").order("created_at", { ascending: false }).limit(120),
    client.rpc("admin_governance_health"),
    client
      .from("users")
      .select("id,username,display_name,phone,email,role,is_active,status,member_status,last_sign_in_at,created_at,password_hash")
      .neq("role", "admin")
      .order("created_at", { ascending: false })
      .limit(300),
    client
      .from("admin_permission_catalog")
      .select("permission_key,group_key,label,description,risk_level,step_up_required,sort_order,is_active,is_delegable,dependency_keys")
      .order("sort_order", { ascending: true }),
  ]);
  if (profileError || auditError || healthError || candidateError || catalogError) {
    return NextResponse.json({ error: "超级管理员数据读取失败", code: "ADMIN_GOVERNANCE_READ_FAILED" }, { status: 500 });
  }
  const userIds = (profiles || []).map((profile: { user_id: string }) => profile.user_id);
  const { data: users, error: userError } = userIds.length > 0
    ? await client.from("users").select("id,username,display_name,phone,email,role,is_active,status,last_sign_in_at,created_at").in("id", userIds)
    : { data: [], error: null };
  if (userError) return NextResponse.json({ error: "管理员账号读取失败" }, { status: 500 });
  const usersById = new Map((users || []).map((user: { id: string }) => [user.id, user]));
  const administrators = (profiles || []).map((profile: {
    user_id: string;
    admin_level?: string;
    permission_keys?: unknown;
    [key: string]: unknown;
  }) => ({
    ...profile,
    user: usersById.get(profile.user_id) || null,
    permission_keys: profile.admin_level === "super_admin"
      ? normalizeAdminPermissionKeys(profile.permission_keys)
      : normalizeDelegableAdminPermissionKeys(profile.permission_keys),
  }));
  const candidates = (candidateUsers || []).map((user: {
    id: string;
    username?: string | null;
    display_name?: string | null;
    phone?: string | null;
    email?: string | null;
    role?: string | null;
    is_active?: boolean | null;
    status?: string | null;
    member_status?: string | null;
    last_sign_in_at?: string | null;
    created_at?: string | null;
    password_hash?: string | null;
  }) => ({
    id: user.id,
    username: user.username || "",
    display_name: user.display_name || "",
    phone: user.phone || null,
    email: user.email || null,
    role: user.role || "student",
    is_active: user.is_active === true,
    status: user.status || "active",
    member_status: user.member_status || "inactive",
    last_sign_in_at: user.last_sign_in_at || null,
    created_at: user.created_at || null,
    has_password: Boolean(user.password_hash?.trim()),
    eligible: user.is_active === true && (user.status || "active") === "active" && Boolean(user.password_hash?.trim()),
  }));
  const catalogCoverage = summarizeAdminPermissionCatalogCoverage(databaseCatalog || []);
  return NextResponse.json({
    administrators,
    candidates,
    audit: audits || [],
    health: health || null,
    catalog: ADMIN_PERMISSION_CATALOG,
    catalogCoverage,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authorization = await requireSuperAdmin(request);
  if (!authorization.ok) return authorization.response;
  const body = await request.json().catch(() => ({})) as {
    mode?: "create" | "promote";
    existingUserId?: string;
    username?: string;
    password?: string;
    displayName?: string;
    phone?: string;
    email?: string;
    permissionKeys?: unknown;
  };
  const mode = body.mode === "promote" ? "promote" : "create";
  if (ownerOnlyAdminPermissionKeys(body.permissionKeys).length > 0) {
    return NextResponse.json(
      { error: "所有者权限不能委派给普通管理员", code: "OWNER_PERMISSION_NOT_DELEGABLE" },
      { status: 400 },
    );
  }
  const delegatedPermissionKeys = normalizeDelegableAdminPermissionKeys(body.permissionKeys);
  if (mode === "promote") {
    const existingUserId = String(body.existingUserId || "").trim();
    if (!existingUserId) return NextResponse.json({ error: "请选择已注册会员" }, { status: 400 });
    const { data, error } = await getSupabaseAdminClient().rpc("promote_existing_member_to_admin_atomic", {
      p_actor_id: authorization.actor.userId,
      p_target_user_id: existingUserId,
      p_permission_keys: delegatedPermissionKeys,
      p_request_key: requestKey(request),
    });
    if (error || !data?.success) {
      const code = data?.code || "ADMIN_ACCOUNT_PROMOTE_FAILED";
      const responseByCode: Record<string, { status: number; error: string }> = {
        TARGET_USER_REQUIRED: { status: 400, error: "请选择已注册会员" },
        TARGET_USER_NOT_FOUND: { status: 404, error: "该会员不存在，请刷新后重试" },
        TARGET_ALREADY_ADMIN: { status: 409, error: "该账号已经是管理员" },
        TARGET_ACCOUNT_NOT_ACTIVE: { status: 400, error: "停用或异常账号不能授权为管理员" },
        TARGET_LOGIN_PASSWORD_REQUIRED: { status: 400, error: "该会员尚未设置登录密码，请先在学员档案中补齐密码" },
      };
      const mapped = responseByCode[code] || { status: 500, error: "管理员授权失败" };
      return NextResponse.json({ error: mapped.error, code }, { status: mapped.status });
    }
    return NextResponse.json({ success: true, promoted: true, userId: data.user_id, revision: data.revision });
  }
  const username = String(body.username || body.phone || body.email || "").trim();
  const displayName = String(body.displayName || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  if (!username || !displayName) return NextResponse.json({ error: "请填写管理员登录账号和姓名" }, { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
  if (phone && !/^1\d{10}$/u.test(phone)) return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
  const passwordError = adminPasswordError(body.password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

  const passwordHash = await hashPassword(String(body.password));
  const key = requestKey(request);
  const { data, error } = await getSupabaseAdminClient().rpc("create_admin_account_atomic", {
    p_actor_id: authorization.actor.userId,
    p_username: username,
    p_password_hash: passwordHash,
    p_display_name: displayName,
    p_phone: phone,
    p_email: email,
    p_permission_keys: delegatedPermissionKeys,
    p_request_key: key,
  });
  if (error || !data?.success) {
    const code = data?.code || "ADMIN_ACCOUNT_CREATE_FAILED";
    return NextResponse.json({ error: code === "ADMIN_ACCOUNT_ALREADY_EXISTS" ? "登录账号、手机号或邮箱已存在" : "管理员创建失败", code }, { status: code === "ADMIN_ACCOUNT_ALREADY_EXISTS" ? 409 : 500 });
  }
  await logPasswordAudit({
    userId: data.user_id,
    action: "admin_create",
    performedById: authorization.actor.userId,
    performedByRole: "super_admin",
    performedByName: authorization.user.display_name || authorization.user.username || "超级管理员",
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: request.headers.get("user-agent") || undefined,
    details: "由超级管理员控制台创建后台管理员；密码内容未写入审计日志",
  });
  return NextResponse.json({ success: true, userId: data.user_id, revision: data.revision });
}

export async function PATCH(request: NextRequest) {
  const authorization = await requireSuperAdmin(request);
  if (!authorization.ok) return authorization.response;
  const body = await request.json().catch(() => ({})) as {
    action?: "permissions" | "account";
    userId?: string;
    permissionKeys?: unknown;
    isActive?: boolean;
    expectedRevision?: number;
    reason?: string;
    displayName?: string;
    phone?: string;
    email?: string;
    newPassword?: string;
  };
  const userId = String(body.userId || "");
  if (!userId) return NextResponse.json({ error: "缺少管理员账号" }, { status: 400 });
  const client = getSupabaseAdminClient();
  const key = requestKey(request);

  if (body.action === "permissions") {
    if (ownerOnlyAdminPermissionKeys(body.permissionKeys).length > 0) {
      return NextResponse.json(
        { error: "所有者权限不能委派给普通管理员", code: "OWNER_PERMISSION_NOT_DELEGABLE" },
        { status: 400 },
      );
    }
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return NextResponse.json({ error: "授权版本无效，请刷新后重试" }, { status: 409 });
    const { data, error } = await client.rpc("set_admin_access_profile_atomic", {
      p_actor_id: authorization.actor.userId,
      p_target_user_id: userId,
      p_permission_keys: normalizeDelegableAdminPermissionKeys(body.permissionKeys),
      p_is_active: body.isActive !== false,
      p_expected_revision: expectedRevision,
      p_request_key: key,
      p_reason: String(body.reason || "超级管理员调整后台授权").slice(0, 500),
    });
    if (error || !data?.success) {
      const code = data?.code || "ADMIN_PERMISSION_UPDATE_FAILED";
      const status = code === "ADMIN_PROFILE_REVISION_CONFLICT" ? 409 : code === "SUPER_ADMIN_PROFILE_IMMUTABLE" ? 400 : 500;
      return NextResponse.json({ error: code === "ADMIN_PROFILE_REVISION_CONFLICT" ? "权限已被其他窗口更新，请刷新后重试" : "管理员权限保存失败", code, revision: data?.revision }, { status });
    }
    return NextResponse.json({ success: true, profile: data });
  }

  if (body.action === "account") {
    const { data: profile } = await client.from("admin_access_profiles").select("admin_level").eq("user_id", userId).maybeSingle();
    if (!profile) return NextResponse.json({ error: "管理员账号不存在" }, { status: 404 });
    if (profile.admin_level === "super_admin" && userId !== authorization.actor.userId) {
      return NextResponse.json({ error: "不能修改其他超级管理员" }, { status: 403 });
    }
    const { data: target } = await client.from("users").select("id,username,phone,email,display_name").eq("id", userId).maybeSingle();
    if (!target) return NextResponse.json({ error: "管理员账号不存在" }, { status: 404 });

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName) return NextResponse.json({ error: "管理员姓名不能为空" }, { status: 400 });
      updates.display_name = displayName;
    }
    if (body.phone !== undefined) {
      const phone = body.phone.trim();
      if (phone && !/^1\d{10}$/u.test(phone)) return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
      if (phone !== String(target.phone || "").trim()) {
        return NextResponse.json({
          error: "更换手机号必须由账号本人验证当前QQ安全邮箱，超级管理也不能绕过",
          code: "PHONE_CHANGE_REQUIRES_EMAIL_VERIFICATION",
        }, { status: 409 });
      }
    }
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      const currentEmail = String(target.email || '').trim().toLowerCase();
      if (email !== currentEmail) {
        return NextResponse.json({
          error: "安全邮箱是永久身份凭据，后台不能改写",
          code: "EMAIL_IMMUTABLE",
        }, { status: 409 });
      }
    }
    let passwordChanged = false;
    if (body.newPassword) {
      const passwordError = adminPasswordError(body.newPassword);
      if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
      updates.password_hash = await hashPassword(body.newPassword);
      updates.session_id = null;
      passwordChanged = true;
    }
    const { error: updateError } = await client.from("users").update(updates).eq("id", userId);
    if (updateError) return NextResponse.json({ error: "管理员资料保存失败", code: updateError.code }, { status: updateError.code === "23505" ? 409 : 500 });
    if (passwordChanged) {
      await client.from("user_auth_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "super_admin_password_change" }).eq("user_id", userId).is("revoked_at", null);
      await client.rpc("revoke_admin_step_up_sessions", { p_actor_id: userId, p_token_hash: null });
      await logPasswordAudit({
        userId,
        action: userId === authorization.actor.userId ? "self_change" : "admin_reset",
        performedById: authorization.actor.userId,
        performedByRole: "super_admin",
        performedByName: authorization.user.display_name || authorization.user.username || "超级管理员",
        ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
        userAgent: request.headers.get("user-agent") || undefined,
        details: "超级管理员控制台修改管理员密码并撤销既有登录与敏感操作会话",
      });
    }
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: "super_admin",
      targetUserId: userId,
      permissionKey: "admin.accounts.manage",
      action: "admin_account_update",
      result: "success",
      resource: "admin_account",
      request,
      requestKey: key,
      metadata: {
        displayNameChanged: body.displayName !== undefined,
        phoneChanged: body.phone !== undefined,
        emailChanged: false,
        passwordChanged,
      },
    });
    return NextResponse.json({ success: true, reauthRequired: passwordChanged && userId === authorization.actor.userId });
  }

  return NextResponse.json({ error: "未知的管理员操作" }, { status: 400 });
}
