import { NextRequest, NextResponse } from 'next/server';

import { withAuth, type AuthUser } from '@/lib/api-middleware';
import { inspectVolcanoVoiceProviderConfig } from '@/lib/server/voice-provider-config';
import {
  finalizeVoiceTrainingReady,
  isVoiceTrainingJobExpired,
  loadOwnedVoiceTrainingJob,
  markVoiceTrainingProviderAttempt,
  releaseVoiceTrainingTerminal,
  type VoiceTrainingOperation,
} from '@/lib/server/voice-training-lifecycle';
import { normalizeVoiceTrainingStatus } from '@/lib/voice-training-status';
import { getVoiceStatus } from '@/lib/vs/volcengine';
import { getSupabaseClient } from '@/storage/database/supabase-client';

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const VOICE_TASK_TABLES = {
  voice_generation_requests: 'id,request_id,user_id,client_request_id,phase,payload_fingerprint,model_id,billing_idempotency_key,quoted_credits,charge_credits,refunded_credits,billing_exempt,state,wallet_operation_id,refund_scopes,asset_id,generation_id,provider_task_id,response,error,price_snapshot,metadata,started_at,updated_at,completed_at,refunded_at',
  voice_training_authorization_jobs: 'id,user_id,job_key,operation_kind,request_fingerprint,license_id,status,provider_speaker_id,voice_id,result_payload,provider_call_started_at,provider_last_checked_at,provider_last_status,reconciliation_reason,reserved_used_before,reserved_used_after,max_trainings,created_at,updated_at',
};
const VOICE_TASK_RPCS = [
  'begin_voice_generation_atomic', 'finalize_voice_generation_atomic', 'refund_voice_generation_atomic',
  'reserve_voice_training_authorization_atomic', 'release_voice_training_authorization_atomic',
  'finalize_voice_training_authorization_atomic', 'claim_voice_training_provider_call_atomic',
  'mark_voice_training_provider_attempt_atomic', 'release_voice_training_terminal_atomic',
  'finalize_voice_training_ready_atomic', 'apply_wallet_operation_atomic',
] as const;

