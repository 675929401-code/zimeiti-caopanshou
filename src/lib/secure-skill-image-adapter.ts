import type { ImageResolution } from "@/lib/image-model-capabilities";
import { IMAGE_GENERATION_REQUEST_LIMITS } from "@/lib/image-generation-request";

export type SecureSkillImageRequestInput = {
  modelName: string;
  prompt: string;
  resolution: ImageResolution;
  aspectRatio: string;
  referenceImageUrls?: string[];
  providerContract?: string;
  pixelSize?: string;
  quality?: string;
};

export const SECURE_SKILL_GPT25_SYNC_CONTRACT = "secure_skill_gpt_image_2_5_sync.v1";
/** Explicit current provider contract; do not infer it from a display/model name. */
export const SECURE_SKILL_GPT25_SYNC_V2_CONTRACT = "secure_skill_gpt_image_2_5_sync.v2";
const GPT25_V2_MODELS = new Set(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
const GPT25_V2_RESOLUTIONS = new Set(["1K", "2K", "4K"]);
const GPT25_V2_ASPECT_RATIOS = new Set(["auto", "1:1", "2:1", "3:1", "16:9", "3:2", "4:3", "5:4", "4:5", "3:4", "2:3", "9:16", "1:2", "1:3", "21:9"]);
const GPT25_V2_QUALITIES = new Set(["low", "medium", "high", "xhigh", "max"]);
const GPT25_V2_MAX_REFERENCES = 16;

export function validateSecureSkillGpt25SyncInput(input: SecureSkillImageRequestInput & {
  requestProtocol: string;
  referenceTransport: string;
  maxReferenceImages: number;
  protocolConfig?: Record<string, unknown>;
}) {
  if (!input.providerContract?.startsWith("secure_skill_gpt_image_2_5_sync")) return null;
  const v2 = input.providerContract === SECURE_SKILL_GPT25_SYNC_V2_CONTRACT;
  if (input.providerContract !== SECURE_SKILL_GPT25_SYNC_CONTRACT && !v2) {
    return { code: "IMAGE_PROVIDER_CONTRACT_UNSUPPORTED", message: "当前图片模型的契约版本未受支持，请联系管理员核对配置。" };
  }
  if (!v2 && (input.requestProtocol !== "images_generations" || input.referenceTransport !== "generations_url_array"
    || input.resolution !== "1K" || input.aspectRatio !== "1:1" || input.pixelSize !== "1024x1024" || input.quality !== "high")) {
    return { code: "IMAGE_PROVIDER_CONTRACT_MISMATCH", message: "当前图片模型仅支持已确认的 1K、1:1、高质量输出，请核对模型与画幅设置。" };
  }
  if (v2 && (input.requestProtocol !== "images_generations" || input.referenceTransport !== "generations_url_array"
    || !GPT25_V2_MODELS.has(input.modelName) || !GPT25_V2_RESOLUTIONS.has(input.resolution)
    || !GPT25_V2_ASPECT_RATIOS.has(input.aspectRatio) || !GPT25_V2_QUALITIES.has(input.quality === undefined ? "high" : input.quality)
    || (input.protocolConfig?.quality !== undefined && (typeof input.protocolConfig.quality !== "string" || !GPT25_V2_QUALITIES.has(input.protocolConfig.quality))))) {
    return { code: "IMAGE_PROVIDER_CONTRACT_MISMATCH", message: "当前 GPT Image 2.5 配置必须使用已确认的同步协议、模型、1K/2K/4K、画幅与质量参数。" };
  }
  for (const [field, expected] of [["protocol", "images_generations"], ["protocol_type", "images_generations"], ["image_protocol", "images_generations"],
    ["reference_transport", "generations_url_array"], ["image_reference_transport", "generations_url_array"]]) {
    if (input.protocolConfig?.[field] !== undefined && input.protocolConfig[field] !== expected) {
      return { code: "IMAGE_PROVIDER_CONTRACT_MISMATCH", message: "当前图片模型的输入契约配置不一致，请联系管理员核对。" };
    }
  }
  // Historical v1 binds exact pixels. V2 sends resolution/aspect_ratio directly,
  // so legacy pixel maps must not silently rewrite the provider request.
  for (const field of v2 ? [] : ["request_pixel_size_by_resolution", "input_pixel_size_by_resolution", "pixel_size_by_resolution"]) {
    const configured = input.protocolConfig?.[field];
    if (configured === undefined) continue;
    if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
      return { code: "IMAGE_PROVIDER_CONTRACT_MISMATCH", message: "当前图片模型的像素尺寸配置无效，请联系管理员核对。" };
    }
    for (const [resolution, map] of Object.entries(configured)) {
      if (resolution.trim().toUpperCase() !== "1K") continue;
      if (!map || typeof map !== "object" || Array.isArray(map)
        || (Object.prototype.hasOwnProperty.call(map, "1:1") && String((map as Record<string, unknown>)["1:1"]).trim().toLowerCase() !== "1024x1024")) {
        return { code: "IMAGE_PROVIDER_CONTRACT_MISMATCH", message: "当前图片模型的像素尺寸配置与已确认契约不一致。" };
      }
    }
  }
  const references = input.referenceImageUrls || [];
  if (!Number.isSafeInteger(input.maxReferenceImages) || input.maxReferenceImages < 0 || references.length > input.maxReferenceImages
    || v2 && references.length > GPT25_V2_MAX_REFERENCES) {
    return { code: "IMAGE_REFERENCE_LIMIT_EXCEEDED", message: "参考图片数量超出当前模型允许的上限。" };
  }
  if (references.some(reference => {
    try {
      const url = new URL(reference);
      return !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password);
    } catch { return true; }
  })) return { code: "IMAGE_REFERENCE_INVALID", message: "当前图片模型需要可公开访问的 HTTP(S) 参考图片链接。" };
  return null;
}

export function buildSecureSkillImagePayload(input: SecureSkillImageRequestInput): {
  model: string; prompt: string; n: 1; response_format: "url"; image?: string[];
  image_size?: ImageResolution; resolution?: ImageResolution; aspect_ratio?: string; size?: string; quality?: string;
} {
  if (input.providerContract?.startsWith("secure_skill_gpt_image_2_5_sync")) {
    const issue = validateSecureSkillGpt25SyncInput({ ...input, requestProtocol: "images_generations", referenceTransport: "generations_url_array", maxReferenceImages: input.providerContract === SECURE_SKILL_GPT25_SYNC_V2_CONTRACT ? GPT25_V2_MAX_REFERENCES : IMAGE_GENERATION_REQUEST_LIMITS.maxReferences });
    if (issue) throw new Error(issue.code);
    const references = input.referenceImageUrls || [];
    if (input.providerContract === SECURE_SKILL_GPT25_SYNC_V2_CONTRACT) {
      return { model: input.modelName, prompt: input.prompt, n: 1, response_format: "url", resolution: input.resolution,
        aspect_ratio: input.aspectRatio, quality: input.quality === undefined ? "high" : input.quality, ...(references.length > 0 ? { image: references } : {}) };
    }
    return { model: input.modelName, prompt: input.prompt, n: 1, response_format: "url", size: "1024x1024", quality: "high",
      ...(references.length > 0 ? { image: references } : {}) };
  }
  const references = (input.referenceImageUrls || []).filter(Boolean);
  return {
    model: input.modelName,
    prompt: input.prompt,
    n: 1,
    image_size: input.resolution,
    aspect_ratio: input.aspectRatio,
    ...(references.length > 0 ? { image: references } : {}),
    response_format: "url",
  };
}
