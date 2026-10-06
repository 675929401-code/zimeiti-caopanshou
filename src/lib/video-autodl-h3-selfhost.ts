import { videoProviderFetch as fetch } from "./video-provider-request-audit";
import {
  autodlH3SelfhostVideoEndpoint,
  autodlH3VideoOutputTier,
  autodlH3VideoPixelSize,
  normalizeAutodlH3VideoResolutionTier,
  resolveAutodlH3SelfhostResultUrl,
} from "./autodl-h3-selfhost";
import type { VideoGenerateParams, VideoModelConfig, VideoTaskResult } from "./video-adapter";

const MODEL_ID = "minimax-h3-turbo";
const DURATIONS = new Set([5, 10, 15]);
const TASK_ID_RE = /^h3_[a-f0-9]+$/u;

function endpoint(config: VideoModelConfig) {
  return autodlH3SelfhostVideoEndpoint(config.api_endpoint);
}

function errorMessage(data: Record<string, unknown>, fallback: string) {
  const error = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : null;
  return String(error?.message || data.message || fallback).replace(/\s+/gu, " ").slice(0, 300);
}

function parseResult(
  config: VideoModelConfig,
  taskId: string,
  data: Record<string, unknown>,
  expectedOutputTier?: string,
): VideoTaskResult {
  const status = String(data.status || "processing").toLowerCase();
  const returnedIds = [data.id, data.task_id]
    .map((value) => String(value || ""))
    .filter(Boolean);
  if (taskId && (returnedIds.length === 0 || returnedIds.some((value) => value !== taskId))) {
    throw new Error("AutoDL H3 自租网关返回了不匹配的任务 ID");
  }
  const returnedId = returnedIds[0] || "";
  if (!TASK_ID_RE.test(returnedId)) throw new Error("AutoDL H3 自租网关返回了无效任务 ID");
  const returnedOutputTier = String(data.output_tier || "").trim();
  if (expectedOutputTier && returnedOutputTier && returnedOutputTier !== expectedOutputTier) {
    throw new Error("AutoDL H3 自租网关返回了不匹配的输出分辨率档");
  }
  if (["failed", "error", "cancelled", "canceled"].includes(status)) {
    return { taskId: returnedId, status: "failed", error: errorMessage(data, "AutoDL H3 视频生成失败") };
  }
  if (["completed", "succeeded", "success"].includes(status)) {
    const output = data.output && typeof data.output === "object" ? data.output as Record<string, unknown> : null;
    const dataObject = data.data && typeof data.data === "object" && !Array.isArray(data.data)
      ? data.data as Record<string, unknown>
      : null;
    const rows = Array.isArray(data.data) ? data.data : [];
    const first = rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : null;
    const rawUrl = String(
      first?.url
      || first?.video_url
      || dataObject?.url
      || dataObject?.video_url
      || dataObject?.file_url
      || output?.url
      || output?.video_url
      || data.video_url
      || "",
    );
    if (!rawUrl) throw new Error("AutoDL H3 自租任务完成但没有返回视频地址");
    return {
      taskId: returnedId,
      status: "success",
      videoUrl: resolveAutodlH3SelfhostResultUrl(rawUrl, config.api_endpoint),
    };
  }
  return { taskId: returnedId, status: status === "queued" ? "queued" : "processing" };
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}") as Record<string, unknown>;
  } catch {
    throw new Error(`AutoDL H3 自租网关返回了非 JSON 响应 (${response.status})`);
  }
}

export type AutodlH3SelfhostGatewayReadiness = {
  ready: boolean;
  reason: "ready" | "not_ready" | "unreachable";
};

/**
 * A no-generation readiness probe for the exact loopback H3 gateway.
 * It never sends the gateway credential and never retries.
 */
