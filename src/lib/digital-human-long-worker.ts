import 'server-only';

import { randomUUID } from 'node:crypto';

import { executeCashDeduction } from '@/lib/billing-executor';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { digitalModelHash, digitalProviderKey } from '@/lib/digital-video-dispatch';
import {
  beginLongSegmentPost,
  bindLongSegmentProvider,
  claimLongFinalization,
  claimLongSegment,
  completeLongSegment,
  completedLongSegmentsForMerge,
  finalizeLongJob,
  markLongJobMerged,
  markLongSegmentPrepared,
  retryLongSegmentPreparation,
  transitionLongSegment,
  type ClaimedLongSegment,
  type LongParentRow,
} from '@/lib/digital-human-long-repository';
import {
  mergeLongDigitalHumanSegments,
  persistLongSegmentProviderVideo,
  prepareLongDigitalHumanSegment,
} from '@/lib/digital-human-long-media';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { isUserAccountDisabled } from '@/lib/user-account-status';
import { submitVideoTask, pollVideoTask, type VideoModelConfig } from '@/lib/video-adapter';
import { isReleaseVerifiedVideoChannelHealth } from '@/lib/video-channel-health-release';
import { classifyVideoProviderError } from '@/lib/video-error-policy';
import { recordVideoSubmission, recordVideoTerminalOutcome } from '@/lib/video-terminal-accounting';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';

function text(value: unknown) { return String(value || ''); }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

async function currentModel(parent: LongParentRow) {
  const db = getSupabaseAdminClient();
  const [{ data: raw, error }, { data: health, error: healthError }] = await Promise.all([
    db.from('video_models').select('*').eq('id', text(parent.model_id)).single(),
    db.from('video_channel_health').select('*').eq('channel_id', text(parent.model_id)).maybeSingle(),
  ]);
  if (error || !raw || raw.is_active !== true || raw.is_hidden === true || raw.protocol_type !== 'dashscope_video_retalk') {
    throw new Error('DIGITAL_HUMAN_LONG_MODEL_UNAVAILABLE');
  }
  if (healthError || !isReleaseVerifiedVideoChannelHealth(health)) throw new Error('DIGITAL_HUMAN_LONG_MODEL_UNVERIFIED');
  const model = {
    ...raw,
    api_key: resolveProviderSecret(raw.api_key),
    model_name: raw.model_name || raw.id,
    api_protocol_config: raw.api_protocol_config || undefined,
  } as VideoModelConfig;
  if (digitalModelHash(model) !== parent.model_hash || digitalProviderKey(model) !== parent.provider_key) {
    throw new Error('DIGITAL_HUMAN_LONG_MODEL_CONFIGURATION_CHANGED');
  }
  return model;
}

async function accountCanDispatch(parent: LongParentRow) {
  const { data: user, error } = await getSupabaseAdminClient().from('users')
    .select('id,role,is_active,status,cash_balance,member_status,member_expires_at')
    .eq('id', text(parent.user_id)).single();
  if (error || !user || isUserAccountDisabled(user)) throw new Error('DIGITAL_HUMAN_LONG_ACCOUNT_UNAVAILABLE');
  const expired = ['inactive', 'expired'].includes(text(user.member_status))
    || Boolean(user.member_expires_at && Date.parse(text(user.member_expires_at)) < Date.now());
  if (user.role !== 'admin' && expired) throw new Error('MEMBERSHIP_REQUIRED');
  if (number(user.cash_balance) + 0.0001 < number(parent.locked_price_yuan)) throw new Error('INSUFFICIENT_CASH_BALANCE');
}

async function failSegment(job: ClaimedLongSegment, code: string, message: string) {
  await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'failed', code, message });
}

