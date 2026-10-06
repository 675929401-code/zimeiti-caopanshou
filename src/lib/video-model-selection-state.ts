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
  return image && audio ? "需参考图和音频" : image ? "需参考图" : audio ? "需参考音频" : "支持文生视频";
}

export function boundVideoTaskModel(
  task: { modelId?: string; modelName?: string; supportsRemoteCancel?: boolean },
  models: SelectableVideoModel[],
) {
  const model = models.find((item) => item.id === task.modelId);
  return {
    id: task.modelId || "",
    name: task.modelName || model?.name || "提交时所选模型",
    supportsRemoteCancel: task.supportsRemoteCancel ?? model?.supportsRemoteCancel ?? false,
  };
}
