import { NextRequest, NextResponse } from "next/server";

import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  getSecurityEventReliabilityStatus,
  SecurityEventReliabilityError,
  securityEventReliabilityErrorStatus,
} from "@/lib/server/security-event-reliability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

// Read-only receiver coverage. This endpoint does not drain, retry, purge,
// change rate state, or claim that the locked producer edge is durable.
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "security.view", {
    operation: "security_event_reliability_status_read",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;

  try {
    return json({
      ok: true,
      phase: "receiver_reliability_v1",
      complete: false,
      ...(await getSecurityEventReliabilityStatus()),
    });
  } catch (error) {
    const code = error instanceof SecurityEventReliabilityError
      ? error.code
      : "SECURITY_EVENT_RELIABILITY_STATUS_UNAVAILABLE";
    console.error("[Security Event Reliability] status read failed", code);
    return json({
      ok: false,
      phase: "receiver_reliability_v1",
      complete: false,
      error: "安全事件可靠化状态暂不可用",
      code,
    }, error instanceof SecurityEventReliabilityError ? securityEventReliabilityErrorStatus(error) : 503);
  }
}
