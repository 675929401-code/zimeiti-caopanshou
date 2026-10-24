/** Shared server/client policy. Expiry is anchored once by the database at completion. */
export const STORYBOARD_ARCHIVE_PREFIX = 'videos/scoped/storyboard-delivery/';
export const STORYBOARD_ARCHIVE_POLICY = 'storyboard-video-72h-v1';
export const STORYBOARD_ARCHIVE_RETENTION_MS = 72 * 60 * 60 * 1000;
export type StoryboardArchiveTask = {
  task_label?: unknown; status?: unknown; completed_at?: unknown; created_at?: unknown;
  storage_url?: unknown; source_expired_at?: unknown;
  storyboard_archive_expires_at?: unknown; storyboard_archive_state?: unknown;
};
export function isStoryboardVideoTask(task: StoryboardArchiveTask) {
  return String(task.task_label || '').startsWith('分镜工作台');
}
export function storyboardVideoRetainedUntil(task: StoryboardArchiveTask): string | null {
  const explicit = Date.parse(String(task.storyboard_archive_expires_at || ''));
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  const completed = Date.parse(String(task.completed_at || ''));
  return Number.isFinite(completed) ? new Date(completed + STORYBOARD_ARCHIVE_RETENTION_MS).toISOString() : null;
}
export function isStoryboardArchiveExpired(task: StoryboardArchiveTask, now = Date.now()) {
  if (!isStoryboardVideoTask(task)) return false;
  const until = storyboardVideoRetainedUntil(task);
  return until !== null && Date.parse(until) <= now;
}
export function storyboardArchiveObjectKey(uri: unknown): string | null {
  const value = String(uri || '');
  if (!value.startsWith('object://tencent_cos/')) return null;
  try {
    const key = decodeURIComponent(value.slice('object://tencent_cos/'.length));
    return key.startsWith(STORYBOARD_ARCHIVE_PREFIX) && !/[\\\u0000\r\n]/u.test(key)
      && !key.split('/').includes('..') ? key : null;
  } catch { return null; }
}
/** Owned storage remains usable even if the upstream was separately marked expired. */
export function usableStoryboardArchive(task: StoryboardArchiveTask, now = Date.now()) {
  return isStoryboardVideoTask(task) && task.status === 'completed' && storyboardVideoRetainedUntil(task) !== null && !isStoryboardArchiveExpired(task, now)
    && storyboardArchiveObjectKey(task.storage_url) !== null;
}
export function storyboardVideoDeliveryState(task: StoryboardArchiveTask, now = Date.now()): 'saving' | 'saved' | 'failed' | 'expired' {
  if (isStoryboardArchiveExpired(task, now)) return 'expired';
  if (usableStoryboardArchive(task, now)) return 'saved';
  if (['queued', 'leased', 'retry'].includes(String(task.storyboard_archive_state || ''))) return 'saving';
  return ['dead_letter', 'source_expired', 'failed'].includes(String(task.storyboard_archive_state || ''))
    || Boolean(task.source_expired_at) ? 'failed' : 'saving';
}
