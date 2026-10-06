/**
 * 图片生成处理器 — 智能体对话中调用生图模型
 *
 * 架构：
 * 1. 从 llm_models / cover_models 读取生图模型配置
 * 2. 解析用户指令中的图片参数（分辨率、数量、风格）
 * 3. 调用 OpenAI 兼容 /images/generations API
 * 4. 通过 SSE 返回图片 URL 列表
 *
 * SSE 事件格式：
 *   event: image_delta
 *   data: {"type":"image","url":"...","index":0,"total":2}
 *
 *   event: image_complete
 *   data: {"type":"image_complete","images":[{"url":"...","width":1024,"height":1024}],"prompt":"..."}
 */

import { buildOpenAIEndpoint } from "@/lib/api-endpoints";

// ═══════════════════════════════════════════════════════════
// 指令解析：从用户消息中提取图片生成参数
// ═══════════════════════════════════════════════════════════

export interface ImageGenParams {
  prompt: string;           // 图片生成提示词（从消息中提取）
  n: number;                // 生成数量（默认1，最大4）
  size: string;             // 尺寸（如 "1024x1024"）
  quality?: "standard" | "hd"; // 质量
  style?: string;           // 风格（如 "vivid", "natural"）
}

/** 尺寸别名映射 */
const SIZE_ALIASES: Record<string, string> = {
  "1:1": "1024x1024",
  "1:1_hd": "1024x1024",
  "3:4": "768x1024",
  "4:3": "1024x768",
  "9:16": "576x1024",
  "16:9": "1024x576",
  "square": "1024x1024",
  "portrait": "768x1024",
  "landscape": "1024x768",
  "wide": "1024x576",
  "tall": "576x1024",
};

/** DALL-E 3 尺寸映射 */
const DALLE3_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "3:4": "1024x1792",
  "4:3": "1792x1024",
  "9:16": "1024x1792",
  "16:9": "1792x1024",
  "square": "1024x1024",
  "portrait": "1024x1792",
  "landscape": "1792x1024",
};

/**
 * 从用户消息中解析图片生成指令
 *
 * 支持的指令格式：
 * - "生成2张图" / "画3张" / "出4图"
 * - "分辨率16:9" / "尺寸9:16" / "横图" / "竖图" / "方图"
 * - "高清" / "HD" / "标清"
 * - "风格vivid" / "风格natural"
 * - "单张" / "一张"
 */
export function parseImageGenInstructions(message: string): {
  params: Partial<ImageGenParams>;
  cleanedPrompt: string;
} {
  let cleaned = message;
  const params: Partial<ImageGenParams> = {};

  // 数量指令："生成2张" / "画3张" / "出4图" / "单张" / "一张"
  const countMatch = cleaned.match(/(?:生成|画|出|做)\s*(\d)\s*(?:张|幅|个|份)?\s*(?:图|画|图片|图像|插画)/);
  if (countMatch) {
    params.n = Math.min(Math.max(parseInt(countMatch[1]), 1), 4);
    cleaned = cleaned.replace(countMatch[0], "");
  }
  // "单张" / "一张"
  if (/单张|一张/.test(cleaned)) {
    params.n = 1;
    cleaned = cleaned.replace(/单张|一张/g, "");
  }
  // "多张" / "几张"（默认2张）
  if (/多张|几张/.test(cleaned)) {
    params.n = params.n || 2;
    cleaned = cleaned.replace(/多张|几张/g, "");
  }

  // 尺寸指令
  const sizeRatioMatch = cleaned.match(/(?:分辨率|尺寸|比例|比例)\s*[:：]?\s*(\d+:\d+)/);
  if (sizeRatioMatch) {
    const alias = SIZE_ALIASES[sizeRatioMatch[1]];
    if (alias) params.size = alias;
    cleaned = cleaned.replace(sizeRatioMatch[0], "");
  }
  // 简写："横图" / "竖图" / "方图"
  if (/横图|宽图|宽屏/.test(cleaned)) {
    params.size = "1024x768";
    cleaned = cleaned.replace(/横图|宽图|宽屏/g, "");
  }
  if (/竖图|长图|竖屏/.test(cleaned)) {
    params.size = "768x1024";
    cleaned = cleaned.replace(/竖图|长图|竖屏/g, "");
  }
  if (/方图|正方/.test(cleaned)) {
    params.size = "1024x1024";
    cleaned = cleaned.replace(/方图|正方/g, "");
  }
  // "16:9" / "9:16" 等直接写比例
  const directRatio = cleaned.match(/\b(1:1|3:4|4:3|9:16|16:9)\b/);
  if (directRatio && !params.size) {
    params.size = SIZE_ALIASES[directRatio[1]];
    cleaned = cleaned.replace(directRatio[1], "");
  }

  // 质量指令
  if (/高清|HD|hd|高质量/.test(cleaned)) {
    params.quality = "hd";
    cleaned = cleaned.replace(/高清|HD|hd|高质量/g, "");
  }
  if (/标清|SD|sd|标准质量/.test(cleaned)) {
    params.quality = "standard";
    cleaned = cleaned.replace(/标清|SD|sd|标准质量/g, "");
  }

  // 风格指令
  const styleMatch = cleaned.match(/(?:风格|style)\s*[:：]?\s*(vivid|natural|动漫|写实|油画|水彩|赛博朋克|极简)/i);
  if (styleMatch) {
    const styleVal = styleMatch[1].toLowerCase();
    if (styleVal === "vivid" || styleVal === "natural") {
      params.style = styleVal;
    } else {
      params.style = styleVal;
    }
    cleaned = cleaned.replace(styleMatch[0], "");
  }

  // 清理多余空白
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  return { params, cleanedPrompt: cleaned };
}

