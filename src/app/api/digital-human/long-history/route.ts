import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { hideLongJobHistory, listLongJobsForUser, longErrorResponse } from '@/lib/digital-human-long-repository';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const limit = Number(request.nextUrl.searchParams.get('limit') || 30);
    const offset = Number(request.nextUrl.searchParams.get('offset') || 0);
    const page = await listLongJobsForUser(auth.user.userId, limit, offset);
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const taskId = request.nextUrl.searchParams.get('taskId') || '';
    if (!/^dhl_[0-9a-f]{40}$/u.test(taskId)) return NextResponse.json({ error: '任务编号无效' }, { status: 400 });
    await hideLongJobHistory(taskId, auth.user.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
