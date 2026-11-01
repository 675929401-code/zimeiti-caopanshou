import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";
import { isPublicHttpsVideoAssetUrl } from "./video-public-url";

/** Official /docs#muse-video and /docs#official-sd-video, checked 2026-10-30.
 * The 1–10 second range is platform admission policy, not an upstream maximum.
 * https://token.secure-skill.com/assets/DocsView-CwwL14Gv.js
 */
export function isSecureSkillNativeVideoModel(model: unknown): model is "muse-video" | "seedance2.0" {
  return model === "muse-video" || model === "seedance2.0";
}

function httpsInput(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("SECURE_SKILL_MEDIA_URL_INVALID");
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("SECURE_SKILL_MEDIA_URL_INVALID"); }
  if (!isPublicHttpsVideoAssetUrl(text) || url.hash) {
    throw new Error("SECURE_SKILL_MEDIA_HTTPS_REQUIRED");
  }
  return text;
}

function inputs(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const url = httpsInput(value);
    if (url && !result.includes(url)) result.push(url);
  }
  return result;
}

function array(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("SECURE_SKILL_MEDIA_ARRAY_REQUIRED");
  return value;
}

export function secureSkillNativeVideoBody(config: VideoModelConfig, params: VideoGenerateParams): Record<string, unknown> {
  const model = config.model_name;
  if (!isSecureSkillNativeVideoModel(model)) throw new Error("SECURE_SKILL_NATIVE_MODEL_UNSUPPORTED");
  const duration = params.duration ?? config.duration_seconds;
  if (!Number.isInteger(duration) || duration < 1 || duration > 10) throw new Error("SECURE_SKILL_PLATFORM_DURATION_1_10_REQUIRED");
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("SECURE_SKILL_NATIVE_PROMPT_REQUIRED");
  const aspect = params.aspectRatio || "16:9";
  if (!["16:9", "9:16"].includes(aspect)) throw new Error("SECURE_SKILL_NATIVE_PLATFORM_ASPECT_UNSUPPORTED");
  if (params.lastFrameUrl || params.sourceVideoUrl || params.audioUrl || array(params.audioUrls).length) {
    throw new Error("SECURE_SKILL_NATIVE_INPUT_UNSUPPORTED");
  }
  if (params.generateAudio !== undefined || params.fps != null || params.seed != null || params.negativePrompt?.trim()) {
    throw new Error("SECURE_SKILL_NATIVE_OPTION_UNSUPPORTED");
  }
  const images = inputs([params.imageUrl, params.referenceImageUrl, ...array(params.imageUrls)]);
  const body: Record<string, unknown> = { model, prompt: params.prompt, duration, aspect_ratio: aspect };
  if (model === "muse-video") {
    if (images.length > 10) throw new Error("MUSE_REFERENCE_IMAGE_LIMIT_10");
    const resolutions = [params.resolutionTier, params.resolution].filter(value => value !== undefined && value !== "");
    if (resolutions.length && (config.api_protocol_config?.provider_resolution_policy !== "omit-model-default"
      || config.api_protocol_config?.public_default_resolution_alias !== "720p"
      || config.api_protocol_config?.native_resolution !== "default"
      || resolutions.some(value => value !== "720p"))) throw new Error("MUSE_DEFAULT_QUALITY_ALIAS_REQUIRED");
    // Explicit configured alias means model-default quality, not 720p output.
    // The provider resolution field is intentionally absent under this policy.
    if (images.length) body.reference_images = images;
  } else {
    if (images.length > 1) throw new Error("SS_SEEDANCE_20_PLATFORM_SINGLE_IMAGE_ONLY");
    const resolutions = [params.resolutionTier, params.resolution].filter(value => value !== undefined && value !== "");
    if (resolutions.some(value => value !== "720p")) throw new Error("SS_SEEDANCE_20_PLATFORM_720P_ONLY");
    body.resolution = "720p";
    if (images.length) body.image_url = images[0];
  }
  return body;
}

/** Preserve documented Wan3 roles, rejecting rather than filtering bad inputs. */
export function secureSkillWan3Media(config: VideoModelConfig, params: VideoGenerateParams): Array<Record<string, string>> {
  if (params.lastFrameUrl) throw new Error("WAN3_LAST_FRAME_UNSUPPORTED");
  const images = inputs([params.imageUrl, params.referenceImageUrl, ...array(params.imageUrls)]);
  const audios = inputs([params.audioUrl, ...array(params.audioUrls)]);
  const video = httpsInput(params.sourceVideoUrl);
  const protocol = config.api_protocol_config || {};
  const imageMaximum = protocol.max_reference_images ?? 10;
  const audioMaximum = protocol.max_reference_audios ?? 5;
  if (!Number.isInteger(imageMaximum) || imageMaximum < 0 || imageMaximum > 10
    || !Number.isInteger(audioMaximum) || audioMaximum < 0 || audioMaximum > 5) throw new Error("WAN3_REFERENCE_POLICY_INVALID");
  if (images.length > imageMaximum || audios.length > audioMaximum) throw new Error("WAN3_REFERENCE_LIMIT_EXCEEDED");
  if (video && protocol.supports_source_video === false) throw new Error("WAN3_SOURCE_VIDEO_NOT_ENABLED");
  if (audios.length && protocol.supports_audio_input === false) throw new Error("WAN3_AUDIO_NOT_ENABLED");
  const media: Array<Record<string, string>> = images.map((url, index) => ({ type: index === 0 ? "first_frame" : "reference_image", url }));
  if (video) media.push({ type: "reference_video", url: video });
  for (const url of audios) media.push({ type: "audio", url });
  return media;
}
