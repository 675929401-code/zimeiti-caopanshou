// Cyanlis API 统一客户端 — 封装 cyanlis.cn 平台的全部 API 插件调用
// 支持抖音/小红书各类数据采集与处理能力

import { getSupabaseClient } from "@/storage/database/supabase-client";

// ============ 类型定义 ============

export interface CyanlisConfig {
  apiBaseUrl: string; // https://cyanlis.cn
  apiKey: string;     // UUID 格式的 API Key
  provider: string;   // "cyanlis"
}

// 抖音视频详情 — 内部 data 结构
interface DouyinDetailData {
  aweme_id: string;
  desc: string;
  caption: string;
  create_time: number;
  author_id: string;
  nickname: string;
  unique_id: string;
  signature: string;
  cover: string;
  video_url: string;
  duration: number;
  digg_count: number;
  comment_count: number;
  collect_count: number;
  share_count: number;
  music_title: string;
  play_url: string;
  pics?: string[];
  type?: number; // 1=视频, 2=图文
}

// 抖音视频转文字 — 内部 data 结构
interface DouyinVideoToTextData {
  desc: string;
  nickname: string;
  caption: string;
  digg_count: number;
  video_url: string;
  cover: string;
  duration: number;
}

// 抖音用户作品列表 — 内部 data 结构
interface DouyinUserPostsData {
  hasMore: string; // "0" or "1"
  cursor: string;
  list: Array<{
    aweme_id: string;
    desc: string;
    caption: string;
    create_time: number;
    digg_count: number;
    comment_count: number;
    video_url: string;
    cover: string;
    duration: number;
    author_id: string;
    nickname: string;
  }>;
}

// 抖音视频搜索 — 内部 data 结构
interface DouyinVideoSearchData {
  hasMore: string;
  cursor: string;
  list: Array<{
    aweme_id: string;
    desc: string;
    video_url: string;
    cover: string;
    digg_count: number;
    nickname: string;
  }>;
}

// 小红书笔记详情 — 内部 data 结构
interface XhsDetailData {
  note_id: string;
  title: string;
  desc: string;
  type: string; // "video" or "normal"
  video_url?: string;
  cover: string;
  pics?: string[];
  liked_count: number;
  comment_count: number;
  collect_count: number;
  share_count: number;
  user: {
    nickname: string;
    user_id: string;
  };
}

// ============ 配置获取 ============

/**
 * 从 plugins 表获取 Cyanlis API 配置
 * 查询条件：role 包含 extract 相关 + config.provider = cyanlis
 */
export async function getCyanlisConfig(): Promise<CyanlisConfig | null> {
  try {
    const supabase = getSupabaseClient();
    // 从任意含 cyanlis apiKey 的插件获取配置（同一平台共享密钥）
    // 不要求 is_active，因为 Cyanlis apiKey 是全局共享的
    const { data } = await supabase
      .from("plugins")
      .select("config")
      .filter("config->provider", "eq", "cyanlis")
      .limit(1)
      .maybeSingle();

    if (data) {
      const config = data.config as Record<string, string>;
      const apiKey = config.api_key || "";
      if (apiKey) {
        return {
          apiBaseUrl: config.api_base_url || "https://cyanlis.cn",
          apiKey,
          provider: config.provider || "cyanlis",
        };
      }
    }

    // 兜底2：从含 Cyanlis apiKey 的插件（含 provider 字段或在名称中）
    const { data: data2 } = await supabase
      .from("plugins")
      .select("config, name")
      .ilike("name", "%cyanlis%")
      .limit(1)
      .maybeSingle();

    if (data2) {
      const config = data2.config as Record<string, string>;
      const apiKey = config.api_key || "";
      if (apiKey) {
        return {
          apiBaseUrl: "https://cyanlis.cn",
          apiKey,
          provider: "cyanlis",
        };
      }
    }

    // 兜底：从环境变量读取
    const envKey = process.env.CYANLIS_API_KEY || "";
    if (envKey) {
      return {
        apiBaseUrl: "https://cyanlis.cn",
        apiKey: envKey,
        provider: "cyanlis",
      };
    }

    return null;
  } catch (err) {
    console.error("[CyanlisClient] getCyanlisConfig error:", err);
    return null;
  }
}

