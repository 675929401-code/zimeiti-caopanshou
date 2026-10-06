import { runCozeCaptionWorkflow as callCozeWorkflow, detectCozeCaptionMode as detectCozeMode } from '@/lib/coze-workflow-client';
import { cozeCaptionResults, parseCozeWorkflowResult, CozeWorkflowExecutionError, cozeWorkflowFailure, type CozeWorkflowOutput } from "@/lib/coze-extraction-result";
import { getSupabaseAdminClient, getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { authorizeExtractionRequest } from "@/lib/extraction-auth";
import { ASRClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import { deductCash } from "@/lib/billing";
import {
  ExtractionPricingConfigError,
  configuredExtractionMoney,
  extractionTotalPrice,
  normalizeExtractionCount,
  requireConfiguredExtractionMoney,
} from "@/lib/extract-pricing";
import { recordRevenue } from "@/lib/revenue";
import { getDouyinVideoDetail, getDouyinVideoToText, type CyanlisConfig } from "@/lib/cyanlis-client";
import { createSignedExtractDownloadParams } from "@/lib/extract-download-signature";
import { cacheExtractVideoForProvider } from "@/lib/extract-local-video-cache";
import { withExtractionExactlyOnce, checkpointExtractionProviderTask, checkpointExtractionProviderResult, type ExtractionAttemptRecord } from "@/lib/extraction-exactly-once";
import { extractionProviderProblem, readableExtractionError } from "@/lib/extraction-provider-error";
import { buildPpt6TranscriptItem } from "@/lib/extract-transcript";
import {
  expandDistinctVideoRecoveryResponse,
  readDistinctVideoRequestPlan,
  validDistinctVideoCheckpointCardinality,
  withDistinctExtractionLinks,
} from "@/lib/extract-distinct-links";
import { cacheExtractVideoForTemporaryOwner } from "@/lib/extract-local-video-cache";
type ExtractionFallbackPricing = { pricePerUse: number; costPrice: number };

function resolveExtractionFallbackPricing(): ExtractionFallbackPricing | null {
  const pricePerUse = configuredExtractionMoney(process.env.EXTRACT_FALLBACK_PRICE);
  const costPrice = configuredExtractionMoney(process.env.EXTRACT_FALLBACK_COST);
  return pricePerUse === null || costPrice === null ? null : { pricePerUse, costPrice };
}

// 视频/文案提取 API — 多方案架构
// ★ 渠道优先级（文案提取）：
//   0. 扣子三合一工作流（coze_multifunction_extract）— 最高优先级，支持单视频/博主主页/搜索
//   1. Cyanlis video_to_text（一步提取口播文案）— extract_text_third_party(provider=cyanlis)
//   2. PPT6 第三方差价渠道 — extract_text_third_party(response_format=ppt6)
//   3. 方案二：douyin.wtf + ASR/LLM — extract_workflow
//   4. 方案一：Coze 工作流兜底
// 文案提取主方案：douyin.wtf 解析 + Volcengine ASR/LLM 双引擎（直接提取口播文案，不降级返回视频描述）
// 备选方案：Coze 工作流插件提取（仅在主方案失败时尝试）
// 视频提取与文案提取共用 active coze_multifunction_extract 三合一工作流。
// 旧 PPT6 结果只保留检查点恢复兼容，不再接收新提交，也不作为故障回退。

export const maxDuration = 180; // Coze 工作流可能需要 60-120 秒，设为 180 秒防止超时

interface ExtractRequest {
  links: string[];
  extraction_mode: string; // "video" | "text" | "batch"
  douyin_share_text?: string; // 方案一：抖音分享的原始文本（整段粘贴）
  client_request_id?: string;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function resolveClientRequestId(
  request: NextRequest,
  body: ExtractRequest,
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

function providerLogHost(value: string): string {
  try {
    return new URL(value).host || "unknown";
  } catch {
    return "invalid";
  }
}

function boundedProviderText(value: unknown, maxLength = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedProviderMediaUrl(value: unknown): string {
  const candidate = boundedProviderText(value, 8_192);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return /^https?:$/u.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch {
    return "";
  }
}

interface WorkflowOutput {
  success: boolean;
  message: string;
  videos: VideoItem[];
  texts: TextItem[];
  summary: string;
  run_id?: string;
  author?: string;
  debug_fields?: string[];
}

interface VideoItem {
  row: number;
  col: number;
  platform: string;
  success: boolean;
  error?: string;
  url?: string;
  title?: string;
  cover?: string;
  download_url?: string;
  asset_id?: string;
  temporary_url?: string;
  temporary_expires_at?: number;
  images?: string[];
}

async function attachTemporaryExtractionVideos(
  videos: Array<VideoItem>,
  userId: string,
  clientRequestId: string,
) {
  for (const [index, video] of videos.entries()) {
    if (video.success === false || video.images?.length) continue;
    if (video.temporary_url) continue;
    if (video.asset_id) continue;
    const sourceUrl = video.download_url || video.url || "";
    if (!sourceUrl) throw new Error("EXTRACTION_VIDEO_SOURCE_MISSING");
    const staged = await cacheExtractVideoForTemporaryOwner(sourceUrl, userId);
    video.temporary_url = staged.temporaryUrl;
    video.temporary_expires_at = staged.expiresAt;
  }
}

interface TextItem {
  row: number;
  col: number;
  platform: string;
  success: boolean;
  error?: string;
  content?: string;
  corrected_content?: string;
  title?: string;
  author?: string;
  source?: string;
  isTranscript?: boolean;
  transcriptMethod?: string;
}

// ============ 抖音链接解析工具 ============

/** 从用户分享文本中提取视频ID或短链接 */
function parseDouyinInput(input: string): { type: "video_id" | "short_url" | "full_url"; videoId?: string; url?: string } | null {
  const text = input.trim();

  // Pattern 1: 完整链接 https://www.douyin.com/video/123456
  const fullMatch = text.match(/https?:\/\/www\.douyin\.com\/video\/(\d{15,22})/);
  if (fullMatch) {
    return { type: "full_url", videoId: fullMatch[1], url: fullMatch[0] };
  }

  // Pattern 2: 短链接 https://v.douyin.com/xxx (支持 _ - 等URL安全字符)
  const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/);
  if (shortMatch) {
    return { type: "short_url", url: shortMatch[0].replace(/\/$/, "") };
  }

  // Pattern 3: iesdouyin 链接
  const iesMatch = text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/(\d{15,22})/);
  if (iesMatch) {
    return { type: "full_url", videoId: iesMatch[1], url: iesMatch[0] };
  }

  // Pattern 4: 小红书链接 https://www.xiaohongshu.com/explore/xxx 或 /discovery/item/xxx
  const xhsMatch = text.match(/https?:\/\/www\.xiaohongshu\.com\/(explore|discovery\/item)\/[A-Za-z0-9]+/);
  if (xhsMatch) {
    return { type: "full_url", url: xhsMatch[0] };
  }

  // Pattern 5: 快手链接 https://v.kuaishou.com/xxx 或 www.kuaishou.com/short-video/xxx
  const ksMatch = text.match(/https?:\/\/(v\.kuaishou\.com\/[A-Za-z0-9_-]+|www\.kuaishou\.com\/short-video\/[A-Za-z0-9_-]+)/);
  if (ksMatch) {
    return { type: "full_url", url: ksMatch[0] };
  }

  // Pattern 6: 皮皮虾链接 https://www.iesdouyin.com/share/video/xxx
  const ppMatch = text.match(/https?:\/\/www\.iesdouyin\.com\/share\/video\/\d+/);
  if (ppMatch) {
    return { type: "full_url", url: ppMatch[0] };
  }

  // Pattern 7: 通用http链接（兜底，从分享文本中提取任意http链接）
  const genericMatch = text.match(/https?:\/\/[^\s<>"']+/);
  if (genericMatch) {
    return { type: "full_url", url: genericMatch[0].replace(/\/$/, "") };
  }

  // Pattern 8: 纯视频ID（15-22位数字，兼容各种长度）
  const idMatch = text.match(/\b(\d{15,22})\b/);
  if (idMatch) {
    return { type: "video_id", videoId: idMatch[1] };
  }

  return null;
}

/** 通过 iesdouyin.com 解析短链接获取视频ID */
async function resolveShortUrl(shortUrl: string): Promise<string | null> {
  try {
    // 先尝试 GET 请求 + manual redirect，从 302 Location 中提取视频ID
    const res = await fetch(shortUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") || "";
      // 从 redirect URL 中提取视频ID（支持 douyin.com/video/xxx 和 iesdouyin.com/share/video/xxx）
      const match = location.match(/video\/(\d{15,22})/);
      if (match) return match[1];

      // 尝试跟随重定向再提取
      if (location) {
        const res2 = await fetch(location, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
            "Accept": "text/html",
          },
          signal: AbortSignal.timeout(15000),
        });
        const location2 = res2.headers.get("location") || "";
        const match2 = location2.match(/video\/(\d{15,22})/);
        if (match2) return match2[1];

        // 尝试第三次重定向（抖音有时需要2次302）
        if (location2) {
          const res3 = await fetch(location2, {
            method: "GET",
            redirect: "manual",
            headers: {
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
              "Accept": "text/html",
            },
            signal: AbortSignal.timeout(15000),
          });
          const location3 = res3.headers.get("location") || "";
          const match3 = location3.match(/video\/(\d{15,22})/);
          if (match3) return match3[1];
        }
      }
    }

    // 如果 manual redirect 方式失败，尝试自动跟随重定向，从最终 URL 提取
    try {
      const autoRes = await fetch(shortUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
          "Accept": "text/html",
        },
        signal: AbortSignal.timeout(15000),
      });
      const finalUrl = autoRes.url || "";
      const autoMatch = finalUrl.match(/video\/(\d{15,22})/);
      if (autoMatch) return autoMatch[1];

      // 最后尝试从返回的 HTML 中提取
      const html = await autoRes.text();
      const htmlMatch = html.match(/video\/(\d{15,22})/) || html.match(/aweme_id.*?(\d{15,22})/);
      if (htmlMatch) return htmlMatch[1];
    } catch {
      // ignore
    }

    return null;
  } catch (error) {
    console.error("[Extract] Short URL resolution failed:", error);
    return null;
  }
}

// ============ 方案二：多源视频提取 API ============
// douyin.wtf 不稳定，加入多个备选源

interface DouyinVideoResult {
  success: boolean;
  desc: string;
  author: string;
  authorAvatar: string;
  awemeId: string;
  coverUrl: string;
  videoUrl: string;
  downloadUrl: string;
  dynamicCoverUrl: string;
  duration: number;
  width: number;
  height: number;
  stats: {
    diggCount: number;
    commentCount: number;
    shareCount: number;
    playCount: number;
    collectCount: number;
  };
  createTime: number;
  musicTitle: string;
  musicAuthor: string;
  musicUrl: string;
}

/** 通过 douyin.wtf API 获取抖音视频详情（源1） */
async function fetchDouyinVideoViaWtf(awemeId: string): Promise<DouyinVideoResult | null> {
  try {
    const apiUrl = `https://douyin.wtf/api/douyin/web/fetch_one_video?aweme_id=${awemeId}`;
    console.log(`[Extract] Calling douyin.wtf API: ${apiUrl}`);
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[Extract] douyin.wtf API returned ${response.status}`);
      return null;
    }

    const json = await response.json() as {
      code: number;
      msg: string;
      data: {
        aweme_detail: {
          aweme_id: string;
          desc: string;
          create_time: number;
          author: {
            nickname: string;
            uid: string;
            unique_id?: string;
            avatar_thumb?: { url_list: string[] };
          };
          video: {
            play_addr?: { url_list: string[] };
            download_addr?: { url_list: string[] };
            cover?: { url_list: string[] };
            dynamic_cover?: { url_list: string[] };
            duration: number;
            width: number;
            height: number;
          };
          statistics: {
            digg_count: number;
            comment_count: number;
            share_count: number;
            play_count: number;
            collect_count: number;
          };
          music?: {
            title: string;
            author: string;
            play_url?: { uri: string };
          };
        };
        filter_reason?: string;
      };
    };

    console.log(`[Extract] douyin.wtf API response: code=${json.code}, has_aweme_detail=${!!json.data?.aweme_detail}, filter_reason=${json.data?.filter_reason}`);
    if (json.code !== 200 || !json.data?.aweme_detail) {
      console.error(`[Extract] douyin.wtf API failed: code=${json.code}, reason=${json.data?.filter_reason}`);
      return null;
    }

    const d = json.data.aweme_detail;
    return {
      success: true,
      desc: d.desc || "",
      author: d.author?.nickname || "",
      authorAvatar: d.author?.avatar_thumb?.url_list?.[0] || "",
      awemeId: d.aweme_id,
      coverUrl: d.video?.cover?.url_list?.[0] || "",
      videoUrl: d.video?.play_addr?.url_list?.[0] || "",
      downloadUrl: d.video?.download_addr?.url_list?.[0] || "",
      dynamicCoverUrl: d.video?.dynamic_cover?.url_list?.[0] || "",
      duration: d.video?.duration || 0,
      width: d.video?.width || 0,
      height: d.video?.height || 0,
      stats: {
        diggCount: d.statistics?.digg_count || 0,
        commentCount: d.statistics?.comment_count || 0,
        shareCount: d.statistics?.share_count || 0,
        playCount: d.statistics?.play_count || 0,
        collectCount: d.statistics?.collect_count || 0,
      },
      createTime: d.create_time || 0,
      musicTitle: d.music?.title || "",
      musicAuthor: d.music?.author || "",
      musicUrl: d.music?.play_url?.uri || "",
    };
  } catch (error) {
    console.error("[Extract] douyin.wtf API error:", error);
    return null;
  }
}

/** 通过抖音网页 API 直接获取视频信息（源2） */
async function fetchDouyinVideoViaWebApi(awemeId: string): Promise<DouyinVideoResult | null> {
  try {
    // 抖音移动端 API — 不需要登录即可获取公开视频信息
    const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&cookie_enabled=true`;
    console.log(`[Extract] Trying Douyin Web API: aweme_id=${awemeId}`);
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.douyin.com/",
        "Accept": "application/json",
        "Cookie": "msToken=abcdef1234567890", // 伪 token，部分接口需要
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.log(`[Extract] Douyin Web API returned ${response.status}`);
      return null;
    }

    const json = await response.json() as {
      status_code?: number;
      aweme_detail?: {
        aweme_id: string;
        desc: string;
        create_time: number;
        author: {
          nickname: string;
          uid: string;
          avatar_thumb?: { url_list: string[] };
        };
        video: {
          play_addr?: { url_list: string[] };
          download_addr?: { url_list: string[] };
          cover?: { url_list: string[] };
          dynamic_cover?: { url_list: string[] };
          duration: number;
          width: number;
          height: number;
        };
        statistics: {
          digg_count: number;
          comment_count: number;
          share_count: number;
          play_count: number;
          collect_count: number;
        };
        music?: {
          title: string;
          author: string;
          play_url?: { uri: string };
        };
      };
    };

    const d = json.aweme_detail;
    if (!d) {
      console.log(`[Extract] Douyin Web API: no aweme_detail in response`);
      return null;
    }

    console.log(`[Extract] Douyin Web API 成功: desc=${d.desc?.substring(0, 50)}`);
    return {
      success: true,
      desc: d.desc || "",
      author: d.author?.nickname || "",
      authorAvatar: d.author?.avatar_thumb?.url_list?.[0] || "",
      awemeId: d.aweme_id,
      coverUrl: d.video?.cover?.url_list?.[0] || "",
      videoUrl: d.video?.play_addr?.url_list?.[0] || "",
      downloadUrl: d.video?.download_addr?.url_list?.[0] || "",
      dynamicCoverUrl: d.video?.dynamic_cover?.url_list?.[0] || "",
      duration: d.video?.duration || 0,
      width: d.video?.width || 0,
      height: d.video?.height || 0,
      stats: {
        diggCount: d.statistics?.digg_count || 0,
        commentCount: d.statistics?.comment_count || 0,
        shareCount: d.statistics?.share_count || 0,
        playCount: d.statistics?.play_count || 0,
        collectCount: d.statistics?.collect_count || 0,
      },
      createTime: d.create_time || 0,
      musicTitle: d.music?.title || "",
      musicAuthor: d.music?.author || "",
      musicUrl: d.music?.play_url?.uri || "",
    };
  } catch (error) {
    console.log(`[Extract] Douyin Web API error:`, error);
    return null;
  }
}

