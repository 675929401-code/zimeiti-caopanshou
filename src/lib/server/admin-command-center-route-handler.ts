import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  clampCommandCenterWindowHours,
  commandCenterPermissionKeysForView,
  commandCenterViewDefinition,
  isCommandCenterView,
  normalizeCommandCenterView,
  type CommandCenterView,
} from "@/lib/admin-command-center-domain";
import { missingAdminPermissionKeys } from "@/lib/admin-governance";
import { readAdminCommandCenterSnapshot } from "@/lib/server/admin-command-center";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";

export interface CommandCenterRouteDependencies {
  authorize: typeof authorizeAdminCapability;
  appendAudit: typeof appendAdminGovernanceAudit;
  readSnapshot: typeof readAdminCommandCenterSnapshot;
}

const DEFAULT_DEPENDENCIES: CommandCenterRouteDependencies = {
  authorize: authorizeAdminCapability,
  appendAudit: appendAdminGovernanceAudit,
  readSnapshot: readAdminCommandCenterSnapshot,
};

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
};

const MAX_REFRESH_ACTORS = 2_048;
const manualRefreshAcceptedAt = new Map<string, number>();

interface ManualRefreshDecision {
  allowed: boolean;
  intervalMs: number;
  remaining: 0 | 1;
  retryAfterSeconds: number;
  nextAllowedAt: string;
}

function manualRefreshDecision(actorId: string, view: CommandCenterView, consume: boolean): ManualRefreshDecision {
  const now = Date.now();
  const intervalMs = commandCenterViewDefinition(view).manualRefreshMinIntervalMs;
  const key = `${actorId}:${view}`;
  const lastAcceptedAt = manualRefreshAcceptedAt.get(key) || 0;
  const remainingMs = Math.max(0, lastAcceptedAt + intervalMs - now);
  if (consume && remainingMs <= 0) {
    manualRefreshAcceptedAt.set(key, now);
    if (manualRefreshAcceptedAt.size > MAX_REFRESH_ACTORS) {
      const staleBefore = now - Math.max(intervalMs * 2, 120_000);
      for (const [candidate, acceptedAt] of manualRefreshAcceptedAt) {
        if (acceptedAt < staleBefore) manualRefreshAcceptedAt.delete(candidate);
        if (manualRefreshAcceptedAt.size <= MAX_REFRESH_ACTORS) break;
      }
    }
    return {
      allowed: true,
      intervalMs,
      remaining: 0,
      retryAfterSeconds: Math.ceil(intervalMs / 1_000),
      nextAllowedAt: new Date(now + intervalMs).toISOString(),
    };
  }
  return {
    allowed: remainingMs <= 0,
    intervalMs,
    remaining: remainingMs <= 0 ? 1 : 0,
    retryAfterSeconds: Math.ceil(remainingMs / 1_000),
    nextAllowedAt: new Date(remainingMs <= 0 ? now : lastAcceptedAt + intervalMs).toISOString(),
  };
}

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

export function createCommandCenterGetHandler(
  dependencies: CommandCenterRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return async function handleCommandCenterGet(request: NextRequest): Promise<NextResponse> {
    const requestedView = request.nextUrl.searchParams.get("view");
    const view = normalizeCommandCenterView(requestedView);
    const requiredPermissions = commandCenterPermissionKeysForView(view);
    const authorization = await dependencies.authorize(request, requiredPermissions[0], {
      operation: `command_center_${view}_read`,
    });
    if (!authorization.ok) return noStore(authorization.response);

    const missingPermissions = missingAdminPermissionKeys(authorization.access.permissionKeys, requiredPermissions);
    if (missingPermissions.length > 0) {
      await dependencies.appendAudit({
        actorId: authorization.actor.userId,
        actorLevel: authorization.access.adminLevel,
        permissionKey: missingPermissions[0],
        action: "command_center_read",
        result: "denied",
        reasonCode: "ADMIN_PERMISSION_SET_INCOMPLETE",
        resource: request.nextUrl.pathname,
        request,
        metadata: { view, requiredPermissions, missingPermissions },
      });
      return noStore(NextResponse.json({
        error: "当前管理员缺少该指挥中心目标视图所需的数据权限",
        code: "ADMIN_PERMISSION_SET_INCOMPLETE",
      }, { status: 403 }));
    }

    const hours = clampCommandCenterWindowHours(request.nextUrl.searchParams.get("hours"));
    if (requestedView && !isCommandCenterView(requestedView)) {
      return noStore(NextResponse.json({
        error: "未知的平台指挥中心目标视图",
        code: "COMMAND_CENTER_VIEW_INVALID",
      }, { status: 400 }));
    }
    const bypassCache = request.nextUrl.searchParams.get("refresh") === "1";
    const refreshLimit = manualRefreshDecision(authorization.actor.userId, view, bypassCache);
    if (bypassCache && !refreshLimit.allowed) {
      return noStore(NextResponse.json({
        error: "刷新过于频繁，请在冷却结束后重试",
        code: "COMMAND_CENTER_REFRESH_RATE_LIMITED",
        asOf: new Date().toISOString(),
        freshnessSeconds: null,
        nextRefreshAt: refreshLimit.nextAllowedAt,
        cacheStatus: "rate_limited",
        rateLimit: {
          scope: "process-local-admin-view",
          limit: 1,
          intervalMs: refreshLimit.intervalMs,
          remaining: refreshLimit.remaining,
          retryAfterSeconds: refreshLimit.retryAfterSeconds,
          nextAllowedAt: refreshLimit.nextAllowedAt,
        },
      }, {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, refreshLimit.retryAfterSeconds)) },
      }));
    }
    try {
      const snapshot = await dependencies.readSnapshot({ hours, view, bypassCache });
      return NextResponse.json({
        ...snapshot,
        refresh: {
          ...snapshot.refresh,
          rateLimit: {
            scope: "process-local-admin-view",
            limit: 1,
            intervalMs: refreshLimit.intervalMs,
            remaining: refreshLimit.remaining,
            retryAfterSeconds: refreshLimit.retryAfterSeconds,
            nextAllowedAt: refreshLimit.nextAllowedAt,
          },
        },
      }, {
        headers: {
          ...NO_STORE_HEADERS,
          "X-RateLimit-Limit": "1",
          "X-RateLimit-Remaining": String(refreshLimit.remaining),
          "X-RateLimit-Reset": refreshLimit.nextAllowedAt,
        },
      });
    } catch {
      return NextResponse.json({
        error: "平台指挥中心暂时无法读取",
        code: "COMMAND_CENTER_UNAVAILABLE",
        readOnly: true,
        providerCalls: 0,
        businessWrites: 0,
      }, { status: 503, headers: NO_STORE_HEADERS });
    }
  };
}
