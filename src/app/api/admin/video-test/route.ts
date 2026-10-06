/**
 * 视频模型连通性测试 API
 * POST - 测试指定模型的API是否可用
 * 默认只执行 GET /v1/models 无费用契约检查。
 * 只有管理员显式传 allowPaidProbe=true 时才允许降级到真实提交。
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { buildOpenAIEndpoint } from "@/lib/api-endpoints";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { AUTODL_COMFYUI_WORKFLOW_PROTOCOL } from "@/lib/video-autodl-comfyui-workflow";
import { sanitizeVideoChannelError } from "@/lib/video-channel-health-circuit";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const { modelId, allowPaidProbe = false } = await req.json();
  if (!modelId) return NextResponse.json({ error: "缺少模型ID" }, { status: 400 });

  // 从数据库读取模型配置
  const supabase = getSupabaseAdminClient();
  const { data: model, error } = await supabase
    .from("video_models")
    .select("*")
    .eq("id", modelId)
    .single();

  if (error || !model) {
    return NextResponse.json({ error: "模型不存在" }, { status: 404 });
  }

  const result = await testModelConnection(model, allowPaidProbe === true);

  // 将测试结果持久化到模型记录
  const now = new Date().toLocaleString("zh-CN");
  if (result.success) {
    if (result.isQuotaIssue) {
      await supabase
        .from("video_models")
        .update({
          admin_notes: `⚠️ 余额不足(${now}) 充值后即可使用`,
          last_tested_at: new Date().toISOString(),
        })
        .eq("id", modelId);
    } else {
      await supabase
        .from("video_models")
        .update(result.paidProbeUsed
          ? {
              admin_notes: `ℹ️ 显式真实提交已受理(${now}) 延迟${result.latency}ms；不等于终态成功或结果已持久化`,
              last_tested_at: new Date().toISOString(),
            }
          : {
              // GET /v1/models 只证明认证和模型映射，不能覆盖最近一次真实生成的
              // quota / 503 / render failure 诊断。
              last_tested_at: new Date().toISOString(),
            })
        .eq("id", modelId);
      // 连通或提交被受理都不足以发布模型。新模型只能由独立验收激活通道
      // 在读取完整、已持久化证据后启用和解隐藏。
      result.activationRequired = model.is_active !== true;
    }
  } else {
    await supabase
      .from("video_models")
      .update({
        admin_notes: `❌ ${result.message}(${now})`,
        last_tested_at: new Date().toISOString(),
      })
      .eq("id", modelId);
  }

  return NextResponse.json(result);
}

interface ModelRecord {
  id: string;
  name: string;
  model_name: string;
  api_endpoint: string;
  api_key: string;
  protocol_type: string;
}

interface TestResult {
  success: boolean;
  message: string;
  details?: string;
  activationRequired?: boolean;
  latency?: number;
  isQuotaIssue?: boolean;
  diagnosticCode?: string;
  paidProbeUsed?: boolean;
}

/**
 * 从 api_endpoint 提取 baseUrl（去掉 /v1/xxx 或 /v1 路径部分）
 */
function extractBaseUrl(endpoint: string): string {
  return endpoint.replace(/\/v1(?:\/.*)?$/, "").replace(/\/+$/, "");
}

/**
 * 第一步：轻量级测试 - GET /v1/models 验证密钥有效性
 * 绝大多数中转站都支持此端点，且不消耗配额
 */
