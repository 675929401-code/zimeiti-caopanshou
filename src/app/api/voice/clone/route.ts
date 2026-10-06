import { VOICE_PAID_TRAINING_ENABLED } from '@/lib/vs/feature-policy';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { withAuth, type AuthUser } from '@/lib/api-middleware';
import { validateAudioFileSignature } from '@/lib/audio-file-signature';
import {
  claimVoiceTrainingProviderCall,
  deriveVoiceTrainingSpeakerId,
  finalizeVoiceTrainingReady,
  markVoiceTrainingProviderAttempt,
  releaseVoiceTrainingTerminal,
} from '@/lib/server/voice-training-lifecycle';
import { readOwnedCustomVoiceAudio } from '@/lib/server/custom-voice-assets';
import { getEngineConfig } from '@/lib/store';
import { routeClone } from '@/lib/tts/router';
import type { CloneRequest, CloneResponse, StoredEngineConfig, TTSEngine } from '@/lib/types';
import { normalizeVoiceTrainingStatus } from '@/lib/voice-training-status';
import { cloneVoice, getActiveApiKey } from '@/lib/vs/volcengine';
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
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function jobKeyFromRequest(request: NextRequest, body: JsonBody): string {
  return cleanString(request.headers.get('Idempotency-Key') || body.clientRequestId || body.idempotencyKey, 220);
}
function migrationNotReady(message: string): boolean {
  return /voice_training|schema cache|function|column .*provider_/i.test(message);
}
function providerPayload(reservation: ReservationResult, jobKey: string) {
  return NextResponse.json({
    success: true,
    message: reservation.status === 'reconciliation_required'
      ? '供应商任务状态待对账，请使用同一请求继续查询，切勿新建作业'
      : '相同声音克隆作业仍在训练中，本次未重复调用供应商',
    data: {
      ...(reservation.result_payload || {}),
      jobKey,
      status: reservation.status === 'reconciliation_required' ? 'pending' : (reservation.result_payload?.status || 'training'),
      canResume: true,
      retryAfterMs: 3_000,
    },
  }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
}
function replayResponse(result: ReservationResult, jobKey: string) {
  const payload = result.result_payload || {};
  const speakerId = cleanString(payload.speakerId, 500);
  const voiceId = result.voice_id == null ? cleanString(payload.voiceId, 100) : String(result.voice_id);
  const used = Number(result.used_trainings);
  const max = Number(result.max_trainings);
  if (!speakerId || !voiceId || !Number.isSafeInteger(used) || !Number.isSafeInteger(max)) {
    return NextResponse.json({ success: false, code: 'VOICE_CLONE_REPLAY_INVALID', message: '持久化终态不完整，拒绝重复交付' }, { status: 503 });
  }
  return NextResponse.json({
    success: true,
    message: '声音克隆已完成，本次返回原作业终态',
    data: {
      ...payload, speakerId, voiceId, jobKey, status: 'ready', alreadyFulfilled: true,
      billing: { licenseUsed: true, trainingsUsed: used, trainingsMax: max, trainingsRemaining: Math.max(0, max - used), chargeAmount: 0 },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    if (!VOICE_PAID_TRAINING_ENABLED) return NextResponse.json({ success:false, code:'VOICE_FEATURE_RETIRED', message:'当前不再开放声音复刻与声音设计，请使用音色模仿；已有声音和记录不受影响' }, {status:410});
    const db = getSupabaseClient();
    let fingerprint = '';
    let jobKey = '';
    let speakerId = '';
    let providerCallStarted = false;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ success: false, code: 'VOICE_CLONE_REQUEST_INVALID', message: '请求体必须是 JSON 对象' }, { status: 400 });
      }
      const body = parsed as JsonBody;
      jobKey = jobKeyFromRequest(request, body);
      const voiceName = cleanString(body.voiceName ?? body.name, 100);
      const engine = cleanString(body.engine, 60) || 'volcano';
      const language = cleanString(body.language, 20) || 'zh';
      const referenceAudioId = cleanString(body.referenceAudioId, 160);
      let audioData = cleanString(body.audioData ?? body.audioBase64, 30_000_000);
      let audioFormat = (cleanString(body.audioFormat, 20) || 'wav').toLowerCase();
      if (referenceAudioId) {
        const asset = await readOwnedCustomVoiceAudio(user.id, referenceAudioId).catch(() => null);
        if (!asset) return NextResponse.json({ success: false, code: 'VOICE_CLONE_REFERENCE_FORBIDDEN', message: '参考音频不存在或不属于当前账号' }, { status: 404 });
        audioData = asset.bytes.toString('base64');
        audioFormat = asset.extension;
      }
      if (!jobKey) return NextResponse.json({ success: false, code: 'VOICE_CLONE_JOB_KEY_REQUIRED', message: '声音克隆必须提供稳定 Idempotency-Key' }, { status: 400 });
      if (!voiceName) return NextResponse.json({ success: false, code: 'VOICE_CLONE_NAME_REQUIRED', message: '请填写声音名称' }, { status: 400 });
      if (!audioData) return NextResponse.json({ success: false, code: 'VOICE_CLONE_AUDIO_REQUIRED', message: '缺少参考音频' }, { status: 400 });
      if (!['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(audioFormat)) {
        return NextResponse.json({ success: false, code: 'VOICE_CLONE_AUDIO_FORMAT_UNSUPPORTED', message: `不支持的音频格式：${audioFormat}` }, { status: 400 });
      }
      if (!referenceAudioId) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioData) || audioData.length % 4 !== 0) {
          return NextResponse.json({ success: false, code: 'VOICE_CLONE_AUDIO_INVALID', message: '参考音频编码无效' }, { status: 400 });
        }
        const bytes = Buffer.from(audioData, 'base64');
        if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) {
          return NextResponse.json({ success: false, code: 'VOICE_CLONE_AUDIO_SIZE_INVALID', message: '参考音频必须大于 0 且不超过 15MB' }, { status: 413 });
        }
        try {
          const declaredMime: Record<string, string> = {
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
          };
          validateAudioFileSignature({ bytes, fileName: `reference.${audioFormat}`, mimeType: declaredMime[audioFormat] });
        } catch {
          return NextResponse.json({ success: false, code: 'VOICE_CLONE_AUDIO_SIGNATURE_INVALID', message: '参考音频扩展名、MIME 或真实容器不一致' }, { status: 400 });
        }
      }

      speakerId = deriveVoiceTrainingSpeakerId(user.id, jobKey, 'clone');
      fingerprint = sha256(JSON.stringify({
        operation: 'clone', referenceAudioId, audioSha256: sha256(audioData), audioFormat,
        voiceName, engine, language, speakerId,
        text: cleanString(body.text ?? body.demoText, 2_000),
      }));
      const { data, error } = await db.rpc('reserve_voice_training_authorization_atomic', {
        p_user_id: user.id, p_job_key: jobKey, p_operation_kind: 'clone', p_request_fingerprint: fingerprint,
      });
      if (error) {
        const code = migrationNotReady(error.message || '') ? 'MIGRATION_NOT_READY' : /IDEMPOTENCY_CONFLICT/.test(error.message || '') ? 'VOICE_CLONE_IDEMPOTENCY_CONFLICT' : /LICENSE_REQUIRED/.test(error.message || '') ? 'VOICE_CLONE_LICENSE_REQUIRED' : 'VOICE_CLONE_RESERVATION_FAILED';
        return NextResponse.json({ success: false, code, message: code === 'MIGRATION_NOT_READY' ? '声音训练生命周期迁移尚未发布' : '声音训练授权预占失败' }, { status: code === 'VOICE_CLONE_IDEMPOTENCY_CONFLICT' ? 409 : code === 'VOICE_CLONE_LICENSE_REQUIRED' ? 402 : 503 });
      }
      const reservation = data as ReservationResult | null;
      if (!reservation?.success || !reservation.job_id || !reservation.status) {
        return NextResponse.json({ success: false, code: 'VOICE_CLONE_RESERVATION_RESULT_INVALID', message: '授权预占结果无效，未调用供应商' }, { status: 503 });
      }
      if (reservation.already_exists) {
        if (reservation.status === 'completed') return replayResponse(reservation, jobKey);
        if (reservation.status === 'provider_pending' || reservation.status === 'reconciliation_required') return providerPayload(reservation, jobKey);
        if (reservation.status !== 'reserved') {
          return NextResponse.json({ success: false, code: 'VOICE_CLONE_JOB_KEY_RETIRED', message: '该作业已终态释放，请在确认失败后重新提交' }, { status: 409 });
        }
      }

      let engineConfig: StoredEngineConfig | undefined;
      if (engine === 'volcano') {
        if (!(await getActiveApiKey()).trim()) {
          await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation: 'clone', fingerprint, terminalKind: 'not_started', reason: 'provider_not_configured' });
          return NextResponse.json({ success: false, code: 'VOICE_PROVIDER_NOT_CONFIGURED', message: '火山语音供应商未配置，未调用上游，授权已释放', data: { jobKey, status: 'failed', terminal: true, released: true } }, { status: 503 });
        }
      } else {
        engineConfig = getEngineConfig(engine as TTSEngine);
        if (!engineConfig?.enabled) {
          await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation: 'clone', fingerprint, terminalKind: 'not_started', reason: 'engine_disabled' });
          return NextResponse.json({ success: false, code: 'VOICE_CLONE_ENGINE_DISABLED', message: `引擎 ${engine} 未启用`, data: { jobKey, status: 'failed', terminal: true, released: true } }, { status: 400 });
        }
      }

      const immutableContext = { engine, voiceName, language, sourceInfo: { engine, description: `通过 ${engine} 克隆的声音`, jobKey } };
      const claim = await claimVoiceTrainingProviderCall({
        db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId,
        resultPayload: { ...immutableContext, status: 'pending', submittedAt: new Date().toISOString() },
      });
      if (!claim.claimed) {
        return providerPayload({ status: claim.job.status, result_payload: claim.job.result_payload || undefined }, jobKey);
      }
      providerCallStarted = true;

      let providerResult: CloneResponse;
      if (engine === 'volcano') {
        const result = await cloneVoice({
          speakerId, audioBase64: audioData, audioFormat,
          language: Number(body.languageCode) || 0,
          text: cleanString(body.text, 2_000) || undefined,
          referenceText: cleanString(body.referenceText, 2_000) || undefined,
          demoText: cleanString(body.demoText, 80) || undefined,
        });
        const status = normalizeVoiceTrainingStatus(result.status);
        providerResult = {
          success: status !== 'failed',
          data: {
            cloneId: result.speakerId, speakerId: result.speakerId, status,
            providerStatus: result.status, estimatedTime: status === 'ready' ? 0 : 60,
            demoAudioUrl: result.speakerStatus?.find((entry) => entry.demoAudio)?.demoAudio,
            availableTrainingTimes: result.availableTrainingTimes,
            speakerStatus: result.speakerStatus || [],
          },
          message: status === 'failed' ? '火山声音克隆训练失败' : '火山声音克隆请求已受理',
        };
      } else {
        providerResult = await routeClone({ ...body, audioData, audioFormat, voiceName, language, engine } as unknown as CloneRequest, engineConfig!);
      }

      const providerData = providerResult.data;
      const normalizedStatus = normalizeVoiceTrainingStatus(providerData?.status);
      const providerSpeakerId = cleanString(providerData?.speakerId, 500);
      const providerConfirmedFailed = Boolean(providerSpeakerId) && normalizedStatus === 'failed';
      if (providerConfirmedFailed) {
        await markVoiceTrainingProviderAttempt({
          db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId: providerSpeakerId,
          lifecycleState: 'provider_pending', providerStatus: 'failed', providerCallStarted: true,
          resultPayload: { ...immutableContext, status: 'failed', failureCode: providerResult.code || 'provider_rejected' },
        });
        await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation: 'clone', fingerprint, terminalKind: 'provider_failed', reason: providerResult.message || 'provider_failed' });
        return NextResponse.json({ success: false, code: providerResult.code || 'VOICE_CLONE_PROVIDER_REJECTED', message: providerResult.message || '声音克隆训练失败，授权已释放', data: { jobKey, status: 'failed', terminal: true, released: true } }, { status: 502 });
      }
      if (!providerResult.success || !providerData || !providerSpeakerId) {
        await markVoiceTrainingProviderAttempt({
          db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId,
          lifecycleState: 'reconciliation_required', providerStatus: 'unknown', providerCallStarted: true,
          reconciliationReason: providerResult.message || 'provider_result_incomplete',
          resultPayload: { ...immutableContext, status: 'pending', failureCode: providerResult.code || 'provider_result_incomplete' },
        }).catch(() => undefined);
        return NextResponse.json({
          success: false,
          code: 'VOICE_CLONE_RECONCILIATION_REQUIRED',
          message: '供应商请求已发出但未返回可证明的终态；授权和同一作业键已保留，请勿创建新请求',
        }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }

      const resultPayload = {
        ...immutableContext,
        cloneId: cleanString(providerData.cloneId, 500) || providerSpeakerId,
        speakerId: providerSpeakerId,
        status: normalizedStatus,
        providerStatus: String(providerData.providerStatus ?? providerData.status ?? ''),
        estimatedTime: Number.isFinite(providerData.estimatedTime) ? providerData.estimatedTime : 0,
        demoAudioUrl: cleanString(providerData.demoAudioUrl, 2_000) || undefined,
      };
      await markVoiceTrainingProviderAttempt({
        db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId: providerSpeakerId,
        lifecycleState: 'provider_pending', providerStatus: normalizedStatus, providerCallStarted: true, resultPayload,
      });
      if (normalizedStatus !== 'ready') {
        return NextResponse.json({ success: true, message: '声音克隆已受理，等待供应商训练终态', data: { ...resultPayload, jobKey, canResume: true, retryAfterMs: 3_000 } }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
      }

      try {
        const finalized = await finalizeVoiceTrainingReady({ db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId: providerSpeakerId, voiceName, language, sourceInfo: immutableContext.sourceInfo, resultPayload });
        const used = Number(finalized.used_trainings);
        const max = Number(finalized.max_trainings);
        return NextResponse.json({
          success: true, message: '声音克隆训练已完成并永久保存',
          data: { ...resultPayload, status: 'ready', voiceId: String(finalized.voice_id || ''), voiceName, jobKey, billing: { licenseUsed: true, trainingsUsed: used, trainingsMax: max, trainingsRemaining: Math.max(0, max - used), chargeAmount: 0 } },
        }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (finalizeError) {
        await markVoiceTrainingProviderAttempt({
          db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId: providerSpeakerId,
          lifecycleState: 'reconciliation_required', providerStatus: 'ready', providerCallStarted: true,
          reconciliationReason: finalizeError instanceof Error ? finalizeError.message : 'finalize_failed', resultPayload,
        }).catch(() => undefined);
        return NextResponse.json({ success: false, code: 'VOICE_CLONE_RECONCILIATION_REQUIRED', message: '供应商已完成，但本地终态落库待对账；已保留授权，请使用同一作业键查询' }, { status: 503 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (providerCallStarted && fingerprint && jobKey && speakerId) {
        await markVoiceTrainingProviderAttempt({
          db, userId: user.id, jobKey, operation: 'clone', fingerprint, speakerId,
          lifecycleState: 'reconciliation_required', providerStatus: 'unknown', providerCallStarted: true,
          reconciliationReason: message, resultPayload: { status: 'pending', failure: 'ambiguous_provider_result' },
        }).catch(() => undefined);
        return NextResponse.json({ success: false, code: 'VOICE_CLONE_RECONCILIATION_REQUIRED', message: '供应商调用结果不确定；授权和同一作业键已保留，请勿创建新请求' }, { status: 503 });
      }
      const code = migrationNotReady(message) ? 'MIGRATION_NOT_READY' : 'VOICE_CLONE_INTERNAL_ERROR';
      return NextResponse.json({ success: false, code, message: code === 'MIGRATION_NOT_READY' ? '声音训练生命周期迁移尚未发布' : '声音克隆服务暂时不可用' }, { status: 503 });
    }
  });
}
