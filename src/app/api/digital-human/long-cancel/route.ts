import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { cancelLongJob, longErrorResponse } from '@/lib/digital-human-long-repository';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const taskId = String(body.taskId || '');
    if (!/^dhl_[0-9a-f]{40}$/u.test(taskId)) return NextResponse.json({ error: '任务编号无效' }, { status: 400 });
    const result = await cancelLongJob(taskId, auth.user.userId);
    if (result === 'not_found') return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    if (result === 'started') return NextResponse.json({ error: '任务已经提交上游，不能远程取消；系统会继续保存结果', status: 'started' }, { status: 409 });
    return NextResponse.json({ taskId, status: 'cancelled', message: '任务已取消，本次未扣费' });
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

