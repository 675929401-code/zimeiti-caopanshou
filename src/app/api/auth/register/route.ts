import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { createToken, hashPassword, logPasswordAudit } from '@/lib/auth';
import { checkRateLimit, getClientIP as getSecIP } from '@/lib/security';
import { createHash, randomBytes } from 'crypto';
import { shouldRejectReservedFixtureIdentity } from '@/lib/account-governance';
import { normalizeQqEmail, qqEmailError } from '@/lib/qq-email';
import { adminPasswordError } from '@/lib/admin-password-policy';
import { publicAllowedAgentCategoryIds } from '@/lib/agent-category-access';
import { issueUserAuthSession } from '@/lib/auth-session-store';
import { getAuthSessionClientIP } from '@/lib/auth-session-client-ip';

interface AtomicRegistrationResult {
  ok?: boolean;
  code?: string;
  session_active?: boolean;
  risk_status?: string;
  risk_reasons?: string[];
  automatic_trial_eligible?: boolean;
  user?: {
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    phone: string | null;
    role: 'student';
    credits: number;
    is_active: boolean;
    allowed_categories: unknown;
    member_status: string | null;
  };
}

function hashRegistrationIP(ip: string): string {
  const salt = process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || '';
  return createHash('sha256').update(ip + salt).digest('hex').substring(0, 16);
}

function hashRegistrationDevice(deviceId: string): string | null {
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(deviceId)) return null;
  const salt = process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || '';
  return createHash('sha256').update(`registration-device:${deviceId}:${salt}`).digest('hex').substring(0, 32);
}

