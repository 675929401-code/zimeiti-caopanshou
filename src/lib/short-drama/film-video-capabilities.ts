interface FilmVideoModel {
  id: string;
  capabilities: Record<string, unknown>;
}

export function filmVideoUnavailableReason(model: FilmVideoModel | null): string {
  if (!model) return "请选择视频模型";
  const c = model.capabilities;
  if (c.available === false) return "渠道暂停";
  if (c.requiresSourceVideo === true) return "需要源视频，请到视频制作页使用";
  if (c.supportsImageInput === false || c.maxReferenceImages === 0) return "不支持镜头图片";
  if (c.requiresLastFrame === true || Number(c.minReferenceImages || 0) > 1) return "需要多张参考图";
  if (Number(c.minReferenceAudios || 0) > 0) return "需要参考音频";
  return "";
}

export function canSubmitFilmVideo(model: FilmVideoModel | null, resolution: string): boolean {
  if (!model || filmVideoUnavailableReason(model)) return false;
  const raw = model.capabilities.resolutionOptions;
  const options = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
  const defaultResolution = model.capabilities.defaultResolution;
  if (!options.length && typeof defaultResolution === "string" && defaultResolution.trim()) options.push(defaultResolution);
  return options.length === 0 || options.includes(resolution);
}

export function buildFilmVideoSubmission(input: {
  model: FilmVideoModel;
  shotId: string;
  clientRequestId: string;
  resolution: string;
  duration: number;
}) {
  if (!canSubmitFilmVideo(input.model, input.resolution)) throw new Error("FILM_VIDEO_MODEL_INPUT_UNAVAILABLE");
  return {
    action: "generate_video" as const,
    shotId: input.shotId,
    clientRequestId: input.clientRequestId,
    modelId: input.model.id,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    duration: input.duration,
  };
}

export function filmJobModelLabel(
  modelPublicId: string | null,
  models: Array<{ id: string; displayName: string }>,
): string {
  return models.find((model) => model.id === modelPublicId)?.displayName || modelPublicId || "原任务模型";
}
