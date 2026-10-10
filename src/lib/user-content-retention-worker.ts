import 'server-only';
import { DurableQueueLoop } from '@/lib/durable-queue-loop';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

const RETENTION_INTERVAL_MS = 15 * 60_000;
const RETENTION_BATCH_LIMIT = 500;
const RETENTION_MAX_BATCHES_PER_TICK = 10;

type RetentionResult = {
  conversation_settings_deleted?: number;
  conversation_attachments_deleted?: number;
  conversation_messages_deleted?: number;
  conversations_deleted?: number;
  extractions_purged?: number;
  has_more?: boolean;
};

function isMissingRetentionRpc(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(value.code || '');
  const description = `${String(value.message || '')} ${String(value.details || '')}`;
  return code === 'PGRST202'
    || code === '42883'
    || (/purge_expired_user_content/iu.test(description)
      && /(?:schema cache|not find|does not exist|undefined function)/iu.test(description));
}

const retentionGlobal = globalThis as typeof globalThis & {
  __userContentRetentionWorker?: DurableQueueLoop;
  __userContentRetentionMigrationWarned?: boolean;
};

export async function purgeExpiredUserContentBatch() {
  const db = getSupabaseAdminClient();
  const totals = {
    conversationSettingsDeleted: 0,
    conversationAttachmentsDeleted: 0,
    conversationMessagesDeleted: 0,
    conversationsDeleted: 0,
    extractionsPurged: 0,
  };

  for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TICK; batch += 1) {
    const { data, error } = await db.rpc('purge_expired_user_content', {
      p_conversation_days: 30,
      p_extraction_days: 10,
      p_limit: RETENTION_BATCH_LIMIT,
    });
    if (error) {
      if (isMissingRetentionRpc(error)) {
        if (!retentionGlobal.__userContentRetentionMigrationWarned) {
          retentionGlobal.__userContentRetentionMigrationWarned = true;
          console.warn('[UserContentRetention] migration unavailable; cleanup remains fail-closed');
        }
        return totals;
      }
      throw new Error('USER_CONTENT_RETENTION_RPC_FAILED');
    }

    const result = (data || {}) as RetentionResult;
    totals.conversationSettingsDeleted += Number(result.conversation_settings_deleted || 0);
    totals.conversationAttachmentsDeleted += Number(result.conversation_attachments_deleted || 0);
    totals.conversationMessagesDeleted += Number(result.conversation_messages_deleted || 0);
    totals.conversationsDeleted += Number(result.conversations_deleted || 0);
    totals.extractionsPurged += Number(result.extractions_purged || 0);
    if (!result.has_more) break;
  }

  if (Object.values(totals).some((count) => count > 0)) {
    console.info('[UserContentRetention] expired content removed', totals);
  }
  return totals;
}

function loop() {
  return retentionGlobal.__userContentRetentionWorker ??= new DurableQueueLoop({
    name: 'user-content-retention',
    intervalMs: RETENTION_INTERVAL_MS,
    runOnce: async () => { await purgeExpiredUserContentBatch(); },
    onError: () => console.warn('[UserContentRetention] cleanup deferred'),
  });
}

export function startUserContentRetentionWorker() { return loop().start(); }
export function stopUserContentRetentionWorker(timeout: number) { return loop().stop(timeout); }
export function userContentRetentionWorkerStatus() { return loop().snapshot(); }
