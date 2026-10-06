import { videoProviderFetch as fetch } from "./video-provider-request-audit";
import type {
  VideoGenerateParams,
  VideoModelConfig,
  VideoTaskResult,
} from "./video-adapter";

export const AUTODL_COMFYUI_WORKFLOW_PROTOCOL = "autodl_comfyui_workflow";
export const AUTODL_COMFYUI_LEGACY_H3_PROTOCOL = "autodl_comfyui_h3";

export function isAutodlComfyuiHostedProtocol(value: unknown): boolean {
  return value === AUTODL_COMFYUI_WORKFLOW_PROTOCOL || value === AUTODL_COMFYUI_LEGACY_H3_PROTOCOL;
}

export type AutodlComfyuiWorkflowInputMode =
  | "text"
  | "multi_image"
  | "first_last_frame"
  | "image_audio_lipsync"
  | "multi_image_audio";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableIdempotencyKey(value: unknown): string {
  const key = safeString(value);
  return /^[A-Za-z0-9._:-]{8,240}$/u.test(key) ? key : "";
}

function submissionUnknown(): VideoTaskResult {
  return {
    taskId: "",
    status: "processing",
    progress: null,
    submissionOutcome: "unknown",
    error: "上游提交结果尚未确认，请保留原任务，暂不要重复生成",
  };
}

function parseJsonResponse(response: Response): Promise<JsonRecord> {
  return response.json()
    .then((value) => record(value))
    .catch(() => ({}));
}

function apiBase(endpoint: string): string {
  const fallback = "https://www.autodl.art/api/v1";
  const value = String(endpoint || fallback).trim().replace(/\/+$/u, "");
  try {
    const parsed = new URL(value);
    if (!/^https:$/u.test(parsed.protocol)) return fallback;
    const marker = "/api/v1";
    const markerIndex = parsed.pathname.indexOf(marker);
    const path = markerIndex >= 0 ? parsed.pathname.slice(0, markerIndex + marker.length) : marker;
    return `${parsed.origin}${path}`.replace(/\/+$/u, "");
  } catch {
    return fallback;
  }
}

function workflowId(config: VideoModelConfig): string {
  return safeString(config.api_protocol_config?.workflow_id)
    || safeString(config.model_name);
}

export function autodlComfyuiWorkflowMode(config: VideoModelConfig): AutodlComfyuiWorkflowInputMode {
  const configured = safeString(config.api_protocol_config?.workflow_input_mode);
  if (["text", "multi_image", "first_last_frame", "image_audio_lipsync", "multi_image_audio"].includes(configured)) {
    return configured as AutodlComfyuiWorkflowInputMode;
  }
  const id = workflowId(config);
  if (id === "minimax_h3_lightx2v_no_pic") return "text";
  if (id === "minimax_h3_lightx2v") return "first_last_frame";
  if (id === "minimax_h3_image_audio_to_video") return "image_audio_lipsync";
  if (/^minimax_h3_lightx2v_v5(?:_15s)?$/u.test(id)) return "multi_image";
  return "multi_image_audio";
}

