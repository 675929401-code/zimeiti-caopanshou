import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { withAuth } from '@/lib/api-middleware';
import { getServerSecret } from '@/lib/server-secrets';

/**
 * POST /api/voice/sso-token
 *
 * Generate a voice-studio SSO token for the verified current user.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (user) => {
    try {
      const ssoSecret = getServerSecret('SSO_SECRET', 'zyuani8-voice-studio-sso-2026');
      if (!ssoSecret) {
        return NextResponse.json({ error: 'SSO 服务未配置' }, { status: 503 });
      }

      const userId = user.id;
      const email = user.email;
      const role = user.role;
      const name = user.displayName || user.email;
      const ssoTs = Date.now().toString();
      const payload = `${userId}:${email}:${ssoTs}`;
      const ssoToken = createHmac('sha256', ssoSecret).update(payload).digest('hex');

      const voiceStudioUrl = process.env.VOICE_STUDIO_URL || 'http://localhost:3001';
      const ssoRes = await fetch(`${voiceStudioUrl}/api/sso/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sso_token: ssoToken,
          sso_user_id: userId,
          sso_email: email,
          sso_role: role,
          sso_name: name,
          sso_ts: ssoTs,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!ssoRes.ok) {
        const err = await ssoRes.text();
        console.error('[sso-token] voice studio SSO login failed:', err);
        return NextResponse.json({ error: 'SSO 登录失败' }, { status: 502 });
      }

      const ssoData = await ssoRes.json();
      if (!ssoData.success) {
        return NextResponse.json({ error: ssoData.message || 'SSO 登录失败' }, { status: 401 });
      }

      return NextResponse.json({
        token: ssoData.data.token,
        userId: ssoData.data.userId,
      });
    } catch (e: unknown) {
      console.error('[sso-token] Error:', e);
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'SSO 令牌生成失败' },
        { status: 500 },
      );
    }
  });
}
