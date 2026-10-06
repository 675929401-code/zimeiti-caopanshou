import { NextRequest } from 'next/server';
import { cloneVoice } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';

const SITE_API_KEY = process.env.SITE_API_KEY?.trim() ?? '';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      speakerId,
      audioBase64,
      audioFormat,
      language,
      text,
      extraParams,
      name,
      userId: bodyUserId,
    } = body;

    // 认证：支持两种方式
    // 方式1: 主站调用，通过 X-Site-API-Key + userId 参数
    // 方式2: 前端调用，通过 JWT Bearer Token
    const siteKey = request.headers.get('X-Site-API-Key');
    let userId: string | null = null;

    if (siteKey && SITE_API_KEY && siteKey === SITE_API_KEY && bodyUserId) {
      // 主站认证：验证 userId 是否存在
      const user = await prisma.user.findUnique({ where: { id: bodyUserId }, select: { id: true } });
      if (!user) return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
      userId = user.id;
    } else {
      // JWT 认证
      const authUser = await getUserFromRequest(request);
      if (!authUser) return errorResponse('请先登录', 'UNAUTHORIZED', 401);
      userId = authUser.userId;
    }

    // 参数校验
    if (!speakerId || typeof speakerId !== 'string') {
      return errorResponse('speakerId 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return errorResponse('audioBase64 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!audioFormat || typeof audioFormat !== 'string') {
      return errorResponse('audioFormat 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    // 支持的音频格式
    const supportedFormats = ['wav', 'mp3', 'ogg', 'm4a', 'wma'];
    if (!supportedFormats.includes(audioFormat.toLowerCase())) {
      return errorResponse(
        `不支持的音频格式，支持: ${supportedFormats.join(', ')}`,
        'VALIDATION_ERROR',
        400
      );
    }

    // 调用火山引擎声音复刻
    const result = await cloneVoice({
      speakerId,
      audioBase64,
      audioFormat,
      language,
      text,
      extraParams,
    });

    // 创建 Voice 记录
    await prisma.voice.create({
      data: {
        speakerId,
        name: name || `克隆音色 ${speakerId}`,
        type: 'cloned',
        category: 'custom',
        language: language ? String(language) : 'zh-cn',
        isActive: true,
        userId,
      },
    });

    return successResponse({
      speakerId: result.speakerId,
      status: result.status,
    }, '声音复刻请求已提交');
  } catch (error: any) {
    return errorResponse(
      error.message || '声音复刻失败',
      'VOICE_CLONE_ERROR',
      500
    );
  }
}
