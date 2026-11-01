import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";
import { isPublicHttpsVideoAssetUrl } from "./video-public-url";
import { isVideoOptionalMediaInputAbsent } from "./video-optional-media-input";

/** Platform 720p is an explicit compatibility label for Gaorui H3's fixed native 768p canvas. */
export const GAORUI_H3_NATIVE_RESOLUTION_BY_PLATFORM_TIER: Readonly<Record<string, "768p">> = Object.freeze({ "720p": "768p", "768p": "768p" });

export function isGaoruiH3NativeModel(model: unknown): model is "minimax-h3" { return model === "minimax-h3"; }

function media(value: unknown): string {
  if (!isPublicHttpsVideoAssetUrl(value)) throw new Error("GAORUI_H3_MEDIA_URL_INVALID: 素材必须是公网 HTTPS 地址，本次未提交上游");
  return value;
}
function optional(value: unknown): string[] { return isVideoOptionalMediaInputAbsent(value) ? [] : [media(value)]; }
function list(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("GAORUI_H3_MEDIA_LIST_INVALID");
  return value.map(media);
}
function resolution(value: unknown): "768p" {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(GAORUI_H3_NATIVE_RESOLUTION_BY_PLATFORM_TIER, value)) {
    throw new Error("GAORUI_H3_RESOLUTION_INVALID: 仅支持原生 768p（平台 720p 兼容档），本次未提交上游");
  }
  return GAORUI_H3_NATIVE_RESOLUTION_BY_PLATFORM_TIER[value];
}

/** Gaorui's published MiniMax H3 JSON contract; no uploads, remote inspection, billing or truncation. */
export function gaoruiH3NativeBody(config: VideoModelConfig, params: VideoGenerateParams): Record<string, unknown> {
  if (!isGaoruiH3NativeModel(config.model_name)) throw new Error("GAORUI_H3_MODEL_UNSUPPORTED");
  if (typeof params.prompt !== "string" || !params.prompt.trim() || Array.from(params.prompt).length > 7000) {
    throw new Error("GAORUI_H3_PROMPT_INVALID: 提示词须为 1–7000 个字符，本次未提交上游");
  }
  if (params.negativePrompt !== undefined && (typeof params.negativePrompt !== "string" || params.negativePrompt.trim())) {
    throw new Error("GAORUI_H3_NEGATIVE_PROMPT_UNSUPPORTED: 本模型没有负向提示词字段，本次未提交上游");
  }
  if (params.generateAudio !== undefined) throw new Error("GAORUI_H3_AUDIO_TOGGLE_UNSUPPORTED: 原生协议未声明音轨开关，本次未提交上游");
  const duration = params.duration ?? config.duration_seconds ?? 5;
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("GAORUI_H3_DURATION_INVALID: 原生时长须为 1–15 秒整数，本次未提交上游");
  const nativeResolution = resolution(params.resolutionTier ?? params.resolution ?? config.api_protocol_config?.resolution ?? config.api_protocol_config?.default_resolution ?? "768p");
  if (params.resolutionTier !== undefined && params.resolution !== undefined && resolution(params.resolution) !== nativeResolution) {
    throw new Error("GAORUI_H3_RESOLUTION_CONFLICT");
  }
  const primary = optional(params.imageUrl), last = optional(params.lastFrameUrl);
  const mode = config.api_protocol_config?.workflow_input_mode;
  // Workbench multimodal controls use imageUrl for the primary reference. A
  // supplied last frame or an explicit frame workflow retains native frame roles.
  const referenceMode = !last.length && mode !== "first_last_frame"
    && ["multi_image", "multi_image_audio", "image_audio_lipsync"].includes(String(mode || ""));
  const first = referenceMode ? [] : primary;
  const images = [...(referenceMode ? primary : []), ...optional(params.referenceImageUrl), ...list(params.imageUrls)];
  const videos = optional(params.sourceVideoUrl), audios = [...optional(params.audioUrl), ...list(params.audioUrls)];
  if ((first.length || last.length) && (images.length || videos.length || audios.length)) {
    throw new Error("GAORUI_H3_INPUT_MODE_CONFLICT: 首尾帧不可与参考图片、视频或音频混用，本次未提交上游");
  }
  const configuredImages = config.api_protocol_config?.max_reference_images;
  const configuredAudios = config.api_protocol_config?.max_reference_audios;
  for (const limit of [configuredImages, configuredAudios]) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("GAORUI_H3_REFERENCE_LIMIT_INVALID");
  }
  if (images.length > Math.min(9, configuredImages ?? 9) || videos.length > 3 || audios.length > Math.min(3, configuredAudios ?? 3)
    || images.length + videos.length + audios.length > 12) {
    throw new Error("GAORUI_H3_REFERENCE_LIMIT_EXCEEDED: 参考图最多 9 张、视频和音频各最多 3 段，合计最多 12 个，本次未提交上游");
  }
  const hasVisual = first.length + last.length + images.length + videos.length > 0;
  const aspectRatio = params.aspectRatio ?? (hasVisual ? "adaptive" : "16:9");
  if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"].includes(aspectRatio) || aspectRatio === "adaptive" && !hasVisual) {
    throw new Error("GAORUI_H3_ASPECT_RATIO_INVALID: 自动画幅须有图片或视频素材，本次未提交上游");
  }
  const metadata: Record<string, unknown> = {};
  if (first.length) metadata.first_frame = first[0];
  if (last.length) metadata.last_frame = last[0];
  if (videos.length) metadata.videos = videos;
  if (audios.length) metadata.audios = audios;
  return { model: "minimax-h3", prompt: params.prompt, duration, resolution: nativeResolution, aspect_ratio: aspectRatio,
    ...(images.length ? { images } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) };
}
