import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getLongJobDownloadForUser, longErrorResponse } from '@/lib/digital-human-long-repository';

export const runtime = 'nodejs';

function safeDownloadName(value: string) {
  const stem = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/\s+/gu, ' ').trim().slice(0, 100) || 'AI数字人长视频';
  return stem.toLowerCase().endsWith('.mp4') ? stem : `${stem}.mp4`;
}

export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const taskId = request.nextUrl.searchParams.get('taskId') || '';
    if (!/^dhl_[0-9a-f]{40}$/u.test(taskId)) return NextResponse.json({ error: '任务编号无效' }, { status: 400 });
    const url = await getLongJobDownloadForUser(taskId, auth.user.userId, safeDownloadName(request.nextUrl.searchParams.get('name') || 'AI数字人长视频.mp4'));
    if (!url) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    return NextResponse.json({ url, expiresIn: 300 });
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
