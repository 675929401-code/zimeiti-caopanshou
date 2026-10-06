import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  createAdminCamiAssignmentReauth,
  createAdminUserAccountReauth,
  createAdminUserDeleteReauth,
} from "@/lib/admin-user-delete-reauth";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const SENSITIVE_PURPOSE_CAPABILITIES = {
  admin_user_delete: "members.delete",
  admin_user_account_recovery: "members.manage",
  admin_cami_assignment: "cards.manage",
} as const;

// 验证管理员操作密码
// 优先检查平台操作密码；兼容旧版 operation_password_hash 键，未设置时回退到管理员登录密码
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
    }

    const { password, purpose } = await request.json() as {
      password?: string;
      purpose?: string;
    };
    if (!password) {
      return NextResponse.json({ error: "请输入密码" }, { status: 400 });
    }

    const sensitivePermission = purpose && purpose in SENSITIVE_PURPOSE_CAPABILITIES
      ? SENSITIVE_PURPOSE_CAPABILITIES[purpose as keyof typeof SENSITIVE_PURPOSE_CAPABILITIES]
      : null;
    if (sensitivePermission) {
      // This endpoint mints a purpose-bound re-authentication proof. The final
      // admin mutation still enforces the same capability and step-up gate;
      // reject unprivileged administrators before reading either password hash.
      const capability = await authorizeAdminCapability(request, sensitivePermission, {
        operation: `admin_reauth_${purpose}`,
      });
      if (!capability.ok) return capability.response;
    }

    const supabase = getSupabaseClient();

    // 优先检查平台操作密码
    const { data: operationPasswordRows, error: operationPasswordError } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["operation_password_hash", "operation_password"]);
    if (operationPasswordError) throw operationPasswordError;
    const typedOperationPasswordRows = operationPasswordRows as Array<{
      setting_key: string;
      setting_value: string | null;
    }> | null;
    const opSetting = typedOperationPasswordRows?.find(
      (row) => row.setting_key === "operation_password" && Boolean(row.setting_value),
    ) || typedOperationPasswordRows?.find(
      (row) => row.setting_key === "operation_password_hash" && Boolean(row.setting_value),
    );

    if (opSetting?.setting_value && await verifyPassword(password, opSetting.setting_value)) {
      // 管理密码验证成功。若输入的不是管理密码，仍继续尝试当前管理员
      // 自己的登录密码，避免设置管理密码后反而禁用个人密码确认。
      if (purpose === "admin_user_delete") {
        const deletionVerification = await createAdminUserDeleteReauth(payload);
        return NextResponse.json(
          { success: true, deletionVerification },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (purpose === "admin_user_account_recovery") {
        const accountRecoveryVerification = await createAdminUserAccountReauth(payload);
        return NextResponse.json(
          { success: true, accountRecoveryVerification },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (purpose === "admin_cami_assignment") {
        const camiAssignmentVerification = await createAdminCamiAssignmentReauth(payload);
        return NextResponse.json(
          { success: true, camiAssignmentVerification },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json({ success: true });
    }

    // 回退：使用管理员登录密码验证
    const { data: user } = await supabase
      .from("users")
      .select("password_hash")
      .eq("id", payload.userId)
      .single();

    if (!user?.password_hash) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return NextResponse.json({ error: "管理员登录密码或管理密码错误" }, { status: 401 });
    }

    if (purpose === "admin_user_delete") {
      const deletionVerification = await createAdminUserDeleteReauth(payload);
      return NextResponse.json(
        { success: true, deletionVerification },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (purpose === "admin_user_account_recovery") {
      const accountRecoveryVerification = await createAdminUserAccountReauth(payload);
      return NextResponse.json(
        { success: true, accountRecoveryVerification },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (purpose === "admin_cami_assignment") {
      const camiAssignmentVerification = await createAdminCamiAssignmentReauth(payload);
      return NextResponse.json(
        { success: true, camiAssignmentVerification },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "验证失败" }, { status: 500 });
  }
}
