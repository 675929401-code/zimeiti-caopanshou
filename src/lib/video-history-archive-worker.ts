import 'server-only';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { storageManager } from '@/storage/object';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { SafeFetchError } from '@/lib/safe-fetch';
import { isAutodlComfyuiHostedProtocol } from '@/lib/video-autodl-comfyui-workflow';
import { pollVideoTask, type VideoModelConfig } from '@/lib/video-adapter';
import { trustedVideoProviderResultHostname } from '@/lib/video-provider-result-url';
import {
  persistVideoFromUrl,
  persistentVideoUriForKey,
} from '@/lib/video-persistence';

const ARCHIVE_BATCH_SIZE = 4;
const ARCHIVE_CONCURRENCY = 2;
const ARCHIVE_LEASE_SECONDS = 600;

type ArchiveClaim = {
  taskId: string;
  userId: string;
  modelId: string;
  providerTaskId: string;
  providerResultUrl: string;
  attemptNo: number;
};

type JsonRow = Record<string, unknown>;

const archiveWorkerGlobal = globalThis as typeof globalThis & {
  __videoHistoryArchiveWorker?: DurableQueueLoop;
};

function archiveWorkerId() {
  const instance = String(
    process.env.MEDIA_QUEUE_WORKER_INSTANCE
      || process.env.NODE_APP_INSTANCE
      || process.env.pm_id
      || '0',
  ).replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 80);
  return `video-history-archive:${process.pid}:${instance}`;
}

function fixedErrorCode(error: unknown) {
  if (error instanceof SafeFetchError) return error.code;
  const value = error instanceof Error ? error.message : String(error || 'VIDEO_HISTORY_ARCHIVE_FAILED');
  return value
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/Bearer\s+\S+/giu, 'Bearer_[redacted]')
    .replace(/[^A-Za-z0-9_.:-]/gu, '_')
    .slice(0, 120) || 'VIDEO_HISTORY_ARCHIVE_FAILED';
}

function sourceExpired(error: unknown) {
  if (error instanceof SafeFetchError && [404, 410].includes(Number(error.upstreamStatus))) return true;
  const value = error instanceof Error ? error.message : String(error || '');
  return value === 'GAORUI_RESULT_SOURCE_EXPIRED'
    || /(?:^|[^0-9])(?:404|410)(?:[^0-9]|$)/u.test(value);
}

function retrySeconds(attemptNo: number) {
  return Math.min(3600, 30 * (2 ** Math.max(0, Math.min(6, attemptNo - 1))));
}

function normalizeClaims(value: unknown): ArchiveClaim[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => row && typeof row === 'object' ? row as JsonRow : {}).map((row) => ({
    taskId: String(row.task_id || ''),
    userId: String(row.owner_user_id || ''),
    modelId: String(row.internal_model_id || ''),
    providerTaskId: String(row.provider_task_id || ''),
    providerResultUrl: String(row.provider_result_url || ''),
    attemptNo: Math.max(1, Number(row.attempt_no) || 1),
  })).filter((row) => row.taskId && row.userId && row.modelId && row.providerResultUrl);
}

async function findExistingArchive(
  db: ReturnType<typeof getSupabaseAdminClient>,
  claim: ArchiveClaim,
) {
  const { data, error } = await db.from('user_files')
    .select('storage_key,storage_provider,file_category,meta,created_at')
    .eq('user_id', claim.userId)
    .eq('storage_provider', 'tencent_cos')
    .eq('file_category', 'video')
    .contains('meta', { taskId: claim.taskId })
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw new Error('VIDEO_HISTORY_ARCHIVE_ASSET_LOOKUP_FAILED');
  for (const row of (data || []) as JsonRow[]) {
    const key = String(row.storage_key || '');
    if (!key.startsWith('videos/generated/')) continue;
    if (await storageManager.exists(key, 'tencent_cos')) return persistentVideoUriForKey(key);
  }
  return '';
}

async function modelForArchive(
  db: ReturnType<typeof getSupabaseAdminClient>,
  modelId: string,
) {
  const { data, error } = await db.from('video_models')
    .select('id,name,provider,model_name,protocol_type,api_endpoint,api_key,api_protocol_config')
    .eq('id', modelId)
    .maybeSingle();
  if (error || !data) throw new Error('VIDEO_HISTORY_ARCHIVE_MODEL_NOT_FOUND');
  return data as JsonRow;
}

async function refreshedHostedResultUrl(
  claim: ArchiveClaim,
  model: JsonRow,
  providerApiKey: string,
) {
  if (!claim.providerTaskId || !isAutodlComfyuiHostedProtocol(model.protocol_type)) return '';
  const refreshed = await pollVideoTask({
    id: String(model.id || claim.modelId),
    name: String(model.name || model.model_name || claim.modelId),
    provider: String(model.provider || 'autodl'),
    model_name: String(model.model_name || model.id || claim.modelId),
    protocol_type: String(model.protocol_type || ''),
    api_endpoint: String(model.api_endpoint || ''),
    api_key: providerApiKey,
    api_protocol_config: (model.api_protocol_config || {}) as VideoModelConfig['api_protocol_config'],
    price_per_use: 0,
    duration_seconds: 0,
    supports_image_input: false,
  }, claim.providerTaskId);
  return refreshed.status === 'success' ? String(refreshed.videoUrl || '').trim() : '';
}

