import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import {
  assertDigitalHumanUploadRecord,
  DIGITAL_HUMAN_FINAL_SOURCE,
  DIGITAL_HUMAN_MAX_PENDING_PER_USER,
  DIGITAL_HUMAN_PENDING_SOURCE,
  DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS,
  DIGITAL_HUMAN_UPLOAD_TICKET_TTL_SECONDS,
  digitalHumanUploadMeta,
  digitalHumanUploadObjectKey,
  digitalHumanUploadTicketId,
  DigitalHumanUploadError,
  parseDigitalHumanUploadTicketInput,
  uploadTicketExpired,
  type UploadTicketRecord,
} from '@/lib/digital-human-direct-upload';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { storageManager } from '@/storage/object';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const runtime = 'nodejs';
const MAX_JSON_BYTES = 96 * 1024;
const PENDING_SELECT = 'id,user_id,storage_key,storage_provider,file_name,file_category,file_size,content_type,source,meta,is_public,created_at';

function noStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { 'Cache-Control': 'private, no-store', ...(init?.headers || {}) },
  });
}

async function cleanupExpiredPending() {
  const db = getSupabaseClient();
  const expiredBefore = new Date(
    Date.now() - DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS * 1000,
  ).toISOString();
  const { data } = await db.from('user_files').select(PENDING_SELECT)
    .eq('source', DIGITAL_HUMAN_PENDING_SOURCE)
    .lt('meta->>uploadExpiresAt', expiredBefore)
    .order('created_at', { ascending: true })
    .limit(20);
  for (const raw of data || []) {
    const row = raw as UploadTicketRecord;
    if (!uploadTicketExpired(row, DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS)) continue;
    if (row.storage_provider === 'tencent_cos') {
      await storageManager.deleteObjectOnly(String(row.storage_key), 'tencent_cos').catch(() => false);
    }
    await db.from('user_files').delete().eq('id', row.id).eq('user_id', row.user_id)
      .eq('source', DIGITAL_HUMAN_PENDING_SOURCE);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_JSON_BYTES) return noStore({ error: '上传初始化请求过大' }, { status: 413 });

  try {
    const input = parseDigitalHumanUploadTicketInput(await request.json() as Record<string, unknown>);
    const status = await storageManager.getStatus();
    if (!status.initializedProviders.includes('tencent_cos')) {
      return noStore({
        mode: 'proxy',
        requestId: input.requestId,
        uploadUrl: '/api/digital-human/upload',
        maxBytes: input.size,
        message: '本地未配置腾讯 COS，已切换为受限兼容上传',
      });
    }

    await cleanupExpiredPending();
    const db = getSupabaseClient();
    const ticketId = digitalHumanUploadTicketId(auth.user.userId, input.requestId);
    const objectKey = digitalHumanUploadObjectKey(
      auth.user.userId,
      input.requestId,
      input.category,
      input.detected.extension,
    );
    const existingResult = await db.from('user_files').select(PENDING_SELECT)
      .eq('id', ticketId).eq('user_id', auth.user.userId).maybeSingle();
    let record = existingResult.data as UploadTicketRecord | null;
    if (record) {
      assertDigitalHumanUploadRecord(record, auth.user.userId, input);
      if (record.storage_key !== objectKey || record.storage_provider !== 'tencent_cos') {
        throw new DigitalHumanUploadError('上传对象与请求不匹配', 'UPLOAD_OBJECT_CONFLICT', 409);
      }
      if (record.source === DIGITAL_HUMAN_FINAL_SOURCE) {
        return noStore({ mode: 'completed', requestId: input.requestId, asset: await ownedDigitalHumanAsset(auth.user.userId, record.id) });
      }
      if (record.source !== DIGITAL_HUMAN_PENDING_SOURCE) {
        throw new DigitalHumanUploadError('上传请求状态无效', 'UPLOAD_STATE_INVALID', 409);
      }
      if (uploadTicketExpired(record, DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS)) {
        await storageManager.deleteObjectOnly(record.storage_key, 'tencent_cos').catch(() => false);
        await db.from('user_files').delete().eq('id', record.id).eq('user_id', auth.user.userId);
        record = null;
      }
    }

    if (!record) {
      const { count } = await db.from('user_files').select('id', { count: 'exact', head: true })
        .eq('user_id', auth.user.userId).eq('source', DIGITAL_HUMAN_PENDING_SOURCE);
      if (Number(count) >= DIGITAL_HUMAN_MAX_PENDING_PER_USER) {
        return noStore(
          { error: '已有多个素材正在上传，请等待当前上传完成后重试', retryAfterSeconds: 5 },
          { status: 429, headers: { 'Retry-After': '5' } },
        );
      }
      const expiresAt = new Date(Date.now() + DIGITAL_HUMAN_UPLOAD_TICKET_TTL_SECONDS * 1000).toISOString();
      const inserted = await db.from('user_files').insert({
        id: ticketId,
        user_id: auth.user.userId,
        storage_key: objectKey,
        storage_provider: 'tencent_cos',
        file_name: `${ticketId}${input.detected.extension}`,
        file_category: input.category,
        file_size: input.size,
        content_type: input.contentType,
        source: DIGITAL_HUMAN_PENDING_SOURCE,
        meta: digitalHumanUploadMeta(input, expiresAt),
        is_public: false,
      }).select(PENDING_SELECT).maybeSingle();
      if (inserted.error || !inserted.data) {
        const replay = await db.from('user_files').select(PENDING_SELECT)
          .eq('id', ticketId).eq('user_id', auth.user.userId).maybeSingle();
        if (!replay.data) throw new Error('UPLOAD_TICKET_PERSIST_FAILED');
        record = replay.data as UploadTicketRecord;
        assertDigitalHumanUploadRecord(record, auth.user.userId, input);
      } else {
        record = inserted.data as UploadTicketRecord;
      }
    }

    const refreshedExpiresAt = new Date(Date.now() + DIGITAL_HUMAN_UPLOAD_TICKET_TTL_SECONDS * 1000).toISOString();
    const refreshed = await db.from('user_files').update({
      meta: { ...(record.meta || {}), uploadExpiresAt: refreshedExpiresAt, uploadState: 'pending' },
    }).eq('id', ticketId).eq('user_id', auth.user.userId).eq('source', DIGITAL_HUMAN_PENDING_SOURCE)
      .select(PENDING_SELECT).maybeSingle();
    if (refreshed.error || !refreshed.data) throw new Error('UPLOAD_TICKET_REFRESH_FAILED');
    record = refreshed.data as UploadTicketRecord;

    const direct = await storageManager.createDirectUploadTicket({
      key: objectKey,
      contentType: input.contentType,
      contentLength: input.size,
      expireTime: DIGITAL_HUMAN_UPLOAD_TICKET_TTL_SECONDS,
    }, 'tencent_cos').catch(async () => {
      await storageManager.deleteObjectOnly(objectKey, 'tencent_cos').catch(() => false);
      await db.from('user_files').delete().eq('id', ticketId).eq('user_id', auth.user.userId)
        .eq('source', DIGITAL_HUMAN_PENDING_SOURCE);
      throw new Error('DIRECT_UPLOAD_AUTHORIZATION_FAILED');
    });

    return noStore({
      mode: 'direct',
      requestId: input.requestId,
      ticketId,
      upload: {
        url: direct.url,
        method: direct.method,
        headers: direct.headers,
        expiresAt: direct.expiresAt,
      },
      completeUrl: '/api/digital-human/upload-session',
    }, { status: existingResult.data ? 200 : 201 });
  } catch (cause) {
    if (cause instanceof DigitalHumanUploadError) {
      return noStore({ error: cause.message, code: cause.code }, { status: cause.status });
    }
    return noStore({ error: '暂时无法初始化上传，请稍后重试' }, { status: 503, headers: { 'Retry-After': '5' } });
  }
}
