import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readConfigurationIdentity } from "@/lib/server/configuration-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Cookie" };

/** Owner-only diagnostic hashes; existing sensitive-read governance and audit remain in force. */
export async function GET(request: NextRequest) {
  const listing = await authorizeAdminCapability(request, "agents.view", { operation: "configuration_identity_read", requireStepUp: false });
  if (!listing.ok) return listing.response;
  if (listing.access.adminLevel !== "super_admin" || !listing.access.profileActive
    || listing.access.revision <= 0 || !listing.access.checksum || listing.access.checksum === "legacy-schema-absent") {
    return NextResponse.json({ error: "配置身份诊断仅限当前超级管理员", code: "CONFIGURATION_IDENTITY_OWNER_REQUIRED" }, { status: 403, headers: noStore });
  }
  for (const permission of ["models.view", "members.view", "prompts.view", "internal_tools.manage"] as const) {
    const access = await authorizeAdminCapability(request, permission, {
      operation: "configuration_identity_read", requireStepUp: ["prompts.view", "internal_tools.manage"].includes(permission),
    });
    if (!access.ok) return access.response;
  }
  try {
    return NextResponse.json(await readConfigurationIdentity(), { headers: noStore });
  } catch {
    return NextResponse.json({ error: "配置身份暂不可用", code: "CONFIGURATION_IDENTITY_UNAVAILABLE" }, { status: 503, headers: noStore });
  }
}
