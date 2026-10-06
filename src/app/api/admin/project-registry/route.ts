import { NextRequest, NextResponse } from "next/server";

import { readAdminProjectRegistrySnapshot } from "@/lib/server/project-registry";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
};

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "logs.view", {
    operation: "project_registry_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const snapshot = await readAdminProjectRegistrySnapshot();
  return NextResponse.json(snapshot, {
    status: snapshot.registryState === "unavailable" ? 503 : 200,
    headers: NO_STORE_HEADERS,
  });
}