async function completeArchive(
  db: ReturnType<typeof getSupabaseAdminClient>,
  claim: ArchiveClaim,
  worker: string,
  storageUrl: string,
) {
  const { data, error } = await db.rpc('complete_video_history_archive_job', {
    p_task_id: claim.taskId,
    p_worker_id: worker,
    p_storage_url: storageUrl,
  });
  if (error || !data) throw new Error('VIDEO_HISTORY_ARCHIVE_COMMIT_FAILED');
}

async function failArchive(
  db: ReturnType<typeof getSupabaseAdminClient>,
  claim: ArchiveClaim,
  worker: string,
  error: unknown,
) {
  const expired = sourceExpired(error);
  const { error: settleError } = await db.rpc('fail_video_history_archive_attempt', {
    p_task_id: claim.taskId,
    p_worker_id: worker,
    p_error_code: fixedErrorCode(error),
    p_source_expired: expired,
    p_retry_seconds: retrySeconds(claim.attemptNo),
  });
  if (settleError) throw new Error('VIDEO_HISTORY_ARCHIVE_FAILURE_COMMIT_FAILED');
}

async function archiveClaim(
  db: ReturnType<typeof getSupabaseAdminClient>,
  claim: ArchiveClaim,
  worker: string,
) {
  try {
    let storageUrl = await findExistingArchive(db, claim);
    if (!storageUrl) {
      const model = await modelForArchive(db, claim.modelId);
      const protocolType = String(model.protocol_type || '');
      const providerEndpoint = String(model.api_endpoint || '');
      const providerApiKey = model.api_key ? resolveProviderSecret(String(model.api_key)) : '';
      const trustedProviderResult = trustedVideoProviderResultHostname(claim.providerResultUrl, {
        protocolType,
        apiProtocolConfig: model.api_protocol_config,
        apiEndpoint: providerEndpoint,
      });
      const persistenceOptions = {
        providerProtocol: protocolType,
        providerEndpoint,
        providerApiKey,
        providerTaskId: claim.providerTaskId,
        trustedProviderResultHostname: trustedProviderResult,
      };
      try {
        storageUrl = await persistVideoFromUrl(
          claim.providerResultUrl,
          claim.taskId,
          claim.userId,
          persistenceOptions,
        );
      } catch (initialError) {
        const refreshedUrl = await refreshedHostedResultUrl(claim, model, providerApiKey)
          .catch(() => '');
        if (!refreshedUrl) throw initialError;
        storageUrl = await persistVideoFromUrl(
          refreshedUrl,
          claim.taskId,
          claim.userId,
          {
            ...persistenceOptions,
            trustedProviderResultHostname: trustedVideoProviderResultHostname(refreshedUrl, {
              protocolType,
              apiProtocolConfig: model.api_protocol_config,
              apiEndpoint: providerEndpoint,
            }),
          },
        );
      }
    }
    await completeArchive(db, claim, worker, storageUrl);
  } catch (error) {
    await failArchive(db, claim, worker, error).catch((settleError) => {
      console.warn('[VideoHistoryArchiveWorker] attempt settlement deferred', {
        taskId: claim.taskId,
        errorCode: fixedErrorCode(settleError),
      });
    });
  }
}

export async function reconcileVideoHistoryArchiveBatch() {
  const db = getSupabaseAdminClient();
  const worker = archiveWorkerId();
  const { data, error } = await db.rpc('claim_video_history_archive_batch', {
    p_worker_id: worker,
    p_limit: ARCHIVE_BATCH_SIZE,
    p_lease_seconds: ARCHIVE_LEASE_SECONDS,
  });
  if (error) {
    const description = `${String(error.code || '')} ${String(error.message || '')}`;
    if (/PGRST202|42883|claim_video_history_archive_batch/iu.test(description)) return { claimed: 0, unavailable: true };
    throw new Error('VIDEO_HISTORY_ARCHIVE_CLAIM_FAILED');
  }
  const claims = normalizeClaims(data);
  for (let offset = 0; offset < claims.length; offset += ARCHIVE_CONCURRENCY) {
    await Promise.all(claims.slice(offset, offset + ARCHIVE_CONCURRENCY).map((claim) => (
      archiveClaim(db, claim, worker)
    )));
  }
  return { claimed: claims.length, unavailable: false };
}

function loop() {
  return archiveWorkerGlobal.__videoHistoryArchiveWorker ??= new DurableQueueLoop({
    name: 'video-history-archive',
    intervalMs: 15_000,
    runOnce: async () => { await reconcileVideoHistoryArchiveBatch(); },
    onError: () => console.warn('[VideoHistoryArchiveWorker] batch deferred'),
  });
}

export function startVideoHistoryArchiveWorker() { return loop().start(); }
export function stopVideoHistoryArchiveWorker(timeout: number) { return loop().stop(timeout); }
export function videoHistoryArchiveWorkerStatus() { return loop().snapshot(); }