// POST /api/auth/register - 用户自注册
export async function POST(request: NextRequest) {
  try {
    // ⚡ 速率限制：防止恶意批量注册
    const secIP = getSecIP(request);
    const rateCheck = checkRateLimit(secIP, 'POST', '/api/auth/register');
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: '注册操作过于频繁，请稍后再试' },
        { status: 429 }
      );
    }
    const clientIP = getAuthSessionClientIP(request);
    if (!clientIP) {
      return NextResponse.json(
        { error: '注册入口暂未获得可信网络地址，请稍后重试', code: 'CLIENT_IP_UNAVAILABLE' },
        { status: 503 },
      );
    }

    const body = await request.json();
    const { phone, code, displayName, password, invitationCode } = body;
    const email = normalizeQqEmail(body.email);

    // 验证必填字段
    if (!invitationCode) {
      return NextResponse.json({ error: '邀请码为必填项，请联系现有学员获取邀请码' }, { status: 400 });
    }
    const emailError = qqEmailError(email);
    if (emailError) return NextResponse.json({ error: emailError }, { status: 400 });
    if (!phone) {
      return NextResponse.json({ error: '手机号为必填项' }, { status: 400 });
    }
    if (!code) {
      return NextResponse.json({ error: '验证码为必填项' }, { status: 400 });
    }

    if (shouldRejectReservedFixtureIdentity({ email, phone, displayName })) {
      return NextResponse.json({ error: '测试/E2E/验收账号不能通过正式注册入口创建' }, { status: 400 });
    }

    // 验证手机号格式（中国大陆11位手机号）
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return NextResponse.json({ error: '请输入正确的手机号码' }, { status: 400 });
    }

    const passwordError = adminPasswordError(password);
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

    // 验证验证码
    const { verifyCode } = await import('@/lib/email-code-store');
    const codeResult = verifyCode(email, code, 'register');
    if (!codeResult.ok) {
      return NextResponse.json({ error: codeResult.error }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 创建用户（注册用户默认角色为student，积分为0，会员状态为inactive）
    const username = `user_${phone}`;
    const passwordHash = await hashPassword(password);

    // 🛡️ 防御性自检：确保 password_hash 已生成（铁律 #10 — 禁止 INSERT 中丢失密码哈希）
    if (!passwordHash) {
      console.error('[REGISTER SAFETY] password_hash 为空！拒绝注册，phone:', phone);
      return NextResponse.json({ error: '注册失败：密码处理异常，请联系管理员' }, { status: 500 });
    }

    const ipHash = hashRegistrationIP(clientIP);
    const riskIPHash = clientIP === 'unknown' ? null : ipHash;
    const deviceHash = hashRegistrationDevice(String(body.deviceId || '').trim());
    const sessionId = randomBytes(32).toString('hex');
    const { data: registrationData, error: registrationError } = await client.rpc(
      'register_invited_user_secure_atomic',
      {
        p_email: String(email),
        p_phone: String(phone),
        p_username: username,
        p_password_hash: passwordHash,
        p_display_name: String(displayName || `用户${phone.slice(-4)}`),
        p_invitation_code: String(invitationCode).toUpperCase().trim(),
        p_session_id: sessionId,
        p_registration_ip_hash: riskIPHash,
        p_registration_device_hash: deviceHash,
      },
    );
    if (registrationError) {
      console.error('Register atomic RPC error:', registrationError.code || registrationError.message);
      if (String(registrationError.message || '').includes('INVITATION_OWNER_NOT_ELIGIBLE')) {
        return NextResponse.json({ error: '邀请人的正式会员资格已失效，请联系对方生成新的有效邀请码' }, { status: 409 });
      }
      const migrationMissing = registrationError.code === 'PGRST202';
      return NextResponse.json(
        { error: migrationMissing ? '注册事务尚未部署，请联系管理员' : '注册事务失败，请稍后重试' },
        { status: 503 },
      );
    }

    const registration = registrationData as AtomicRegistrationResult | null;
    if (!registration?.ok || !registration.user?.id) {
      const responseByCode: Record<string, { error: string; status: number }> = {
        EMAIL_EXISTS: { error: '该邮箱已注册，请直接登录', status: 409 },
        PHONE_EXISTS: { error: '该手机号已注册，请直接登录', status: 409 },
        INVITATION_NOT_FOUND: { error: '邀请码不存在，请确认后重试', status: 400 },
        INVITATION_USED: { error: '邀请码已被使用，请联系邀请人获取新的邀请码', status: 400 },
        INVITATION_OWNER_INVALID: { error: '邀请码归属无效，请联系管理员', status: 409 },
      };
      const mapped = responseByCode[String(registration?.code || '')]
        || { error: '注册事务失败，请稍后重试', status: 500 };
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    const newUser = registration.user;

    // The current migration writes the first session in the same transaction as
    // the account and invitation relationship. Reissuing with the same random
    // session id is idempotent and also repairs a node that briefly runs against
    // the pre-session version of the registration RPC.
    const sessionResult = await issueUserAuthSession(client, {
      userId: newUser.id,
      sessionId,
      ipHash,
      userAgentHash: createHash('sha256')
        .update(request.headers.get('user-agent') || 'unknown')
        .digest('hex')
        .substring(0, 32),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!sessionResult.ok) {
      return NextResponse.json({
        error: '账号已创建，但自动登录状态未能确认，请返回首页重新登录',
        code: 'REGISTRATION_SESSION_PENDING',
        accountCreated: true,
      }, { status: 503 });
    }

    // 🔒 密码审计：用户自注册
    await logPasswordAudit({
      userId: newUser.id,
      action: 'register',
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      details: `用户自注册，手机号:${phone}，邮箱:${email}，邀请码已验证`,
    });

    const token = await createToken({
      userId: newUser.id,
      username: newUser.username,
      role: newUser.role,
      displayName: newUser.display_name,
      ipHash,
      sessionId,
    });

    const response = NextResponse.json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        displayName: newUser.display_name,
        email: newUser.email || '',
        phone: newUser.phone || '',
        role: newUser.role,
        credits: newUser.credits,
        allowedCategories: publicAllowedAgentCategoryIds(newUser.role, newUser.allowed_categories),
        memberStatus: newUser.member_status || 'inactive',
      },
      invitationRisk: {
        status: String(registration.risk_status || 'clear'),
        reasons: Array.isArray(registration.risk_reasons) ? registration.risk_reasons : [],
        automaticTrialEligible: registration.automatic_trial_eligible !== false,
      },
      token,
    });
    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && request.nextUrl.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 3,
      path: '/',
    });
    return response;
  } catch (err) {
    console.error('Register error:', err);
    return NextResponse.json({ error: '注册失败，请稍后重试' }, { status: 500 });
  }
}
