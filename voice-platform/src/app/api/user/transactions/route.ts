import { NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { getTransactions } from '@/lib/billing';
import { successResponse, errorResponse } from '@/lib/response';

// GET - 查询当前用户的交易记录
export async function GET(request: NextRequest) {
  try {
    const authUser = await getUserFromRequest(request);
    if (!authUser) {
      return errorResponse('请先登录', 'UNAUTHORIZED', 401);
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));

    const result = await getTransactions(authUser.userId, page, limit);

    return successResponse({
      transactions: result.transactions,
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    }, '查询成功');
  } catch (error: any) {
    return errorResponse(error.message || '查询交易记录失败', 'TRANSACTIONS_ERROR', 500);
  }
}
