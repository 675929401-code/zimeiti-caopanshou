import { NextRequest, NextResponse } from "next/server";

import {
  ADMIN_COMMAND_CENTER_PERMISSION_KEYS,
  missingAdminPermissionKeys,
} from "@/lib/admin-governance";
import { SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS } from "@/lib/slo-metric-registry";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { readSloMetricRegistrySnapshot } from "@/lib/server/slo-metric-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};
const MAX_REFRESH_ACTORS = 2_048;
const NORMAL_READ_MIN_INTERVAL_MS = 15_000;
const MAX_READ_KEYS = 2_048;
const SUPPORTED_WINDOW_HOURS = new Set([24, 72, 168]);
const FIXED_HISTORY_POINTS = 12;
const manualRefreshAt = new Map<string, number>();
const normalReadAt = new Map<string, number>();

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

function refreshDecision(actorId: string, consume: boolean): {
  allowed: boolean;
  remaining: 0 | 1;
  retryAfterSeconds: number;
  nextAllowedAt: string;
} {
  const now = Date.now();
  const lastAccepted = manualRefreshAt.get(actorId) || 0;
  const remainingMs = Math.max(0, lastAccepted + SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS - now);
  if (consume && remainingMs <= 0) {
    manualRefreshAt.set(actorId, now);
    if (manualRefreshAt.size > MAX_REFRESH_ACTORS) {
      const staleBefore = now - SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS * 2;
      for (const [key, acceptedAt] of manualRefreshAt) {
        if (acceptedAt < staleBefore) manualRefreshAt.delete(key);
        if (manualRefreshAt.size <= MAX_REFRESH_ACTORS) break;
      }
      while (manualRefreshAt.size > MAX_REFRESH_ACTORS) {
        const oldestActor = manualRefreshAt.keys().next().value as string | undefined;
        if (!oldestActor) break;
        manualRefreshAt.delete(oldestActor);
      }
    }
    return {
      allowed: true,
      remaining: 0,
      retryAfterSeconds: Math.ceil(SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS / 1_000),
      nextAllowedAt: new Date(now + SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS).toISOString(),
    };
  }
  return {
    allowed: remainingMs <= 0,
    remaining: remainingMs <= 0 ? 1 : 0,
    retryAfterSeconds: Math.ceil(remainingMs / 1_000),
    nextAllowedAt: new Date(remainingMs > 0 ? lastAccepted + SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS : now).toISOString(),
  };
}

