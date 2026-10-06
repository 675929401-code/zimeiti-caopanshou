import { NextRequest, NextResponse } from "next/server";

import {
  MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
  type MemberRegionRateLimitedResponse,
} from "@/lib/member-region-distribution-contract";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  readCachedMemberRegionDistribution,
  readMemberRegionDistributionForAdmin,
} from "@/lib/server/member-region-distribution";

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
    operation: "member_region_distribution_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  try {
    const result = await readMemberRegionDistributionForAdmin(authorization.actor.userId);
    if (result.allowed) {
      return NextResponse.json(result.value, {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    const cached = readCachedMemberRegionDistribution();
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
    const body: MemberRegionRateLimitedResponse = {
      ok: false,
      code: "MEMBER_REGION_DISTRIBUTION_RATE_LIMITED",
      error: result.reason === "single_flight"
        ? "同一管理员的会员地域读取正在进行，请稍后重试"
        : "会员地域数据最短读取间隔为 60 秒，请稍后重试",
      asOf: cached?.asOf ?? null,
      freshness: cached?.freshness ?? null,
      nextRefreshAt: new Date(result.nextAllowedAtMs).toISOString(),
      cacheStatus: "rate_limited",
      rateLimit: {
        scope: "process-local-admin",
        minimumIntervalMs: MEMBER_REGION_MIN_REQUEST_INTERVAL_MS,
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
    console.error("[member-region-distribution] snapshot read failed", error);
    return NextResponse.json({
      ok: false,
      code: "MEMBER_REGION_DISTRIBUTION_UNAVAILABLE",
      error: "会员地域数据准备度暂时无法读取",
    }, {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }
}
