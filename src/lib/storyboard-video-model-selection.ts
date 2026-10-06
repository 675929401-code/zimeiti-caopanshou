import {
  coerceVideoTargetDuration,
  getVideoResolutionCapabilities,
  normalizeVideoResolution,
  type VideoModelCapabilitySource,
} from "@/lib/video-model-capabilities";

export type StoryboardVideoSelectionModel = VideoModelCapabilitySource & {
  supportsImageInput: boolean;
  requiresImage?: boolean;
  requiresSourceVideo: boolean;
  aspectRatios: readonly string[];
  supportsAudioInput?: boolean;
  minReferenceAudios?: number;
  referenceInputMode?: string;
  minReferenceImages?: number;
  maxReferenceImages?: number;
  requiresFirstFrame?: boolean;
  requiresLastFrame?: boolean;
  available?: boolean;
  priceReady?: boolean;
  generationReady?: boolean;
  readinessMessage?: string;
  availabilityMessage?: string;
};

export type StoryboardVideoSelectionTarget = {
  ratio: string;
  duration: number;
  resolution?: string;
};

const RESOLUTION_QUALITY_ORDER = ["480p", "720p", "768p", "1080p", "2K", "4K"] as const;

/** An existing selection never silently changes when the live catalog shrinks. */
export function resolveStoryboardInitialVideoModelId(
  requestedId: string | undefined,
  models: readonly StoryboardVideoSelectionModel[],
) {
  if (requestedId) return requestedId;
  const selectable = models.filter(model => (
    model.available !== false
    && !storyboardVideoInputModeIssue(model)
  ));
  const selectedId = selectable.find(model => /omni.*flash.*10/iu.test(String(model.name)))?.id
    || selectable.find(model => /veo.*3.*1.*fast/iu.test(String(model.name)))?.id
    || selectable[0]?.id || "";
  return typeof selectedId === "string" ? selectedId : "";
}

/** Provider quota and media 403 errors are not the user's balance or session. */
export function storyboardVideoErrorMessage(message: string, status?: number, code?: string) {
  const detail = String(message || "视频任务失败").trim();
  if (/^余额不足(?:：|:|，|,|\s|$)/u.test(detail) || /^内容审核未通过(?:：|:|，|,|\s|$)/u.test(detail)) return detail;
  if (code === "INSUFFICIENT_BALANCE") return `余额不足：${detail}`;
  if (["AUTH_REQUIRED", "UNAUTHORIZED", "TOKEN_EXPIRED"].includes(String(code)) || /^登录已过期|^请先登录/u.test(detail)) return `登录或权限异常：${detail}`;
  if (/违规|审核|敏感|content.?policy|moderation|safety/iu.test(detail)) return `内容审核未通过：${detail}`;
  if (status === 429 || /限流|rate.?limit|too many requests/iu.test(detail)) return `通道限流：${detail}`;
  return detail;
}

export type StoryboardBoundVideoTask = {
  videoTaskId?: string;
  videoClientRequestId?: string;
  videoTaskModelId?: string;
  videoTaskModelName?: string;
  videoTaskDuration?: number;
  videoSupportsRemoteCancel?: boolean;
};

/**
 * A stable client request is enough to request termination. The server will
 * decide atomically whether the task is still pre-dispatch or must be stopped
 * through the immutable upstream routing snapshot.
 */
export function storyboardTaskCanRequestTermination(task: StoryboardBoundVideoTask) {
  return Boolean(String(task.videoClientRequestId || task.videoTaskId || "").trim());
}

/** Cancellation belongs to the submitted task, never the currently selected model. */
export function storyboardTaskCanCancel(
  task: StoryboardBoundVideoTask,
  models: readonly { id: string; supportsRemoteCancel?: boolean }[],
) {
  if (!task.videoTaskId || !task.videoTaskModelId) return false;
  const boundModel = models.find(model => model.id === task.videoTaskModelId);
  return boundModel ? boundModel.supportsRemoteCancel === true : task.videoSupportsRemoteCancel === true;
}

function resolutionQuality(resolution: string) {
  const index = RESOLUTION_QUALITY_ORDER.indexOf(resolution as typeof RESOLUTION_QUALITY_ORDER[number]);
  return index < 0 ? -1 : index;
}

