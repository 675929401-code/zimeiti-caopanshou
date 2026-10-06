import { NextRequest, NextResponse } from 'next/server';
import { authorizeToken, getTokenFromHeaders } from '@/lib/auth';
import { generateCode, storeCode, verifyCode } from '@/lib/email-code-store';
import { isEmailConfigured, sendVerificationCode } from '@/lib/email';
import { isQqEmail, normalizeQqEmail } from '@/lib/qq-email';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function maskedEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '当前安全邮箱';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(3, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) return json({ error: '未登录' }, 401);
    const authorization = await authorizeToken(token);
    if (!authorization.ok) {
      return json({ error: authorization.error, code: authorization.code }, authorization.status);
    }

    const body = await request.json().catch(() => ({})) as {
      action?: string;
      phone?: string;
      emailCode?: string;
    };
    const action = body.action === 'send_code' ? 'send_code' : body.action === 'change' ? 'change' : '';
    const phone = String(body.phone || '').trim();
    if (!action) return json({ error: '操作类型无效' }, 400);
    if (!/^1[3-9]\d{9}$/u.test(phone)) return json({ error: '请输入正确的手机号' }, 400);

    const client = getSupabaseClient();
    const { data: currentUser, error: currentUserError } = await client
      .from('users')
      .select('email,phone')
      .eq('id', authorization.actor.userId)
      .maybeSingle();
    if (currentUserError) return json({ error: '暂时无法核验账号安全信息' }, 503);
    if (!currentUser) return json({ error: '用户不存在' }, 404);

    const email = normalizeQqEmail(currentUser.email);
    if (!isQqEmail(email)) {
      return json({
        error: '请先绑定已验证的QQ安全邮箱',
        code: 'QQ_EMAIL_REQUIRED',
      }, 409);
    }
    if (phone === String(currentUser.phone || '')) {
      return json({ error: '新手机号不能与当前手机号相同' }, 400);
    }

    const { data: existingPhone, error: phoneLookupError } = await client
      .from('users')
      .select('id')
      .eq('phone', phone)
      .neq('id', authorization.actor.userId)
      .maybeSingle();
    if (phoneLookupError) return json({ error: '暂时无法核验手机号' }, 503);
    if (existingPhone) return json({ error: '该手机号已被其他账号绑定' }, 409);

    const purpose = `phone_change:${authorization.actor.userId}:${phone}`;
    if (action === 'send_code') {
      if (!(await isEmailConfigured())) {
        return json({ error: '邮件验证服务未配置，当前不能更换手机号' }, 503);
      }
      const code = generateCode();
      const stored = storeCode(email, code, purpose);
      if (!stored.ok) return json({ error: stored.error }, 429);
      if (!(await sendVerificationCode(email, code, '更换安全手机'))) {
        return json({ error: '验证码发送失败，请稍后重试' }, 500);
      }
      return json({
        success: true,
        message: `验证码已发送至 ${maskedEmail(email)}`,
        maskedEmail: maskedEmail(email),
      });
    }

    if (!body.emailCode) return json({ error: '请输入QQ邮箱验证码' }, 400);
    const verification = verifyCode(email, String(body.emailCode), purpose);
    if (!verification.ok) return json({ error: verification.error }, 400);

    let updateQuery = client
      .from('users')
      .update({ phone, updated_at: new Date().toISOString() })
      .eq('id', authorization.actor.userId);
    updateQuery = currentUser.phone === null
      ? updateQuery.is('phone', null)
      : updateQuery.eq('phone', currentUser.phone);
    const { data: updatedUser, error: updateError } = await updateQuery.select('id').maybeSingle();
    if (updateError) {
      return json({ error: updateError.code === '23505' ? '该手机号已被其他账号绑定' : '手机号更新失败' }, updateError.code === '23505' ? 409 : 500);
    }
    if (!updatedUser) {
      return json({ error: '手机号已由其他请求更新，请刷新页面', code: 'PHONE_CHANGE_CONFLICT' }, 409);
    }

    return json({ success: true, phone, message: '手机号更新成功' });
  } catch (error) {
    console.error('Change phone error:', error);
    return json({ error: '操作失败，请稍后重试' }, 500);
  }
}
