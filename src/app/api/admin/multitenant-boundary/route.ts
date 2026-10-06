import { NextRequest, NextResponse } from "next/server";

import { readAdminMultitenantBoundarySnapshot } from "@/lib/server/multitenant-boundary";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Expires: "0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
};

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "white_label.manage", {
    operation: "multitenant_boundary_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const snapshot = await readAdminMultitenantBoundarySnapshot();
  return NextResponse.json(snapshot, {
    status: snapshot.migrationRequired ? 503 : 200,
    headers: NO_STORE_HEADERS,
  });
}
