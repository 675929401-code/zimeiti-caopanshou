import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { NativeAgentRuntimeConfigError, readNativeAgentRuntimeConfig, saveNativeAgentRuntimeConfig } from "@/lib/server/native-agent-runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  if (error instanceof NativeAgentRuntimeConfigError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
  return NextResponse.json({ ok: false, code: "NATIVE_AGENT_RUNTIME_UNAVAILABLE", error: "原生智能体运行配置暂时不可用，请稍后重新读取" }, { status: 503, headers });
}
export async function GET(request: NextRequest) {
  const auth = await authorizeAdminCapability(request, "models.view", { requireStepUp: false, operation: "native_agent_runtime_read" });
  if (!auth.ok) return auth.response;
  try { return NextResponse.json({ ok: true, ...(await readNativeAgentRuntimeConfig(getSupabaseAdminClient())) }, { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const auth = await authorizeAdminCapability(request, "models.manage", { requireStepUp: true, operation: "native_agent_runtime_save", auditAllowed: true });
  if (!auth.ok) return auth.response;
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 16_384) return NextResponse.json({ ok: false, code: "NATIVE_AGENT_RUNTIME_INPUT_TOO_LARGE", error: "配置内容超出大小限制" }, { status: 413, headers });
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 16_384) return NextResponse.json({ ok: false, code: "NATIVE_AGENT_RUNTIME_INPUT_TOO_LARGE", error: "配置内容超出大小限制" }, { status: 413, headers });
    let input: unknown;
    try { input = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, code: "NATIVE_AGENT_RUNTIME_INPUT_INVALID", error: "配置必须为有效 JSON" }, { status: 400, headers }); }
    return NextResponse.json({ ok: true, ...(await saveNativeAgentRuntimeConfig(getSupabaseAdminClient(), auth.actor.userId, input)) }, { headers });
  } catch (error) { return failure(error); }
}
