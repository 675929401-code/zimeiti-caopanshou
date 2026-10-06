import 'server-only';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { refreshOwnedVideoTaskStatus } from '@/lib/video-task-status';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';
import { reconcileStaleVideoSubmissionBatch } from '@/lib/video-submission-reconciliation';

const VIDEO_HISTORY_POLL_BATCH_SIZE = 16;
const VIDEO_HISTORY_POLL_CONCURRENCY = 4;
const VIDEO_HISTORY_POLL_LEASE_SECONDS = 180;
const VIDEO_HISTORY_POLL_FAILURE_COOLDOWN_SECONDS = 30;

type AcceptedTask = {
  id: string;
  user_id: string;
  model_id: string;
  task_id_external: string;
};

type ClaimedTask = AcceptedTask & { leaseOwner?: string };

type WorkerStatusSnapshot = {
  status?: unknown;
  processingStage?: unknown;
  providerPollFailures?: unknown;
  errorCode?: unknown;
};

function fixedWorkerDiagnostic(value: unknown) {
  return String(value || 'VIDEO_HISTORY_REFRESH_FAILED')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 240);
}

function workerId() {
  const runtimeProcess = typeof process === 'undefined'
    ? { pid: 0, env: {} as Record<string, string | undefined> }
    : process;
  const instance = String(
    runtimeProcess.env.MEDIA_QUEUE_WORKER_INSTANCE
      || runtimeProcess.env.NODE_APP_INSTANCE
      || runtimeProcess.env.pm_id
      || '0',
  ).replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 80);
  return `video-history:${runtimeProcess.pid}:${instance}`;
}

function missingLeaseRpc(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(value.code || '');
  const description = `${String(value.message || '')} ${String(value.details || '')} ${String(value.hint || '')}`;
  return code === 'PGRST202'
    || code === '42883'
    || (/claim_video_history_poll_batch/iu.test(description)
      && /(?:schema cache|not find|does not exist|undefined function)/iu.test(description));
}