async function inspectVoiceTaskSchema(): Promise<'ready' | 'missing' | 'unavailable'> {
  try {
    // Initialize the existing protected environment loader, then use only GETs.
    // HEAD may report success for a missing PostgREST table on older gateways.
    const db = getSupabaseClient();
    const base = process.env.COZE_SUPABASE_URL?.trim();
    const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!base || !key) return 'unavailable';
    const response = await fetch(new URL('rest/v1/', `${base.replace(/\/+$/u, '')}/`), {
      method: 'GET',
      headers: { Accept: 'application/openapi+json', 'Accept-Profile': 'public', Authorization: `Bearer ${key}`, apikey: key },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return 'unavailable';
    const document = record(await response.json());
    if (!document.paths || typeof document.paths !== 'object') return 'unavailable';
    const paths = record(document.paths);
    if (VOICE_TASK_RPCS.some((name) => !record(paths[`/rpc/${name}`]).post)) return 'missing';
    const reads = await Promise.all(Object.entries(VOICE_TASK_TABLES).map(([table, columns]) =>
      db.from(table).select(columns).limit(0).abortSignal(AbortSignal.timeout(5_000))));
    if (reads.some(({ error }) => error && ['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'].includes(error.code))) return 'missing';
    return reads.some(({ error }) => error) ? 'unavailable' : 'ready';
  } catch {
    return 'unavailable';
  }
}

// Zero-cost local/database preflight. No provider request is made here.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const provider = req.nextUrl.searchParams.get('provider') || 'volcano';
  if (provider !== 'volcano') return NextResponse.json({ success: false, code: 'VOICE_PROVIDER_UNSUPPORTED', data: { provider, available: false, canSubmit: false, upstreamCalls: 0, creditsCharged: 0 } }, { status: 400 });
  try {
    const state = await inspectVolcanoVoiceProviderConfig();
    const schema = await inspectVoiceTaskSchema();
    const canSubmit = state.configured && schema === 'ready';
    return NextResponse.json({
      success: schema === 'ready',
      ...(schema === 'ready' ? {} : { code: schema === 'missing' ? 'MIGRATION_NOT_READY' : 'VOICE_DATABASE_STATUS_UNAVAILABLE' }),
      data: { provider, available: state.configured, canSubmit, configurationReady: canSubmit,
        readinessScope: 'configuration', upstreamChecked: false, generationVerified: false,
        schemaReady: schema === 'ready', migrationStatus: schema, source: state.source, upstreamCalls: 0, creditsCharged: 0 },
      message: schema === 'missing' ? '语音任务服务尚未就绪，本次不会提交生成或产生费用。'
        : schema === 'unavailable' ? '语音任务服务状态暂时无法确认，本次不会提交生成或产生费用。'
          : state.configured ? '语音服务配置已就绪；当前生成权限和额度尚未确认。' : '语音服务尚未配置，本次不会提交生成或产生费用。',
    }, { status: schema === 'ready' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ success: false, code: 'VOICE_PROVIDER_STATUS_UNAVAILABLE', message: '语音服务状态暂时无法确认，本次不会提交生成或产生费用。', data: { provider, available: false, canSubmit: false, upstreamCalls: 0, creditsCharged: 0 } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return withAuth(req, async (user: AuthUser) => {
    const db = getSupabaseClient();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const jobKey = cleanString(body.jobKey ?? body.clientRequestId, 220);
    const operation = cleanString(body.operationKind, 20) as VoiceTrainingOperation;
    if (!jobKey || !['clone', 'design'].includes(operation)) {
      return NextResponse.json({ success: false, code: 'VOICE_STATUS_JOB_REQUIRED', message: '必须提供 jobKey 和 operationKind；不接受客户端 speakerId 查询' }, { status: 400 });
    }

    let job;
    try {
      job = await loadOwnedVoiceTrainingJob(db, user.id, jobKey, operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ success: false, code: /column .*provider_|schema cache/i.test(message) ? 'MIGRATION_NOT_READY' : 'VOICE_STATUS_STORE_UNAVAILABLE', message: '声音训练状态存储暂不可用' }, { status: 503 });
    }
    if (!job) return NextResponse.json({ success: false, code: 'VOICE_STATUS_JOB_NOT_FOUND', message: '当前账号没有该声音训练作业' }, { status: 404 });
    const payload = record(job.result_payload);
    if (job.status === 'completed') {
      return NextResponse.json({ success: true, message: '声音训练已完成', data: { ...payload, jobKey, voiceId: job.voice_id, status: 'ready', alreadyFulfilled: true } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (job.status === 'released') {
      return NextResponse.json({ success: false, code: 'VOICE_TRAINING_TERMINAL_FAILED', message: '声音训练已确认失败，授权已释放', data: { jobKey, status: 'failed', terminal: true } }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
    }
    if (job.status === 'reserved' || !job.provider_speaker_id) {
      return NextResponse.json({ success: true, message: '声音训练请求正在持久化，未重复调用供应商', data: { ...payload, jobKey, status: 'pending', canResume: true, retryAfterMs: 3_000 } }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
    }

    const speakerId = cleanString(job.provider_speaker_id, 500);
    const fingerprint = cleanString(job.request_fingerprint, 64);
    const voiceName = cleanString(payload.voiceName, 100) || `${operation === 'clone' ? '克隆' : '设计'}音色`;
    const language = cleanString(payload.language, 20) || 'zh';
    const sourceInfo = record(payload.sourceInfo);
    try {
      const result = await getVoiceStatus(speakerId);
      const status = normalizeVoiceTrainingStatus(result.status);
      const resultPayload = {
        ...payload,
        speakerId,
        status,
        providerStatus: String(result.status),
        demoAudioUrl: result.speakerStatus.find((entry) => entry.demoAudio)?.demoAudio,
        speakerStatus: result.speakerStatus,
      };

      if (status === 'failed') {
        await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation, fingerprint, speakerId, lifecycleState: 'provider_pending', providerStatus: 'failed', providerCallStarted: true, resultPayload });
        await releaseVoiceTrainingTerminal({ db, userId: user.id, jobKey, operation, fingerprint, terminalKind: 'provider_failed', reason: 'provider_status_failed' });
        return NextResponse.json({ success: false, code: 'VOICE_TRAINING_TERMINAL_FAILED', message: '声音训练已确认失败，授权已释放', data: { jobKey, status: 'failed', terminal: true } }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
      }

      if (status !== 'ready') {
        const expired = isVoiceTrainingJobExpired(job);
        await markVoiceTrainingProviderAttempt({
          db, userId: user.id, jobKey, operation, fingerprint, speakerId,
          lifecycleState: expired ? 'reconciliation_required' : 'provider_pending',
          providerStatus: status, providerCallStarted: true,
          reconciliationReason: expired ? 'provider_nonterminal_timeout' : undefined,
          resultPayload,
        });
        return NextResponse.json({
          success: true,
          message: expired ? '训练超过等待窗口，已转入对账；授权保持预占，未重复调用供应商' : '声音训练进行中',
          data: { ...resultPayload, jobKey, canResume: true, reconciliationRequired: expired, retryAfterMs: expired ? 30_000 : 3_000 },
        }, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': expired ? '30' : '3' } });
      }

      try {
        const finalized = await finalizeVoiceTrainingReady({ db, userId: user.id, jobKey, operation, fingerprint, speakerId, voiceName, language, sourceInfo, resultPayload });
        return NextResponse.json({ success: true, message: '声音训练已完成并永久保存', data: { ...resultPayload, jobKey, status: 'ready', voiceId: String(finalized.voice_id || ''), billing: { licenseUsed: true, trainingsUsed: Number(finalized.used_trainings), trainingsMax: Number(finalized.max_trainings), chargeAmount: 0 } } }, { headers: { 'Cache-Control': 'no-store' } });
      } catch (finalizeError) {
        await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation, fingerprint, speakerId, lifecycleState: 'reconciliation_required', providerStatus: 'ready', providerCallStarted: true, reconciliationReason: finalizeError instanceof Error ? finalizeError.message : 'finalize_failed', resultPayload }).catch(() => undefined);
        return NextResponse.json({ success: false, code: 'VOICE_TRAINING_RECONCILIATION_REQUIRED', message: '供应商已完成，但本地终态落库待对账；授权保持预占，请继续使用同一作业键' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
    } catch (error) {
      await markVoiceTrainingProviderAttempt({ db, userId: user.id, jobKey, operation, fingerprint, speakerId, lifecycleState: 'reconciliation_required', providerStatus: 'unknown', providerCallStarted: true, reconciliationReason: error instanceof Error ? error.message : 'status_query_failed', resultPayload: { ...payload, status: 'pending' } }).catch(() => undefined);
      return NextResponse.json({ success: false, code: 'VOICE_STATUS_RECONCILIATION_REQUIRED', message: '供应商状态暂不可确认；授权和作业键已保留，请勿新建请求' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  });
}
