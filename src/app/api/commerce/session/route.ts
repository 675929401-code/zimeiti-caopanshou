import { NextRequest } from 'next/server';
import {
  COMMERCE_MAIN_SESSION_COOKIE,
  createSession,
  ensureSessionForMainUser,
  identity,
  revokeSession,
  sameOrigin,
} from '../../../../commerce/server/auth';
import {
  authorizeCommerceMainAccount,
  authorizeCurrentCommerceIdentity,
} from '../../../../commerce/server/main-account-access';
import { verifyToken } from '@/lib/auth';
import { get } from '../../../../commerce/server/store';
import { errorResponse, json } from '../../../../commerce/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sessionView(user: { id: string; name: string; role: 'admin' | 'user' }) {
  return {
    user: { id: user.id, name: user.name, role: user.role },
    workspaceStorage: {
      legacyOwner: get<{ id: string }>('settings', 'local-operator', 'system')?.id === user.id,
    },
  };
}

function withSession(user: { id: string; name: string; role: 'admin' | 'user' }, request: Request) {
  const response = json(sessionView(user));
  response.cookies.set(COMMERCE_MAIN_SESSION_COOKIE, createSession(user), {
    httpOnly: true,
    sameSite: 'strict',
    secure: new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: 604800,
  });
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const user = identity(request);
    if (user) {
      await authorizeCurrentCommerceIdentity(user);
      return json(sessionView(user));
    }

    // Every main-site account receives an isolated product owner. The product
    // role remains `user`; the authoritative main role is stored only on the
    // reverse binding for revalidation, never for free/admin product access.
    sameOrigin(request);
    const mainPayload = await verifyToken(String(request.headers.get('authorization') || '').replace(/^Bearer /, ''));
    if (mainPayload?.userId) {
      const current = await authorizeCommerceMainAccount(mainPayload.userId);
      return withSession(await ensureSessionForMainUser({
        userId: current.mainUserId,
        username: current.username,
        role: current.role,
      }), request);
    }
    return json({ user: null }, 401);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.json();
    if (body.action === 'main-bind') {
      const payload = await verifyToken(String(body.mainToken || ''));
      if (!payload?.userId) throw Error('主站登录态无效，请先登录主站');
      const current = await authorizeCommerceMainAccount(payload.userId);
      const bound = await ensureSessionForMainUser({
        userId: current.mainUserId,
        username: current.username,
        role: current.role,
      });
      return withSession(bound, request);
    }
    if (body.action === 'logout') {
      revokeSession(request);
      const response = json({ ok: true });
      response.cookies.delete(COMMERCE_MAIN_SESSION_COOKIE);
      return response;
    }
    throw Error('主站带货工作区仅接受主站登录态，请从主站重新进入。');
  } catch (error) {
    return errorResponse(error);
  }
}
