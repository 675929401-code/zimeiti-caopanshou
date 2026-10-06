import { NextRequest } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { readOwnedVideoTaskStatus } from '@/lib/video-task-status';

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  return readOwnedVideoTaskStatus(authorization.user, new URL(request.url).searchParams);
}
