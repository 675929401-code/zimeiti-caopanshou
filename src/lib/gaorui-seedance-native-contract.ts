import type { VideoGenerateParams, VideoModelConfig } from "./video-adapter";
import { isPublicHttpsVideoAssetUrl } from "./video-public-url";
import { assertGaoruiTrustedPersonAsset, gaoruiCredentialBindingFingerprint } from "./gaorui-provider-asset-contract";
import { isVideoOptionalMediaInputAbsent } from "./video-optional-media-input";
import { gaoruiVideoCreateContractAdmission } from "./gaorui-video-contract-admission";

/** Public Gaorui Seedance create-task schema; URLs remain subject to the existing public HTTPS policy. */
export function isGaoruiSeedanceNativeModel(model: unknown): model is "seedance-2.0" | "seedance-2.5" | "seedance-2.0-fast" | "seedance-2.0-mini" {
  return model === "seedance-2.0" || model === "seedance-2.5" || model === "seedance-2.0-fast" || model === "seedance-2.0-mini";
}

/** Creation binding does not interfere with recovering existing native tasks. */
export function isGaoruiSeedanceNativePollModel(model: unknown) {
  return isGaoruiSeedanceNativeModel(model);
}

type SeedanceContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" | "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

export type GaoruiSeedanceNativeBody = {
  model: "seedance-2.0" | "seedance-2.5" | "seedance-2.0-fast" | "seedance-2.0-mini";
  content: SeedanceContent[];
  duration: number;
  ratio: string;
  resolution: string;
  generate_audio: boolean;
};

function mediaUrl(value: unknown): string {
  if (!isPublicHttpsVideoAssetUrl(value)) {
    throw new Error("GAORUI_SEEDANCE_MEDIA_URL_INVALID: 参考素材必须是公网 HTTPS 地址，本次未提交上游");
  }
  return value;
}

function optionalMedia(value: unknown): string[] {
  return isVideoOptionalMediaInputAbsent(value) ? [] : [mediaUrl(value)];
}

function mediaArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("GAORUI_SEEDANCE_MEDIA_LIST_INVALID: 参考素材列表格式无效");
  return value.map(mediaUrl);
}

/**
 * No network, upload, asset lookup or pricing occurs here. Every input first
 * passes the public HTTPS contract. Only server-issued, fully scoped person
 * certificates can then replace their exact image URL with a provider asset URI.
 */
