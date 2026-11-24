import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";

export const SEEDANCE_RELAY_RESOLUTIONS = ["480p", "720p", "1080p"];

/** Secure Skill /docs#seedance-2-5-video. No network or silent parameter loss. */
export function seedanceRelayBody(config: VideoModelConfig, params: VideoGenerateParams): Record<string, unknown> {
  if (config.model_name !== "seedance-2.5") throw new Error("Seedance中转协议仅支持已核对的 seedance-2.5 模型ID");
  const seconds = params.duration ?? config.duration_seconds;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30) throw new Error("Seedance 2.5 时长须为4–30秒整数");
  const resolution = String(params.resolutionTier || params.resolution || config.api_protocol_config?.default_resolution || "720p").toLowerCase();
  if (params.resolutionTier && params.resolution && params.resolutionTier.toLowerCase() !== params.resolution.toLowerCase()) throw new Error("Seedance 2.5 请求分辨率冲突");
  const allowed = config.api_protocol_config?.resolution_options || ["480p", "720p"];
  if (!SEEDANCE_RELAY_RESOLUTIONS.includes(resolution) || !allowed.some(option => option.toLowerCase() === resolution)) {
    throw new Error("Seedance 2.5 当前渠道不支持所选分辨率");
  }
  const aspect = params.aspectRatio || "9:16";
  if (!["16:9", "9:16", "1:1"].includes(aspect)) throw new Error("Seedance 2.5 不支持该画幅");
  const images = Array.from(new Set([params.imageUrl, params.referenceImageUrl, ...(params.imageUrls || [])].filter(Boolean))) as string[];
  const videos = params.sourceVideoUrl ? [params.sourceVideoUrl] : [];
  const audios = Array.from(new Set([params.audioUrl, ...(params.audioUrls || [])].filter(Boolean))) as string[];
  if (params.lastFrameUrl) throw new Error("Seedance混合参考未定义尾帧约束，请将素材放入参考图，而非首尾帧模式");
  if (images.length > 30 || videos.length > 10 || audios.length > 10 || images.length + videos.length + audios.length > 50) throw new Error("Seedance参考素材数量超出限制");
  for (const value of [...images, ...videos, ...audios]) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Seedance参考素材必须是HTTP(S)地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Seedance参考素材必须是HTTP(S)地址");
  }
  return { model: config.model_name, prompt: params.prompt, seconds, resolution, aspect_ratio: aspect,
    ...(images.length ? { images } : {}), ...(videos.length ? { videos } : {}), ...(audios.length ? { audios } : {}) };
}
