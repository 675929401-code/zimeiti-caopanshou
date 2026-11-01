import { getAiVideoPageInputCapabilities, normalizeAiVideoWorkflowInputMode } from "./ai-video-page-capabilities";
import { requiresGaoruiGrok15InputImage } from "./video-model-capabilities";

export function getGaoruiVeoComponentsReferenceLimit(model: {
  protocol_type?: unknown; model_name?: unknown; api_protocol_config?: unknown;
}): number | null {
  if (model.protocol_type !== "gaorui_video" || model.model_name !== "veo_3_1-components") return null;
  const config = model.api_protocol_config && typeof model.api_protocol_config === "object" && !Array.isArray(model.api_protocol_config)
    ? model.api_protocol_config as Record<string, unknown> : {};
  const configured = Number(config.max_reference_images);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(3, Math.max(1, Math.floor(configured))) : 3;
}

/** One interpretation of stored input requirements for the public DTO and submission gate. */
export function getVideoInputContract(model: Record<string, unknown>) {
  const config = model.api_protocol_config && typeof model.api_protocol_config === "object" && !Array.isArray(model.api_protocol_config)
    ? model.api_protocol_config as Record<string, unknown> : {};
  const mode = normalizeAiVideoWorkflowInputMode(config.workflow_input_mode ?? config.reference_input_mode);
  const maxAudios = Math.max(0, Number(config.max_reference_audios) || 0);
  const requiresGrokInputImage = requiresGaoruiGrok15InputImage(model);
  const configuredFirstFrame = config.requires_first_frame === true;
  const configuredLastFrame = config.requires_last_frame === true;
  const capabilities = getAiVideoPageInputCapabilities({
    supportsImageInput: requiresGrokInputImage || model.supports_image_input === true,
    requiresImage: requiresGrokInputImage || model.requires_image === true,
    workflowInputMode: mode,
    supportsPrompt: config.supports_prompt !== false,
    requiresSourceVideo: config.requires_source_video === true,
    requiresFirstFrame: requiresGrokInputImage || configuredFirstFrame || mode === "first_last_frame",
    requiresLastFrame: configuredLastFrame || mode === "first_last_frame",
    showFirstFrame: requiresGrokInputImage || configuredFirstFrame,
    showLastFrame: configuredLastFrame,
    minReferenceImages: config.min_reference_images ?? config.required_reference_images,
    maxReferenceImages: getGaoruiVeoComponentsReferenceLimit(model) ?? config.max_reference_images,
    minReferenceAudios: config.min_reference_audios ?? config.required_reference_audios,
    maxReferenceAudios: config.max_reference_audios,
    supportsAudioInput: config.supports_audio_input === true || maxAudios > 0,
    supportsSourceVideoInput: config.supports_source_video_input === true
      || config.requires_source_video === true,
  });
  return {
    ...capabilities,
    // An explicitly configured single first-frame input must be labelled as a
    // first frame in the UI. Synthetic compatibility requirements (such as
    // legacy Grok image input) keep the neutral reference-image control.
    showReferenceImages: capabilities.showReferenceImages
      && !(configuredFirstFrame && !configuredLastFrame && capabilities.maxReferenceImages === 1),
    // Match the adapter's existing promotion of the singular reference image.
    // Other models' explicit first-frame contracts remain strict.
    ...(requiresGrokInputImage && model.supports_image_input === true
      ? { allowReferenceImageAsFirstFrame: true } : {}),
  };
}

export type VideoInputRequest = {
  prompt?: unknown;
  imageUrl?: unknown;
  lastFrameUrl?: unknown;
  referenceImageUrl?: unknown;
  referenceImageUrls?: unknown[];
  audioUrl?: unknown;
  referenceAudioUrls?: unknown[];
  sourceVideoUrl?: unknown;
};

export type VideoInputViolation = { code: string; message: string };
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function validateVideoInputContract(
  contract: ReturnType<typeof getVideoInputContract>,
  input: VideoInputRequest,
): VideoInputViolation | null {
  if (contract.supportsPrompt && !present(input.prompt)) return { code: "VIDEO_PROMPT_REQUIRED", message: "当前模型需要填写视频提示词" };
  if (contract.requiresFirstFrame && !present(input.imageUrl)
    && !(contract.allowReferenceImageAsFirstFrame && present(input.referenceImageUrl))) {
    return { code: "VIDEO_FIRST_FRAME_REQUIRED", message: "当前模型必须提供首帧图片，请先上传图片后提交" };
  }
  if (contract.requiresLastFrame && !present(input.lastFrameUrl)) return { code: "VIDEO_LAST_FRAME_REQUIRED", message: "当前模型必须提供尾帧图片" };
  const images = [input.imageUrl, input.lastFrameUrl, input.referenceImageUrl, ...(input.referenceImageUrls || [])].filter(present);
  if (images.length < contract.minReferenceImages) return { code: "VIDEO_REFERENCE_REQUIRED", message: `当前模型至少需要 ${contract.minReferenceImages} 张参考图片，当前 ${images.length} 张，请先上传所需图片` };
  if (images.length > contract.maxReferenceImages) return { code: "VIDEO_REFERENCE_LIMIT_EXCEEDED", message: contract.maxReferenceImages > 0 ? `当前模型最多支持 ${contract.maxReferenceImages} 张参考图片` : "当前模型仅支持文生视频，请清空参考图片后提交" };
  const audios = [input.audioUrl, ...(input.referenceAudioUrls || [])].filter(present);
  if (audios.length < contract.minReferenceAudios) return { code: "VIDEO_AUDIO_REQUIRED", message: `当前模型至少需要 ${contract.minReferenceAudios} 段参考音频` };
  if (audios.length > contract.maxReferenceAudios) return { code: "VIDEO_AUDIO_LIMIT_EXCEEDED", message: contract.maxReferenceAudios > 0 ? `当前模型最多支持 ${contract.maxReferenceAudios} 段参考音频` : "当前模型不支持参考音频，请清空音频后提交" };
  if (contract.requiresSourceVideo && !present(input.sourceVideoUrl)) return { code: "VIDEO_SOURCE_REQUIRED", message: "当前模型必须提供源视频，请先上传源视频" };
  if (!contract.supportsSourceVideoInput && present(input.sourceVideoUrl)) return { code: "VIDEO_SOURCE_UNSUPPORTED", message: "当前模型不支持源视频输入，请清空源视频后提交" };
  return null;
}
