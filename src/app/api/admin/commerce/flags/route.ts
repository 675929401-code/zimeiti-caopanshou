import { NextRequest } from "next/server";
import { requireCommerceAdmin } from "@/lib/commerce-admin-auth";
import { createRuntimeFlagsReadHandler, readRuntimeFlagSettingsFromPlatformSettings } from "@/lib/server/runtime-flag-read-layer";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";

const readRuntimeFlagsRoute = createRuntimeFlagsReadHandler({
  authorize: (request) => requireCommerceAdmin(request as NextRequest, {
    requiredPermissions: ["models.view"],
    operation: "commerce_runtime_flags_view",
  }),
  readSettings: readRuntimeFlagSettingsFromPlatformSettings,
  env: process.env,
});

/** 管理员专用：带货运行开关读取（后台配置优先，环境变量兜底；只读）。 */
export async function GET(request: NextRequest) {
  return readRuntimeFlagsRoute(request);
}
