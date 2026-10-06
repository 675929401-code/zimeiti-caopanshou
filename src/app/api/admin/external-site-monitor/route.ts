import { NextRequest, NextResponse } from "next/server";

import {
  EXTERNAL_SITE_MONITOR_DEFAULT_EXPECTED_INTERVAL_SECONDS,
  type ExternalSiteMonitorRateLimitedResponse,
} from "@/lib/external-site-monitor-contract";
import {
  ExternalSiteMonitorError,
  readCachedExternalSiteMonitorSnapshot,
  readExternalSiteMonitorForAdmin,
} from "@/lib/server/external-site-monitor";
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

function unavailableReadBody(code: string, error: string) {
  const cached = readCachedExternalSiteMonitorSnapshot();
  const nowMs = Date.now();
  return {
    ok: false,
    code,
    error,
    nextRefreshAt: cached?.nextRefreshAt
      ?? new Date(nowMs + EXTERNAL_SITE_MONITOR_DEFAULT_EXPECTED_INTERVAL_SECONDS * 1_000).toISOString(),
  };
}

// Read-only evidence. This route never performs DNS, TLS, HTTPS or browser
// checks from the application host and therefore cannot masquerade as an
// external availability probe.
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "logs.view", {
    operation: "external_site_monitor_read",
  });
  if (!authorization.ok) {
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) authorization.response.headers.set(key, value);
    return authorization.response;
  }
  try {
    const result = await readExternalSiteMonitorForAdmin(authorization.actor.userId);
    if (result.allowed) return json(result.value);

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
    const body: ExternalSiteMonitorRateLimitedResponse = {
      ok: false,
      code: "EXTERNAL_SITE_MONITOR_RATE_LIMITED",
      error: result.reason === "single_flight"
        ? "同一管理员的外部监测读取正在进行，请稍后重试"
        : "外部监测最短读取间隔为 30 秒，请稍后重试",
      nextRefreshAt: new Date(result.nextAllowedAtMs).toISOString(),
    };
    return json(body, 429, { "Retry-After": String(retryAfterSeconds) });
  } catch (error) {
    if (error instanceof ExternalSiteMonitorError) {
      return json(unavailableReadBody(error.code, error.message), error.status);
    }
    console.error("[external-site-monitor] admin read failed", error);
    return json(unavailableReadBody(
      "EXTERNAL_SITE_MONITOR_UNAVAILABLE",
      "外部站点监测暂时无法读取",
    ), 503);
  }
}
