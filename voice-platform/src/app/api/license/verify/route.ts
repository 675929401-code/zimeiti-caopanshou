import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// POST - 验证密钥（检查是否有效 + 返回剩余次数）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { licenseKey } = body;

    if (!licenseKey) return errorResponse('请输入授权密钥', 'MISSING_KEY', 400);

    const lic = await prisma.cloneLicense.findUnique({
      where: { licenseKey: licenseKey.trim() },
    });

    if (!lic) {
      return errorResponse('密钥无效，请检查是否输入正确或联系管理员', 'INVALID_KEY', 404);
    }

    if (lic.status === 'exhausted') {
      return errorResponse('该密钥训练次数已用完（' + lic.usedTrainings + '/' + lic.maxTrainings + '次），请联系管理员续费', 'KEY_EXHAUSTED', 409);
    }

    if (lic.status === 'expired') {
      return errorResponse('该密钥已过期', 'KEY_EXPIRED', 409);
    }

    const remaining = lic.maxTrainings - lic.usedTrainings;

    return successResponse({
      licenseKey: lic.licenseKey,
      status: lic.status,
      usedTrainings: lic.usedTrainings,
      maxTrainings: lic.maxTrainings,
      remaining,
      message: `密钥验证通过，剩余 ${remaining}/${lic.maxTrainings} 次训练`,
    });
  } catch (err: any) {
    return errorResponse(err.message || '验证失败', 'VERIFY_ERROR', 500);
  }
}
