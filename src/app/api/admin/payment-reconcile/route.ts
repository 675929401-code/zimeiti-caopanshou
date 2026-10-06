import { NextRequest, NextResponse } from "next/server";
import { queryOrderStatus } from "@/lib/xunhupay";
import { fulfillPaymentOrder } from "@/lib/payment-fulfillment";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 7;
const DISCOVERY_LIMIT_PER_PROVIDER = 200;
const MANUAL_RECONCILIATION_LIMIT = 50;
const ORDER_COLUMNS = "trade_order_id,payment_provider,payment_method,amount,status,created_at,expire_at";

type PendingPaymentOrder = {
  trade_order_id: string;
  payment_provider: string | null;
  payment_method: string | null;
  amount: number | string;
  status: string;
  created_at: string;
  expire_at: string | null;
};

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function paymentReference(orderId: string): string {
  return orderId.length <= 16 ? orderId : `${orderId.slice(0, 8)}…${orderId.slice(-6)}`;
}

async function readCandidates(provider: "xunhupay" | "epay", limit: number) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const result = await getSupabaseAdminClient()
    .from("payment_orders")
    .select(ORDER_COLUMNS, { count: "exact" })
    .in("status", ["pending", "expired"])
    .eq("payment_provider", provider)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (result.error) throw result.error;
  return {
    rows: (result.data || []) as PendingPaymentOrder[],
    count: result.count || 0,
    truncated: (result.count || 0) > (result.data || []).length,
  };
}

/**
 * Read-only discovery for schedulers and administrators.
 *
 * This path performs no provider call and no database mutation. It deliberately
 * reports EPay as callback-only because this repository has no verified active
 * query protocol for an arbitrary EPay gateway.
 */
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "payment_reconciliation_discovery",
  });
  if (!authorization.ok) return noStore(authorization.response);

  try {
    const [xunhu, epay] = await Promise.all([
      readCandidates("xunhupay", DISCOVERY_LIMIT_PER_PROVIDER),
      readCandidates("epay", DISCOVERY_LIMIT_PER_PROVIDER),
    ]);
    return noStore(NextResponse.json({
      success: true,
      mode: "read_only_discovery",
      generatedAt: new Date().toISOString(),
      lookbackDays: LOOKBACK_DAYS,
      writePerformed: false,
      providerCalls: 0,
      xunhupay: {
        recoveryMode: "manual_step_up_query",
        automaticScheduledRecovery: false,
        candidateCount: xunhu.count,
        listedCount: xunhu.rows.length,
        truncated: xunhu.truncated,
        candidates: xunhu.rows.map((order) => ({
          tradeOrderId: order.trade_order_id,
          orderRef: paymentReference(order.trade_order_id),
          status: order.status,
          amount: Number(order.amount),
          createdAt: order.created_at,
          expireAt: order.expire_at,
        })),
      },
      epay: {
        recoveryMode: "callback_only",
        automaticRecoverySupported: false,
        candidateCount: epay.count,
        listedCount: epay.rows.length,
        truncated: epay.truncated,
        actionRequired: epay.count > 0
          ? "本站没有已核验的 EPay 主动查询协议；请核查签名回调日志和渠道后台，不能自动补账。"
          : null,
        candidates: epay.rows.map((order) => ({
          tradeOrderId: order.trade_order_id,
          orderRef: paymentReference(order.trade_order_id),
          status: order.status,
          amount: Number(order.amount),
          createdAt: order.created_at,
          expireAt: order.expire_at,
        })),
      },
    }));
  } catch (error) {
    console.error("[payment-reconcile] discovery failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return noStore(NextResponse.json(
      { error: "支付待办发现失败", code: "PAYMENT_RECONCILIATION_DISCOVERY_FAILED" },
      { status: 503 },
    ));
  }
}

