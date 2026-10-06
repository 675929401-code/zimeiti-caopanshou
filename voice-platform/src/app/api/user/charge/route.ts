import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { chargeBalance } from '@/lib/billing';
import { successResponse, errorResponse } from '@/lib/response';

/**
 * 充值接口 - 供主站 zyuani8.com 调用
 * 
 * 认证方式: API Key (Header: X-Site-API-Key)
 * 主站需要在请求头中携带预共享的 API Key
 * 
 * 请求体:
 *   { "userId": "用户ID", "amount": 金额(元), "description": "可选描述" }
 * 
 * 返回:
 *   { "success": true, "data": { "balance": 充值后余额 } }
 */

const SITE_API_KEY = process.env.SITE_API_KEY?.trim() ?? '';

export async function POST(request: NextRequest) {
  try {
    // 认证：主站API Key
    const siteKey = request.headers.get('X-Site-API-Key');
    if (!siteKey || siteKey !== SITE_API_KEY) {
      return errorResponse('无效的API Key', 'UNAUTHORIZED', 401);
    }

    const body = await request.json();
    const { userId, amount, description } = body;

    // 参数校验
    if (!userId || typeof userId !== 'string') {
      return errorResponse('userId 参数不能为空', 'VALIDATION_ERROR', 400);
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return errorResponse('amount 必须为正数', 'VALIDATION_ERROR', 400);
    }

    // 检查用户是否存在
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      return errorResponse('用户不存在', 'USER_NOT_FOUND', 404);
    }

    // 执行充值
    const result = await chargeBalance(userId, amount, description || `主站充值 ${amount} 元`);

    if (!result.success) {
      return errorResponse(result.error || '充值失败', 'CHARGE_ERROR', 500);
    }

    return successResponse({
      userId,
      balance: result.balance,
      chargedAmount: amount,
    }, '充值成功');
  } catch (error: any) {
    return errorResponse(error.message || '充值失败', 'CHARGE_ERROR', 500);
  }
}
