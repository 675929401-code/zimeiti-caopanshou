import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";
import { isPublicHttpsVideoAssetUrl } from "./video-public-url";
import { isVideoOptionalMediaInputAbsent } from "./video-optional-media-input";

export function isGaoruiGrokNativeModel(model: unknown): boolean {
  return model === "grok-imagine-1.0-video" || model === "grok-imagine-video-1.5" || model === "grok-imagine-video-1.5-preview";
}
const pixels: Record<string, string> = { "16:9": "1280x720", "9:16": "720x1280", "1:1": "1024x1024" };

/** Exact published Grok generation schema; source-video editing is a separate model contract. */
export function gaoruiGrokNativeBody(config: VideoModelConfig, params: VideoGenerateParams): Record<string, unknown> {
  const model = config.model_name;
  if (!isGaoruiGrokNativeModel(model)) throw new Error("GAORUI_GROK_MODEL_UNSUPPORTED");
  const isV10 = model === "grok-imagine-1.0-video", isPreview = model === "grok-imagine-video-1.5-preview";
  const duration = params.duration ?? config.duration_seconds;
  if (!Number.isInteger(duration) || !(isV10 ? [6, 10, 15] : [6, 8, 10, 12, 15]).includes(duration)) {
    throw new Error("GAORUI_GROK_DURATION_INVALID: 时长不在当前原生档位内，本次未提交上游");
  }
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("GAORUI_GROK_PROMPT_REQUIRED");
  if (params.negativePrompt !== undefined && (typeof params.negativePrompt !== "string" || params.negativePrompt.trim())) throw new Error("GAORUI_GROK_NEGATIVE_PROMPT_UNSUPPORTED");
  if (params.generateAudio !== undefined) throw new Error("GAORUI_GROK_AUDIO_TOGGLE_UNSUPPORTED");
  if (params.audioUrls !== undefined && !Array.isArray(params.audioUrls)) throw new Error("GAORUI_GROK_REFERENCE_LIST_INVALID");
  if (!isVideoOptionalMediaInputAbsent(params.sourceVideoUrl) || !isVideoOptionalMediaInputAbsent(params.audioUrl) || params.audioUrls?.length) throw new Error("GAORUI_GROK_REFERENCE_KIND_UNSUPPORTED");
  if (params.imageUrls !== undefined && !Array.isArray(params.imageUrls)) throw new Error("GAORUI_GROK_REFERENCE_LIST_INVALID");
  const singles = [params.imageUrl, params.referenceImageUrl, params.lastFrameUrl].filter(value => !isVideoOptionalMediaInputAbsent(value));
  const refs = [...singles, ...(params.imageUrls ?? [])].map(value => {
      if (!isPublicHttpsVideoAssetUrl(value)) throw new Error("GAORUI_GROK_MEDIA_URL_INVALID: 参考图必须为公网 HTTPS 地址，本次未提交上游");
      return value;
    });
  // Reference indices are meaningful in prompts (@图1, @图2); preserve every supplied slot.
  const images = refs;
  const configuredMaximum = config.api_protocol_config?.max_reference_images;
  if (configuredMaximum !== undefined && (!Number.isInteger(configuredMaximum) || configuredMaximum < 0)) throw new Error("GAORUI_GROK_REFERENCE_LIMIT_INVALID");
  const maximum = Math.min(isPreview ? 1 : 5, configuredMaximum ?? (isPreview ? 1 : 5));
  if (images.length > maximum) throw new Error(`GAORUI_GROK_REFERENCE_LIMIT_EXCEEDED: 当前模型最多 ${maximum} 张参考图，本次未提交上游`);
  if (isV10 && images.length > 1 && duration > 10) throw new Error("GAORUI_GROK_MULTI_IMAGE_DURATION_EXCEEDED: 1.0 多图参考最长 10 秒，本次未提交上游");
  const pixelRatio = Object.entries(pixels).find(([, size]) => size === params.resolution)?.[0];
  const ratio = params.aspectRatio ?? pixelRatio ?? "16:9";
  if (!Object.prototype.hasOwnProperty.call(pixels, ratio) || pixelRatio && pixelRatio !== ratio) throw new Error("GAORUI_GROK_ASPECT_RATIO_INVALID");
  const tier = params.resolutionTier ?? (pixelRatio ? undefined : params.resolution) ?? config.api_protocol_config?.resolution ?? config.api_protocol_config?.default_resolution ?? (isV10 ? "720p" : "480p");
  if (!(isV10 ? ["720p"] : ["480p", "720p"]).includes(tier)) throw new Error("GAORUI_GROK_RESOLUTION_INVALID: 不支持该分辨率，本次未提交上游");
  if (params.resolutionTier !== undefined && params.resolution !== undefined && !pixelRatio && params.resolution !== params.resolutionTier) throw new Error("GAORUI_GROK_RESOLUTION_CONFLICT");
  return { model, prompt: params.prompt, size: isV10 ? pixels[ratio] : ratio, seconds: duration,
    ...(!isV10 ? { resolution: tier } : {}), ...(images.length ? { image_urls: images } : {}) };
}