/** 通过 TikWM API 提取抖音视频（源3 — 支持 ID 直接查询） */
async function fetchDouyinVideoViaTikWM(awemeId: string): Promise<DouyinVideoResult | null> {
  try {
    // TikWM 支持通过视频ID直接获取，接口稳定
    const apiUrl = `https://www.tikwm.com/api/?url=${awemeId}&hd=1`;
    console.log(`[Extract] Trying TikWM API: aweme_id=${awemeId}`);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: `url=${awemeId}&hd=1`,
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.log(`[Extract] TikWM API returned ${response.status}`);
      return null;
    }

    const json = await response.json() as {
      code: number;
      msg: string;
      data?: {
        id: string;
        title: string;
        author?: { nickname?: string; avatar?: string; id?: string };
        cover?: string;
        hdplay?: string;
        play?: string;
        wmplay?: string;
        duration?: number;
        width?: number;
        height?: number;
        play_count?: number;
        digg_count?: number;
        comment_count?: number;
        share_count?: number;
        download_count?: number;
        create_time?: number;
        music?: string;
      };
    };

    if (json.code !== 0 || !json.data) {
      console.log(`[Extract] TikWM API failed: code=${json.code}, msg=${json.msg}`);
      return null;
    }

    const d = json.data;
    console.log(`[Extract] TikWM API 成功: title=${d.title?.substring(0, 50)}`);
    return {
      success: true,
      desc: d.title || "",
      author: d.author?.nickname || "",
      authorAvatar: d.author?.avatar || "",
      awemeId: d.id || awemeId,
      coverUrl: d.cover || "",
      videoUrl: d.hdplay || d.play || "",
      downloadUrl: d.hdplay || d.play || d.wmplay || "",
      dynamicCoverUrl: "",
      duration: d.duration || 0,
      width: d.width || 0,
      height: d.height || 0,
      stats: {
        diggCount: d.digg_count || 0,
        commentCount: d.comment_count || 0,
        shareCount: d.share_count || 0,
        playCount: d.play_count || 0,
        collectCount: d.download_count || 0,
      },
      createTime: d.create_time || 0,
      musicTitle: "",
      musicAuthor: "",
      musicUrl: d.music || "",
    };
  } catch (error) {
    console.log(`[Extract] TikWM API error:`, error);
    return null;
  }
}

/** 多源竞速提取视频信息：依次尝试多个 API 源，取最先成功的结果 */
async function fetchDouyinVideoMultiSource(awemeId: string): Promise<DouyinVideoResult | null> {
  // 按稳定性和速度排序的 API 源列表
  const sources = [
    { name: "douyin.wtf", fn: () => fetchDouyinVideoViaWtf(awemeId) },
    { name: "tikwm", fn: () => fetchDouyinVideoViaTikWM(awemeId) },
    { name: "douyin_web", fn: () => fetchDouyinVideoViaWebApi(awemeId) },
  ];

  for (const source of sources) {
    try {
      console.log(`[Extract] 尝试视频提取源: ${source.name}`);
      const result = await source.fn();
      if (result && result.success) {
        console.log(`[Extract] 视频提取源命中: ${source.name}`);
        return result;
      }
    } catch (error) {
      console.log(`[Extract] 视频提取源 ${source.name} 异常:`, error);
    }
  }

  console.log(`[Extract] 所有视频提取源均失败`);
  return null;
}

// ============ 文案提取：ASR + LLM 双引擎 ============

/** 构建代理下载URL，使LLM/ASR可以通过我们的服务器访问视频（绕过CDN防盗链） */
function buildProxyUrl(originalUrl: string): string {
  const baseUrl = process.env.COZE_PROJECT_DOMAIN_DEFAULT || `http://localhost:${process.env.DEPLOY_RUN_PORT || 5000}`;
  const protocol = baseUrl.startsWith('http') ? '' : 'https://';
  const signed = createSignedExtractDownloadParams(originalUrl);
  const query = new URLSearchParams({
    url: originalUrl,
    filename: "video.mp4",
    expires: signed.expires,
    sig: signed.sig,
  });
  return `${protocol}${baseUrl}/api/extract/download?${query.toString()}`;
}

/** 下载视频到本地 /tmp 目录，并返回可通过本服务访问的URL */
async function downloadVideoToLocal(videoUrl: string): Promise<string | null> {
  return cacheExtractVideoForProvider(videoUrl);
}

