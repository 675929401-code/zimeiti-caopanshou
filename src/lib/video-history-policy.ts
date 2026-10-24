/** Shared browser/server history policy; contains no storage or server imports. */
export const VIDEO_HISTORY_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
export type VideoHistorySurface = 'storyboard-workbench' | 'video-page';

export interface VideoHistoryPolicyItem {
  id?: string;
  taskId?: string;
  status?: unknown;
  billingState?: unknown;
  billing_state?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  completedAt?: unknown;
  completed_at?: unknown;
  batchId?: unknown;
  batch_id?: unknown;
  batchTopic?: unknown;
  batch_topic?: unknown;
  cardIndex?: unknown;
  card_index?: unknown;
  historyHiddenAt?: unknown;
  history_hidden_at?: unknown;
  sourceExpiredAt?: unknown;
  source_expired_at?: unknown;
  taskLabel?: unknown;
  task_label?: unknown;
}

export const VIDEO_HISTORY_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired'] as const;
export const VIDEO_HISTORY_SETTLED_BILLING_STATES = ['settled', 'not_required', 'exempt', 'failed', 'cancelled', 'submission_failed', 'refunded', 'not_charged'] as const;
/**
 * Billing states the clear write may hide. `provider_submitted` is included
 * because `isVideoHistoryProtected` already time-gates it: only rows past the
 * retention window reach the write, while a concurrent unknown state still
 * cannot be cleared.
 */
export const VIDEO_HISTORY_CLEARABLE_BILLING_STATES = [...VIDEO_HISTORY_SETTLED_BILLING_STATES, 'provider_submitted'] as const;

function field(item: VideoHistoryPolicyItem, camel: keyof VideoHistoryPolicyItem, snake: keyof VideoHistoryPolicyItem): unknown {
  return item[camel] ?? item[snake];
}
function time(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
}

/** Billing states that mean "the provider may still settle": protected only while the window is open. */
const STALE_SUBMITTED_BILLING_STATES = new Set(['provider_submitted']);

/** Unknown status or an explicitly unresolved billing state is protected from every clear. */
export function isVideoHistoryProtected(item: VideoHistoryPolicyItem, now: number = Date.now()): boolean {
  if (!(VIDEO_HISTORY_TERMINAL_STATUSES as readonly string[]).includes(String(item.status ?? ''))) return true;
  const billing = field(item, 'billingState', 'billing_state');
  // Rows written before billing tracking existed have no billing state at all.
  // They can never transition to a settled value, so treating "missing" as
  // "still pending" pinned them in history forever and blocked both the 5-day
  // retention and every clear. Missing is legacy evidence, not an open charge;
  // an explicit state outside the settled set (empty string, "unknown", …)
  // stays protected.
  if (billing === null || billing === undefined) return false;
  if (STALE_SUBMITTED_BILLING_STATES.has(String(billing))) {
    // The provider accepted the job but never reported a terminal state. Keep
    // it protected while a settlement can still land; after the retention
    // window it must stop pinning history forever.
    const terminalAt = videoHistoryTerminalTime(item);
    return !Number.isFinite(terminalAt) || now - terminalAt < VIDEO_HISTORY_RETENTION_MS;
  }
  return !(VIDEO_HISTORY_SETTLED_BILLING_STATES as readonly string[]).includes(String(billing));
}

/** The legacy expiry RPC wrote the same timestamp to both columns. It is not a user clear. */
export function isVideoHistoryExplicitlyHidden(item: VideoHistoryPolicyItem): boolean {
  const hiddenValue = field(item, 'historyHiddenAt', 'history_hidden_at');
  if (!hiddenValue) return false;
  const hidden = time(hiddenValue);
  const expired = time(field(item, 'sourceExpiredAt', 'source_expired_at'));
  return !Number.isFinite(hidden) || !Number.isFinite(expired) || hidden !== expired;
}

export function videoHistoryTerminalTime(item: VideoHistoryPolicyItem): number {
  const completed = time(field(item, 'completedAt', 'completed_at'));
  return Number.isFinite(completed) ? completed : time(field(item, 'createdAt', 'created_at'));
}

export function isVideoHistoryExpired(item: VideoHistoryPolicyItem, now: number = Date.now()): boolean {
  // Storyboard media expires independently after 72h. Keep its task/fee audit
  // in history; never treat reclaiming video bytes as deleting a task.
  if (String(field(item, 'taskLabel', 'task_label') || '').startsWith('分镜工作台')) return false;
  if (isVideoHistoryProtected(item)) return false;
  const terminalAt = videoHistoryTerminalTime(item);
  return Number.isFinite(terminalAt) && now - terminalAt >= VIDEO_HISTORY_RETENTION_MS;
}

export interface VideoHistoryBatch<T> { batchId: string; batchTopic: string; items: T[] }
export interface VideoHistoryDay<T> { dateKey: string; label: string; batches: VideoHistoryBatch<T>[] }

function dateKey(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : 'unknown';
}

/** Submission day → newest batch → original zero-based card order → all attempts. */
export function groupVideoHistory<T extends VideoHistoryPolicyItem>(items: readonly T[], now: number = Date.now()): VideoHistoryDay<T>[] {
  const days = new Map<string, Map<string, VideoHistoryBatch<T>>>();
  const allBatches = new Map<string, VideoHistoryBatch<T>>();
  const created = (item: T) => time(field(item, 'createdAt', 'created_at'));
  for (const item of items) {
    if (isVideoHistoryExpired(item, now)) continue;
    const batchId = String(field(item, 'batchId', 'batch_id') || `task:${item.id || item.taskId || 'unknown'}`);
    if (!allBatches.has(batchId)) allBatches.set(batchId, { batchId, batchTopic: String(field(item, 'batchTopic', 'batch_topic') || ''), items: [] });
    allBatches.get(batchId)!.items.push(item);
  }
  const latestTime = (batch: VideoHistoryBatch<T>) => batch.items.reduce((latest, item) => Math.max(latest, created(item) || 0), 0);
  for (const [batchId, batch] of allBatches) {
    const latest = latestTime(batch);
    const day = latest ? dateKey(latest) : 'unknown';
    if (!days.has(day)) days.set(day, new Map());
    days.get(day)!.set(batchId, batch);
  }
  const today = dateKey(now);
  const yesterday = dateKey(now - 24 * 60 * 60 * 1000);
  return [...days].sort(([a], [b]) => a === 'unknown' ? 1 : b === 'unknown' ? -1 : b.localeCompare(a)).map(([day, batches]) => ({
    dateKey: day,
    label: day === today ? '今天' : day === yesterday ? '昨天' : day === 'unknown' ? '日期未记录' : day,
    batches: [...batches.values()].sort((a, b) => latestTime(b) - latestTime(a) || b.batchId.localeCompare(a.batchId)).map((batch) => ({
      ...batch,
      items: [...batch.items].sort((a, b) => {
        const card = (item: T) => {
          const raw = field(item, 'cardIndex', 'card_index');
          if (raw == null || raw === '') return Number.MAX_SAFE_INTEGER;
          const value = Number(raw);
          return Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
        };
        return card(a) - card(b) || (created(b) || 0) - (created(a) || 0) || String(b.id || b.taskId || '').localeCompare(String(a.id || a.taskId || ''));
      }),
    })),
  }));
}
