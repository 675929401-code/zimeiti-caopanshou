import { withAuth, type AuthUser } from '@/lib/api-middleware';

type ExtractionAuthorization =
  | { ok: true; userId: string; role: string }
  | { ok: false; response: Response };

const authorizations = new WeakMap<Request, Promise<ExtractionAuthorization>>();

/** Share one current-database authorization between idempotency and billing. */
export function authorizeExtractionRequest(request: Request): Promise<ExtractionAuthorization> {
  const existing = authorizations.get(request);
  if (existing) return existing;
  const pending = (async (): Promise<ExtractionAuthorization> => {
    const result: { user?: AuthUser } = {};
    try {
      const response = await withAuth(request, async user => {
        result.user = user;
        return new Response(null, { status: 204 });
      });
      return result.user
        ? { ok: true, userId: result.user.id, role: result.user.role }
        : { ok: false, response };
    } catch {
      return { ok: false, response: Response.json({ error: '账户状态暂时无法确认，请稍后重试', provider_call_started: false }, { status: 503 }) };
    }
  })();
  authorizations.set(request, pending);
  return pending;
}
