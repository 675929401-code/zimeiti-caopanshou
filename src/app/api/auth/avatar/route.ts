import crypto from 'node:crypto';
import sharp from 'sharp';
import { NextRequest, NextResponse } from 'next/server';
import { authorizeToken, getTokenFromHeaders } from '@/lib/auth';
import { UploadValidationError, validateUploadBuffer } from '@/lib/file-upload-security';
import { isUserProfileAvatarPreset } from '@/lib/user-profile-avatar';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { storageManager } from '@/storage/object';
import type { StorageProviderType } from '@/storage/object';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const MAX_PIXELS = 36_000_000;
const ACCEPTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type AvatarRow = {
  avatar_url: string;
  storage_provider: StorageProviderType | null;
  storage_key: string | null;
  source: 'preset' | 'upload';
};

type DatabaseFailure = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

function avatarDatabaseFailure(error: DatabaseFailure, fallback: string): string {
  const code = String(error.code || '').toUpperCase();
  const diagnostic = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  if (code === '42P01' || code === 'PGRST205' || /schema cache|user_profile_avatars.*not found|relation .*user_profile_avatars.*does not exist/iu.test(diagnostic)) {
    return 'AVATAR_STORAGE_NOT_READY';
  }
  console.error('[profile-avatar] database operation failed', code || fallback);
  return fallback;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

async function actorFrom(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return { ok: false as const, response: json({ error: '未登录' }, 401) };
  const authorization = await authorizeToken(token);
  if (!authorization.ok) {
    return {
      ok: false as const,
      response: json({ error: authorization.error, code: authorization.code }, authorization.status),
    };
  }
  return { ok: true as const, userId: authorization.actor.userId };
}

async function currentAvatar(userId: string): Promise<AvatarRow | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from('user_profile_avatars')
    .select('avatar_url,storage_provider,storage_key,source')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(avatarDatabaseFailure(error, 'AVATAR_READ_FAILED'));
  return data as AvatarRow | null;
}

async function removePreviousUpload(previous: AvatarRow | null, replacementKey?: string) {
  if (!previous || previous.source !== 'upload' || !previous.storage_key || !previous.storage_provider) return;
  if (previous.storage_key === replacementKey) return;
  if (!previous.storage_key.startsWith('user-profile-avatars/')
    || previous.storage_key.includes('://')
    || /[\\\u0000\r\n?#]/u.test(previous.storage_key)
    || previous.storage_key.split('/').includes('..')) {
    console.warn('[profile-avatar] skipped unsafe previous storage key');
    return;
  }
  try {
    await storageManager.delete(previous.storage_key, previous.storage_provider);
  } catch (error) {
    console.warn('[profile-avatar] previous object cleanup failed', error instanceof Error ? error.message : error);
  }
}

export async function PUT(request: NextRequest) {
  const actor = await actorFrom(request);
  if (!actor.ok) return actor.response;
  try {
    const body = await request.json().catch(() => ({})) as { presetUrl?: string };
    if (!isUserProfileAvatarPreset(body.presetUrl)) {
      return json({ error: '请选择平台提供的预设头像' }, 400);
    }
    const previous = await currentAvatar(actor.userId);
    const { error } = await getSupabaseAdminClient().from('user_profile_avatars').upsert({
      user_id: actor.userId,
      avatar_url: body.presetUrl,
      storage_provider: null,
      storage_key: null,
      source: 'preset',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw new Error(avatarDatabaseFailure(error, 'AVATAR_WRITE_FAILED'));
    await removePreviousUpload(previous);
    return json({ success: true, avatarUrl: body.presetUrl });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return json({
      error: code === 'AVATAR_STORAGE_NOT_READY' ? '头像存储尚未完成升级' : '头像保存失败',
      code: code || 'AVATAR_PRESET_FAILED',
    }, code === 'AVATAR_STORAGE_NOT_READY' ? 503 : 500);
  }
}

export async function POST(request: NextRequest) {
  const actor = await actorFrom(request);
  if (!actor.ok) return actor.response;
  let uploaded: { key: string; provider: StorageProviderType } | null = null;
  try {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return json({ error: '头像图片必须在5MB以内' }, 413);
    }
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: '请选择头像图片' }, 400);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return json({ error: '头像图片必须在5MB以内' }, 413);

    const source = Buffer.from(await file.arrayBuffer());
    if (source.byteLength !== file.size || source.byteLength > MAX_FILE_BYTES) {
      return json({ error: '头像图片大小校验失败' }, 413);
    }
    const detected = validateUploadBuffer(source, file.type || 'application/octet-stream');
    if (!ACCEPTED_MIME_TYPES.has(detected.contentType)) {
      return json({ error: '头像仅支持 PNG、JPEG 或 WebP' }, 415);
    }

    const image = sharp(source, { failOn: 'error', limitInputPixels: MAX_PIXELS, animated: false });
    const metadata = await image.metadata();
    if ((metadata.pages || 1) !== 1) return json({ error: '头像仅支持单帧图片' }, 400);
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (width < 64 || height < 64 || width > 6000 || height > 6000) {
      return json({ error: '头像尺寸应在64到6000像素之间' }, 400);
    }

    const normalized = await image
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'attention' })
      .webp({ quality: 88, smartSubsample: true })
      .toBuffer();
    const digest = crypto.createHash('sha256').update(normalized).digest('hex');
    const fileName = `${actor.userId}-${digest.slice(0, 16)}.webp`;
    const stored = await storageManager.upload(normalized, fileName, 'image/webp', {
      category: 'image',
      prefix: 'user-profile-avatars',
      fileName,
      publicRead: true,
      userId: actor.userId,
      source: 'profile-avatar-upload',
      requireOwnershipRecord: true,
      meta: {
        purpose: 'profile-avatar',
        sha256: digest,
        width: '512',
        height: '512',
      },
    });
    uploaded = { key: stored.key, provider: stored.provider };
    if (!stored.isPublic || !stored.url || stored.size !== normalized.byteLength || stored.contentType !== 'image/webp') {
      throw new Error('AVATAR_STORAGE_RECEIPT_INVALID');
    }

    const previous = await currentAvatar(actor.userId);
    const { error } = await getSupabaseAdminClient().from('user_profile_avatars').upsert({
      user_id: actor.userId,
      avatar_url: stored.url,
      storage_provider: stored.provider,
      storage_key: stored.key,
      source: 'upload',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw new Error(avatarDatabaseFailure(error, 'AVATAR_WRITE_FAILED'));
    await removePreviousUpload(previous, stored.key);
    uploaded = null;
    return json({ success: true, avatarUrl: stored.url });
  } catch (error) {
    if (uploaded) {
      try { await storageManager.delete(uploaded.key, uploaded.provider); } catch {}
    }
    if (error instanceof UploadValidationError) {
      return json({ error: '头像内容与文件格式不匹配', code: error.code }, 415);
    }
    const code = error instanceof Error ? error.message : 'AVATAR_UPLOAD_FAILED';
    console.error('[profile-avatar] upload failed', code);
    return json({
      error: code === 'AVATAR_STORAGE_NOT_READY' ? '头像存储尚未完成升级' : '头像上传失败，请稍后重试',
      code,
    }, code === 'AVATAR_STORAGE_NOT_READY' ? 503 : 500);
  }
}
