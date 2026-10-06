import { NextRequest } from 'next/server';
import { extractAudioFromLink } from '@/lib/link-extractor';
import { cloneVoice } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { deductBalance } from '@/lib/billing';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';

const SITE_API_KEY = process.env.SITE_API_KEY?.trim() ?? '';

/**
 * POST /api/voice/link-clone
 * 
 * 短视频链接一键克隆音色
 * 
 * 认证方式（双模式）：
 *   模式A（主站）: Header: X-Site-API-Key + Body: { userId }
 *   模式B（前端）: Header: Authorization: Bearer <JWT>
 * 
 * 请求：
 *   { url: string, name?: string, duration?: number }
 * 
 * 响应：
 *   { success: true,
 *     data: { speakerId, videoTitle, videoCover, status } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, name, duration = 20, userId: bodyUserId } = body;

    // 参数校验
    if (!url || typeof url !== 'string') {
      return errorResponse('请输入视频链接', 'MISSING_URL', 400);
    }

    if (duration < 14 || duration > 30) {
      return errorResponse('音频时长范围 14-30 秒', 'INVALID_DURATION', 400);
    }

    // 认证
    const siteKey = request.headers.get('X-Site-API-Key');
    let userId: string | null = null;

    if (siteKey && siteKey === SITE_API_KEY && bodyUserId) {
      const user = await prisma.user.findUnique({ where: { id: bodyUserId }, select: { id: true } });
      if (!user) return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
      userId = user.id;
    } else {
      const authUser = await getUserFromRequest(request);
      if (!authUser) return errorResponse('请先登录', 'UNAUTHORIZED', 401);
      userId = authUser.userId;
    }

    // Step 1-3: 提取链接 → 转换音频 → 预处理
    let audioResult;
    try {
      audioResult = await extractAudioFromLink(url, duration);
    } catch (err: any) {
      const msg = err.message || '链接处理失败';
      if (msg.includes('不是视频')) {
        return errorResponse(msg, 'NOT_VIDEO', 400);
      }
      return errorResponse(msg, 'LINK_PARSE_ERROR', 502);
    }

    // Step 4: 调用火山引擎声音复刻
    const speakerId = `S_${Date.now()}`;
    let cloneResult;
    try {
      cloneResult = await cloneVoice({
        speakerId,
        audioBase64: audioResult.wavBase64,
        audioFormat: 'wav',
        language: 0,
      });
    } catch (err: any) {
      return errorResponse(`声音克隆失败: ${err.message}`, 'CLONE_ERROR', 500);
    }

    // Step 5: 创建数据库记录
    const voiceName = name || audioResult.title || `链接克隆_${speakerId}`;
    await prisma.voice.create({
      data: {
        speakerId,
        name: voiceName,
        type: 'cloned',
        category: 'custom',
        language: 'zh-cn',
        isActive: true,
        userId,
      },
    });

    // Step 6: 扣费
    try {
      await deductBalance(userId, 0, `link-clone-${speakerId}`, `链接克隆: ${voiceName}`);
    } catch {
      // 扣费失败不阻塞克隆结果
    }

    return successResponse({
      speakerId: cloneResult.speakerId,
      videoTitle: audioResult.title,
      videoCover: audioResult.cover,
      status: cloneResult.status,
      availableTrainingTimes: cloneResult.availableTrainingTimes,
      demoAudio: cloneResult.speakerStatus?.[0]?.demoAudio || '',
    }, '链接克隆已提交');
  } catch (error: any) {
    return errorResponse(
      error.message || '链接克隆失败',
      'INTERNAL_ERROR',
      500
    );
  }
}
