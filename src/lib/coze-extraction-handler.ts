import { runCozeCaptionWorkflow as callCozeWorkflow, detectCozeCaptionMode as detectMode, type CozeExtractMode as ExtractMode } from '@/lib/coze-workflow-client';
import { cozeCaptionResults, parseCozeWorkflowResult, CozeWorkflowExecutionError, cozeWorkflowFailure, type CozeWorkflowOutput, type CozeCaptionResult as CozeExtractResult } from "@/lib/coze-extraction-result";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { authorizeExtractionRequest } from "@/lib/extraction-auth";
import { deductCash } from "@/lib/billing";
import {
  ExtractionPricingConfigError,
  extractionTotalPrice,
  normalizeExtractionCount,
  requireConfiguredExtractionMoney,
} from "@/lib/extract-pricing";
import { recordRevenue } from "@/lib/revenue";
import { checkpointExtractionProviderResult } from "@/lib/extraction-exactly-once";
import { extractionProviderProblem, readableExtractionError } from "@/lib/extraction-provider-error";

/**
 * 扣子多功能文案提取 API
 *
 * 通过扣子工作流实现三种文案提取模式：
 * - 单视频模式：输入视频链接，提取口播文案
 * - 博主主页模式：输入博主主页链接，批量提取视频文案
 * - 搜索模式：输入关键词，搜索并批量提取视频文案
 *
 * 工作流统一入口参数：share_text, min_likes, max_count
 * 工作流自动识别模式：含/user/→主页，含/video/或http→单视频，纯文字→搜索
 */


// ============ 请求/响应类型 ============

interface CozeExtractRequest {
  /** 抖音分享文本（视频链接/博主主页链接/搜索关键词） */
  share_text: string;
  /** 最低点赞数阈值（0=不筛选，默认0） */
  min_likes?: number;
  /** 最大提取视频数量（默认10） */
  max_count?: number;
  /** 模式指定（video/homepage/search），空=自动识别 */
  mode?: string;
  /** 调用方生成并在重试时复用的稳定请求标识 */
  client_request_id?: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function resolveClientRequestId(
  request: NextRequest,
  body: CozeExtractRequest,
): { clientRequestId: string } | { response: NextResponse } {
  const headerValue = request.headers.get("Idempotency-Key")?.trim() || "";
  const bodyValue = typeof body.client_request_id === "string" ? body.client_request_id.trim() : "";
  if (headerValue && bodyValue && headerValue !== bodyValue) {
    return { response: NextResponse.json({ error: "幂等请求标识冲突" }, { status: 409 }) };
  }
  const clientRequestId = headerValue || bodyValue;
  if (!clientRequestId) {
    return { response: NextResponse.json({ error: "缺少 client_request_id 或 Idempotency-Key，本次未调用提取服务" }, { status: 400 }) };
  }
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    return { response: NextResponse.json({ error: "client_request_id 格式无效" }, { status: 400 }) };
  }
  return { clientRequestId };
}

// ============ 获取插件配置 ============

interface CozeMultifunctionConfig {
  apiUrl: string;
  apiToken: string;
  pricePerUse: number;
  costPrice: number;
  maxVideosPerBatch: number;
}

