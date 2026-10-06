import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { createToken } from '@/lib/auth';
import { verifyCode } from '@/lib/email-code-store';
import { createHash, randomBytes } from 'crypto';
import { issueUserAuthSession } from '@/lib/auth-session-store';
import { publicAllowedAgentCategoryIds } from '@/lib/agent-category-access';
import { readUserAppearancePreference } from '@/lib/server/user-appearance-preference';

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIP = request.headers.get('x-real-ip');
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) return cfIP.trim();
  if (realIP) return realIP.trim();
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim()).filter(Boolean);
    if (ips.length > 0) {
      for (let i = ips.length - 1; i >= 0; i--) {
        const ip = ips[i];
        if (!isPrivateIP(ip)) return ip;
      }
      return ips[ips.length - 1];
    }
  }
  return 'unknown';
}

function isPrivateIP(ip: string): boolean {
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1') return true;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  const second = parseInt(parts[1], 10);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 127) return true;
  return false;
}

function hashIP(ip: string): string {
  return createHash('sha256').update(ip + (process.env.SECURITY_INTERNAL_KEY?.trim() || process.env.JWT_SECRET?.trim() || '')).digest('hex').substring(0, 16);
}

function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

function hashUserAgent(userAgent: string): string {
  return createHash('sha256').update(userAgent).digest('hex').substring(0, 32);
}

export async function POST(request: NextRequest) {
  try {
    const { email, code } = await request.json();

    if (!email || !code) {
      return NextResponse.json({ error: '请输入邮箱和验证码' }, { status: 400 });
    }

    // 验证邮箱格式
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: '请输入正确的邮箱地址' }, { status: 400 });
    }

    // 验证验证码
    const codeResult = verifyCode(email, code, 'login');
    if (!codeResult.ok) {
      return NextResponse.json({ error: codeResult.error }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 查询用户
    const { data: user, error } = await client
      .from('users')
      .select('id, username, display_name, email, phone, role, credits, is_active, status, allowed_categories, member_status, password_hash')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: '查询用户失败' }, { status: 500 });
    }

    if (!user) {
      return NextResponse.json({ error: '该邮箱未注册' }, { status: 401 });
    }

    // 检查用户状态 (status 优先于 is_active)
    const userStatus = user.status || (user.is_active ? 'active' : 'blocked');
    if (userStatus === 'blocked') {
      return NextResponse.json({ error: '账号已被拉黑，禁止登录，请联系管理员' }, { status: 403 });
    }
    if (userStatus === 'suspended') {
      return NextResponse.json({ error: '账号已被暂停，请联系管理员恢复' }, { status: 403 });
    }
    if (!user.is_active || userStatus !== 'active') {
      return NextResponse.json({ error: '账号已被禁用，请联系管理员' }, { status: 403 });
    }

    // 创建 token
    const ipHash = hashIP(getClientIP(request));
    const sessionId = generateSessionId();

    const sessionUpdate = await issueUserAuthSession(client, {
      userId: user.id,
      sessionId,
      ipHash,
      userAgentHash: hashUserAgent(request.headers.get('user-agent') || 'unknown'),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!sessionUpdate.ok) {
      return NextResponse.json(
        { error: '登录会话创建失败，请稍后重试', code: 'SESSION_PERSIST_FAILED' },
        { status: 503 },
      );
    }

    const token = await createToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
      ipHash,
      sessionId,
    });

    let appearance = { preference: null, status: 'storage_unavailable' } as Awaited<ReturnType<typeof readUserAppearancePreference>>;
    try {
      appearance = await readUserAppearancePreference(user.id, request as unknown as Request);
    } catch {
      // 外观偏好是非关键附加信息，不得让已通过验证的邮箱登录失败。
      console.warn('[auth/login-email] User appearance preference could not be read');
    }

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email || '',
        phone: user.phone || '',
        role: user.role,
        credits: user.credits,
        allowedCategories: publicAllowedAgentCategoryIds(user.role, user.allowed_categories),
        memberStatus: user.member_status || 'inactive',
        themePreference: appearance.preference?.theme || null,
        themeModePreference: appearance.preference?.modePreference || null,
        themePreferenceExpiresAt: appearance.preference?.expiresAt || null,
        themePreferenceStatus: appearance.status,
        hasPassword: !!user.password_hash,
      },
      token,
    });

    // Set cookie
    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && request.nextUrl.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 3, // 3 days
      path: '/',
    });

    return response;
  } catch (err) {
    console.error('Email login error:', err);
    return NextResponse.json({ error: '登录失败，请稍后重试' }, { status: 500 });
  }
}
