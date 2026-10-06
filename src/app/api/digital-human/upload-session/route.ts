import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import {
  assertDigitalHumanUploadRecord,
  DIGITAL_HUMAN_FINAL_SOURCE,
  DIGITAL_HUMAN_MAGIC_BYTES,
  DIGITAL_HUMAN_PENDING_SOURCE,
  DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS,
  digitalHumanUploadObjectKey,
  digitalHumanUploadTicketId,
  DigitalHumanUploadError,
  normalizeUploadContentType,
  parseDigitalHumanUploadTicketInput,
  uploadTicketExpired,
  type DigitalHumanUploadCategory,
  type UploadTicketRecord,
} from '@/lib/digital-human-direct-upload';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { mediaMetadata, mediaMetadataFromCosUrl } from '@/lib/digital-human-media';
import { storageManager } from '@/storage/object';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export const runtime = 'nodejs';
const RECORD_SELECT = 'id,user_id,storage_key,storage_provider,file_name,file_category,file_size,content_type,source,meta,is_public,created_at';
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/u;

function noStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { 'Cache-Control': 'private, no-store', ...(init?.headers || {}) },
  });
}

async function cleanupPending(record: UploadTicketRecord) {
  const db = getSupabaseClient();
  if (record.storage_provider === 'tencent_cos') {
    await storageManager.deleteObjectOnly(record.storage_key, 'tencent_cos').catch(() => false);
  }
  await db.from('user_files').delete().eq('id', record.id).eq('user_id', record.user_id)
    .eq('source', DIGITAL_HUMAN_PENDING_SOURCE);
}

async function ownedRecord(userId: string, ticketId: string) {
  const result = await getSupabaseClient().from('user_files').select(RECORD_SELECT)
    .eq('id', ticketId).eq('user_id', userId).maybeSingle();
  if (result.error) throw new Error('UPLOAD_TICKET_READ_FAILED');
  return result.data as UploadTicketRecord | null;
}

function requestIdentity(body: Record<string, unknown>, userId: string) {
  const requestId = String(body.requestId || '').trim();
  const ticketId = String(body.ticketId || '').trim().toLowerCase();
  if (!REQUEST_ID.test(requestId) || ticketId !== digitalHumanUploadTicketId(userId, requestId)) {
    throw new DigitalHumanUploadError('上传会话无效，请重新选择素材', 'UPLOAD_SESSION_INVALID', 400);
  }
  return { requestId, ticketId };
}

