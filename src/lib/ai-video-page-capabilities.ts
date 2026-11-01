import {
  getVideoResolutionCapabilities,
  normalizeVideoResolution,
  type VideoModelCapabilitySource,
} from "./video-model-capabilities";

export type AiVideoWorkflowInputMode =
  | "text"
  | "multi_image"
  | "first_last_frame"
  | "image_audio_lipsync"
  | "multi_image_audio"
  | "flexible_image";

export type AiVideoPageCapabilitySource = VideoModelCapabilitySource & {
  firstFrameRatioPolicy?: unknown;
  workflowInputMode?: unknown;
  supportsPrompt?: unknown;
  minReferenceImages?: unknown;
  maxReferenceImages?: unknown;
  minReferenceAudios?: unknown;
  maxReferenceAudios?: unknown;
  requiresFirstFrame?: unknown;
  requiresLastFrame?: unknown;
  showFirstFrame?: unknown;
  showLastFrame?: unknown;
  showReferenceImages?: unknown;
  showAudioInputs?: unknown;
  supportsImageInput?: unknown;
  requiresImage?: unknown;
  supportsAudioInput?: unknown;
  supportsSourceVideoInput?: unknown;
  requiresSourceVideo?: unknown;
};
/** Public parameter rule; the request and visible UI must agree before submission. */
export function resolveAiVideoInputAspectRatio(model: AiVideoPageCapabilitySource | undefined, requested: string, input: { imageUrl?: unknown }) {
  const caps = model?.capabilities && typeof model.capabilities === "object" ? model.capabilities as Record<string, unknown> : {};
  return (model?.firstFrameRatioPolicy ?? caps.firstFrameRatioPolicy) === "adaptive"
    && typeof input.imageUrl === "string" && Boolean(input.imageUrl.trim()) ? "adaptive" : requested;
}

export type AiVideoPageInputCapabilities = {
  mode: AiVideoWorkflowInputMode;
  supportsPrompt: boolean;
  showFirstFrame: boolean;
  showLastFrame: boolean;
  showReferenceImages: boolean;
  showAudioInputs: boolean;
  requiresFirstFrame: boolean;
  requiresLastFrame: boolean;
  minReferenceImages: number;
  maxReferenceImages: number;
  minReferenceAudios: number;
  maxReferenceAudios: number;
  supportsSourceVideoInput: boolean;
  requiresSourceVideo: boolean;
};

export const AI_VIDEO_PAGE_ASPECT_RATIOS = [
  { label: "横屏 16:9", value: "16:9" },
  { label: "竖屏 9:16", value: "9:16" },
  { label: "方形 1:1", value: "1:1" },
] as const;

const RESOLUTION_RANK: Readonly<Record<string, number>> = {
  "480p": 480,
  "720p": 720,
  "768p": 768,
  "1080p": 1080,
  "2K": 2000,
  "4K": 4000,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstDefined(source: AiVideoPageCapabilitySource, ...keys: string[]): unknown {
  const capabilities = objectValue(source.capabilities);
  for (const key of keys) {
    if (source[key as keyof AiVideoPageCapabilitySource] !== undefined) {
      return source[key as keyof AiVideoPageCapabilitySource];
    }
    if (capabilities[key] !== undefined) return capabilities[key];
  }
  return undefined;
}

function boundedCount(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : fallback;
}

export function normalizeAiVideoWorkflowInputMode(value: unknown): AiVideoWorkflowInputMode | "" {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "none" || mode === "t2v" || mode === "text_to_video" || mode === "text-to-video") {
    return "text";
  }
  if (mode === "single" || mode === "single_image" || mode === "single-image" || mode === "i2v" || mode === "image_to_video" || mode === "image-to-video") {
    return "flexible_image";
  }
  if (mode === "multi") return "multi_image";
  if (mode === "first-last-frame") return "first_last_frame";
  return mode === "text"
    || mode === "multi_image"
    || mode === "first_last_frame"
    || mode === "image_audio_lipsync"
    || mode === "multi_image_audio"
    || mode === "flexible_image"
    ? mode
    : "";
}

/**
 * AI 视频页的分辨率默认值：
 * - 全部分辨率同价时默认最高画质；
 * - 存在价差时尊重管理员/官方显式默认值；
 * - 没有显式默认值时选最低价格，同价档内再选最高画质，避免静默升价。
 */
export function getAiVideoPageDefaultResolution(model?: AiVideoPageCapabilitySource): string {
  const resolution = getVideoResolutionCapabilities(model);
  if (resolution.options.length === 0) return "";

  const highest = (options: string[]) => [...options].sort((left, right) => (
    (RESOLUTION_RANK[right] || 0) - (RESOLUTION_RANK[left] || 0)
  ))[0] || options[0] || "";
  const prices = resolution.options.map((option) => resolution.publicPrices[option]);
  const allFinite = prices.every((price) => Number.isFinite(price) && price >= 0);
  const allSamePrice = allFinite && new Set(prices).size === 1;
  if (allSamePrice) return highest(resolution.options);

  const capabilities = objectValue(model?.capabilities);
  const configuredDefault = normalizeVideoResolution(
    model?.defaultResolution
      ?? model?.default_resolution
      ?? model?.resolutionTier
      ?? capabilities.defaultResolution
      ?? capabilities.resolutionTier,
  );
  if (resolution.options.includes(configuredDefault)) return configuredDefault;

  if (allFinite) {
    const minimumPrice = Math.min(...prices);
    return highest(resolution.options.filter((option) => resolution.publicPrices[option] === minimumPrice));
  }
  return resolution.defaultResolution || resolution.options[0] || "";
}

