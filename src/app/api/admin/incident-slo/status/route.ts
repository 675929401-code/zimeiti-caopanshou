import { NextRequest, NextResponse } from "next/server";

import { IncidentSloError, incidentSloExecutionPolicy } from "@/lib/incident-slo-control-plane";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readIncidentSloStatus } from "@/lib/server/incident-slo-control-plane";

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

// Read-only status. It does not collect metrics, open incidents, notify anyone,
// run a recovery probe, or invoke an action executor.
export async function GET(request: NextRequest) {
  const logsAccess = await authorizeAdminCapability(request, "logs.view", {
    operation: "incident_slo_status_read",
  });
  if (!logsAccess.ok) return logsAccess.response;
  const securityAccess = await authorizeAdminCapability(request, "security.view", {
    operation: "incident_slo_security_status_read",
  });
  if (!securityAccess.ok) return securityAccess.response;
  try {
    return json({ ok: true, ...(await readIncidentSloStatus()) });
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
        error: "事故与 SLO 控制平面暂不可用",
        code: "INCIDENT_SLO_STATUS_UNAVAILABLE",
        executionPolicy: incidentSloExecutionPolicy(),
      },
      503,
    );
  }
}
