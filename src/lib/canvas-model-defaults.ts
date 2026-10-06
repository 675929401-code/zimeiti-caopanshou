import type { CoverModel, VideoModel } from "@/lib/studio-canvas-types";
import { getVideoDurationCapabilities } from "@/lib/video-model-capabilities";

export const FALLBACK_CANVAS_IMAGE_MODEL = "gpt-image-2-chA-1";
export const FALLBACK_CANVAS_VIDEO_MODEL = "grok-imagine-video-1-5-preview-chA";

function imageModelQualityScore(model: CoverModel) {
  const identity = `${model.name} ${model.model_name}`.toLowerCase();
  if (/\bgpt[- ]?image[- ]?2\b/.test(identity)) return 1000;
  if (/\bgpt[- ]?image[- ]?1\.5\b/.test(identity)) return 800;
  if (/\bgpt[- ]?image\b/.test(identity) && !/mini/.test(identity)) return 600;
  return 0;
}

export function selectCanvasImageModel(models: CoverModel[], configuredId?: string) {
  const bestGptModel = models
    .map((model, index) => ({ model, index, score: imageModelQualityScore(model) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.model;
  return bestGptModel?.id
    || models.find((model) => model.id === configuredId)?.id
    || models[0]?.id
    || FALLBACK_CANVAS_IMAGE_MODEL;
}

export function isCanvasStoryboardVideoModelCompatible(model: VideoModel) {
  if (!model.supportsImageInput) return false;
  const timing = getVideoDurationCapabilities(model);
  return timing.mode === "range" && timing.minDuration <= 1 && timing.maxDuration >= 4;
}

function videoModelFitScore(model: VideoModel) {
  if (!isCanvasStoryboardVideoModelCompatible(model)) return Number.NEGATIVE_INFINITY;
  const timing = getVideoDurationCapabilities(model);
  const measuredSuccess = model.successRate >= 0 ? model.successRate : 0;
  return 200
    + (model.requiresImage ? 80 : 0)
    + 130
    + (timing.maxDuration >= 8 ? 20 : 0)
    + (/1080p/i.test(model.resolutionTier || model.name) ? 20 : 0)
    + measuredSuccess * 2;
}

export function selectCanvasVideoModel(models: VideoModel[], configuredId?: string) {
  const ranked = models
    .map((model, index) => ({ model, index, score: videoModelFitScore(model) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.model.id
    || models.find((model) => model.id === configuredId)?.id
    || models[0]?.id
    || FALLBACK_CANVAS_VIDEO_MODEL;
}
