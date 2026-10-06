import { NextRequest, NextResponse } from "next/server";

import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readAdminBackupRestoreSnapshot } from "@/lib/server/backup-restore-control-plane";

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
  const authorization = await authorizeAdminCapability(request, "backups.manage", {
    operation: "backup_restore_control_plane_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  const snapshot = await readAdminBackupRestoreSnapshot();
  return NextResponse.json(snapshot, {
    status: snapshot.schemaState === "unavailable" ? 503 : 200,
    headers: NO_STORE_HEADERS,
  });
}
