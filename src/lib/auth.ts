import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/server-secrets';
import { isUserAuthSessionActive } from '@/lib/auth-session-store';

export function getJwtSecretString(): string {
  return requireServerSecret('JWT_SECRET');
}

export function getJwtSecretKey(): Uint8Array {
  return new TextEncoder().encode(getJwtSecretString());
}

export interface JWTPayload {
  userId: string;
  username: string;
  role: 'admin' | 'student';
  displayName: string;
  ipHash?: string;
  sessionId?: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;

  if (/^\$2[aby]\$/.test(hash)) {
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }

  const separator = hash.indexOf(':');
  if (separator > 0) {
    const salt = hash.slice(0, separator);
    const expected = hash.slice(separator + 1);
    if (/^[a-f0-9]{64}$/i.test(expected)) {
      const actual = createHash('sha256').update(salt + password).digest('hex');
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
    }
  }

  return false;
}

export async function createToken(
  payload: JWTPayload & { ipHash?: string; sessionId?: string },
  options: { expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '3d')
    .sign(getJwtSecretKey());
}

/** Verify only the JWT signature and expiry. Use this only when the caller
 * performs its own current-user/session lookup immediately afterwards. */
export async function verifyTokenSignature(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretKey());
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

export type TokenAuthorizationResult =
  | { ok: true; actor: JWTPayload }
  | { ok: false; status: 401 | 403 | 503; code: string; error: string };

/**
 * Authoritative authentication result. Unlike the legacy nullable wrapper this
 * keeps an unavailable database/session authority distinct from an expired or
 * revoked login, so a temporary outage never signs the browser out.
 */
export async function authorizeToken(token: string): Promise<TokenAuthorizationResult> {
  const payload = await verifyTokenSignature(token);
  if (!payload || !payload.userId || !payload.sessionId) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', error: '登录状态无效或已过期' };
  }

  if (process.env.NODE_ENV !== 'production' && payload.sessionId.startsWith('sandbox-')) {
    return { ok: true, actor: payload };
  }

  try {
    const { getSupabaseAdminClient } = await import('@/storage/database/supabase-client');
    const client = getSupabaseAdminClient();
    const { data, error } = await client
      .from('users')
      .select('id, username, display_name, role, status, is_active, session_id')
      .eq('id', payload.userId)
      .maybeSingle();
    if (error) {
      return { ok: false, status: 503, code: 'AUTH_AUTHORITY_UNAVAILABLE', error: '登录状态校验暂不可用，请稍后重试' };
    }
    if (!data) {
      return { ok: false, status: 401, code: 'UNAUTHENTICATED', error: '账户不存在或登录状态无效' };
    }
    if (data.is_active !== true || (data.status != null && data.status !== 'active')) {
      return { ok: false, status: 403, code: 'ACCOUNT_DISABLED', error: '账户已停用，请联系管理员' };
    }
    if (data.role !== 'admin' && data.role !== 'student') {
      return { ok: false, status: 403, code: 'ROLE_INVALID', error: '账户权限无效' };
    }

    const currentSession = await isUserAuthSessionActive(client, payload.userId, payload.sessionId);
    if (!currentSession.ok) {
      return currentSession.unavailable
        ? { ok: false, status: 503, code: 'AUTH_AUTHORITY_UNAVAILABLE', error: '登录状态校验暂不可用，请稍后重试' }
        : { ok: false, status: 401, code: 'SESSION_REVOKED', error: '登录状态已失效，请重新登录' };
    }

    return {
      ok: true,
      actor: {
        ...payload,
        username: String(data.username || payload.username || ''),
        displayName: String(data.display_name || payload.displayName || ''),
        role: data.role,
        sessionId: payload.sessionId,
      },
    };
  } catch {
    return { ok: false, status: 503, code: 'AUTH_AUTHORITY_UNAVAILABLE', error: '登录状态校验暂不可用，请稍后重试' };
  }
}

/**
 * Verify both the signed token and the server-owned current session.
 *
 * Password resets and administrator identity changes revoke every session;
 * logout revokes only the caller. Same-account sessions may coexist on one IP;
 * a login from a different IP replaces that account's prior-IP sessions, and
 * a different account on the same IP is replaced.
 * Current role and display identity also come from the database instead of a
 * stale claim embedded in the token.
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  const result = await authorizeToken(token);
  return result.ok ? result.actor : null;
}

export function getTokenFromHeaders(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  // Also check cookies
  const cookie = headers.get('cookie');
  if (cookie) {
    const match = cookie.match(/auth_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * 密码操作审计日志 — 所有 password_hash 修改必须调用此函数
 * 禁止通过 exec_sql 或直接 SQL 修改 password_hash，必须通过 API 路由 + 此审计函数
 */
export async function logPasswordAudit(params: {
  userId: string;
  action: 'register' | 'admin_create' | 'admin_update' | 'admin_reset' | 'self_change' | 'emergency_reset';
  performedById?: string;
  performedByRole?: string;
  performedByName?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: string;
}): Promise<void> {
  try {
    const { getSupabaseAdminClient } = await import('@/storage/database/supabase-client');
    const client = getSupabaseAdminClient();
    const { error } = await client.from('password_audit_log').insert({
      user_id: params.userId,
      action: params.action,
      performed_by: params.performedById || null,
      performed_by_role: params.performedByRole || null,
      performed_by_name: params.performedByName || null,
      // Audit the operation without copying password material into another table.
      old_hash_prefix: null,
      new_hash_prefix: null,
      ip_address: params.ipAddress || null,
      user_agent: params.userAgent || null,
      details: params.details || null,
    });
    if (error) {
      console.error('[密码审计] 写入失败:', error.message);
    }
  } catch (err) {
    console.error('[密码审计] 异常:', err);
    // 审计日志写入失败不应阻塞业务流程
  }
}
