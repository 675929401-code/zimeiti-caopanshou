import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders, verifyToken } from '@/lib/auth';
import { isEmailConfigured, sendVerificationCode } from '@/lib/email';
import { generateCode, storeCode, verifyCode } from '@/lib/email-code-store';
import { normalizeQqEmail, qqEmailError } from '@/lib/qq-email';

// POST /api/auth/bind-email
// action: "send_code" | "bind"
export async function POST(request: NextRequest) {
  try {
    // 验证登录状态
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 });
    }

    const body = await request.json();
    const { action, code } = body;
    const email = normalizeQqEmail(body.email);
    const client = getSupabaseClient();

    const { data: currentUser, error: currentUserError } = await client
      .from('users')
      .select('email')
      .eq('id', payload.userId)
      .maybeSingle();
    if (currentUserError) {
      return NextResponse.json({ error: '暂时无法核验账号安全信息' }, { status: 503 });
    }
    if (!currentUser) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    // QQ 邮箱是注册与找回账号的永久身份凭据。仅兼容历史未绑定账号做一次性补绑，
    // 一旦存在任何邮箱值，就必须拒绝所有自助换绑请求。
    const currentEmail = String(currentUser.email || '').trim();
    if (currentEmail) {
      return NextResponse.json({
        error: '安全邮箱绑定后不可更改',
        code: 'EMAIL_IMMUTABLE',
      }, { status: 409 });
    }

    if (!action) {
      return NextResponse.json({ error: '缺少 action 参数' }, { status: 400 });
    }

    if (action === 'send_code') {
      // 发送绑定验证码
      const emailError = qqEmailError(email);
      if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });

      // 检查邮箱是否已被其他用户绑定
      const { data: existingUser } = await client
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', payload.userId)
        .maybeSingle();

      if (existingUser) {
        return NextResponse.json({ error: '该邮箱已被其他用户绑定' }, { status: 409 });
      }

      // 检查邮件服务
      if (!(await isEmailConfigured())) {
        return NextResponse.json({ error: '邮件验证服务未配置，当前不能绑定邮箱' }, { status: 503 });
      }

      // 生成并发送验证码
      const verifyCode = generateCode();
      const storeResult = storeCode(email, verifyCode, `email_initial_bind:${payload.userId}`);
      if (!storeResult.ok) {
        return NextResponse.json({ error: storeResult.error }, { status: 429 });
      }

      const sent = await sendVerificationCode(email, verifyCode, '绑定安全邮箱');
      if (!sent) {
        return NextResponse.json({ error: '验证码发送失败，请稍后重试' }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: '验证码已发送到您的邮箱',
      });

    } else if (action === 'bind') {
      // 绑定邮箱
      const emailError = qqEmailError(email);
      if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });

      // 再次检查邮箱是否已被其他用户绑定
      const { data: existingUser } = await client
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', payload.userId)
        .maybeSingle();

      if (existingUser) {
        return NextResponse.json({ error: '该邮箱已被其他用户绑定' }, { status: 409 });
      }

      if (!(await isEmailConfigured())) {
        return NextResponse.json({ error: '邮件验证服务未配置，当前不能绑定邮箱' }, { status: 503 });
      }
      if (!code) {
        return NextResponse.json({ error: '请输入邮箱验证码' }, { status: 400 });
      }
      const verifyResult = verifyCode(email, code, `email_initial_bind:${payload.userId}`);
      if (!verifyResult.ok) {
        return NextResponse.json({ error: verifyResult.error }, { status: 400 });
      }

      // 更新邮箱
      let updateQuery = client
        .from('users')
        .update({ email, updated_at: new Date().toISOString() })
        .eq('id', payload.userId);
      updateQuery = currentUser.email === null
        ? updateQuery.is('email', null)
        : updateQuery.eq('email', currentUser.email);
      const { data: updatedUser, error } = await updateQuery.select('id').maybeSingle();

      if (error) {
        console.error('Bind email error:', error);
        return NextResponse.json({ error: '绑定邮箱失败' }, { status: 500 });
      }
      if (!updatedUser) {
        return NextResponse.json({
          error: '安全邮箱已由其他请求绑定，请刷新页面',
          code: 'EMAIL_BIND_CONFLICT',
        }, { status: 409 });
      }

      return NextResponse.json({
        success: true,
        message: 'QQ邮箱验证并绑定成功',
      });

    } else {
      return NextResponse.json({ error: '无效的 action 参数' }, { status: 400 });
    }

  } catch (err) {
    console.error('Bind email error:', err);
    return NextResponse.json({ error: '操作失败，请稍后重试' }, { status: 500 });
  }
}