async function legacyVideoHistoryTasks(db: ReturnType<typeof getSupabaseAdminClient>): Promise<AcceptedTask[]> {
  const { data, error } = await db.from('video_tasks')
    .select('id,user_id,model_id,task_id_external,task_label,provider_last_polled_at')
    .in('status', ['pending', 'queued', 'processing', 'generating', 'finalizing', 'billing_pending'])
    .not('task_id_external', 'is', null).neq('task_id_external', '')
    .or('task_label.is.null,task_label.not.like.digital-human:%')
    .order('provider_last_polled_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .range(0, VIDEO_HISTORY_POLL_BATCH_SIZE - 1);
  if (error) throw new Error('VIDEO_HISTORY_WORKER_READ_FAILED');
  return ((data || []) as AcceptedTask[]).filter(task => !String(task.task_id_external).startsWith('h3q_'));
}

function missingLeaseColumns(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(value.code || '');
  const description = `${String(value.message || '')} ${String(value.details || '')}`;
  return ['42703', 'PGRST204'].includes(code)
    || /provider_poll_lease_(?:owner|until)/iu.test(description) && /(?:column|schema cache|not find|does not exist)/iu.test(description);
}

async function claimBillingPendingTasks(
  db: ReturnType<typeof getSupabaseAdminClient>,
  leaseOwner: string,
  limit: number,
): Promise<ClaimedTask[]> {
  if (limit <= 0) return [];
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + VIDEO_HISTORY_POLL_LEASE_SECONDS * 1000).toISOString();
  const { data, error } = await db.from('video_tasks')
    .select('id,user_id,model_id,task_id_external,task_label,provider_poll_lease_owner,provider_poll_lease_until,created_at')
    .eq('status', 'billing_pending')
    .not('task_id_external', 'is', null).neq('task_id_external', '')
    .or('task_label.is.null,task_label.not.like.digital-human:%')
    .order('provider_poll_lease_until', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .range(0, Math.max(limit * 4, limit) - 1);
  if (error) {
    if (missingLeaseColumns(error)) return [];
    throw new Error('VIDEO_HISTORY_WORKER_BILLING_CLAIM_READ_FAILED');
  }
  const candidates = ((data || []) as Array<Record<string, unknown>>).filter((row) => {
    const providerTaskId = String(row.task_id_external || '');
    const leaseUntilMs = Date.parse(String(row.provider_poll_lease_until || ''));
    return providerTaskId
      && !providerTaskId.startsWith('h3q_')
      && (!Number.isFinite(leaseUntilMs) || leaseUntilMs <= now.getTime());
  });
  const claimed: ClaimedTask[] = [];
  for (const row of candidates) {
    if (claimed.length >= limit) break;
    let update = db.from('video_tasks').update({
      provider_poll_lease_owner: leaseOwner,
      provider_poll_lease_until: leaseUntil,
    }).eq('id', String(row.id || '')).eq('status', 'billing_pending');
    update = row.provider_poll_lease_owner == null
      ? update.is('provider_poll_lease_owner', null)
      : update.eq('provider_poll_lease_owner', String(row.provider_poll_lease_owner));
    update = row.provider_poll_lease_until == null
      ? update.is('provider_poll_lease_until', null)
      : update.eq('provider_poll_lease_until', String(row.provider_poll_lease_until));
    const { data: claimedRow, error: claimError } = await update
      .select('id,user_id,model_id,task_id_external').maybeSingle();
    if (claimError) {
      if (missingLeaseColumns(claimError)) return claimed;
      throw new Error('VIDEO_HISTORY_WORKER_BILLING_CLAIM_FAILED');
    }
    if (!claimedRow) continue;
    claimed.push({
      id: String(claimedRow.id || ''),
      user_id: String(claimedRow.user_id || ''),
      model_id: String(claimedRow.model_id || ''),
      task_id_external: String(claimedRow.task_id_external || ''),
      leaseOwner,
    });
  }
  return claimed.filter(task => task.id && task.user_id && task.model_id && task.task_id_external);
}

async function claimVideoHistoryTasks(
  db: ReturnType<typeof getSupabaseAdminClient>,
  leaseOwner: string,
): Promise<ClaimedTask[]> {
  if (typeof db.rpc !== 'function') return legacyVideoHistoryTasks(db);
  const { data, error } = await db.rpc('claim_video_history_poll_batch', {
    p_worker_id: leaseOwner,
    p_limit: VIDEO_HISTORY_POLL_BATCH_SIZE,
    p_lease_seconds: VIDEO_HISTORY_POLL_LEASE_SECONDS,
  });
  if (!error) {
    const claimed = ((data || []) as Array<Record<string, unknown>>).map(row => ({
      id: String(row.task_id || ''),
      user_id: String(row.owner_user_id || ''),
      model_id: String(row.internal_model_id || ''),
      task_id_external: String(row.provider_task_id || ''),
      leaseOwner,
    })).filter(task => task.id && task.user_id && task.model_id && task.task_id_external);
    const billingPending = claimed.length < VIDEO_HISTORY_POLL_BATCH_SIZE
      ? await claimBillingPendingTasks(db, leaseOwner, VIDEO_HISTORY_POLL_BATCH_SIZE - claimed.length).catch(() => [])
      : [];
    return [...claimed, ...billingPending];
  }
  if (!missingLeaseRpc(error)) throw new Error('VIDEO_HISTORY_WORKER_CLAIM_FAILED');
  if (!globalWorker.__videoHistoryLeaseFallbackWarned) {
    globalWorker.__videoHistoryLeaseFallbackWarned = true;
    console.warn('[VideoHistoryWorker] poll lease migration unavailable; using legacy selection');
  }
  return legacyVideoHistoryTasks(db);
}

function pollCooldownSeconds(responseOk: boolean, snapshot: WorkerStatusSnapshot) {
  const status = String(snapshot.status || '').toLowerCase();
  const stage = String(snapshot.processingStage || '').toLowerCase();
  if (['completed', 'failed', 'cancelled', 'expired'].includes(status)) return 0;
  if (!responseOk) {
    const failures = Math.max(0, Math.min(3, Number(snapshot.providerPollFailures) || 0));
    return VIDEO_HISTORY_POLL_FAILURE_COOLDOWN_SECONDS * (2 ** failures);
  }
  if (status === 'queued') return 30;
  if (status === 'billing_pending' || stage === 'billing') return 15;
  if (status === 'processing' && stage === 'finalizing') return 10;
  if (['pending', 'processing', 'generating'].includes(status)) return 15;
  return 30;
}

async function deferVideoHistoryTask(
  db: ReturnType<typeof getSupabaseAdminClient>,
  task: ClaimedTask,
  seconds: number,
) {
  if (!task.leaseOwner || seconds <= 0) return false;
  const { data, error } = await db.from('video_tasks').update({
    provider_poll_lease_owner: null,
    provider_poll_lease_until: new Date(Date.now() + seconds * 1000).toISOString(),
  }).eq('id', task.id).eq('provider_poll_lease_owner', task.leaseOwner)
    .select('id').maybeSingle();
  return !error && Boolean(data?.id);
}

async function releaseVideoHistoryTask(
  db: ReturnType<typeof getSupabaseAdminClient>,
  task: ClaimedTask,
) {
  if (!task.leaseOwner) return;
  const { error } = await db.rpc('release_video_history_poll_claim', {
    p_task_id: task.id,
    p_worker_id: task.leaseOwner,
  });
  if (error) console.warn('[VideoHistoryWorker] poll lease release deferred');
}

// This worker checks accepted provider jobs and safely closes stale unknown
// reservations. It has no submission API, never replays a provider POST, and
// does not depend on a browser being open.
export async function reconcileVideoHistoryBatch() {
  const db = getSupabaseAdminClient();
  const [, claimed] = await Promise.allSettled([
    reconcileStaleVideoSubmissionBatch({ supabase: db }),
    claimVideoHistoryTasks(db, workerId()),
  ]);
  if (claimed.status === 'rejected') throw claimed.reason;
  const tasks = claimed.value;
  for (let i = 0; i < tasks.length; i += VIDEO_HISTORY_POLL_CONCURRENCY) {
    await Promise.allSettled(tasks.slice(i, i + VIDEO_HISTORY_POLL_CONCURRENCY).map(async task => {
      let deferred = false;
      try {
        const owner = await db.from('users').select('id,role').eq('id', task.user_id).maybeSingle();
        if (owner.error || !owner.data) {
          deferred = await deferVideoHistoryTask(db, task, 120).catch(() => false);
          return;
        }
        const response = await refreshOwnedVideoTaskStatus({ userId: owner.data.id, role: owner.data.role === 'admin' ? 'admin' : 'student' },
          new URLSearchParams({ taskId: task.task_id_external, modelId: task.model_id }));
        // Consume the in-process response; no credentials or provider URLs enter logs.
        const snapshot = await response.json().catch(() => ({})) as WorkerStatusSnapshot;
        if (!response.ok) {
          console.warn('[VideoHistoryWorker] task refresh deferred', {
            taskId: task.id,
            modelId: task.model_id,
            httpStatus: response.status,
            errorCode: fixedWorkerDiagnostic(snapshot.errorCode),
          });
        }
        const cooldown = pollCooldownSeconds(response.ok, snapshot);
        if (cooldown > 0) deferred = await deferVideoHistoryTask(db, task, cooldown).catch(() => false);
      } catch (error) {
        console.warn('[VideoHistoryWorker] task refresh exception', {
          taskId: task.id,
          modelId: task.model_id,
          error: fixedWorkerDiagnostic(error instanceof Error ? error.message : error),
        });
        deferred = await deferVideoHistoryTask(db, task, VIDEO_HISTORY_POLL_FAILURE_COOLDOWN_SECONDS).catch(() => false);
      } finally {
        if (!deferred) await releaseVideoHistoryTask(db, task);
      }
    }));
  }
}
const globalWorker = globalThis as typeof globalThis & {
  __videoHistoryWorker?: DurableQueueLoop;
  __videoHistoryLeaseFallbackWarned?: boolean;
};
function loop() {
  return globalWorker.__videoHistoryWorker ??= new DurableQueueLoop({ name: 'video-history', intervalMs: 10000,
    runOnce: reconcileVideoHistoryBatch, onError: () => console.warn('[VideoHistoryWorker] status refresh deferred') });
}
export function startVideoHistoryWorker() { return loop().start(); }
export function stopVideoHistoryWorker(timeout: number) { return loop().stop(timeout); }
export function videoHistoryWorkerStatus() { return loop().snapshot(); }
