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

/** Read only current-owner assets and confirmed wallet operations; never derive charges from supplier prices. */
export async function loadMediaImageProvenance(userId: string, assetIds: string[]) {
  const db = getSupabaseClient();
  const covers = new Map<string, CoverOrigin>();
  const receipts = new Map<string, ImageReceipt>();
  const origins = new Map<string, ImageOrigin>();
  let failed = false;
  for (let offset = 0; offset < assetIds.length; offset += 100) {
    const result = await db.from('cover_generation_history').select('asset_id,background_asset_id,plan')
      .eq('user_id', userId).in('asset_id', assetIds.slice(offset, offset + 100));
    if (result.error) { failed = true; continue; }
    for (const row of result.data || []) covers.set(String(row.asset_id), { assetId: String(row.asset_id),
      backgroundAssetId: String(row.background_asset_id), title: String(row.plan?.title || '封面'), ratio: String(row.plan?.aspectRatio || '') });
  }
  const generationAssets = [...new Set([...assetIds, ...[...covers.values()].map(cover => cover.backgroundAssetId)])];
  const attempts: Attempt[] = [];
  for (let offset = 0; offset < generationAssets.length; offset += 100) {
    const result = await db.from('image_generation_requests').select('delivery_asset_id,client_idempotency_key,request_snapshot')
      .eq('user_id', userId).eq('state', 'completed').eq('delivery_state', 'delivered')
      .in('delivery_asset_id', generationAssets.slice(offset, offset + 100));
    if (result.error) { failed = true; continue; }
    attempts.push(...(result.data || []) as Attempt[]);
  }
  const keyFor = (key: string) => 'image:h3_' + createHash('sha256').update(userId + ':' + key).digest('hex').slice(0, 48);
  const walletKeys = [...new Set(attempts.map(attempt => keyFor(attempt.client_idempotency_key)))];
  const charges = new Map<string, ImageReceipt>();
  for (let offset = 0; offset < walletKeys.length; offset += 100) {
    const result = await db.from('wallet_operations').select('idempotency_key,amount,metadata')
      .eq('user_id', userId).eq('operation_kind', 'cash_charge').eq('status', 'completed')
      .in('idempotency_key', walletKeys.slice(offset, offset + 100));
    if (result.error) { failed = true; continue; }
    for (const row of result.data || []) {
      const amount = Number(row.amount);
      if (row.amount !== null && Number.isFinite(amount) && amount >= 0) charges.set(String(row.idempotency_key),
        { cost: amount, modelName: String(row.metadata?.model_name || '图片生成模型') });
    }
  }
  for (const attempt of attempts) {
    const surface = String(attempt.request_snapshot?.surface || '').trim();
    if (surface) origins.set(attempt.delivery_asset_id, { surface });
    const receipt = charges.get(keyFor(attempt.client_idempotency_key));
    if (receipt) receipts.set(attempt.delivery_asset_id, receipt);
  }
  return { covers, receipts, origins, failed };
}
