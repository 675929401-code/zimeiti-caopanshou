import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";

const retiredPayload = {
  error: "主站自由画布已退役，画布提示词不再由管理后台维护",
  code: "ADMIN_CANVAS_PROMPTS_RETIRED",
  replacement: "/admin?tab=workspace-models&project=storyboard",
};

function retired(request: Request) {
  return withAdminAuth(request, async () => NextResponse.json(retiredPayload, { status: 410 }));
}

export const GET = retired;
export const POST = retired;
