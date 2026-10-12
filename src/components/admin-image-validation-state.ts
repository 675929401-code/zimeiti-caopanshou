import { projectGeneratedImageClientReceipt, resolveGeneratedImageClientDelivery, type GeneratedImageClientDelivery, type GeneratedImageClientReceipt } from "@/lib/generated-image-client-delivery";
import type { ImageModelCapabilities, ImageResolution } from "@/lib/image-model-capabilities";

export type ImageValidationProof = {
  validationKey: string; configurationHash: string; epoch: number;
  clientIdempotencyKey: string; clientTraceId: string;
};
export type ImageValidationDto = {
  modelId: string; publicModelId: string; name: string; modelName: string;
  active: boolean; hidden: boolean; credentialReady: boolean; priceReady: boolean;
  capabilities: ImageModelCapabilities; requiresComputeReadiness: boolean;
  acceptance: "pending" | "published"; quotedPriceYuan: number | null;
  confirmation: string; configurationHash: string; epoch: number;
  validationKey: string | null; clientIdempotencyKey: string | null; clientTraceId: string | null;
  busy: boolean; canRequestRetest: boolean;
  existingAttempt?: { validationId: string; imageRecordId: string; state: string; requestState: string;
    deliveryState: string; assetId: string | null; hasProviderCheckpoint: boolean;deliveryReceipt?:unknown } | null;
};
export type ImageValidationInputs = {
  prompt: string; resolution: ImageResolution; aspectRatio: string;
  referenceMode: boolean; referenceImageUrls: string[];
};
export type ImageValidationBody = {
  prompt: string; modelId: string; mode: "local"; style: ""; coverText: "";
  aspectRatio: string; resolution: ImageResolution; referenceImageUrls: string[];
  clientIdempotencyKey: string; clientTraceId: string; noRetry: true; strictSingleSubmit: true;
  adminValidation: ImageValidationProof & { confirmation: string; retestReason?: string };
};
export type ImageValidationAttempt = {
  version: 1; userId: string; model: { id: string; publicId: string; name: string; upstream: string };
  proof: ImageValidationProof; createdAt: string; body?: ImageValidationBody;
  status: "submitting" | "processing" | "finalizing" | "unknown" | "rejected" | "completed" | "published";
  generationCompleted?:boolean; mediaAvailable?:boolean; deliveryReceipt?:GeneratedImageClientReceipt;
  imageRecordId: string; assetId: string; canRecover: boolean; error: string; errorCode: string;
};
type AttemptStorage = Pick<Storage, "getItem" | "setItem">;
type AttemptIo = { storage: AttemptStorage; token: string; fetcher: typeof fetch; onChange?: (attempt: ImageValidationAttempt) => void; onDelivery?: (delivery:GeneratedImageClientDelivery)=>void };
const KEY = /^iav_[a-f0-9]{64}$/u;
const ASSET_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const TERMINAL = new Set(["rejected", "completed", "published"]);
export const imageValidationIsTerminal = (attempt: ImageValidationAttempt) => TERMINAL.has(attempt.status);
export const imageValidationStorageKey = (userId: string, modelId: string) => `admin-image-validation:v1:${encodeURIComponent(userId)}:${encodeURIComponent(modelId)}`;

