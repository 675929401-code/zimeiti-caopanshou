import { videoProviderFetch as fetch } from "./video-provider-request-audit";
/**
 * 蓝猫平台（aijisu.cn）视频生成专属适配器
 *
 * 【隔离设计原则】
 * 1. 独立文件 — 所有蓝猫平台逻辑在此文件内，不与其他平台交叉
 * 2. 自包含工具函数 — 不依赖 video-adapter.ts 的内部函数，避免耦合
 * 3. 协议隔离 — 蓝猫的请求/响应格式与其他平台完全不同，独立处理
 * 4. 计费隔离 — 只返回标准 VideoTaskResult，计费逻辑由上层统一处理
 *
 * 【蓝猫API协议】
 * 提交（异步，推荐）：POST {base}/v1/videos
 *   请求：{model, prompt, duration, orientation, images?}
 *   响应：{id, status, ...}
 *
 * 轮询：GET {base}/v1/videos/{task_id}
 *   响应：{id, status, progress, url, video_url, ...}
 *
 * 每个业务任务只提交一次；丢失回执不换地址、不换模型、不重新 POST。
 *
 * 状态值映射：
 *   completed / COMPLETED → success
 *   failed / error / FAILED → failed
 *   processing / PROCESSING → processing
 *   pending / submitted / queued → queued
 *
 * 支持模型：grok-video-3-pro, grok-imagine 等
 * 支持比例：16:9, 9:16, 1:1
 * 支持时长：10秒、20秒
 * 支持分辨率：480p, 720p
 */

import type { VideoModelConfig, VideoGenerateParams, VideoTaskResult } from "./video-adapter";

// ─── 日志前缀 ──────────────────────────────────────
const LM_LOG = "[蓝猫通道]";

// ─── 内部工具函数（自包含，不依赖外部） ────────────────

/** 安全提取字符串 */
function lmSafeStr(val: unknown, fallback = ""): string {
  if (val == null) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return fallback;
}

/** 安全提取数字 */
function lmSafeNum(val: unknown, fallback: number | null): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 安全解析 JSON */
async function lmSafeParseJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    const text = await resp.text();
    if (!text || text.trim().length === 0) return {};
    const parsed = JSON.parse(text);
    return (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      ? (parsed as Record<string, unknown>)
      : { _raw: parsed };
  } catch {
    return {};
  }
}

/** 蓝猫状态归一化 */
function lmNormalizeStatus(raw: string): "success" | "failed" | "queued" | "processing" {
  const s = raw.toLowerCase().trim();
  // 成功
  if (["completed", "success", "succeeded", "done", "finished"].includes(s)) return "success";
  // 失败
  if (["failed", "error", "terminated", "cancelled", "canceled", "expired", "timeout"].includes(s)) return "failed";
  // 排队
  if (["queued", "pending", "waiting", "submitted", "created", "not_started"].includes(s)) return "queued";
  // 渲染中
  return "processing";
}

/** 从蓝猫响应中提取 task_id（多级提取） */
function lmExtractTaskId(data: Record<string, unknown>): string {
  const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown> : {};
  for (const value of [data.task_id, data.id, nested.task_id, nested.id]) {
    const id = typeof value === "string" ? value.trim()
      : typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
    if (id && !/[\s\u0000-\u001f\u007f]/u.test(id)) return id;
  }
  return "";
}

function lmSubmissionUnknown(): VideoTaskResult {
  return { taskId: "", status: "processing", progress: null, submissionOutcome: "unknown", error: "上游提交结果尚未确认，请保留原任务，暂不要重复生成" };
}

function lmSubmissionError(data: Record<string, unknown>): string {
  const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown> : {};
  return [data, nested].flatMap(record => {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown> : {};
    return [record.message, record.error, record.detail, record.code, record.status, error.message, error.code, error.type];
  }).filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(": ");
}

function lmSubmissionRefused(message: string): boolean {
  return /model_not_found|no available channel|no[_ ]+(?:available[_ ]+)?accounts?(?:[_ ]+available)?|unsupported model|model (?:is )?not (?:found|supported)|insufficient[_ ](?:quota|balance|credits)|invalid[_ ](?:api[_ ]?key|request|parameter|argument)|unauthorized|authentication[_ ]error|permission[_ ]denied|content[_ ]policy[_ ]violation|\btask_failed\b|\brejected\b|模型(?:不存在|已下架|不支持)|无可用(?:模型)?(?:通道|渠道)|无可用账号|余额不足|配额不足/iu.test(message);
}

/** 从蓝猫响应中提取 video_url（多级提取） */
function lmExtractVideoUrl(data: Record<string, unknown>): string {
  // 优先级：video_url → url（部分平台直接返回url字段） → result.video_url → result.outputs[0]
  const directUrl = lmSafeStr(data.video_url);
  if (directUrl) return directUrl;

  const topUrl = lmSafeStr(data.url);
  if (topUrl) return topUrl;

  const result = data.result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const rVideoUrl = lmSafeStr(r.video_url);
    if (rVideoUrl) return rVideoUrl;
    const outputs = r.outputs;
    if (Array.isArray(outputs) && outputs.length > 0 && typeof outputs[0] === "string") {
      return outputs[0];
    }
  }
  return "";
}