function configuredCozeEndpoint(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

async function getCozeMultifunctionConfig(): Promise<CozeMultifunctionConfig | null> {
  try {
    const supabase = getSupabaseClient();
    const { data: pluginRows, error: pluginError } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .eq("role", "coze_multifunction_extract")
      .eq("is_active", true)
      .limit(2);

    if (pluginError) throw new ExtractionPricingConfigError("文案提取插件价格配置暂时无法读取，本次未调用上游服务");
    if (Array.isArray(pluginRows) && pluginRows.length > 1) {
      throw new ExtractionPricingConfigError("检测到多个启用的三合一提取插件，请先在管理后台保留一个；本次未调用上游服务");
    }
    const pluginData = Array.isArray(pluginRows) ? pluginRows[0] : null;
    if (!pluginData) return null;

    const config = pluginData.config as Record<string, string>;
    const apiUrl = configuredCozeEndpoint(config.api_base_url);
    if (!apiUrl) {
      throw new ExtractionPricingConfigError("三合一提取插件地址配置无效，本次未调用上游服务");
    }
    return {
      apiUrl,
      apiToken: String(config.api_token || "").trim(),
      pricePerUse: requireConfiguredExtractionMoney(pluginData.price_per_use, "扣子文案提取售价"),
      costPrice: requireConfiguredExtractionMoney(pluginData.cost_price, "扣子文案提取成本"),
      maxVideosPerBatch: normalizeExtractionCount(Number(config.max_videos_per_batch), 30),
    };
  } catch (error) {
    console.error("[CozeExtract] 获取插件配置失败");
    if (error instanceof ExtractionPricingConfigError) throw error;
    throw new ExtractionPricingConfigError("文案提取插件价格配置暂时无法读取，本次未调用上游服务");
  }
}

// ============ 模式识别 ============

// ============ 格式化结果 ============

function formatResults(output: CozeWorkflowOutput, mode: ExtractMode): CozeExtractResult[] {
  return cozeCaptionResults(output, mode);
}

// Unknown workflow outcomes must be reconciled before any new provider request.

// ============ 主处理逻辑 ============

export async function handleCozeExtraction(request: NextRequest, options: { billingNamespace?: 'extract-coze' | 'extract-search' | 'extract-batch'; config?: CozeMultifunctionConfig } = {}) {
  try {
    // 鉴权
    const authorization = await authorizeExtractionRequest(request);
    if (!authorization.ok) return authorization.response;
    const userId = authorization.userId;
    const userRole = authorization.role;

    // 解析请求
    let body: CozeExtractRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "请求体解析失败" }, { status: 400 });
    }

    const requestIdentity = resolveClientRequestId(request, body);
    if ("response" in requestIdentity) return requestIdentity.response;
    const { clientRequestId } = requestIdentity;

    const { share_text, min_likes, max_count } = body;

    if (typeof share_text !== "string" || !share_text.trim()) {
      return NextResponse.json({ error: "请提供分享文本、链接或搜索关键词" }, { status: 400 });
    }

    // 读取插件配置
    const config = options.config || await getCozeMultifunctionConfig();
    if (!config || !config.apiUrl || !config.apiToken) {
      return NextResponse.json({
        error: "扣子多功能文案插件未配置完整，本次未调用上游服务",
        error_code: "EXTRACTION_PROVIDER_CONFIG_UNAVAILABLE",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 503 });
    }

    // 模式识别
    const requestedModes: Record<string, ExtractMode> = { video: "single_video", homepage: "creator_page", search: "search" };
    if (body.mode && !requestedModes[body.mode]) {
      return NextResponse.json({ error: "提取模式无效", provider_call_started: false }, { status: 400 });
    }
    const mode = requestedModes[body.mode || ""] || detectMode(share_text);
    const effectiveMaxCount = mode === "single_video" ? 1 : normalizeExtractionCount(max_count, 10, config.maxVideosPerBatch);
    const effectiveMinLikes = Number.isFinite(min_likes) && Number(min_likes) >= 0 ? Number(min_likes) : 0;

    console.log(`[CozeExtract] 模式: ${mode}, max_count: ${effectiveMaxCount}, min_likes: ${effectiveMinLikes}`);

    // 预检余额
    const estimatedCount = mode === "single_video" ? 1 : effectiveMaxCount;
    const estimatedCost = extractionTotalPrice(config.pricePerUse, estimatedCount);
    let extractCharged = false;

    if (estimatedCost > 0) {
      const supabase = getSupabaseClient();
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("cash_balance")
        .eq("id", userId)
        .single();

      if (userError || !userData) {
        return NextResponse.json({ error: "用户信息获取失败", provider_call_started: false }, { status: 500 });
      }

      if ((userData.cash_balance || 0) < estimatedCost) {
        return NextResponse.json({
          error: "现金余额不足，请先充值",
          required: estimatedCost,
          current: userData.cash_balance || 0,
        }, { status: 402 });
      }
    }

    // 调用扣子工作流
    let results: CozeExtractResult[];
    let workflowOutput: CozeWorkflowOutput | null = null;
    let effectiveMode = mode; // 可能被工作流纠正

    try {
      workflowOutput = await callCozeWorkflow(config, share_text.trim(), body.mode, effectiveMinLikes, effectiveMaxCount);
      results = formatResults(workflowOutput, mode).slice(0, effectiveMaxCount);
      // ★ 优先使用工作流返回的 mode（工作流可能纠正了模式识别）
      if (workflowOutput.mode) {
        const modeMap: Record<string, ExtractMode> = {
          video: "single_video",
          homepage: "creator_page",
          search: "search",
        };
        if (modeMap[workflowOutput.mode]) {
          effectiveMode = modeMap[workflowOutput.mode];
        }
      }
    } catch (workflowError) {
      console.error(`[CozeExtract] 工作流调用失败:`, workflowError instanceof Error ? workflowError.message : workflowError);

      return NextResponse.json({
        ...cozeWorkflowFailure(workflowError), mode, results: [],
      }, { status: 503 });
    }
    // Charge only validated, delivered captions, never an upstream aggregate.
    const successCount = results.filter(r => r.success && r.content?.trim()).length;
    const failCount = results.length - successCount;
    const providerProblem = successCount === 0 ? extractionProviderProblem([
      workflowOutput?.final_result || "",
      ...(workflowOutput?.captions || []).map(item => item.error || ""),
    ].join("\n")) : undefined;
    const failureMessage = (providerProblem ? `${providerProblem.message}本次未扣费。` : undefined) || "未提取到口播文案，本次未扣费。请检查链接是否可正常访问。";
    results = results.map(item => item.success ? item : ({
      ...item, error: readableExtractionError(item.error || "未提取到口播文案，请检查链接。", "text"),
    }));

    console.log(`[CozeExtract] 结果: 共 ${results.length} 条, 成功 ${successCount}, 失败 ${failCount}`);

    if (successCount > 0) {
      try {
        await checkpointExtractionProviderResult({ results, mode: effectiveMode, upstream_completed: true, source: "coze_workflow" });
      } catch {
        return NextResponse.json({ success: false, error: "提取正文暂未完成保存，原请求已保留，本次未扣费。", charged: false, billing_unknown: false, retry_safe: false, upstream_completed: true }, { status: 503 });
      }
    }

    // 扣费（仅对成功的条目收费）
    let billingReplayed = false;
    if (successCount > 0) {
      const totalCost = extractionTotalPrice(config.pricePerUse, successCount);
      try {
        const settlementKey = `${options.billingNamespace || "extract-coze"}:${clientRequestId}:charge`;
        if (totalCost > 0) {
          const deductResult = await deductCash(
            userId,
            totalCost,
            `扣子文案提取 ${successCount} 条 (${effectiveMode})`,
            settlementKey,
          );
          if (!deductResult.success) {
            return NextResponse.json({
              success: false,
              error: "提取已完成，费用正在确认。原请求已保留，请稍后刷新状态。",
              results,
              upstream_completed: true,
              provider_call_started: true,
              charged: null, billing_unknown: true, retry_safe: false,
            }, { status: 503 });
          }
          extractCharged = true;
          billingReplayed = Boolean(deductResult.alreadyFulfilled);
        }
        await recordRevenue({
          userId,
          userRole: userRole as "admin" | "student",
          modelId: "coze_multifunction_extract",
          taskId: settlementKey,
          costPrice: extractionTotalPrice(config.costPrice, successCount),
          sellingPrice: totalCost,
          recordType: "extract",
          cashCharged: totalCost,
        });
      } catch (e) {
        console.error("[CozeExtract] 结算异常:", e);
        return NextResponse.json({
          success: false,
          error: "提取已完成，账务正在确认。原请求已保留，请稍后用相同请求刷新状态。",
          results,
          upstream_completed: true,
          provider_call_started: true,
          charged: extractCharged ? true : null, billing_unknown: true, retry_safe: false,
        }, { status: 503 });
      }
    }

    // 返回结果
    const modeLabel = effectiveMode === "single_video" ? "单视频" : effectiveMode === "creator_page" ? "博主主页" : "搜索";

    return NextResponse.json({
      success: successCount > 0,
      message: successCount > 0
        ? `${modeLabel}文案提取完成，共 ${successCount} 条${failCount > 0 ? `，${failCount} 条失败` : ""}`
        : failureMessage,
      ...(successCount === 0 ? { error: failureMessage, code: providerProblem?.code || "EXTRACTION_NO_CONTENT" } : {}),
      upstream_completed: true,
      mode: effectiveMode,
      mode_label: modeLabel,
      results,
      final_result: successCount > 0 ? workflowOutput?.final_result || "" : failureMessage,
      summary: `共 ${results.length} 条，成功 ${successCount} 条，失败 ${failCount} 条`,
      charged: extractCharged,
      billing_replayed: billingReplayed,
      price: config.pricePerUse,
      total_cost: extractCharged ? extractionTotalPrice(config.pricePerUse, successCount) : 0,
    });
  } catch (error) {
    console.error("[CozeExtract API] Error:", readableExtractionError(error instanceof Error ? error.message : String(error), "text"));
    if (error instanceof ExtractionPricingConfigError) {
      return NextResponse.json({
        success: false,
        error: error.message,
        error_code: error.code,
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 503 });
    }
    return NextResponse.json(
      { error: readableExtractionError(error instanceof Error ? error.message : String(error), "text") },
      { status: 500 }
    );
  }
}



