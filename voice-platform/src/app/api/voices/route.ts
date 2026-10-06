import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { Prisma } from '@prisma/client';

function safeParseTags(tags: string | null): string[] {
  try { return tags ? JSON.parse(tags) : []; } catch { return []; }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || '';
    const category = searchParams.get('category') || '';
    const type = searchParams.get('type') || '';
    const gender = searchParams.get('gender') || '';
    const favorites = searchParams.get('favorites') === 'true';
    const mine = searchParams.get('mine') === 'true';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '200')));
    const skip = (page - 1) * limit;

    const authUser = await getUserFromRequest(request);

    const where: Prisma.VoiceWhereInput = { isActive: true };

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { description: { contains: search } },
        { speakerId: { contains: search } },
      ];
    }
    if (category) where.category = category;
    if (type) where.type = type;
    if (gender) where.gender = gender;

    // "我的音色" Tab: 当前用户创建的复刻/设计音色
    if (mine) {
      if (!authUser) {
        return successResponse({ voices: [], total: 0, page, limit });
      }
      delete where.type; // 清除type单独筛选，mine限定为 cloned+designed
      where.userId = authUser.userId;
      where.type = { in: ['cloned', 'designed'] };
    }

    // "收藏音色" Tab: 通过收藏关联查询
    if (favorites) {
      if (!authUser) {
        return successResponse({ voices: [], total: 0, page, limit });
      }
      const favVoiceIds = await prisma.favorite.findMany({
        where: { userId: authUser.userId },
        select: { voiceId: true },
      });
      where.id = { in: favVoiceIds.map(f => f.voiceId) };
    }

    const [voices, total] = await Promise.all([
      prisma.voice.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.voice.count({ where }),
    ]);

    return successResponse({
      voices: voices.map(v => ({ ...v, tags: safeParseTags(v.tags) })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(error.message || '查询音色列表失败', 'VOICES_ERROR', 500);
  }
}
