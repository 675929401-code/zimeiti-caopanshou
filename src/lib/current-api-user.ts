import { withAuth, type AuthUser } from '@/lib/api-middleware';

type CurrentApiUser = Omit<AuthUser, 'role'> & { userId: string; username: string; role: 'admin' | 'student' };
type Authorization = { ok: true; user: CurrentApiUser } | { ok: false; response: Response };
const authorizations = new WeakMap<Request, Promise<Authorization>>();

/** Reuse the current database role and account state within one request. */
export function authorizeCurrentApiUser(request: Request): Promise<Authorization> {
 const cached = authorizations.get(request);
 if (cached) return cached;
 const pending = (async (): Promise<Authorization> => {
  const resolved: { user?: CurrentApiUser } = {};
  try {
   const response = await withAuth(request, async user => {
    resolved.user = { ...user, userId: user.id, username: user.email, role: user.role === 'admin' ? 'admin' : 'student' };
    return new Response(null, { status: 204 });
   });
   return resolved.user ? { ok: true, user: resolved.user } : { ok: false, response };
  } catch {
   return { ok: false, response: Response.json({ error: '账户状态暂时无法确认，请稍后重试', code: 'ACCOUNT_STATUS_UNAVAILABLE' }, { status: 503 }) };
  }
 })();
 authorizations.set(request, pending);
 return pending;
}