/**
 * Each storyboard card supplies one image plus a prompt. It
 * does not expose distinct first/last-frame slots or audio inputs, so those
 * workflow modes must stay in their dedicated workspaces.
 */
export function storyboardVideoInputModeIssue(model: StoryboardVideoSelectionModel) {
  if (!model.supportsImageInput) return "不支持故事板图片输入";
  if (model.requiresSourceVideo) return "需要源视频，不能用于故事板图片";
  const inputMode = String(model.referenceInputMode || "").trim().toLowerCase();
  // A few legacy catalog rows predate the explicit first/last-frame flags.
  // Their public model name is still an authoritative workflow declaration;
  // do not let those two-frame models enter a one-image storyboard card.
  const legacyFirstLastFrameModel = /(?:首\s*尾\s*帧|first[\s_-]*(?:and[\s_-]*)?last[\s_-]*frame)/iu
    .test(String(model.name || ""));
  if (
    model.requiresLastFrame
    || legacyFirstLastFrameModel
    || (model.requiresLastFrame !== false && (
      inputMode === "first_last_frame"
      || inputMode === "first-last-frame"
    ))
  ) return "需要分别提供首帧和尾帧，当前工作台不支持";
  const requiredAudios = model.minReferenceAudios ?? (model.supportsAudioInput ? 1 : 0);
  if (requiredAudios > 0 || inputMode === "image_audio_lipsync") {
    return "需要音频输入，请在 AI 视频制作的对应模式使用";
  }
  if (typeof model.minReferenceImages === "number" && model.minReferenceImages > 1) {
    return `至少需要 ${model.minReferenceImages} 张参考图；分镜每张卡片仅提交一张故事板，请在视频制作页使用`;
  }
  if (model.maxReferenceImages === 0) return "当前模型不接收故事板图片";
  return "";
}

/**
 * Pick a default resolution without silently moving the user to a dearer
 * tier.  A valid explicit selection is always preserved.  Only when every
 * declared tier has the same unit price do we default to the highest tier.
 */
export function resolveStoryboardVideoResolution(
  model: StoryboardVideoSelectionModel | undefined,
  requestedResolution?: unknown,
) {
  const capabilities = getVideoResolutionCapabilities(model);
  const requested = normalizeVideoResolution(requestedResolution);
  if (requested && capabilities.options.includes(requested)) return requested;
  if (capabilities.options.length === 0) return capabilities.defaultResolution || requested;

  const prices = capabilities.options.map((option) => capabilities.publicPrices[option]);
  const sameUnitPrice = prices.length > 0
    && prices.every((price) => Number.isFinite(price) && price >= 0)
    && prices.every((price) => Math.abs(price - prices[0]) < 0.000_001);
  if (sameUnitPrice) {
    return [...capabilities.options].sort((left, right) => (
      resolutionQuality(right) - resolutionQuality(left)
    ))[0];
  }
  return capabilities.defaultResolution || capabilities.options[0];
}

export function coerceStoryboardVideoRatio(
  model: StoryboardVideoSelectionModel | undefined,
  requestedRatio: string,
) {
  if (!model?.aspectRatios.length || model.aspectRatios.includes(requestedRatio)) return requestedRatio;
  return model.aspectRatios[0] || requestedRatio;
}

export function resolveStoryboardVideoSelection(
  model: StoryboardVideoSelectionModel | undefined,
  target: StoryboardVideoSelectionTarget,
) {
  return {
    ratio: coerceStoryboardVideoRatio(model, target.ratio),
    duration: coerceVideoTargetDuration(model, target.duration),
    resolution: resolveStoryboardVideoResolution(model, target.resolution),
  };
}

/**
 * Return the user-facing reason a model cannot replace the current storyboard
 * video preset. Resolution is intentionally not a blocker: after an explicit
 * model switch the workbench selects that model's closest declared resolution.
 */
export function storyboardVideoModelSelectionIssue(
  model: StoryboardVideoSelectionModel,
  _target: StoryboardVideoSelectionTarget,
) {
  void _target;
  if (model.available === false) {
    return String(model.availabilityMessage || "").trim() || "当前未开放";
  }
  if (model.priceReady === false) return "当前未开放";
  return storyboardVideoInputModeIssue(model);
}
