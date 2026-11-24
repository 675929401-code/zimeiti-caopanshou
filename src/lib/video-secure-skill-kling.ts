import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";

/** Secure Skill /docs Kling JSON contract; group permissions remain external. */
export function secureSkillKlingBody(config: VideoModelConfig, params: VideoGenerateParams): Record<string, unknown> {
  const protocol = config.api_protocol_config || {};
  const duration = Number(params.duration ?? config.duration_seconds ?? 10);
  const minimum = Math.max(3, Number(protocol.min_duration) || 3);
  const maximum = Math.min(30, Number(protocol.max_duration) || 30);
  if (!Number.isInteger(duration) || duration < minimum || duration > maximum) throw new Error("KLING_DURATION_OUTSIDE_CONFIGURED_RANGE");
  if (config.model_name !== "kling-video-v4" || !params.prompt.trim()) throw new Error("KLING_MODEL_AND_PROMPT_REQUIRED");
  const resolution = String(params.resolutionTier || protocol.default_resolution || "720p").toLowerCase();
  if (!["720p", "1080p"].includes(resolution)) throw new Error("KLING_RESOLUTION_UNSUPPORTED");
  const urls = (values: Array<string | undefined>): string[] => [...new Set(values.filter((v): v is string => Boolean(v)))].map(value => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("KLING_REFERENCE_URL_INVALID"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("KLING_REFERENCE_URL_INVALID");
    return value;
  });
  const images = urls([params.imageUrl, params.referenceImageUrl, params.lastFrameUrl, ...(params.imageUrls || [])]);
  const videos = urls([params.sourceVideoUrl]);
  if (params.audioUrl || params.audioUrls?.some(Boolean)) throw new Error("可灵当前渠道不支持参考音频，请选择支持声音参考的渠道");
  if (params.generateAudio === true) throw new Error("可灵当前渠道不支持主动开启声音生成");
  const imageLimit = Math.min(10, Number(protocol.max_reference_images) || 10);
  if (images.length > imageLimit || images.length + videos.length > 15) throw new Error("KLING_REFERENCE_LIMIT_EXCEEDED");
  if (videos.length && protocol.supports_source_video === false) throw new Error("KLING_SOURCE_VIDEO_NOT_CONFIGURED");
  const ratio = params.aspectRatio || "16:9";
  if (!["16:9", "9:16", "1:1", "21:9"].includes(ratio) && !(ratio === "auto" && videos.length)) throw new Error("KLING_RATIO_UNSUPPORTED");
  const media = [
    ...images.map(url => ({ type: "reference_image", url })),
    ...videos.map(url => ({ type: "reference_video", url })),
  ];
  return {
    model: config.model_name, prompt: params.prompt, duration, resolution, ratio,
    ...(media.length ? { media } : {}),
    ...(videos.length && params.generateAudio === false ? { enable_audio: false } : {}),
  };
}
