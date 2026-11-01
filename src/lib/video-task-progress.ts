type ProgressInput = {
  status?: unknown; processingStage?: unknown; taskIdExternal?: unknown;
  errorCode?: unknown; submission_outcome?: unknown; task_submitted?: unknown; business_task_id?: unknown;
  videoUrl?: unknown; video_url?: unknown; storageUrl?: unknown;
};
type ActiveStatus = 'pending' | 'queued' | 'processing' | 'generating' | 'finalizing';

function confirmedVideoTaskEvidence(input: ProgressInput): boolean {
  const status = String(input.status || '').toLowerCase();
  return ['done', 'completed', 'success', 'succeeded', 'ready', 'failed', 'error', 'failure', 'cancelled', 'canceled', 'terminated', 'expired',
    'processing', 'running', 'generating', 'in_progress', 'trimming', 'finalizing', 'asset_persisting'].includes(status)
    || Boolean(input.videoUrl || input.video_url || input.storageUrl)
    || typeof input.taskIdExternal === 'string' && Boolean(input.taskIdExternal.trim())
    || ['running', 'result_staging', 'persisting', 'finalizing', 'billing'].includes(String(input.processingStage || ''));
}

/** Undefined means the snapshot has no new submission-confirmation evidence. */
export function videoSubmissionConfirmationSignal(input: ProgressInput): boolean | undefined {
  const status = String(input.status || '').toLowerCase();
  const stage = String(input.processingStage || '');
  if (confirmedVideoTaskEvidence(input)) return false;
  if (['waiting_power', 'waiting_ready', 'retry_wait', 'queued', 'dispatching', 'running', 'result_staging', 'persisting', 'finalizing', 'billing'].includes(stage)) return false;
  if (['confirming_submission', 'submission_unknown'].includes(stage)
    || input.errorCode === 'VIDEO_SUBMIT_OUTCOME_UNKNOWN'
    || input.submission_outcome === 'unknown'
    || input.task_submitted === null && typeof input.business_task_id === 'string' && Boolean(input.business_task_id.trim())) return true;
  if (status === 'pending' && Object.hasOwn(input, 'taskIdExternal') && input.taskIdExternal === '') return true;
  return undefined;
}

/** A confirmed task cannot regress to submission confirmation on a late snapshot. */
export function updateVideoConfirmationMap(current: Map<string, boolean>, taskKey: string, input: ProgressInput): Map<string, boolean> {
  const signal = videoSubmissionConfirmationSignal(input);
  if (!taskKey || signal === undefined || current.get(taskKey) === signal
    || signal === true && current.get(taskKey) === false) return current;
  if (signal === false && !confirmedVideoTaskEvidence(input)) {
    if (!current.has(taskKey)) return current;
    const next = new Map(current);
    next.delete(taskKey);
    return next;
  }
  return new Map(current).set(taskKey, signal);
}

export function videoProgressStatus(input: ProgressInput): ActiveStatus {
  const stage = String(input.processingStage || '');
  if (['confirming_submission', 'submission_unknown'].includes(stage)) return 'pending';
  if (['result_staging', 'persisting', 'finalizing', 'billing'].includes(stage)) return 'finalizing';
  if (['waiting_power', 'waiting_ready', 'retry_wait', 'queued'].includes(stage)) return 'queued';
  if (['dispatching', 'recovery_required', 'running'].includes(stage)) return 'processing';
  return ['pending', 'queued', 'processing', 'generating', 'finalizing'].includes(String(input.status))
    ? input.status as ActiveStatus : 'processing';
}

export function videoProgressLabel(input: ProgressInput): string {
  if (videoSubmissionConfirmationSignal(input) === true) return '正在确认结果';
  const stageLabels: Record<string, string> = {
    waiting_power: '正在准备生成资源', waiting_ready: '正在等待服务就绪',
    retry_wait: '等待恢复原任务', dispatching: '正在提交任务', recovery_required: '正在恢复任务状态',
    result_staging: '正在接收视频', persisting: '正在保存视频', billing: '正在完成结算',
    finalizing: '正在保存作品与记录',
  };
  return stageLabels[String(input.processingStage || '')] || {
    pending: '提交中', queued: '排队中', processing: '生成中', generating: '生成中', finalizing: '正在保存视频',
  }[videoProgressStatus(input)];
}
