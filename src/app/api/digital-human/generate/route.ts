import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { findModelByPublicId, toPublicModelId } from '@/lib/public-model-dto';
import { humanBillingSeconds } from '@/features/digital-human/client-state';
import { humanDurationCapabilities, planHumanDuration } from '@/features/digital-human/duration-policy';
import { getVideoInputContract } from '@/lib/video-input-contract';
import { isDigitalHumanWorkspaceModel } from '@/lib/video-model-surface';
import { readGaoruiPersonAssetAdmission } from '@/lib/gaorui-person-asset-admission';
import { POST as generateVideo } from '@/app/api/video/generate/route';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const mode = body.mode;
    const requestId = String(body.clientRequestId || '');
    if (!['photo', 'video'].includes(mode) || !/^digital-[a-zA-Z0-9-]{16,90}$/.test(requestId)) return NextResponse.json({ error: '任务参数无效', task_submitted: false }, { status: 400 });
    const db = getSupabaseClient();
    // Recover the original receipt before signing input URLs again. No resubmission on refresh/replay.
    const prior = await db.from('video_tasks').select('id,task_id_external,model_id,status,billing_price_yuan,provider_asset_preparation')
      .eq('user_id', auth.user.userId).eq('client_request_id', requestId).maybeSingle();
    if (prior.error) return NextResponse.json({ error: '暂时无法确认原任务，请稍后查询', task_submitted: null }, { status: 503 });
    if (prior.data) {
      if (toPublicModelId('video', prior.data.model_id) !== body.modelId) return NextResponse.json({ error: '该请求已绑定原模型，请查询原任务', task_submitted: null }, { status: 409 });
      const preparation = prior.data.provider_asset_preparation as Record<string, unknown> | null;
      if (preparation?.schema === 'gaorui_person_asset_preparation.v1'
        && typeof preparation.operation_id === 'string'
        && /^[0-9a-f-]{36}$/iu.test(preparation.operation_id)
        && ['submitting', 'processing', 'submission_unknown', 'reconciliation_required', 'failed'].includes(String(preparation.state))) {
        return NextResponse.json({
          task_id: prior.data.id, business_task_id: prior.data.id, model_id: body.modelId,
          status: prior.data.status, replayed: true, video_task_submitted: false,
          asset_operation_id: preparation.operation_id,
          asset_preparation_state: preparation.state,
          asset_submission_outcome: preparation.asset_submission_outcome,
          message: '人物素材状态仍需核对；已保留原任务，没有重复提交素材或视频',
          retryable: false,
        });
      }
      return NextResponse.json({ task_id: prior.data.task_id_external || prior.data.id, business_task_id: prior.data.id, model_id: body.modelId,
        status: prior.data.status, price: Number(prior.data.billing_price_yuan), replayed: true });
    }
    const { data: models, error } = await db.from('video_models').select('*').eq('is_active', true).eq('is_hidden', false);
    if (error) return NextResponse.json({ error: '模型列表暂时无法读取', task_submitted: false }, { status: 503 });
    const model = findModelByPublicId('video', (models || []) as Array<Record<string, unknown> & { id?: unknown }>, body.modelId);
    const config = model?.api_protocol_config as Record<string, unknown> | undefined;
    if (!model || !isDigitalHumanWorkspaceModel(model)) return NextResponse.json({ error: '请选择当前可用的数字人模型', task_submitted: false }, { status: 422 });
    const personAssetAdmission = readGaoruiPersonAssetAdmission(model, { surface: 'digital-human' });
    if (!personAssetAdmission.ready) return NextResponse.json({
      error: personAssetAdmission.message,
      error_code: personAssetAdmission.code,
      task_submitted: false,
      video_task_submitted: false,
      asset_preparation_attempted: false,
      retryable: false,
    }, { status: 422 });
    const contract = getVideoInputContract(model);
    if ((mode === 'video') !== contract.requiresSourceVideo) return NextResponse.json({ error: '所选模型与当前创作方式不匹配', task_submitted: false }, { status: 422 });
    const [person, audio] = await Promise.all([
      ownedDigitalHumanAsset(auth.user.userId, String(body.personAssetId || '')),
      ownedDigitalHumanAsset(auth.user.userId, String(body.audioAssetId || '')),
    ]);
    if (person.category !== (mode === 'photo' ? 'image' : 'video') || audio.category !== 'audio') return NextResponse.json({ error: '请上传对应的人物素材和配音音频', task_submitted: false }, { status: 422 });
    const plan = planHumanDuration(humanDurationCapabilities(model), mode, person.duration, audio.duration, body.durationChoice, audio.size);
    if (plan.error) return NextResponse.json({ error: plan.error, error_code: plan.code, task_submitted: false, price: 0 }, { status: 422 });
    const duration = humanBillingSeconds({ publicPrice: Number(model.price_per_use), capabilities: {}, ...model }, plan.seconds);
    const params = {
      model_id: body.modelId, prompt: mode === 'photo' ? '人物自然讲话，口型与配音同步，保持人物形象与背景稳定。' : '保持原视频画面，人物口型与配音同步。',
      image_url: mode === 'photo' ? person.url : '', source_video_url: mode === 'video' ? person.url : '', audio_url: audio.url,
      duration, video_extension: plan.videoExtension, person_asset_id: person.id, audio_asset_id: audio.id, duration_choice: body.durationChoice, resolution: String(body.resolution || config?.default_resolution || '480p'), resolution_tier: String(body.resolution || config?.default_resolution || '480p'),
      aspect_ratio: person.width >= person.height ? '16:9' : '9:16', surface: 'digital-human',
      task_label: `digital-human:${mode}`, batch_id: requestId, card_index: 1, client_request_id: requestId,
    };
    const headers = new Headers(request.headers);
    headers.set('Content-Type', 'application/json'); headers.set('Idempotency-Key', requestId); headers.delete('content-length');
    return generateVideo(new NextRequest(new URL('/api/video/generate', request.url), { method: 'POST', headers, body: JSON.stringify(params) }));
  } catch (error) {
    const message = error instanceof Error && /^(请选择已上传|素材不存在)/u.test(error.message) ? error.message : '数字人任务暂时无法提交，请检查素材后重试';
    return NextResponse.json({ error: message, task_submitted: false }, { status: 422 });
  }
}