/** 通过 LLM 视频理解能力提取视频中的语音文案 */
async function transcribeVideoViaLLM(videoUrl: string, requestHeaders: Headers): Promise<string | null> {
  try {
    // 优先：直接传视频URL给支持视频理解的模型（Gemini），无需下载，速度最快
    const yunwuApiKey = process.env.VISION_API_KEY || process.env.LLM_API_KEY || "";
    const rawYunwuBase = process.env.VISION_API_BASE_URL || process.env.LLM_API_BASE_URL || "https://yunwu.ai";
    // 统一 URL 拼接：确保 base 包含 /v1，再拼接 /chat/completions
    const yunwuBaseUrl = /\/v\d+$/.test(rawYunwuBase.replace(/\/+$/, "")) ? rawYunwuBase.replace(/\/+$/, "") : `${rawYunwuBase.replace(/\/+$/, "")}/v1`;
    const visionModel = process.env.VISION_MODEL || "gemini-2.5-flash";

    const transcriptionPrompt = "这是一个人在镜头前口播讲述的短视频。请仔细听视频中的语音内容，将口播讲述的每一句话完整转写为文字。注意：只提取语音/配音讲述的实际内容，不要提取视频标题、画面中的装饰文字、搜索关键词等非语音内容。只输出逐句转写的口播原文，不要添加任何解释、总结或格式。";

    // 第1优先：Gemini 模型通过 image_url 传视频URL（无需下载，速度最快 ~10秒）
    console.log(`[Extract] Trying Gemini video understanding with URL (no download)...`);
    const geminiModels = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
    for (const model of geminiModels) {
      try {
        const response = await fetch(`${yunwuBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${yunwuApiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: transcriptionPrompt },
                { type: "image_url", image_url: { url: videoUrl } },
              ],
            }],
            temperature: 0.1,
            max_tokens: 4096,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          if (content && content.trim().length > 20) {
            console.log(`[Extract] Gemini ${model} transcription OK, length: ${content.length}`);
            return content;
          }
          console.log(`[Extract] Gemini ${model} returned too short (${content?.length || 0}), trying next...`);
        } else {
          const errText = await response.text();
          console.log(`[Extract] Gemini ${model} failed: ${response.status}, trying next...`);
        }
      } catch (e) {
        console.log(`[Extract] Gemini ${model} error, trying next...`);
      }
    }

    // 第2优先：下载视频后用视觉模型提取（image_url 传本地URL）
    console.log(`[Extract] Gemini direct URL failed, downloading video for vision model...`);
    const localUrl = await downloadVideoToLocal(videoUrl);
    if (!localUrl) {
      console.log(`[Extract] Download failed, cannot use vision model`);
      return null;
    }

    const visionModels = [visionModel, "claude-sonnet-4-6", "gpt-4o-mini"];
    for (const model of visionModels) {
      try {
        const response = await fetch(`${yunwuBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${yunwuApiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: transcriptionPrompt },
                { type: "image_url", image_url: { url: localUrl } },
              ],
            }],
            temperature: 0.1,
            max_tokens: 4096,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          if (content && content.trim().length > 20) {
            console.log(`[Extract] Vision ${model} transcription OK, length: ${content.length}`);
            return content;
          }
        }
      } catch (e) {
        console.log(`[Extract] Vision ${model} error, trying next...`);
      }
    }

    console.log(`[Extract] All LLM transcription attempts failed`);
    return null;
  } catch (error) {
    console.error("[Extract] LLM video understanding failed:", error);
    return null;
  }
}

/** 通过 ASR 语音识别提取视频中的语音文案 */
async function transcribeVideoViaASR(videoUrl: string, requestHeaders: Headers, existingLocalUrl?: string): Promise<string | null> {
  try {
    // 使用已有的本地URL或重新下载
    const localUrl = existingLocalUrl || await downloadVideoToLocal(videoUrl);
    console.log(`[Extract] Using ASR for transcription... (local URL: ${localUrl ? 'ok' : 'failed'})`);
    if (!localUrl) return null;

    const customHeaders = HeaderUtils.extractForwardHeaders(requestHeaders);
    const config = new Config();
    const client = new ASRClient(config, customHeaders);

    const result = await client.recognize({
      uid: "extract-service",
      url: localUrl,
    });

    console.log(`[Extract] ASR result length: ${result.text?.length || 0}, duration: ${result.duration || 0}ms`);
    return result.text || null;
  } catch (error) {
    console.error("[Extract] ASR transcription failed:", error);
    return null;
  }
}

