import { NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { getPricingConfig, estimateCost } from '@/lib/billing';
import { successResponse, errorResponse } from '@/lib/response';

// GET - 查询当前用户余额和定价信息
export async function GET(request: NextRequest) {
  try {
    const authUser = await getUserFromRequest(request);
    if (!authUser) {
      return errorResponse('请先登录', 'UNAUTHORIZED', 401);
    }

    // 通过 auth 库已获取用户信息，但需要查余额
    const { prisma } = await import('@/lib/prisma');
    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { balance: true, storageConfigured: true },
    });

    if (!user) {
      return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
    }

    const pricing = await getPricingConfig();

    return successResponse({
      balance: user.balance,
      storageConfigured: user.storageConfigured,
      pricing: {
        costPricePer1k: pricing.costPricePer1k,
        profitMargin: pricing.profitMargin,
        // 每千字符实际收费价 = 成本价 × (1 + 利润率/100)
        pricePer1k: Math.round(pricing.costPricePer1k * (1 + pricing.profitMargin / 100) * 100) / 100,
      },
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(error.message || '查询余额失败', 'BALANCE_ERROR', 500);
  }
}
