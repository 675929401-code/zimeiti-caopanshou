import 'server-only';

import { storageManager, type StorageProviderType } from '@/storage/object';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { toPublicModelId } from '@/lib/public-model-dto';

type Json = Record<string, unknown>;

export type LongParentRow = Json & {
  id: string;
  user_id: string;
  model_id: string;
  state: string;
  locked_price_yuan: number;
};

export type LongSegmentRow = Json & {
  id: string;
  parent_id: string;
  user_id: string;
  ordinal: number;
  start_seconds: number;
  duration_seconds: number;
  state: string;
  prepared_person_asset_id?: string | null;
  prepared_audio_asset_id?: string | null;
};

export type ClaimedLongSegment = LongSegmentRow & { parent: LongParentRow; lease_owner: string };

export class DigitalHumanLongError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 503) {
    super(message);
    this.name = 'DigitalHumanLongError';
  }
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function rpcDetail(error: unknown) {
  const value = object(error);
  return `${String(value.message || '')} ${String(value.details || '')} ${String(value.hint || '')}`;
}

function missingLongHistoryVisibility(error: unknown) {
  const detail = rpcDetail(error);
  const code = String(object(error).code || '');
  return ['42703', '42883', 'PGRST202', 'PGRST204'].includes(code)
    || /history_hidden_at|hide_digital_human_long_history_item/iu.test(detail);
}

function assertRpcBoolean(data: unknown, error: unknown, code: string) {
  if (error || data !== true) throw new DigitalHumanLongError(code, '长视频任务状态暂时无法安全保存');
}

export async function reserveLongDigitalHumanJob(parent: Json, segments: Json[]) {
  const { data, error } = await getSupabaseAdminClient().rpc('reserve_digital_human_long_job', {
    p_parent: parent,
    p_segments: segments,
  });
  if (error) {
    const detail = rpcDetail(error);
    if (detail.includes('DIGITAL_HUMAN_ACCOUNT_BUSY')) {
      throw new DigitalHumanLongError('DIGITAL_HUMAN_ACCOUNT_BUSY', '当前账号已有数字人任务正在处理，请先查看原任务', 429);
    }
    if (detail.includes('VIDEO_REQUEST_IDEMPOTENCY_CONFLICT')) {
      throw new DigitalHumanLongError('VIDEO_REQUEST_IDEMPOTENCY_CONFLICT', '同一请求编号已绑定不同参数，请新建任务', 409);
    }
    if (/function|schema cache/iu.test(detail)) {
      throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_MIGRATION_NOT_READY', '长视频任务服务正在准备中，本次未提交生成或产生费用');
    }
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_RESERVATION_FAILED', '长视频任务登记失败，本次未调用上游');
  }
  return object(data);
}

export async function claimLongSegment(workerId: string): Promise<ClaimedLongSegment | null> {
  const { data, error } = await getSupabaseAdminClient().rpc('claim_digital_human_long_segment', { p_worker: workerId });
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_CLAIM_FAILED', '长视频分段队列暂时不可用');
  if (!data) return null;
  const row = object(data);
  return { ...row, parent: object(row.parent) as LongParentRow } as ClaimedLongSegment;
}

