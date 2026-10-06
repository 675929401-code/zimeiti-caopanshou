import { NextRequest, NextResponse } from "next/server";

import {
  FINANCIAL_RECONCILIATION_DEFAULT_PAGE_SIZE,
  type FinancialReconciliationRateLimitedResponse,
} from "@/lib/financial-reconciliation-contract";
import {
  FinancialReconciliationCursorError,
  readFullFinancialReconciliationForAdmin,
} from "@/lib/server/full-financial-reconciliation";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

/**
 * Full reconciliation is split into signed, bounded pages. Each cursor freezes
 * the created_at population boundary and carries cumulative coverage. This
 * endpoint never mutates balances or calls a payment provider.
 */
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "financial_full_reconciliation_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const cursor = request.nextUrl.searchParams.get("cursor");
  const requestedPageSize = Number(
    request.nextUrl.searchParams.get("pageSize") || FINANCIAL_RECONCILIATION_DEFAULT_PAGE_SIZE,
  );

  try {
    const result = await readFullFinancialReconciliationForAdmin({
      actorId: authorization.actor.userId,
      cursor,
      pageSize: requestedPageSize,
      requestSignal: request.signal,
    });
    if (result.allowed) {
      return NextResponse.json(result.value, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
    const body: FinancialReconciliationRateLimitedResponse = {
      ok: false,
      code: "FINANCIAL_RECONCILIATION_RATE_LIMITED",
      error: result.reason === "single_flight"
        ? "同一管理员的资金扫描正在处理，请等待当前批次结束"
        : "资金扫描请求过于频繁，请按检查点继续",
      retryAfterSeconds,
      nextAllowedAt: new Date(result.nextAllowedAtMs).toISOString(),
    };
    return NextResponse.json(body, {
      status: 429,
      headers: {
        ...NO_STORE_HEADERS,
        "Retry-After": String(retryAfterSeconds),
      },
    });
  } catch (error) {
    if (error instanceof FinancialReconciliationCursorError) {
      return NextResponse.json({
        ok: false,
        code: error.code,
        error: error.message,
      }, {
        status: error.code === "CURSOR_EXPIRED" ? 410 : 400,
        headers: NO_STORE_HEADERS,
      });
    }
    console.error("[financial-reconciliation] bounded scan failed", error);
    return NextResponse.json({
      ok: false,
      code: "FINANCIAL_RECONCILIATION_UNAVAILABLE",
      error: "资金一致性扫描暂不可用；未完成覆盖前系统不会显示通过",
    }, {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }
}

/** No bulk rebuild or automatic repair is exposed by this route. */
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "financial_reconciliation_write_rejected",
  });
  if (!authorization.ok) return noStore(authorization.response);
  return NextResponse.json({
    ok: false,
    error: "资金一致性扫描只读；批量重算和自动修复已禁用",
    code: "FINANCIAL_RECONCILIATION_READ_ONLY",
    detail: "如需修复，请针对单个订单或钱包 operation_id 走审计后的原子处理链路。",
  }, {
    status: 405,
    headers: { ...NO_STORE_HEADERS, Allow: "GET" },
  });
}
