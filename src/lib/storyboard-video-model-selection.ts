import {
  coerceVideoTargetDuration,
  getVideoResolutionCapabilities,
  normalizeVideoResolution,
  type VideoModelCapabilitySource,
} from "@/lib/video-model-capabilities";
import { isStoryboardImageWorkflow } from "@/lib/storyboard-video-inputs";
import { getAiVideoPageInputCapabilities } from "@/lib/ai-video-page-capabilities";

export type StoryboardVideoSelectionModel = VideoModelCapabilitySource & {
  supportsImageInput: boolean;
  requiresImage?: boolean;
  requiresSourceVideo: boolean;
  aspectRatios: readonly string[];
  supportsAudioInput?: boolean;
  minReferenceAudios?: number;
  maxReferenceAudios?: number;
  referenceInputMode?: string;
  workflowInputMode?: string;
  minReferenceImages?: number;
  maxReferenceImages?: number;
  requiresFirstFrame?: boolean;
  requiresLastFrame?: boolean;
  showFirstFrame?: boolean;
  showLastFrame?: boolean;
  available?: boolean;
  priceReady?: boolean;
  generationReady?: boolean;
  readinessMessage?: string;
  verificationNotice?: string;
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
    && model.priceReady !== false
    && !storyboardVideoReadinessIssue(model)
    && !storyboardVideoInputModeIssue(model)
  ));
  const ordinary = selectable.filter(model => isStoryboardImageWorkflow(model));
  const selectedId = ordinary.find(model => /omni.*flash.*10/iu.test(String(model.name)))?.id
    || ordinary.find(model => /veo.*3.*1.*fast/iu.test(String(model.name)))?.id
    || ordinary[0]?.id || selectable.find(model => {
      const caps = getAiVideoPageInputCapabilities(model);
      return caps.minReferenceImages === 0 && !caps.requiresSourceVideo && caps.minReferenceAudios === 0 && !caps.requiresLastFrame;
    })?.id || "";
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
 * Acceptance prose remains diagnostic. Only the structured generation switch
 * blocks submission; current price, activity and configuration have their own gates.
 */
export function storyboardVideoReadinessIssue(model: StoryboardVideoSelectionModel) {
  if (model.generationReady === false) {
    return String(model.readinessMessage || model.verificationNotice || "").trim()
      || "当前模型生成尚未验收";
  }
  return "";
}

/** Model selection is independent of a card's current media inputs.
 * Per-card requirements are validated by resolveStoryboardVideoInputs before submission. */
export function storyboardVideoInputModeIssue(_model: StoryboardVideoSelectionModel) {
  void _model;
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
  const readinessIssue = storyboardVideoReadinessIssue(model);
  if (readinessIssue) return readinessIssue;
  return storyboardVideoInputModeIssue(model);
}
