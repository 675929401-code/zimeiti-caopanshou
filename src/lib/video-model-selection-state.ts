import { stripVideoModelOperationalAnnotation } from "./video-model-display-name";

type SelectableVideoModel = {
  id: string;
  name?: string;
  available?: boolean;
  generationReady?: boolean;
  supportsRemoteCancel?: boolean;
  requiresFirstFrame?: boolean;
  requiresLastFrame?: boolean;
  requiresSourceVideo?: boolean;
  requiresImage?: boolean;
  minReferenceImages?: number;
  minReferenceAudios?: number;
  maxReferenceImages?: number;
  maxReferenceAudios?: number;
  supportsImageInput?: boolean;
  supportsAudioInput?: boolean;
  supportsSourceVideoInput?: boolean;
  supportsPrompt?: boolean;
  workflowInputMode?: string;
  capabilitiesVerified?: boolean;
};

export function reconcileVideoModelSelection(currentId: string, models: SelectableVideoModel[]): string {
  // Catalog refreshes must not replace a choice the user has already made.
  return currentId || models.find((model) => model.available && model.generationReady !== false)?.id || "";
}

export function videoModelInputHint(model: SelectableVideoModel): string {
  if (model.requiresSourceVideo) return "需源视频";
  if (model.requiresFirstFrame && model.requiresLastFrame) return "需首尾帧";
  const image = model.requiresFirstFrame || model.requiresImage || (model.minReferenceImages || 0) > 0;
  const audio = (model.minReferenceAudios || 0) > 0;
  const optionalImage = (model.maxReferenceImages || 0) > 0 || model.supportsImageInput === true;
  return image && audio ? "需参考图和音频" : image ? "需参考图" : audio ? "需参考音频"
    : optionalImage && model.supportsPrompt === true ? "支持文生和图生视频"
    : optionalImage ? "支持图生视频" : model.supportsPrompt === true ? "支持文生视频" : "";
}

/** Input labels describe the full contract, not merely prompt acceptance. */
export function videoModelInputLabel(model: SelectableVideoModel): string {
  if (model.requiresSourceVideo) return "视频编辑";
  const image = model.requiresImage || model.requiresFirstFrame || (model.minReferenceImages || 0) > 0;
  const imageSupported = image || model.supportsImageInput || (model.maxReferenceImages || 0) > 0;
  const audio = (model.minReferenceAudios || 0) > 0;
  const audioSupported = audio || model.supportsAudioInput || (model.maxReferenceAudios || 0) > 0;
  const primary = model.requiresLastFrame || /first[_-]last[_-]frame/u.test(model.workflowInputMode || "") ? "首尾帧"
    : imageSupported && audio ? "图+音频" : image ? "图生视频"
    : imageSupported ? model.supportsPrompt === true ? "文生 / 图生视频" : "图生视频"
    : audio ? "音频生视频" : model.supportsPrompt === true ? "文生视频" : "";
  if (!primary) return "";
  return [primary, audioSupported && !audio ? "可选音频" : "", model.supportsSourceVideoInput ? "可选源视频" : ""].filter(Boolean).join(" · ");
}

export function boundVideoTaskModel(
  task: { modelId?: string; modelName?: string; supportsRemoteCancel?: boolean },
  models: SelectableVideoModel[],
) {
  const model = models.find((item) => item.id === task.modelId);
  return {
    id: task.modelId || "",
    name: stripVideoModelOperationalAnnotation(task.modelName || model?.name) || "提交时所选模型",
    supportsRemoteCancel: task.supportsRemoteCancel ?? model?.supportsRemoteCancel ?? false,
  };
}
