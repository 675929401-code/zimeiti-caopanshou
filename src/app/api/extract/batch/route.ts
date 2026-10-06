import { tryCozeMultiModeExtraction } from '@/lib/coze-extraction-handler';
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { authorizeExtractionRequest } from "@/lib/extraction-auth";
import { deductCash } from "@/lib/billing";
import { ExtractionPricingConfigError, extractionTotalPrice, normalizeExtractionCount, requireConfiguredExtractionMoney } from "@/lib/extract-pricing";
import { recordRevenue } from "@/lib/revenue";
import { getDouyinUserPostsLite, getDouyinVideoToText, getDouyinVideoDetail, type CyanlisConfig } from "@/lib/cyanlis-client";
import { cacheExtractVideoForProvider } from "@/lib/extract-local-video-cache";
import { withExtractionExactlyOnce } from "@/lib/extraction-exactly-once";

/**
 * 批量文案提取 API — 博主主页模式
 *
 * 输入：博主主页链接 + 筛选条件
 * ★ 渠道优先级：
 *   1. Cyanlis渠道（provider=cyanlis）：user_posts_lite获取视频列表 + video_to_text提取文案（无需cookie）
 *   2. douyin.wtf + ASR/LLM 兜底
 * 输出：筛选后的视频文案列表
 */

export const maxDuration = 300; // 批量提取可能需要较长时间

// ============ 请求/响应类型 ============

interface BatchExtractRequest {
  /** 抖音博主主页链接（完整URL或分享文本） */
  creator_url: string;
  /** 点赞数阈值（最低点赞数，低于此值的视频跳过） */
  likes_threshold?: number;
  /** 最大提取数量 */
  max_count?: number;
  /** 调用方生成并在重试时复用的稳定请求标识 */
  client_request_id?: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function resolveClientRequestId(
  request: NextRequest,
  body: BatchExtractRequest,
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

interface CreatorVideo {
  awemeId: string;
  desc: string;
  author: string;
  coverUrl: string;
  videoUrl: string;
  likes: number;
  comments: number;
  shares: number;
  createTime: number;
  duration?: number;
}

interface BatchTextResult {
  row: number;
  awemeId: string;
  title: string;
  author: string;
  likes: number;
  success: boolean;
  content?: string;
  error?: string;
  source?: string;
}

// ============ 主页链接解析 ============

/** 从用户输入中提取 sec_user_id */
function parseCreatorUrl(input: string): { secUserId: string; source: "full_url" | "short_url" } | null {
  const text = input.trim();

  // Pattern 1: 完整主页链接 https://www.douyin.com/user/MS4wLjABAAAA...
  const fullMatch = text.match(/https?:\/\/www\.douyin\.com\/user\/(MS4wLjAB[A-Za-z0-9_-]+)/);
  if (fullMatch) {
    return { secUserId: fullMatch[1], source: "full_url" };
  }

  // Pattern 2: 短链接（需要服务端解析获取 sec_user_id）
  const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
  if (shortMatch) {
    return { secUserId: shortMatch[0].replace(/\/$/, ""), source: "short_url" };
  }

  // Pattern 3: 直接输入 sec_user_id（MS4wLjAB 开头）
  if (/^MS4wLjAB[A-Za-z0-9_-]+$/.test(text)) {
    return { secUserId: text, source: "full_url" };
  }

  return null;
}

/** 解析抖音短链接获取 sec_user_id */
async function resolveCreatorShortUrl(shortUrl: string): Promise<string | null> {
  try {
    console.log(`[BatchExtract] 解析博主短链接: ${shortUrl}`);
    const response = await fetch(shortUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });

    // 从重定向 URL 中提取 sec_user_id
    // 格式1: /user/MS4wLjAB... 格式2: sec_uid=MS4wLjAB...
    const extractSecUid = (url: string): string | null => {
      const pathMatch = url.match(/\/user\/(MS4wLjAB[A-Za-z0-9_-]+)/);
      if (pathMatch) return pathMatch[1];
      const paramMatch = url.match(/sec_uid=(MS4wLjAB[A-Za-z0-9_-]+)/);
      if (paramMatch) return paramMatch[1];
      return null;
    };

    // 跟踪重定向
    const location = response.headers.get("location");
    if (location) {
      const secUid = extractSecUid(location);
      if (secUid) {
        console.log(`[BatchExtract] 从重定向获取sec_user_id: ${secUid}`);
        return secUid;
      }
      // 继续跟踪重定向
      const response2 = await fetch(location, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
        },
        signal: AbortSignal.timeout(15000),
      });
      const location2 = response2.headers.get("location") || "";
      const secUid2 = extractSecUid(location2);
      if (secUid2) {
        console.log(`[BatchExtract] 从二级重定向获取sec_user_id: ${secUid2}`);
        return secUid2;
      }
    }

