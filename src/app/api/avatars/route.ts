import { NextRequest, NextResponse } from 'next/server';
import { parseImageRenditionWidth, renderWebpRendition } from '@/lib/server/image-rendition';

// GET - Stream avatar image by key
// Usage: /api/avatars?key=<storage_key>
// Avatar images are public-facing content, no strict auth required.
// Supports multiple key sources:
//   1. Coze S3 keys (coze_storage_xxx/...) — uses StorageManager with fallback
//   2. Local relative paths (avatars/xxx) — reads from public/ directory
// Streams image content directly to avoid cross-origin redirect issues with <img> tags.

async function avatarResponse(
  request: NextRequest,
  source: Uint8Array,
  contentType: string,
  cacheKey: string,
  maxAge: number,
  renditionWidth: number | null,
) {
  const rendition = renditionWidth
    ? await renderWebpRendition(source, { cacheKey, width: renditionWidth })
    : null;
  const body = rendition?.bytes || source;
  const etag = rendition ? `"sha256-${rendition.sha256}"` : null;
  const headers = new Headers({
    'Content-Type': rendition ? 'image/webp' : contentType,
    'Content-Length': String(body.byteLength),
    'Cache-Control': `public, max-age=${maxAge}, immutable`,
    'X-Accel-Buffering': 'no',
    ...(etag ? { ETag: etag } : {}),
  });
  if (etag && request.headers.get('if-none-match') === etag) {
    headers.delete('Content-Length');
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(new Uint8Array(body), { status: 200, headers });
}

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key');
  let renditionWidth: number | null;

  try {
    renditionWidth = parseImageRenditionWidth(request.nextUrl.searchParams.get('w'));
  } catch {
    return NextResponse.json({ error: '无效的头像尺寸' }, { status: 400 });
  }

  if (!key) {
    return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
  }

  // Basic key validation: reject obviously malicious paths
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) {
    return NextResponse.json({ error: '无效的 key' }, { status: 400 });
  }

  // Avatar access is public — no auth required

  // Strategy 1: If it's a local file path (avatars/xxx), try local first, then Supabase Storage
  if (key.startsWith('avatars/') || key.startsWith('uploads/')) {
    try {
      const path = await import('path');
      const fs = await import('fs/promises');
      const isUpload = key.startsWith('uploads/');
      const configuredRoot = isUpload
        ? process.env.STORAGE_LOCAL_BASE_PATH
        : process.env.PUBLIC_ASSET_ROOT;
      if (process.env.NODE_ENV === 'production' && !configuredRoot) {
        throw new Error(isUpload ? 'STORAGE_LOCAL_BASE_PATH is required' : 'PUBLIC_ASSET_ROOT is required');
      }
      const baseRoot = path.resolve(
        /* turbopackIgnore: true */
        configuredRoot || path.join(/* turbopackIgnore: true */ process.cwd(), 'public'),
      );
      const relativeKey = isUpload ? key.slice('uploads/'.length) : key;
      const fullPath = path.resolve(/* turbopackIgnore: true */ baseRoot, relativeKey);
      if (fullPath !== baseRoot && !fullPath.startsWith(`${baseRoot}${path.sep}`)) {
        return NextResponse.json({ error: '无效的 key' }, { status: 400 });
      }

      const buffer = await fs.readFile(/* turbopackIgnore: true */ fullPath);
      const ext = path.extname(key).toLowerCase();
      const contentType = ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';

      return avatarResponse(request, buffer, contentType, `local:${key}`, 604800, renditionWidth);
    } catch (localErr) {
      // Local file not found — try Supabase Storage as fallback
      console.warn('[Avatars] Local file not found, trying Supabase Storage:', key);
      try {
        const fileName = key.split('/').pop() || key;
        const supabaseUrl = `https://br-sunny-crab-4eaf4f50.supabase2.aidap-global.cn-beijing.volces.com/storage/v1/object/public/avatars/${fileName}`;
        const imageResponse = await fetch(supabaseUrl);
        if (imageResponse.ok) {
          const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
          const imageBuffer = await imageResponse.arrayBuffer();
          return avatarResponse(request, new Uint8Array(imageBuffer), contentType, `supabase:${key}`, 86400, renditionWidth);
        }
      } catch (supabaseErr) {
        console.warn('[Avatars] Supabase Storage fallback also failed:', supabaseErr instanceof Error ? supabaseErr.message : supabaseErr);
      }
      return NextResponse.json({ error: '获取头像失败' }, { status: 500 });
    }
  }

  // Strategy 2: Try StorageManager (supports Coze S3 + fallback providers)
  try {
    const { storageManager } = await import('@/storage/object');

    // First try reading the file content directly
    const buffer = await storageManager.read(key);
    const ext = key.split('.').pop()?.toLowerCase() || 'jpeg';
    const contentType = ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';

    return avatarResponse(request, buffer, contentType, `storage:${key}`, 86400, renditionWidth);
  } catch (storageErr) {
    console.warn('[Avatars] StorageManager read failed:', storageErr instanceof Error ? storageErr.message : storageErr);
  }

  // Strategy 3: Try direct S3Storage (for Coze platform where SDK auto-injects credentials)
  if (process.env.COZE_BUCKET_ENDPOINT_URL) {
    try {
      const { S3Storage } = await import('coze-coding-dev-sdk');
      const storage = new S3Storage({
        endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
        accessKey: '',
        secretKey: '',
        bucketName: process.env.COZE_BUCKET_NAME,
        region: 'cn-beijing',
      });

      const url = await storage.generatePresignedUrl({
        key,
        expireTime: 86400,
      });

      const imageResponse = await fetch(url);
      if (imageResponse.ok) {
        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
        const imageBuffer = await imageResponse.arrayBuffer();

        return avatarResponse(request, new Uint8Array(imageBuffer), contentType, `s3:${key}`, 86400, renditionWidth);
      }
    } catch (s3Err) {
      console.warn('[Avatars] S3Storage fallback failed:', s3Err instanceof Error ? s3Err.message : s3Err);
    }
  }

  console.error('[Avatars] All strategies failed for key:', key);
  return NextResponse.json({ error: '获取头像失败' }, { status: 500 });
}
