import { getTokenFromHeaders } from '@/lib/auth';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { verifyVideoAccessTicket, type VideoAccessIdentity, type VideoAccessScope } from '@/lib/video-access-ticket';

export async function authorizeVideoMediaRequest(request: Request, taskId: string, scope: VideoAccessScope): Promise<{ ok: true; user: VideoAccessIdentity } | { ok: false; response: Response }> {
  if (getTokenFromHeaders(request.headers)) {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization;
    return { ok: true, user: { userId: authorization.user.userId, role: authorization.user.role } };
  }
  const ticket = new URL(request.url).searchParams.get('media_ticket');
  const user = ticket ? await verifyVideoAccessTicket(ticket, { taskId, scope }) : null;
  if (!user) return { ok: false, response: Response.json({ error: '播放或下载凭据已失效，请重新登录后打开', code: 'MEDIA_ACCESS_EXPIRED' }, { status: 401 }) };
  return { ok: true, user };
}
