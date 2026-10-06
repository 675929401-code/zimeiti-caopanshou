import type { AiVideoPageInputCapabilities } from "@/lib/ai-video-page-capabilities";

export type VideoValidationProof = {
  validationKey: string;
  configurationHash: string;
  healthEpoch: string;
  confirmation: string;
  model: { id: string; publicId: string; displayName: string; upstreamModel: string };
};
export type VideoValidationReceipt = {
  taskId: string;
  businessTaskId: string;
  status: string;
  errorCode?: string;
  error?: string;
  validationKey?: string;
  configurationHash?: string;
  healthEpoch?: string;
};
export type VideoValidationDto = VideoValidationProof & {
  readiness: { credentialReady: boolean; endpointConfigured: boolean };
  capabilities: AiVideoPageInputCapabilities;
  minimumInput: {
    promptRequired: boolean; imageCount: number; audioCount: number;
    firstFrameRequired: boolean; lastFrameRequired: boolean; sourceVideoRequired: boolean;
    durationSeconds: number; resolution: string | null; aspectRatio: string; requiresComputeLifecycle: boolean;
  };
  minimumPrice?: number | null;
  billingUnit?: "per_use" | "output_second";
  administratorCharge?: number;
  existingTask?: VideoValidationReceipt | null;
  busy?: boolean;
};
export type VideoValidationInputs = {
  prompt: string; firstFrame: string; lastFrame: string;
  images: string[]; audios: string[]; sourceVideo: string;
};
export function videoValidationInputsForDto(dto: VideoValidationDto): VideoValidationInputs {
  const minimum = dto.minimumInput, capabilities = dto.capabilities;
  const frameSlots = Number(capabilities.showFirstFrame) + Number(capabilities.showLastFrame);
  return {
    prompt: "", firstFrame: "", lastFrame: "", sourceVideo: "",
    images: Array(Math.max(minimum.imageCount - frameSlots, capabilities.showReferenceImages ? 1 : 0, 0)).fill(""),
    audios: Array(Math.max(minimum.audioCount, capabilities.showAudioInputs ? 1 : 0)).fill(""),
  };
}
export type VideoValidationAttempt = {
  version: 1; userId: string; proof: VideoValidationProof; createdAt: string;
  status: "submitting" | "processing" | "finalizing" | "unknown" | "completed" | "failed" | "published";
  taskId: string; businessTaskId: string; error: string; errorCode: string;
  notSubmitted?: boolean;
};
type AttemptStorage = Pick<Storage, "getItem" | "setItem">;
type AttemptIo = { storage: AttemptStorage; fetcher: typeof fetch; token: string; onChange?: (attempt: VideoValidationAttempt) => void };
const terminal = (attempt: VideoValidationAttempt) => ["completed", "failed", "published"].includes(attempt.status);
export const videoValidationIsTerminal = terminal;
export const videoValidationStorageKey = (userId: string, modelId: string) => `admin-video-validation:v1:${userId}:${modelId}`;

export function videoValidationProof(dto: VideoValidationProof): VideoValidationProof {
  if (!/^vav_[a-f0-9]{64}$/u.test(dto.validationKey) || !dto.configurationHash || !dto.healthEpoch
    || !dto.model?.id || !dto.model.displayName || !dto.confirmation) throw new Error("视频验证配置不完整，请重新检查");
  return {
    validationKey: dto.validationKey, configurationHash: dto.configurationHash, healthEpoch: dto.healthEpoch,
    confirmation: dto.confirmation, model: {
      id: dto.model.id, publicId: dto.model.publicId, displayName: dto.model.displayName, upstreamModel: dto.model.upstreamModel,
    },
  };
}

