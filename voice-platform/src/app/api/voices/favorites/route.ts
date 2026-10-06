import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

function safeParseTags(tags: string | null): string[] {
  try { return tags ? JSON.parse(tags) : []; } catch { return []; }
}

export async function GET(request: NextRequest) {
  try {
    const authUser = await getUserFromRequest(request);
    if (!authUser) return errorResponse('请先登录', 'UNAUTHORIZED', 401);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const skip = (page - 1) * limit;

    const [favorites, total] = await Promise.all([
      prisma.favorite.findMany({
        where: { userId: authUser.userId, voice: { isActive: true } },
        include: { voice: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.favorite.count({ where: { userId: authUser.userId, voice: { isActive: true } } }),
    ]);

    return successResponse({
      favorites: favorites.map((f) => ({ ...f, voice: { ...f.voice, tags: safeParseTags(f.voice.tags) } })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(error.message || '查询收藏列表失败', 'FAVORITES_ERROR', 500);
  }
}
