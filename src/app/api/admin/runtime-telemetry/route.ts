import { NextRequest, NextResponse } from "next/server";

import {
  RUNTIME_TELEMETRY_SCOPE,
  type RuntimeTelemetryRateLimitedResponse,
} from "@/lib/runtime-telemetry-contract";
import {
  readRuntimeTelemetryForAdmin,
  readRuntimeTelemetrySnapshot,
} from "@/lib/server/runtime-telemetry";
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

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "logs.view", {
    operation: "runtime_telemetry_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const result = await readRuntimeTelemetryForAdmin(authorization.actor.userId);
  if (result.allowed) {
    return NextResponse.json(result.value, {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  }

  const nowMs = Date.now();
  const snapshot = readRuntimeTelemetrySnapshot({
    nowMs,
    nextRefreshAtMs: result.nextAllowedAtMs,
    rateLimitRemainingMs: result.retryAfterMs,
    touchActivity: false,
  });
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
  const body: RuntimeTelemetryRateLimitedResponse = {
    ok: false,
    code: "RUNTIME_TELEMETRY_RATE_LIMITED",
    error: result.reason === "single_flight"
      ? "同一管理员的遥测读取正在进行，请稍后重试"
      : "遥测读取最短间隔为 15 秒，请稍后重试",
    scope: RUNTIME_TELEMETRY_SCOPE,
    asOf: snapshot.asOf,
    freshness: snapshot.freshness,
    nextRefreshAt: snapshot.nextRefreshAt,
    cacheStatus: "rate_limited",
    rateLimit: {
      ...snapshot.rateLimit,
      retryAfterSeconds,
    },
    idlePolicy: snapshot.idlePolicy,
  };

  return NextResponse.json(body, {
    status: 429,
    headers: {
      ...NO_STORE_HEADERS,
      "Retry-After": String(retryAfterSeconds),
    },
  });
}
