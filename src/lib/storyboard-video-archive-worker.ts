import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { storageManager } from '@/storage/object';
import { persistStableVideoFromUrl } from '@/lib/video-persistence';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { trustedVideoProviderResultHostname } from '@/lib/video-provider-result-url';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';
import { STORYBOARD_ARCHIVE_PREFIX } from '@/lib/storyboard-video-archive-policy';

type Claim = { task_id: string; user_id: string; model_id: string; provider_task_id: string; source_url: string;
  lease_token: string; object_key: string | null; expires_at: string; cleanup: boolean; attempt_no: number };
const workerGlobal = globalThis as typeof globalThis & { __storyboardArchiveLoop?: DurableQueueLoop };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function processClaim(job: Claim) {
  const db = getSupabaseAdminClient();
  const mutate = async (action: string, key = job.object_key, metadata?: { size: number; contentType: string }) => {
    const { error } = await db.rpc('storyboard_archive_mutate', {
      p_task_id: job.task_id, p_token: job.lease_token, p_action: action, p_key: key,
      p_error: action === 'fail' ? 'ARCHIVE_ATTEMPT_FAILED' : null, p_metadata: metadata || null,
    });
    if (error) throw new Error('STORYBOARD_ARCHIVE_MUTATION_FAILED');
  };
  // A lease token fences database publication. Reserved immutable keys also make a
  // process crash after COS PUT recoverable without another upstream download.
  const heartbeat = setInterval(() => { void mutate('renew').catch(() => {}); }, 60_000);
  heartbeat.unref?.();
  try {
    if (job.cleanup) {
      if (job.object_key) {
        const head = await storageManager.headStoryboardArchiveObjectOnly(job.object_key);
        if (head && !await storageManager.deleteStoryboardArchiveObjectOnly(job.object_key)) throw new Error('ARCHIVE_DELETE_FAILED');
      }
      await mutate('cleaned');
      return;
    }
    if (!job.object_key) {
      job.object_key = `${STORYBOARD_ARCHIVE_PREFIX}${hash(job.user_id)}/${hash(job.task_id)}/${randomUUID()}.mp4`;
      await mutate('prepare');
    }
    let head = await storageManager.headStoryboardArchiveObjectOnly(job.object_key);
    if (!head) {
      const { data: model, error } = await db.from('video_models')
        .select('protocol_type,api_endpoint,api_key,api_protocol_config').eq('id', job.model_id).maybeSingle();
      if (error || !model || !job.source_url) throw new Error('ARCHIVE_SOURCE_UNAVAILABLE');
      const trustedHostname = trustedVideoProviderResultHostname(job.source_url, {
        protocolType: model.protocol_type, apiEndpoint: model.api_endpoint, apiProtocolConfig: model.api_protocol_config,
      });
      await mutate('renew');
      await persistStableVideoFromUrl(job.source_url, job.task_id, job.user_id, {
        storageScope: 'storyboard-delivery', storyboardArchiveKey: job.object_key, storyboardArchiveExpiresAt: job.expires_at,
        providerProtocol: String(model.protocol_type || ''), providerEndpoint: String(model.api_endpoint || ''),
        providerApiKey: resolveProviderSecret(String(model.api_key || '')), providerTaskId: job.provider_task_id,
        trustedProviderResultHostname: trustedHostname,
      });
      head = await storageManager.headStoryboardArchiveObjectOnly(job.object_key);
    }
    if (!head || head.size <= 0 || !head.contentType.startsWith('video/')) throw new Error('ARCHIVE_OBJECT_INVALID');
    await mutate('complete', job.object_key, head);
  } catch {
    // The reserved key is retained even when ownership/publication fails. Expiry
    // claims it for cleanup; retries inspect it before attempting another PUT.
    await mutate('fail').catch(() => {});
  } finally { clearInterval(heartbeat); }
}

export async function reconcileStoryboardVideoArchiveBatch() {
  const { data, error } = await getSupabaseAdminClient().rpc('claim_storyboard_video_archive', {
    p_worker_id: `storyboard-archive:${process.pid}:${process.env.NODE_APP_INSTANCE || '0'}`, p_limit: 2,
  });
  if (error) throw new Error('STORYBOARD_ARCHIVE_CLAIM_FAILED');
  await Promise.all(((data || []) as Claim[]).map(processClaim));
}
function loop() {
  return workerGlobal.__storyboardArchiveLoop ??= new DurableQueueLoop({ name: 'storyboard-video-archive', intervalMs: 5000,
    runOnce: reconcileStoryboardVideoArchiveBatch, onError: () => console.warn('[StoryboardArchiveWorker] queue attempt deferred') });
}
export function startStoryboardVideoArchiveWorker() { return loop().start(); }
export function stopStoryboardVideoArchiveWorker(timeout: number) { return loop().stop(timeout); }
export function storyboardVideoArchiveWorkerStatus() { return loop().snapshot(); }
