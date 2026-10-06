import { NextRequest, NextResponse } from "next/server";
import { testCozeConnection, clearCozeConfigCache } from "@/lib/coze-api";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

// POST /api/coze/test - Test the platform-level Coze integration.
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "integrations.manage", {
    requireStepUp: true,
    operation: "coze_integration_connection_test",
  });
  if (!authorization.ok) return authorization.response;

  // Clear cache first to pick up latest settings
  clearCozeConfigCache();

  const result = await testCozeConnection();
  return NextResponse.json(result);
}
