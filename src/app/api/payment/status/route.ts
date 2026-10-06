// 🔒 核心底层代码 — 锁定保护
//
// 本文件是支付状态查询 API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { queryOrderStatus } from "@/lib/xunhupay";
import { fulfillPaymentOrder } from "@/lib/payment-fulfillment";
import { evaluatePaidOrderSettlement } from "@/lib/payment-settlement-status";

// GET /api/payment/status?order=xxx - 查询支付订单状态
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload?.userId) {
      return NextResponse.json({ error: "无效的登录状态" }, { status: 401 });
    }
    const userId = payload.userId as string;

    const tradeOrderId = request.nextUrl.searchParams.get('order');
    if (!tradeOrderId) {
      return NextResponse.json({ error: "缺少订单号" }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    const { data: order, error } = await supabase
      .from('payment_orders')
      .select('trade_order_id, type, amount, status, payment_method, payment_provider, created_at, paid_at, credits_amount, expire_at, user_id, provider_trade_order_id, provider_transaction_id, provider_paid_amount, provider_confirmed_at')
      .eq('trade_order_id', tradeOrderId)
      .eq('user_id', userId) // 只能查自己的订单
      .single();

    if (error || !order) {
      return NextResponse.json({ error: "订单不存在" }, { status: 404 });
    }

    // 💡 主动检测：如果订单仍为 pending，主动查询支付平台确认是否已支付
    // 场景：迅虎回调经常不到达服务器，需要通过主动查询兜底到账。
    // 策略：
    //   0~5秒：等待回调到达（用户可能还在扫码）
    //   5秒后：查询迅虎API，并且仅使用支付平台返回的实付金额执行原子到账。
    // 严禁通过“附近时间出现相同金额流水”反推订单已支付；这会把无关充值
    // 错配到当前订单，造成重复到账或错误标记 paid。
    //   同一订单5秒内不重复查询迅虎API（防止前端3秒轮询导致平台API被刷）
    let providerReconciliationAttempted = false;
    let providerReconciliationConclusive = false;
    const normalizedProvider = String(order.payment_provider ?? '').trim().toLowerCase();
    if (order.status === 'pending' && normalizedProvider === 'xunhupay') {
      const orderCreatedTime = new Date(order.created_at);
      const now = new Date();
      const elapsedSeconds = (now.getTime() - orderCreatedTime.getTime()) / 1000;

      if (elapsedSeconds > 5) {
        providerReconciliationAttempted = true;
        // 5秒节流：同一订单5秒内不重复查询外部API。
        const platformConfirmation = await queryPaymentPlatformThrottled(tradeOrderId);
        providerReconciliationConclusive = platformConfirmation.conclusive;
        if (platformConfirmation.paid) {
          const paidAmount = platformConfirmation.paidAmount;
          const providerTradeOrderId = platformConfirmation.providerTradeOrderId;
          const providerTransactionId = platformConfirmation.providerTransactionId;
          const parsedPaidAmount = Number(paidAmount);
          if (typeof paidAmount !== 'string' || !paidAmount.trim()
            || !Number.isFinite(parsedPaidAmount) || parsedPaidAmount <= 0
            || providerTradeOrderId !== tradeOrderId
            || typeof providerTransactionId !== 'string' || !providerTransactionId.trim()) {
            order.status = 'pending';
            console.error(`[支付状态] 迅虎订单 ${tradeOrderId} 缺少完整平台支付证据，拒绝到账`);
          } else {
            const fulfillment = await fulfillPaymentOrder({
              tradeOrderId,
              provider: 'xunhupay',
              providerTradeOrderId,
              providerTransactionId,
              paidAmount,
            });
            if (fulfillment.success) {
              order.status = 'paid';
              order.paid_at = new Date().toISOString();
              console.log(`[支付状态] 迅虎平台确认已支付，订单 ${tradeOrderId} 已原子到账`);
            } else {
              order.status = 'pending';
              console.error(`[支付状态] 订单 ${tradeOrderId} 到账失败: ${fulfillment.error}`);
            }
          }
        }
      }
    }

    // 只有当前订单自己的支付证据核对完成后，才允许把 pending 标记为
    // expired。这样可覆盖“临近过期已付款、回调稍晚”的迅虎订单；EPay
    // 没有主动查询协议，只依赖其签名回调，且回调仍可原子完成 expired 订单。
    const providerAllowsExpiry = normalizedProvider !== 'xunhupay'
      || (providerReconciliationAttempted && providerReconciliationConclusive);
    if (order.status === 'pending' && providerAllowsExpiry
      && order.expire_at && new Date(order.expire_at) < new Date()) {
      const { error: expireError } = await supabase
        .from('payment_orders')
        .update({ status: 'expired' })
        .eq('trade_order_id', tradeOrderId)
        .eq('user_id', userId)
        .eq('status', 'pending');
      if (expireError) {
        console.error(`[支付状态] 订单 ${tradeOrderId} 过期状态持久化失败`, {
          provider: normalizedProvider || 'unknown',
          providerReconciliationAttempted,
        });
      } else {
        order.status = 'expired';
      }
    }

    let settlementStatus: "credited" | "reconciliation_required" | "awaiting_payment" | "not_credited" = "not_credited";
    let balanceCredited = false;
    let publicStatus = String(order.status || "pending");
    if (order.status === "paid") {
      const idempotencyKey = `payment:${tradeOrderId}`;
      const expectedOperationKind = order.type === "credits" ? "credit_topup" : order.type === "cash" ? "cash_topup" : "";
      const { data: walletOperations, error: walletError } = await supabase
        .from("wallet_operations")
        .select("id,user_id,operation_kind,idempotency_key,status,amount,balance_before,balance_after")
        .eq("user_id", userId)
        .eq("idempotency_key", idempotencyKey)
        .eq("operation_kind", expectedOperationKind)
        .limit(2);
      if (walletError) {
        console.error("[支付状态] 钱包到账证据读取失败", { tradeOrderId });
        return NextResponse.json({
          error: "到账证据暂时无法核验，请勿重复支付",
          code: "PAYMENT_SETTLEMENT_EVIDENCE_UNAVAILABLE",
        }, { status: 503 });
      }

      const operationId = walletOperations?.length === 1 ? String(walletOperations[0].id || "") : "";
      let ledgerEntries: Array<Record<string, unknown>> = [];
      if (operationId) {
        const { data: ledgerRows, error: ledgerError } = await supabase
          .from("wallet_ledger_entries")
          .select("operation_id,user_id,operation_kind,idempotency_key,delta,balance_before,balance_after")
          .eq("operation_id", operationId)
          .eq("user_id", userId)
          .limit(2);
        if (ledgerError) {
          console.error("[支付状态] 钱包账本证据读取失败", { tradeOrderId });
          return NextResponse.json({
            error: "到账证据暂时无法核验，请勿重复支付",
            code: "PAYMENT_SETTLEMENT_EVIDENCE_UNAVAILABLE",
          }, { status: 503 });
        }
        ledgerEntries = (ledgerRows || []) as Array<Record<string, unknown>>;
      }

      const settlement = evaluatePaidOrderSettlement({
        order: order as Record<string, unknown>,
        walletOperations: (walletOperations || []) as Array<Record<string, unknown>>,
        ledgerEntries,
      });
      settlementStatus = settlement.status;
      balanceCredited = settlement.balanceCredited;
      if (!balanceCredited) {
        publicStatus = "reconciliation_required";
        console.warn("[支付状态] 历史 paid 标记缺少完整到账证据，已阻止用户侧成功展示", {
          tradeOrderId,
          issueCodes: settlement.issueCodes,
        });
      }
    } else if (order.status === "pending") {
      settlementStatus = "awaiting_payment";
    }

    return NextResponse.json({ 
      success: true, 
      order: {
        trade_order_id: order.trade_order_id,
        type: order.type,
        amount: Number(order.amount),
        status: publicStatus,
        recorded_status: order.status,
        payment_method: order.payment_method,
        payment_provider: order.payment_provider,
        created_at: order.created_at,
        paid_at: order.paid_at,
        credits_amount: order.credits_amount ? Number(order.credits_amount) : null,
        expire_at: order.expire_at,
        settlement_status: settlementStatus,
        balance_credited: balanceCredited,
        settlement_message: settlementStatus === "reconciliation_required"
          ? "支付记录已收到，但余额到账证据不完整，正在人工核对；请勿重复支付"
          : settlementStatus === "credited"
            ? "支付与余额到账证据均已确认"
            : null,
      }
    });
  } catch (error) {
    console.error('查询订单状态失败:', error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

/**
 * 节流查询支付平台（同一订单5秒内不重复查询）
 * 防止前端3秒轮询导致迅虎API被频繁调用
 */
type PlatformPaymentConfirmation = {
  paid: boolean;
  conclusive: boolean;
  paidAmount?: string;
  providerTradeOrderId?: string;
  providerTransactionId?: string;
};

const platformQueryCache = new Map<string, { result: PlatformPaymentConfirmation; timestamp: number }>();
const PLATFORM_QUERY_THROTTLE_MS = 5000;

async function queryPaymentPlatformThrottled(
  tradeOrderId: string,
): Promise<PlatformPaymentConfirmation> {
  const now = Date.now();
  const cached = platformQueryCache.get(tradeOrderId);
  if (cached && (now - cached.timestamp) < PLATFORM_QUERY_THROTTLE_MS) {
    return cached.result;
  }

  const result = await queryPaymentPlatform(tradeOrderId);
  platformQueryCache.set(tradeOrderId, { result, timestamp: now });

  // 清理过期缓存（保留最近2分钟的条目）
  if (platformQueryCache.size > 200) {
    const cutoff = now - 120_000;
    for (const [key, val] of platformQueryCache) {
      if (val.timestamp < cutoff) platformQueryCache.delete(key);
    }
  }

  return result;
}

/**
 * 主动查询支付平台确认订单支付状态
 * 
 * 2026-06-24 修复：迅虎支付实际上有订单查询API（https://api.xunhupay.com/payment/query.html），
 * 之前误认为没有，导致回调不到时完全无法主动确认支付状态。
 * 现在改为调用迅虎查询API，作为回调不到达时的兜底机制。
 */
async function queryPaymentPlatform(
  tradeOrderId: string,
): Promise<PlatformPaymentConfirmation> {
  try {
    const result = await queryOrderStatus(tradeOrderId);
    
    if (!result) {
      console.log(`[支付状态] 迅虎查询返回null，订单 ${tradeOrderId}`);
      return { paid: false, conclusive: false };
    }

    if (result.status === 'OD') {
      if (result.tradeOrderId !== tradeOrderId || !result.transactionId || !result.totalAmount) {
        console.error(`[支付状态] 迅虎查询订单 ${tradeOrderId} 返回不完整或不匹配的支付证据`);
        return { paid: false, conclusive: false };
      }
      console.log(`[支付状态] 迅虎确认订单 ${tradeOrderId} 已支付，金额: ${result.totalAmount}，支付时间: ${result.paidDate}`);
      return {
        paid: true,
        conclusive: true,
        paidAmount: result.totalAmount,
        providerTradeOrderId: result.tradeOrderId,
        providerTransactionId: result.transactionId,
      };
    }

    if (result.status === 'NOT_FOUND') {
      console.log(`[支付状态] 迅虎查询订单 ${tradeOrderId} 不存在（可能已过期清理）`);
      return { paid: false, conclusive: true };
    }

    // WP=待支付，CD=已退款
    console.log(`[支付状态] 迅虎查询订单 ${tradeOrderId} 状态: ${result.status}`);
    return { paid: false, conclusive: true };
  } catch (err) {
    console.warn('[支付状态] 查询迅虎平台异常:', err);
    return { paid: false, conclusive: false };
  }
}