/**
 * Manual Xunhu recovery. This mutation is never used by the scheduler: it
 * requires wallet.adjust, a current step-up session, a durable audit intent,
 * and exact signed provider evidence before the existing atomic fulfillment.
 */
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "wallet.adjust", {
    requireStepUp: true,
    operation: "payment_reconciliation_manual_execute",
    auditAllowed: true,
  });
  if (!authorization.ok) return noStore(authorization.response);

  const requestKey = (request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "").slice(0, 200);
  const audit = (result: "allowed" | "success" | "failure", reasonCode: string, metadata: Record<string, unknown> = {}) => (
    appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "wallet.adjust",
      action: result === "allowed" ? "payment_reconciliation_intent" : "payment_reconciliation_result",
      result,
      reasonCode,
      resource: "payment_orders:xunhupay_reconciliation",
      request,
      requestKey,
      metadata,
    })
  );

  const intentRecorded = await audit("allowed", "PAYMENT_RECONCILIATION_MANUAL_INTENT_RECORDED", {
    lookbackDays: LOOKBACK_DAYS,
    maximumOrders: MANUAL_RECONCILIATION_LIMIT,
    provider: "xunhupay",
  });
  if (!intentRecorded) {
    return noStore(NextResponse.json(
      {
        error: "支付对账审计暂不可用，本次未查询供应商也未补账",
        code: "PAYMENT_RECONCILIATION_AUDIT_UNAVAILABLE",
      },
      { status: 503 },
    ));
  }

  try {
    const [xunhu, epay] = await Promise.all([
      readCandidates("xunhupay", MANUAL_RECONCILIATION_LIMIT),
      readCandidates("epay", 1),
    ]);
    let checked = 0;
    let recovered = 0;
    let unresolved = 0;
    let providerRefunded = 0;
    let providerNotFound = 0;
    let providerQueryErrors = 0;
    const recoveredOrders: string[] = [];
    const outcomes: Array<{ orderRef: string; outcome: string }> = [];

    for (const order of xunhu.rows) {
      checked += 1;
      const orderRef = paymentReference(order.trade_order_id);
      try {
        const confirmation = await queryOrderStatus(order.trade_order_id);
        if (!confirmation) {
          unresolved += 1;
          outcomes.push({ orderRef, outcome: "provider_inconclusive" });
          continue;
        }
        if (confirmation.status === "CD") {
          providerRefunded += 1;
          outcomes.push({ orderRef, outcome: "provider_reports_refunded_manual_review" });
          continue;
        }
        if (confirmation.status === "NOT_FOUND") {
          providerNotFound += 1;
          outcomes.push({ orderRef, outcome: "provider_not_found" });
          continue;
        }
        if (confirmation.status !== "OD") {
          unresolved += 1;
          outcomes.push({ orderRef, outcome: "still_pending" });
          continue;
        }

        const paidAmount = Number(confirmation.totalAmount);
        const localAmount = Number(order.amount);
        const providerTradeOrderId = confirmation.tradeOrderId;
        const providerTransactionId = confirmation.transactionId?.trim() || "";
        const evidenceComplete = Number.isFinite(paidAmount) && paidAmount > 0
          && Number.isFinite(localAmount) && Math.round(paidAmount * 100) === Math.round(localAmount * 100)
          && providerTradeOrderId === order.trade_order_id
          && Boolean(providerTransactionId);
        if (!evidenceComplete) {
          unresolved += 1;
          outcomes.push({ orderRef, outcome: "provider_evidence_incomplete" });
          continue;
        }

        const fulfillment = await fulfillPaymentOrder({
          tradeOrderId: order.trade_order_id,
          provider: "xunhupay",
          providerTradeOrderId: order.trade_order_id,
          providerTransactionId,
          paidAmount,
        });
        if (fulfillment.success) {
          recovered += 1;
          recoveredOrders.push(order.trade_order_id);
          outcomes.push({ orderRef, outcome: "atomically_fulfilled" });
        } else {
          unresolved += 1;
          outcomes.push({ orderRef, outcome: "fulfillment_rejected" });
        }
      } catch {
        providerQueryErrors += 1;
        unresolved += 1;
        outcomes.push({ orderRef, outcome: "provider_query_error" });
      }
    }

    const resultMetadata = {
      scanned: xunhu.rows.length,
      checked,
      recovered,
      unresolved,
      providerRefunded,
      providerNotFound,
      providerQueryErrors,
      epayCallbackOnly: epay.count,
      providerCalls: checked,
    };
    const resultAudited = await audit("success", "PAYMENT_RECONCILIATION_MANUAL_FINISHED", resultMetadata);
    return noStore(NextResponse.json({
      success: true,
      mode: "manual_step_up_reconcile",
      writePerformed: recovered > 0,
      ...resultMetadata,
      candidateCount: xunhu.count,
      candidateListTruncated: xunhu.truncated,
      recoveredOrders,
      outcomes,
      epay: {
        recoveryMode: "callback_only",
        automaticRecoverySupported: false,
        candidateCount: epay.count,
        actionRequired: epay.count > 0
          ? "核查签名回调日志和渠道后台；本站不伪造 EPay 主动恢复。"
          : null,
      },
      auditStatus: resultAudited ? "complete" : "authorized_intent_only",
      ...(!resultAudited ? {
        warning: "补账结果审计待运维核查；调用意图和订单原子到账凭证已保留。",
      } : {}),
    }, { status: resultAudited ? 200 : 202 }));
  } catch (error) {
    await audit("failure", "PAYMENT_RECONCILIATION_MANUAL_FAILED");
    console.error("[payment-reconcile] manual execution failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return noStore(NextResponse.json(
      { error: "支付人工对账失败", code: "PAYMENT_RECONCILIATION_MANUAL_FAILED" },
      { status: 503 },
    ));
  }
}