function normalReadDecision(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
  nextAllowedAt: string;
} {
  const now = Date.now();
  const lastAccepted = normalReadAt.get(key) || 0;
  const remainingMs = Math.max(0, lastAccepted + NORMAL_READ_MIN_INTERVAL_MS - now);
  if (remainingMs <= 0) {
    normalReadAt.set(key, now);
    if (normalReadAt.size > MAX_READ_KEYS) {
      const staleBefore = now - NORMAL_READ_MIN_INTERVAL_MS * 2;
      for (const [candidate, acceptedAt] of normalReadAt) {
        if (acceptedAt < staleBefore) normalReadAt.delete(candidate);
        if (normalReadAt.size <= MAX_READ_KEYS) break;
      }
      while (normalReadAt.size > MAX_READ_KEYS) {
        const oldestKey = normalReadAt.keys().next().value as string | undefined;
        if (!oldestKey) break;
        normalReadAt.delete(oldestKey);
      }
    }
    return {
      allowed: true,
      retryAfterSeconds: 0,
      nextAllowedAt: new Date(now).toISOString(),
    };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
    nextAllowedAt: new Date(lastAccepted + NORMAL_READ_MIN_INTERVAL_MS).toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "logs.view", {
    operation: "slo_metric_registry_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const missingPermissions = missingAdminPermissionKeys(
    authorization.access.permissionKeys,
    ADMIN_COMMAND_CENTER_PERMISSION_KEYS,
  );
  if (missingPermissions.length > 0) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: missingPermissions[0],
      action: "slo_metric_registry_read",
      result: "denied",
      reasonCode: "ADMIN_PERMISSION_SET_INCOMPLETE",
      resource: request.nextUrl.pathname,
      request,
      metadata: {
        requiredPermissions: ADMIN_COMMAND_CENTER_PERMISSION_KEYS,
        missingPermissions,
      },
    });
    return noStore(NextResponse.json({
      error: "当前管理员缺少指标注册表所需的完整数据权限",
      code: "ADMIN_PERMISSION_SET_INCOMPLETE",
    }, { status: 403 }));
  }

  const requestedWindow = request.nextUrl.searchParams.get("hours");
  const windowHours = requestedWindow === null ? 24 : Number(requestedWindow);
  const requestedHistoryPoints = request.nextUrl.searchParams.get("historyPoints");
  const historyPoints = requestedHistoryPoints === null ? FIXED_HISTORY_POINTS : Number(requestedHistoryPoints);
  if (!Number.isInteger(windowHours) || !SUPPORTED_WINDOW_HOURS.has(windowHours)) {
    return noStore(NextResponse.json({
      error: "统计窗口仅支持 24、72 或 168 小时",
      code: "SLO_METRIC_REGISTRY_WINDOW_UNSUPPORTED",
      supportedWindowHours: [...SUPPORTED_WINDOW_HOURS],
    }, { status: 400 }));
  }
  if (historyPoints !== FIXED_HISTORY_POINTS) {
    return noStore(NextResponse.json({
      error: "历史点数固定为 12，以限制查询成本",
      code: "SLO_METRIC_REGISTRY_HISTORY_POINTS_UNSUPPORTED",
      supportedHistoryPoints: FIXED_HISTORY_POINTS,
    }, { status: 400 }));
  }
  const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";
  const rateLimit = refreshDecision(authorization.actor.userId, bypassCache);
  if (bypassCache && !rateLimit.allowed) {
    return noStore(NextResponse.json({
      error: "刷新过于频繁，请在冷却结束后重试",
      code: "SLO_METRIC_REGISTRY_RATE_LIMITED",
      asOf: new Date().toISOString(),
      freshnessSeconds: null,
      nextRefreshAt: rateLimit.nextAllowedAt,
      cacheStatus: "rate_limited",
      rateLimit: {
        scope: "process-local-admin",
        limit: 1,
        intervalMs: SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS,
        remaining: rateLimit.remaining,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        nextAllowedAt: rateLimit.nextAllowedAt,
      },
    }, {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, rateLimit.retryAfterSeconds)) },
    }));
  }

  if (!bypassCache) {
    const readLimit = normalReadDecision(`${authorization.actor.userId}:${windowHours}:${historyPoints}`);
    if (!readLimit.allowed) {
      return noStore(NextResponse.json({
        error: "指标注册表读取过于频繁，请稍后重试",
        code: "SLO_METRIC_REGISTRY_READ_RATE_LIMITED",
        asOf: new Date().toISOString(),
        freshnessSeconds: null,
        nextRefreshAt: readLimit.nextAllowedAt,
        cacheStatus: "rate_limited",
        rateLimit: {
          scope: "process-local-admin-window",
          limit: 1,
          intervalMs: NORMAL_READ_MIN_INTERVAL_MS,
          remaining: 0,
          retryAfterSeconds: readLimit.retryAfterSeconds,
          nextAllowedAt: readLimit.nextAllowedAt,
        },
      }, {
        status: 429,
        headers: { "Retry-After": String(readLimit.retryAfterSeconds) },
      }));
    }
  }

  try {
    const snapshot = await readSloMetricRegistrySnapshot({ windowHours, historyPoints, bypassCache });
    return NextResponse.json({
      ...snapshot,
      refresh: {
        ...snapshot.refresh,
        rateLimit: {
          scope: "process-local-admin",
          limit: 1,
          intervalMs: SLO_METRIC_REGISTRY_MANUAL_REFRESH_MS,
          remaining: rateLimit.remaining,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
          nextAllowedAt: rateLimit.nextAllowedAt,
        },
      },
    }, {
      headers: {
        ...NO_STORE_HEADERS,
        "X-RateLimit-Limit": "1",
        "X-RateLimit-Remaining": String(rateLimit.remaining),
        "X-RateLimit-Reset": rateLimit.nextAllowedAt,
      },
    });
  } catch {
    return NextResponse.json({
      error: "指标注册表暂时无法读取",
      code: "SLO_METRIC_REGISTRY_UNAVAILABLE",
      readOnly: true,
      providerCalls: 0,
      businessWrites: 0,
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
