/**
 * 生图模型无费用契约检查。
 * 仅 GET /v1/models；绝不提交 images/generations 或 chat/completions。
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { buildOpenAIEndpoint } from "@/lib/api-endpoints";
import { resolveProviderSecret } from "@/lib/provider-secret";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  return payload?.role === "admin" ? payload : null;
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const { modelId } = await request.json().catch(() => ({})) as { modelId?: string };
  if (!modelId) return NextResponse.json({ error: "缺少模型ID" }, { status: 400 });

  const supabase = getSupabaseAdminClient();
  const { data: model, error } = await supabase
    .from("cover_models")
    .select("id, name, model_name, provider, api_endpoint, api_key")
    .eq("id", modelId)
    .single();
  if (error || !model) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  let apiKey = "";
  try {
    apiKey = resolveProviderSecret(model.api_key);
  } catch (secretError) {
    return NextResponse.json({
      success: false,
      message: secretError instanceof Error ? secretError.message : "无法读取模型密钥",
      paidProbeUsed: false,
    });
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(buildOpenAIEndpoint(model.api_endpoint, "models"), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latency = Date.now() - startedAt;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return NextResponse.json({
        success: false,
        message: response.status === 401 || response.status === 403 ? "API密钥无效或已过期" : `模型清单检查失败 (${response.status})`,
        latency,
        paidProbeUsed: false,
      });
    }
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const found = rows.some((row) => row?.id === model.model_name);
    return NextResponse.json({
      success: found,
      message: found ? "密钥有效，目标生图模型映射存在，API连通正常" : "密钥有效，但目标生图模型不在模型清单中",
      latency,
      diagnosticCode: found ? "CONTRACT_OK" : "MODEL_NOT_LISTED_FOR_KEY",
      paidProbeUsed: false,
    });
  } catch (requestError) {
    return NextResponse.json({
      success: false,
      message: requestError instanceof Error && requestError.name === "TimeoutError" ? "模型清单检查超时" : "模型清单检查网络错误",
      latency: Date.now() - startedAt,
      paidProbeUsed: false,
    });
  }
}