// ============ 通用请求方法 ============

async function cyanlisRequest<T>(
  config: CyanlisConfig,
  method: "GET" | "POST",
  endpoint: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
  timeoutMs = 30000
): Promise<{ success: boolean; data?: T; error?: string; cost?: string }> {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${endpoint}`);

  // GET 请求：apiKey 作为 query 参数
  if (method === "GET") {
    url.searchParams.append("apiKey", config.apiKey);
    Object.entries(params).forEach(([k, v]) => {
      if (v) url.searchParams.append(k, v);
    });
  }

  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };

  // POST 请求：apiKey 也作为 query 参数（Cyanlis 统一风格）
  if (method === "POST") {
    url.searchParams.append("apiKey", config.apiKey);
    if (Object.keys(body).length > 0) {
      options.body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(url.toString(), options);
    const result = await response.json();

    if (result.code === 0 && result.success) {
      return {
        success: true,
        data: result.data as T,
        cost: result.msg || "", // msg 中包含消耗信息
      };
    } else {
      return {
        success: false,
        error: result.msg || result.message || `Cyanlis API 错误(code=${result.code})`,
      };
    }
  } catch (err) {
    console.error(`[CyanlisClient] ${method} ${endpoint} error:`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============ 抖音 API ============

/**
 * 抖音视频详情 — 获取视频详细信息+无水印下载链接
 * POST /api/plugins/douyin/detail_v4
 */
export async function getDouyinVideoDetail(
  config: CyanlisConfig,
  shareUrl: string
): Promise<{ success: boolean; video_url?: string; cover?: string; desc?: string; caption?: string; nickname?: string; digg_count?: number; aweme_id?: string; error?: string }> {
  const result = await cyanlisRequest<DouyinDetailData>(
    config, "POST", "/api/plugins/douyin/detail_v4", {}, { url: shareUrl }
  );
  if (result.success && result.data) {
    const d = result.data;
    return {
      success: true,
      video_url: d.video_url || d.play_url || "",
      cover: d.cover || "",
      desc: d.desc || "",
      caption: d.caption || "",
      nickname: d.nickname || "",
      digg_count: d.digg_count || 0,
      aweme_id: d.aweme_id || "",
    };
  }
  return { success: false, error: result.error };
}

/**
 * 抖音视频转文字 — 一键从视频提取口播文案
 * GET /api/plugins/douyin/dy_video_to_text
 */
export async function getDouyinVideoToText(
  config: CyanlisConfig,
  shareUrl: string
): Promise<{ success: boolean; text?: string; desc?: string; caption?: string; nickname?: string; digg_count?: number; error?: string }> {
  const result = await cyanlisRequest<DouyinVideoToTextData>(
    config, "GET", "/api/plugins/douyin/dy_video_to_text", { url: shareUrl }
  );
  if (result.success && result.data) {
    const d = result.data;
    return {
      success: true,
      text: d.caption || d.desc || "",
      desc: d.desc || "",
      caption: d.caption || "",
      nickname: d.nickname || "",
      digg_count: d.digg_count || 0,
    };
  }
  return { success: false, error: result.error };
}

/**
 * 抖音音视频转文字 — ASR 将音频/视频转文字
 * POST /api/plugins/douyin/audio_to_text
 */
export async function getDouyinAudioToText(
  config: CyanlisConfig,
  audioUrl: string,
  durationMs?: number
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const result = await cyanlisRequest<{ text: string; duration: number }>(
    config, "POST", "/api/plugins/douyin/audio_to_text",
    {}, { audio_url: audioUrl, duration: durationMs }
  );
  return result.success
    ? { success: true, transcript: (result.data as unknown as Record<string, string>)?.text || "" }
    : { success: false, error: result.error };
}

/**
 * 抖音用户作品列表 — 获取博主发布的视频列表
 * GET /api/plugins/douyin/user_posts
 * 注意：此接口不需要 cookie（精简版 user_posts_lite 也不需要）
 */
export async function getDouyinUserPostsLite(
  config: CyanlisConfig,
  userId: string, // sec_uid 或用户主页链接
  cursor?: string,
  sortType?: number // 0=默认, 1=按热度
): Promise<{ success: boolean; posts?: DouyinUserPostsData; error?: string }> {
  const params: Record<string, string> = { userId };
  if (cursor) params.cursor = cursor;
  if (sortType !== undefined) params.sortType = String(sortType);

  const result = await cyanlisRequest<DouyinUserPostsData>(
    config, "GET", "/api/plugins/douyin/user_posts_lite", params
  );
  return result.success
    ? { success: true, posts: result.data! }
    : { success: false, error: result.error };
}

/**
 * 抖音视频搜索 — 搜索关键词获取视频列表
 * GET /api/plugins/douyin/video_search
 */
export async function getDouyinVideoSearch(
  config: CyanlisConfig,
  keyword: string,
  cookie?: string,
  cursor?: string,
  sortType?: number
): Promise<{ success: boolean; results?: DouyinVideoSearchData; error?: string }> {
  const params: Record<string, string> = { keyword };
  if (cookie) params.cookie = cookie;
  if (cursor) params.cursor = cursor;
  if (sortType !== undefined) params.sortType = String(sortType);

  const result = await cyanlisRequest<DouyinVideoSearchData>(
    config, "GET", "/api/plugins/douyin/video_search", params
  );
  return result.success
    ? { success: true, results: result.data! }
    : { success: false, error: result.error };
}

/**
 * 抖音链接解析 — 解析分享链接提取原始视频地址
 * POST /api/plugins/douyin/share_link
 */
export async function getDouyinShareLink(
  config: CyanlisConfig,
  videoId: string // 作品ID
): Promise<{ success: boolean; data?: Record<string, string>; error?: string }> {
  const result = await cyanlisRequest<Record<string, string>>(
    config, "POST", "/api/plugins/douyin/share_link", {}, { id: videoId }
  );
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

/**
 * 抖音视频评论采集
 * GET /api/plugins/douyin/comments
 */
export async function getDouyinComments(
  config: CyanlisConfig,
  awemeId: string,
  cursor?: string
): Promise<{ success: boolean; comments?: unknown; error?: string }> {
  const params: Record<string, string> = { awemeId };
  if (cursor) params.cursor = cursor;

  const result = await cyanlisRequest<unknown>(
    config, "GET", "/api/plugins/douyin/comments", params
  );
  return result.success
    ? { success: true, comments: result.data }
    : { success: false, error: result.error };
}

/**
 * 抖音用户信息
 * GET /api/plugins/douyin/user_info
 */
export async function getDouyinUserInfo(
  config: CyanlisConfig,
  userId: string // sec_uid
): Promise<{ success: boolean; userInfo?: unknown; error?: string }> {
  const result = await cyanlisRequest<unknown>(
    config, "GET", "/api/plugins/douyin/user_info", { userId }
  );
  return result.success
    ? { success: true, userInfo: result.data }
    : { success: false, error: result.error };
}

// ============ 小红书 API ============

/**
 * 小红书笔记详情 — 获取笔记内容+图片+视频
 * GET /api/plugins/xiaohongshu/detail
 */
export async function getXhsNoteDetail(
  config: CyanlisConfig,
  noteUrl: string,
  cookie?: string
): Promise<{ success: boolean; detail?: XhsDetailData; error?: string }> {
  const params: Record<string, string> = { url: noteUrl };
  if (cookie) params.cookie = cookie;

  const result = await cyanlisRequest<XhsDetailData>(
    config, "GET", "/api/plugins/xiaohongshu/detail", params
  );
  return result.success
    ? { success: true, detail: result.data! }
    : { success: false, error: result.error };
}

/**
 * 小红书关键词搜索
 * GET /api/plugins/xiaohongshu/search
 */
export async function getXhsKeywordSearch(
  config: CyanlisConfig,
  keyword: string,
  cookie: string,
  sortType?: number
): Promise<{ success: boolean; results?: unknown; error?: string }> {
  const params: Record<string, string> = { keyword, cookie };
  if (sortType !== undefined) params.sortType = String(sortType);

  const result = await cyanlisRequest<unknown>(
    config, "GET", "/api/plugins/xiaohongshu/search", params
  );
  return result.success
    ? { success: true, results: result.data }
    : { success: false, error: result.error };
}

/**
 * 小红书用户笔记采集
 * GET /api/plugins/xiaohongshu/user_notes
 */
export async function getXhsUserNotes(
  config: CyanlisConfig,
  userUrl: string,
  cookie: string
): Promise<{ success: boolean; notes?: unknown; error?: string }> {
  const result = await cyanlisRequest<unknown>(
    config, "GET", "/api/plugins/xiaohongshu/user_notes", { url: userUrl, cookie }
  );
  return result.success
    ? { success: true, notes: result.data }
    : { success: false, error: result.error };
}

/**
 * 小红书视频转文字
 * GET /api/plugins/xiaohongshu/video_to_text
 */
export async function getXhsVideoToText(
  config: CyanlisConfig,
  noteUrl: string,
  cookie?: string
): Promise<{ success: boolean; text?: string; error?: string }> {
  const params: Record<string, string> = { url: noteUrl };
  if (cookie) params.cookie = cookie;

  const result = await cyanlisRequest<Record<string, string>>(
    config, "GET", "/api/plugins/xiaohongshu/video_to_text", params
  );
  return result.success
    ? { success: true, text: result.data?.caption || result.data?.desc || "" }
    : { success: false, error: result.error };
}

// ============ 渠道优先级判定 ============

/**
 * 判断是否有 Cyanlis 插件可用，并返回配置
 * 如果有多个 Cyanlis 插件活跃，共享同一个 apiKey
 */
export async function isCyanlisAvailable(): Promise<CyanlisConfig | null> {
  return getCyanlisConfig();
}

/**
 * 判断文案提取是否应该优先使用 Cyanlis video_to_text
 * 优先级：
 * 1. extract_text_third_party (Cyanlis直接API) — 如果活跃且 provider=cyanlis
 * 2. 原方案 (douyin.wtf + ASR)
 * 3. extract_workflow (Coze工作流) — 兜底
 */
export async function shouldUseCyanlisForTextExtract(): Promise<{ use: boolean; config?: CyanlisConfig }> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("plugins")
      .select("config, role")
      .eq("is_active", true)
      .in("role", ["extract_text_third_party", "extract_workflow"])
      .order("role", { ascending: true }) // extract_text_third_party 排前面
      .limit(1)
      .maybeSingle();

    if (data) {
      const config = data.config as Record<string, string>;
      if (config.provider === "cyanlis" && config.api_key) {
        return {
          use: true,
          config: {
            apiBaseUrl: config.api_base_url || "https://cyanlis.cn",
            apiKey: config.api_key,
            provider: "cyanlis",
          },
        };
      }
    }
    return { use: false };
  } catch {
    return { use: false };
  }
}

/**
 * 判断视频提取是否应该使用 Cyanlis detail_v4
 * 优先级：
 * 1. extract_video (如果 provider=cyanlis) — 使用 detail_v4
 * 2. extract_video (如果 provider=ppt6) — 使用 PPT6 API
 * 3. 内置多源解析 — 兜底
 */
export async function shouldUseCyanlisForVideoExtract(): Promise<{ use: boolean; config?: CyanlisConfig }> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("plugins")
      .select("config")
      .eq("role", "extract_video")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (data) {
      const config = data.config as Record<string, string>;
      if (config.provider === "cyanlis" && config.api_key) {
        return {
          use: true,
          config: {
            apiBaseUrl: config.api_base_url || "https://cyanlis.cn",
            apiKey: config.api_key,
            provider: "cyanlis",
          },
        };
      }
    }
    return { use: false };
  } catch {
    return { use: false };
  }
}