export function gaoruiSeedanceNativeParameters(config: VideoModelConfig, params: VideoGenerateParams) {
  const model = config.model_name;
  if (!isGaoruiSeedanceNativeModel(model)) throw new Error("GAORUI_SEEDANCE_MODEL_UNSUPPORTED");
  const admission = gaoruiVideoCreateContractAdmission(config);
  if (!admission.ready) throw new Error(`${admission.code}: ${admission.message}`);
  if ((model === "seedance-2.0" || model === "seedance-2.5")
    && ([params.lastFrameUrl, params.referenceImageUrl, params.sourceVideoUrl, params.audioUrl].some(value => !isVideoOptionalMediaInputAbsent(value))
      || [params.imageUrls, params.audioUrls].some(value => value !== undefined && (!Array.isArray(value) || value.length > 0)))) {
    throw new Error("GAORUI_SEEDANCE_PLAIN_INPUT_UNSUPPORTED: 当前型号仅支持文本和可选单首帧，本次未提交上游");
  }

  // Never infer paid duration from prose, round a value, or permit provider-selected duration -1.
  const duration = params.duration ?? config.duration_seconds;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new Error("GAORUI_SEEDANCE_DURATION_INVALID: 时长须为 4–15 秒整数，本次未提交上游");
  }
  const ratio = params.aspectRatio ?? "16:9";
  if (!["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(ratio)) {
    throw new Error("GAORUI_SEEDANCE_RATIO_INVALID: 不支持该画幅，本次未提交上游");
  }
  const protocol = config.api_protocol_config;
  const selectedResolution = params.resolutionTier ?? params.resolution ?? protocol?.resolution ?? protocol?.default_resolution ?? "720p";
  const resolution = model === "seedance-2.0" && selectedResolution === "4K" ? "4k" : selectedResolution;
  if (params.resolutionTier !== undefined && params.resolution !== undefined && params.resolutionTier !== params.resolution) {
    throw new Error("GAORUI_SEEDANCE_RESOLUTION_CONFLICT: 分辨率与分辨率档位不一致，本次未提交上游");
  }
  const resolutions = model === "seedance-2.0" ? ["480p", "720p", "1080p", "4k"] : model === "seedance-2.5" ? ["480p", "720p", "1080p"] : ["480p", "720p"];
  if (!resolutions.includes(resolution)) {
    throw new Error(`GAORUI_SEEDANCE_RESOLUTION_INVALID: 当前型号支持 ${resolutions.join("/")}，本次未提交上游`);
  }
  if (typeof params.prompt !== "string") throw new Error("GAORUI_SEEDANCE_PROMPT_INVALID");
  if (params.negativePrompt !== undefined && (typeof params.negativePrompt !== "string" || params.negativePrompt.trim())) {
    throw new Error("GAORUI_SEEDANCE_NEGATIVE_PROMPT_UNSUPPORTED: 原生协议未声明反向提示词字段，本次未提交上游");
  }
  if (params.generateAudio !== undefined && typeof params.generateAudio !== "boolean") {
    throw new Error("GAORUI_SEEDANCE_GENERATE_AUDIO_INVALID");
  }
  const generateAudio = params.generateAudio ?? protocol?.generate_audio ?? true;
  if (typeof generateAudio !== "boolean") throw new Error("GAORUI_SEEDANCE_GENERATE_AUDIO_INVALID");

  return { model, duration, ratio, resolution, generate_audio: generateAudio };
}

export function gaoruiSeedanceNativeBody(config: VideoModelConfig, params: VideoGenerateParams): GaoruiSeedanceNativeBody {
  const { model, duration, ratio, resolution, generate_audio: generateAudio } = gaoruiSeedanceNativeParameters(config, params);
  const protocol = config.api_protocol_config;
  const firstFrames = optionalMedia(params.imageUrl);
  const lastFrames = optionalMedia(params.lastFrameUrl);
  const images = [...optionalMedia(params.referenceImageUrl), ...mediaArray(params.imageUrls)];
  const videos = optionalMedia(params.sourceVideoUrl);
  const audios = [...optionalMedia(params.audioUrl), ...mediaArray(params.audioUrls)];
  if (model === "seedance-2.0" || model === "seedance-2.5") {
    if (model === "seedance-2.5" && firstFrames.length && ratio !== "adaptive") throw new Error("GAORUI_SEEDANCE_FIRST_FRAME_RATIO_REQUIRED: 带首帧时须明确使用跟随首帧比例 adaptive，本次未提交上游");
    if (!firstFrames.length && ratio === "adaptive") throw new Error("GAORUI_SEEDANCE_TEXT_RATIO_REQUIRED: 文生视频须选择固定合法画幅，本次未提交上游");
  }
  if (lastFrames.length && !firstFrames.length) throw new Error("GAORUI_SEEDANCE_FIRST_FRAME_REQUIRED: 尾帧必须搭配首帧");
  if ((firstFrames.length || lastFrames.length) && (images.length || videos.length || audios.length)) {
    throw new Error("GAORUI_SEEDANCE_INPUT_MODE_CONFLICT: 首尾帧与全模态参考模式不可混用，本次未提交上游");
  }
  const configuredImageLimit = protocol?.max_reference_images;
  const configuredAudioLimit = protocol?.max_reference_audios;
  for (const limit of [configuredImageLimit, configuredAudioLimit]) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("GAORUI_SEEDANCE_REFERENCE_LIMIT_INVALID");
  }
  const imageLimit = Math.min(9, configuredImageLimit ?? 9);
  const audioLimit = Math.min(3, configuredAudioLimit ?? 3);
  if (images.length > imageLimit || videos.length > 3 || audios.length > audioLimit) {
    throw new Error(`GAORUI_SEEDANCE_REFERENCE_LIMIT_EXCEEDED: 最多 ${imageLimit} 张参考图、3 个参考视频、${audioLimit} 段参考音频，本次未提交上游`);
  }
  if (audios.length && !images.length && !videos.length) {
    throw new Error("GAORUI_SEEDANCE_AUDIO_REQUIRES_VISUAL: 参考音频须至少搭配一张参考图或一个参考视频");
  }
  const content: SeedanceContent[] = params.prompt.trim() ? [{ type: "text", text: params.prompt }] : [];
  // Preserve each supplied role and order, including the same URL used as both first and last frame.
  for (const url of firstFrames) content.push({ type: "image_url", image_url: { url }, role: "first_frame" });
  for (const url of lastFrames) content.push({ type: "image_url", image_url: { url }, role: "last_frame" });
  for (const url of images) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  for (const url of videos) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  for (const url of audios) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  if (!content.length) throw new Error("GAORUI_SEEDANCE_CONTENT_REQUIRED");
  const body = { model, content, duration, ratio, resolution, generate_audio: generateAudio };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024 * 1024) {
    throw new Error("GAORUI_SEEDANCE_REQUEST_TOO_LARGE: 请求体不可超过 64 MB，本次未提交上游");
  }
  mapTrustedPersonAssets(config, params, body);
  return body;
}

