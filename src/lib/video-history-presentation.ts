import { stripVideoModelOperationalAnnotation } from "./video-model-display-name";

type HistoryIdentity = { id: string; createdAt: string; taskLabel?: string; batchTopic?: string; cardIndex?: number };

export function videoTokenBillingMessage(state: unknown): string {
  if (state === 'usage_pending') return '视频已生成，正在查询原任务的实际 Token 用量，尚未扣费，请勿重复生成';
  if (state === 'quote_exceeded') return '视频已生成，实际费用超过本次扣款上限，账单待确认；未自动扣款，请保留原任务';
  if (state === 'billing_review') return '视频已生成，实际 Token 用量需要核对；未追加扣费，请保留原任务';
  return '';
}

export function compactPublicVideoModelName(value: unknown, fallback = "视频模型") {
  const publicValue = stripVideoModelOperationalAnnotation(value)
    .replace(/\s+/gu, " ");
  const segments = publicValue.split("·").map((segment) => segment.trim()).filter(Boolean);
  const cleaned = segments.filter((segment, index) => {
    if (/元\/(?:秒|次)/u.test(segment)) return false;
    if (/(?:企业渠道)?分组\s*\d+/u.test(segment)) return false;
    return !(index === segments.length - 1 && /^\d{1,3}$/u.test(segment));
  });
  return cleaned.join(" · ").trim() || fallback;
}

export function sortVideoHistoryBySubmission<T extends HistoryIdentity>(tasks: readonly T[]): T[] {
  const time = (value: string) => Date.parse(value) || 0;
  return [...tasks].sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id));
}
export function videoHistoryTitle(task: HistoryIdentity): string {
  const date = new Date(task.createdAt);
  const timestamp = Number.isNaN(date.getTime()) ? '提交时间未记录' : date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${timestamp} · ${task.batchTopic || task.taskLabel || '视频'}${task.cardIndex ? ` · 镜头${String(task.cardIndex).padStart(2, '0')}` : ''}`;
}
export function canRetryVideoHistoryTask(task: Record<string, unknown>): boolean {
  const errorCode = String(task.submission_error_code || '');
  if (task.status !== 'failed' || errorCode.includes('UNKNOWN') || task.provider_result_url) return false;
  if (errorCode === 'VIDEO_SUBMISSION_CONFIRMATION_EXPIRED') {
    return String(task.billing_state || '') === 'submission_failed'
      && !task.task_id_external
      && Number(task.price_charged || 0) === 0;
  }
  return ['failed', 'not_required'].includes(String(task.billing_state))
    || !task.billing_state && Number(task.price_charged || 0) === 0;
}
