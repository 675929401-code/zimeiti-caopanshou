import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST - 收藏音色
export async function POST(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const authUser = await getUserFromRequest(request);

    if (!authUser) {
      return errorResponse('请先登录', 'UNAUTHORIZED', 401);
    }

    const { id } = await context.params;

    // 检查音色是否存在
    const voice = await prisma.voice.findUnique({ where: { id } });
    if (!voice) {
      return errorResponse('音色不存在', 'VOICE_NOT_FOUND', 404);
    }

    // 检查是否已收藏
    const existing = await prisma.favorite.findUnique({
      where: {
        userId_voiceId: {
          userId: authUser.userId,
          voiceId: id,
        },
      },
    });

    if (existing) {
      return errorResponse('已经收藏过该音色', 'ALREADY_FAVORITED', 409);
    }

    const favorite = await prisma.favorite.create({
      data: {
        userId: authUser.userId,
        voiceId: id,
      },
    });

    return successResponse(favorite, '收藏成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '收藏失败',
      'FAVORITE_ERROR',
      500
    );
  }
}

// DELETE - 取消收藏
export async function DELETE(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const authUser = await getUserFromRequest(request);

    if (!authUser) {
      return errorResponse('请先登录', 'UNAUTHORIZED', 401);
    }

    const { id } = await context.params;

    // 检查是否已收藏
    const existing = await prisma.favorite.findUnique({
      where: {
        userId_voiceId: {
          userId: authUser.userId,
          voiceId: id,
        },
      },
    });

    if (!existing) {
      return errorResponse('未收藏该音色', 'NOT_FAVORITED', 404);
    }

    await prisma.favorite.delete({
      where: {
        userId_voiceId: {
          userId: authUser.userId,
          voiceId: id,
        },
      },
    });

    return successResponse(null, '取消收藏成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '取消收藏失败',
      'FAVORITE_ERROR',
      500
    );
  }
}