// ═══════════════════════════════════════════════════════════
// 图片生成 API 调用
// ═══════════════════════════════════════════════════════════

export interface ImageGenResult {
  success: boolean;
  images: Array<{
    url: string;
    width?: number;
    height?: number;
    revisedPrompt?: string;
  }>;
  error?: string;
}

const SEEDREAM_MIN_PIXELS = 3_686_400;
const SEEDREAM_SIZE_ALIASES: Record<string, string> = {
  "1024x1024": "2048x2048",
  "1024x768": "2304x1728",
  "768x1024": "1728x2304",
  "1024x576": "2560x1440",
  "576x1024": "1440x2560",
};

function isSeedreamFamilyModel(modelName?: string): boolean {
  return /doubao|豆包|seedream|seededit/i.test(modelName || "");
}

function normalizeSizeForImageModel(size: string, modelName?: string): string {
  if (!isSeedreamFamilyModel(modelName)) return size;

  const mapped = SEEDREAM_SIZE_ALIASES[size];
  if (mapped) return mapped;

  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return "2048x2048";

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "2048x2048";
  }

  if (width * height >= SEEDREAM_MIN_PIXELS) return size;

  const ratio = width / height;
  const roundTo16 = (value: number) => Math.max(16, Math.ceil(value / 16) * 16);
  let nextWidth = roundTo16(Math.sqrt(SEEDREAM_MIN_PIXELS * ratio));
  let nextHeight = roundTo16(nextWidth / ratio);

  while (nextWidth * nextHeight < SEEDREAM_MIN_PIXELS) {
    nextWidth += 16;
    nextHeight = roundTo16(nextWidth / ratio);
  }

  return `${nextWidth}x${nextHeight}`;
}

function isSecureSkillEndpoint(apiBase: string): boolean {
  return /token\.secure-skill\.com|secure-skill/i.test(apiBase);
}

function getAspectRatioFromSize(size: string): string {
  const known: Record<string, string> = {
    "1024x1024": "1:1",
    "2048x2048": "1:1",
    "4096x4096": "1:1",
    "1024x768": "4:3",
    "2304x1728": "4:3",
    "768x1024": "3:4",
    "1728x2304": "3:4",
    "1024x576": "16:9",
    "1792x1024": "16:9",
    "2560x1440": "16:9",
    "576x1024": "9:16",
    "1024x1792": "9:16",
    "1440x2560": "9:16",
  };
  if (known[size]) return known[size];

  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return "1:1";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "1:1";
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.08) return "16:9";
  if (Math.abs(ratio - 9 / 16) < 0.08) return "9:16";
  if (Math.abs(ratio - 4 / 3) < 0.08) return "4:3";
  if (Math.abs(ratio - 3 / 4) < 0.08) return "3:4";
  return "1:1";
}

function getSecureSkillImageSize(size: string): "1K" | "2K" | "4K" {
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return "1K";
  const maxSide = Math.max(Number(match[1]), Number(match[2]));
  if (maxSide >= 3000) return "4K";
  if (maxSide >= 1600) return "2K";
  return "1K";
}

