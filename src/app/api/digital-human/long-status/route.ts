import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getLongJobByClientRequestForUser, getLongJobForUser, longErrorResponse } from '@/lib/digital-human-long-repository';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const taskId = request.nextUrl.searchParams.get('taskId') || '';
    const clientRequestId = request.nextUrl.searchParams.get('clientRequestId') || '';
    if (!/^dhl_[0-9a-f]{40}$/u.test(taskId) && !/^digital-long-[a-zA-Z0-9-]{16,90}$/u.test(clientRequestId)) {
      return NextResponse.json({ error: '任务编号无效' }, { status: 400 });
    }
    const task = taskId
      ? await getLongJobForUser(taskId, auth.user.userId)
      : await getLongJobByClientRequestForUser(clientRequestId, auth.user.userId);
    if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    return NextResponse.json(task);
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