/** 无费用契约预检：只读取模型清单，绝不提交生成任务。 */
async function lmCheckContract(baseUrl: string, apiKey: string, modelName: string): Promise<{
  reachable: boolean;
  modelFound: boolean | null;
  latencyMs: number;
  error?: string;
}> {
  const url = baseUrl.replace(/\/+$/, "").replace(/\/v1\/?$/, "") + "/v1/models";
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.status === 404 || resp.status === 405) {
      return { reachable: true, modelFound: null, latencyMs: Date.now() - start };
    }
    const data = await lmSafeParseJson(resp);
    if (!resp.ok) {
      return {
        reachable: resp.status < 500,
        modelFound: null,
        latencyMs: Date.now() - start,
        error: lmSafeStr(data.message || data.error, `HTTP ${resp.status}`),
      };
    }
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const ids = rows
      .map((item) => item && typeof item === "object" ? lmSafeStr((item as Record<string, unknown>).id || (item as Record<string, unknown>).name) : "")
      .filter(Boolean);
    return {
      reachable: true,
      modelFound: ids.length > 0 ? ids.includes(modelName) : null,
      latencyMs: Date.now() - start,
    };
  } catch (e: unknown) {
    return { reachable: false, modelFound: null, latencyMs: Date.now() - start, error: (e as Error).message };
  }
}

// ─── 宽高比 → 分辨率映射 ────────────────────────────
/** 将前端 resolution（如 1280x720）转换为上游要求的 size 格式（720P/1080P） */
function lmResolutionToSize(resolution: string): string {
  if (!resolution) return "720P";
  // 已经是 720P/1080P 格式，直接返回（统一大写）
  const upper = resolution.toUpperCase();
  if (/^\d{3,4}P$/.test(upper)) return upper;
  // 从 WxH 格式提取较短边，映射为 720P 或 1080P
  const match = resolution.match(/^(\d+)x(\d+)$/i);
  if (match) {
    const shorter = Math.min(parseInt(match[1]), parseInt(match[2]));
    return shorter >= 1080 ? "1080P" : "720P";
  }
  // 回退
  return "720P";
}

const LM_SIZE_MAP: Record<string, string> = {
  "16:9": "720P",
  "9:16": "720P",
  "1:1": "720P",
};

// ─── 提交视频生成任务 ────────────────────────────────

