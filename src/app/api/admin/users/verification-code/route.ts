import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { isEmailConfigured, sendVerificationCode } from "@/lib/email";
import { generateCode, storeCode } from "@/lib/email-code-store";
import {
  adminUserVerificationKey,
  maskQqEmail,
  type AdminUserVerificationPurpose,
} from "@/lib/admin-user-verification";
import { normalizeQqEmail, qqEmailError } from "@/lib/qq-email";
import { checkAdminUserIdentity } from "@/lib/admin-user-identity";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const PURPOSES = new Set<AdminUserVerificationPurpose>([
  "create",
  "email_change",
  "password_reset",
]);

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  return payload?.role === "admin" ? payload : null;
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });

  try {
    const body = await request.json();
    const purpose = body.purpose as AdminUserVerificationPurpose;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!PURPOSES.has(purpose)) {
      return NextResponse.json({ error: "无效的验证用途" }, { status: 400 });
    }
    if (purpose !== "create" && !userId) {
      return NextResponse.json({ error: "目标用户不能为空" }, { status: 400 });
    }
    if (!(await isEmailConfigured())) {
      return NextResponse.json({ error: "邮件验证服务未配置，当前不能执行此操作" }, { status: 503 });
    }

    const client = getSupabaseAdminClient();
    let email = normalizeQqEmail(body.email);

    if (purpose === "password_reset") {
      const { data: targetUser, error } = await client
        .from("users")
        .select("id, email")
        .eq("id", userId)
        .maybeSingle();
      if (error) return NextResponse.json({ error: "暂时无法读取用户，请稍后重试" }, { status: 503 });
      if (!targetUser) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
      email = normalizeQqEmail(targetUser.email);
    } else {
      const emailError = qqEmailError(email);
      if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
      const identityError = await checkAdminUserIdentity(
        client,
        { email },
        purpose === "email_change" ? userId : undefined,
      );
      if (identityError) {
        return NextResponse.json({ error: identityError.error }, { status: identityError.status });
      }
    }

    const emailError = qqEmailError(email);
    if (emailError) {
      return NextResponse.json(
        { error: purpose === "password_reset" ? "该学员尚未绑定有效QQ邮箱，不能通过后台重置密码" : emailError },
        { status: 409 },
      );
    }

    const code = generateCode();
    const verificationPurpose = adminUserVerificationKey(purpose, admin.userId, userId || undefined);
    const stored = storeCode(email, code, verificationPurpose);
    if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 429 });

    const emailPurpose = purpose === "create"
      ? "创建学员账号"
      : purpose === "password_reset"
        ? "重置学员密码"
        : "管理员安全验证";
    if (!(await sendVerificationCode(email, code, emailPurpose))) {
      return NextResponse.json({ error: "验证码发送失败，请稍后重试" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `验证码已发送至 ${maskQqEmail(email)}`,
      maskedEmail: maskQqEmail(email),
    });
  } catch (error) {
    console.error("Admin user verification code error:", error);
    return NextResponse.json({ error: "验证码发送失败，请稍后重试" }, { status: 500 });
  }
}
