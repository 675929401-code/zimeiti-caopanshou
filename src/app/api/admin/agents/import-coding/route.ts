import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";

const RETIRED_RESPONSE = {
  error: "旧版 Coding 智能体通道已停用，不能再导入。请使用模型资源池和统一 LLM 路由配置智能体。",
  code: "LEGACY_CODING_AGENT_IMPORT_RETIRED",
};

async function rejectRetiredImport(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });

  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  }

  return NextResponse.json(RETIRED_RESPONSE, { status: 410 });
}

export async function POST(request: NextRequest) {
  return rejectRetiredImport(request);
}

export async function PUT(request: NextRequest) {
  return rejectRetiredImport(request);
}
