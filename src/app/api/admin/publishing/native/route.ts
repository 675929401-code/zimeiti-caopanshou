import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/api-middleware";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readPublishingNativeStatus } from "@/lib/server/publishing-native-status";
import { publishingFailure } from "@/lib/server/publishing-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    for (const capability of ["integrations.manage", "packages.manage"] as const) {
      const access = await authorizeAdminCapability(request, capability, { requireStepUp: false, operation: "publishing_native_metadata_read" });
      if (!access.ok) { access.response.headers.set("Cache-Control", "private, no-store"); return access.response; }
    }
    const billing = await authorizeAdminCapability(request, "billing.view", { requireStepUp: false, operation: "publishing_native_counts_read" });
    // Do not perform unscoped count queries without the accounting read capability.
    return NextResponse.json(await readPublishingNativeStatus(getSupabase(), { includeCounts: billing.ok }), { headers });
  } catch (error) { const result = publishingFailure(error); return NextResponse.json(result.body, { status: result.status, headers }); }
}