export function imageValidationSafeError(value: unknown, fallback = "原验证暂时无法确认，请检查原任务") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/https?:\/\/\S+/gu, "[链接已隐藏]").replace(/\bBearer\s+\S+/giu, "[凭据已隐藏]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[凭据已隐藏]").replace(/\bsk-[\w-]+/gu, "[凭据已隐藏]").slice(0, 350);
}
export function imageValidationProof(dto: Pick<ImageValidationDto, "validationKey" | "configurationHash" | "epoch" | "clientIdempotencyKey" | "clientTraceId">): ImageValidationProof {
  if (!KEY.test(dto.validationKey || "") || !/^[a-f0-9]{64}$/u.test(dto.configurationHash)
    || !Number.isSafeInteger(dto.epoch) || dto.epoch < 0 || dto.clientIdempotencyKey !== dto.validationKey || dto.clientTraceId !== dto.validationKey) {
    throw new Error("生图验证证明不完整，请重新读取当前配置");
  }
  return { validationKey: dto.validationKey!, configurationHash: dto.configurationHash, epoch: dto.epoch,
    clientIdempotencyKey: dto.clientIdempotencyKey!, clientTraceId: dto.clientTraceId! };
}
export function sameImageValidationProof(left: ImageValidationProof, right: ImageValidationDto | ImageValidationProof) {
  return left.validationKey === right.validationKey && left.configurationHash === right.configurationHash && left.epoch === right.epoch
    && left.clientIdempotencyKey === right.clientIdempotencyKey && left.clientTraceId === right.clientTraceId;
}
export function imageValidationInputsForDto(dto: ImageValidationDto): ImageValidationInputs {
  return { prompt: "", resolution: dto.capabilities.defaultResolution, aspectRatio: "1:1", referenceMode: false, referenceImageUrls: [] };
}
export function readImageValidationAttempt(storage: AttemptStorage, userId: string, modelId: string): ImageValidationAttempt | null {
  const raw = storage.getItem(imageValidationStorageKey(userId, modelId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ImageValidationAttempt;
    if (value.version !== 1 || value.userId !== userId || value.model.id !== modelId
      || !["submitting", "processing", "finalizing", "unknown", "rejected", "completed", "published"].includes(value.status)) throw new Error();
    imageValidationProof(value.proof);
    if (value.body && (value.body.modelId !== modelId || value.body.clientIdempotencyKey !== value.proof.validationKey
      || value.body.clientTraceId !== value.proof.validationKey || !sameImageValidationProof(value.proof, value.body.adminValidation))) throw new Error();
    return value;
  } catch { throw new Error("本地验证记录无法读取，原记录已保留，请先核对原任务"); }
}
export function saveImageValidationAttempt(storage: AttemptStorage, attempt: ImageValidationAttempt) {
  // Store the user's original request (including supplied reference URLs) and proof.
  // Never store authorization, generated-result URLs or access tickets, or log this body.
  const durable={version:attempt.version,userId:attempt.userId,model:attempt.model,proof:attempt.proof,createdAt:attempt.createdAt,body:attempt.body,status:attempt.status,imageRecordId:attempt.imageRecordId,assetId:attempt.assetId,canRecover:attempt.canRecover,error:attempt.error,errorCode:attempt.errorCode,generationCompleted:attempt.generationCompleted,mediaAvailable:attempt.deliveryReceipt?.deliveryMode==="inline_ephemeral"?false:attempt.mediaAvailable,deliveryReceipt:projectGeneratedImageClientReceipt(attempt.deliveryReceipt)||undefined};
  const serialized = JSON.stringify(durable), key = imageValidationStorageKey(attempt.userId, attempt.model.id);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("无法保存原验证编号，请允许本站本地存储后再试");
}
export function buildImageValidationRequest(dto: ImageValidationDto, inputs: ImageValidationInputs, retestReason = ""): ImageValidationBody {
  const proof = imageValidationProof(dto), prompt = inputs.prompt.trim();
  if (dto.confirmation !== "RUN_SINGLE_REAL_IMAGE_VALIDATION") throw new Error("当前验证协议不匹配，请刷新后再试");
  if (!prompt || prompt.length > 10000) throw new Error("请填写 1 至 10000 字的验证图片描述");
  if (!["1:1", "3:4", "4:3", "9:16", "16:9"].includes(inputs.aspectRatio)
    || !dto.capabilities.resolutionOptions.includes(inputs.resolution)) throw new Error("请选择此模型支持的比例和清晰度");
  const references = inputs.referenceMode ? inputs.referenceImageUrls.map(value => value.trim()).filter(Boolean) : [];
  if (inputs.referenceMode && (!dto.capabilities.supportsReferenceInput || references.length < 1 || references.length > Math.min(8, dto.capabilities.maxReferenceImages))) {
    throw new Error("请按当前模型的参考图能力选择图片");
  }
  for (const value of references) {
    let parsed: URL; try { parsed = new URL(value); } catch { throw new Error("参考图需要有效的 HTTPS 链接"); }
    if (value.length > 2048 || parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("请上传参考图，或填写不含账号密码的 HTTPS 链接");
  }
  const reason = retestReason.trim();
  if (reason && (reason.length < 8 || reason.length > 300)) throw new Error("请填写 8 至 300 字的复测原因");
  return { prompt, modelId: dto.modelId, mode: "local", style: "", coverText: "", aspectRatio: inputs.aspectRatio,
    resolution: inputs.resolution, referenceImageUrls: references, clientIdempotencyKey: proof.validationKey, clientTraceId: proof.validationKey,
    noRetry: true, strictSingleSubmit: true, adminValidation: { ...proof, confirmation: dto.confirmation, ...(reason ? { retestReason: reason } : {}) } };
}
export function updateImageValidationReceipt(attempt: ImageValidationAttempt, data: Record<string, unknown>, responseOk = true): ImageValidationAttempt {
  const model = String(data.modelId || data.modelIdUsed || ""), returnedKey = String(data.traceId || data.clientTraceId || "");
  if ((model && ![attempt.model.id, attempt.model.publicId].includes(model)) || (returnedKey && returnedKey !== attempt.proof.validationKey)) {
    return { ...attempt, status: "unknown", error: "返回记录与原验证模型或请求号不一致，已保留原任务", errorCode: "IMAGE_VALIDATION_RECEIPT_MISMATCH" };
  }
  const state = String(data.state || data.status || "");
  const first=Array.isArray(data.images)?data.images[0] as Record<string,unknown>|undefined:undefined;
  const recordId=String(data.recordId||first?.recordId||attempt.imageRecordId||"");
  if(recordId && (!/^[a-f0-9]{64}$/u.test(recordId) || (attempt.imageRecordId && attempt.imageRecordId!==recordId)))throw new Error("原验证任务编号不一致");
  const deliveryReceipt=projectGeneratedImageClientReceipt(data)||attempt.deliveryReceipt;
  const returnedAsset = typeof data.assetId === "string" ? data.assetId : Array.isArray(data.images)
    && data.images[0] && typeof data.images[0] === "object" ? String((data.images[0] as Record<string, unknown>).assetId || "") : "";
  if (returnedAsset && !ASSET_ID.test(returnedAsset)) throw new Error("验证图片资产编号无效");
  if (attempt.assetId && returnedAsset && attempt.assetId !== returnedAsset) throw new Error("原验证的图片资产不一致，已停止替换结果");
  const assetId = returnedAsset || attempt.assetId;
  const completed = responseOk && (state === "completed" || (state==="expired" && Boolean(deliveryReceipt))) && (Boolean(deliveryReceipt) || (Boolean(assetId) && data.deliveryReady !== false) || (Boolean(recordId) && data.deliveryReady === true));
  const rejected = state === "rejected" && data.canResubmit === true && data.sameKeyCanResubmit === false;
  const finalizing = state === "provider_completed_pending_delivery" || data.hasProviderCheckpoint === true;
  return { ...attempt, assetId, imageRecordId:recordId,deliveryReceipt,generationCompleted:completed||attempt.generationCompleted,mediaAvailable:completed ? (data.mediaAvailable===true || Boolean(first?.url) || Boolean(assetId)) : attempt.mediaAvailable,
    status: completed ? attempt.status === "published" ? "published" : "completed" : rejected ? "rejected" : finalizing ? "finalizing"
      : responseOk && ["processing", "intent"].includes(state) ? "processing" : "unknown",
    canRecover: finalizing && data.canRecover === true,
    error: completed ? "" : imageValidationSafeError(data.error || data.message, rejected ? "本次请求已被明确拒绝" : responseOk && ["processing", "intent"].includes(state) ? "" : "原任务尚未确认，记录已保留"),
    errorCode: typeof data.code === "string" ? data.code.replace(/[^A-Z0-9_]/gu, "").slice(0, 100) : "" };
}
export function adoptImageValidationAttempt(dto: ImageValidationDto, userId: string, previous: ImageValidationAttempt | null): ImageValidationAttempt | null {
  if (!dto.existingAttempt || dto.busy || (previous && !sameImageValidationProof(previous.proof, dto))) return previous;
  const receipt = dto.existingAttempt;
  if (!/^[a-f0-9]{64}$/u.test(receipt.imageRecordId)) throw new Error("原图片请求标识不可确认");
  const base: ImageValidationAttempt = previous || { version: 1, userId, model: { id: dto.modelId, publicId: dto.publicModelId, name: dto.name, upstream: dto.modelName },
    proof: imageValidationProof(dto), createdAt: new Date().toISOString(), status: "unknown", imageRecordId: "", assetId: "", canRecover: false, error: "", errorCode: "" };
  if (base.userId !== userId || base.model.id !== dto.modelId || (base.imageRecordId && base.imageRecordId !== receipt.imageRecordId)) throw new Error("原验证记录归属不一致");
  const deliveryPending = receipt.hasProviderCheckpoint || (receipt.requestState === "completed" && receipt.deliveryState !== "delivered");
  const next = updateImageValidationReceipt({ ...base, imageRecordId: receipt.imageRecordId }, {
    ...((receipt.deliveryReceipt && typeof receipt.deliveryReceipt==="object")?receipt.deliveryReceipt:{}),
    state: receipt.requestState === "completed" && receipt.deliveryState === "delivered" ? "completed" : receipt.state === "rejected" ? "rejected" : deliveryPending ? "provider_completed_pending_delivery" : receipt.requestState,
    assetId: receipt.deliveryState === "delivered" ? receipt.assetId : undefined,
    deliveryReady: receipt.deliveryState === "delivered", canResubmit: receipt.state === "rejected", sameKeyCanResubmit: false, canRecover: deliveryPending,
    ...(receipt.state === "rejected" ? { error: base.error, code: base.errorCode } : {}),
  });
  return receipt.state === "published" && next.status === "completed" ? { ...next, status: "published" } : next;
}
export async function submitImageValidation(dto: ImageValidationDto, fields: ImageValidationInputs, userId: string, io: AttemptIo, retestReason = "") {
  const fetcher = io.fetcher;
  if (!userId || !io.token) throw new Error("请先登录当前管理员账号");
  const previous = readImageValidationAttempt(io.storage, userId, dto.modelId);
  if (previous && (previous.status !== "rejected" || previous.proof.validationKey === dto.validationKey)) return previous;
  if (previous && (dto.epoch <= previous.proof.epoch || retestReason.trim().length < 8)) throw new Error("请先明确原拒绝原因并读取复测证明");
  if (dto.busy || !dto.credentialReady || !dto.priceReady) throw new Error(dto.busy ? "此配置已有验证，请先检查原任务" : "请先补齐当前模型密钥和价格配置");
  const body = buildImageValidationRequest(dto, fields, retestReason);
  const attempt: ImageValidationAttempt = { version: 1, userId, model: { id: dto.modelId, publicId: dto.publicModelId, name: dto.name, upstream: dto.modelName },
    proof: imageValidationProof(dto), body, createdAt: new Date().toISOString(), status: "submitting", imageRecordId: "", assetId: "", canRecover: false, error: "", errorCode: "" };
  if (previous) io.storage.setItem(`${imageValidationStorageKey(userId, dto.modelId)}:previous:${previous.proof.validationKey}`, JSON.stringify(previous));
  saveImageValidationAttempt(io.storage, attempt); io.onChange?.(attempt);
  let next: ImageValidationAttempt;
  try {
    const response = await fetcher("/api/image/generate", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${io.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const data=await response.json() as Record<string,unknown>;
    next = updateImageValidationReceipt(attempt,data,response.ok);
    if(response.ok && next.generationCompleted && Array.isArray(data.images) && data.images.length) {try {io.onDelivery?.(await resolveGeneratedImageClientDelivery(data));}catch {next={...next,mediaAvailable:false,error:"生成已完成，当前图片暂不可读取；原收据已保留"};}}
  } catch { next = { ...attempt, status: "unknown", error: "连接中断，原验证编号已保留，请检查原任务", errorCode: "IMAGE_VALIDATION_RESPONSE_UNKNOWN" }; }
  saveImageValidationAttempt(io.storage, next); io.onChange?.(next); return next;
}
export function buildImageValidationPublishRequest(attempt: ImageValidationAttempt) {
  if (!["completed", "published"].includes(attempt.status) || (!attempt.assetId && !attempt.deliveryReceipt) || !/^[a-f0-9]{64}$/u.test(attempt.imageRecordId)) throw new Error("请先确认原验证图片已完成");
  if(attempt.deliveryReceipt)return {modelId:attempt.model.id,imageRecordId:attempt.imageRecordId,proof:imageValidationProof(attempt.proof),intent:"retain_validation_evidence_and_publish"};
  return { modelId: attempt.model.id, imageRecordId: attempt.imageRecordId, proof: imageValidationProof(attempt.proof), confirmation: "PUBLISH_VALIDATED_IMAGE_MODEL" };
}
/** Explicit recovery only after a fresh read confirms an original provider checkpoint. */
export async function recoverImageValidation(attempt: ImageValidationAttempt, io: AttemptIo) {
  const fetcher = io.fetcher;
  const saved = readImageValidationAttempt(io.storage, attempt.userId, attempt.model.id);
  if (!io.token || !saved?.body || !sameImageValidationProof(saved.proof, attempt.proof)
    || JSON.stringify(saved.body) !== JSON.stringify(attempt.body)) throw new Error("缺少完整原请求，不能恢复保存");
  const query = new URLSearchParams({ clientIdempotencyKey: saved.proof.clientIdempotencyKey, clientTraceId: saved.proof.clientTraceId });
  const statusResponse = await fetcher(`/api/image/status?${query}`, { headers: { Authorization: `Bearer ${io.token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000) });
  const status = await statusResponse.json() as Record<string, unknown>;
  if (statusResponse.ok && status.state === "completed" && (status.deliveryReady === true || status.deliveryMode === "inline_ephemeral")) {
    const completed = updateImageValidationReceipt(saved, status); saveImageValidationAttempt(io.storage, completed); io.onChange?.(completed); return completed;
  }
  if (!statusResponse.ok || status.state !== "provider_completed_pending_delivery" || status.canRecover !== true || status.canResubmit !== false) {
    throw new Error("原任务尚无可恢复结果，请继续检查原任务");
  }
  const working: ImageValidationAttempt = { ...saved, status: "finalizing", canRecover: false, error: "正在恢复原结果保存", errorCode: "" };
  saveImageValidationAttempt(io.storage, working); io.onChange?.(working);
  let next: ImageValidationAttempt;
  try {
    const response = await fetcher("/api/image/generate", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${io.token}` },
      body: JSON.stringify(saved.body), signal: AbortSignal.timeout(180000) });
    next = updateImageValidationReceipt(working, await response.json() as Record<string, unknown>, response.ok);
  } catch { next = { ...working, status: "unknown", error: "原结果恢复暂未确认，请检查原任务", errorCode: "IMAGE_VALIDATION_RECOVERY_UNKNOWN" }; }
  saveImageValidationAttempt(io.storage, next); io.onChange?.(next); return next;
}
export async function fetchImageValidationAsset(assetId: string, token: string, fetcher: typeof fetch = fetch) {
  if (!token || !ASSET_ID.test(assetId)) throw new Error("图片归属信息不完整");
  return fetchValidationPreview(`/api/storage/files/${encodeURIComponent(assetId)}/content?download=1`,token,fetcher);
}
export async function fetchImageValidationRecord(recordId:string,token:string,fetcher:typeof fetch=fetch){
  if(!token || !/^[a-f0-9]{64}$/u.test(recordId))throw new Error("图片归属信息不完整");
  return fetchValidationPreview(`/api/media-history/content?recordId=${recordId}`,token,fetcher);
}
async function fetchValidationPreview(url:string,token:string,fetcher:typeof fetch){
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000) });
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), limit = 30 * 1024 * 1024;
  if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(type) || !response.body) throw new Error("原验证图片暂时无法读取");
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new Error("图片超过 30MB 读取上限"); }
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("图片超过 30MB 读取上限"); } chunks.push(new Uint8Array(item.value)); } }
  finally { reader.releaseLock(); }
  if (!size) throw new Error("原验证图片内容为空");
  return { blob: new Blob(chunks, { type }), extension: type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png" };
}
