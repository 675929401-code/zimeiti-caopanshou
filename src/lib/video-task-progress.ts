type ProgressInput = { status?: unknown; processingStage?: unknown };
type ActiveStatus = 'pending' | 'queued' | 'processing' | 'generating' | 'finalizing';

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
  const stageLabels: Record<string, string> = {
    confirming_submission: '正在确认原任务', submission_unknown: '正在确认原任务',
    waiting_power: '正在准备生成资源', waiting_ready: '正在等待服务就绪',
    retry_wait: '等待恢复原任务', dispatching: '正在提交任务', recovery_required: '正在恢复任务状态',
    result_staging: '正在接收视频', persisting: '正在保存视频', billing: '正在完成结算',
    finalizing: '正在保存作品与记录',
  };
  return stageLabels[String(input.processingStage || '')] || {
    pending: '提交中', queued: '排队中', processing: '生成中', generating: '生成中', finalizing: '正在保存视频',
  }[videoProgressStatus(input)];
}
