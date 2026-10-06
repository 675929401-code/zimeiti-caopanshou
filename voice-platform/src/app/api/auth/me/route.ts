import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

export async function GET(request: NextRequest) {
  try {
    const authUser = await getUserFromRequest(request);

    if (!authUser) {
      return errorResponse('未登录或 token 已过期', 'UNAUTHORIZED', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
    }

    return successResponse(user, '获取用户信息成功');
  } catch (error: any) {
    return errorResponse(error.message || '获取用户信息失败', 'AUTH_ERROR', 500);
  }
}
