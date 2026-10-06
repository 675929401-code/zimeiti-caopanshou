/**
 * Read-only connection checks. These never issue a generation request or
 * activate a model, and a directory response is not a generation receipt.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { AUTODL_COMFYUI_WORKFLOW_PROTOCOL } from "@/lib/video-autodl-comfyui-workflow";
import { sanitizeVideoChannelError } from "@/lib/video-channel-health-circuit";

function result(body: Record<string, unknown>, status = 200) {
  return NextResponse.json({
    ...body, checkKind: "connection", generationVerified: false,
    healthUpdated: false, activationChanged: false,
  }, { status });
}

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  return payload?.role === "admin" ? payload : null;
}

function upstreamFailure(status: number, detail = "") {
  if (sanitizeVideoChannelError(detail).code === "UPSTREAM_QUOTA_OR_BALANCE") {
    return result({
      success: true,
      connectionOk: true,
      status,
      diagnosticCode: "UPSTREAM_BALANCE",
      fundingRequired: true,
      message: "接口连接正常，上游余额或额度不足；配置保持启用，充值后可直接继续使用。",
    });
  }
  const error = status === 401 || status === 403
    ? "上游鉴权未通过，请检查凭据和权限。"
    : status === 404 ? "连接检查端点不存在，不能据此确认此型号可用。"
      : status === 429 ? "上游暂时限制请求，请稍后重试。"
        : "上游连接检查失败（HTTP " + status + "）。";
  return result({ success: false, connectionOk: false, status, error });
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) return result({ success: false, error: "无权限" }, 403);
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_BODY");
    input = parsed as Record<string, unknown>;
  } catch {
    return result({ success: false, code: "INVALID_REQUEST", error: "请求参数不是有效 JSON 对象" }, 400);
  }
  let endpoint = typeof input.api_endpoint === "string" ? input.api_endpoint : "";
  let key = typeof input.api_key === "string" ? input.api_key : "";
  let protocol = typeof input.protocol_type === "string" ? input.protocol_type : "";
  let targetModel = typeof input.model_name === "string" ? input.model_name.trim() : "";
  let config = input.api_protocol_config && typeof input.api_protocol_config === "object"
    ? input.api_protocol_config as Record<string, unknown> : {};
  if (input.model_id) {
    if (typeof input.model_id !== "string") return result({ success: false, error: "模型编号无效" }, 400);
    const { data, error } = await getSupabaseAdminClient().from("video_models")
      .select("id,api_endpoint,api_key,protocol_type,model_name,api_protocol_config").eq("id", input.model_id).maybeSingle();
    if (error) return result({ success: false, code: "MODEL_LOOKUP_FAILED", error: "暂时无法读取所选模型配置" }, 503);
    if (!data) return result({ success: false, code: "MODEL_NOT_FOUND", error: "模型不存在" }, 404);
    endpoint = String(data.api_endpoint || "");
    key = String(data.api_key || "");
    protocol = String(data.protocol_type || "");
    targetModel = String(data.model_name || "").trim();
    config = data.api_protocol_config && typeof data.api_protocol_config === "object" ? data.api_protocol_config : {};
  }
  try { key = resolveProviderSecret(key); }
  catch { return result({ success: false, code: "PROVIDER_SECRET_UNAVAILABLE", error: "无法读取所选配置的 API 凭据" }, 400); }
  if (!endpoint || !key) return result({ success: false, error: "API 地址和凭据必填" }, 400);

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
    if (!["http:", "https:"].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password) throw new Error("INVALID_ENDPOINT");
  } catch {
    return result({ success: false, code: "INVALID_ENDPOINT", error: "API 地址格式无效" }, 400);
  }
  try {
    if (protocol === "autodl_comfyui_h3" || protocol === AUTODL_COMFYUI_WORKFLOW_PROTOCOL) {
      const workflowId = String(config.workflow_id || targetModel || "minimax_h3_image_audio_to_video_v2");
      const metadata = await fetch(parsedEndpoint.origin + "/api/v1/comfyui/workflows/" + encodeURIComponent(workflowId), { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!metadata.ok) return upstreamFailure(metadata.status, await metadata.text().catch(() => ""));
      const auth = await fetch(parsedEndpoint.origin + "/api/v1/comfyui/comfyui_workflow/result/codex_readonly_probe", {
        method: "GET", headers: { Authorization: key, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      if (!auth.ok && auth.status !== 404) return upstreamFailure(auth.status, await auth.text().catch(() => ""));
      return result({ success: true, connectionOk: true, modelListed: null, workflowFound: true, message: "工作流目录连接检查通过；真实生成尚未验证。" });
    }

    let testUrl: string;
    let testHeaders: Record<string, string> = { Authorization: "Bearer " + key };
    if (protocol.includes("siliconflow")) testUrl = "https://api.siliconflow.cn/v1/models";
    else if (protocol === "runway") {
      testUrl = "https://api.dev.runwayml.com/v1/models";
      testHeaders["X-Runway-Version"] = "2024-11-06";
    } else if (protocol === "replicate") {
      testUrl = "https://api.replicate.com/v1/models";
      testHeaders = { Authorization: "Token " + key };
    } else {
      const basePath = parsedEndpoint.pathname.replace(/\/v1(?:\/.*)?$/, "").replace(/\/+$/, "");
      testUrl = parsedEndpoint.origin + basePath + "/v1/models";
    }
    const response = await fetch(testUrl, { method: "GET", headers: testHeaders, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return upstreamFailure(response.status, await response.text().catch(() => ""));
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return result({ success: false, connectionOk: true, status: response.status, code: "INVALID_MODEL_DIRECTORY", error: "连接有响应，但未返回有效模型目录。" });
    const data = (body as { data?: unknown }).data;
    const recognized = Array.isArray(data);
    const identifiers = recognized ? data.flatMap((item: unknown) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") return [(item as { id: string }).id];
      return [];
    }) : [];
    const modelListed = targetModel && recognized ? identifiers.includes(targetModel) : null;
    if (modelListed === false) return result({
      success: false, connectionOk: true, modelListed, modelCount: identifiers.length, status: response.status,
      error: "连接正常，但目录未列出所选型号；真实生成尚未验证。",
    });
    return result({
      success: true, connectionOk: true, modelListed, modelCount: identifiers.length, status: response.status,
      message: modelListed ? "连接检查通过，目录包含所选型号；真实生成尚未验证。" : "连接检查通过；目录不能确认所选型号，真实生成尚未验证。",
    });
  } catch (error) {
    return result({
      success: false, connectionOk: false,
      code: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "CONNECTION_TIMEOUT" : "CONNECTION_FAILED",
      error: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "连接检查超时，请稍后重试。" : "连接检查失败，请检查接口地址与网络。",
    });
  }
}