async function lightweightTest(baseUrl: string, apiKey: string, targetModel?: string): Promise<TestResult & { modelFound?: boolean }> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency = Date.now() - startTime;

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Several relays return account arrears as HTTP 401/403. Inspect the
      // provider body before treating the status as an invalid credential.
      if (isQuotaError(text)) {
        return { success: true, message: "API连通正常，但上游余额不足", latency, isQuotaIssue: true, diagnosticCode: "UPSTREAM_BALANCE", paidProbeUsed: false };
      }
      // 401 = 密钥无效
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, message: "API密钥无效或已过期", details: text.slice(0, 200), latency };
      }
      // 404 = 端点不支持（不是所有平台都有/v1/models）
      if (resp.status === 404) {
        return { success: false, message: "NOT_SUPPORTED", latency };
      }
      // 其他错误 → 降级
      return { success: false, message: "NOT_SUPPORTED", details: `HTTP ${resp.status}`, latency };
    }

    const data = await resp.json().catch(() => ({ data: [] }));
    const models: { id: string }[] = data.data || data.models || [];

    // 检查目标模型是否在列表中
    let modelFound = true;
    if (targetModel && models.length > 0) {
      modelFound = models.some(m => m.id === targetModel);
    }

    return { success: true, message: "API连通正常", latency, modelFound };
  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    const errMsg = String(err);
    if (errMsg.includes("abort") || errMsg.includes("timeout")) {
      return { success: false, message: "NOT_SUPPORTED", latency };
    }
    if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ENOTFOUND")) {
      return { success: false, message: "连接被拒绝，服务器不可达", details: errMsg, latency };
    }
    // 网络错误也降级
    return { success: false, message: "NOT_SUPPORTED", details: errMsg.slice(0, 200), latency };
  }
}

