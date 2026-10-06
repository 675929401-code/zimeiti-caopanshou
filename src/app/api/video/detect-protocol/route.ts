/**
 * 视频模型一键适配 API
 * POST - 自动检测API协议类型
 */
import { resolveVideoDetectionDraft } from "@/lib/model-endpoint";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { autoDetectVideoProtocol, getSupportedProtocols } from "@/lib/video-protocol-detector";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { assertAutodlH3SelfhostModelBinding } from "@/lib/autodl-h3-selfhost";

// GET - 获取支持的协议列表
export async function GET(req: NextRequest) {
  const authorization = await authorizeAdminCapability(req, "models.manage", {
    requireStepUp: true,
    operation: "video_protocol_catalog_read",
  });
  if (!authorization.ok) return authorization.response;

  return NextResponse.json({
    protocols: getSupportedProtocols(),
  });
}

// Read-only: drafts are checked without mutating the saved model.
export async function POST(req: NextRequest) {
  const authorization = await authorizeAdminCapability(req, "models.manage", {
    requireStepUp: true,
    operation: "video_protocol_detect",
  });
  if (!authorization.ok) return authorization.response;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch { return NextResponse.json({ error: "请求格式错误" }, { status: 400 }); }
  let stored: Record<string, unknown> | undefined;
  if (body.model_id) {
    if (typeof body.model_id !== "string") return NextResponse.json({ error: "模型 ID 格式错误" }, { status: 400 });
    const { data, error } = await getSupabaseAdminClient().from("video_models").select("api_endpoint,api_key,model_name,provider,protocol_type").eq("id", body.model_id).single();
    if (error || !data) return NextResponse.json({ error: "模型不存在或无法读取" }, { status: 404 });
    stored = data;
  }
  let draft: ReturnType<typeof resolveVideoDetectionDraft>;
  try { draft = resolveVideoDetectionDraft(body, stored); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "配置无效" }, { status: 400 }); }
  try {
    assertAutodlH3SelfhostModelBinding({ kind: "video", provider: draft.provider, protocolType: draft.protocolType,
      modelName: draft.modelName, apiEndpoint: draft.apiEndpoint, apiKey: draft.apiKey });
    draft.apiKey = resolveProviderSecret(draft.apiKey);
  } catch { return NextResponse.json({ error: "无法解析渠道密钥或渠道绑定不匹配，请检查后端密钥配置" }, { status: 400 }); }
  return NextResponse.json(await autoDetectVideoProtocol(draft));
}
