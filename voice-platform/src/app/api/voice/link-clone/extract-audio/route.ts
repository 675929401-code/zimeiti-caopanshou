import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/response';
import { getUserFromRequest } from '@/lib/auth';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_REFERENCE_AUDIO_FILE_BYTES,
  registerReferenceAudioOwnership,
  resolveReferenceAudioDirectory,
} from '@/lib/runtime-paths';

async function readBodyWithinLimit(response: Response, maximumBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('参考音频响应没有可读取内容');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel('REFERENCE_AUDIO_TOO_LARGE').catch(() => undefined);
        throw new Error('下载的参考音频超过 15MB 限制');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function POST(request: NextRequest) {
  try {
    const authUser = await getUserFromRequest(request);
    if (!authUser) {
      return errorResponse('请先登录', 'UNAUTHORIZED', 401);
    }

    const ppt6ClientId = process.env.PPT6_CLIENT_ID?.trim() ?? '';
    const ppt6ClientSecret = process.env.PPT6_CLIENT_SECRET?.trim() ?? '';
    if (!ppt6ClientId || !ppt6ClientSecret) {
      return errorResponse('视频解析服务尚未配置', 'PPT6_NOT_CONFIGURED', 503);
    }

    const { url } = await request.json();
    if (!url) return errorResponse('请提供视频链接', 'MISSING_URL', 400);

    // Step 1: PPT6 解析视频。凭据仅从服务器环境变量读取，不进入源码或日志。
    const apiUrl = `https://apis.ppt6.top?clientId=${encodeURIComponent(ppt6ClientId)}&clientSecretKey=${encodeURIComponent(ppt6ClientSecret)}&url=${encodeURIComponent(url)}`;
    const ppt6Res = await fetch(apiUrl, { signal: AbortSignal.timeout(25000) });
    const ppt6Data = await ppt6Res.json();

    if (ppt6Data.code !== 200) {
      return errorResponse(ppt6Data.msg || '视频解析失败', 'PARSE_ERROR', 500);
    }

    const videoUrl = ppt6Data.data?.video_url || ppt6Data.data?.video_mp4 || '';
    const title = ppt6Data.data?.title || ppt6Data.data?.desc || '参考音频';
    const cover = ppt6Data.data?.cover || '';

    if (!videoUrl) {
      return errorResponse('未找到视频地址', 'NO_VIDEO_URL', 404);
    }

    // Step 2: 下载到版本目录之外的持久参考音频挂载。
    let localAudioUrl: string | null = null;
    try {
      const timestamp = Date.now();
      const publicDir = resolveReferenceAudioDirectory();

      if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true, mode: 0o750 });
      }

      const downloadRes = await fetch(videoUrl, { signal: AbortSignal.timeout(60000) });
      if (downloadRes.ok) {
        const declaredBytes = Number(downloadRes.headers.get('content-length') || '0');
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REFERENCE_AUDIO_FILE_BYTES) {
          throw new Error('下载的参考音频超过 15MB 限制');
        }
        // Enforce the limit while streaming; Content-Length can be absent or false.
        // Reading the entire untrusted body first would allow excessive memory use.
        const buffer = await readBodyWithinLimit(downloadRes, MAX_REFERENCE_AUDIO_FILE_BYTES);
        if (buffer.length <= 0 || buffer.length > MAX_REFERENCE_AUDIO_FILE_BYTES) {
          throw new Error('下载的参考音频大小无效');
        }
        const contentType = downloadRes.headers.get('content-type')?.toLowerCase() || '';
        const ext = contentType.includes('mp4') || videoUrl.includes('.mp4') ? 'mp4' : 'mp3';
        const filename = `${timestamp}_link_${randomUUID()}.${ext}`;
        const filepath = path.join(publicDir, filename);
        const temporary = `${filepath}.uploading-${process.pid}-${randomUUID()}`;
        fs.writeFileSync(temporary, buffer, { flag: 'wx', mode: 0o640 });
        try {
          fs.renameSync(temporary, filepath);
          registerReferenceAudioOwnership(authUser.userId, filename, title.slice(0, 50), publicDir);
        } catch (error) {
          fs.rmSync(temporary, { force: true });
          fs.rmSync(filepath, { force: true });
          throw error;
        }
        localAudioUrl = `/voice-platform/api/reference-audio?filename=${encodeURIComponent(filename)}`;
      }
    } catch (downErr: unknown) {
      console.warn('[extract-audio] Download to local failed:', downErr instanceof Error ? downErr.message : 'unknown error');
      // 下载失败不影响返回，fallback 到原始 URL
    }

    return successResponse({
      // 上游调用继续使用供应商 URL；本地副本只通过 owner-scoped API 读取。
      audioUrl: videoUrl,
      localAudioUrl,
      filename: localAudioUrl ? new URL(localAudioUrl, 'http://voice.local').searchParams.get('filename') : null,
      title: title.slice(0, 50),
      cover,
      source: ppt6Data.data?.type === 1 ? 'video' : 'image',
      savedLocally: !!localAudioUrl,
    });
  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : '提取失败', 'EXTRACT_ERROR', 500);
  }
}
