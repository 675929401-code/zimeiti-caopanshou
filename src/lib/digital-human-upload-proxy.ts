import 'server-only';

import { NextRequest, NextResponse } from 'next/server';

import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { mediaMetadata } from '@/lib/digital-human-media';
import { safeUploadFileName, validateUploadBuffer, UploadValidationError } from '@/lib/file-upload-security';
import { storageManager } from '@/storage/object';
import { getSupabaseClient } from '@/storage/database/supabase-client';

const LIMITS = { image: 10, audio: 30, video: 100 } as const;
const MAX_REQUEST_BYTES = 102 * 1024 * 1024;
const COS_COMPATIBILITY_BYTES = 10 * 1024 * 1024;
const MAX_ACTIVE_BUFFERED_UPLOADS = 1;
const uploadRuntime = globalThis as typeof globalThis & { __digitalHumanBufferedUploads?: number };

function acquireUploadSlot() {
  const active = uploadRuntime.__digitalHumanBufferedUploads || 0;
  if (active >= MAX_ACTIVE_BUFFERED_UPLOADS) return false;
  uploadRuntime.__digitalHumanBufferedUploads = active + 1;
  return true;
}

function releaseUploadSlot() {
  uploadRuntime.__digitalHumanBufferedUploads = Math.max(0, (uploadRuntime.__digitalHumanBufferedUploads || 1) - 1);
}

function noStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { 'Cache-Control': 'private, no-store', ...(init?.headers || {}) },
  });
}

/**
 * Compatibility-only upload path. A configured COS deployment must use the
 * browser-direct ticket flow for large files, while an offline/local runtime
 * can still accept one bounded upload at a time.
 */
export async function handleDigitalHumanProxyUpload(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_REQUEST_BYTES) {
    return noStore({ error: '上传文件过大或请求大小无效' }, { status: 413 });
  }
  const storageStatus = await storageManager.getStatus();
  const cosReady = storageStatus.initializedProviders.includes('tencent_cos');
  if (cosReady && length > COS_COMPATIBILITY_BYTES) {
    return noStore(
      { error: '大文件需使用浏览器直传，请重新选择素材', code: 'DIRECT_UPLOAD_REQUIRED' },
      { status: 409 },
    );
  }
  if (!acquireUploadSlot()) {
    return noStore(
      { error: '当前有兼容上传正在处理，请稍后重试', retryAfterSeconds: 5 },
      { status: 429, headers: { 'Retry-After': '5' } },
    );
  }
  try {
    const form = await request.formData();
    const category = String(form.get('category')) as keyof typeof LIMITS;
    const file = form.get('file');
    if (!Object.prototype.hasOwnProperty.call(LIMITS, category) || !(file instanceof File) || file.size <= 0) {
      return noStore({ error: '请选择有效的素材文件' }, { status: 400 });
    }
    if (file.size > LIMITS[category] * 1024 * 1024) {
      return noStore({ error: '文件大小超出当前素材类型限制' }, { status: 413 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const detected = validateUploadBuffer(buffer, file.type || 'application/octet-stream');
    const supported = category === 'image'
      ? ['image/jpeg', 'image/png', 'image/webp', 'image/bmp']
      : category === 'audio'
        ? ['audio/mpeg', 'audio/wav', 'audio/aac']
        : ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
    if (!supported.includes(detected.contentType)) {
      return noStore({ error: '文件格式与所选素材类型不匹配' }, { status: 415 });
    }
    const info = await mediaMetadata(buffer, detected.extension, category);
    const uploaded = await storageManager.upload(buffer, safeUploadFileName(detected.extension), detected.contentType, {
      userId: auth.user.userId,
      category,
      source: 'digital-human-input',
      ...(cosReady ? { providerType: 'tencent_cos' as const, strictProvider: true } : {}),
      publicRead: false,
      requireOwnershipRecord: true,
      prefix: `digital-human-inputs/${category}/`,
      meta: { duration: String(info.duration), width: String(info.width), height: String(info.height) },
    });
    const { data, error } = await getSupabaseClient().from('user_files').select('id')
      .eq('user_id', auth.user.userId).eq('storage_key', uploaded.key).single();
    if (error || !data) throw new Error('素材归属记录未能保存，请稍后重试');
    const url = await storageManager.getSignedUrl(uploaded.key, { expireTime: 24 * 3600 }, uploaded.provider);
    return noStore({ asset: { id: data.id, category, url, ...info, size: uploaded.size }, mode: 'proxy' });
  } catch (error) {
    const message = error instanceof UploadValidationError
      ? '文件内容或格式无效'
      : error instanceof Error && /^(请上传|人物图片|人物视频|素材归属)/u.test(error.message)
        ? error.message
        : '素材上传未完成，请稍后重试';
    return noStore({ error: message }, { status: 422 });
  } finally {
    releaseUploadSlot();
  }
}
