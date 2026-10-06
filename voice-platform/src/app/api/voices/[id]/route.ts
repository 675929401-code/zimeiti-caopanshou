import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const { id } = await context.params;

    const voice = await prisma.voice.findUnique({
      where: { id },
    });

    if (!voice) {
      return errorResponse('音色不存在', 'VOICE_NOT_FOUND', 404);
    }

    // 检查当前用户是否已收藏
    const authUser = await getUserFromRequest(request);
    let isFavorited = false;

    if (authUser) {
      const favorite = await prisma.favorite.findUnique({
        where: {
          userId_voiceId: {
            userId: authUser.userId,
            voiceId: id,
          },
        },
      });
      isFavorited = !!favorite;
    }

    return successResponse({
      ...voice,
      tags: JSON.parse(voice.tags),
      isFavorited,
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '查询音色详情失败',
      'VOICE_DETAIL_ERROR',
      500
    );
  }
}
