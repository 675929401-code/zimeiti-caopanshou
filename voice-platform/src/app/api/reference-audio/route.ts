import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { errorResponse, successResponse } from '@/lib/response';
import { getUserFromRequest } from '@/lib/auth';
import {
  deleteOwnedReferenceAudio,
  getOwnedReferenceAudio,
  listOwnedReferenceAudio,
  ReferenceAudioStorageError,
  renameOwnedReferenceAudio,
} from '@/lib/runtime-paths';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function storageFailure(error: unknown, fallbackCode: string) {
  if (error instanceof ReferenceAudioStorageError) {
    return errorResponse(error.message, error.code, error.status);
  }
  return errorResponse('参考音频服务暂不可用', fallbackCode, 500);
}

async function authenticate(request: NextRequest) {
  return getUserFromRequest(request);
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

// GET /api/reference-audio — 仅列出当前登录用户拥有的文件；带 filename 时返回受认证的文件内容。
export async function GET(request: NextRequest) {
  const user = await authenticate(request);
  if (!user) return errorResponse('请先登录', 'UNAUTHORIZED', 401);

  try {
    const filename = request.nextUrl.searchParams.get('filename');
    if (filename) {
      const file = getOwnedReferenceAudio(user.userId, filename);
      const requestedRange = request.headers.get('range');
      const range = parseByteRange(requestedRange, file.size);
      if (requestedRange && !range) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'private, no-store' },
        });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? file.size - 1;
      const body = Readable.toWeb(fs.createReadStream(file.filepath, { start, end })) as ReadableStream;
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
          'Content-Type': file.mimeType,
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    const files = listOwnedReferenceAudio(user.userId).slice(0, 20).map((file) => ({
      filename: file.filename,
      url: `/voice-platform/api/reference-audio?filename=${encodeURIComponent(file.filename)}`,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
      displayName: file.displayName,
      customName: file.customName,
      source: file.filename.includes('_link_') ? 'link' : 'upload',
    }));
    return successResponse({ files });
  } catch (error) {
    return storageFailure(error, 'LIST_ERROR');
  }
}

// PUT /api/reference-audio — 仅允许所有者重命名。
export async function PUT(request: NextRequest) {
  const user = await authenticate(request);
  if (!user) return errorResponse('请先登录', 'UNAUTHORIZED', 401);

  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse('请求格式无效', 'INVALID_REQUEST', 400);
    }
    const { filename, displayName } = body as Record<string, unknown>;
    const file = renameOwnedReferenceAudio(user.userId, filename, displayName);
    return successResponse({ filename: file.filename, displayName: file.displayName });
  } catch (error) {
    return storageFailure(error, 'RENAME_ERROR');
  }
}

// DELETE /api/reference-audio?filename=xxx — 仅允许所有者删除。
export async function DELETE(request: NextRequest) {
  const user = await authenticate(request);
  if (!user) return errorResponse('请先登录', 'UNAUTHORIZED', 401);

  try {
    const deleted = deleteOwnedReferenceAudio(user.userId, request.nextUrl.searchParams.get('filename'));
    return successResponse({ deleted });
  } catch (error) {
    return storageFailure(error, 'DELETE_ERROR');
  }
}
