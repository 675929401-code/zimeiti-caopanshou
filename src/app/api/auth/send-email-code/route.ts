import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isEmailConfigured, sendVerificationCode } from '@/lib/email';
import { generateCode, storeCode } from '@/lib/email-code-store';

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: '请输入邮箱地址' }, { status: 400 });
    }

    // 验证邮箱格式
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: '请输入正确的邮箱地址' }, { status: 400 });
    }

    // 检查邮件服务是否配置
    if (!(await isEmailConfigured())) {
      return NextResponse.json({ error: '邮件服务未配置，请联系管理员' }, { status: 503 });
    }

    const client = getSupabaseClient();

    // 仅允许已注册的邮箱发送验证码
    const { data: user, error } = await client
      .from('users')
      .select('id, email, is_active')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: '查询失败，请稍后重试' }, { status: 500 });
    }

    // 未注册邮箱 — 不暴露是否存在，统一提示"邮箱未注册"
    if (!user) {
      return NextResponse.json({ error: '该邮箱未注册，请联系管理员创建账号' }, { status: 404 });
    }

    if (!user.is_active) {
      return NextResponse.json({ error: '账号已被禁用，请联系管理员' }, { status: 403 });
    }

    // 生成验证码
    const code = generateCode();
    const storeResult = storeCode(email, code, 'login');
    if (!storeResult.ok) {
      return NextResponse.json({ error: storeResult.error }, { status: 429 });
    }

    // 发送邮件
    const sent = await sendVerificationCode(email, code, '登录验证');
    if (!sent) {
      return NextResponse.json({ error: '验证码发送失败，请稍后重试' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: '验证码已发送到您的邮箱',
    });
  } catch (err) {
    console.error('Send email code error:', err);
    return NextResponse.json({ error: '发送验证码失败，请稍后重试' }, { status: 500 });
  }
}
