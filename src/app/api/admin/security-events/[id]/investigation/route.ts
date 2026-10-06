import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import {
  readSecurityEventInvestigation,
  SecurityEventInvestigationError,
} from "@/lib/server/security-event-investigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function privateResponse(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function allowed(result: AdminCapabilityResult): Extract<AdminCapabilityResult, { ok: true }> {
  if (!result.ok) throw new Error("authorization result is not allowed");
  return result;
}

function parseEventId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw new SecurityEventInvestigationError("安全事件编号无效", "SECURITY_EVENT_ID_INVALID", 400);
  }
  return id;
}

function parseReason(request: NextRequest): string {
  const reason = (request.nextUrl.searchParams.get("reason") || "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (reason.length < 8 || reason.length > 240) {
    throw new SecurityEventInvestigationError(
      "查看原始调查线索前，请填写 8 至 240 字的调查原因",
      "SECURITY_INVESTIGATION_REASON_REQUIRED",
      400,
    );
  }
  return reason;
}

async function appendRevealAudit(params: {
  request: NextRequest;
  authorization: Extract<AdminCapabilityResult, { ok: true }>;
  eventId: string;
  reason: string;
  result: "success" | "failure";
  reasonCode: string;
  requestKey: string;
}): Promise<boolean> {
  return appendAdminGovernanceAudit({
    actorId: params.authorization.actor.userId,
    actorLevel: params.authorization.access.adminLevel,
    permissionKey: "security.manage",
    action: "security_event_investigation_reveal",
    result: params.result,
    reasonCode: params.reasonCode,
    resource: "security_event_investigation",
    request: params.request,
    requestKey: params.requestKey,
    metadata: {
      eventId: params.eventId,
      investigationReason: params.reason,
      revealedFields: ["raw_ip", "ip_hash", "raw_user_agent", "account_linkage", "correlations"],
    },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authorizationResult = await authorizeAdminCapability(request, "security.manage", {
    operation: "security_event_investigation_reveal",
    requireStepUp: true,
  });
  if (!authorizationResult.ok) return privateResponse(authorizationResult.response);
  const authorization = allowed(authorizationResult);
  const requestKey = request.headers.get("x-request-id")?.trim().slice(0, 200) || crypto.randomUUID();
  let eventId = "invalid";
  let reason = "invalid";

  try {
    eventId = parseEventId((await context.params).id);
    reason = parseReason(request);
    const investigation = await readSecurityEventInvestigation(eventId);
    const auditSaved = await appendRevealAudit({
      request,
      authorization,
      eventId,
      reason,
      result: "success",
      reasonCode: "SECURITY_INVESTIGATION_REVEALED",
      requestKey,
    });
    if (!auditSaved) {
      return json({
        ok: false,
        error: "调查审计记录暂不可用，原始线索未返回",
        code: "SECURITY_INVESTIGATION_AUDIT_UNAVAILABLE",
      }, 503);
    }

    return json({
      ok: true,
      investigation: {
        ...investigation,
        audit: {
          reason,
          revealedAt: new Date().toISOString(),
          permission: "security.manage",
          stepUpVerified: true,
          requestKey,
        },
      },
    });
  } catch (error) {
    const code = error instanceof SecurityEventInvestigationError
      ? error.code
      : "SECURITY_INVESTIGATION_FAILED";
    if (eventId !== "invalid" && reason !== "invalid") {
      await appendRevealAudit({
        request,
        authorization,
        eventId,
        reason,
        result: "failure",
        reasonCode: code,
        requestKey,
      });
    }
    if (error instanceof SecurityEventInvestigationError) {
      return json({ ok: false, error: error.message, code: error.code }, error.status);
    }
    console.error("[Security Investigation] reveal failed", code);
    return json({
      ok: false,
      error: "安全事件调查数据暂不可用",
      code: "SECURITY_INVESTIGATION_FAILED",
    }, 503);
  }
}
