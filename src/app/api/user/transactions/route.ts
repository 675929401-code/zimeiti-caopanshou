import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromHeaders, verifyToken } from '@/lib/auth';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

// GET /api/user/transactions?type=all|credits|cash&page=1&pageSize=20&dateFrom=xxx&dateTo=xxx&transactionType=all|recharge|consume
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 });
    }

    const userId = payload.userId;
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'all'; // all | credits | cash
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = Math.min(parseInt(searchParams.get('pageSize') || '20'), 50);
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const transactionType = searchParams.get('transactionType') || 'all'; // all | recharge | consume

    const client = getSupabaseAdminClient();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const buildDateFilter = (query: any) => {
      if (dateFrom) query = query.gte('created_at', dateFrom);
      if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59');
      return query;
    };

    // === 积分交易记录 ===
    let creditTransactions: any[] = [];
    let creditTotal = 0;

    if (type === 'all' || type === 'credits') {
      let creditQuery = client
        .from('credit_transactions')
        .select('id, type, transaction_type, amount, balance_after, description, metadata, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (transactionType === 'recharge') {
        creditQuery = creditQuery.in('type', ['recharge', 'admin_adjust']);
      } else if (transactionType === 'consume') {
        creditQuery = creditQuery.in('type', ['consume', 'consumption']);
      }

      creditQuery = buildDateFilter(creditQuery);

      const { data: cData, error: cError, count: cTotal } = await creditQuery.range(from, to);

      if (cError) {
        console.error('查询积分记录失败:', cError);
      } else {
        creditTransactions = (cData || []).map((t: any) => ({
          id: t.id,
          category: 'credits' as const,
          type: t.type,
          transactionType: t.transaction_type,
          amount: Number(t.amount),
          balanceAfter: t.balance_after ? Number(t.balance_after) : null,
          description: t.description || '',
          metadata: t.metadata,
          createdAt: t.created_at,
        }));
        creditTotal = cTotal || 0;
      }
    }

    // === 现金交易记录（排除视频扣费，视频扣费由 video_tasks 单独展示，避免重复） ===
    let cashTransactions: any[] = [];
    let cashTotal = 0;

    if (type === 'all' || type === 'cash') {
      let cashQuery = client
        .from('cash_transactions')
        .select('id, type, amount, balance_after, description, reference_id, metadata, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // 排除视频扣费记录（reference_id 以 "video:" 开头），由 video_tasks 单独展示更完整的信息
      cashQuery = cashQuery.not('reference_id', 'like', 'video:%');

      if (transactionType === 'recharge') {
        cashQuery = cashQuery.eq('type', 'topup');
      } else if (transactionType === 'consume') {
        cashQuery = cashQuery.eq('type', 'consume');
      }

      cashQuery = buildDateFilter(cashQuery);

      const { data: chData, error: chError, count: chTotal } = await cashQuery.range(from, to);

      if (chError) {
        console.error('查询现金记录失败:', chError);
      } else {
        cashTransactions = (chData || []).map((t: any) => ({
          id: t.id,
          category: 'cash' as const,
          type: t.type,
          transactionType: t.type === 'topup' ? 'recharge' : 'consumption',
          amount: Number(t.amount),
          balanceAfter: t.balance_after ? Number(t.balance_after) : null,
          description: t.description || '',
          referenceId: t.reference_id || null,
          metadata: t.metadata || null,
          createdAt: t.created_at,
        }));
        cashTotal = chTotal || 0;
      }
    }

    // === 视频任务记录 ===
    let videoTasks: any[] = [];
    let videoTotal = 0;

    if (type === 'all' || type === 'cash') {
      let videoQuery = client
        .from('video_tasks')
        .select('id, model_id, status, price_charged, created_at, completed_at, aspect_ratio, duration_seconds, prompt, error_message', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (transactionType === 'consume') {
        videoQuery = videoQuery.eq('status', 'completed');
      } else if (transactionType === 'recharge') {
        // 视频没有充值，跳过
        videoQuery = videoQuery.eq('id', 'never-match');
      }

      videoQuery = buildDateFilter(videoQuery);

      const { data: vData, error: vError, count: vTotal } = await videoQuery.range(from, to);

      if (!vError && vData) {
        // 批量查询关联的视频模型名称
        const modelIds = [...new Set(vData.map((v: any) => v.model_id).filter(Boolean))];
        const modelMap: Record<string, string> = {};
        if (modelIds.length > 0) {
          const { data: models } = await client
            .from('video_models')
            .select('id, name')
            .in('id', modelIds);
          (models || []).forEach((m: any) => { modelMap[m.id] = m.name; });
        }

        videoTasks = vData.map((v: any) => ({
          id: v.id,
          category: 'video' as const,
          type: v.status === 'completed' ? 'consume' : 'pending',
          transactionType: 'video_generation' as const,
          amount: Number(v.price_charged || 0),
          modelName: modelMap[v.model_id] || null,
          modelId: v.model_id,
          status: v.status,
          aspectRatio: v.aspect_ratio,
          durationSeconds: v.duration_seconds,
          prompt: v.prompt ? (v.prompt as string).substring(0, 100) : null,
          errorMessage: v.error_message,
          createdAt: v.created_at,
          completedAt: v.completed_at,
        }));
        videoTotal = vTotal || 0;
      }
    }

    // === 支付订单记录 ===
    let paymentOrders: any[] = [];
    let paymentTotal = 0;

    if (transactionType !== 'consume') {
      let paymentQuery = client
        .from('payment_orders')
        .select('id, type, amount, status, payment_method, credits_amount, trade_order_id, paid_at, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      paymentQuery = buildDateFilter(paymentQuery);

      const { data: pData, error: pError, count: pTotal } = await paymentQuery.range(from, to);

      if (pError) {
        throw new Error('PAYMENT_ORDER_HISTORY_READ_FAILED');
      }

      if (pData) {
        paymentOrders = pData.map((o: any) => ({
          id: o.id,
          category: 'payment' as const,
          type: o.type, // credits / cash
          transactionType: 'payment_order' as const,
          amount: Number(o.amount),
          status: o.status,
          paymentMethod: o.payment_method,
          creditsAmount: o.credits_amount,
          cashAmount: o.type === 'cash' ? Number(o.amount) : null,
          tradeOrderId: o.trade_order_id,
          paidAt: o.paid_at,
          createdAt: o.created_at,
        }));
        paymentTotal = pTotal || 0;
      }
    }

    // === 合并并按时间排序 ===
    const allTransactions = [
      ...creditTransactions,
      ...cashTransactions,
      ...videoTasks,
      ...paymentOrders,
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // === 总计统计 ===
    const { data: creditSummary } = await client
      .from('credit_transactions')
      .select('amount, type')
      .eq('user_id', userId);

    const { data: cashSummary } = await client
      .from('cash_transactions')
      .select('amount, type')
      .eq('user_id', userId);

    let totalCreditsRecharged = 0;
    let totalCreditsConsumed = 0;
    let totalCashRecharged = 0;
    let totalCashConsumed = 0;

    (creditSummary || []).forEach((t: any) => {
      const amt = Number(t.amount);
      if (t.type === 'recharge' || t.type === 'admin_adjust') {
        if (amt > 0) totalCreditsRecharged += amt;
        else totalCreditsConsumed += Math.abs(amt);
      } else {
        totalCreditsConsumed += Math.abs(amt);
      }
    });

    (cashSummary || []).forEach((t: any) => {
      const amt = Number(t.amount);
      if (t.type === 'topup') totalCashRecharged += amt;
      else totalCashConsumed += Math.abs(amt);
    });

    // 查询当前余额
    const { data: userData } = await client
      .from('users')
      .select('credits, cash_balance')
      .eq('id', userId)
      .single();

    return NextResponse.json({
      success: true,
      data: {
        transactions: allTransactions,
        summary: {
          totalCreditsRecharged,
          totalCreditsConsumed,
          creditBalance: userData ? Number(userData.credits) : 0,
          totalCashRecharged,
          totalCashConsumed,
          cashBalance: userData ? Number(userData.cash_balance || 0) : 0,
        },
        pagination: {
          page,
          pageSize,
          creditTotal,
          cashTotal,
          videoTotal,
          paymentTotal,
          total: creditTotal + cashTotal + videoTotal + paymentTotal,
        },
      },
    });
  } catch (err) {
    console.error('User transactions GET error:', err);
    return NextResponse.json({ error: '查询交易记录失败' }, { status: 500 });
  }
}
