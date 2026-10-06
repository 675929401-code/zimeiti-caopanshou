import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { toPublicModelId } from '@/lib/public-model-dto';

export const dynamic = 'force-dynamic';

/** Recover a lost submit response from the original owned request; never dispatch a provider job. */
export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const requestId = request.nextUrl.searchParams.get('clientRequestId') || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(requestId)) {
    return NextResponse.json({ error: '视频请求编号无效' }, { status: 400 });
  }
  const result = await getSupabaseClient().from('video_tasks')
    .select('id,model_id,task_id_external,status,submission_error_code,billing_state,price_charged')
    .eq('user_id', authorization.user.userId).eq('client_request_id', requestId).maybeSingle();
  if (result.error) return NextResponse.json({ error: '暂时无法查询原视频任务，请稍后再试' }, { status: 503 });
  if (!result.data) return NextResponse.json({
    found: false,
    canResubmit: true,
    sameRequestKeyRequired: true,
    message: '服务器未找到该请求号对应的持久任务；可由用户明确重试，重试必须沿用原请求号以防止并发重复投递',
  }, { headers: { 'Cache-Control': 'private, no-store' } });
  return NextResponse.json({ found: true, taskId: result.data.task_id_external || result.data.id, businessTaskId: result.data.id, modelId: toPublicModelId('video', result.data.model_id),
    status: result.data.status, canResubmit: false, billingState: result.data.billing_state,
    priceCharged: Number.isFinite(Number(result.data.price_charged)) ? Math.max(0, Number(result.data.price_charged)) : undefined,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
