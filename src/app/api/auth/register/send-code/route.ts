import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isEmailConfigured, sendVerificationCode } from '@/lib/email';
import { generateCode, storeCode } from '@/lib/email-code-store';
import { shouldRejectReservedFixtureIdentity } from '@/lib/account-governance';
import { normalizeQqEmail, qqEmailError } from '@/lib/qq-email';

// POST /api/auth/register/send-code - 注册时发送邮箱验证码（不要求邮箱已注册）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = normalizeQqEmail(body.email);
    const emailError = qqEmailError(email);
    if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
    if (shouldRejectReservedFixtureIdentity({ email })) {
      return NextResponse.json({ error: '测试/E2E/验收邮箱不能通过正式注册入口发送验证码' }, { status: 400 });
    }

    // 检查邮件服务是否配置
    if (!(await isEmailConfigured())) {
      return NextResponse.json({ error: '邮件服务未配置，请联系管理员' }, { status: 503 });
    }

    const client = getSupabaseClient();

    // 检查邮箱是否已注册
    const { data: existingUser } = await client
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existingUser) {
      return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
    }

    // 生成验证码
    const code = generateCode();
    const storeResult = storeCode(email, code, 'register');
    if (!storeResult.ok) {
      return NextResponse.json({ error: storeResult.error }, { status: 429 });
    }

    // 发送邮件
    const sent = await sendVerificationCode(email, code, '注册账号');
    if (!sent) {
      return NextResponse.json({ error: '验证码发送失败，请稍后重试' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: '验证码已发送到您的邮箱',
    });
  } catch (err) {
    console.error('Register send code error:', err);
    return NextResponse.json({ error: '发送验证码失败，请稍后重试' }, { status: 500 });
  }
}