export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  let record: UploadTicketRecord | null = null;
  try {
    const body = await request.json() as Record<string, unknown>;
    const identity = requestIdentity(body, auth.user.userId);
    record = await ownedRecord(auth.user.userId, identity.ticketId);
    if (!record) throw new DigitalHumanUploadError('上传会话不存在或已过期', 'UPLOAD_SESSION_NOT_FOUND', 404);
    const category = record.file_category as DigitalHumanUploadCategory;
    assertDigitalHumanUploadRecord(record, auth.user.userId, {
      requestId: identity.requestId,
      category,
      size: Number(record.file_size),
      contentType: normalizeUploadContentType(record.content_type),
    });
    if (record.source === DIGITAL_HUMAN_FINAL_SOURCE) {
      return noStore({ completed: true, idempotentReplay: true, asset: await ownedDigitalHumanAsset(auth.user.userId, record.id) });
    }
    if (record.source !== DIGITAL_HUMAN_PENDING_SOURCE || record.storage_provider !== 'tencent_cos') {
      throw new DigitalHumanUploadError('上传会话状态无效', 'UPLOAD_SESSION_STATE_INVALID', 409);
    }
    if (uploadTicketExpired(record, DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS)) {
      throw new DigitalHumanUploadError('上传会话已过期，请重新选择素材', 'UPLOAD_SESSION_EXPIRED', 410, true);
    }

    const head = await storageManager.head(record.storage_key, 'tencent_cos');
    if (!head) {
      return noStore(
        { error: '文件尚未上传完成，请稍后重试', code: 'UPLOAD_NOT_VISIBLE', retryAfterSeconds: 2 },
        { status: 409, headers: { 'Retry-After': '2' } },
      );
    }
    if (head.size !== Number(record.file_size)
        || normalizeUploadContentType(head.contentType) !== normalizeUploadContentType(record.content_type)) {
      throw new DigitalHumanUploadError('上传文件大小或格式与会话不一致', 'UPLOAD_HEAD_MISMATCH', 422, true);
    }

    const prefix = await storageManager.readRange(
      record.storage_key,
      0,
      Math.min(head.size, DIGITAL_HUMAN_MAGIC_BYTES) - 1,
      'tencent_cos',
    );
    const verified = parseDigitalHumanUploadTicketInput({
      requestId: identity.requestId,
      category,
      size: head.size,
      contentType: record.content_type,
      originalName: record.meta?.originalName,
      prefixBase64: prefix.toString('base64'),
    });
    const expectedKey = digitalHumanUploadObjectKey(
      auth.user.userId,
      identity.requestId,
      category,
      verified.detected.extension,
    );
    if (record.storage_key !== expectedKey) {
      throw new DigitalHumanUploadError('上传对象与当前账号不匹配', 'UPLOAD_OBJECT_MISMATCH', 409, true);
    }

    let metadata: { duration: number; width: number; height: number };
    try {
      metadata = category === 'image'
        ? await mediaMetadata(await storageManager.read(record.storage_key, 'tencent_cos'), verified.detected.extension, 'image')
        : await mediaMetadataFromCosUrl(
          await storageManager.getSignedUrl(record.storage_key, { expireTime: 120 }, 'tencent_cos'),
          category,
        );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      if (/^(?:请上传|人物图片|人物视频)/u.test(message)) {
        throw new DigitalHumanUploadError(message, 'UPLOAD_MEDIA_INVALID', 422, true);
      }
      throw cause;
    }
    const finalMeta = {
      ...(record.meta || {}),
      uploadState: 'completed',
      uploadCompletedAt: new Date().toISOString(),
      duration: String(metadata.duration),
      width: String(metadata.width),
      height: String(metadata.height),
    };
    const updated = await getSupabaseClient().from('user_files').update({
      source: DIGITAL_HUMAN_FINAL_SOURCE,
      file_name: `${record.id}${verified.detected.extension}`,
      file_size: head.size,
      content_type: verified.detected.contentType,
      meta: finalMeta,
    }).eq('id', record.id).eq('user_id', auth.user.userId)
      .eq('source', DIGITAL_HUMAN_PENDING_SOURCE).select('id').maybeSingle();
    if (updated.error) throw new Error('UPLOAD_TICKET_FINALIZE_FAILED');
    if (!updated.data) {
      const replay = await ownedRecord(auth.user.userId, record.id);
      if (replay?.source !== DIGITAL_HUMAN_FINAL_SOURCE) throw new Error('UPLOAD_TICKET_FINALIZE_CONFLICT');
    }
    return noStore({ completed: true, idempotentReplay: !updated.data, asset: await ownedDigitalHumanAsset(auth.user.userId, record.id) });
  } catch (cause) {
    if (cause instanceof DigitalHumanUploadError) {
      if (cause.permanent && record?.source === DIGITAL_HUMAN_PENDING_SOURCE) await cleanupPending(record);
      return noStore({ error: cause.message, code: cause.code }, { status: cause.status });
    }
    return noStore({ error: '暂时无法确认上传结果，请使用原会话重试', code: 'UPLOAD_COMPLETE_RETRY' }, { status: 503, headers: { 'Retry-After': '3' } });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const identity = requestIdentity(await request.json() as Record<string, unknown>, auth.user.userId);
    const record = await ownedRecord(auth.user.userId, identity.ticketId);
    if (!record) return noStore({ cancelled: true, idempotentReplay: true });
    if (record.source === DIGITAL_HUMAN_FINAL_SOURCE) {
      return noStore({ cancelled: false, completed: true, message: '素材已经上传完成' });
    }
    if (record.source !== DIGITAL_HUMAN_PENDING_SOURCE) {
      throw new DigitalHumanUploadError('上传会话状态无效', 'UPLOAD_SESSION_STATE_INVALID', 409);
    }
    await cleanupPending(record);
    return noStore({ cancelled: true, idempotentReplay: false });
  } catch (cause) {
    if (cause instanceof DigitalHumanUploadError) {
      return noStore({ error: cause.message, code: cause.code }, { status: cause.status });
    }
    return noStore({ error: '暂时无法清理上传会话，请稍后重试' }, { status: 503, headers: { 'Retry-After': '3' } });
  }
}
