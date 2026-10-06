import { NextRequest, NextResponse } from "next/server";

import { horizontalScaleReadinessSnapshot } from "@/lib/horizontal-scale-readiness-contract";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

// This is a source-audit snapshot. It does not query live capacity, start a
// probe, call an upstream, request an allowed-read audit, or imply production
// readiness. Denied authorization still follows the governance audit policy.
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "logs.view", {
    operation: "horizontal_scale_readiness_status_read",
  });
  if (!authorization.ok) return authorization.response;

  return NextResponse.json(
    { ok: true, ...horizontalScaleReadinessSnapshot() },
    { status: 200, headers: PRIVATE_HEADERS },
  );
}
