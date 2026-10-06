import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';
import { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const skip = (page - 1) * limit;
    const status = searchParams.get('status') || '';
    const search = searchParams.get('search') || '';

    // 构建查询条件
    const where: Prisma.TTSJobWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      where.text = { contains: search };
    }

    const [jobs, total] = await Promise.all([
      prisma.tTSJob.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          voice: {
            select: {
              id: true,
              name: true,
              speakerId: true,
            },
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.tTSJob.count({ where }),
    ]);

    return successResponse({
      jobs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '查询任务列表失败',
      'JOBS_ERROR',
      500
    );
  }
}
