import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// GET - 获取所有 API 配置
export async function GET(request: NextRequest) {
  try {
    const configs = await prisma.apiConfig.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return successResponse(configs, '查询成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '查询API配置失败',
      'CONFIGS_ERROR',
      500
    );
  }
}

// POST - 创建 API 配置
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, apiKey, resourceId, isActive, costPricePer1k, profitMargin } = body;

    // 参数校验
    if (!name || typeof name !== 'string') {
      return errorResponse('name 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    if (!apiKey || typeof apiKey !== 'string') {
      return errorResponse('apiKey 参数不能为空', 'VALIDATION_ERROR', 400);
    }

    // 如果设置为激活，先取消其他配置的激活状态
    if (isActive) {
      await prisma.apiConfig.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
    }

    const config = await prisma.apiConfig.create({
      data: {
        name,
        apiKey,
        resourceId: resourceId || 'seed-tts-2.0',
        isActive: isActive ?? true,
        costPricePer1k: costPricePer1k ?? 0.5,
        profitMargin: profitMargin ?? 100,
      },
    });

    return successResponse(config, '创建成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '创建API配置失败',
      'CONFIG_CREATE_ERROR',
      500
    );
  }
}