function extractSecureSkillImageUrl(data: Record<string, unknown>): string {
  const get = (obj: unknown, path: string): unknown => {
    let current = obj;
    for (const key of path.split(".")) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  const paths = ["url", "result_url", "data.url", "data.result_url", "output.0.url"];
  for (const path of paths) {
    const value = get(data, path);
    if (typeof value === "string" && value) return value;
  }
  return "";
}

async function callSecureSkillGeminiImageJob(
  apiBase: string,
  apiKey: string,
  prompt: string,
  modelName: string,
  size: string,
): Promise<ImageGenResult> {
  const submitUrl = buildOpenAIEndpoint(apiBase, "jobs");
  const aspectRatio = getAspectRatioFromSize(size);
  const imageSize = getSecureSkillImageSize(size);
  const submitResp = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      generationConfig: {
        imageConfig: {
          aspectRatio,
          imageSize,
        },
      },
      stream: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  const submitData = await submitResp.json().catch(async () => ({ error: await submitResp.text().catch(() => "") })) as Record<string, unknown>;
  if (!submitResp.ok) {
    const message = typeof submitData.error === "string"
      ? submitData.error
      : (submitData.error as Record<string, unknown> | undefined)?.message || submitData.message || JSON.stringify(submitData).slice(0, 200);
    return { success: false, images: [], error: `图片任务提交失败 (${submitResp.status}): ${String(message).slice(0, 120)}` };
  }

  const taskId = String(submitData.id || submitData.job_id || submitData.task_id || "");
  if (!taskId) {
    const directUrl = extractSecureSkillImageUrl(submitData);
    if (directUrl) return { success: true, images: [{ url: directUrl }] };
    return { success: false, images: [], error: "图片任务未返回 job id" };
  }

  for (let i = 0; i < 24; i++) {
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 1500 : 5000));
    const pollResp = await fetch(buildOpenAIEndpoint(apiBase, `jobs/${encodeURIComponent(taskId)}`), {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const pollData = await pollResp.json().catch(async () => ({ error: await pollResp.text().catch(() => "") })) as Record<string, unknown>;
    if (!pollResp.ok) continue;

    const status = String(pollData.status || "").toLowerCase();
    if (["completed", "succeeded", "success", "done"].includes(status)) {
      const url = extractSecureSkillImageUrl(pollData);
      if (url) return { success: true, images: [{ url }] };
      return { success: false, images: [], error: "图片任务完成但未返回图片 URL" };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      const message = typeof pollData.error === "string"
        ? pollData.error
        : (pollData.error as Record<string, unknown> | undefined)?.message || pollData.message || "图片生成失败";
      return { success: false, images: [], error: String(message).slice(0, 160) };
    }
  }

  return { success: false, images: [], error: "图片任务轮询超时" };
}

/**
 * 调用 OpenAI 兼容 /images/generations API
 *
 * @param apiBase  - API 基础地址（如 https://open.bigmodel.cn/api/paas/v4）
 * @param apiKey   - API 密钥
 * @param prompt   - 图片提示词
 * @param options  - 生成参数
 * @param modelName - 模型名称（如 glm-image, dall-e-3）
 */
export async function callImageGenerationAPI(
  apiBase: string,
  apiKey: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    style?: string;
    modelName?: string;
    responseFormat?: "url" | "b64_json";
  },
): Promise<ImageGenResult> {
  const modelName = options.modelName || "dall-e-3";
  const requestedSize = options.size || "1024x1024";
  const normalizedSize = normalizeSizeForImageModel(requestedSize, modelName);
  const secureSkill = isSecureSkillEndpoint(apiBase);

  if (secureSkill && /gemini-3\.(0|1).*image/i.test(modelName)) {
    return callSecureSkillGeminiImageJob(apiBase, apiKey, prompt, modelName, normalizedSize);
  }

  const url = buildOpenAIEndpoint(apiBase, "images/generations");
  const body: Record<string, unknown> = secureSkill
    ? {
      model: modelName,
      prompt,
      n: options.n || 1,
      image_size: getSecureSkillImageSize(normalizedSize),
      aspect_ratio: getAspectRatioFromSize(normalizedSize),
    }
    : {
      model: modelName,
      prompt,
      n: options.n || 1,
      size: normalizedSize,
    };

  // 可选参数
  if (!secureSkill) {
    if (options.quality) body.quality = options.quality;
    if (options.style) body.style = options.style;
  }
  if (options.responseFormat) body.response_format = options.responseFormat;
  else if (!secureSkill) body.response_format = "url";

  let upstreamHost = "invalid-endpoint";
  try {
    upstreamHost = new URL(url).hostname || upstreamHost;
  } catch {
    // Keep logs useful without ever serializing a malformed endpoint or its query string.
  }
  console.log(`[ImageGen] Calling provider=${upstreamHost}, model=${body.model}, n=${body.n}, size=${body.size}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ImageGen] API error ${response.status}:`, errorText.slice(0, 200));
      return { success: false, images: [], error: `图片生成失败 (${response.status}): ${errorText.slice(0, 100)}` };
    }

    const data = await response.json() as {
      data?: Array<{
        url?: string;
        b64_json?: string;
        revised_prompt?: string;
        width?: number;
        height?: number;
      }>;
      error?: { message?: string };
    };

    if (data.error) {
      return { success: false, images: [], error: data.error.message || "图片生成API返回错误" };
    }

    if (!data.data || data.data.length === 0) {
      return { success: false, images: [], error: "API未返回图片数据" };
    }

    const images = data.data.map((item) => ({
      url: item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : ""),
      width: item.width,
      height: item.height,
      revisedPrompt: item.revised_prompt,
    })).filter((item) => item.url);

    if (images.length === 0) {
      return { success: false, images: [], error: "未获取到有效图片URL" };
    }

    return { success: true, images };
  } catch (err) {
    const msg = err instanceof Error
      ? (err.message || err.name || "Unknown error")
      : String(err || "Unknown error");
    console.error("[ImageGen] Exception:", msg);
    return { success: false, images: [], error: `图片生成异常: ${msg}` };
  }
}