export function readVideoValidationAttempt(storage: AttemptStorage, userId: string, modelId: string): VideoValidationAttempt | null {
  const raw = storage.getItem(videoValidationStorageKey(userId, modelId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as VideoValidationAttempt;
    if (value.version !== 1 || value.userId !== userId || value.proof.model.id !== modelId
      || !["submitting", "processing", "finalizing", "unknown", "completed", "failed", "published"].includes(value.status)) throw new Error();
    videoValidationProof(value.proof);
    return value;
  } catch { throw new Error("本地验证记录暂时无法读取，请先检查原任务，勿重新生成"); }
}

export function saveVideoValidationAttempt(storage: AttemptStorage, attempt: VideoValidationAttempt) {
  // Persist only the bound model proof and receipt. Never persist the bearer token, access ticket or request headers.
  const key = videoValidationStorageKey(attempt.userId, attempt.proof.model.id);
  storage.setItem(key, JSON.stringify(attempt));
  if (storage.getItem(key) !== JSON.stringify(attempt)) throw new Error("无法保存验证任务，请允许本站本地存储后再试");
}

function validAsset(value: string) {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

export function buildVideoValidationRequest(dto: VideoValidationDto, fields: VideoValidationInputs) {
  const proof = videoValidationProof(dto), minimum = dto.minimumInput, capabilities = dto.capabilities;
  const prompt = fields.prompt.trim(), first = fields.firstFrame.trim(), last = fields.lastFrame.trim();
  const images = fields.images.map(value => value.trim()).filter(Boolean), audios = fields.audios.map(value => value.trim()).filter(Boolean);
  const source = fields.sourceVideo.trim();
  if (minimum.promptRequired && !prompt) throw new Error("请填写本次验证的视频描述");
  if (prompt.length > 10000) throw new Error("视频描述不能超过 10000 字");
  if (minimum.firstFrameRequired && !first) throw new Error("当前模型需要首帧图片");
  if (minimum.lastFrameRequired && !last) throw new Error("当前模型需要尾帧图片");
  const imageCount = Number(!!first) + Number(!!last) + images.length;
  if (imageCount < minimum.imageCount || imageCount > capabilities.maxReferenceImages) throw new Error(`请按当前模型要求提供 ${minimum.imageCount} 至 ${capabilities.maxReferenceImages} 张图片`);
  if (audios.length < minimum.audioCount || audios.length > capabilities.maxReferenceAudios) throw new Error(`请按当前模型要求提供 ${minimum.audioCount} 至 ${capabilities.maxReferenceAudios} 段音频`);
  if (minimum.sourceVideoRequired && !source) throw new Error("当前模型需要源视频链接");
  if (![first, last, source, ...images, ...audios].every(validAsset)) throw new Error("参考素材须使用不含账号密码的 HTTPS 链接，或通过本窗口上传");
  return {
    model_id: proof.model.id, prompt, image_url: first, last_frame_url: last,
    reference_image_urls: images, reference_audio_urls: audios, source_video_url: source,
    duration: minimum.durationSeconds, aspect_ratio: minimum.aspectRatio,
    resolution: minimum.resolution || "", resolution_tier: minimum.resolution || "",
    surface: "video-page", task_label: `管理员验证 · ${proof.model.displayName}`,
    admin_validation: true, admin_validation_key: proof.validationKey,
    admin_validation_confirmation: proof.confirmation, client_request_id: proof.validationKey,
  };
}

function safeError(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/https?:\/\/\S+/gu, "[链接已隐藏]").replace(/\bBearer\s+\S+/giu, "[凭据已隐藏]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[凭据已隐藏]").replace(/\bsk-[\w-]+/gu, "[凭据已隐藏]").slice(0, 500);
}

export function updateVideoValidationReceipt(attempt: VideoValidationAttempt, data: Record<string, unknown>, responseOk = true): VideoValidationAttempt {
  const returnedModel = typeof data.model_id === "string" ? data.model_id : typeof data.modelId === "string" ? data.modelId : "";
  if (returnedModel && ![attempt.proof.model.id, attempt.proof.model.publicId].includes(returnedModel)) {
    return { ...attempt, status: "unknown", error: "返回任务的模型与本次选择不一致，已保留原验证记录", errorCode: "VIDEO_VALIDATION_MODEL_MISMATCH" };
  }
  const taskId = String(data.task_id || data.taskId || attempt.taskId || "");
  const businessTaskId = String(data.business_task_id || data.businessTaskId || attempt.businessTaskId || "");
  const status = String(data.status || "");
  const unknown = data.submission_outcome === "unknown" || data.task_submitted === null || status === "unknown";
  const failed = !unknown && (["failed", "cancelled", "expired"].includes(status) || (!responseOk && data.task_submitted === false && !taskId && !businessTaskId));
  return {
    ...attempt, taskId, businessTaskId,
    notSubmitted: data.task_submitted === false && !taskId && !businessTaskId,
    status: unknown ? "unknown" : status === "completed" && (taskId || businessTaskId) ? "completed" : failed ? "failed" : status === "finalizing" && (taskId || businessTaskId) ? "finalizing" : responseOk && taskId ? "processing" : "unknown",
    error: status === "completed" ? "" : safeError(data.errorMessage || data.error || data.message, unknown ? "上游提交结果待确认，请检查原任务" : failed ? "本次验证未完成" : responseOk ? "" : "验证响应暂不可确认，请检查原任务"),
    errorCode: String(data.error_code || data.errorCode || data.code || "").slice(0, 100),
  };
}

export async function submitVideoValidation(dto: VideoValidationDto, fields: VideoValidationInputs, userId: string, io: AttemptIo): Promise<VideoValidationAttempt> {
  const fetcher = io.fetcher;
  if (!io.token || !userId) throw new Error("请先登录管理员账号");
  const previous = readVideoValidationAttempt(io.storage, userId, dto.model.id);
  if (previous && (!terminal(previous) || (previous.proof.validationKey === dto.validationKey && !previous.notSubmitted))) return previous;
  const body = buildVideoValidationRequest(dto, fields);
  if (!dto.readiness.credentialReady || !dto.readiness.endpointConfigured || dto.busy) throw new Error(dto.busy ? "该配置已有验证任务，请先检查原任务" : "当前模型连接配置尚未就绪");
  const attempt: VideoValidationAttempt = { version: 1, userId, proof: videoValidationProof(dto), createdAt: new Date().toISOString(), status: "submitting", taskId: "", businessTaskId: "", error: "", errorCode: "" };
  if (previous) io.storage.setItem(`${videoValidationStorageKey(userId, dto.model.id)}:previous:${previous.proof.validationKey}`, JSON.stringify(previous));
  saveVideoValidationAttempt(io.storage, attempt); io.onChange?.(attempt);
  let next: VideoValidationAttempt;
  try {
    const response = await fetcher("/api/video/generate", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${io.token}`, "Idempotency-Key": dto.validationKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const data = await response.json() as Record<string, unknown>;
    next = updateVideoValidationReceipt(attempt, data, response.ok);
  } catch { next = { ...attempt, status: "unknown", error: "连接中断，原验证记录已保留。请检查原任务，不会自动重新生成。", errorCode: "VIDEO_VALIDATION_RESPONSE_UNKNOWN" }; }
  saveVideoValidationAttempt(io.storage, next); io.onChange?.(next); return next;
}

export function buildVideoValidationPublishRequest(attempt: VideoValidationAttempt) {
  if (attempt.status !== "completed" || !attempt.businessTaskId) throw new Error("请先完成本配置的真实验证并保存结果");
  return {
    modelId: attempt.proof.model.id, validationKey: attempt.proof.validationKey,
    configurationHash: attempt.proof.configurationHash, healthEpoch: attempt.proof.healthEpoch,
    clientRequestId: attempt.proof.validationKey, taskId: attempt.businessTaskId,
    confirmation: "PUBLISH_VALIDATED_VIDEO_MODEL",
  };
}