/** 并行竞速提取视频语音文案：ASR 和 LLM 同时启动，取最先成功的结果 */
async function transcribeVideo(videoUrl: string, requestHeaders: Headers): Promise<{ transcript: string | null; method: string }> {
  // 先统一下载视频到本地（只下载一次，两个引擎共享）
  const localUrl = await downloadVideoToLocal(videoUrl);
  if (!localUrl) {
    console.log("[Extract] 视频下载失败，无法进行语音转文字");
    return { transcript: null, method: "none" };
  }

  console.log("[Extract] 并行启动 ASR + LLM 双引擎竞速提取口播文案...");

  // 并行启动两个引擎，都使用已下载的本地视频
  const asrPromise = (async () => {
    try {
      const customHeaders = HeaderUtils.extractForwardHeaders(requestHeaders);
      const config = new Config();
      const client = new ASRClient(config, customHeaders);
      const result = await client.recognize({ uid: "extract-service", url: localUrl });
      console.log(`[Extract] ASR 完成: length=${result.text?.length || 0}, duration=${result.duration || 0}ms`);
      if (result.text && result.text.trim().length > 5) {
        return { transcript: result.text, method: "asr" };
      }
      return null;
    } catch (error) {
      console.error("[Extract] ASR 失败:", error);
      return null;
    }
  })();

  const llmPromise = (async () => {
    try {
      const yunwuApiKey = process.env.VISION_API_KEY || process.env.LLM_API_KEY || "";
      const yunwuBaseUrl = process.env.VISION_API_BASE_URL || process.env.LLM_API_BASE_URL || "https://yunwu.ai/v1";
      const visionModel = process.env.VISION_MODEL || "claude-sonnet-4-6";
      console.log(`[Extract] LLM 引擎启动: model=${visionModel}`);

      const prompt = "这是一个人在镜头前口播讲述的短视频。请仔细听视频中的语音内容，将口播讲述的每一句话完整转写为文字。注意：只提取语音/配音讲述的实际内容，不要提取视频标题、画面中的装饰文字、搜索关键词等非语音内容。只输出逐句转写的口播原文，不要添加任何解释、总结或格式。";

      // 先尝试主模型
      const llmResponse = await fetch(`${yunwuBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${yunwuApiKey}` },
        body: JSON.stringify({
          model: visionModel,
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: localUrl } },
          ]}],
          temperature: 0.1,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (llmResponse.ok) {
        const data = await llmResponse.json();
        const content = data.choices?.[0]?.message?.content;
        if (content && content.trim().length > 5) {
          console.log(`[Extract] ${visionModel} 成功: length=${content.length}`);
          return { transcript: content, method: "llm" };
        }
      }

      // 主模型失败，回退 gpt-4o-mini
      console.log(`[Extract] ${visionModel} 失败或结果不足，回退 gpt-4o-mini...`);
      const fbResponse = await fetch(`${yunwuBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${yunwuApiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: localUrl } },
          ]}],
          temperature: 0.1,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (fbResponse.ok) {
        const fbData = await fbResponse.json();
        const fbContent = fbData.choices?.[0]?.message?.content;
        if (fbContent && fbContent.trim().length > 5) {
          console.log(`[Extract] gpt-4o-mini 成功: length=${fbContent.length}`);
          return { transcript: fbContent, method: "llm_fallback" };
        }
      }
      return null;
    } catch (error) {
      console.error("[Extract] LLM 失败:", error);
      return null;
    }
  })();

  // Promise.any: 取最先成功的结果
  try {
    const result = await Promise.any([asrPromise, llmPromise]);
    if (result) {
      console.log(`[Extract] 竞速胜出: method=${result.method}, length=${result.transcript?.length || 0}`);
      return result;
    }
  } catch {
    // Promise.any 在所有 Promise 都 reject 时抛 AggregateError
  }

  // 两个引擎都返回 null，尝试等待另一个完成
  console.log("[Extract] 竞速结果不足，等待另一个引擎...");
  const [asrResult, llmResult] = await Promise.all([asrPromise, llmPromise]);
  const final = asrResult || llmResult;
  if (final) {
    console.log(`[Extract] 最终结果: method=${final.method}, length=${final.transcript?.length || 0}`);
    return final;
  }

  return { transcript: null, method: "none" };
}

// ============ 方案一：Coze 工作流 ============

// ============ 扣子三合一文案提取工作流（最高优先级） ============

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
    const { data: pluginRows, error } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price")
      .eq("role", "coze_multifunction_extract")
      .eq("is_active", true)
      .limit(2);

    if (error) {
      throw new ExtractionPricingConfigError("扣子提取价格配置暂时无法读取，本次未调用上游服务");
    }
    if (Array.isArray(pluginRows) && pluginRows.length > 1) {
      throw new ExtractionPricingConfigError("检测到多个启用的三合一提取插件，请先在管理后台保留一个；本次未调用上游服务");
    }
    const pluginData = Array.isArray(pluginRows) ? pluginRows[0] : null;
    if (pluginData) {
      const config = pluginData.config as Record<string, string>;
      const apiUrl = configuredCozeEndpoint(config.api_base_url);
      if (!apiUrl) {
        throw new ExtractionPricingConfigError("三合一提取插件地址配置无效，本次未调用上游服务");
      }
      return {
        apiUrl,
        apiToken: String(config.api_token || "").trim(),
        pricePerUse: requireConfiguredExtractionMoney(pluginData.price_per_use, "扣子提取售价"),
        costPrice: requireConfiguredExtractionMoney(pluginData.cost_price, "扣子提取成本"),
        maxVideosPerBatch: normalizeExtractionCount(Number(config.max_videos_per_batch), 30),
      };
    }
    console.log("[Extract-Coze] 配置查询: 无激活的三合一插件行");
    return null;
  } catch (error) {
    console.error("[Extract] 获取扣子多功能提取配置失败:", error);
    if (error instanceof ExtractionPricingConfigError) throw error;
    throw new ExtractionPricingConfigError("扣子提取价格配置暂时无法读取，本次未调用上游服务");
  }
}

// ============ 获取文案提取第三方差价渠道配置 ============

interface TextExtractThirdPartyConfig {
  apiUrl: string;
  pricePerUse: number;
  costPrice: number;
  responseFormat?: string;
  clientId?: string;
  clientSecretKey?: string;
  /** 提供商标识（ppt6 / cyanlis） */
  provider?: string;
  /** Cyanlis API Key（当 provider=cyanlis 时使用） */
  apiKey?: string;
  /** 插件名称（用于日志） */
  name?: string;
  /** 网站名称（备注） */
  siteName?: string;
  /** 更新日期 */
  updatedDate?: string;
}

async function getTextExtractThirdPartyConfig(): Promise<TextExtractThirdPartyConfig | null> {
  try {
    const supabase = getSupabaseClient();
    // ★ 从 plugins 表读取 role=extract_text_third_party 的活跃插件
    const { data: pluginData, error } = await supabase
      .from("plugins")
      .select("config, price_per_use, cost_price, name")
      .eq("role", "extract_text_third_party")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new ExtractionPricingConfigError("第三方文案提取价格配置暂时无法读取，本次未调用上游服务");
    }
    if (pluginData) {
      const config = pluginData.config as Record<string, string>;
      return {
        apiUrl: config.api_base_url || "",
        pricePerUse: requireConfiguredExtractionMoney(pluginData.price_per_use, "第三方文案提取售价"),
        costPrice: requireConfiguredExtractionMoney(pluginData.cost_price, "第三方文案提取成本"),
        responseFormat: config.response_format || "",
        clientId: config.client_id || "",
        clientSecretKey: config.client_secret_key || "",
        provider: config.provider || "",
        apiKey: config.api_key || "",
        name: pluginData.name || "",
        siteName: config.site_name || "",
        updatedDate: config.updated_date || "",
      };
    }

    return null;
  } catch (error) {
    if (error instanceof ExtractionPricingConfigError) throw error;
    throw new ExtractionPricingConfigError("第三方文案提取价格配置暂时无法读取，本次未调用上游服务");
  }
}

// ============ 获取管理后台当前生效的文案提取插件角色 ============
async function getActiveTextExtractPluginRole(): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    // 查询文案提取类插件（extract_workflow + extract_text_third_party + coze_multifunction_extract）中 is_active 的那个
    const { data, error } = await supabase
      .from("plugins")
      .select("role")
      .in("role", ["extract_workflow", "extract_text_third_party", "coze_multifunction_extract"])
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new ExtractionPricingConfigError("文案提取生效渠道暂时无法确认，本次未调用上游服务");
    }
    return data?.role || null;
  } catch (error) {
    if (error instanceof ExtractionPricingConfigError) throw error;
    throw new ExtractionPricingConfigError("文案提取生效渠道暂时无法确认，本次未调用上游服务");
  }
}

async function parseStreamRun(response: Response): Promise<WorkflowOutput> {
  const text = await response.text();
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      try {
        const event = JSON.parse(jsonStr) as { type: string; output?: WorkflowOutput };
        if (event.type === "workflow_end" && event.output) {
          return event.output;
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  try {
    return JSON.parse(text) as WorkflowOutput;
  } catch {
    throw new Error("无法解析工作流返回数据");
  }
}

type CozeVideoCheckpoint = {
  schema: "coze_video_provider_result.v1";
  videos: VideoItem[];
  providerTasks: Array<{ task_id: string }>;
  unitPrice: number;
  costPrice: number;
  billingExempt: boolean;
  userRole: "admin" | "student";
  providerProblem?: string;
};

function readCozeVideoCheckpoint(record: ExtractionAttemptRecord): CozeVideoCheckpoint | null {
  const raw = record.providerCheckpoint.result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const checkpoint = raw as Record<string, unknown>;
  if (
    checkpoint.schema !== "coze_video_provider_result.v1"
    || !Array.isArray(checkpoint.videos)
    || checkpoint.videos.length === 0
    || checkpoint.videos.length > 30
    || !Array.isArray(checkpoint.providerTasks)
    || typeof checkpoint.billingExempt !== "boolean"
    || !["admin", "student"].includes(String(checkpoint.userRole))
    || typeof checkpoint.unitPrice !== "number"
    || !Number.isFinite(checkpoint.unitPrice)
    || checkpoint.unitPrice < 0
    || typeof checkpoint.costPrice !== "number"
    || !Number.isFinite(checkpoint.costPrice)
    || checkpoint.costPrice < 0
  ) return null;
  const videos: VideoItem[] = [];
  for (const candidate of checkpoint.videos) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(item.row)
      || !Number.isInteger(item.col)
      || typeof item.platform !== "string"
      || typeof item.success !== "boolean"
    ) return null;
    videos.push({ ...(item as unknown as VideoItem), images: Array.isArray(item.images) ? item.images.filter(value => typeof value === "string") : undefined });
  }
  const providerTasks = checkpoint.providerTasks
    .filter(task => task && typeof task === "object" && !Array.isArray(task) && typeof (task as { task_id?: unknown }).task_id === "string")
    .map(task => ({ task_id: String((task as { task_id: string }).task_id) }));
  return {
    schema: "coze_video_provider_result.v1",
    videos,
    providerTasks,
    unitPrice: Number(checkpoint.unitPrice),
    costPrice: Number(checkpoint.costPrice),
    billingExempt: checkpoint.billingExempt,
    userRole: checkpoint.userRole as "admin" | "student",
    ...(typeof checkpoint.providerProblem === "string" && checkpoint.providerProblem
      ? { providerProblem: checkpoint.providerProblem.slice(0, 500) }
      : {}),
  };
}

type Ppt6VideoCheckpoint = {
  schema: "extract_video_ppt6_result.v1";
  videos: VideoItem[];
  unitPrice: number;
  costPrice: number;
  billingExempt: boolean;
  userRole: "admin" | "student";
};

function readPpt6VideoCheckpoint(record: ExtractionAttemptRecord): Ppt6VideoCheckpoint | null {
  const raw = record.providerCheckpoint.result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const checkpoint = raw as Record<string, unknown>;
  if (
    checkpoint.schema !== "extract_video_ppt6_result.v1"
    || !Array.isArray(checkpoint.videos)
    || checkpoint.videos.length === 0
    || checkpoint.videos.length > 30
    || typeof checkpoint.billingExempt !== "boolean"
    || !["admin", "student"].includes(String(checkpoint.userRole))
    || typeof checkpoint.unitPrice !== "number"
    || !Number.isFinite(checkpoint.unitPrice)
    || checkpoint.unitPrice < 0
    || typeof checkpoint.costPrice !== "number"
    || !Number.isFinite(checkpoint.costPrice)
    || checkpoint.costPrice < 0
  ) return null;
  const videos: VideoItem[] = [];
  for (const candidate of checkpoint.videos) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const item = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(item.row)
      || !Number.isInteger(item.col)
      || typeof item.platform !== "string"
      || typeof item.success !== "boolean"
    ) return null;
    if (item.success === true && typeof item.url !== "string" && typeof item.download_url !== "string") return null;
    videos.push({ ...(item as unknown as VideoItem), images: undefined });
  }
  return {
    schema: "extract_video_ppt6_result.v1",
    videos,
    unitPrice: Number(checkpoint.unitPrice),
    costPrice: Number(checkpoint.costPrice),
    billingExempt: checkpoint.billingExempt,
    userRole: checkpoint.userRole as "admin" | "student",
  };
}

function cozeVideoPersistencePending(providerTasks: Array<{ task_id: string }>) {
  return NextResponse.json({
    success: false,
    error: "视频已解析，30分钟临时文件准备失败。本次未扣费；刷新或用相同内容重试时只会继续准备文件，不会重新调用供应商。",
    error_code: "EXTRACTION_TEMPORARY_MEDIA_FAILED",
    videos: [],
    provider_tasks: providerTasks,
    upstream_completed: true,
    provider_call_started: true,
    recovery_pending: true,
    charged: false,
    billing_unknown: false,
    retry_safe: false,
  }, { status: 503 });
}

async function persistAndSettleCozeVideos(input: {
  videos: VideoItem[];
  providerTasks: Array<{ task_id: string }>;
  userId: string;
  clientRequestId: string;
  unitPrice: number;
  costPrice: number;
  billingExempt: boolean;
  userRole: "admin" | "student";
  providerProblem?: string;
  settlement?: {
    keySuffix: "ppt6-video";
    description: string;
    modelId: "extract_video";
    source: "ppt6";
    logLabel: "Extract-PPT6";
  };
}) {
  const settlement = input.settlement || {
    keySuffix: "coze-video" as const,
    description: "扣子工作流视频提取",
    modelId: "coze_multifunction_extract" as const,
    source: "coze_workflow" as const,
    logLabel: "Extract-Coze" as const,
  };
  const videoResults = input.videos.map(video => ({ ...video, images: video.images ? [...video.images] : undefined }));
  const ownedVideos = videoResults.filter(video => video.success);
  try {
    await attachTemporaryExtractionVideos(ownedVideos, input.userId, input.clientRequestId);
    if (ownedVideos.some(video => !video.temporary_url && !video.images?.length)) {
      throw new Error("EXTRACTION_TEMPORARY_VIDEO_MISSING");
    }
  } catch (error) {
    console.error(`[${settlement.logLabel}] 视频转存失败，保留供应商检查点等待补存储:`, error instanceof Error ? error.message : "unknown");
    return cozeVideoPersistencePending(input.providerTasks);
  }

  let charged = false;
  let billingReplayed = false;
  const totalPrice = extractionTotalPrice(input.unitPrice, ownedVideos.length);
  if (!input.billingExempt && totalPrice > 0) {
    const deduction = await deductCash(
      input.userId,
      totalPrice,
      `${settlement.description} ${ownedVideos.length} 条`,
      `extract:${input.clientRequestId}:${settlement.keySuffix}`,
    ).catch(() => ({ success: false, alreadyFulfilled: false }));
    if (!deduction.success) {
      return NextResponse.json({
        success: false,
        error: "30分钟临时视频已准备好，费用正在确认。请使用原请求再次提交以继续结算；系统不会重复调用视频服务。",
        videos: [],
        provider_tasks: input.providerTasks,
        upstream_completed: true,
        provider_call_started: true,
        recovery_pending: true,
        charged: null,
        billing_unknown: true,
        retry_safe: false,
      }, { status: 503 });
    }
    charged = true;
    billingReplayed = Boolean(deduction.alreadyFulfilled);
  }

  const settlementKey = `extract:${input.clientRequestId}:${settlement.keySuffix}`;
  try {
    await recordRevenue({
      userId: input.userId,
      userRole: input.userRole,
      modelId: settlement.modelId,
      taskId: settlementKey,
      costPrice: input.costPrice * ownedVideos.length,
      sellingPrice: totalPrice,
      recordType: "extract",
      cashCharged: input.billingExempt ? 0 : totalPrice,
      billingExempt: input.billingExempt,
    });
  } catch (error) {
    console.error(`[${settlement.logLabel}] 收入落账失败:`, error instanceof Error ? error.message : "unknown");
    return NextResponse.json({
      success: false,
      error: "30分钟临时视频已准备好，账务正在确认。请使用原请求再次提交以继续结算；系统不会重复调用视频服务。",
      videos: [],
      provider_tasks: input.providerTasks,
      upstream_completed: true,
      provider_call_started: true,
      recovery_pending: true,
      charged: totalPrice > 0 && !input.billingExempt ? true : false,
      billing_unknown: true,
      retry_safe: false,
    }, { status: 503 });
  }

  // Temporary local files are the delivery boundary. Provider media URLs stay
  // only in the private provider checkpoint; the signed local delivery URL and
  // its cache entry both expire in 30 minutes and never enter the asset store.
  // Keep one result per input and preserve its original index. The distinct-link
  // wrapper expands this ordered array back to duplicate inputs; splitting
  // successful and failed rows would shift later results onto the wrong URL.
  const deliveredVideos = videoResults.map(video => {
    const deliveredVideo = { ...video };
    delete deliveredVideo.url;
    delete deliveredVideo.download_url;
    delete deliveredVideo.cover;
    if (video.success) delete deliveredVideo.asset_id;
    return deliveredVideo;
  });
  return NextResponse.json({
    success: true,
    videos: deliveredVideos,
    texts: [],
    source: settlement.source,
    provider_tasks: input.providerTasks,
    charged,
    billing_replayed: billingReplayed,
    price: totalPrice,
    ...(input.providerProblem ? { provider_problem: input.providerProblem } : {}),
  });
}

async function recoverVideoFromCheckpoint(request: NextRequest, record: ExtractionAttemptRecord) {
  const cozeCheckpoint = readCozeVideoCheckpoint(record);
  const ppt6Checkpoint = readPpt6VideoCheckpoint(record);
  if (!cozeCheckpoint && !ppt6Checkpoint) return null;
  const authorization = await authorizeExtractionRequest(request);
  if (!authorization.ok || authorization.userId !== record.userId) {
    return authorization.ok
      ? NextResponse.json({ success: false, error: "提取任务不属于当前账号" }, { status: 403 })
      : authorization.response;
  }
  const requestPlan = await readDistinctVideoRequestPlan(request);
  const checkpointVideoCount = cozeCheckpoint?.videos.length ?? ppt6Checkpoint?.videos.length ?? 0;
  if (!requestPlan || !validDistinctVideoCheckpointCardinality(requestPlan, checkpointVideoCount)) {
    return NextResponse.json({
      success: false,
      error: "已保存的视频结果无法与原输入逐项对应，请保留原请求号交由管理员核对",
      error_code: "EXTRACTION_RESULT_MAPPING_UNKNOWN",
      upstream_completed: true,
      provider_call_started: true,
      charged: false,
      retry_safe: false,
    }, { status: 503 });
  }
  if (cozeCheckpoint) {
    const response = await persistAndSettleCozeVideos({
      ...cozeCheckpoint,
      userId: record.userId,
      clientRequestId: record.clientRequestId,
    });
    return expandDistinctVideoRecoveryResponse(response, requestPlan);
  }
  const response = await persistAndSettleCozeVideos({
    ...ppt6Checkpoint!,
    providerTasks: [],
    userId: record.userId,
    clientRequestId: record.clientRequestId,
    settlement: {
      keySuffix: "ppt6-video",
      description: "视频提取",
      modelId: "extract_video",
      source: "ppt6",
      logLabel: "Extract-PPT6",
    },
  });
  return expandDistinctVideoRecoveryResponse(response, requestPlan);
}

// ============ 主处理逻辑 ============

async function handlePost(request: NextRequest) {
  try {
    // Auth check
    const authorization = await authorizeExtractionRequest(request);
    if (!authorization.ok) return authorization.response;
    const userId = authorization.userId;
    const userRole = authorization.role;
    // 跨渠道共享的结算状态：必须在 handlePost 函数级声明，
    // 各提取分支（视频/文案/绘图/兜底结算）都读写同一份。
    let extractCharged = false;
    let billingReplayed = false;
    let settlementStarted = false;
    function unresolvedSettlement() {
      return NextResponse.json({
        success: false,
        error: "提取已完成但结算记录未确认，请按请求号对账；本次已停止自动重提",
        upstream_completed: true,
        charged: null,
        billing_unknown: true,
        provider_call_started: true,
        retry_safe: false,
      }, { status: 503 });
    }

    let body: ExtractRequest;
    try {
      const rawBody = await request.text();
      console.log("[Extract] request_body_chars:", rawBody.length);
      body = JSON.parse(rawBody);
    } catch (e) {
      console.error("[Extract] Failed to parse request body:", e);
      return NextResponse.json({ error: "请求体解析失败" }, { status: 400 });
    }
    const requestIdentity = resolveClientRequestId(request, body);
    if ("response" in requestIdentity) return requestIdentity.response;
    const { clientRequestId } = requestIdentity;
    const { links, extraction_mode, douyin_share_text } = body;

    if (!links || !Array.isArray(links) || links.length === 0 || links.length > 30 || links.some(link => typeof link !== "string" || !link.trim())) {
      return NextResponse.json({ error: "请提供有效的链接列表" }, { status: 400 });
    }

    if (!["video", "text", "batch"].includes(extraction_mode)) {
      return NextResponse.json({ error: "请选择提取模式" }, { status: 400 });
    }

    // Each video URL owns an independent idempotency, timeout and settlement
    // boundary. The desktop client may accept multiple lines, but submits them
    // one by one so a slow supplier response cannot strand an entire batch.
    if (extraction_mode === "video" && links.length !== 1) {
      return NextResponse.json({
        success: false,
        error: "一次视频提取只处理一个链接；多行输入会由工具箱逐条创建独立任务",
        error_code: "EXTRACTION_VIDEO_SINGLE_LINK_REQUIRED",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
        videos: [],
      }, { status: 400 });
    }

    // 视频与文案共用同一个 active coze_multifunction_extract 三合一插件。
    // 这里绝不向旧 PPT6 通道新提交，也不在 Coze 结果未知时切换供应商。
    if (extraction_mode === "video") {
      const cozeVideoConfig = await getCozeMultifunctionConfig();
      if (!cozeVideoConfig?.apiUrl || !cozeVideoConfig.apiToken) {
        return NextResponse.json({
          success: false,
          error: "三合一提取插件未配置完整，视频提取暂不可用；本次未调用上游服务",
          error_code: "EXTRACTION_PROVIDER_CONFIG_UNAVAILABLE",
          provider_call_started: false,
          charged: false,
          retry_safe: true,
          videos: [],
        }, { status: 503 });
      }
      // 平台统一计费合同：管理员账号也按公开售价结算，不能绕过余额预检或收入记录。
      const billingExempt = false;
      const insufficient = await precheckCash(cozeVideoConfig.pricePerUse, 1, userId);
      if (insufficient) return insufficient;

      const videoResults: VideoItem[] = [];
      const providerTasks: Array<{ task_id: string }> = [];
      const workflowInput = douyin_share_text?.trim() || links[0].trim();
      let workflowOutput: CozeWorkflowOutput;
      try {
        console.log(`[Extract] provider=coze_multifunction_extract action=video_extract host=${providerLogHost(cozeVideoConfig.apiUrl)} status=request_started`);
        workflowOutput = await callCozeWorkflow(cozeVideoConfig, workflowInput, "video", 0, 1);
        if (workflowOutput.provider_task_id) {
          providerTasks.push({ task_id: workflowOutput.provider_task_id });
        }
      } catch (error) {
        console.error("[Extract-Coze] 三合一视频提取失败:", error instanceof Error ? error.message : "unknown");
        const failure = cozeWorkflowFailure(error);
        const terminal = error instanceof CozeWorkflowExecutionError && error.terminal;
        const providerTaskId = error instanceof CozeWorkflowExecutionError ? error.providerTaskId : undefined;
        return NextResponse.json({
          ...failure,
          error: terminal
            ? "三合一工作流未成功返回视频，本次未扣费。"
            : "三合一视频结果暂未确认，原请求已保留，本次未扣费。",
          error_code: terminal ? "EXTRACTION_PROVIDER_REJECTED" : "EXTRACTION_PROVIDER_OUTCOME_UNKNOWN",
          source: "coze_workflow",
          videos: [],
          provider_tasks: providerTaskId ? [{ task_id: providerTaskId }] : [],
          retry_safe: terminal,
        }, { status: 503 });
      }

      const providerProblem = extractionProviderProblem(workflowOutput.final_result);
      const captions = Array.isArray(workflowOutput.captions) ? workflowOutput.captions.slice(0, 1) : [];
      for (const [index, caption] of captions.entries()) {
        const pageUrl = boundedProviderMediaUrl(caption.url);
        const directVideoUrl = boundedProviderMediaUrl(caption.video_url);
        const title = boundedProviderText(caption.desc);
        const cover = boundedProviderMediaUrl(caption.cover);

        // The shared three-in-one workflow is the only provider boundary for
        // new video requests. Its direct media URL must be present; a missing
        // URL is a terminal, uncharged result and never triggers another
        // provider or the legacy aweme-id resolver.
        if (directVideoUrl) {
          videoResults.push({
            row: index,
            col: 0,
            platform: "douyin",
            success: true,
            url: pageUrl || directVideoUrl,
            download_url: directVideoUrl,
            cover,
            title,
          });
          continue;
        }
        videoResults.push({
          row: index,
          col: 0,
          platform: "douyin",
          success: false,
          error: "三合一工作流未返回可用视频直链",
          title,
        });
      }

      const successfulVideos = videoResults.filter(video => video.success);
      if (successfulVideos.length === 0) {
        return NextResponse.json({
          success: false,
          error: videoResults[0]?.error || "三合一工作流未返回可下载视频",
          videos: videoResults,
          texts: [],
          source: "coze_workflow",
          provider_tasks: providerTasks,
          upstream_completed: true,
          provider_call_started: true,
          charged: false,
          retry_safe: true,
        }, { status: 422 });
      }

      try {
        await checkpointExtractionProviderResult({
          schema: "coze_video_provider_result.v1",
          videos: videoResults,
          providerTasks,
          unitPrice: cozeVideoConfig.pricePerUse,
          costPrice: cozeVideoConfig.costPrice,
          billingExempt,
          userRole: userRole as "admin" | "student",
          ...(providerProblem ? { providerProblem: providerProblem.message } : {}),
        });
      } catch {
        return NextResponse.json({
          success: false,
          error: "视频提取结果暂未完成保存，原请求已保留，本次未扣费。",
          charged: false,
          retry_safe: false,
          upstream_completed: true,
          provider_call_started: true,
          provider_tasks: providerTasks,
        }, { status: 503 });
      }
      return persistAndSettleCozeVideos({
        videos: videoResults,
        providerTasks,
        userId,
        clientRequestId,
        unitPrice: cozeVideoConfig.pricePerUse,
        costPrice: cozeVideoConfig.costPrice,
        billingExempt,
        userRole: userRole as "admin" | "student",
        ...(providerProblem ? { providerProblem: providerProblem.message } : {}),
      });
    }
    // 🔒 20260914 审计#P2修复：真实余额预检（此前为恒null测试桩且未await查询）
    async function precheckCash(unitPrice: number, count: number | undefined, userId: string) {
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return NextResponse.json({
          success: false,
          error: "提取价格配置无效，本次未调用供应商",
          error_code: "EXTRACTION_PRICE_INVALID",
          provider_call_started: false,
          charged: false,
          retry_safe: true,
        }, { status: 503 });
      }
      if (unitPrice === 0) return null;
      if (!userId) {
        return NextResponse.json({
          success: false,
          error: "账户信息不可用，本次未调用供应商",
          error_code: "EXTRACTION_ACCOUNT_UNAVAILABLE",
          provider_call_started: false,
          charged: false,
          retry_safe: true,
        }, { status: 503 });
      }
      // Quote with the same cent precision used by the atomic wallet settlement.
      // Otherwise a fractional unit price can pass precheck and fail only after
      // the supplier has already produced a result.
      const amount = extractionTotalPrice(unitPrice, count || 1);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({
          success: false,
          error: "提取计费金额无效，本次未调用供应商",
          error_code: "EXTRACTION_AMOUNT_INVALID",
          provider_call_started: false,
          charged: false,
          retry_safe: true,
        }, { status: 503 });
      }
      const db = getSupabaseAdminClient();
      const { data, error } = await db.from('users').select('cash_balance').eq('id', userId).maybeSingle();
      if (error || !data) {
        return NextResponse.json({
          success: false,
          error: "余额服务暂不可用，本次未调用供应商，请稍后重试",
          error_code: "EXTRACTION_BALANCE_PRECHECK_UNAVAILABLE",
          provider_call_started: false,
          charged: false,
          retry_safe: true,
        }, { status: 503 });
      }
      const shortage = `余额不足：本次提取需 ${amount} 元，请先充值`;
      return Number(data.cash_balance) >= amount ? null : NextResponse.json({
        success: false,
        error: shortage,
        error_code: "EXTRACTION_BALANCE_INSUFFICIENT",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 402 });
    }

    async function callCozeWorkflowTextExtract(
      inputLinks: string[],
    ): Promise<{ texts: WorkflowOutput["texts"]; allFailed: boolean }> {
      const wfTexts: WorkflowOutput["texts"] = [];
      let anySuccess = false;
      const cozeConfig = await getCozeMultifunctionConfig();
      if (!cozeConfig?.apiUrl || !cozeConfig.apiToken) {
        for (let index = 0; index < inputLinks.length; index++) {
          wfTexts.push({
            row: wfTexts.length + 1,
            col: 1,
            platform: "douyin",
            success: false,
            content: "",
            corrected_content: "",
            title: "",
            error: "扣子工作流未配置",
          });
        }
        return { texts: wfTexts, allFailed: true };
      }
      for (const inputText of inputLinks) {
        try {
          const wfOutput = await callCozeWorkflow(cozeConfig, inputText, "video", 0, 1);
          for (const item of cozeCaptionResults(wfOutput, "single_video", 1)) {
            if (item.success) anySuccess = true;
            wfTexts.push({
              row: wfTexts.length + 1,
              col: 1,
              platform: "douyin",
              success: item.success,
              content: item.content || "",
              corrected_content: item.content || "",
              title: item.title,
              author: item.author,
              ...(item.error ? { error: item.error } : {}),
            });
          }
        } catch (error) {
          wfTexts.push({
            row: wfTexts.length + 1,
            col: 1,
            platform: "douyin",
            success: false,
            content: "",
            corrected_content: "",
            title: "",
            error: `工作流调用异常: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return { texts: wfTexts, allFailed: !anySuccess };
    }

// ============ 文案提取模式：根据管理后台"生效插件"决定渠道 ============
    // ★ 渠道优先级（文案提取）：
    //   0. 扣子三合一工作流（coze_multifunction_extract）— 最高优先级，支持单视频/博主主页/搜索
    //   1. Cyanlis 渠道（extract_text_third_party, provider=cyanlis）：直接调用 video_to_text API 一步提取
    //   2. PPT6 渠道（extract_text_third_party, response_format=ppt6）：PPT6获取视频URL → ASR转写口播文案
    //   3. 方案二（extract_workflow）：douyin.wtf+ASR → 方案一（Coze工作流）兜底
    const textActivePluginRole = await getActiveTextExtractPluginRole();
    
    if (extraction_mode === "text" || extraction_mode === "batch") {
      console.log(`[Extract] 文案提取模式：管理后台生效插件role=${textActivePluginRole || "无"} → 决定渠道`);
    } else {
      console.log(`[Extract] 视频提取模式：继续走方案二（内置多源解析）`);
    }

    // ============ 渠道-1（最高优先级）：扣子三合一文案提取工作流 ============
    // 当 coze_multifunction_extract 插件激活时，文案提取和批量提取优先走此渠道
    const cozeMultifunctionConfig = (extraction_mode === "text" || extraction_mode === "batch") ? await getCozeMultifunctionConfig() : null;

    if ((extraction_mode === "text" || extraction_mode === "batch") && cozeMultifunctionConfig) {
      const cozeMaxCount = Math.min(10, cozeMultifunctionConfig.maxVideosPerBatch);
      const requestedCount = links.reduce((count, link, index) => {
        const input = (douyin_share_text && index === 0) ? douyin_share_text : link;
        return count + (detectCozeMode(input) === "single_video" ? 1 : cozeMaxCount);
      }, 0);
      const insufficient = await precheckCash(cozeMultifunctionConfig.pricePerUse, requestedCount, userId);
      if (insufficient) return insufficient;
      console.log(`[Extract] 扣子三合一工作流可用，作为最高优先级渠道`);
      try {
        const cozeTexts: WorkflowOutput["texts"] = [];
        let cozeAnySuccess = false;
        let cozeSuccessCount = 0;
        const cozeTaskIds: string[] = [];
        let cozeOutputProblem: ReturnType<typeof extractionProviderProblem>;

        for (let i = 0; i < links.length; i++) {
          // ★ 优先使用完整的抖音分享文本（含描述/标签），工作流识别率更高
          const inputText = (douyin_share_text && i === 0) ? douyin_share_text : links[i];
          console.log(`[Extract-Coze] 处理第 ${i + 1}/${links.length} 条: ${inputText.substring(0, 80)}`);

          try {
            const inputMaxCount = detectCozeMode(inputText) === "single_video" ? 1 : cozeMaxCount;
            const output = await callCozeWorkflow(cozeMultifunctionConfig, inputText, undefined, 0, inputMaxCount);
            if (output.provider_task_id) cozeTaskIds.push(output.provider_task_id);
            cozeOutputProblem ||= extractionProviderProblem(output.final_result);
            for (const item of cozeCaptionResults(output, detectCozeMode(inputText), inputMaxCount)) {
              cozeTexts.push({ row: cozeTexts.length, col: 0, platform: 'douyin', success: item.success,
                content: item.content || '', corrected_content: '', title: item.title, author: item.author,
                source: 'coze_workflow', ...(item.error ? { error: item.error } : {}) });
              if (item.success) { cozeAnySuccess = true; cozeSuccessCount++; }
            }
          } catch (cozeErr) {
            console.error(`[Extract-Coze] 第 ${i + 1} 条提取失败:`, cozeErr);
            return NextResponse.json({
              ...cozeWorkflowFailure(cozeErr), source: "coze_workflow",
              provider_tasks: cozeTaskIds.map(task_id => ({ task_id })),
            }, { status: 503 });
          }
        }

        const providerProblem = cozeTexts.map(item => extractionProviderProblem(item.error)).find(Boolean) || cozeOutputProblem;
        for (const item of cozeTexts) {
          const problem = extractionProviderProblem(item.error);
          if (problem) item.error = problem.message;
        }
        // 扣子工作流有成功结果，直接返回
        if (cozeAnySuccess) {
          try {
            await checkpointExtractionProviderResult({ texts: cozeTexts, videos: [], source: "coze_workflow", provider_tasks: cozeTaskIds.map(task_id => ({ task_id })), upstream_completed: true });
          } catch {
            return NextResponse.json({ success: false, error: "提取正文暂未完成保存，原请求已保留，本次未扣费。", charged: false, billing_unknown: false, retry_safe: false, upstream_completed: true, provider_tasks: cozeTaskIds.map(task_id => ({ task_id })) }, { status: 503 });
          }
          const cozePrice = cozeMultifunctionConfig.pricePerUse;
          const totalCost = extractionTotalPrice(cozePrice, cozeSuccessCount);
          if (cozeSuccessCount > 0) {
            const settlementKey = `extract:${clientRequestId}:coze-charge`;
            if (totalCost > 0) {
            const deductResult = await deductCash(
              userId,
              totalCost,
              `扣子工作流文案提取 ${cozeSuccessCount} 条`,
              settlementKey,
            ).catch(() => ({ success: false, alreadyFulfilled: false }));
            if (!deductResult.success) {
              return NextResponse.json({
                success: false,
                error: "提取已完成，费用正在确认。原请求已保留，请稍后刷新状态。",
                videos: [],
                texts: cozeTexts,
                provider_tasks: cozeTaskIds.map(task_id => ({ task_id })),
                upstream_completed: true, provider_call_started: true,
                charged: null, billing_unknown: true, retry_safe: false,
              }, { status: 503 });
            }
            extractCharged = true;
            billingReplayed = Boolean(deductResult.alreadyFulfilled);
            }
            try {
              await recordRevenue({
                userId,
                userRole: userRole as "admin" | "student",
                modelId: "coze_multifunction_extract",
                taskId: settlementKey,
                costPrice: extractionTotalPrice(cozeMultifunctionConfig.costPrice, cozeSuccessCount),
                sellingPrice: totalCost,
                recordType: "extract",
                cashCharged: totalCost,
              });
            } catch (error) {
              console.error("[Extract-Coze] 收益落账失败:", error);
              return NextResponse.json({
                success: false,
                error: "提取已完成，账务正在确认。原请求已保留，请稍后用相同请求刷新状态。",
                videos: [],
                texts: [],
                provider_tasks: cozeTaskIds.map(task_id => ({ task_id })),
                upstream_completed: true,
                charged: totalCost > 0,
                billing_unknown: true,
                retry_safe: false,
              }, { status: 503 });
            }
          }

          return NextResponse.json({
            success: true,
            message: `扣子工作流文案提取完成，共 ${cozeSuccessCount} 条`,
            provider_tasks: cozeTaskIds.map(task_id => ({ task_id })),
            texts: cozeTexts,
            videos: [],
            summary: `扣子工作流提取成功 ${cozeSuccessCount} 条`,
            source: "coze_workflow",
            charged: extractCharged,
            billing_replayed: billingReplayed,
          });
        }

        // The workflow returned a final failure; preserve it without dispatching another provider.
        return NextResponse.json({
          success: false, message: `${providerProblem?.message || "未提取到口播文案。"}本次未扣费。`, texts: cozeTexts, videos: [],
          ...(providerProblem ? { error: `${providerProblem.message}本次未扣费。`, code: providerProblem.code } : {}),
          source: "coze_workflow", charged: false, upstream_completed: true,
          provider_tasks: cozeTaskIds.map(task_id => ({ task_id })),
        });
      } catch (cozeErr) {
        console.error(`[Extract-Coze] 工作流或结算状态未确认:`, cozeErr);
        return NextResponse.json({
          success: false, error: "这次提取的结算结果暂未确认，原请求已保留。请稍后刷新状态。",
          source: "coze_workflow", charged: null, billing_unknown: true,
          provider_call_started: true, retry_safe: false,
        }, { status: 503 });
      }
    }

    const textThirdPartyConfig = (extraction_mode === "text" || extraction_mode === "batch")
      && textActivePluginRole === "extract_text_third_party"
      ? await getTextExtractThirdPartyConfig()
      : null;

    // ============ 渠道0：Cyanlis 直接API（文案提取） ============
    // 当 extract_text_third_party 的 provider=cyanlis 时，直接调用 video_to_text API 一步提取文案
    // 比PPT6+ASR更简单高效，一个API调用即可获得口播文案
    const cyanlisConfig: CyanlisConfig | null = textThirdPartyConfig?.provider === "cyanlis" && textThirdPartyConfig.apiKey
      ? { apiBaseUrl: textThirdPartyConfig.apiUrl || "https://cyanlis.cn", apiKey: textThirdPartyConfig.apiKey, provider: "cyanlis" }
      : null;
    const isCyanlisTextChannel = textActivePluginRole === "extract_text_third_party" && cyanlisConfig && textThirdPartyConfig?.provider === "cyanlis";

    if ((extraction_mode === "text" || extraction_mode === "batch") && isCyanlisTextChannel) {
      const insufficient = await precheckCash(textThirdPartyConfig!.pricePerUse, undefined, userId);
      if (insufficient) return insufficient;
      console.log(`[Extract] Cyanlis渠道文案提取：直接调用 video_to_text API`);
      try {
        const cyanlisTextResults: WorkflowOutput["texts"] = [];
        let cyanlisAnySuccess = false;

        for (let i = 0; i < links.length; i++) {
          const inputText = links[i];
          const parsedUrl = parseDouyinInput(inputText);
          const urlStr = parsedUrl
            ? (parsedUrl.url || (parsedUrl.videoId ? `https://www.douyin.com/video/${parsedUrl.videoId}` : null))
            : null;
          const effectiveUrl = urlStr || inputText;

          try {
            console.log(`[Extract] Cyanlis video_to_text (${i + 1}/${links.length}): ${effectiveUrl.substring(0, 100)}`);
            const result = await getDouyinVideoToText(cyanlisConfig!, effectiveUrl);

            if (result.success && result.text) {
              // Cyanlis video_to_text 返回的 caption/desc 就是口播文案
              const caption = result.caption || result.desc || "";
              const content = result.text || caption;
              const title = result.desc || result.caption || "";
              const nickname = result.nickname || "";

              if (content.trim().length > 0) {
                console.log(`[Extract] Cyanlis文案提取成功: length=${content.length}, author=${nickname}`);
                cyanlisAnySuccess = true;
                cyanlisTextResults.push({
                  row: i + 1, col: 1, platform: "douyin",
                  success: true,
                  content,
                  corrected_content: content,
                  title,
                  author: nickname,
                  source: "cyanlis_video_to_text",
                });
              } else {
                cyanlisTextResults.push({
                  row: i + 1, col: 1, platform: "douyin",
                  success: false, content: "", corrected_content: "", title: "",
                  error: "文案提取未返回内容",
                  source: "cyanlis_video_to_text",
                });
              }
            } else {
              cyanlisTextResults.push({
                row: i + 1, col: 1, platform: "douyin",
                success: false, content: "", corrected_content: "", title: "",
                error: result.error || "文案提取服务调用失败",
                source: "cyanlis_video_to_text",
              });
            }
          } catch (err) {
            console.error(`[Extract] Cyanlis文案提取异常:`, err);
            cyanlisTextResults.push({
              row: i + 1, col: 1, platform: "douyin",
              success: false, content: "", corrected_content: "", title: "",
              error: `文案提取服务异常: ${err instanceof Error ? err.message : String(err)}`,
              source: "cyanlis_video_to_text",
            });
          }
        }

        if (cyanlisAnySuccess) {
          const successCount = cyanlisTextResults.filter(r => r.success).length;
          const failedCount = cyanlisTextResults.filter(r => !r.success).length;
          console.log(`[Extract] Cyanlis渠道结果：${successCount}成功/${failedCount}失败`);

          // 扣费
          const cyanlisPrice = textThirdPartyConfig!.pricePerUse;
          if (successCount > 0) {
            settlementStarted = true;
            const totalCost = extractionTotalPrice(cyanlisPrice, successCount);
            const settlementKey = `extract:${clientRequestId}:cyanlis-charge`;
            if (totalCost > 0) {
              const deductResult = await deductCash(
                userId,
                totalCost,
                `Cyanlis文案提取 ${successCount} 条`,
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
              extractCharged = true;
              billingReplayed = Boolean(deductResult.alreadyFulfilled);
            }
            await recordRevenue({
              userId, userRole: userRole as "admin" | "student",
              modelId: "cyanlis_video_to_text",
              taskId: settlementKey,
              costPrice: extractionTotalPrice(textThirdPartyConfig!.costPrice, successCount),
              sellingPrice: totalCost,
              recordType: "extract",
              cashCharged: totalCost,
            });
          }

          // 全部成功 → 直接返回
          if (failedCount === 0) {
            console.log(`[Extract] Cyanlis渠道全部成功(${successCount}条)，直接返回`);
            return NextResponse.json({
              success: true,
              texts: cyanlisTextResults,
              source: "cyanlis_video_to_text",
              chargeInfo: { charged: extractCharged, replayed: billingReplayed, price: cyanlisPrice, count: successCount },
            });
          }

          // 部分成功 → 返回Cyanlis成功的结果（失败的由用户重试或继续走方案二）
          console.log(`[Extract] Cyanlis部分成功(${successCount}/${links.length})，返回成功部分`);
          return NextResponse.json({
            success: true,
            texts: cyanlisTextResults,
            source: "cyanlis_video_to_text",
            chargeInfo: { charged: extractCharged, replayed: billingReplayed, price: cyanlisPrice, count: successCount },
          });
        }

        console.log(`[Extract] Cyanlis渠道全部失败，继续走方案二`);
      } catch (cyanlisErr) {
        if (settlementStarted) return unresolvedSettlement();
        console.error(`[Extract] Cyanlis渠道异常，继续走方案二:`, cyanlisErr);
      }
    }

    // ============ 渠道1：PPT6 第三方差价渠道（文案提取） ============
    // 仅当管理后台选了 extract_text_third_party 类型的插件且 provider 不是 cyanlis 时才走此渠道
    const textThirdPartySource = (textActivePluginRole === "extract_text_third_party" && textThirdPartyConfig && textThirdPartyConfig.provider !== "cyanlis") ? textThirdPartyConfig : null;

    if ((extraction_mode === "text" || extraction_mode === "batch") && textThirdPartySource && textThirdPartySource.apiUrl && textThirdPartySource.responseFormat === "ppt6") {
      const insufficient = await precheckCash(textThirdPartySource.pricePerUse, undefined, userId);
      if (insufficient) return insufficient;
      console.log(`[Extract] 尝试第三方差价渠道(${textThirdPartySource.name || "PPT6"})文案提取：PPT6获取视频URL → ASR转写口播文案`);
      try {
        const ppt6TextResults: WorkflowOutput["texts"] = [];
        let ppt6AnySuccess = false;

        for (let i = 0; i < links.length; i++) {
          const inputText = links[i];
          const parsedUrl = parseDouyinInput(inputText);

          try {
            const urlStr = parsedUrl
              ? (parsedUrl.url || (parsedUrl.videoId ? `https://www.douyin.com/video/${parsedUrl.videoId}` : null))
              : null;
            const effectiveUrl = urlStr || inputText;

            // 第一步：调用 PPT6 API 获取视频信息
            const ppt6Url = `${textThirdPartySource.apiUrl}?clientId=${encodeURIComponent(textThirdPartySource.clientId || "")}&clientSecretKey=${encodeURIComponent(textThirdPartySource.clientSecretKey || "")}&url=${encodeURIComponent(effectiveUrl)}`;
            console.log(`[Extract] provider=ppt6 action=text_extract host=${providerLogHost(textThirdPartySource.apiUrl)} status=request_started item=${i + 1}/${links.length}`);

            const ppt6Response = await fetch(ppt6Url, {
              method: "GET",
              headers: { "Accept": "application/json" },
              signal: AbortSignal.timeout(60000),
            });

            if (!ppt6Response.ok) {
              console.error(`[Extract] provider=ppt6 action=text_extract host=${providerLogHost(textThirdPartySource.apiUrl)} status=http_error http_status=${ppt6Response.status}`);
              ppt6TextResults.push({ row: i + 1, col: 1, platform: "douyin", success: false, content: "", corrected_content: "", title: "", error: `视频提取服务返回错误(${ppt6Response.status})` });
              continue;
            }

            const ppt6Result = await ppt6Response.json();
            console.log(`[Extract] provider=ppt6 action=text_extract host=${providerLogHost(textThirdPartySource.apiUrl)} status=response_received provider_code=${String(ppt6Result.code ?? "unknown")}`);

            // PPT6 响应格式: {code: 200, msg: "解析成功", data: {type, title, desc, cover, video_mp4, video_url, pics?}}
            // 官方文档: code==200 为成功；兼容 code==0 防止平台侧变更
            if ((ppt6Result.code === 200 || ppt6Result.code === 0) && ppt6Result.data) {
              const d = ppt6Result.data;
              const desc = d.desc || "";
              const title = d.title || "";
              const videoUrl = d.video_url || d.video_mp4 || d.video || "";

              // 第二步：ASR 语音转写，提取真正的口播文案
              let transcript: string | null = null;
              let transcriptMethod = "none";
              if (videoUrl) {
                console.log(`[Extract] PPT6获取到视频URL，开始ASR语音转写...`);
                try {
                  const transResult = await transcribeVideo(videoUrl, request.headers);
                  transcript = transResult.transcript;
                  transcriptMethod = transResult.method;
                  console.log(`[Extract] ASR转写完成: length=${transcript?.length || 0}`);
                } catch (asrErr) {
                  console.error(`[Extract] ASR转写异常:`, asrErr);
                }
              }

              const transcriptItem = buildPpt6TranscriptItem({
                index: i, transcript, method: transcriptMethod, title, description: desc,
              });
              ppt6TextResults.push(transcriptItem);
              ppt6AnySuccess ||= transcriptItem.success;
            } else {
              const errMsg = readableExtractionError(ppt6Result.msg || `PPT6解析失败(code:${ppt6Result.code})`, "text");
              ppt6TextResults.push({ row: i + 1, col: 1, platform: "douyin", success: false, content: "", corrected_content: "", title: "", error: errMsg, source: "ppt6_third_party" });
            }
          } catch (err) {
            console.error(`[Extract] provider=ppt6 action=text_extract host=${providerLogHost(textThirdPartySource.apiUrl)} status=request_failed error_type=${err instanceof Error ? err.name : "unknown"}`);
            ppt6TextResults.push({ row: i + 1, col: 1, platform: "douyin", success: false, content: "", corrected_content: "", title: "", error: readableExtractionError(err instanceof Error ? err.message : String(err), "text"), source: "ppt6_third_party" });
          }
        }

        // PPT6 第三方差价渠道成功提取文案
        if (ppt6AnySuccess) {
          const ppt6SuccessCount = ppt6TextResults.filter(r => r.success).length;
          const ppt6FailedCount = ppt6TextResults.filter(r => !r.success).length;

          // Preserve successful items and return per-item failures without resubmitting the batch.
          {
            console.log(`[Extract] 第三方差价渠道完成(${ppt6SuccessCount}成功/${ppt6FailedCount}失败)`);
            // 扣费
            const ppt6Price = textThirdPartySource.pricePerUse;
            if (ppt6SuccessCount > 0) {
              const totalCost = extractionTotalPrice(ppt6Price, ppt6SuccessCount);
              settlementStarted = true;
              const settlementKey = `extract:${clientRequestId}:ppt6-charge`;
              if (totalCost > 0) {
                const deductResult = await deductCash(
                  userId,
                  totalCost,
                  `第三方渠道文案提取 ${ppt6SuccessCount} 条`,
                  settlementKey,
                );
                if (!deductResult.success) {
                  return NextResponse.json({
                    success: false,
                    error: `计费未完成: ${deductResult.error || "统一钱包暂不可用"}`,
                    texts: [],
                    videos: [],
                    upstream_completed: true,
                    charged: false,
                  }, { status: 503 });
                }
                extractCharged = true;
                billingReplayed = Boolean(deductResult.alreadyFulfilled);
              }
              await recordRevenue({
                userId,
                userRole: userRole as "admin" | "student",
                modelId: "extract_text_third_party",
                taskId: settlementKey,
                costPrice: extractionTotalPrice(textThirdPartySource.costPrice, ppt6SuccessCount),
                sellingPrice: totalCost,
                recordType: "extract",
                cashCharged: totalCost,
              });
            }

            return NextResponse.json({
              success: true,
              texts: ppt6TextResults,
              videos: [],
              summary: `第三方渠道文案提取完成，${ppt6SuccessCount} 条成功，${ppt6FailedCount} 条失败${textThirdPartySource.siteName ? ` (${textThirdPartySource.siteName})` : ""}`,
              mode: "text",
              channel: "ppt6_third_party",
              charged: extractCharged,
              billing_replayed: billingReplayed,
              price: ppt6Price,
            });
          }

        }
        // This channel already attempted transcription. Keep the failed item
        // instead of submitting the same media to another recognition provider.
        return NextResponse.json({
          success: false,
          message: "未提取到有效口播正文，标题和描述未作为提取结果",
          texts: ppt6TextResults,
          videos: [],
          mode: "text",
          channel: "ppt6_third_party",
          charged: false,
        });
      } catch (ppt6Err) {
        if (settlementStarted) return unresolvedSettlement();
        console.error(`[Extract] PPT6第三方差价渠道异常，继续走方案二:`, ppt6Err);
      }
    }

    // ============ 方案二（主方案）：douyin.wtf + ASR/LLM ============
    const fallbackPricing = resolveExtractionFallbackPricing();
    if (!fallbackPricing) {
      return NextResponse.json({
        success: false,
        error: "备用提取链路的售价或成本未明确配置，本次未调用上游服务",
        error_code: "EXTRACTION_FALLBACK_PRICING_NOT_CONFIGURED",
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      }, { status: 503 });
    }
    const insufficient = await precheckCash(fallbackPricing.pricePerUse, undefined, userId);
    if (insufficient) return insufficient;
    console.log(`[Extract] 方案二：使用 douyin.wtf + ASR/LLM 提取`);

    const results: Array<{
      input: string;
      success: boolean;
      error?: string;
      video?: DouyinVideoResult;
      transcript?: string | null;
      transcriptMethod?: string;
    }> = [];

    for (const link of links) {
      const parsed = parseDouyinInput(link);
      console.log(`[Extract] 输入: ${link}, 解析结果:`, JSON.stringify(parsed));

      if (!parsed) {
        results.push({
          input: link,
          success: false,
          error: "无法识别的链接格式，请输入抖音分享链接或视频ID",
        });
        continue;
      }

      let videoId = parsed.videoId;

      // 如果是短链接，尝试解析出视频ID
      if (parsed.type === "short_url" && parsed.url) {
        videoId = await resolveShortUrl(parsed.url) || undefined;
        if (!videoId) {
          results.push({
            input: link,
            success: false,
            error: "短链接解析失败，请使用完整链接（https://www.douyin.com/video/xxx）或直接输入视频ID",
          });
          continue;
        }
      }

      if (!videoId) {
        results.push({
          input: link,
          success: false,
          error: "无法获取视频ID，请提供完整的抖音视频链接",
        });
        continue;
      }

      // 调用 douyin.wtf API
      console.log(`[Extract] 视频ID: ${videoId}, 开始调用 douyin.wtf API...`);
      const videoResult = await fetchDouyinVideoMultiSource(videoId);
      console.log(`[Extract] douyin.wtf 结果:`, videoResult ? `成功 desc=${videoResult.desc?.substring(0, 50)}` : 'null');

      if (videoResult) {
        // 文案提取模式：使用 ASR + LLM 双引擎提取视频语音文案
        let transcript: string | null = null;
        let transcriptMethod = "none";
        if (extraction_mode !== "video" && videoResult.videoUrl) {
          console.log(`[Extract] 文案提取模式，开始语音转文字...`);
          const transResult = await transcribeVideo(videoResult.videoUrl, request.headers);
          transcript = transResult.transcript;
          transcriptMethod = transResult.method;
          console.log(`[Extract] 语音转文字完成: method=${transcriptMethod}, length=${transcript?.length || 0}`);
        }

        results.push({
          input: link,
          success: true,
          video: videoResult,
          transcript,
          transcriptMethod,
        });
      } else {
        results.push({
          input: link,
          success: false,
          error: "视频信息获取失败，该视频可能已被删除或设为私密",
        });
      }
    }

    // 返回方案二结果（统一为 WorkflowOutput 格式，前端无需修改）
    const videos: WorkflowOutput["videos"] = [];
    const texts: WorkflowOutput["texts"] = [];

    let hasAnySuccess = false;
    for (const [index, r] of results.entries()) {
      if (extraction_mode === "video" && r.success && r.video && r.video.videoUrl) {
        hasAnySuccess = true;
        videos.push({
          row: index + 1,
          col: 1,
          platform: "douyin",
          success: true,
          url: r.video.videoUrl || "",
          download_url: r.video.videoUrl || "",
          title: r.video.desc || "",
          cover: r.video.coverUrl || "",
        });
      } else if (extraction_mode === "video") {
        videos.push({ row: index + 1, col: 1, platform: "douyin", success: false, error: r.error || "未提取到视频链接" });
      }
      if (extraction_mode !== "video" && r.transcript?.trim()) {
        hasAnySuccess = true;
        texts.push({
          row: index + 1,
          col: 1,
          platform: "douyin",
          success: true,
          content: r.transcript,
          corrected_content: r.transcript,
          title: r.video?.desc || "",
        });
      } else if (extraction_mode !== "video") {
        texts.push({ row: index + 1, col: 1, platform: "douyin", success: false, content: "", corrected_content: "", title: r.video?.desc || "", error: r.error || "未提取到有效口播文案" });
      }
    }

    // ★ 方案二文案提取失败 → 尝试方案一（Coze 三合一工作流）作为备选
    if (!hasAnySuccess && extraction_mode !== "video") {
      console.log(`[Extract] 方案二文案提取全部失败，尝试方案一（Coze 三合一工作流）备选...`);
      try {
        const wfResult = await callCozeWorkflowTextExtract(links);
        if (!wfResult.allFailed) {
          // 方案一成功，合并结果
          texts.splice(0, texts.length, ...wfResult.texts);
          hasAnySuccess = true;
          console.log(`[Extract] 方案一备选成功，获取 ${wfResult.texts.filter(t => t.success).length} 条文案`);
        } else {
          console.log(`[Extract] 方案一备选也全部失败`);
        }
      } catch (wfErr) {
        console.error(`[Extract] 方案一备选异常:`, wfErr);
      }
    }

    // 扣费
    if (hasAnySuccess && extraction_mode === "video") {
      try {
        await attachTemporaryExtractionVideos(videos, userId, clientRequestId);
      } catch (error) {
        console.error("[Extract] 回退视频临时交付失败:", error instanceof Error ? error.message : "unknown");
        return NextResponse.json({
          success: false,
          error: "视频已解析，但30分钟临时文件准备失败。本次未扣费，请稍后重新提取。",
          error_code: "EXTRACTION_TEMPORARY_MEDIA_FAILED",
          upstream_completed: true,
          provider_call_started: true,
          retry_safe: false,
          charged: false,
        }, { status: 503 });
      }
    }
    const fallbackSuccessCount = extraction_mode === "video" ? videos.filter(item => item.success).length : texts.filter(item => item.success && item.content?.trim()).length;
    const fallbackTotal = extractionTotalPrice(fallbackPricing.pricePerUse, fallbackSuccessCount);
    if (hasAnySuccess && !extractCharged) {
      try {
        const settlementKey = `extract:${clientRequestId}:fallback-charge`;
        if (fallbackTotal > 0) {
          const deductResult = await deductCash(
            userId,
            fallbackTotal,
            `文案提取: ${texts[0]?.title || videos[0]?.title || ""}`,
            settlementKey,
          );
          if (!deductResult.success) {
            return NextResponse.json({
              success: false,
              error: `计费未完成: ${deductResult.error || "统一钱包暂不可用"}`,
              videos: [],
              texts: [],
              upstream_completed: true,
              charged: false,
            }, { status: 503 });
          }
          extractCharged = true;
          billingReplayed = Boolean(deductResult.alreadyFulfilled);
        }
        await recordRevenue({
          userId,
          userRole: userRole as "admin" | "student",
          modelId: "extract",
          taskId: settlementKey,
          costPrice: extractionTotalPrice(fallbackPricing.costPrice, fallbackSuccessCount),
          sellingPrice: fallbackTotal,
          recordType: "extract",
          cashCharged: fallbackTotal,
        });
      } catch (e) {
        console.error("[Extract] 结算异常:", e);
        return NextResponse.json({
          success: false,
          error: "计费服务异常，本次结果未交付",
          videos: [],
          texts: [],
          upstream_completed: true,
          charged: false,
        }, { status: 503 });
      }
    }

    if (extraction_mode === "video") {
      for (const video of videos) {
        if (video.success !== false && video.temporary_url) {
          delete video.url;
          delete video.download_url;
          delete video.asset_id;
          delete video.cover;
          const privateFields = video as unknown as Record<string, unknown>;
          for (const field of [
            "downloadUrl", "video_url", "videoUrl", "video_mp4", "videoMp4",
            "play_url", "playUrl", "cover_url", "coverUrl", "dynamic_cover",
            "dynamicCover", "avatar", "avatar_url", "avatarUrl", "music_url",
            "musicUrl",
          ]) delete privateFields[field];
        }
      }
    }

    return NextResponse.json({
      success: hasAnySuccess,
      message: hasAnySuccess ? "提取成功" : (extraction_mode === "text" ? "文案提取失败，请检查链接是否有效或稍后重试" : "视频提取失败，请检查链接是否有效或稍后重试"),
      videos,
      texts,
      summary: hasAnySuccess ? "" : results.map((r) => r.error).filter(Boolean).join("; "),
      charged: extractCharged,
      billing_replayed: billingReplayed,
    } as WorkflowOutput);
  } catch (error) {
    console.error("[Extract API] Error:", error);
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
      { error: "提取服务异常，请稍后重试" },
      { status: 500 }
    );
  }
}

export const POST = withExtractionExactlyOnce(
  "single",
  withDistinctExtractionLinks(handlePost, input => detectCozeMode(input) === "single_video"),
  { recoverFromProviderCheckpoint: recoverVideoFromCheckpoint },
);
