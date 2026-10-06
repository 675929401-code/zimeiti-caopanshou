import { NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/response';
import { getUserFromRequest } from '@/lib/auth';
import * as fs from 'fs';
import * as path from 'path';
import { referenceAudioPublicUrl, resolveReferenceAudioDirectory } from '@/lib/runtime-paths';

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
      const ext = videoUrl.includes('.mp4') ? 'mp4' : 'mp3';
      const filename = `${timestamp}_link_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const publicDir = resolveReferenceAudioDirectory();
      const filepath = path.join(publicDir, filename);

      if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
      }

      const downloadRes = await fetch(videoUrl, { signal: AbortSignal.timeout(60000) });
      if (downloadRes.ok) {
        const buffer = Buffer.from(await downloadRes.arrayBuffer());
        fs.writeFileSync(filepath, buffer);
        localAudioUrl = referenceAudioPublicUrl(filename);
        console.log(`[extract-audio] Saved to: ${filepath} (${buffer.length} bytes)`);
      }
    } catch (downErr: any) {
      console.warn('[extract-audio] Download to local failed:', downErr.message);
      // 下载失败不影响返回，fallback 到原始 URL
    }

    return successResponse({
      audioUrl: videoUrl,
      localAudioUrl,
      title: title.slice(0, 50),
      cover,
      source: ppt6Data.data?.type === 1 ? 'video' : 'image',
      savedLocally: !!localAudioUrl,
    });
  } catch (err: any) {
    return errorResponse(err.message || '提取失败', 'EXTRACT_ERROR', 500);
  }
}
