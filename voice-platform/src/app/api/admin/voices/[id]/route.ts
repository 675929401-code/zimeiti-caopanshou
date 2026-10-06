import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PUT - 更新音色信息或上下架
export async function PUT(
  request: NextRequest,
  context: RouteParams
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { name, description, category, tags, language, gender, avatar, isActive, isRecommended } = body;

    // 检查音色是否存在
    const existing = await prisma.voice.findUnique({ where: { id } });
    if (!existing) {
      return errorResponse('音色不存在', 'VOICE_NOT_FOUND', 404);
    }

    // 构建更新数据
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (tags !== undefined) {
      updateData.tags = Array.isArray(tags) ? JSON.stringify(tags) : tags;
    }
    if (language !== undefined) updateData.language = language;
    if (gender !== undefined) updateData.gender = gender;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (isRecommended !== undefined) updateData.isRecommended = isRecommended;

    const voice = await prisma.voice.update({
      where: { id },
      data: updateData,
    });

    return successResponse({
      ...voice,
      tags: JSON.parse(voice.tags),
    }, '更新成功');
  } catch (error: any) {
    return errorResponse(
      error.message || '更新音色失败',
      'VOICE_UPDATE_ERROR',
      500
    );
  }
}
