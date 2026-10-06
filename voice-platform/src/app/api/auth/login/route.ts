import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createToken, verifyPassword } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return errorResponse('邮箱和密码不能为空', 'VALIDATION_ERROR', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
    }

    const isValid = await verifyPassword(password, user.password);

    if (!isValid) {
      return errorResponse('密码错误', 'INVALID_PASSWORD', 401);
    }

    const token = createToken(user.id, user.role);

    return successResponse({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    }, '登录成功');
  } catch (error: any) {
    return errorResponse(error.message || '登录失败', 'LOGIN_ERROR', 500);
  }
}
