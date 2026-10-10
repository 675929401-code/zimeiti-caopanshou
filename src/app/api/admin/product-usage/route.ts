import { NextRequest, NextResponse } from "next/server";

import {
  PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
  type ProductUsageRateLimitedResponse,
} from "@/lib/product-usage-contract";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  readCachedProductUsageAnalytics,
  readProductUsageAnalyticsForAdmin,
} from "@/lib/server/product-usage-analytics";
import { createOperationPerformanceTrace } from "@/lib/operation-performance-trace";
import { recordServerOperationPerformanceEventBestEffort } from "@/lib/operation-flight-recorder";

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

export async function GET(request: NextRequest) {
  const performanceTrace = createOperationPerformanceTrace({
    domain: "admin",
    operation: "admin.product_usage_load",
    route: "/api/admin/product-usage",
    requestId: request.headers.get("x-client-trace-id"),
    traceId: request.headers.get("x-client-trace-id"),
  }, (event) => { void recordServerOperationPerformanceEventBestEffort(event); });
  performanceTrace.checkpoint("request.received", { outcome: "in_progress" });
  const authorization = await authorizeAdminCapability(request, "members.view", {
    operation: "product_usage_analytics_read",
  });
  if (!authorization.ok) {
    performanceTrace.checkpoint("response.terminal", {
      outcome: "error",
      httpStatus: authorization.response.status,
      errorCode: "ADMIN_PRODUCT_USAGE_FORBIDDEN",
    });
    return noStore(authorization.response);
  }
  performanceTrace.enrichIdentity({
    userId: authorization.actor.userId,
    accountId: authorization.actor.userId,
  });
  performanceTrace.checkpoint("auth.permission");

  try {
    const result = await readProductUsageAnalyticsForAdmin(authorization.actor.userId);
    performanceTrace.checkpoint("database.read");
    if (result.allowed) {
      performanceTrace.checkpoint("response.first_byte", { httpStatus: 200 });
      performanceTrace.checkpoint("response.terminal", { httpStatus: 200 });
      return NextResponse.json(result.value, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const cached = readCachedProductUsageAnalytics();
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
    if (cached) {
      performanceTrace.checkpoint("response.first_byte", { httpStatus: 200 });
      performanceTrace.checkpoint("response.terminal", { httpStatus: 200 });
      return NextResponse.json({
        ...cached,
        refresh: {
          ...cached.refresh,
          cacheStatus: "hit",
          nextRefreshAt: new Date(result.nextAllowedAtMs).toISOString(),
          rateLimit: {
            ...cached.refresh.rateLimit,
            remainingMs: result.retryAfterMs,
            retryAfterSeconds,
          },
        },
      }, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }
    const body: ProductUsageRateLimitedResponse = {
      ok: false,
      code: "PRODUCT_USAGE_ANALYTICS_RATE_LIMITED",
      error: result.reason === "single_flight"
        ? "同一管理员的产品使用数据读取正在进行，请稍后重试"
        : "产品使用数据最短读取间隔为 60 秒，请稍后重试",
      asOf: null,
      nextRefreshAt: new Date(result.nextAllowedAtMs).toISOString(),
      cacheStatus: "rate_limited",
      rateLimit: {
        scope: "process-local-admin",
        minimumIntervalMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
        remainingMs: result.retryAfterMs,
        retryAfterSeconds,
      },
    };
    performanceTrace.checkpoint("response.first_byte", { httpStatus: 429 });
    performanceTrace.checkpoint("response.terminal", {
      outcome: "warning",
      httpStatus: 429,
      errorCode: "PRODUCT_USAGE_ANALYTICS_RATE_LIMITED",
    });
    return NextResponse.json(body, {
      status: 429,
      headers: {
        ...NO_STORE_HEADERS,
        "Retry-After": String(retryAfterSeconds),
      },
    });
  } catch (error) {
    console.error("[product-usage-analytics] snapshot read failed", error);
    performanceTrace.checkpoint("response.terminal", {
      outcome: "error",
      httpStatus: 503,
      errorCode: "PRODUCT_USAGE_ANALYTICS_UNAVAILABLE",
    });
    return NextResponse.json({
      ok: false,
      code: "PRODUCT_USAGE_ANALYTICS_UNAVAILABLE",
      error: "产品使用数据暂时无法读取",
    }, {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }
}
