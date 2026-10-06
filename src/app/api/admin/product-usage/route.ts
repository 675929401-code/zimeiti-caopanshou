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
  const authorization = await authorizeAdminCapability(request, "members.view", {
    operation: "product_usage_analytics_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  try {
    const result = await readProductUsageAnalyticsForAdmin(authorization.actor.userId);
    if (result.allowed) {
      return NextResponse.json(result.value, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const cached = readCachedProductUsageAnalytics();
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
    const body: ProductUsageRateLimitedResponse = {
      ok: false,
      code: "PRODUCT_USAGE_ANALYTICS_RATE_LIMITED",
      error: result.reason === "single_flight"
        ? "同一管理员的产品使用数据读取正在进行，请稍后重试"
        : "产品使用数据最短读取间隔为 60 秒，请稍后重试",
      asOf: cached?.asOf ?? null,
      nextRefreshAt: new Date(result.nextAllowedAtMs).toISOString(),
      cacheStatus: "rate_limited",
      rateLimit: {
        scope: "process-local-admin",
        minimumIntervalMs: PRODUCT_USAGE_MIN_REQUEST_INTERVAL_MS,
        remainingMs: result.retryAfterMs,
        retryAfterSeconds,
      },
    };
    return NextResponse.json(body, {
      status: 429,
      headers: {
        ...NO_STORE_HEADERS,
        "Retry-After": String(retryAfterSeconds),
      },
    });
  } catch (error) {
    console.error("[product-usage-analytics] snapshot read failed", error);
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
