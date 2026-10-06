import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getHealthStatus, resetAllHealth } from "@/lib/llm-fallback";

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "models.manage", {
      requireStepUp: true,
      operation: "model_health_view",
    });
    if (!authorization.ok) return authorization.response;
    return NextResponse.json({ health: getHealthStatus() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "models.manage", {
      requireStepUp: true,
      operation: "model_health_reset",
    });
    if (!authorization.ok) return authorization.response;
    const body = await request.json();
    if (body.action === "reset_all") {
      resetAllHealth();
      return NextResponse.json({ success: true, message: "所有模型健康记录已重置" });
    }
    return NextResponse.json({ error: "无效操作" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
