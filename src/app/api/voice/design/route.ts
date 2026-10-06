import { VOICE_PAID_TRAINING_ENABLED } from '@/lib/vs/feature-policy';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { withAuth, type AuthUser } from '@/lib/api-middleware';
import {
  claimVoiceTrainingProviderCall,
  deriveVoiceTrainingSpeakerId,
  finalizeVoiceTrainingReady,
  markVoiceTrainingProviderAttempt,
  releaseVoiceTrainingTerminal,
} from '@/lib/server/voice-training-lifecycle';
import { normalizeVoiceTrainingStatus } from '@/lib/voice-training-status';
import { designVoice, getActiveApiKey } from '@/lib/vs/volcengine';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type JsonBody = Record<string, unknown>;
type ReservationResult = {
  success?: boolean;
  already_exists?: boolean;
  job_id?: number | string;
  status?: string;
  used_trainings?: number | string;
  max_trainings?: number | string;
  voice_id?: number | string;
  result_payload?: Record<string, unknown>;
};

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function jobKeyFromRequest(request: NextRequest, body: JsonBody): string {
  return cleanString(request.headers.get('Idempotency-Key') || body.clientRequestId || body.idempotencyKey, 220);
}
function migrationNotReady(message: string): boolean {
  return /voice_training|schema cache|function|column .*provider_/i.test(message);
}
function replayResponse(reservation: ReservationResult, jobKey: string) {
  const payload = reservation.result_payload || {};
  const used = Number(reservation.used_trainings);
  const max = Number(reservation.max_trainings);
  return NextResponse.json({
    success: true, message: '声音设计已完成，本次返回原作业终态',
    data: {
      ...payload, voiceId: String(reservation.voice_id || payload.voiceId || ''), jobKey, status: 'ready', alreadyFulfilled: true,
      billing: { licenseUsed: true, trainingsUsed: used, trainingsMax: max, trainingsRemaining: Math.max(0, max - used), chargeAmount: 0 },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    if (!VOICE_PAID_TRAINING_ENABLED) return NextResponse.json({ success:false, code:'VOICE_FEATURE_RETIRED', message:'当前不再开放声音复刻与声音设计，请使用音色模仿；已有声音和记录不受影响' }, {status:410});
    const db = getSupabaseClient();
    let jobKey = '';
    let fingerprint = '';
    let speakerId = '';
    let providerCallStarted = false;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ success: false, code: 'VOICE_DESIGN_REQUEST_INVALID', message: '请求体必须是 JSON 对象' }, { status: 400 });
      }
      const body = parsed as JsonBody;
      const prompt = body.prompt && typeof body.prompt === 'object' && !Array.isArray(body.prompt) ? body.prompt as JsonBody : {};
      jobKey = jobKeyFromRequest(request, body);
      const engine = cleanString(body.engine, 60) || 'volcano';
      const languageValue = Number.isSafeInteger(body.language) ? Number(body.language) : 0;
      const languageLabel = cleanString(body.language, 20) || 'zh';
      const text = cleanString(body.text, 10_000);
      const textPrompt = cleanString(prompt.textPrompt ?? body.textPrompt, 8_000);
      const imageUrl = cleanString(prompt.imageUrl ?? body.imageUrl, 4_000);
      const imageBytes = cleanString(prompt.imageBytes ?? body.imageBytes, 30_000_000);
      if (!jobKey) return NextResponse.json({ success: false, code: 'VOICE_DESIGN_JOB_KEY_REQUIRED', message: '声音设计必须提供稳定 Idempotency-Key' }, { status: 400 });
      if (!textPrompt && !imageUrl && !imageBytes) return NextResponse.json({ success: false, code: 'VOICE_DESIGN_PROMPT_REQUIRED', message: '请至少提供文字提示词或图片参考' }, { status: 400 });
      if (engine !== 'volcano') return NextResponse.json({ success: false, code: 'VOICE_DESIGN_ENGINE_UNSUPPORTED', message: `声音设计不支持引擎 ${engine}` }, { status: 400 });

      speakerId = deriveVoiceTrainingSpeakerId(user.id, jobKey, 'design');
      const voiceName = cleanString(body.voiceName ?? body.name, 100) || `声音设计-${sha256(jobKey).slice(0, 6)}`;
      const sourceInfo = {
        engine, gender: cleanString(body.gender, 40), age: cleanString(body.age, 40),
        personality: cleanString(body.personality, 500), description: cleanString(body.description, 2_000), jobKey,
      };
      fingerprint = sha256(JSON.stringify({
        operation: 'design', voiceName, engine, speakerId, languageValue, sourceInfo,
        text, textPrompt, imageUrl, imageSha256: imageBytes ? sha256(imageBytes) : '',
      }));

      const { data, error } = await db.rpc('reserve_voice_training_authorization_atomic', {
        p_user_id: user.id, p_job_key: jobKey, p_operation_kind: 'design', p_request_fingerprint: fingerprint,
      });
      if (error) {
        const code = migrationNotReady(error.message || '') ? 'MIGRATION_NOT_READY' : /IDEMPOTENCY_CONFLICT/.test(error.message || '') ? 'VOICE_DESIGN_IDEMPOTENCY_CONFLICT' : /LICENSE_REQUIRED/.test(error.message || '') ? 'VOICE_DESIGN_LICENSE_REQUIRED' : 'VOICE_DESIGN_RESERVATION_FAILED';
        return NextResponse.json({ success: false, code, message: code === 'MIGRATION_NOT_READY' ? '声音训练生命周期迁移尚未发布' : '声音设计授权预占失败' }, { status: code === 'VOICE_DESIGN_IDEMPOTENCY_CONFLICT' ? 409 : code === 'VOICE_DESIGN_LICENSE_REQUIRED' ? 402 : 503 });
      }
      const reservation = data as ReservationResult | null;
      if (!reservation?.success || !reservation.job_id || !reservation.status) return NextResponse.json({ success: false, code: 'VOICE_DESIGN_RESERVATION_RESULT_INVALID', message: '授权预占结果无效，未调用供应商' }, { status: 503 });
      if (reservation.already_exists) {
        if (reservation.status === 'completed') return replayResponse(reservation, jobKey);
        if (reservation.status === 'provider_pending' || reservation.status === 'reconciliation_required') {
          return NextResponse.json({ success: true, message: reservation.status === 'reconciliation_required' ? '声音设计待对账，请使用同一作业键查询' : '声音设计仍在训练中，本次未重复调用供应商', data: { ...(reservation.result_payload || {}), jobKey, canResume: true, retryAfterMs: 3_000 } }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
        }
        if (reservation.status !== 'reserved') return NextResponse.json({ success: false, code: 'VOICE_DESIGN_JOB_KEY_RETIRED', message: '该声音设计作业已终态释放' }, { status: 409 });
      }

      if (!(await getActiveApiKey()).trim()) {
        await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation: 'design', fingerprint, terminalKind: 'not_started', reason: 'provider_not_configured' });
        return NextResponse.json({ success: false, code: 'VOICE_PROVIDER_NOT_CONFIGURED', message: '火山语音供应商未配置，未调用上游，授权已释放', data: { jobKey, status: 'failed', terminal: true, released: true } }, { status: 503 });
      }

      const immutableContext = { engine, voiceName, language: languageLabel, sourceInfo };
      const claim = await claimVoiceTrainingProviderCall({
        db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId,
        resultPayload: { ...immutableContext, status: 'pending', submittedAt: new Date().toISOString() },
      });
      if (!claim.claimed) {
        return NextResponse.json({ success: true, message: '声音设计仍在训练中，本次未重复调用供应商', data: { ...(claim.job.result_payload || {}), jobKey, canResume: true, retryAfterMs: 3_000 } }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
      }
      providerCallStarted = true;
      const result = await designVoice({
        speakerId, text, prompt: { textPrompt: textPrompt || undefined, imageUrl: imageUrl || undefined, imageBytes: imageBytes || undefined }, language: languageValue,
      });
      const status = normalizeVoiceTrainingStatus(result.status);
      if (status === 'failed') {
        await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId, lifecycleState: 'provider_pending', providerStatus: 'failed', providerCallStarted: true, resultPayload: { ...immutableContext, status: 'failed' } });
        await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation: 'design', fingerprint, terminalKind: 'provider_failed', reason: 'provider_training_failed' });
        return NextResponse.json({ success: false, code: 'VOICE_DESIGN_PROVIDER_REJECTED', message: '声音设计训练失败，授权已释放', data: { jobKey, status: 'failed', terminal: true, released: true } }, { status: 502 });
      }

      const resultPayload = {
        ...immutableContext, speakerId, status, providerStatus: String(result.status),
        demoAudioUrl: cleanString(result.demoAudio, 2_000) || undefined,
        availableTrainingTimes: Number.isFinite(result.availableTrainingTimes) ? result.availableTrainingTimes : undefined,
      };
      await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId, lifecycleState: 'provider_pending', providerStatus: status, providerCallStarted: true, resultPayload });
      if (status !== 'ready') {
        return NextResponse.json({ success: true, message: '声音设计已受理，等待供应商训练终态', data: { ...resultPayload, jobKey, canResume: true, retryAfterMs: 3_000 } }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
      }

      try {
        const finalized = await finalizeVoiceTrainingReady({ db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId, voiceName, language: languageLabel, sourceInfo, resultPayload });
        const used = Number(finalized.used_trainings);
        const max = Number(finalized.max_trainings);
        return NextResponse.json({
          success: true, message: '声音设计训练已完成并永久保存',
          data: { ...resultPayload, status: 'ready', voiceId: String(finalized.voice_id || ''), jobKey, billing: { licenseUsed: true, trainingsUsed: used, trainingsMax: max, trainingsRemaining: Math.max(0, max - used), chargeAmount: 0 } },
        }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (finalizeError) {
        await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId, lifecycleState: 'reconciliation_required', providerStatus: 'ready', providerCallStarted: true, reconciliationReason: finalizeError instanceof Error ? finalizeError.message : 'finalize_failed', resultPayload }).catch(() => undefined);
        return NextResponse.json({ success: false, code: 'VOICE_DESIGN_RECONCILIATION_REQUIRED', message: '供应商已完成，但本地终态落库待对账；已保留授权，请使用同一作业键查询' }, { status: 503 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (providerCallStarted && jobKey && fingerprint && speakerId) {
        await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation: 'design', fingerprint, speakerId, lifecycleState: 'reconciliation_required', providerStatus: 'unknown', providerCallStarted: true, reconciliationReason: message, resultPayload: { status: 'pending', failure: 'ambiguous_provider_result' } }).catch(() => undefined);
        return NextResponse.json({ success: false, code: 'VOICE_DESIGN_RECONCILIATION_REQUIRED', message: '供应商调用结果不确定；授权和同一作业键已保留，请勿创建新请求' }, { status: 503 });
      }
      const code = migrationNotReady(message) ? 'MIGRATION_NOT_READY' : 'VOICE_DESIGN_INTERNAL_ERROR';
      return NextResponse.json({ success: false, code, message: code === 'MIGRATION_NOT_READY' ? '声音训练生命周期迁移尚未发布' : '声音设计服务暂时不可用' }, { status: 503 });
    }
  });
}
