import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders, authorizeToken, hashPassword, verifyPassword, logPasswordAudit } from '@/lib/auth';
import { adminPasswordError } from '@/lib/admin-password-policy';
import { generateCode, storeCode, verifyCode } from '@/lib/email-code-store';
import { isEmailConfigured, sendVerificationCode } from '@/lib/email';
import { isQqEmail, normalizeQqEmail } from '@/lib/qq-email';

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const authorization = await authorizeToken(token);
    if (!authorization.ok) {
      return NextResponse.json(
        { error: authorization.error, code: authorization.code },
        { status: authorization.status },
      );
    }
    const payload = authorization.actor;

    const body = await request.json();
    const { oldPassword, newPassword, emailCode } = body;
    const action = body.action === 'send_code' ? 'send_code' : 'change';

    const client = getSupabaseClient();

    // Get current password hash
    const { data: user, error: fetchError } = await client
      .from('users')
      .select('password_hash, email')
      .eq('id', payload.userId)
      .maybeSingle();

    if (fetchError || !user) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    const email = normalizeQqEmail(user.email);
    if (!isQqEmail(email)) {
      return NextResponse.json({ error: '账号尚未绑定已验证的QQ邮箱，请先在个人中心绑定QQ邮箱' }, { status: 409 });
    }

    const purpose = `password_change:${payload.userId}`;
    if (action === 'send_code') {
      if (!(await isEmailConfigured())) {
        return NextResponse.json({ error: '邮件验证服务未配置，当前不能修改密码' }, { status: 503 });
      }
      const code = generateCode();
      const stored = storeCode(email, code, purpose);
      if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 429 });
      if (!(await sendVerificationCode(email, code, '修改登录密码'))) {
        return NextResponse.json({ error: '验证码发送失败，请稍后重试' }, { status: 500 });
      }
      return NextResponse.json({ success: true, message: '验证码已发送到当前QQ邮箱' });
    }

    const passwordError = adminPasswordError(newPassword);
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

    // 如果用户已有密码，必须验证旧密码
    if (user.password_hash) {
      if (!oldPassword) {
        return NextResponse.json({ error: '请输入旧密码' }, { status: 400 });
      }
      const valid = await verifyPassword(oldPassword, user.password_hash);
      if (!valid) {
        return NextResponse.json({ error: '旧密码错误' }, { status: 401 });
      }
    }
    // 无密码用户（password_hash 为 null）跳过旧密码验证，直接设置新密码

    if (!emailCode) {
      return NextResponse.json({ error: '请输入QQ邮箱验证码' }, { status: 400 });
    }
    const verification = verifyCode(email, String(emailCode), purpose);
    if (!verification.ok) {
      return NextResponse.json({ error: verification.error }, { status: 400 });
    }

    // Update password
    const newHash = await hashPassword(newPassword);
    const { error: updateError } = await client
      .from('users')
      .update({
        password_hash: newHash,
        session_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', payload.userId);

    if (updateError) {
      return NextResponse.json({ error: '修改密码失败' }, { status: 500 });
    }

    // 🔒 密码审计：用户自行修改密码
    await logPasswordAudit({
      userId: payload.userId,
      action: 'self_change',
      performedById: payload.userId,
      performedByRole: payload.role,
      performedByName: payload.displayName,
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      details: user.password_hash ? '用户自行修改密码（验证旧密码）' : '无密码用户首次设置密码',
    });

    return NextResponse.json({
      success: true,
      sessionRevoked: true,
      message: '密码修改成功，所有设备已退出，请使用新密码重新登录',
    });
  } catch (err) {
    console.error('Change password error:', err);
    return NextResponse.json({ error: '修改密码失败' }, { status: 500 });
  }
}
