import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';
import { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '50')));
    const skip = (page - 1) * limit;
    const search = searchParams.get('search') || '';
    const type = searchParams.get('type') || '';
    const isActive = searchParams.get('isActive');

    // 构建查询条件
    const where: Prisma.VoiceWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { speakerId: { contains: search } },
        { description: { contains: search } },
      ];
    }

    if (type) {
      where.type = type;
    }

    if (isActive !== null && isActive !== '') {
      where.isActive = isActive === 'true';
    }

    const [voices, total] = await Promise.all([
      prisma.voice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              favorites: true,
              ttsJobs: true,
            },
          },
        },
      }),
      prisma.voice.count({ where }),
    ]);

    return successResponse({
      voices: voices.map((v) => ({
        ...v,
        tags: JSON.parse(v.tags),
        favoriteCount: v._count.favorites,
        jobCount: v._count.ttsJobs,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '查询音色列表失败',
      'ADMIN_VOICES_ERROR',
      500
    );
  }
}
