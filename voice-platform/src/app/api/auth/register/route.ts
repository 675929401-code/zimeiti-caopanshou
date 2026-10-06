import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createToken, hashPassword } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, name } = body;

    if (!email || !password) {
      return errorResponse('邮箱和密码不能为空', 'VALIDATION_ERROR', 400);
    }

    // 邮箱格式校验
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse('邮箱格式不正确', 'VALIDATION_ERROR', 400);
    }

    // 密码长度校验
    if (password.length < 6) {
      return errorResponse('密码长度不能少于6位', 'VALIDATION_ERROR', 400);
    }

    // 检查邮箱是否已注册
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return errorResponse('该邮箱已被注册', 'EMAIL_EXISTS', 409);
    }

    const hashedPassword = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || email.split('@')[0],
        role: 'user',
      },
    });

    const token = createToken(user.id, user.role);

    return successResponse({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    }, '注册成功');
  } catch (error: any) {
    return errorResponse(error.message || '注册失败', 'REGISTER_ERROR', 500);
  }
}