async function autoDLReadOnlyTest(model: ModelRecord): Promise<TestResult> {
  const startedAt = Date.now();
  let apiKey = "";
  try {
    apiKey = resolveProviderSecret(model.api_key);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "无法读取本地 ComfyUI Token", paidProbeUsed: false };
  }
  let origin = "https://www.autodl.art";
  try { origin = new URL(model.api_endpoint).origin; } catch {}
  const workflowId = model.model_name || "minimax_h3_image_audio_to_video_v2";
  try {
    const [metadataResp, probeResp] = await Promise.all([
      fetch(`${origin}/api/v1/comfyui/workflows/${encodeURIComponent(workflowId)}`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${origin}/api/v1/comfyui/comfyui_workflow/result/codex_readonly_probe`, {
        method: "GET",
        headers: { Authorization: apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    const latency = Date.now() - startedAt;
    if (probeResp.status === 401 || probeResp.status === 403) {
      return { success: false, message: "ComfyUI 分组 Token 无效或已过期", latency, diagnosticCode: "AUTODL_TOKEN_INVALID", paidProbeUsed: false };
    }
    if (!metadataResp.ok) {
      return { success: false, message: `AutoDL 工作流不存在或元数据不可用 (HTTP ${metadataResp.status})`, latency, diagnosticCode: "AUTODL_WORKFLOW_UNAVAILABLE", paidProbeUsed: false };
    }
    return {
      success: true,
      message: "AutoDL H3 只读契约与 Token 鉴权通过（未提交付费任务）",
      latency,
      diagnosticCode: "AUTODL_READONLY_CONTRACT_OK",
      paidProbeUsed: false,
    };
  } catch (error) {
    return { success: false, message: "AutoDL 只读检查网络失败", details: error instanceof Error ? error.message : "网络错误", latency: Date.now() - startedAt, paidProbeUsed: false };
  }
}

/**
 * 第二步：降级测试 - 实际提交请求验证
 */
async function submissionTest(model: ModelRecord): Promise<TestResult> {
  const startTime = Date.now();
  const baseUrl = extractBaseUrl(model.api_endpoint);

  let testUrl: string;
  let testBody: Record<string, unknown>;
  let testHeaders: Record<string, string>;

  if (model.protocol_type === "kling_official") {
    const baseEndpoint = model.api_endpoint.replace(/\/kling\/.*$/, "").replace(/\/v1\/.*$/, "");
    testUrl = `${baseEndpoint}/kling/v1/videos/text2video`;
    testBody = { prompt: "test connectivity", cfg_scale: 0.5, mode: "std", duration: "5", aspect_ratio: "16:9" };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json" };
  } else if (model.protocol_type === "veo_newapi") {
    testUrl = `${baseUrl}/v1/videos`;
    testBody = { model: model.model_name, prompt: "test connectivity", size: "1280x720", duration: 8, retry_times: 1 };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json", "Accept": "application/json" };
  } else if (model.protocol_type === "yunwu_video") {
    testUrl = `${baseUrl}/v1/video/create`;
    testBody = { model: model.model_name, prompt: "test connectivity", aspect_ratio: "3:2", size: "720P", images: [] };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json", "Accept": "application/json" };
  } else if (model.protocol_type === "secure_skill_grok_video") {
    testUrl = buildOpenAIEndpoint(model.api_endpoint, "videos");
    testBody = { model: model.model_name, prompt: "test connectivity", seconds: 5, size: "1280x720", resolution: "720p" };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json", "Accept": "application/json" };
  } else if (model.protocol_type === "gaorui_video") {
    testUrl = `${baseUrl}/v1/videos`;
    testBody = { model: model.model_name, prompt: "test connectivity", aspect_ratio: "16:9", seconds: 8, quality: "standard" };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json" };
  } else if (model.protocol_type === "newapi_video") {
    testUrl = `${baseUrl}/v1/videos`;
    testBody = { model: model.model_name, prompt: "test connectivity", size: "1280x720", duration: 8, retry_times: 1 };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json", "Accept": "application/json" };
  } else if (model.protocol_type === "grok_video") {
    // 防止 /v1 双重拼接
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    testUrl = /\/v\d+$/.test(normalizedBaseUrl)
      ? `${normalizedBaseUrl}/chat/completions`
      : `${normalizedBaseUrl}/v1/chat/completions`;
    testBody = { model: model.model_name, messages: [{ role: "user", content: "test connectivity" }], stream: false };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json" };
  } else {
    // 防止 /v1 双重拼接
    const normalizedBaseUrl2 = baseUrl.replace(/\/+$/, "");
    testUrl = /\/v\d+$/.test(normalizedBaseUrl2)
      ? `${normalizedBaseUrl2}/chat/completions`
      : `${normalizedBaseUrl2}/v1/chat/completions`;
    testBody = { model: model.model_name, messages: [{ role: "user", content: "test connectivity" }], stream: false };
    testHeaders = { "Authorization": `Bearer ${model.api_key}`, "Content-Type": "application/json" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(testUrl, {
      method: "POST",
      headers: testHeaders,
      body: JSON.stringify(testBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latency = Date.now() - startTime;

    const respText = await resp.text();
    let respData: Record<string, unknown>;
    try {
      respData = JSON.parse(respText);
    } catch {
      return {
        success: false,
        message: `HTTP ${resp.status} - 响应非JSON格式`,
        details: respText.slice(0, 300),
        latency,
      };
    }

    // 判断结果
    if (resp.ok) {
      const errObj = respData.error as Record<string, unknown> | undefined;
      if (errObj?.message) {
        const errMsg = String(errObj.message);
        if (isQuotaError(errMsg)) {
          return { success: true, message: "API连通正常，但上游余额不足", details: errMsg.slice(0, 300), latency, isQuotaIssue: true };
        }
        return { success: false, message: classifyError(errMsg), details: errMsg.slice(0, 300), latency };
      }

      // 有task_id = 视频提交成功
      const hasTask = respData.id || respData.task_id || (respData.generated_assets as Record<string, unknown>)?.task_id;
      if (hasTask) {
        return { success: true, message: "API连通正常，视频任务提交成功", details: `task_id: ${String(hasTask)}`, latency };
      }

      // 普通chat响应也算连通
      const choices = respData.choices as Record<string, unknown>[] | undefined;
      if (choices?.length) {
        return { success: true, message: "API连通正常", latency };
      }

      return { success: true, message: "API返回200，连通正常", details: respText.slice(0, 200), latency };
    } else {
      const errObj = respData.error as Record<string, unknown> | undefined;
      const errMsg = errObj?.message ? String(errObj.message) : respText.slice(0, 200);

      if (isQuotaError(errMsg)) {
        return { success: true, message: "API连通正常，但上游余额不足", details: errMsg.slice(0, 300), latency, isQuotaIssue: true };
      }

      return { success: false, message: `HTTP ${resp.status} - ${classifyError(errMsg)}`, details: errMsg.slice(0, 300), latency };
    }
  } catch (err) {
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    const errMsg = String(err);

    if (errMsg.includes("abort") || errMsg.includes("timeout")) {
      return { success: false, message: "提交测试超时（30秒无响应），但密钥可能有效，请尝试轻量级测试", details: "上游响应慢，不代表API不可用", latency };
    }

    return { success: false, message: "网络错误", details: errMsg.slice(0, 300), latency };
  }
}

async function testModelConnection(model: ModelRecord, allowPaidProbe: boolean): Promise<TestResult> {
  if (model.protocol_type === "autodl_comfyui_h3" || model.protocol_type === AUTODL_COMFYUI_WORKFLOW_PROTOCOL) {
    return autoDLReadOnlyTest(model);
  }
  const paidProbePermitted = allowPaidProbe && model.protocol_type !== "autodl_h3_selfhost";
  try {
    model = { ...model, api_key: resolveProviderSecret(model.api_key) };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "无法读取模型密钥", paidProbeUsed: false };
  }
  const baseUrl = extractBaseUrl(model.api_endpoint);

  // 第一步：轻量级测试 GET /v1/models
  const lwResult = await lightweightTest(baseUrl, model.api_key, model.model_name);

  // 密钥和服务可达不等于目标模型可用；必须验证模型确实出现在认证后的清单中。
  if (lwResult.success) {
    if (lwResult.modelFound === false) {
      return {
        success: false,
        message: "密钥有效，但目标模型未在当前密钥的模型清单中",
        details: `缺失模型映射: ${model.model_name}`,
        latency: lwResult.latency,
        isQuotaIssue: false,
        diagnosticCode: "MODEL_NOT_LISTED_FOR_KEY",
        paidProbeUsed: false,
      };
    }
    return {
      success: true,
      message: "密钥有效，目标模型映射存在，API连通正常",
      latency: lwResult.latency,
      isQuotaIssue: false,
      diagnosticCode: "CONTRACT_OK",
      paidProbeUsed: false,
    };
  }

  // 轻量端点不支持时，默认停止，避免“连通性测试”暗中创建计费视频任务。
  if (lwResult.message === "NOT_SUPPORTED") {
    if (!paidProbePermitted) {
      return {
        success: false,
        message: "服务可达，但不支持无费用模型清单检查；未提交计费测试",
        details: lwResult.details,
        latency: lwResult.latency,
        diagnosticCode: "FREE_CONTRACT_CHECK_UNSUPPORTED",
        paidProbeUsed: false,
      };
    }
    const submissionResult = await submissionTest(model);
    return { ...submissionResult, paidProbeUsed: true };
  }

  // 轻量级测试返回真正的错误（密钥无效、连接被拒等）
  return lwResult;
}

function isQuotaError(errMsg: string): boolean {
  return sanitizeVideoChannelError(errMsg).code === "UPSTREAM_QUOTA_OR_BALANCE";
}

function classifyError(errMsg: string): string {
  const lower = errMsg.toLowerCase();
  if ((lower.includes("invalid") && lower.includes("key")) || (lower.includes("invalid") && lower.includes("token")) || lower.includes("unauthorized") || lower.includes("authentication")) return "API密钥无效或已过期";
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) return "上游限流，请稍后重试";
  if ((lower.includes("model") && lower.includes("not found")) || lower.includes("model_not_exist")) return "模型不存在";
  if (lower.includes("server") && lower.includes("error") || lower.includes("500") || lower.includes("internal")) return "上游服务器错误";
  if (lower.includes("timeout") || lower.includes("timed out")) return "上游处理超时";
  if (lower.includes("overload") || lower.includes("capacity")) return "上游过载";
  if (lower.includes("billing") || lower.includes("insufficient") || lower.includes("余额") || lower.includes("balance")) return "上游余额不足";
  return errMsg.slice(0, 100);
}