async function prepareAndSubmit(job: ClaimedLongSegment) {
  try {
    await accountCanDispatch(job.parent);
    const model = await currentModel(job.parent);
    const prepared = await prepareLongDigitalHumanSegment({
      parentId: text(job.parent.id),
      userId: text(job.parent.user_id),
      sourceVideoAssetId: text(job.parent.source_video_asset_id),
      sourceAudioAssetId: text(job.parent.source_audio_asset_id),
      sourceVideoDurationSeconds: number(job.parent.source_video_duration_seconds),
      segment: job,
    });
    await markLongSegmentPrepared({ segmentId: job.id, workerId: job.lease_owner, ...prepared });
    const [person, audio] = await Promise.all([
      ownedDigitalHumanAsset(text(job.parent.user_id), prepared.personAssetId),
      ownedDigitalHumanAsset(text(job.parent.user_id), prepared.audioAssetId),
    ]);
    await beginLongSegmentPost(job.id, job.lease_owner);
    let result;
    try {
      result = await submitVideoTask(model, {
        prompt: '保持原视频画面，人物口型与配音同步。',
        sourceVideoUrl: person.url,
        audioUrl: audio.url,
        duration: number(job.duration_seconds),
        resolution: text(job.parent.resolution || '720p'),
        resolutionTier: text(job.parent.resolution || '720p'),
        videoExtension: false,
        idempotencyKey: `digital-human-long:${job.id}`,
      });
    } catch {
      await transitionLongSegment({
        segmentId: job.id, workerId: job.lease_owner, state: 'submission_unknown',
        code: 'VIDEO_SUBMIT_OUTCOME_UNKNOWN', message: '正在确认原分段任务，请勿重复生成',
      });
      return;
    }
    if (result.submissionOutcome === 'unknown') {
      await transitionLongSegment({
        segmentId: job.id, workerId: job.lease_owner, state: 'submission_unknown',
        code: 'VIDEO_SUBMIT_OUTCOME_UNKNOWN', message: '正在确认原分段任务，请勿重复生成',
      });
      return;
    }
    if (result.status === 'failed') {
      const failure = classifyVideoProviderError(result.error, model.name);
      await failSegment(job, failure.code, failure.publicMessage);
      await recordVideoTerminalOutcome({ modelId: model.id, outcome: 'fail', responseMs: 0, errorMessage: failure.publicMessage, countSubmission: true });
      return;
    }
    const providerTaskId = result.taskId || (result.status === 'success' && result.videoUrl ? `sync_${job.id}` : '');
    if (!providerTaskId) {
      await transitionLongSegment({
        segmentId: job.id, workerId: job.lease_owner, state: 'submission_unknown',
        code: 'VIDEO_PROVIDER_TASK_ID_MISSING', message: '正在确认原分段任务，请勿重复生成',
      });
      return;
    }
    await bindLongSegmentProvider({
      segmentId: job.id, workerId: job.lease_owner, providerTaskId,
      state: result.status === 'success' && result.videoUrl ? 'finalizing' : 'running',
      resultUrl: result.videoUrl,
    });
    await recordVideoSubmission(model.id);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'DIGITAL_HUMAN_LONG_PREPARE_FAILED';
    const publicMessage = code === 'INSUFFICIENT_CASH_BALANCE' ? '本站钱包余额不足，分段尚未提交，本次未扣费。'
      : code === 'MEMBERSHIP_REQUIRED' ? '会员状态已失效，分段尚未提交，本次未扣费。'
      : code.includes('MODEL_') ? '模型配置或可用状态已变化，分段尚未提交，本次未扣费。'
      : '长视频分段准备失败，本次未调用该分段上游。';
    const retryable = !['INSUFFICIENT_CASH_BALANCE', 'MEMBERSHIP_REQUIRED', 'DIGITAL_HUMAN_LONG_ACCOUNT_UNAVAILABLE'].includes(code)
      && !code.includes('MODEL_');
    if (retryable) {
      const retained = await retryLongSegmentPreparation({
        segmentId: job.id, workerId: job.lease_owner, code, message: publicMessage, delaySeconds: 15,
      }).catch(() => false);
      if (retained) return;
    }
    await failSegment(job, code, publicMessage);
  }
}

async function pollOrPersist(job: ClaimedLongSegment) {
  const model = await currentModel(job.parent).catch(async () => {
    await failSegment(job, 'DIGITAL_HUMAN_LONG_MODEL_CONFIGURATION_CHANGED', '模型配置已变化，原分段任务需要人工核对。');
    return null;
  });
  if (!model) return;
  if (job.state === 'finalizing') {
    const resultUrl = text(job.provider_result_url);
    if (!resultUrl) {
      await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'running', delaySeconds: 15 });
      return;
    }
    try {
      const receipt = await persistLongSegmentProviderVideo({
        resultUrl,
        segmentId: job.id,
        parentId: text(job.parent_id),
        userId: text(job.user_id),
      });
      await completeLongSegment({ segmentId: job.id, workerId: job.lease_owner, ...receipt });
      await recordVideoTerminalOutcome({ modelId: model.id, outcome: 'success', responseMs: 0 });
    } catch {
      await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'finalizing', delaySeconds: 30 });
    }
    return;
  }
  if (!job.provider_task_id) {
    await transitionLongSegment({
      segmentId: job.id, workerId: job.lease_owner, state: 'submission_unknown',
      code: 'VIDEO_PROVIDER_TASK_ID_MISSING', message: '正在确认原分段任务，请勿重复生成',
    });
    return;
  }
  let result;
  try {
    result = await pollVideoTask(model, text(job.provider_task_id));
  } catch {
    await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'running', delaySeconds: 30 });
    return;
  }
  if (result.status === 'success' && result.videoUrl) {
    await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'finalizing', resultUrl: result.videoUrl, delaySeconds: 2 });
  } else if (result.status === 'failed') {
    const failure = classifyVideoProviderError(result.error, model.name);
    await failSegment(job, failure.code, failure.publicMessage);
    await recordVideoTerminalOutcome({ modelId: model.id, outcome: 'fail', responseMs: 0, errorMessage: failure.publicMessage });
  } else {
    await transitionLongSegment({ segmentId: job.id, workerId: job.lease_owner, state: 'running', delaySeconds: 10 });
  }
}

