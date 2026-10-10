import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-middleware';
import { beijingCalendarDayWindowStart } from '@/lib/beijing-history-window';
import { storageManager, type StorageProviderType } from '@/storage/object';
import { parseImageFailureRequestSnapshot } from '@/lib/image-failure-history';

export const dynamic = 'force-dynamic';
const ID = /^[A-Za-z0-9:_-]{8,160}$/;
const PAGE_SIZE = 20;
type Obj = Record<string, any>;
type Asset = { id: string; user_id: string; storage_key: string; storage_provider: StorageProviderType; created_at: string };

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as Obj)?.message || '');
  if (/IMAGE_HISTORY_NOT_FOUND/.test(message)) return NextResponse.json({ error: '历史记录不存在或无权访问' }, { status: 404 });
  return NextResponse.json({ error: '账户历史暂时无法同步，请稍后重试' }, { status: 503 });
}
function recordInput(value: unknown): Obj | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Obj;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !['text-to-image', 'image-to-image'].includes(r.mode)
    || !['1:1','3:4','4:3','16:9','9:16'].includes(r.aspectRatio)
    || typeof r.modelName !== 'string' || r.modelName.length > 200
    || !Array.isArray(r.items) || r.items.length < 1 || r.items.length > 100) return null;
  if (r.items.some((item: Obj) => !item || typeof item.assetId !== 'string' || !ID.test(item.assetId) || typeof item.historyRecordId !== 'string' || !ID.test(item.historyRecordId)
    || typeof item.prompt !== 'string' || item.prompt.length > 50_000)) return null;
  if (new Set(r.items.map((item: Obj) => item.assetId)).size !== r.items.length) return null;
  return r;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
  const page = Number(request.nextUrl.searchParams.get('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) return NextResponse.json({ error: '页码无效' }, { status: 400 });
  try {
    const rows = await db.from('image_workbench_history').select('id,document,created_at')
      .eq('owner_id', user.id).eq('deleted', false)
      .gte('created_at', beijingCalendarDayWindowStart())
      .order('created_at', { ascending: false }).order('id')
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (rows.error) throw rows.error;
    const loaded = (rows.data || []) as Array<{ id: string; document: Obj; created_at: string }>;
    // A malformed legacy row must not make every valid image from the same
    // account disappear behind a page-wide 503. Validate before touching
    // document.items and isolate only the bad row; never log its prompt data.
    const documents = loaded.slice(0, PAGE_SIZE).flatMap((row) => {
      const document = recordInput(row.document);
      if (!document) {
        console.warn("[ImageWorkbench/History] skipped malformed account row", { historyId: row.id });
        return [];
      }
      return [{ ...row, document }];
    });
    const ids = [...new Set(documents.flatMap(row => row.document.items.map((item: Obj) => String(item.assetId))))];
    const assets = new Map<string, Asset>();
    // Keep asset lookups bounded even when many full batches share one history page.
    for (let offset = 0; offset < ids.length; offset += 100) {
      const lookup = await db.from('user_files').select('id,user_id,storage_key,storage_provider,created_at')
        .eq('user_id', user.id).eq('file_category', 'image').in('id', ids.slice(offset, offset + 100));
      if (lookup.error) throw lookup.error;
      for (const asset of (lookup.data || []) as Asset[]) assets.set(asset.id, asset);
    }
    const records = await Promise.all(documents.map(async row => ({
      ...row.document, id: row.id, createdAt: new Date(row.created_at).getTime(),
      items: await Promise.all(row.document.items.map(async (item: Obj) => {
        const asset = assets.get(item.assetId);
        let imageUrl = '';
        if (asset) {
          try { imageUrl = await storageManager.getSignedUrl(asset.storage_key, { expireTime: 3600 }, asset.storage_provider); } catch { /* Keep the history and allow refreshing. */ }
        }
        return { ...item, imageUrl, storageKey: asset?.storage_key || '' };
      })),
    })));
    return NextResponse.json({ records, nextPage: loaded.length > PAGE_SIZE ? page + 1 : null }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return failure(error); }
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 2_097_152) return NextResponse.json({ error: '历史内容过大，请分批同步' }, { status: 413 });
    let body: Obj;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ error: '历史格式无效' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 5
      || Object.keys(body).some(key => key !== 'records')) return NextResponse.json({ error: '历史格式无效' }, { status: 400 });
    const records = body.records.map(recordInput);
    if (records.some((record: Obj | null) => !record)) return NextResponse.json({ error: '历史记录内容无效' }, { status: 400 });
    const valid = records as Obj[];
    const items = valid.flatMap(record => record.items as Obj[]);
    if (items.length > 200) return NextResponse.json({ error: '图片过多，请分批同步' }, { status: 413 });
    const lookup = await db.from('user_files').select('id,user_id,storage_key,storage_provider,created_at')
      .eq('user_id', user.id).eq('file_category', 'image').in('id', items.map(item => item.assetId));
    if (lookup.error) throw lookup.error;
    const assets = new Map<string, Asset>(((lookup.data || []) as Asset[]).map(asset => [asset.id, asset]));
    const messages = await db.from('conversation_messages').select('id,content').eq('user_id', user.id)
      .eq('agent_id', 'image-workbench').in('id', items.map(item => item.historyRecordId));
    if (messages.error) throw messages.error;
    const messageAssets = new Map<string, Set<string>>();
    for (const row of (messages.data || []) as Array<{ id: string; content: string }>) {
      try { const value = JSON.parse(row.content); messageAssets.set(row.id, new Set((value.images || []).map((image: Obj) => image.assetId))); } catch { /* Invalid legacy rows are not imported. */ }
    }
    if (items.some(item => !assets.has(item.assetId) || !messageAssets.get(item.historyRecordId)?.has(item.assetId))) {
      return NextResponse.json({ error: '只能同步本人已保存的生成图片' }, { status: 403 });
    }
    const attempts = await db.from('image_generation_requests').select('delivery_asset_id,client_idempotency_key,client_trace_id,payload_fingerprint,request_snapshot')
      .eq('user_id', user.id).eq('state', 'completed').eq('delivery_state', 'delivered').in('delivery_asset_id', [...assets.keys()]);
    if (attempts.error) throw attempts.error;
    const attemptRows = (attempts.data || []) as Array<{ delivery_asset_id: string; client_idempotency_key: string; client_trace_id: string; payload_fingerprint: string; request_snapshot: unknown }>;
    const operationFor = (key: string) => 'h3_' + createHash('sha256').update(user.id + ':' + key).digest('hex').slice(0, 48);
    const billingKeys = attemptRows.map(row => 'image:' + operationFor(row.client_idempotency_key));
    const billing = billingKeys.length ? await db.from('wallet_operations').select('idempotency_key,amount,metadata')
      .eq('user_id', user.id).eq('operation_kind', 'cash_charge').eq('status', 'completed').in('idempotency_key', billingKeys) : { data: [], error: null };
    if (billing.error) throw billing.error;
    const charges = new Map<string, Obj>(((billing.data || []) as Obj[]).map(row => [row.idempotency_key, row]));
    const receipts = new Map<string, Obj>(attemptRows.map(row => {
      const operationId = operationFor(row.client_idempotency_key);
      const charge = charges.get('image:' + operationId);
      const snapshot = parseImageFailureRequestSnapshot(row.request_snapshot);
      const integrity = snapshot?.payloadFingerprint && snapshot.payloadFingerprint === row.payload_fingerprint
        ? {
            schema: snapshot.schema,
            payloadFingerprint: snapshot.payloadFingerprint,
            effectivePrompt: snapshot.effectivePrompt,
            style: snapshot.style || '',
            referenceUsage: snapshot.referenceUsage || 'general',
            providerProtocol: snapshot.providerProtocol,
            outputPixelSize: snapshot.outputPixelSize,
            imageCount: snapshot.imageCount || 1,
          }
        : { schema: snapshot?.schema || 'legacy', payloadFingerprint: row.payload_fingerprint, imageCount: 1 };
      return [row.delivery_asset_id, { operationId, traceId: row.client_trace_id,
        resolution: charge?.metadata?.price_snapshot?.resolution,
        requestIntegrity: integrity,
        ...(charge && Number.isFinite(Number(charge.amount)) ? { cashCharged: Number(charge.amount) } : {}),
      }];
    }));
    const prepared = valid.map(record => {
      const normalized = record.items.map((item: Obj) => {
        const receipt = receipts.get(item.assetId);
        const charge = typeof receipt?.cashCharged === 'number' && Number.isFinite(receipt.cashCharged) ? receipt.cashCharged : undefined;
        return { id: item.assetId, assetId: item.assetId, historyRecordId: item.historyRecordId, prompt: item.prompt,
          ...(receipt?.taskId || receipt?.traceId ? { taskId: receipt.taskId || receipt.traceId } : {}),
          ...(receipt?.operationId ? { operationId: receipt.operationId } : {}),
          ...(receipt?.requestIntegrity ? { requestIntegrity: receipt.requestIntegrity } : {}),
          ...(['1K','2K','4K'].includes(receipt?.resolution) ? { resolution: receipt!.resolution } : {}),
          ...(charge !== undefined ? { cashCharged: charge } : {}),
        };
      });
      const createdAt = Math.max(...record.items.map((item: Obj) => new Date(assets.get(item.assetId)!.created_at).getTime()));
      const document = { id: record.id, createdAt, mode: record.mode, aspectRatio: record.aspectRatio,
        modelName: record.modelName, items: normalized,
        ...(['1K','2K','4K'].includes(record.resolution) ? { resolution: record.resolution } : {}),
        ...(normalized.every((item: Obj) => item.cashCharged !== undefined)
          ? { totalCharged: Number(normalized.reduce((sum: number, item: Obj) => sum + item.cashCharged, 0).toFixed(6)) } : {}),
      };
      return { document, createdAt };
    });
    if (prepared.some(({ document, createdAt }) => !Number.isFinite(createdAt) || Buffer.byteLength(JSON.stringify(document), 'utf8') > 262144)) {
      return NextResponse.json({ error: '历史记录过大或日期无效' }, { status: 400 });
    }
    const saved = [];
    for (const { document, createdAt } of prepared) {
      const result = await db.rpc('save_image_workbench_history', { p_owner_id: user.id, p_id: document.id,
        p_document: document, p_created_at: new Date(createdAt).toISOString() });
      if (result.error) throw result.error;
      saved.push({ id: result.data.id, deleted: result.data.deleted });
    }
    return NextResponse.json({ saved });
  } catch (error) { return failure(error); }
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
  const id = request.nextUrl.searchParams.get('id');
  const all = request.nextUrl.searchParams.get('all') === '1';
  if ((id !== null && !ID.test(id)) || (!id && !all) || (!!id && all)) return NextResponse.json({ error: '请选择需要删除的历史' }, { status: 400 });
  try {
    const result = await db.rpc('delete_image_workbench_history', { p_owner_id: user.id, p_id: id });
    if (result.error) throw result.error;
    return NextResponse.json(result.data);
  } catch (error) { return failure(error); }
  });
}