export async function probeAutodlH3SelfhostGateway(
  apiEndpoint: string,
): Promise<AutodlH3SelfhostGatewayReadiness> {
  const submitEndpoint = new URL(autodlH3SelfhostVideoEndpoint(apiEndpoint));
  const healthUrl = `${submitEndpoint.origin}/health/ready`;
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return { ready: false, reason: "not_ready" };
    const data = await readJson(response);
    return String(data.status || "").toLowerCase() === "ready"
      ? { ready: true, reason: "ready" }
      : { ready: false, reason: "not_ready" };
  } catch {
    return { ready: false, reason: "unreachable" };
  }
}

export async function generateAutodlH3SelfhostVideo(
  config: VideoModelConfig,
  params: VideoGenerateParams,
): Promise<VideoTaskResult> {
  const model = String(config.model_name || config.id || "");
  if (model !== MODEL_ID) throw new Error(`AutoDL H3 自租协议只允许模型 ${MODEL_ID}`);
  const duration = Number(params.duration || config.duration_seconds || 10);
  if (!DURATIONS.has(duration)) throw new Error("AutoDL H3 自租视频仅支持 5、10、15 秒");
  const aspectRatio = String(params.aspectRatio || "16:9");
  const requestedResolution = params.resolutionTier || params.resolution
    || config.api_protocol_config?.default_resolution
    || config.api_protocol_config?.resolution
    || "480p";
  const resolutionTier = normalizeAutodlH3VideoResolutionTier(requestedResolution);
  if (!resolutionTier) throw new Error("AutoDL H3 自租视频分辨率档无效");
  const secondaryResolution = params.resolution && params.resolutionTier
    ? normalizeAutodlH3VideoResolutionTier(params.resolution)
    : resolutionTier;
  if (!secondaryResolution || secondaryResolution !== resolutionTier) {
    throw new Error("AutoDL H3 自租视频分辨率字段不一致");
  }
  const size = autodlH3VideoPixelSize(aspectRatio, resolutionTier, config.api_protocol_config);
  const outputTier = autodlH3VideoOutputTier(resolutionTier, config.api_protocol_config);
  const supportedCombinations = Array.isArray(config.api_protocol_config?.supported_combinations)
    ? config.api_protocol_config.supported_combinations.map(String)
    : [];
  if (supportedCombinations.length > 0
    && !supportedCombinations.includes(`${resolutionTier}|${duration}|${aspectRatio}`)) {
    throw new Error(`AutoDL H3 自租尚未开放 ${resolutionTier}|${duration}|${aspectRatio}`);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
    "Content-Type": "application/json",
  };
  if (params.idempotencyKey) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(params.idempotencyKey)) {
      throw new Error("AutoDL H3 自租幂等键格式无效");
    }
    headers["Idempotency-Key"] = params.idempotencyKey;
  }
  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    size,
    duration,
    aspect_ratio: aspectRatio,
  };
  // 显式传递网关输出档：base / 1080p / 2K，禁止由网关猜测。
  body.output_tier = outputTier;
  if (params.imageUrl) body.image_url = params.imageUrl;
  if (params.lastFrameUrl) body.last_frame_url = params.lastFrameUrl;
  if (params.referenceImageUrl) body.reference_image_url = params.referenceImageUrl;

  const response = await fetch(endpoint(config), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(`AutoDL H3 自租提交失败 (${response.status}): ${errorMessage(data, "未知错误")}`);
  return parseResult(config, "", data, outputTier);
}

export async function pollAutodlH3SelfhostVideo(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  if (!TASK_ID_RE.test(taskId)) throw new Error("AutoDL H3 自租任务 ID 格式无效");
  const submitEndpoint = new URL(endpoint(config));
  const pollUrl = `${submitEndpoint.origin}/v1/video/generations/${encodeURIComponent(taskId)}`;
  const response = await fetch(pollUrl, {
    headers: { Authorization: `Bearer ${config.api_key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(`AutoDL H3 自租轮询失败 (${response.status}): ${errorMessage(data, "未知错误")}`);
  return parseResult(config, taskId, data);
}
