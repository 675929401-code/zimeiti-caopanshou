import { NextRequest, NextResponse } from 'next/server';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { normalizeDisplayText } from '@/lib/display-normalization';

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

// GET /api/admin/user-transactions?userId=xxx&type=all|credits|cash&page=1&pageSize=20&dateFrom=xxx&dateTo=xxx
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id') || searchParams.get('userId');
  const type = searchParams.get('type') || 'all'; // all | credits | cash | recharge
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('page_size') || searchParams.get('pageSize') || '20');
  const dateFrom = searchParams.get('start_date') || searchParams.get('dateFrom');
  const dateTo = searchParams.get('end_date') || searchParams.get('dateTo');
  const transactionType = searchParams.get('transactionType'); // recharge | consume | all
  const category = searchParams.get('category'); // credits | cash (for recharge filtering)

  const client = getSupabaseAdminClient();

  // ── 全局充值记录模式（无 userId 时） ──
  if (!userId) {
    try {
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const allTransactions: any[] = [];
      let totalCount = 0;

      // 积分充值
      if (!category || category === 'credits') {
        let q = client.from('credit_transactions').select('id, user_id, amount, type, transaction_type, description, balance_after, created_at, users(name, phone, email)', { count: 'exact' })
          .eq('type', 'recharge').order('created_at', { ascending: false });
        if (dateFrom) q = q.gte('created_at', dateFrom);
        if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59');
        const { data, count, error } = await q.range(from, to);
        if (!error && data) {
          data.forEach((t: any) => {
            allTransactions.push({
              id: t.id, userId: t.user_id, userName: t.users?.name || '', phone: t.users?.phone || '', email: t.users?.email || '',
              amount: Number(t.amount), balanceAfter: t.balance_after, transactionType: 'recharge',
              description: normalizeDisplayText(t.description, '积分充值'), category: 'credits', createdAt: t.created_at,
            });
          });
          totalCount += count || 0;
        }
      }

      // 现金充值
      if (!category || category === 'cash') {
        let q = client.from('cash_transactions').select('id, user_id, amount, type, description, balance_after, created_at, users(name, phone, email)', { count: 'exact' })
          .eq('type', 'topup').order('created_at', { ascending: false });
        if (dateFrom) q = q.gte('created_at', dateFrom);
        if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59');
        const { data, count, error } = await q.range(from, to);
        if (!error && data) {
          data.forEach((t: any) => {
            allTransactions.push({
              id: t.id, userId: t.user_id, userName: t.users?.name || '', phone: t.users?.phone || '', email: t.users?.email || '',
              amount: Number(t.amount), balanceAfter: Number(t.balance_after), transactionType: 'recharge',
              description: normalizeDisplayText(t.description, '现金充值'), category: 'cash', createdAt: t.created_at,
            });
          });
          totalCount += count || 0;
        }
      }

      // Sort by time descending
      allTransactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return NextResponse.json({
        transactions: allTransactions,
        totalCount,
        page,
        pageSize,
      });
    } catch (err) {
      console.error('查询全局充值记录失败:', err);
      return NextResponse.json({ error: '查询失败' }, { status: 500 });
    }
  }
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Build date filter
  const buildDateFilter = (query: any) => {
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59');
    return query;
  };

  try {
    // === 积分交易记录 ===
    let creditTransactions: any[] = [];
    let creditTotal = 0;

    if (type === 'all' || type === 'credits') {
      let creditQuery = client
        .from('credit_transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Filter by transaction type
      if (transactionType === 'recharge') {
        creditQuery = creditQuery.in('type', ['recharge']);
      } else if (transactionType === 'consume') {
        creditQuery = creditQuery.in('type', ['consume', 'consumption']);
      }

      creditQuery = buildDateFilter(creditQuery);

      // Get total count first
      const { count: cTotal } = await client
        .from('credit_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Get paginated data
      const { data: cData, error: cError } = await creditQuery.range(from, to);

      if (cError) {
        console.error('查询积分记录失败:', cError);
      } else {
        creditTransactions = (cData || []).map((t: any) => ({
          id: t.id,
          category: 'credits' as const,
          type: t.type, // recharge / consume / consumption / admin_adjust
          transactionType: t.transaction_type, // recharge / consumption / admin_adjust
          amount: Number(t.amount),
          balanceAfter: t.balance_after,
          description: normalizeDisplayText(t.description, t.type === 'recharge' ? '积分充值' : '积分消耗'),
          metadata: t.metadata,
          createdAt: t.created_at,
        }));
        creditTotal = cTotal || 0;
      }
    }

    // === 现金交易记录 ===
    let cashTransactions: any[] = [];
    let cashTotal = 0;

    if (type === 'all' || type === 'cash') {
      let cashQuery = client
        .from('cash_transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Filter by transaction type
      if (transactionType === 'recharge') {
        cashQuery = cashQuery.eq('type', 'topup');
      } else if (transactionType === 'consume') {
        cashQuery = cashQuery.eq('type', 'consume');
      }

      cashQuery = buildDateFilter(cashQuery);

      // Get total count first
      const { count: chTotal } = await client
        .from('cash_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      const { data: chData, error: chError } = await cashQuery.range(from, to);

      if (chError) {
        console.error('查询现金记录失败:', chError);
      } else {
        cashTransactions = (chData || []).map((t: any) => ({
          id: t.id,
          category: 'cash' as const,
          type: t.type, // topup / consume
          transactionType: t.type === 'topup' ? 'recharge' : 'consumption',
          amount: Number(t.amount),
          balanceAfter: Number(t.balance_after),
          description: normalizeDisplayText(t.description, t.type === 'topup' ? '现金充值' : '现金消耗'),
          referenceId: t.reference_id || null,
          createdAt: t.created_at,
        }));
        cashTotal = chTotal || 0;
      }
    }

    // === 支付订单记录（在线充值） ===
    let paymentOrders: any[] = [];
    if (type === 'all' || type === 'credits' || type === 'cash') {
      let paymentQuery = client
        .from('payment_orders')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (dateFrom) paymentQuery = paymentQuery.gte('created_at', dateFrom);
      if (dateTo) paymentQuery = paymentQuery.lte('created_at', dateTo + 'T23:59:59');

      const { data: pData, error: pError } = await paymentQuery.limit(50);
      if (!pError && pData) {
        paymentOrders = pData.map((o: any) => ({
          id: o.id,
          category: 'payment' as const,
          type: o.type, // credits / cash
          transactionType: 'payment_order',
          amount: Number(o.amount),
          status: o.status, // pending / paid / expired
          paymentMethod: o.payment_method,
          paymentProvider: o.payment_provider,
          creditsAmount: o.credits_amount,
          tradeOrderId: o.trade_order_id,
          paidAt: o.paid_at,
          createdAt: o.created_at,
        }));
      }
    }

    // === 视频任务记录 ===
    let videoTasks: any[] = [];
    if (type === 'all' || type === 'cash') {
      let videoQuery = client
        .from('video_tasks')
        .select('id, model_id, status, price_charged, created_at, completed_at, aspect_ratio, duration_seconds')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (dateFrom) videoQuery = videoQuery.gte('created_at', dateFrom);
      if (dateTo) videoQuery = videoQuery.lte('created_at', dateTo + 'T23:59:59');

      const { data: vData, error: vError } = await videoQuery.limit(100);
      if (!vError && vData) {
        videoTasks = vData.map((v: any) => ({
          id: v.id,
          category: 'video' as const,
          modelId: v.model_id,
          status: v.status,
          priceCharged: Number(v.price_charged || 0),
          aspectRatio: v.aspect_ratio,
          durationSeconds: v.duration_seconds,
          createdAt: v.created_at,
          completedAt: v.completed_at,
        }));
      }
    }

    // === 每日消耗统计 ===
    // 积分每日消耗
    const { data: creditDailyData } = await client
      .from('credit_transactions')
      .select('amount, created_at, type')
      .eq('user_id', userId)
      .in('type', ['consume', 'consumption']);

    // 现金每日消耗
    const { data: cashDailyData } = await client
      .from('cash_transactions')
      .select('amount, created_at, type')
      .eq('user_id', userId)
      .eq('type', 'consume');

    // Aggregate daily stats
    const dailyStatsMap: Record<string, { date: string; creditsConsumed: number; creditsRecharged: number; cashConsumed: number; cashRecharged: number; videoCount: number }> = {};

    // Process credit daily consumption
    (creditDailyData || []).forEach((t: any) => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!dailyStatsMap[date]) dailyStatsMap[date] = { date, creditsConsumed: 0, creditsRecharged: 0, cashConsumed: 0, cashRecharged: 0, videoCount: 0 };
      dailyStatsMap[date].creditsConsumed += Math.abs(Number(t.amount));
    });

    // Process credit daily recharge
    const { data: creditRechargeData } = await client
      .from('credit_transactions')
      .select('amount, created_at, type')
      .eq('user_id', userId)
      .eq('type', 'recharge');

    (creditRechargeData || []).forEach((t: any) => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!dailyStatsMap[date]) dailyStatsMap[date] = { date, creditsConsumed: 0, creditsRecharged: 0, cashConsumed: 0, cashRecharged: 0, videoCount: 0 };
      dailyStatsMap[date].creditsRecharged += Number(t.amount);
    });

    // Process cash daily consumption
    (cashDailyData || []).forEach((t: any) => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!dailyStatsMap[date]) dailyStatsMap[date] = { date, creditsConsumed: 0, creditsRecharged: 0, cashConsumed: 0, cashRecharged: 0, videoCount: 0 };
      dailyStatsMap[date].cashConsumed += Math.abs(Number(t.amount));
    });

    // Process cash daily recharge
    const { data: cashRechargeData } = await client
      .from('cash_transactions')
      .select('amount, created_at, type')
      .eq('user_id', userId)
      .eq('type', 'topup');

    (cashRechargeData || []).forEach((t: any) => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!dailyStatsMap[date]) dailyStatsMap[date] = { date, creditsConsumed: 0, creditsRecharged: 0, cashConsumed: 0, cashRecharged: 0, videoCount: 0 };
      dailyStatsMap[date].cashRecharged += Number(t.amount);
    });

    // Process video daily count
    videoTasks.forEach((v) => {
      const date = new Date(v.createdAt).toISOString().split('T')[0];
      if (!dailyStatsMap[date]) dailyStatsMap[date] = { date, creditsConsumed: 0, creditsRecharged: 0, cashConsumed: 0, cashRecharged: 0, videoCount: 0 };
      if (v.status === 'completed') dailyStatsMap[date].videoCount++;
    });

    const dailyStats = Object.values(dailyStatsMap).sort((a, b) => b.date.localeCompare(a.date));

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

    const completedVideoCount = videoTasks.filter(v => v.status === 'completed').length;

    // === 收益记录（全类型消费明细：视频/封面/对话/提取/深度思考） ===
    let revenueRecords: any[] = [];
    if (type === 'all' || type === 'cash') {
      let revenueQuery = client
        .from('revenue_records')
        .select('id, model_id, cost_price, selling_price, profit, record_type, task_id, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (dateFrom) revenueQuery = revenueQuery.gte('created_at', dateFrom);
      if (dateTo) revenueQuery = revenueQuery.lte('created_at', dateTo + 'T23:59:59');
      if (transactionType === 'consume') {
        // revenue_records are all consumption records
      } else if (transactionType === 'recharge') {
        // revenue_records have no recharge type, skip
        revenueQuery = revenueQuery.eq('id', '__none__');
      }

      const { data: rData, error: rError } = await revenueQuery.limit(200);
      if (!rError && rData) {
        revenueRecords = rData.map((r: any) => ({
          id: r.id,
          category: 'revenue' as const,
          modelId: r.model_id,
          costPrice: Number(r.cost_price) || 0,
          sellingPrice: Number(r.selling_price) || 0,
          profit: Number(r.profit) || 0,
          recordType: r.record_type, // video | chat | image | deep_thinking | extract
          taskId: r.task_id,
          createdAt: r.created_at,
        }));
      }
    }

    // Merge and sort all transactions for unified view
    const allTransactions = [...creditTransactions, ...cashTransactions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // 收益记录按类型汇总
    const revenueSummary = {
      video: { count: 0, totalSelling: 0, totalCost: 0 },
      chat: { count: 0, totalSelling: 0, totalCost: 0 },
      image: { count: 0, totalSelling: 0, totalCost: 0 },
      extract: { count: 0, totalSelling: 0, totalCost: 0 },
      deep_thinking: { count: 0, totalSelling: 0, totalCost: 0 },
    };
    for (const r of revenueRecords) {
      const rt = r.recordType as string;
      if (revenueSummary[rt as keyof typeof revenueSummary]) {
        const s = revenueSummary[rt as keyof typeof revenueSummary];
        s.count++;
        s.totalSelling += r.sellingPrice;
        s.totalCost += r.costPrice;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        transactions: allTransactions,
        paymentOrders,
        videoTasks,
        revenueRecords,
        revenueSummary,
        dailyStats,
        summary: {
          totalCreditsRecharged,
          totalCreditsConsumed,
          totalCashRecharged,
          totalCashConsumed,
          totalVideoCount: completedVideoCount,
          creditBalance: null, // Will be filled from users table
          cashBalance: null,
        },
        pagination: {
          page,
          pageSize,
          creditTotal,
          cashTotal,
        },
      },
    });
  } catch (err) {
    console.error('查询学员交易记录失败:', err);
    return NextResponse.json({ error: '查询失败' }, { status: 500 });
  }
}
