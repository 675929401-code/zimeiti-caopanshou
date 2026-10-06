import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successResponse, errorResponse } from '@/lib/response';

// POST - 消耗一次训练次数（每次训练成功后调用）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { licenseKey } = body;

    if (!licenseKey) return errorResponse('缺少授权密钥', 'MISSING_KEY', 400);

    const lic = await prisma.cloneLicense.findUnique({
      where: { licenseKey: licenseKey.trim() },
    });

    if (!lic) {
      return errorResponse('密钥无效', 'INVALID_KEY', 404);
    }

    if (lic.usedTrainings >= lic.maxTrainings) {
      return errorResponse('训练次数已用完（' + lic.usedTrainings + '/' + lic.maxTrainings + '次），请联系管理员续费', 'KEY_EXHAUSTED', 409);
    }

    const newUsed = lic.usedTrainings + 1;
    const isExhausted = newUsed >= lic.maxTrainings;

    await prisma.cloneLicense.update({
      where: { id: lic.id },
      data: {
        usedTrainings: newUsed,
        status: isExhausted ? 'exhausted' : lic.status,
        usedAt: isExhausted ? new Date() : lic.usedAt,
      },
    });

    return successResponse({
      usedTrainings: newUsed,
      maxTrainings: lic.maxTrainings,
      remaining: lic.maxTrainings - newUsed,
      isExhausted,
      message: isExhausted
        ? '本次训练已完成，密钥剩余次数已用完'
        : `训练消耗成功，剩余 ${lic.maxTrainings - newUsed} 次`,
    });
  } catch (err: any) {
    return errorResponse(err.message || '消耗训练次数失败', 'CONSUME_ERROR', 500);
  }
}
