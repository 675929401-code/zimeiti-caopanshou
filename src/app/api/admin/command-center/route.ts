import { NextRequest } from "next/server";

import { createCommandCenterGetHandler } from "@/lib/server/admin-command-center-route-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handleCommandCenterGet = createCommandCenterGetHandler();

export async function GET(request: NextRequest) {
  return handleCommandCenterGet(request);
}