function mapTrustedPersonAssets(config: VideoModelConfig, params: VideoGenerateParams, body: GaoruiSeedanceNativeBody) {
  const certificates = params.gaoruiTrustedPersonAssets;
  if (certificates === undefined) return;
  if (!Array.isArray(certificates) || certificates.length > 9) throw new Error("GAORUI_PERSON_ASSET_CERTIFICATES_INVALID");
  if (!certificates.length) return;
  if (config.model_name !== "seedance-2.0-fast" || config.protocol_type !== "gaorui_video"
    || typeof params.inputOwnerId !== "string" || !params.inputOwnerId
    || typeof params.gaoruiOwnedPersonAssetId !== "string" || !params.gaoruiOwnedPersonAssetId) {
    throw new Error("GAORUI_PERSON_ASSET_SCOPE_MISMATCH");
  }
  const fingerprint = gaoruiCredentialBindingFingerprint({ secret: config.api_key, modelId: config.id, endpoint: config.api_endpoint });
  const replacements = new Map<number, string>();
  for (const certificate of certificates) {
    // sourceUrl is only a matching hint until WeakSet authority and the complete
    // server/config scope are checked below. No caller URI enters the body.
    const source = certificate && typeof certificate === "object" ? certificate.sourceUrl : undefined;
    const matches = body.content.flatMap((item, index) => item.type === "image_url" && item.image_url.url === source ? [{ item, index }] : []);
    if (matches.length !== 1 || replacements.has(matches[0].index)) throw new Error("GAORUI_PERSON_ASSET_SOURCE_MISMATCH");
    const { item, index } = matches[0];
    if (item.role !== "first_frame" && item.role !== "reference_image") throw new Error("GAORUI_PERSON_ASSET_ROLE_UNSUPPORTED");
    const asset = assertGaoruiTrustedPersonAsset(certificate, {
      userId: params.inputOwnerId, ownedAssetId: params.gaoruiOwnedPersonAssetId,
      modelId: config.id, modelName: config.model_name, endpoint: config.api_endpoint,
      credentialBindingFingerprint: fingerprint, sourceUrl: item.image_url.url, nativeRole: item.role,
    });
    replacements.set(index, asset.assetUrl);
  }
  for (const [index, assetUrl] of replacements) {
    const item = body.content[index];
    if (item.type === "image_url") item.image_url.url = assetUrl;
  }
}