    console.log(`[BatchExtract] 短链接解析未获取到sec_user_id`);
    return null;
  } catch (error) {
    console.error(`[BatchExtract] 短链接解析异常:`, error);
    return null;
  }
}

// ============ 获取博主视频列表 ============

/** 通过 douyin.wtf API 获取博主视频列表 */
async function fetchCreatorVideosViaWtf(secUserId: string, count: number, cursor: number = 0): Promise<{ videos: CreatorVideo[]; hasMore: boolean; nextCursor: number } | null> {
  try {
    const apiUrl = `https://douyin.wtf/api/douyin/web/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUserId)}&max_cursor=${cursor}&count=${count}`;
    console.log(`[BatchExtract] 调用 douyin.wtf 用户视频API: ${apiUrl.substring(0, 150)}`);

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[BatchExtract] douyin.wtf 用户视频API返回 ${response.status}`);
      return null;
    }

    const json = await response.json() as {
      code?: number;
      status_code?: number;
      data?: {
        aweme_list?: Array<{
          aweme_id: string;
          desc: string;
          author?: { nickname?: string; uid?: string };
          video?: {
            play_addr?: { url_list: string[] };
            cover?: { url_list: string[] };
          };
          statistics?: {
            digg_count: number;
            comment_count: number;
            share_count: number;
          };
          create_time?: number;
        }>;
        has_more?: boolean;
        max_cursor?: number;
      };
    };

    // douyin.wtf 可能返回 code 或 status_code
    const code = json.code ?? json.status_code;
    if (code !== 200 && code !== 0) {
      console.error(`[BatchExtract] douyin.wtf 用户视频API失败: code=${code}`);
      return null;
    }

    const awemeList = json.data?.aweme_list || [];
    if (awemeList.length === 0) {
      console.log(`[BatchExtract] douyin.wtf 返回空视频列表`);
      return { videos: [], hasMore: false, nextCursor: 0 };
    }

    const videos: CreatorVideo[] = awemeList.map(item => ({
      awemeId: item.aweme_id,
      desc: item.desc || "",
      author: item.author?.nickname || "",
      coverUrl: item.video?.cover?.url_list?.[0] || "",
      videoUrl: item.video?.play_addr?.url_list?.[0] || "",
      likes: item.statistics?.digg_count || 0,
      comments: item.statistics?.comment_count || 0,
      shares: item.statistics?.share_count || 0,
      createTime: item.create_time || 0,
    }));

    return {
      videos,
      hasMore: json.data?.has_more || false,
      nextCursor: json.data?.max_cursor || 0,
    };
  } catch (error) {
    console.error(`[BatchExtract] douyin.wtf 用户视频API异常:`, error);
    return null;
  }
}

/** 获取博主视频列表（多源尝试） */
async function fetchCreatorVideoList(secUserId: string, maxCount: number, cyanlisConfig?: CyanlisConfig | null): Promise<CreatorVideo[]> {
  const allVideos: CreatorVideo[] = [];

  // ★ 优先使用 Cyanlis user_posts_lite（无需 cookie，更稳定）
  if (cyanlisConfig) {
    console.log(`[BatchExtract] Cyanlis渠道获取视频列表：user_posts_lite`);
    try {
      let cursor: string | undefined = undefined;
      let hasMore = true;

      while (hasMore && allVideos.length < maxCount * 3) {
        // 获取3倍数量用于筛选，按热度排序(sortType=1)
        const result = await getDouyinUserPostsLite(cyanlisConfig, secUserId, cursor, 1);

        if (result.success && result.posts) {
          const posts = result.posts;
          const list = posts.list || [];
          for (const item of list) {
            allVideos.push({
              awemeId: item.aweme_id,
              desc: item.desc || item.caption || "",
              videoUrl: item.video_url || "",
              coverUrl: item.cover || "",
              likes: item.digg_count || 0,
              comments: item.comment_count || 0,
              shares: 0,
              createTime: item.create_time || 0,
              duration: item.duration || 0,
              author: item.nickname || "",
            });
          }
          hasMore = posts.hasMore === "1";
          cursor = posts.cursor || undefined;
          if (list.length === 0) break;
        } else {
          console.error(`[BatchExtract] Cyanlis user_posts_lite 失败: ${result.error}`);
          break;
        }
      }

      if (allVideos.length > 0) {
        console.log(`[BatchExtract] Cyanlis获取到 ${allVideos.length} 个视频，直接返回`);
        return allVideos;
      }

      console.log(`[BatchExtract] Cyanlis渠道获取视频列表为空，回退到 douyin.wtf`);
    } catch (err) {
      console.error(`[BatchExtract] Cyanlis渠道异常，回退到 douyin.wtf:`, err);
    }
  }

  // 回退：使用 douyin.wtf
  let wtfCursor = 0;
  let wtfHasMore = true;

  while (wtfHasMore && allVideos.length < maxCount * 3) {
    const result = await fetchCreatorVideosViaWtf(secUserId, Math.min(20, maxCount * 3 - allVideos.length), wtfCursor);

    if (!result) {
      console.log(`[BatchExtract] douyin.wtf 获取视频列表失败`);
      break;
    }

    allVideos.push(...result.videos);
    wtfHasMore = result.hasMore;
    wtfCursor = result.nextCursor;

    if (result.videos.length === 0) {
      break;
    }
  }

  return allVideos;
}

// ============ 文案提取核心 ============

/** 通过 PPT6 API 获取视频信息（复用已有逻辑） */
async function fetchVideoInfoViaPpt6(videoUrl: string, clientId: string, clientSecretKey: string): Promise<{
  desc: string; title: string; videoUrl: string; coverUrl: string;
} | null> {
  try {
    const ppt6Url = `https://apis.ppt6.top?clientId=${encodeURIComponent(clientId)}&clientSecretKey=${encodeURIComponent(clientSecretKey)}&url=${encodeURIComponent(videoUrl)}`;
    const response = await fetch(ppt6Url, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) return null;

    const result = await response.json();
    // PPT6 官方文档: code==200 为成功；兼容 code==0
    if ((result.code === 200 || result.code === 0) && result.data) {
      return {
        desc: result.data.desc || "",
        title: result.data.title || "",
        videoUrl: result.data.video_url || result.data.video_mp4 || result.data.video || "",
        coverUrl: result.data.cover || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 获取批量提取插件配置 */
async function getBatchExtractConfig(): Promise<{
  provider: string;
  apiKey: string;
  apiBaseUrl: string;
  siteName: string;
  maxVideosPerBatch: number;
  defaultLikesThreshold: number;
  pricePerUse: number;
  costPrice: number;
  ppt6ClientId?: string;
  ppt6ClientSecretKey?: string;
} | null> {
  try {
    const supabase = getSupabaseClient();

    // 1. 优先读取批量提取专用插件 (extract_batch_third_party)
    const { data: batchPlugin, error: batchPluginError } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .eq("role", "extract_batch_third_party")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (batchPluginError) {
      throw new ExtractionPricingConfigError("批量提取专用渠道价格配置暂时无法读取，本次未调用上游服务");
    }

    if (batchPlugin) {
      const config = batchPlugin.config as Record<string, string>;
      // ★ 优先从批量提取插件自身配置获取PPT6凭据
      let ppt6ClientId = config.client_id || "";
      let ppt6ClientSecretKey = config.client_secret_key || "";
      // 仅允许从当前启用的 PPT6 文案插件补充凭据，不能绕过后台停用状态。
      if (!ppt6ClientId || !ppt6ClientSecretKey) {
        const { data: ppt6Plugin } = await supabase
          .from("plugins")
          .select("config")
          .eq("role", "extract_text_third_party")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        if (ppt6Plugin) {
          const ppt6Config = ppt6Plugin.config as Record<string, string>;
          ppt6ClientId = ppt6ClientId || ppt6Config.client_id || "";
          ppt6ClientSecretKey = ppt6ClientSecretKey || ppt6Config.client_secret_key || "";
        }
      }

      return {
        provider: config.provider || "cyanlis",
        apiKey: config.api_key || "",
        apiBaseUrl: config.api_base_url || "https://cyanlis.cn",
        siteName: config.site_name || "Cyanlis",
        maxVideosPerBatch: parseInt(config.max_videos_per_batch || "30"),
        defaultLikesThreshold: parseInt(config.default_likes_threshold || "1000"),
        pricePerUse: requireConfiguredExtractionMoney(batchPlugin.price_per_use, "批量提取售价"),
        costPrice: requireConfiguredExtractionMoney(batchPlugin.cost_price, "批量提取成本"),
        ppt6ClientId: ppt6ClientId || undefined,
        ppt6ClientSecretKey: ppt6ClientSecretKey || undefined,
      };
    }

    // 2. 兜底：使用当前活跃的文案提取插件 + PPT6配置
    const { data: textPlugin, error: textPluginError } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .in("role", ["extract_text_third_party", "extract_workflow"])
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (textPluginError) {
      throw new ExtractionPricingConfigError("批量提取文案渠道价格配置暂时无法读取，本次未调用上游服务");
    }

    if (textPlugin) {
      const config = textPlugin.config as Record<string, string>;
      return {
        provider: config.provider || "ppt6",
        apiKey: config.api_key || config.api_token || "",
        apiBaseUrl: config.api_base_url || "https://cyanlis.cn",
        siteName: config.site_name || "PPT6",
        maxVideosPerBatch: 30,
        defaultLikesThreshold: 1000,
        pricePerUse: requireConfiguredExtractionMoney(textPlugin.price_per_use, "批量提取售价"),
        costPrice: requireConfiguredExtractionMoney(textPlugin.cost_price, "批量提取成本"),
        ppt6ClientId: config.client_id,
        ppt6ClientSecretKey: config.client_secret_key,
      };
    }

    // 3. 最终兜底：从 extract_video (PPT6视频解析) 插件获取凭据
    const { data: videoPlugin, error: videoPluginError } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .eq("role", "extract_video")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (videoPluginError) {
      throw new ExtractionPricingConfigError("批量提取视频渠道价格配置暂时无法读取，本次未调用上游服务");
    }

    if (videoPlugin) {
      const config = videoPlugin.config as Record<string, string>;
      return {
        provider: "ppt6",
        apiKey: "",
        apiBaseUrl: "",
        siteName: config.site_name || "PPT6",
        maxVideosPerBatch: 30,
        defaultLikesThreshold: 1000,
        pricePerUse: requireConfiguredExtractionMoney(videoPlugin.price_per_use, "批量提取售价"),
        costPrice: requireConfiguredExtractionMoney(videoPlugin.cost_price, "批量提取成本"),
        ppt6ClientId: config.client_id,
        ppt6ClientSecretKey: config.client_secret_key,
      };
    }

    return null;
  } catch (error) {
    console.error("[BatchExtract] 获取插件配置失败:", error);
    return null;
  }
}

// ============ 主处理逻辑 ============

async function handlePost(request: NextRequest) {
  try {
    // Auth check
    const authorization = await authorizeExtractionRequest(request);
    if (!authorization.ok) return authorization.response;
    const userId = authorization.userId;
    const userRole = authorization.role;

    // 解析请求
    let body: BatchExtractRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "请求体解析失败" }, { status: 400 });
    }

    const requestIdentity = resolveClientRequestId(request, body);
    if ("response" in requestIdentity) return requestIdentity.response;
    const { clientRequestId } = requestIdentity;

    const { creator_url, likes_threshold, max_count } = body;

    if (!creator_url?.trim()) {
      return NextResponse.json({ error: "请提供博主主页链接" }, { status: 400 });
    }

    const cozeResponse = await tryCozeMultiModeExtraction(request, { shareText: creator_url.trim(), minLikes: likes_threshold, maxCount: max_count, clientRequestId }, 'batch');
    if (cozeResponse) return cozeResponse;

    // 获取插件配置
    const batchConfig = await getBatchExtractConfig();
    if (!batchConfig) {
      return NextResponse.json({
        error: "批量提取运行配置暂时无法读取，本次未调用上游服务",
        error_code: "EXTRACTION_BATCH_CONFIG_UNAVAILABLE",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 503 });
    }
    const configuredProvider = batchConfig?.provider.trim().toLowerCase() || "";
    if (configuredProvider === "cyanlis" && !batchConfig?.apiKey) {
      return NextResponse.json({
        error: "当前启用的批量提取插件缺少 Cyanlis API Key，本次未调用上游服务",
        provider_call_started: false,
      }, { status: 503 });
    }
    const effectiveMaxCount = normalizeExtractionCount(max_count, batchConfig?.maxVideosPerBatch || 20, normalizeExtractionCount(batchConfig?.maxVideosPerBatch, 30));
    const effectiveLikesThreshold = likes_threshold ?? batchConfig?.defaultLikesThreshold ?? 0;
    const pricePerUse = batchConfig.pricePerUse;

    // 预检余额
    const estimatedCost = extractionTotalPrice(pricePerUse, effectiveMaxCount);
    if (estimatedCost > 0) {
      const supabase = getSupabaseClient();
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

      if ((userData?.cash_balance || 0) < estimatedCost) {
        return NextResponse.json({
          error: "现金余额不足，请先充值",
          required: estimatedCost,
          current: userData?.cash_balance || 0,
        }, { status: 402 });
      }
    }

    // ============ Step 1: 解析博主主页链接 ============
    console.log(`[BatchExtract] Step 1: 解析博主主页链接`);
    const parsed = parseCreatorUrl(creator_url);

    let secUserId: string | null = null;
    if (parsed) {
      if (parsed.source === "full_url") {
        secUserId = parsed.secUserId;
      } else {
        // 短链接，需要解析
        secUserId = await resolveCreatorShortUrl(parsed.secUserId);
      }
    }

    if (!secUserId) {
      return NextResponse.json({
        success: false,
        error: "无法解析博主主页链接，请使用完整链接格式：https://www.douyin.com/user/MS4wLjAB...",
      }, { status: 400 });
    }

    console.log(`[BatchExtract] 解析到sec_user_id: ${secUserId}`);

    // ============ Step 2: 获取博主视频列表 ============
    // 只使用后台当前启用且明确选择的批量渠道，禁止从已停用/其他角色插件偷取密钥。
    const cyanlisConfig: CyanlisConfig | null = configuredProvider === "cyanlis" && batchConfig?.apiKey
      ? {
          apiBaseUrl: batchConfig.apiBaseUrl || "https://cyanlis.cn",
          apiKey: batchConfig.apiKey,
          provider: "cyanlis",
        }
      : null;
    console.log(`[BatchExtract] Step 2: 获取博主视频列表 (max=${effectiveMaxCount}, likes>=${effectiveLikesThreshold})`);
    const allVideos = await fetchCreatorVideoList(secUserId, effectiveMaxCount, cyanlisConfig);

    if (allVideos.length === 0) {
      return NextResponse.json({
        success: false,
        error: "未获取到博主视频列表，该博主可能没有公开视频或API暂时不可用",
        sec_user_id: secUserId,
      }, { status: 404 });
    }

    console.log(`[BatchExtract] 获取到 ${allVideos.length} 个视频`);

    // ============ Step 3: 按条件筛选 ============
    const filteredVideos = allVideos
      .filter(v => v.likes >= effectiveLikesThreshold)
      .sort((a, b) => b.likes - a.likes) // 按点赞数降序
      .slice(0, effectiveMaxCount);

    if (filteredVideos.length === 0) {
      return NextResponse.json({
        success: false,
        error: `没有符合条件的视频（点赞数 >= ${effectiveLikesThreshold}），共有 ${allVideos.length} 个视频`,
        total_videos: allVideos.length,
        filtered_count: 0,
        likes_threshold: effectiveLikesThreshold,
      });
    }

    console.log(`[BatchExtract] 筛选后 ${filteredVideos.length} 个视频 (总${allVideos.length}个, 阈值>=${effectiveLikesThreshold})`);

    // ============ Step 4: 逐条提取文案 ============
    console.log(`[BatchExtract] Step 4: 逐条提取文案`);
    const results: BatchTextResult[] = [];
    let successCount = 0;

    for (let i = 0; i < filteredVideos.length; i++) {
      const video = filteredVideos[i];
      console.log(`[BatchExtract] 提取文案 (${i + 1}/${filteredVideos.length}): awemeId=${video.awemeId}, likes=${video.likes}`);

      try {
        // 构造视频链接用于提取
        const videoLink = `https://www.douyin.com/video/${video.awemeId}`;

        // ★ 方案A*：Cyanlis video_to_text（一步完成，最高效）
        if (cyanlisConfig) {
          try {
            const cyanlisResult = await getDouyinVideoToText(cyanlisConfig, videoLink);
            if (cyanlisResult.success && cyanlisResult.text) {
              successCount++;
              results.push({
                row: i + 1,
                awemeId: video.awemeId,
                title: cyanlisResult.desc || cyanlisResult.caption || video.desc?.substring(0, 100) || "",
                author: cyanlisResult.nickname || video.author,
                likes: video.likes,
                success: true,
                content: cyanlisResult.text,
                source: "cyanlis_video_to_text",
              });
              continue;
            }
            console.log(`[BatchExtract] Cyanlis video_to_text 失败 awemeId=${video.awemeId}, 回退到ASR`);
          } catch (err) {
            console.log(`[BatchExtract] Cyanlis video_to_text 异常 awemeId=${video.awemeId}, 回退到ASR:`, err?.toString?.() || err);
          }
        }

        // 方案A：如果有视频URL，直接用已有的视频信息 + ASR转写
        if (video.videoUrl) {
          // 使用视频直链 → ASR转写口播文案
          // 这里调用现有的提取逻辑（通过内部API调用）
          const extractResult = await extractTextFromVideo(
            videoLink,
            video.videoUrl,
            video.desc,
            request.headers,
            batchConfig?.ppt6ClientId,
            batchConfig?.ppt6ClientSecretKey,
          );

          if (extractResult.success && extractResult.content) {
            successCount++;
            results.push({
              row: i + 1,
              awemeId: video.awemeId,
              title: video.desc?.substring(0, 100) || "",
              author: video.author,
              likes: video.likes,
              success: true,
              content: extractResult.content,
              source: extractResult.source,
            });
            continue;
          }
        }

        // 方案B：PPT6获取视频URL → ASR转写
        if (batchConfig?.ppt6ClientId && batchConfig?.ppt6ClientSecretKey) {
          const ppt6Info = await fetchVideoInfoViaPpt6(
            videoLink,
            batchConfig.ppt6ClientId,
            batchConfig.ppt6ClientSecretKey,
          );

          if (ppt6Info?.videoUrl) {
            const extractResult = await extractTextFromVideo(
              videoLink,
              ppt6Info.videoUrl,
              ppt6Info.desc || video.desc,
              request.headers,
            );

            if (extractResult.success && extractResult.content) {
              successCount++;
              results.push({
                row: i + 1,
                awemeId: video.awemeId,
                title: video.desc?.substring(0, 100) || ppt6Info.title,
                author: video.author,
                likes: video.likes,
                success: true,
                content: extractResult.content,
                source: extractResult.source,
              });
              continue;
            }
          }
        }

        // 方案C：使用视频描述作为兜底文案
        if (video.desc && video.desc.length > 10) {
          successCount++;
          results.push({
            row: i + 1,
            awemeId: video.awemeId,
            title: video.desc?.substring(0, 100) || "",
            author: video.author,
            likes: video.likes,
            success: true,
            content: `[视频描述] ${video.desc}`,
            source: "desc_fallback",
          });
        } else {
          results.push({
            row: i + 1,
            awemeId: video.awemeId,
            title: video.desc?.substring(0, 100) || "",
            author: video.author,
            likes: video.likes,
            success: false,
            error: "文案提取失败",
          });
        }
      } catch (err) {
        console.error(`[BatchExtract] 提取文案异常:`, err);
        results.push({
          row: i + 1,
          awemeId: video.awemeId,
          title: video.desc?.substring(0, 100) || "",
          author: video.author,
          likes: video.likes,
          success: false,
          error: `提取异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // ============ Step 5: 扣费 ============
    let charged = false;
    let billingReplayed = false;
    if (successCount > 0) {
      const totalCost = extractionTotalPrice(pricePerUse, successCount);
      const settlementKey = `extract-batch:${clientRequestId}:charge`;
      if (totalCost > 0) {
        const deductResult = await deductCash(
          userId,
          totalCost,
          `批量文案提取 ${successCount} 条`,
          settlementKey,
        );
        if (!deductResult.success) {
          return NextResponse.json({
            success: false,
            error: `计费未完成: ${deductResult.error || "统一钱包暂不可用"}`,
            results: [],
            upstream_completed: true,
            charged: false,
          }, { status: 503 });
        }
        charged = true;
        billingReplayed = Boolean(deductResult.alreadyFulfilled);
      }
      try {
        await recordRevenue({
          userId,
          userRole: userRole as "admin" | "student",
          modelId: "extract_batch",
          taskId: settlementKey,
          costPrice: extractionTotalPrice(batchConfig.costPrice, successCount),
          sellingPrice: totalCost,
          recordType: "extract",
          cashCharged: totalCost,
        });
      } catch (error) {
        console.error("[BatchExtract] 收益落账失败:", error);
        return NextResponse.json({
          success: false,
          error: "提取已完成，账务正在确认。原请求已保留，请稍后用相同请求刷新状态。",
          results: [],
          upstream_completed: true,
          charged,
          billing_unknown: true,
          retry_safe: false,
        }, { status: 503 });
      }
    }

    // ============ 返回结果 ============
    return NextResponse.json({
      success: successCount > 0,
      message: successCount > 0
        ? `批量文案提取完成，成功 ${successCount}/${filteredVideos.length} 条`
        : "所有视频文案提取失败",
      sec_user_id: secUserId,
      total_videos: allVideos.length,
      filtered_count: filteredVideos.length,
      likes_threshold: effectiveLikesThreshold,
      results,
      texts: results.map(r => ({
        row: r.row,
        col: 1,
        platform: "douyin",
        success: r.success,
        content: r.content || "",
        corrected_content: r.content || "",
        title: r.title,
        author: r.author,
        source: r.source,
        error: r.error,
      })),
      charged,
      billing_replayed: billingReplayed,
      price: pricePerUse,
      channel: batchConfig?.provider || "batch_extract",
    });
  } catch (error) {
    console.error("[BatchExtract API] Error:", error);
    return NextResponse.json(
      { error: "批量提取服务异常，请稍后重试" },
      { status: 500 }
    );
  }
}

export const POST = withExtractionExactlyOnce("batch", handlePost);

// ============ 文案提取辅助函数 ============

async function extractTextFromVideo(
  videoLink: string,
  videoUrl: string,
  desc: string,
  requestHeaders: Headers,
  ppt6ClientId?: string,
  ppt6ClientSecretKey?: string,
): Promise<{ success: boolean; content: string | null; source: string }> {
  // 尝试 ASR 转写
  try {
    // 动态导入 ASR 相关模块
    const { ASRClient, Config, HeaderUtils } = await import("coze-coding-dev-sdk");

    // 下载视频到本地
    const localUrl = await downloadVideoToLocal(videoUrl);
    if (!localUrl) {
      console.log(`[BatchExtract] 视频下载失败: ${videoLink}`);
      return { success: false, content: null, source: "none" };
    }

    // ASR 转写
    try {
      const customHeaders = HeaderUtils.extractForwardHeaders(requestHeaders);
      const config = new Config();
      const client = new ASRClient(config, customHeaders);
      const result = await client.recognize({ uid: "batch-extract", url: localUrl });

      if (result.text && result.text.trim().length > 10) {
        console.log(`[BatchExtract] ASR成功: length=${result.text.length}`);
        return { success: true, content: result.text, source: "asr" };
      }
    } catch (asrErr) {
      console.error(`[BatchExtract] ASR失败:`, asrErr);
    }

    // LLM 视觉理解兜底
    try {
      const yunwuApiKey = process.env.VISION_API_KEY || process.env.LLM_API_KEY || "";
      const rawYunwuBase = process.env.VISION_API_BASE_URL || process.env.LLM_API_BASE_URL || "https://yunwu.ai";
      const yunwuBaseUrl = /\/v\d+$/.test(rawYunwuBase.replace(/\/+$/, "")) ? rawYunwuBase.replace(/\/+$/, "") : `${rawYunwuBase.replace(/\/+$/, "")}/v1`;
      const visionModel = process.env.VISION_MODEL || "gemini-2.5-flash";

      const prompt = "这是一个人在镜头前口播讲述的短视频。请仔细听视频中的语音内容，将口播讲述的每一句话完整转写为文字。注意：只提取语音/配音讲述的实际内容，不要提取视频标题、画面中的装饰文字、搜索关键词等非语音内容。只输出逐句转写的口播原文，不要添加任何解释、总结或格式。";

      const response = await fetch(`${yunwuBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${yunwuApiKey}`,
        },
        body: JSON.stringify({
          model: visionModel,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: localUrl } },
            ],
          }],
          temperature: 0.1,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content && content.trim().length > 10) {
          console.log(`[BatchExtract] LLM视觉理解成功: length=${content.length}`);
          return { success: true, content, source: "llm" };
        }
      }
    } catch (llmErr) {
      console.error(`[BatchExtract] LLM视觉理解失败:`, llmErr);
    }
  } catch (importErr) {
    console.error(`[BatchExtract] ASR模块导入失败:`, importErr);
  }

  return { success: false, content: null, source: "none" };
}

/** 下载视频到本地 /tmp 目录，返回可通过本服务访问的URL */
async function downloadVideoToLocal(videoUrl: string): Promise<string | null> {
  return cacheExtractVideoForProvider(videoUrl);
}