/** Legacy homepage/search endpoints retain their original request and wallet namespaces. */
export async function tryCozeMultiModeExtraction(request: NextRequest, input: {
  shareText: string; minLikes?: number; maxCount?: number; clientRequestId: string;
}, kind: 'batch' | 'search'): Promise<NextResponse> {
  let config: CozeMultifunctionConfig | null;
  try { config = await getCozeMultifunctionConfig(); }
  catch (error) { return NextResponse.json({ success: false, error: readableExtractionError(error instanceof Error ? error.message : '文案提取插件配置暂时无法读取，请稍后重试', 'text'), error_code: error instanceof ExtractionPricingConfigError ? error.code : 'EXTRACTION_PROVIDER_CONFIG_UNAVAILABLE', provider_call_started: false, charged: false, retry_safe: true }, { status: 503 }); }
  if (!config) {
    return NextResponse.json({
      success: false,
      error: "三合一提取插件未启用，本次未调用上游服务",
      error_code: "EXTRACTION_PROVIDER_CONFIG_UNAVAILABLE",
      provider_call_started: false,
      charged: false,
      retry_safe: true,
    }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('Content-Type', 'application/json');
  const mapped = new NextRequest(request.url, { method: 'POST', headers, body: JSON.stringify({
    share_text: input.shareText, min_likes: input.minLikes, max_count: input.maxCount,
    mode: kind === 'batch' ? 'homepage' : 'search', client_request_id: input.clientRequestId,
  }) });
  const response = await handleCozeExtraction(mapped, { config, billingNamespace: kind === 'batch' ? 'extract-batch' : 'extract-search' });
  const data = await response.json();
  const results: CozeExtractResult[] = Array.isArray(data.results) ? data.results : [];
  return NextResponse.json({ ...data, source: 'coze_workflow',
    texts: results.map((item, index) => ({ row: index + 1, col: 1, platform: '抖音', success: item.success,
      url: item.url, awemeId: item.url?.match(/\/video\/(\d+)/)?.[1], title: item.title, desc: item.title,
      content: item.success ? item.content || '' : '', corrected_content: item.success ? item.content || '' : '',
      caption: item.success ? item.content || '' : '', author: item.author, nickname: item.author,
      likes: item.likes, digg_count: item.likes, ...(item.success ? {} : { error: item.error || '未返回有效文案' }) })),
    filtered_count: results.length, success_count: results.filter(item => item.success).length,
  }, { status: response.status });
}
