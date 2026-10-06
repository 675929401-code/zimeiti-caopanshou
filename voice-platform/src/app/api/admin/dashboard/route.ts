import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

export async function GET(request: NextRequest) {
  try {
    // 获取当天起始时间
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // 并行查询所有统计数据
    const [
      totalUsers,
      totalVoices,
      todayTTSJobs,
      activeApiKeys,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.voice.count(),
      prisma.tTSJob.count({
        where: {
          createdAt: { gte: todayStart },
          status: 'completed',
        },
      }),
      prisma.apiConfig.count({
        where: { isActive: true },
      }),
    ]);

    return successResponse({
      totalUsers,
      totalVoices,
      todayJobs: todayTTSJobs,
      activeApiKeys,
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '获取仪表盘数据失败',
      'DASHBOARD_ERROR',
      500
    );
  }
}
