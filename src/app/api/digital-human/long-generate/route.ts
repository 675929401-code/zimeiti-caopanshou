import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { createLongDigitalHumanJob } from '@/lib/digital-human-long-create';
import { longErrorResponse } from '@/lib/digital-human-long-repository';
import { startDigitalHumanLongWorker } from '@/lib/digital-human-long-worker';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const result = await createLongDigitalHumanJob({
      userId: auth.user.userId,
      publicModelId: String(body.modelId || ''),
      clientRequestId: String(body.clientRequestId || ''),
      personAssetId: String(body.personAssetId || ''),
      audioAssetId: String(body.audioAssetId || ''),
      durationChoice: String(body.durationChoice || ''),
      resolution: String(body.resolution || '720p'),
      boundaries: body.boundaries,
    });
    startDigitalHumanLongWorker();
    return NextResponse.json({ ...result, task_submitted: true });
  } catch (error) {
    const response = longErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