function uniquePublicUrls(values: Array<string | undefined>, limit: number): string[] {
  return [...new Set(values
    .map((value) => safeString(value))
    .filter((value) => /^https?:\/\//iu.test(value)))]
    .slice(0, Math.max(0, limit));
}

function maxCount(value: unknown, fallback: number, hardMax: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(hardMax, Math.trunc(parsed)));
}

function durationFor(config: VideoModelConfig, params: VideoGenerateParams): number {
  const min = Math.max(1, Math.trunc(Number(config.api_protocol_config?.min_submit_duration)
    || Number(config.api_protocol_config?.min_duration)
    || 1));
  const max = Math.max(min, Math.trunc(Number(config.api_protocol_config?.max_duration)
    || Number(config.duration_seconds)
    || 10));
  const requested = Math.round(Number(params.duration) || Number(config.duration_seconds) || min);
  return Math.max(min, Math.min(max, requested));
}

function requestedResolutionTier(config: VideoModelConfig, params: VideoGenerateParams): string {
  const raw = safeString(
    params.resolutionTier
      || params.resolution
      || config.api_protocol_config?.default_resolution
      || "768p",
  ).toLowerCase();
  return raw.includes("1080") ? "1080p" : raw.includes("480") ? "480p" : "768p";
}

function resolutionFor(config: VideoModelConfig, params: VideoGenerateParams): string {
  const tier = requestedResolutionTier(config, params);
  const ratio = safeString(params.aspectRatio || "16:9");
  if (ratio === "1:1") return `${tier}(1:1)`;
  const vertical = ratio === "9:16" || ratio === "3:4";
  return `${tier}${vertical ? "竖" : "横"}`;
}

function providerError(data: JsonRecord, fallback: string): string {
  const source = record(data.data);
  const error = data.error ?? source.error;
  if (typeof error === "string" && error.trim()) return error;
  const message = data.message ?? data.msg ?? source.message ?? source.msg;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function inputUrls(config: VideoModelConfig, params: VideoGenerateParams) {
  const mode = autodlComfyuiWorkflowMode(config);
  const defaultImages = mode === "text" ? 0 : mode === "first_last_frame" || mode === "image_audio_lipsync" ? 1 : 9;
  const defaultAudios = mode === "image_audio_lipsync" ? 1 : mode === "multi_image_audio" ? 3 : 0;
  const maxImages = maxCount(config.api_protocol_config?.max_reference_images, defaultImages, 9);
  const maxAudios = maxCount(config.api_protocol_config?.max_reference_audios, defaultAudios, 3);
  const images = uniquePublicUrls([
    params.imageUrl,
    params.referenceImageUrl,
    ...(params.imageUrls || []),
  ], maxImages);
  const audios = uniquePublicUrls([
    params.audioUrl,
    ...(params.audioUrls || []),
  ], maxAudios);
  return { mode, images, audios };
}

export function validateAutodlComfyuiWorkflowInput(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): { ok: true } | { ok: false; code: string; error: string } {
  if (params.sourceVideoUrl) {
    return { ok: false, code: "AUTODL_COMFYUI_SOURCE_VIDEO_UNSUPPORTED", error: "该 AutoDL ComfyUI 工作流不接收源视频" };
  }
  const { mode, images, audios } = inputUrls(config, params);
  const hasAnyImageInput = Boolean(
    safeString(params.imageUrl)
      || safeString(params.referenceImageUrl)
      || safeString(params.lastFrameUrl)
      || (params.imageUrls || []).some((value) => Boolean(safeString(value))),
  );
  const hasAnyAudioInput = Boolean(
    safeString(params.audioUrl)
      || (params.audioUrls || []).some((value) => Boolean(safeString(value))),
  );
  if (mode === "text" && hasAnyImageInput) {
    return { ok: false, code: "AUTODL_COMFYUI_IMAGE_UNSUPPORTED", error: "文生视频工作流不接收参考图片" };
  }
  if (mode !== "multi_image_audio" && mode !== "image_audio_lipsync" && hasAnyAudioInput) {
    return { ok: false, code: "AUTODL_COMFYUI_AUDIO_UNSUPPORTED", error: "当前工作流不接收参考音频" };
  }
  if (mode === "multi_image" && safeString(params.lastFrameUrl)) {
    return { ok: false, code: "AUTODL_COMFYUI_LAST_FRAME_UNSUPPORTED", error: "多图参考工作流不承诺尾帧控制，请改用首尾帧工作流" };
  }
  const promptRequired = config.api_protocol_config?.supports_prompt !== false && mode !== "image_audio_lipsync";
  if (promptRequired && !safeString(params.prompt)) {
    return { ok: false, code: "AUTODL_COMFYUI_PROMPT_REQUIRED", error: "当前 AutoDL ComfyUI 工作流必须提供视频提示词" };
  }
  const requestedDuration = Number(params.duration ?? config.duration_seconds);
  const minDuration = Math.max(1, Number(config.api_protocol_config?.min_duration)
    || Number(config.api_protocol_config?.min_submit_duration)
    || 1);
  const maxDuration = Math.max(minDuration, Number(config.api_protocol_config?.max_duration)
    || Number(config.duration_seconds)
    || 10);
  if (!Number.isInteger(requestedDuration) || requestedDuration < minDuration || requestedDuration > maxDuration) {
    return {
      ok: false,
      code: "AUTODL_COMFYUI_DURATION_UNSUPPORTED",
      error: `当前工作流仅支持 ${minDuration}-${maxDuration} 秒整数时长`,
    };
  }
  const tier = requestedResolutionTier(config, params);
  const configuredTiers = config.api_protocol_config?.resolution_options || [];
  if (configuredTiers.length > 0 && !configuredTiers.includes(tier)) {
    return { ok: false, code: "AUTODL_COMFYUI_RESOLUTION_UNSUPPORTED", error: `当前工作流不支持 ${tier}` };
  }
  const ratio = safeString(params.aspectRatio || "16:9");
  const configuredRatios = config.api_protocol_config?.aspect_ratios || [];
  if (configuredRatios.length > 0 && !configuredRatios.includes(ratio)) {
    return { ok: false, code: "AUTODL_COMFYUI_ASPECT_RATIO_UNSUPPORTED", error: `当前工作流不支持 ${ratio} 画幅` };
  }
  const minimumImages = maxCount(
    config.api_protocol_config?.required_reference_images,
    mode === "multi_image" || mode === "image_audio_lipsync" ? 1 : 0,
    9,
  );
  const minimumAudios = maxCount(
    config.api_protocol_config?.required_reference_audios,
    mode === "image_audio_lipsync" ? 1 : 0,
    3,
  );
  if (mode === "first_last_frame") {
    if (!/^https?:\/\//iu.test(safeString(params.imageUrl || params.referenceImageUrl))) {
      return { ok: false, code: "AUTODL_COMFYUI_FIRST_FRAME_REQUIRED", error: "首尾帧工作流必须提供首帧图片" };
    }
    if (!/^https?:\/\//iu.test(safeString(params.lastFrameUrl))) {
      return { ok: false, code: "AUTODL_COMFYUI_LAST_FRAME_REQUIRED", error: "首尾帧工作流必须提供尾帧图片" };
    }
    return { ok: true };
  }
  if (images.length < minimumImages) {
    return { ok: false, code: "AUTODL_COMFYUI_REFERENCE_IMAGE_REQUIRED", error: `当前工作流至少需要 ${minimumImages} 张参考图` };
  }
  if (audios.length < minimumAudios) {
    return { ok: false, code: "AUTODL_COMFYUI_REFERENCE_AUDIO_REQUIRED", error: `当前工作流至少需要 ${minimumAudios} 段参考音频` };
  }
  return { ok: true };
}

function buildBody(config: VideoModelConfig, params: VideoGenerateParams): JsonRecord {
  const { mode, images, audios } = inputUrls(config, params);
  const body: JsonRecord = {};
  if (config.api_protocol_config?.supports_prompt !== false && mode !== "image_audio_lipsync") {
    body.prompt = params.prompt;
  }
  const durationField = safeString(config.api_protocol_config?.duration_field)
    || (mode === "image_audio_lipsync" ? "audio_duration" : "duration");
  body[durationField] = durationFor(config, params);
  body.resolution = resolutionFor(config, params);

  if (mode === "first_last_frame") {
    body.first_frame = safeString(params.imageUrl || params.referenceImageUrl);
    body.last_frame = safeString(params.lastFrameUrl);
    return body;
  }
  if (mode === "image_audio_lipsync") {
    body.ref_image_0 = images[0];
    body.ref_audio_0 = audios[0];
    return body;
  }
  if (mode === "multi_image" || mode === "multi_image_audio") {
    images.forEach((url, index) => { body[`ref_image_${index}`] = url; });
  }
  if (mode === "multi_image_audio") {
    audios.forEach((url, index) => { body[`ref_audio_${index}`] = url; });
  }
  return body;
}

function normalizeStatus(value: unknown): VideoTaskResult["status"] {
  const status = safeString(value).toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE"].includes(status)) return "success";
  if ([
    "FAILED", "FAILURE", "ERROR", "CANCELLED", "CANCELED",
    "EXPIRED", "TIMEOUT", "TIMED_OUT", "REJECTED",
  ].includes(status)) return "failed";
  if (["QUEUED", "PENDING", "CREATED"].includes(status)) return "queued";
  return "processing";
}

export async function generateAutodlComfyuiWorkflow(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const validation = validateAutodlComfyuiWorkflowInput(config, params);
  if (!validation.ok) return { taskId: "", status: "failed", error: validation.error };
  const id = workflowId(config);
  if (!/^[a-z0-9_]{3,120}$/u.test(id)) {
    return { taskId: "", status: "failed", error: "AutoDL ComfyUI workflow_id 配置无效" };
  }
  const headers: Record<string, string> = {
    Authorization: config.api_key,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // AutoDL's JSON schema is strict, so the stable request identity is carried
  // only as an optional HTTP header and never injected into the workflow body.
  const idempotencyKey = stableIdempotencyKey(params.idempotencyKey);
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${apiBase(config.api_endpoint)}/comfyui/comfyui_workflow/${encodeURIComponent(id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildBody(config, params)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    // The POST was already dispatched. A timeout or lost acknowledgement
    // cannot prove that the paid task was rejected, so it must not be replayed.
    return submissionUnknown();
  }
  const data = await parseJsonResponse(response);
  if (response.status >= 500) return submissionUnknown();
  if (!response.ok || (data.code && safeString(data.code).toLowerCase() !== "success")) {
    return {
      taskId: "",
      status: "failed",
      error: `AutoDL ComfyUI 提交失败 (${response.status}): ${providerError(data, "接口未返回可识别错误")}`,
    };
  }
  const payload = Object.keys(record(data.data)).length > 0 ? record(data.data) : data;
  const taskId = safeString(payload.task_id || payload.id);
  if (!taskId) return submissionUnknown();
  return { taskId, status: normalizeStatus(payload.status || "QUEUED") };
}

export async function pollAutodlComfyuiWorkflow(
  config: VideoModelConfig,
  taskId: string,
): Promise<VideoTaskResult> {
  const response = await fetch(`${apiBase(config.api_endpoint)}/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: { Authorization: config.api_key, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseJsonResponse(response);
  if (response.status === 429) {
    return {
      taskId,
      status: "processing",
      progress: null,
      error: "AutoDL ComfyUI 状态查询限流（HTTP 429），正在自动重试",
    };
  }
  if (response.status >= 500) return { taskId, status: "processing", progress: null };
  if (!response.ok || (data.code && safeString(data.code).toLowerCase() !== "success")) {
    return {
      taskId,
      status: "failed",
      error: `AutoDL ComfyUI 查询失败 (${response.status}): ${providerError(data, "接口未返回可识别错误")}`,
    };
  }
  const payload = Object.keys(record(data.data)).length > 0 ? record(data.data) : data;
  const status = normalizeStatus(payload.status || "RUNNING");
  const results = Array.isArray(payload.results) ? payload.results.map(record) : [];
  const video = results.find((item) => safeString(item.type).toLowerCase() === "video")
    || results.find((item) => Boolean(safeString(item.url)));
  const videoUrl = safeString(video?.url);
  if (status === "success" && !videoUrl) {
    return {
      taskId,
      status: "processing",
      progress: typeof payload.progress === "number" ? payload.progress : null,
      error: "AutoDL ComfyUI 已完成渲染，正在等待可转存的视频 URL",
    };
  }
  return {
    taskId,
    status,
    videoUrl: status === "success" ? videoUrl || undefined : undefined,
    error: status === "failed" ? providerError(payload, "AutoDL ComfyUI 任务生成失败") : undefined,
    progress: typeof payload.progress === "number" ? payload.progress : null,
  };
}