export async function generateLanmaoVideo(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
  // 使用异步接口 POST /v1/videos（比同步 /v1/video/generations 更稳定，duration支持整数）
  const submitUrl = `${baseUrl}/v1/videos`;
  const apiKey = config.api_key || "";

  // ① 构建异步接口请求参数
  // 上游API使用 size 参数（如 "1280x720"），不支持 orientation/aspect_ratio
  // 只支持 16:9 和 9:16 两种画面比例
  // 1080p模型(grok-imagine-1.0-video-super / grok-imagine-1.0-video-super-20s) → 1792x1024 / 1024x1792
  // 720p模型(grok-imagine-1.0-video-super-720p) → 1280x720 / 720x1280
  const aspectRatio = params.aspectRatio || "16:9";
  if (aspectRatio !== "16:9" && aspectRatio !== "9:16") {
    return { taskId: "", status: "failed", error: `渠道D不支持画面比例 ${aspectRatio}，仅支持 16:9 和 9:16` };
  }
  const modelName = typeof config.model_name === "string" ? config.model_name.trim() : "";
  if (!modelName) return { taskId: "", status: "failed", error: "渠道D缺少明确模型配置，任务未提交" };
  const contract = await lmCheckContract(baseUrl, apiKey, modelName);
  if (!contract.reachable) {
    console.warn(`${LM_LOG} 无费用契约预检不可达 (${contract.error || "预检失败"})，仍尝试一次真实提交`);
  } else if (contract.modelFound === false) {
    return {
      taskId: "",
      status: "failed",
      error: `model_not_found: configured model ${modelName} is absent from the authenticated /v1/models contract`,
    };
  }
  const is1080p = !modelName.includes("720p");
  const sizeMap1080: Record<string, string> = { "16:9": "1792x1024", "9:16": "1024x1792" };
  const sizeMap720: Record<string, string> = { "16:9": "1280x720", "9:16": "720x1280" };
  const size = is1080p ? (sizeMap1080[aspectRatio] || "1792x1024") : (sizeMap720[aspectRatio] || "1280x720");
  const duration = params.duration || config.duration_seconds || 10;

  const body: Record<string, unknown> = {
    model: modelName,
    prompt: params.prompt || "",
    duration: Number(duration),
    size: size,
  };

  // 图生视频：添加首帧图/参考图（异步接口用 images 数组）
  // 优先使用首帧图(imageUrl)，若未提供则用参考图(referenceImageUrl)作为输入图
  // 蓝猫API的 images 字段是唯一的图片输入入口，不传则纯文生视频
  // 仅对支持图片输入的模型生效，避免给纯文生视频模型发送不接受的数据
  const inputImage = config.supports_image_input
    ? (params.imageUrl || params.referenceImageUrl)
    : params.imageUrl;
  if (inputImage) {
    body.images = [inputImage];
  }

  console.log(`${LM_LOG} 提交视频(async): model=${body.model}, prompt=${String(body.prompt).slice(0, 50)}, duration=${duration}, size=${size}, 图片输入=${!!inputImage}${params.referenceImageUrl && !params.imageUrl && config.supports_image_input ? '(参考图)' : ''}`);

  // A lost acknowledgement cannot establish rejection. Never repeat a POST,
  // switch endpoints or replace the selected model after dispatch.
  let resp: Response;
  try {
    resp = await fetch(submitUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return lmSubmissionUnknown();
  }
  const data = await lmSafeParseJson(resp);
  const taskId = lmExtractTaskId(data);
  const detail = lmSubmissionError(data);
  const normalizedStatus = lmNormalizeStatus(lmSafeStr(data.status || data.raw_status, "processing"));
  const videoUrl = lmExtractVideoUrl(data);
  if (taskId) {
    const progress = lmSafeNum(data.progress, null);
    return {
      taskId,
      status: normalizedStatus === "success" && !videoUrl ? "processing" : normalizedStatus,
      videoUrl: normalizedStatus === "success" && videoUrl ? videoUrl : undefined,
      error: normalizedStatus === "failed" ? detail.slice(0, 300) || "供应商任务失败" : undefined,
      progress: progress != null && progress >= 0 ? Math.min(progress / 100, 1) : null,
    };
  }
  // A complete synchronous result is an acknowledgement too. The caller uses
  // its stable business task identity; do not invent a timestamp provider ID.
  if (resp.ok && normalizedStatus !== "failed" && !lmSubmissionRefused(detail) && videoUrl) {
    return { taskId: "", status: "success", videoUrl };
  }
  if ((resp.status >= 400 && resp.status < 500) || lmSubmissionRefused(detail) || (resp.ok && normalizedStatus === "failed")) {
    return { taskId: "", status: "failed", error: `蓝猫提交拒绝: ${(detail || `HTTP ${resp.status}`).slice(0, 300)}` };
  }
  return lmSubmissionUnknown();
}

// ─── 轮询视频任务 ──────────────────────────────────

export async function pollLanmaoVideo(
  config: VideoModelConfig,
  taskId: string,
): Promise<VideoTaskResult> {
  const baseUrl = config.api_endpoint.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
  const pollUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;
  const apiKey = config.api_key || "";

  try {
    const resp = await fetch(pollUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    // 网络不可达时返回"处理中"（下次轮询再检测），避免误判
    if (resp.status >= 500) {
      console.warn(`${LM_LOG} 轮询5xx: ${resp.status}, taskId=${taskId}`);
      return { taskId, status: "processing", progress: null };
    }

    // 404：任务不存在或已过期
    if (resp.status === 404) {
      return { taskId, status: "failed", error: "任务不存在或已过期" };
    }

    // 4xx：客户端错误
    if (!resp.ok) {
      const data = await lmSafeParseJson(resp);
      const errMsg = lmSafeStr(data.message, `轮询失败(${resp.status})`);
      return { taskId, status: "failed", error: errMsg };
    }

    const data = await lmSafeParseJson(resp);

    // 提取状态
    const rawStatus = lmSafeStr(data.status || data.raw_status, "processing");
    const normalizedStatus = lmNormalizeStatus(rawStatus);

    // 成功
    if (normalizedStatus === "success") {
      const videoUrl = lmExtractVideoUrl(data);
      console.log(`${LM_LOG} 轮询成功: taskId=${taskId}, videoUrl=${videoUrl.slice(0, 80)}`);
      return { taskId, status: "success", videoUrl };
    }

    // 失败
    if (normalizedStatus === "failed") {
      const errMsg = lmSafeStr(
        data.error && typeof data.error === "object"
          ? (data.error as Record<string, unknown>).message
          : data.error,
        lmSafeStr(data.message) || `生成失败(${rawStatus})`,
      );
      console.warn(`${LM_LOG} 轮询失败: taskId=${taskId}, status=${rawStatus}, ${errMsg}`);
      return { taskId, status: "failed", error: errMsg };
    }

    // 处理中：读取进度
    const progress = lmSafeNum(data.progress, null);
    const normalizedProgress = progress != null && progress >= 0
      ? Math.min(progress / 100, 1)
      : normalizedStatus === "queued" ? 0.05 : 0.3;

    return {
      taskId,
      status: normalizedStatus,
      progress: normalizedProgress,
    };

  } catch (err: unknown) {
    // 网络不可达：返回"处理中"让前端继续轮询
    const msg = err instanceof DOMException && err.name === "AbortError"
      ? "轮询超时"
      : (err as Error).message;
    console.warn(`${LM_LOG} 轮询异常: taskId=${taskId}, ${msg}`);
    return { taskId, status: "processing", progress: null };
  }
}
