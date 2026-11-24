import { classifyWalletEntry, readWalletTotals } from "@/lib/member-wallet-history";
import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromHeaders, verifyToken } from '@/lib/auth';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { buildPublicTransactionBillingExplanation, toPublicTransactionMetadata } from '@/lib/public-billing-explanation';

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
    const page = Number(searchParams.get('page') || '1');
    const pageSize = Number(searchParams.get('pageSize') || '20');
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 || !Number.isSafeInteger(page * pageSize)) {
      return NextResponse.json({ error: '分页参数无效' }, {status: 400});
    }
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const transactionType = searchParams.get('transactionType') || 'all'; // all | recharge | consume

    if (!['all', 'cash', 'credits'].includes(type) || !['all', 'recharge', 'consume'].includes(transactionType)) {
      return NextResponse.json({ error: '交易筛选条件无效' }, {status: 400});
    }
    const client = getSupabaseAdminClient();
    const from = (page - 1) * pageSize;
    const end = from + pageSize;
    const readPrefix = async (query: any) => {
      const data: any[] = [];
      let count = 0;
      while (data.length < end) {
        const start = data.length;
        const result = await query.range(start, Math.min(start + 499, end - 1));
        if (result.error || !Array.isArray(result.data) || !Number.isInteger(result.count)) throw new Error('WALLET_HISTORY_READ_FAILED');
        count = result.count;
        data.push(...result.data);
        if (data.length >= count || !result.data.length) break;
      }
      return { data, count };
    };

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
        .order('created_at', { ascending: false }).order('id', { ascending: false });

      if (transactionType === 'recharge') {
        creditQuery = creditQuery.in('type', ['recharge', 'topup']);
      } else if (transactionType === 'consume') {
        creditQuery = creditQuery.in('type', ['consume', 'consumption', 'deduction']);
      }

      creditQuery = buildDateFilter(creditQuery);

      const { data: cData, count: cTotal } = await readPrefix(creditQuery);
      {
        creditTransactions = (cData || []).map((t: any) => ({
          id: t.id,
          category: 'credits' as const,
          type: t.type,
          transactionType: t.transaction_type,
          amount: Number(t.amount),
          balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
          description: t.description || '',
          metadata: toPublicTransactionMetadata(t.metadata),
          ...(classifyWalletEntry(t.type) === 'spend' ? {
            billingExplanation: buildPublicTransactionBillingExplanation(t.metadata, 'credits'),
          } : {}),
          createdAt: t.created_at,
        }));
        creditTotal = cTotal || 0;
      }
    }

    // 现金流水展示实际钱包变动。
    let cashTransactions: any[] = [];
    let cashTotal = 0;

    if (type === 'all' || type === 'cash') {
      let cashQuery = client
        .from('cash_transactions')
        .select('id, type, amount, balance_after, description, reference_id, metadata, created_at', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false }).order('id', { ascending: false });

      if (transactionType === 'recharge') {
        cashQuery = cashQuery.in('type', ['topup','recharge']);
      } else if (transactionType === 'consume') {
        cashQuery = cashQuery.in('type', ['consume', 'consumption', 'deduction']);
      }

      cashQuery = buildDateFilter(cashQuery);

      const { data: chData, count: chTotal } = await readPrefix(cashQuery);
      {
        cashTransactions = (chData || []).map((t: any) => ({
          id: t.id,
          category: 'cash' as const,
          type: t.type,
          transactionType: classifyWalletEntry(t.type),
          amount: Number(t.amount),
          balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
          description: t.description || '',
          referenceId: t.reference_id || null,
          metadata: toPublicTransactionMetadata(t.metadata),
          ...(classifyWalletEntry(t.type) === 'spend' ? {
            billingExplanation: buildPublicTransactionBillingExplanation(t.metadata, 'cash'),
          } : {}),
          createdAt: t.created_at,
        }));
        cashTotal = chTotal || 0;
      }
    }

    // Video task documents describe delivery; expenses are counted only in the wallet.
    // === 视频任务记录 ===
    let videoTasks: any[] = [];
    let videoTotal = 0;

    if ((type === 'all' || type === 'cash') && transactionType === 'all') {
      let videoQuery = client
        .from('video_tasks')
        .select('id, model_id, status, price_charged, created_at, completed_at, aspect_ratio, duration_seconds, prompt, error_message', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false }).order('id', { ascending: false });


      videoQuery = buildDateFilter(videoQuery);

      const { data: vData, count: vTotal } = await readPrefix(videoQuery);

      if (vData) {
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
        .order('created_at', { ascending: false }).order('id', { ascending: false });

      paymentQuery = buildDateFilter(paymentQuery);

      if (type === 'credits' || type === 'cash') paymentQuery = paymentQuery.eq('type', type);
      const { data: pData, count: pTotal } = await readPrefix(paymentQuery);

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
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(from, end);

    // === 总计统计 ===
    const [creditTotals,cashTotals] = await Promise.all([
      readWalletTotals(client,userId,"credit_transactions"),
      readWalletTotals(client,userId,"cash_transactions"),
    ]);
    // 查询当前余额
    const { data: userData, error: balanceError } = await client
      .from('users')
      .select('credits, credits_reserved, cash_balance')
      .eq('id', userId)
      .single();

    if (balanceError || !userData) throw new Error("WALLET_BALANCE_UNAVAILABLE");
    return NextResponse.json({
      success: true,
      data: {
        transactions: allTransactions,
        summary: {
          totalCreditsRecharged: creditTotals.recharged,
          totalCreditsConsumed: creditTotals.consumed,
          creditBalance: Math.max(0, Number(userData.credits) - Number(userData.credits_reserved || 0)),
          totalCashRecharged: cashTotals.recharged,
          totalCashConsumed: cashTotals.consumed,
          cashBalance: Number(userData.cash_balance || 0),
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