// ═══════════════════════════════════════════════════════════
// SSE 流式输出 — 图片生成结果通过 SSE 返回前端
// ═══════════════════════════════════════════════════════════

/**
 * 生成图片并构建 SSE 流
 *
 * 流程：
 * 1. 先发 "生成中" 状态 → 前端显示骨架屏
 * 2. 调用方完成原子结算与持久化
 * 3. 结算成功后才逐张通过 SSE 推送 URL
 * 4. 最后发送 image_complete 与 [DONE]
 *
 * onComplete 必须是一个可等待的结算回调。回调失败时，本函数只发送
 * image_error，不得发送图片 URL、image_complete 或 [DONE]，避免前端把
 * 未结算的上游结果误判为已完成资产。
 */
export async function generateImageStream(
  apiBase: string,
  apiKey: string,
  prompt: string,
  options: {
    n?: number;
    size?: string;
    quality?: string;
    style?: string;
    modelName?: string;
  },
  callbacks: {
    onImage?: (url: string, index: number, total: number) => void;
    onComplete: (images: Array<{ url: string; width?: number; height?: number }>) => Promise<void>;
    onError?: (error: string) => void;
    onUsage?: (info: { imageCount: number; costRmb: number }) => void;
  },
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  const n = options.n || 1;

  return new ReadableStream({
    async start(controller) {
      try {
        // 1. 发送"生成中"状态
        controller.enqueue(encoder.encode(
          `event: image_generating\ndata: ${JSON.stringify({ type: "image_generating", count: n, prompt })}\n\n`
        ));

        // 2. 调用图片生成 API
        const result = await callImageGenerationAPI(apiBase, apiKey, prompt, options);

        if (!result.success || result.images.length === 0) {
          const errorMsg = result.error || "图片生成失败";
          controller.enqueue(encoder.encode(
            `event: image_error\ndata: ${JSON.stringify({ type: "image_error", error: errorMsg })}\n\n`
          ));
          callbacks?.onError?.(errorMsg);
          controller.close();
          return;
        }

        // 3. 先等待调用方完成原子结算与持久化；失败将进入 catch。
        await callbacks.onComplete(result.images);

        // 4. 结算成功后才逐张推送图片
        for (let i = 0; i < result.images.length; i++) {
          const img = result.images[i];
          controller.enqueue(encoder.encode(
            `event: image_delta\ndata: ${JSON.stringify({ type: "image", url: img.url, index: i, total: result.images.length, width: img.width, height: img.height, revisedPrompt: img.revisedPrompt })}\n\n`
          ));
          callbacks?.onImage?.(img.url, i, result.images.length);
        }

        // 5. 发送完成事件
        controller.enqueue(encoder.encode(
          `event: image_complete\ndata: ${JSON.stringify({ type: "image_complete", images: result.images, prompt })}\n\n`
        ));

        // 6. [DONE] 标记
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("[ImageGen] Stream error:", msg);
        try {
          controller.enqueue(encoder.encode(
            `event: image_error\ndata: ${JSON.stringify({ type: "image_error", error: msg })}\n\n`
          ));
        } catch { /* controller may be closed */ }
        controller.close();
      }
    },
  });
}
