import { NextRequest, NextResponse } from "next/server";

import {
  IncidentSloError,
  incidentSloExecutionPolicy,
  parseIncidentSloControlCommand,
  validateIncidentSloRequestKey,
} from "@/lib/incident-slo-control-plane";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { executeIncidentSloControlCommand } from "@/lib/server/incident-slo-control-plane";

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

// Controlled writes are limited to incident state, ownership leases, recovery
// probe evidence, postmortem links, and preview/request registration. There is
// deliberately no provider, queue replay, process-control, or remediation call.
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "security.manage", {
    operation: "incident_slo_control",
    requireStepUp: true,
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "请求体超过 32KB", 400);
    }
    const requestKey = validateIncidentSloRequestKey(request.headers.get("idempotency-key"));
    const command = parseIncidentSloControlCommand(await request.json().catch(() => null));
    const result = await executeIncidentSloControlCommand(
      command,
      authorization.actor.userId,
      requestKey,
    );
    return json({
      ok: true,
      result,
      requestKey,
      executionPolicy: incidentSloExecutionPolicy(),
    });
  } catch (error) {
    if (error instanceof IncidentSloError) {
      return json(
        { ok: false, error: error.message, code: error.code, executionPolicy: incidentSloExecutionPolicy() },
        error.status,
      );
    }
    return json(
      {
        ok: false,
        error: "事故控制请求失败",
        code: "INCIDENT_SLO_CONTROL_UNAVAILABLE",
        executionPolicy: incidentSloExecutionPolicy(),
      },
      503,
    );
  }
}