/** Convert the public model capability DTO into deterministic AI-video controls. */
export function getAiVideoPageInputCapabilities(
  model?: AiVideoPageCapabilitySource,
): AiVideoPageInputCapabilities {
  if (!model) {
    return {
      mode: "text",
      supportsPrompt: true,
      showFirstFrame: false,
      showLastFrame: false,
      showReferenceImages: false,
      showAudioInputs: false,
      requiresFirstFrame: false,
      requiresLastFrame: false,
      minReferenceImages: 0,
      maxReferenceImages: 0,
      minReferenceAudios: 0,
      maxReferenceAudios: 0,
      supportsSourceVideoInput: false,
      requiresSourceVideo: false,
    };
  }

  const supportsImageInput = firstDefined(model, "supportsImageInput") === true;
  const requiresImage = firstDefined(model, "requiresImage") === true;
  const requiresFirstFrame = firstDefined(model, "requiresFirstFrame") === true;
  const requiresLastFrame = firstDefined(model, "requiresLastFrame") === true;
  const declaredMode = normalizeAiVideoWorkflowInputMode(firstDefined(model, "workflowInputMode"));
  const configuredMinReferenceImages = firstDefined(model, "minReferenceImages");
  const configuredMaxReferenceImages = firstDefined(model, "maxReferenceImages");
  const configuredImageCount = Math.max(
    Number(configuredMinReferenceImages) || 0,
    Number(configuredMaxReferenceImages) || 0,
  );
  const requiredFrameCount = Number(requiresFirstFrame) + Number(requiresLastFrame);
  const minimumRequiredImages = Math.max(requiresImage ? 1 : 0, requiredFrameCount);
  const declaredImageMode = Boolean(declaredMode && declaredMode !== "text");
  const imageInputsSupported = supportsImageInput
    || minimumRequiredImages > 0
    || configuredImageCount > 0
    || declaredImageMode;
  const maxReferenceImages = Math.max(
    minimumRequiredImages,
    boundedCount(configuredMaxReferenceImages, imageInputsSupported ? Math.max(1, minimumRequiredImages) : 0, 9),
  );
  const minReferenceImages = Math.max(
    minimumRequiredImages,
    boundedCount(configuredMinReferenceImages, minimumRequiredImages, maxReferenceImages),
  );
  const maxReferenceAudios = boundedCount(firstDefined(model, "maxReferenceAudios"), 0, 3);
  const minReferenceAudios = boundedCount(
    firstDefined(model, "minReferenceAudios"),
    0,
    maxReferenceAudios,
  );
  // A stored legacy text mode is authoritative for optional/stale image flags,
  // but an explicit image requirement must never be hidden behind text-only UI.
  const effectiveDeclaredMode = declaredMode === "text" && minimumRequiredImages > 0
    ? ""
    : declaredMode;
  const mode: AiVideoWorkflowInputMode = effectiveDeclaredMode
    || (requiresLastFrame
      ? "first_last_frame"
      : maxReferenceAudios > 0 && maxReferenceImages > 1
        ? "multi_image_audio"
        : imageInputsSupported
          ? "flexible_image"
          : "text");
  const supportsPrompt = firstDefined(model, "supportsPrompt") !== false;
  const textOnly = mode === "text";
  // A flexible single-image workflow has one image concept. Presenting
  // “first frame”, “last frame”, and “reference image” together made an
  // optional one-image model look like a three-image contract. Dedicated
  // frame controls belong only to the explicit first/last-frame workflow;
  // flexible models use the single reference-image input, which adapters
  // already promote to image_url where required.
  const showFirstFrame = mode === "first_last_frame" || firstDefined(model, "showFirstFrame") === true;
  const showLastFrame = mode === "first_last_frame" || firstDefined(model, "showLastFrame") === true;
  const inferredReferenceImages = maxReferenceImages > 0 && (mode === "multi_image"
    || mode === "multi_image_audio"
    || mode === "image_audio_lipsync"
    || mode === "flexible_image");
  const showReferenceImages = firstDefined(model, "showReferenceImages") === false ? false
    : firstDefined(model, "showReferenceImages") === true || inferredReferenceImages;
  const showAudioInputs = firstDefined(model, "showAudioInputs") === true
    || firstDefined(model, "supportsAudioInput") === true || maxReferenceAudios > 0;
  const requiresSourceVideo = firstDefined(model, "requiresSourceVideo") === true;
  const supportsSourceVideoInput = requiresSourceVideo
    || firstDefined(model, "supportsSourceVideoInput") === true;

  return {
    mode,
    supportsPrompt,
    showFirstFrame,
    showLastFrame,
    showReferenceImages,
    showAudioInputs,
    requiresFirstFrame,
    requiresLastFrame,
    minReferenceImages: textOnly ? 0 : minReferenceImages,
    maxReferenceImages: textOnly ? 0 : maxReferenceImages,
    minReferenceAudios,
    maxReferenceAudios,
    supportsSourceVideoInput,
    requiresSourceVideo,
  };
}
