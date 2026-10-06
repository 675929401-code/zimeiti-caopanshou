import { tryCozeMultiModeExtraction } from '@/lib/coze-extraction-handler';
/**
 * 关键词搜索批量提取文案 API
 * 路由: POST /api/extract/search
 * 功能: 通过关键词搜索抖音视频，按点赞数筛选后批量提取文案
 * 使用 Cyanlis douyin_video_search + douyin_video_to_text API
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeExtractionRequest } from "@/lib/extraction-auth";
import { deductCash } from "@/lib/billing";
import { configuredExtractionMoney, extractionTotalPrice, normalizeExtractionCount } from "@/lib/extract-pricing";
import { getDouyinVideoSearch, getDouyinVideoToText, type CyanlisConfig } from "@/lib/cyanlis-client";
import { recordRevenue } from "@/lib/revenue";
import { withExtractionExactlyOnce } from "@/lib/extraction-exactly-once";

export const maxDuration = 300;

interface SearchExtractRequest {
  keyword: string;
  likes_threshold?: number;
  max_count?: number;
  client_request_id?: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type SearchChannelConfig = {
  config: CyanlisConfig;
  pricePerUse: number;
  costPrice: number;
  maxCount: number;
  defaultLikesThreshold: number;
  role: string;
};

async function resolveSearchChannel(): Promise<SearchChannelConfig | { error: string }> {
  const supabase = getSupabaseClient();
  // 关键词搜索属于批量提取能力；仅当未配置专用渠道时，才允许复用启用的文案渠道。
  for (const role of ["extract_batch_third_party", "extract_text_third_party"]) {
    const { data, error } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .eq("role", role)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error) {
      return { error: `读取搜索提取插件失败：${error.message}` };
    }
    if (!data) continue;

    const rawConfig = (data.config || {}) as Record<string, string>;
    const provider = String(rawConfig.provider || "").trim().toLowerCase();
    if (provider !== "cyanlis") {
      return { error: `当前启用的${role === "extract_batch_third_party" ? "批量" : "文案"}提取渠道不支持关键词搜索，请启用 Cyanlis 渠道` };
    }
    const apiKey = String(rawConfig.api_key || "").trim();
    if (!apiKey) {
      return { error: "当前启用的 Cyanlis 搜索提取插件缺少 API Key" };
    }
    const pricePerUse = configuredExtractionMoney(data.price_per_use);
    const costPrice = configuredExtractionMoney(data.cost_price);
    if (pricePerUse === null || costPrice === null) {
      return { error: "当前启用的搜索提取渠道售价或成本缺失/无效，请先在管理后台明确配置；本次未调用上游服务" };
    }

    const configuredMax = Number.parseInt(rawConfig.max_videos_per_batch || "30", 10);
    const configuredThreshold = Number.parseInt(rawConfig.default_likes_threshold || "0", 10);
    return {
      config: {
        apiBaseUrl: rawConfig.api_base_url || "https://cyanlis.cn",
        apiKey,
        provider: "cyanlis",
      },
      pricePerUse,
      costPrice,
      maxCount: Number.isFinite(configuredMax) && configuredMax > 0 ? Math.min(configuredMax, 30) : 30,
      defaultLikesThreshold: Number.isFinite(configuredThreshold) && configuredThreshold >= 0 ? configuredThreshold : 0,
      role,
    };
  }

  return { error: "搜索提取插件未启用，请在管理后台启用 Cyanlis 批量提取渠道" };
}

function resolveClientRequestId(
  request: NextRequest,
  body: SearchExtractRequest,
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

async function handlePost(request: NextRequest) {
  // 1. 验证身份
  const authorization = await authorizeExtractionRequest(request);
  if (!authorization.ok) return authorization.response;
  const userId = authorization.userId;
  const userRole = authorization.role;

  // 2. 解析请求
  let body: SearchExtractRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体解析失败" }, { status: 400 });
  }

  const requestIdentity = resolveClientRequestId(request, body);
  if ("response" in requestIdentity) return requestIdentity.response;
  const { clientRequestId } = requestIdentity;

  const { keyword, likes_threshold, max_count } = body;

  if (!keyword?.trim()) {
    return NextResponse.json({ error: "请提供搜索关键词" }, { status: 400 });
  }

  const cozeResponse = await tryCozeMultiModeExtraction(request, { shareText: keyword.trim(), minLikes: likes_threshold, maxCount: max_count, clientRequestId }, 'search');
  if (cozeResponse) return cozeResponse;

  // 3. 获取后台明确启用的 Cyanlis 搜索渠道；不读取停用插件或其他角色的密钥。
  const searchChannel = await resolveSearchChannel();
  if ("error" in searchChannel) {
    return NextResponse.json({ error: searchChannel.error, provider_call_started: false }, { status: 503 });
  }
  const cyanlisConfig = searchChannel.config;

  const effectiveMaxCount = normalizeExtractionCount(max_count, 10, searchChannel.maxCount);
  const effectiveLikesThreshold = likes_threshold ?? searchChannel.defaultLikesThreshold;
  const pricePerUse = searchChannel.pricePerUse;

  // 4. 预检余额
  const supabase = getSupabaseClient();
  const estimatedCost = extractionTotalPrice(pricePerUse, effectiveMaxCount);
  if (estimatedCost > 0) {
    const { data: userData, error: balanceError } = await supabase
      .from("users")
      .select("cash_balance")
      .eq("id", userId)
      .single();
    if (balanceError || !userData) {
      return NextResponse.json({
        error: "余额服务暂不可用，本次未调用上游服务",
        error_code: "EXTRACTION_BALANCE_PRECHECK_UNAVAILABLE",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 503 });
    }
    const cashBalance = Number(userData?.cash_balance) || 0;
    if (cashBalance < estimatedCost) {
      return NextResponse.json({
        error: `余额不足，预估需要 ¥${estimatedCost.toFixed(2)}，当前余额 ¥${cashBalance.toFixed(2)}`,
        current_balance: cashBalance,
        estimated_cost: estimatedCost,
      }, { status: 402 });
    }
  }

  // 5. 搜索视频
  console.log(`[SearchExtract] keyword="${keyword}", threshold=${effectiveLikesThreshold}, max=${effectiveMaxCount}`);

  const searchResult = await getDouyinVideoSearch(
    cyanlisConfig,
    keyword.trim(),
    undefined, // cookie (not needed)
    undefined, // cursor (first page)
    0 // sortType=0 默认综合排序
  );

  if (!searchResult.success || !searchResult.results) {
    return NextResponse.json({
      error: searchResult.error || "搜索失败，请检查关键词或稍后再试",
    }, { status: 500 });
  }

  const videoList = searchResult.results.list || [];
  
  // 6. 筛选：按点赞数阈值过滤，排序
  const filteredVideos = videoList
    .filter(v => (v.digg_count || 0) >= effectiveLikesThreshold)
    .sort((a, b) => (b.digg_count || 0) - (a.digg_count || 0))
    .slice(0, effectiveMaxCount);

  console.log(`[SearchExtract] 搜索返回 ${videoList.length} 条，筛选后 ${filteredVideos.length} 条`);

  if (filteredVideos.length === 0) {
    return NextResponse.json({
      texts: [],
      filtered_count: 0,
      total_search_results: videoList.length,
      message: effectiveLikesThreshold > 0
        ? `搜索到 ${videoList.length} 个视频，但无视频满足点赞数 ≥ ${effectiveLikesThreshold} 的条件`
        : "搜索未找到相关视频",
    });
  }

  // 7. 逐条提取文案
  const texts: Array<{
    url: string;
    title: string;
    desc: string;
    caption: string;
    nickname: string;
    digg_count: number;
    error?: string;
  }> = [];

  let successCount = 0;

  for (const video of filteredVideos) {
    const videoUrl = video.video_url || `https://www.douyin.com/video/${video.aweme_id}`;
    
    try {
      // 使用 Cyanlis video_to_text API
      const textResult = await getDouyinVideoToText(cyanlisConfig, videoUrl);
      
      if (textResult.success && textResult.text) {
        texts.push({
          url: videoUrl,
          title: video.desc || textResult.text.substring(0, 50) + "...",
          desc: video.desc || "",
          caption: textResult.text,
          nickname: video.nickname || "",
          digg_count: video.digg_count || 0,
        });
        successCount++;
      } else {
        texts.push({
          url: videoUrl,
          title: video.desc || "",
          desc: video.desc || "",
          caption: video.desc || "", // 降级到视频描述
          nickname: video.nickname || "",
          digg_count: video.digg_count || 0,
          error: textResult.error || "文案提取失败",
        });
      }
    } catch {
      texts.push({
        url: videoUrl,
        title: video.desc || "",
        desc: video.desc || "",
        caption: video.desc || "",
        nickname: video.nickname || "",
        digg_count: video.digg_count || 0,
        error: "提取过程异常",
      });
    }
  }

  // 8. 扣费（仅对成功条目收费）
  let billingReplayed = false;
  const totalCost = extractionTotalPrice(pricePerUse, successCount);
  if (successCount > 0) {
    const settlementKey = `extract-search:${clientRequestId}:charge`;
    if (totalCost > 0) {
      const deductResult = await deductCash(
        userId,
        totalCost,
        `关键词搜索提取 ${successCount}条文案`,
        settlementKey,
      );
      if (!deductResult.success) {
        return NextResponse.json({
          success: false,
          error: `计费未完成: ${deductResult.error || "统一钱包暂不可用"}`,
          texts: [],
          upstream_completed: true,
          charged: false,
        }, { status: 503 });
      }
      billingReplayed = Boolean(deductResult.alreadyFulfilled);
    }
    try {
      await recordRevenue({
        userId,
        userRole: userRole as "admin" | "student",
        modelId: "search_extract",
        taskId: settlementKey,
        costPrice: extractionTotalPrice(searchChannel.costPrice, successCount),
        sellingPrice: totalCost,
        recordType: "extract",
        cashCharged: totalCost,
      });
    } catch (error) {
      console.error("[SearchExtract] 收益落账失败:", error);
      return NextResponse.json({
        success: false,
        error: "提取已完成，账务正在确认。原请求已保留，请稍后用相同请求刷新状态。",
        texts: [],
        upstream_completed: true,
        charged: totalCost > 0 ? true : false,
        billing_unknown: true,
        retry_safe: false,
      }, { status: 503 });
    }
  }

  return NextResponse.json({
    texts,
    filtered_count: filteredVideos.length,
    total_search_results: videoList.length,
    success_count: successCount,
    cost: totalCost,
    billing_replayed: billingReplayed,
    price: pricePerUse,
    channel: searchChannel.role,
    keyword,
  });
}

export const POST = withExtractionExactlyOnce("search", handlePost);
