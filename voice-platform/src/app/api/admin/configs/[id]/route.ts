import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PUT - 更新 API 配置
export async function PUT(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { name, apiKey, resourceId, isActive, costPricePer1k, profitMargin } = body;

    // 检查配置是否存在
    const existing = await prisma.apiConfig.findUnique({ where: { id } });
    if (!existing) {
      return errorResponse('API配置不存在', 'CONFIG_NOT_FOUND', 404);
    }

    // 如果设置为激活，先取消其他配置的激活状态
    if (isActive) {
      await prisma.apiConfig.updateMany({
        where: { isActive: true, id: { not: id } },
        data: { isActive: false },
      });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (resourceId !== undefined) updateData.resourceId = resourceId;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (costPricePer1k !== undefined) updateData.costPricePer1k = costPricePer1k;
    if (profitMargin !== undefined) updateData.profitMargin = profitMargin;

    const config = await prisma.apiConfig.update({
      where: { id },
      data: updateData,
    });

    return successResponse(config, '更新成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '更新API配置失败',
      'CONFIG_UPDATE_ERROR',
      500
    );
  }
}

// DELETE - 删除 API 配置
export async function DELETE(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const { id } = await context.params;

    const existing = await prisma.apiConfig.findUnique({ where: { id } });
    if (!existing) {
      return errorResponse('API配置不存在', 'CONFIG_NOT_FOUND', 404);
    }

    await prisma.apiConfig.delete({ where: { id } });

    return successResponse(null, '删除成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '删除API配置失败',
      'CONFIG_DELETE_ERROR',
      500
    );
  }
}
