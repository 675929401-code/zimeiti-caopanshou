import { createHash } from 'node:crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type CoverOrigin = { assetId: string; backgroundAssetId: string; title: string; ratio: string };
type ImageReceipt = { cost: number; modelName: string };
type ImageOrigin = { surface: string };
type Attempt = {
  delivery_asset_id: string;
  client_idempotency_key: string;
  request_snapshot?: Record<string, unknown> | null;
};

// Each stage depends on the output of the previous one, but its own batches
// are independent reads. Keep both concurrency and result application order
// bounded so duplicate rows and per-batch failures retain their old semantics.
const PROVENANCE_BATCH_SIZE = 100;
const PROVENANCE_BATCH_CONCURRENCY = 3;

async function readOrderedBatches<T>(
  values: string[],
  query: (batch: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
  consume: (result: { data: T[] | null; error: unknown }) => void,
) {
  for (let offset = 0; offset < values.length; offset += PROVENANCE_BATCH_SIZE * PROVENANCE_BATCH_CONCURRENCY) {
    const batches: string[][] = [];
    for (let index = 0; index < PROVENANCE_BATCH_CONCURRENCY; index += 1) {
      const start = offset + index * PROVENANCE_BATCH_SIZE;
      if (start >= values.length) break;
      batches.push(values.slice(start, start + PROVENANCE_BATCH_SIZE));
    }
    // A rejected query must not leave sibling reads running after the parent
    // snapshot releases its concurrency permit. Defer query creation too, so
    // a synchronous adapter error is captured without orphaning earlier reads.
    const results = await Promise.allSettled(batches.map(batch => Promise.resolve().then(() => query(batch))));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    for (const result of results) consume((result as PromiseFulfilledResult<{ data: T[] | null; error: unknown }>).value);
  }
}

/** Read only current-owner assets and confirmed wallet operations; never derive charges from supplier prices. */
export async function loadMediaImageProvenance(userId: string, assetIds: string[]) {
  const db = getSupabaseClient();
  const covers = new Map<string, CoverOrigin>();
  const receipts = new Map<string, ImageReceipt>();
  const origins = new Map<string, ImageOrigin>();
  let failed = false;
  await readOrderedBatches<{ asset_id: unknown; background_asset_id: unknown; plan?: { title?: unknown; aspectRatio?: unknown } | null }>(
    assetIds,
    batch => db.from('cover_generation_history').select('asset_id,background_asset_id,plan')
      .eq('user_id', userId).in('asset_id', batch),
    result => {
    if (result.error) { failed = true; return; }
    for (const row of result.data || []) covers.set(String(row.asset_id), { assetId: String(row.asset_id),
      backgroundAssetId: String(row.background_asset_id), title: String(row.plan?.title || '封面'), ratio: String(row.plan?.aspectRatio || '') });
    },
  );
  const generationAssets = [...new Set([...assetIds, ...[...covers.values()].map(cover => cover.backgroundAssetId)])];
  const attempts: Attempt[] = [];
  await readOrderedBatches<Attempt>(
    generationAssets,
    batch => db.from('image_generation_requests').select('delivery_asset_id,client_idempotency_key,request_snapshot')
      .eq('user_id', userId).eq('state', 'completed').eq('delivery_state', 'delivered')
      .in('delivery_asset_id', batch),
    result => {
      if (result.error) { failed = true; return; }
      attempts.push(...(result.data || []));
    },
  );
  const keyFor = (key: string) => 'image:h3_' + createHash('sha256').update(userId + ':' + key).digest('hex').slice(0, 48);
  const walletKeys = [...new Set(attempts.map(attempt => keyFor(attempt.client_idempotency_key)))];
  const charges = new Map<string, ImageReceipt>();
  await readOrderedBatches<{ idempotency_key: unknown; amount: unknown; metadata?: { model_name?: unknown } | null }>(
    walletKeys,
    batch => db.from('wallet_operations').select('idempotency_key,amount,metadata')
      .eq('user_id', userId).eq('operation_kind', 'cash_charge').eq('status', 'completed')
      .in('idempotency_key', batch),
    result => {
    if (result.error) { failed = true; return; }
    for (const row of result.data || []) {
      const amount = Number(row.amount);
      if (row.amount !== null && Number.isFinite(amount) && amount >= 0) charges.set(String(row.idempotency_key),
        { cost: amount, modelName: String(row.metadata?.model_name || '图片生成模型') });
    }
    },
  );
  for (const attempt of attempts) {
    const surface = String(attempt.request_snapshot?.surface || '').trim();
    if (surface) origins.set(attempt.delivery_asset_id, { surface });
    const receipt = charges.get(keyFor(attempt.client_idempotency_key));
    if (receipt) receipts.set(attempt.delivery_asset_id, receipt);
  }
  return { covers, receipts, origins, failed };
}