export async function executeDigitalHumanLongSegment(job: ClaimedLongSegment) {
  if (job.state === 'preparing') return prepareAndSubmit(job);
  return pollOrPersist(job);
}

async function settleMergedParent(parent: LongParentRow, workerId: string) {
  const amount = number(parent.locked_price_yuan);
  if (amount === 0 && parent.billing_exempt === true) {
    await finalizeLongJob({ parentId: parent.id, workerId, billingOperationId: '', chargedYuan: 0 });
    return;
  }
  const billing = await executeCashDeduction({
    userId: text(parent.user_id), amount,
    idempotencyKey: text(parent.billing_idempotency_key),
    modelName: 'AI 数字人长视频',
    description: `AI 数字人长视频 ${number(parent.total_duration_seconds).toFixed(1)} 秒`,
    phase: 'digital-human-long-final',
    metadata: { task_id: parent.id, segment_count: number(parent.planned_segment_count) },
  });
  if (!billing.success || !billing.operationId) return;
  await finalizeLongJob({ parentId: parent.id, workerId, billingOperationId: billing.operationId, chargedYuan: amount });
}

export async function executeDigitalHumanLongFinalization(parent: LongParentRow, workerId: string) {
  if (parent.state === 'ready_to_settle') return settleMergedParent(parent, workerId);
  const segments = await completedLongSegmentsForMerge(parent.id, text(parent.user_id));
  const merged = await mergeLongDigitalHumanSegments({ parentId: parent.id, userId: text(parent.user_id), segments });
  await markLongJobMerged({ parentId: parent.id, workerId, ...merged });
}

type WorkerState = { loop: DurableQueueLoop };
const workerGlobal = globalThis as typeof globalThis & { __digitalHumanLongWorker?: WorkerState };

export async function runDigitalHumanLongWorkerOnce() {
  const workerId = randomUUID();
  for (let index = 0; index < 4; index += 1) {
    const job = await claimLongSegment(workerId);
    if (!job) break;
    try { await executeDigitalHumanLongSegment(job); }
    catch { console.warn('[DigitalHumanLong] segment retained for safe recovery', { segmentId: job.id }); }
  }
  const finalizerId = randomUUID();
  const parent = await claimLongFinalization(finalizerId);
  if (parent) {
    try { await executeDigitalHumanLongFinalization(parent, finalizerId); }
    catch { console.warn('[DigitalHumanLong] parent retained for safe recovery', { taskId: parent.id }); }
  }
}

export function startDigitalHumanLongWorker() {
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.argv.includes('build')
    || process.env.MEDIA_QUEUE_WORKER_PROCESS !== '1' || process.env.DIGITAL_HUMAN_LONG_WORKER !== '1') return false;
  const state = workerGlobal.__digitalHumanLongWorker ??= {
    loop: new DurableQueueLoop({
      name: 'digital-human-long',
      intervalMs: 5000,
      runOnce: runDigitalHumanLongWorkerOnce,
      onError: () => console.warn('[DigitalHumanLong] queue temporarily unavailable; no task resubmitted'),
    }),
  };
  return state.loop.start();
}

export async function stopDigitalHumanLongWorker(drainTimeoutMs = 25_000) {
  const state = workerGlobal.__digitalHumanLongWorker;
  return state ? state.loop.stop(drainTimeoutMs) : true;
}

export function digitalHumanLongWorkerStatus() {
  return workerGlobal.__digitalHumanLongWorker?.loop.snapshot() ?? null;
}
