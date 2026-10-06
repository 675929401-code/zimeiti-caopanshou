import { NextRequest } from 'next/server';
import { designVoice } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';

const SITE_API_KEY = process.env.SITE_API_KEY?.trim() ?? '';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      speakerId,
      text,
      prompt,
      language,
      name,
      userId: bodyUserId,
    } = body;

    // 认证：支持两种方式
    // 方式1: 主站调用，通过 X-Site-API-Key + userId 参数
    // 方式2: 前端调用，通过 JWT Bearer Token
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

    // 参数校验
    if (!speakerId || typeof speakerId !== 'string') {
      return errorResponse('speakerId 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!text || typeof text !== 'string') {
      return errorResponse('text 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!prompt || typeof prompt !== 'object') {
      return errorResponse('prompt 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!prompt.textPrompt && !prompt.imageUrl && !prompt.imageBytes) {
      return errorResponse(
        'prompt 中必须包含 textPrompt、imageUrl 或 imageBytes 之一',
        'VALIDATION_ERROR',
        400
      );
    }

    // 调用火山引擎声音设计
    const result = await designVoice({
      speakerId,
      text,
      prompt: {
        textPrompt: prompt.textPrompt,
        imageUrl: prompt.imageUrl,
        imageBytes: prompt.imageBytes,
      },
      language,
    });

    // 创建 Voice 记录
    await prisma.voice.create({
      data: {
        speakerId,
        name: name || `设计音色 ${speakerId}`,
        type: 'designed',
        category: 'custom',
        language: language ? String(language) : 'zh-cn',
        isActive: true,
        userId,
      },
    });

    return successResponse({
      speakerId: result.speakerId,
      status: result.status,
      demoAudio: result.demoAudio,
    }, '声音设计请求已提交');
  } catch (error: any) {
    return errorResponse(
      error.message || '声音设计失败',
      'VOICE_DESIGN_ERROR',
      500
    );
  }
}
