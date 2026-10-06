import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from '@/lib/admin-auth';
import { getAccountGovernanceInfo } from '@/lib/account-governance';
import { getAdminWalletRequestKey, mutateAdminWallet, parseAdminBalanceValue } from '@/lib/admin-wallet-mutation';
import { enqueueUserNotificationOnce, walletNotificationCopy } from '@/lib/user-notification-server';
import { getAuditRequestIp } from '@/lib/billing-audit';

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin' || !payload.userId) return null;
  return payload;
}

async function changeCredits(request: NextRequest, mode: 'topup' | 'set') {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  try {
    const body = await request.json();
    const { userId, description, idempotencyKey: bodyKey } = body;
    const notifyUser = body.notifyUser === true;
    const amount = parseAdminBalanceValue(mode === 'set' ? body.credits : body.amount, 6);
    const requestKey = getAdminWalletRequestKey(request.headers.get('idempotency-key'), bodyKey);
    if (typeof userId !== 'string' || !userId.trim() || amount === null || (mode === 'topup' && amount <= 0)
      || (description !== undefined && (typeof description !== 'string' || description.length > 1000))) {
      return NextResponse.json({ error: '用户ID或积分数值无效' }, { status: 400 });
    }
    if (!requestKey) return NextResponse.json({ error: '缺少有效的 Idempotency-Key，禁止重复点击造成重复调整' }, { status: 400 });
    const client = getSupabaseClient();
    const { data: targetUser, error: targetError } = await client
      .from('users')
      .select('username, display_name, phone, email, last_sign_in_at, allowed_categories')
      .eq('id', userId.trim())
      .maybeSingle();
    if (targetError || !targetUser) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    if (getAccountGovernanceInfo(targetUser).isFixture) {
      return NextResponse.json({ error: '测试/E2E/验收账号禁止调整积分，请使用隔离测试库' }, { status: 400 });
    }
    const operationKey = `${mode === 'set' ? 'admin-credit-adjust' : 'admin-credits'}:${admin.userId}:${requestKey}`;
    const result = await mutateAdminWallet({
      userId: userId.trim(), adminId: admin.userId, kind: mode === 'set' ? 'credit_set' : 'credit_topup',
      amount, operationKey, description: description?.trim() || (mode === 'set' ? '管理员调整积分' : '管理员充值积分'),
      requestIp: getAuditRequestIp(request), requestRoute: "/api/admin/credits",
    });
    if (!result.success) {
      const { status, ...failure } = result;
      return NextResponse.json({ ...failure, idempotencyKey: requestKey }, { status });
    }
    let notification: Awaited<ReturnType<typeof enqueueUserNotificationOnce>> | null = null;
    if (!result.noChange && notifyUser) {
      const copy = walletNotificationCopy({
        kind: mode === 'set' ? 'credit_set' : 'credit_topup',
        delta: result.delta,
        balanceAfter: result.balanceAfter,
        description: description?.trim() || (mode === 'set' ? '管理员调整积分' : '管理员充值积分'),
      });
      notification = await enqueueUserNotificationOnce({
        userId: userId.trim(),
        type: copy.type,
        title: copy.title,
        content: copy.content,
        dedupeKey: `wallet-notification:${operationKey}`,
        metadata: {
          source: 'admin_wallet',
          wallet_kind: mode === 'set' ? 'credit_set' : 'credit_topup',
          operation_id: result.operationId || null,
          adjustment_id: result.adjustmentId || null,
          balance_after: result.balanceAfter,
          delta: result.delta,
        },
      });
      if (!notification.ok) {
        return NextResponse.json({
          ...result,
          success: false,
          outcome: 'committed_notification_pending',
          code: notification.code,
          error: '积分已安全入账，但本次明确要求的通知尚未送达；请使用原操作核对重试，系统不会重复入账',
          canRetryWithSameKey: true,
          idempotencyKey: requestKey,
        }, { status: 503 });
      }
    }
    return NextResponse.json({
      ...result, credits: result.balanceAfter, idempotencyKey: requestKey,
      notificationDelivery: result.noChange ? 'not_required' : !notifyUser ? 'not_requested' : notification?.alreadyExisted ? 'existing' : 'created',
      notificationId: notification?.ok ? notification.notificationId : null,
      message: result.noChange ? '目标积分与当前积分一致，已保存本次操作结果' : mode === 'set' ? '积分调整已完成' : '积分充值已完成',
    });
  } catch {
    return NextResponse.json({ error: '积分请求处理失败，请保留原幂等键核对后重试' }, { status: 500 });
  }
}

// Both routes use durable request identities. A set operation never reads a balance
// here or falls back to recharge/direct UPDATE if its atomic RPC is unavailable.
export async function POST(request: NextRequest) { return changeCredits(request, 'topup'); }
export async function PUT(request: NextRequest) { return changeCredits(request, 'set'); }

// GET - Get credit transactions for a user
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: '用户ID不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from('credit_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: '获取积分记录失败' }, { status: 500 });
    }

    return NextResponse.json({ transactions: data });
  } catch (err) {
    console.error('Get transactions error:', err);
    return NextResponse.json({ error: '获取积分记录失败' }, { status: 500 });
  }
}