export async function markLongSegmentPrepared(input: {
  segmentId: string; workerId: string; personAssetId: string; audioAssetId: string;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('prepare_digital_human_long_segment', {
    p_segment_id: input.segmentId,
    p_worker: input.workerId,
    p_person_asset_id: input.personAssetId,
    p_audio_asset_id: input.audioAssetId,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_PREPARE_SAVE_FAILED');
}

export async function retryLongSegmentPreparation(input: {
  segmentId: string; workerId: string; code: string; message: string; delaySeconds?: number;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('retry_digital_human_long_segment', {
    p_segment_id: input.segmentId,
    p_worker: input.workerId,
    p_error_code: input.code,
    p_error_message: input.message,
    p_delay_seconds: input.delaySeconds ?? 10,
  });
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_PREPARE_RETRY_FAILED', '分段准备状态无法保存');
  return data === true;
}

export async function beginLongSegmentPost(segmentId: string, workerId: string) {
  const { data, error } = await getSupabaseAdminClient().rpc('begin_digital_human_long_segment_post', {
    p_segment_id: segmentId,
    p_worker: workerId,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_POST_LEASE_EXPIRED');
}

export async function bindLongSegmentProvider(input: {
  segmentId: string; workerId: string; providerTaskId: string;
  state: 'running' | 'finalizing'; resultUrl?: string;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('bind_digital_human_long_segment_provider', {
    p_segment_id: input.segmentId,
    p_worker: input.workerId,
    p_provider_task_id: input.providerTaskId,
    p_state: input.state,
    p_result_url: input.resultUrl || null,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_PROVIDER_BIND_FAILED');
}

export async function transitionLongSegment(input: {
  segmentId: string; workerId: string;
  state: 'running' | 'finalizing' | 'submission_unknown' | 'failed';
  resultUrl?: string; code?: string; message?: string; delaySeconds?: number;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('update_digital_human_long_segment', {
    p_segment_id: input.segmentId,
    p_worker: input.workerId,
    p_state: input.state,
    p_result_url: input.resultUrl || null,
    p_error_code: input.code || null,
    p_error_message: input.message || null,
    p_delay_seconds: input.delaySeconds ?? 10,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_TRANSITION_FAILED');
}

export async function completeLongSegment(input: {
  segmentId: string; workerId: string; assetId: string; storageUrl: string; sha256: string;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('complete_digital_human_long_segment', {
    p_segment_id: input.segmentId,
    p_worker: input.workerId,
    p_result_asset_id: input.assetId,
    p_result_storage_url: input.storageUrl,
    p_result_sha256: input.sha256,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_SEGMENT_COMPLETE_FAILED');
}

export async function claimLongFinalization(workerId: string): Promise<LongParentRow | null> {
  const { data, error } = await getSupabaseAdminClient().rpc('claim_digital_human_long_finalization', { p_worker: workerId });
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_FINALIZE_CLAIM_FAILED', '整片合并队列暂时不可用');
  return data ? object(data) as LongParentRow : null;
}

export async function completedLongSegmentsForMerge(parentId: string, userId: string) {
  const { data, error } = await getSupabaseAdminClient().from('digital_human_long_segments')
    .select('ordinal,result_storage_url,state').eq('parent_id', parentId).eq('user_id', userId).order('ordinal');
  if (error || !data?.length || data.some((row: Json) => row.state !== 'completed' || !row.result_storage_url)) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_SEGMENTS_INCOMPLETE', '分段结果尚未完整保存');
  }
  return data.map((row: Json) => ({ ordinal: Number(row.ordinal), result_storage_url: String(row.result_storage_url) }));
}

export async function markLongJobMerged(input: {
  parentId: string; workerId: string; assetId: string; storageUrl: string; sha256: string;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('mark_digital_human_long_job_merged', {
    p_parent_id: input.parentId,
    p_worker: input.workerId,
    p_asset_id: input.assetId,
    p_storage_url: input.storageUrl,
    p_sha256: input.sha256,
  });
  assertRpcBoolean(data, error, 'DIGITAL_HUMAN_LONG_MERGE_SAVE_FAILED');
}

export async function finalizeLongJob(input: {
  parentId: string; workerId: string; billingOperationId: string; chargedYuan: number;
}) {
  const { data, error } = await getSupabaseAdminClient().rpc('finalize_digital_human_long_job', {
    p_parent_id: input.parentId,
    p_worker: input.workerId,
    p_billing_operation_id: input.billingOperationId || null,
    p_charged_yuan: input.chargedYuan,
  });
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_SETTLEMENT_SAVE_FAILED', '扣费结果已经确定，但整片交付状态尚未确认');
  return object(data);
}

export async function cancelLongJob(parentId: string, userId: string) {
  const { data, error } = await getSupabaseAdminClient().rpc('cancel_digital_human_long_job', {
    p_parent_id: parentId,
    p_user_id: userId,
  });
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_CANCEL_FAILED', '暂时无法确认取消结果');
  return String(data || 'not_found');
}

async function signedMergedResult(parent: Json, userId: string) {
  if (parent.state !== 'completed' || !parent.merged_asset_id) return '';
  const { data, error } = await getSupabaseAdminClient().from('user_files')
    .select('storage_key,storage_provider')
    .eq('id', parent.merged_asset_id).eq('user_id', userId).eq('file_category', 'video').maybeSingle();
  if (error || !data) return '';
  return storageManager.getSignedUrl(
    String(data.storage_key),
    { expireTime: 3600 },
    data.storage_provider as StorageProviderType,
  );
}

function publicStatus(state: string, billingState: string) {
  if (state === 'completed') return 'completed';
  if (['failed','cancelled'].includes(state)) return state;
  if (state === 'confirming') return 'confirming';
  if (state === 'merging') return 'merging';
  if (state === 'ready_to_settle' || billingState === 'ready_to_settle') return 'billing_pending';
  return state === 'queued' ? 'queued' : 'processing';
}

export async function getLongJobForUser(parentId: string, userId: string) {
  const db = getSupabaseAdminClient();
  const { data: parent, error } = await db.from('digital_human_long_jobs').select('*')
    .eq('id', parentId).eq('user_id', userId).maybeSingle();
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_READ_FAILED', '长视频任务暂时无法读取');
  if (!parent) return null;
  const { data: segments, error: segmentError } = await db.from('digital_human_long_segments')
    .select('ordinal,start_seconds,end_seconds,duration_seconds,boundary_kind,state,error_code,error_message')
    .eq('parent_id', parentId).eq('user_id', userId).order('ordinal');
  if (segmentError) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_READ_FAILED', '长视频分段暂时无法读取');
  const rows = segments || [];
  const completedSegments = rows.filter((row: Json) => row.state === 'completed').length;
  const canRetry = parent.state === 'failed'
    && parent.billing_state === 'voided'
    && Number(parent.charged_yuan) === 0
    && !parent.merged_asset_id
    && /^[0-9a-f-]{36}$/iu.test(String(parent.source_video_asset_id || ''))
    && /^[0-9a-f-]{36}$/iu.test(String(parent.source_audio_asset_id || ''));
  return {
    id: parent.id,
    clientRequestId: parent.client_request_id,
    modelId: toPublicModelId('video', String(parent.model_id)),
    status: publicStatus(String(parent.state), String(parent.billing_state)),
    totalDurationSeconds: Number(parent.total_duration_seconds),
    segmentCount: Number(parent.planned_segment_count),
    completedSegments,
    progress: Math.round(completedSegments / Math.max(1, Number(parent.planned_segment_count)) * 100),
    quotedPriceYuan: Number(parent.locked_price_yuan),
    priceChargedYuan: Number(parent.charged_yuan),
    resolution: String(parent.resolution || '720p'),
    canRetry,
    retrySource: canRetry ? {
      personAssetId: String(parent.source_video_asset_id),
      audioAssetId: String(parent.source_audio_asset_id),
      durationChoice: 'preserve_audio' as const,
    } : undefined,
    resultUrl: await signedMergedResult(parent, userId),
    message: parent.state === 'confirming' ? '正在确认原分段任务，请勿重复生成'
      : parent.state === 'merging' ? '全部分段已生成，正在合并完整视频'
      : parent.state === 'ready_to_settle' ? '完整视频已保存，正在完成本站钱包结算'
      : parent.state === 'failed' ? String(parent.error_message || '有分段生成失败，本次未扣除整片费用')
      : parent.state === 'cancelled' ? '任务已取消，本次未扣费'
      : parent.state === 'completed' ? '完整视频已生成'
      : `正在处理第 ${Math.min(completedSegments + 1, Number(parent.planned_segment_count))}/${Number(parent.planned_segment_count)} 段`,
    createdAt: parent.created_at,
    completedAt: parent.completed_at,
    segments: rows.map((row: Json) => ({
      ordinal: Number(row.ordinal),
      startSeconds: Number(row.start_seconds),
      endSeconds: Number(row.end_seconds),
      durationSeconds: Number(row.duration_seconds),
      boundaryKind: row.boundary_kind,
      status: row.state === 'submission_unknown' ? 'confirming' : row.state,
      message: row.state === 'failed' ? String(row.error_message || '该分段生成失败') : '',
    })),
  };
}

export async function getLongJobByClientRequestForUser(clientRequestId: string, userId: string) {
  const { data, error } = await getSupabaseAdminClient().from('digital_human_long_jobs').select('id')
    .eq('client_request_id', clientRequestId).eq('user_id', userId).maybeSingle();
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_READ_FAILED', '长视频任务暂时无法读取');
  return data?.id ? getLongJobForUser(String(data.id), userId) : null;
}

export async function getLongJobDownloadForUser(parentId: string, userId: string, responseFileName: string) {
  const db = getSupabaseAdminClient();
  const { data: parent, error } = await db.from('digital_human_long_jobs').select('id,state,merged_asset_id')
    .eq('id', parentId).eq('user_id', userId).maybeSingle();
  if (error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_READ_FAILED', '长视频任务暂时无法读取');
  if (!parent) return null;
  if (parent.state !== 'completed' || !parent.merged_asset_id) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_DOWNLOAD_NOT_READY', '完整视频尚未生成完成', 409);
  }
  const { data: asset, error: assetError } = await db.from('user_files')
    .select('id,user_id,storage_key,storage_provider,file_category,content_type')
    .eq('id', parent.merged_asset_id).eq('user_id', userId).eq('file_category', 'video').maybeSingle();
  if (assetError) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_READ_FAILED', '长视频下载信息暂时无法读取');
  if (!asset || !String(asset.content_type || '').startsWith('video/')) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_ASSET_MISSING', '完整视频文件暂时不可用', 503);
  }
  return storageManager.getSignedUrl(
    String(asset.storage_key),
    { expireTime: 300, responseFileName },
    asset.storage_provider as StorageProviderType,
  );
}

export async function listLongJobsForUser(userId: string, limit = 30, offset = 0) {
  const db = getSupabaseAdminClient();
  const safeLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 30));
  const safeOffset = Math.max(0, Math.min(10_000, Number.isSafeInteger(offset) ? offset : 0));
  let historyHidingReady = true;
  let result = await db.from('digital_human_long_jobs')
    .select('id,history_hidden_at', { count: 'exact' })
    .eq('user_id', userId)
    .is('history_hidden_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (result.error && missingLongHistoryVisibility(result.error)) {
    historyHidingReady = false;
    result = await db.from('digital_human_long_jobs')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);
  }
  if (result.error) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_HISTORY_FAILED', '长视频历史暂时无法读取');
  const tasks = (await Promise.all((result.data || []).map((row: Json) => getLongJobForUser(String(row.id), userId))))
    .filter(Boolean)
    .map((task) => ({ ...task, canHide: historyHidingReady && !['queued', 'processing', 'confirming', 'merging', 'billing_pending'].includes(String(task?.status || '')) }));
  const total = result.count || 0;
  return {
    tasks,
    total,
    nextOffset: safeOffset + safeLimit < total ? safeOffset + safeLimit : null,
    historyHidingReady,
  };
}

export async function hideLongJobHistory(parentId: string, userId: string) {
  const { data, error } = await getSupabaseAdminClient().rpc('hide_digital_human_long_history_item', {
    p_parent_id: parentId,
    p_user_id: userId,
  });
  if (error) {
    if (missingLongHistoryVisibility(error)) {
      throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_HISTORY_MIGRATION_NOT_READY', '长视频历史移除服务正在准备中，请稍后重试', 503);
    }
    const detail = rpcDetail(error);
    if (detail.includes('DIGITAL_HUMAN_LONG_HISTORY_NOT_FOUND')) {
      throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_HISTORY_NOT_FOUND', '记录不存在或无权操作', 404);
    }
    if (detail.includes('DIGITAL_HUMAN_LONG_HISTORY_PENDING')) {
      throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_HISTORY_PENDING', '任务仍在处理，请完成后再移除历史记录', 409);
    }
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_HISTORY_HIDE_FAILED', '长视频历史暂时无法移除');
  }
  return data === true;
}

export function longErrorResponse(error: unknown) {
  if (error instanceof DigitalHumanLongError) {
    return { status: error.status, body: { error: error.message, error_code: error.code, task_submitted: false } };
  }
  return { status: 500, body: { error: '长视频任务暂时无法处理', error_code: 'DIGITAL_HUMAN_LONG_INTERNAL' } };
}
