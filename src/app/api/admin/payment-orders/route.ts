// 🔒 核心底层代码 — 锁定保护
//
// 本文件是管理员订单查询 API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。

import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const MAX_PAGE = 1_000;
const MAX_PAGE_SIZE = 100;
const ALLOWED_QUERY_KEYS = new Set(["page", "pageSize", "status"]);
const ALLOWED_STATUSES = new Set(["pending", "paid", "failed", "expired", "refunded"]);
const PAYMENT_ORDER_COLUMNS = [
  "id", "user_id", "trade_order_id", "type", "amount", "credits_amount",
  "status", "payment_method", "payment_provider", "platform_order_id",
  "payment_url", "paid_at", "created_at", "expire_at",
  "provider_trade_order_id", "provider_transaction_id", "provider_paid_amount",
  "provider_confirmed_at", "refund_attempt_id", "provider_refund_id",
  "provider_refund_amount", "provider_refund_status", "refunded_at",
].join(",");

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function boundedInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value == null || value === "") return fallback;
  if (!/^\d{1,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function finiteMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function pageSummary(rows: Array<Record<string, unknown>>) {
  const paid = rows.filter((row) => row.status === "paid");
  const pending = rows.filter((row) => row.status === "pending");
  return {
    totalOrders: rows.length,
    totalAmount: Math.round(rows.reduce((sum, row) => sum + finiteMoney(row.amount), 0) * 100) / 100,
    successAmount: Math.round(paid.reduce((sum, row) => sum + finiteMoney(row.amount), 0) * 100) / 100,
    successCount: paid.length,
    pendingCount: pending.length,
    byPayMethod: {},
    scope: "page_fallback",
  };
}

function validSummary(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return ["totalOrders", "totalAmount", "successAmount", "successCount", "pendingCount"]
    .every((key) => Number.isFinite(Number(summary[key])) && Number(summary[key]) >= 0);
}

// GET /api/admin/payment-orders - 管理员获取有界支付订单列表
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "payment_orders_view",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const unknownKey = [...request.nextUrl.searchParams.keys()].find((key) => !ALLOWED_QUERY_KEYS.has(key));
  const page = boundedInteger(request.nextUrl.searchParams.get("page"), 1, MAX_PAGE);
  const pageSize = boundedInteger(request.nextUrl.searchParams.get("pageSize"), 20, MAX_PAGE_SIZE);
  const status = (request.nextUrl.searchParams.get("status") || "").trim().toLowerCase();
  if (unknownKey || page === null || pageSize === null || (status && !ALLOWED_STATUSES.has(status))) {
    return noStore(NextResponse.json(
      { error: "支付订单查询参数无效", code: "PAYMENT_ORDER_QUERY_INVALID" },
      { status: 400 },
    ));
  }

  try {
    const database = getSupabaseAdminClient();
    let query = database
      .from("payment_orders")
      .select(PAYMENT_ORDER_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const from = (page - 1) * pageSize;
    const { data, count, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data || []) as unknown as Array<Record<string, unknown>>;

    // The optional RPC is installed by the same forward migration as manual
    // refund reconciliation. Until that migration is deployed, return an
    // explicit page-scoped fallback rather than downloading the full table.
    const summaryResult = await database.rpc("read_payment_order_admin_summary", {
      p_status: status || null,
    });
    const summary = !summaryResult.error && validSummary(summaryResult.data)
      ? summaryResult.data
      : pageSummary(rows);
    const summaryStatus = !summaryResult.error && validSummary(summaryResult.data)
      ? "server_aggregate"
      : "page_fallback_migration_required";

    return noStore(NextResponse.json({
      orders: rows,
      total: count || 0,
      page,
      pageSize,
      pageCount: rows.length,
      status: status || null,
      summary,
      summaryStatus,
      providerRecovery: {
        xunhupay: {
          mode: "manual_step_up_query",
          automaticScheduledRecovery: false,
        },
        epay: {
          mode: "callback_only",
          automaticRecoverySupported: false,
          message: "本站没有已核验的 EPay 主动查询协议；缺失回调的订单必须人工核查渠道后台，不能伪恢复。",
        },
      },
    }));
  } catch (error) {
    console.error("[payment-orders] bounded query failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return noStore(NextResponse.json(
      { error: "获取支付订单失败", code: "PAYMENT_ORDER_QUERY_FAILED" },
      { status: 503 },
    ));
  }
}
