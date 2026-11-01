import { resolveImageProviderContract } from "@/lib/image-provider-contract";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getJwtSecretString } from "@/lib/auth";
import type { AdminAuthorizationResult } from "@/lib/admin-auth";
import type { ImageRequestRejection } from "@/lib/image-exactly-once";
import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { getImageModelCapabilities, IMAGE_RESOLUTION_ORDER } from "@/lib/image-model-capabilities";
import { isRetiredCoverModel } from "@/lib/retired-cover-models";
import { toPublicModelId } from "@/lib/public-model-dto";

export const IMAGE_ADMIN_VALIDATION_CONFIRMATION = "RUN_SINGLE_REAL_IMAGE_VALIDATION";
export const IMAGE_MODEL_PUBLICATION_CONFIRMATION = "PUBLISH_VALIDATED_IMAGE_MODEL";
const SCHEMA = "image_admin_validation.v1";
const ATTEMPT_COLUMNS = "validation_id,model_id,configuration_hash,model_snapshot_hash,epoch,user_id,client_idempotency_key,client_trace_id,image_record_id,payload_fingerprint,state,quoted_price_yuan,cost_price_yuan,rejection_code,rejection_http_status,asset_id,published_at,evidence";
type Database = ReturnType<typeof getSupabaseAdminClient>;
export type ImageValidationRow = Record<string, unknown>;
export type ImageValidationProof = { validationKey: string; configurationHash: string; epoch: number; clientIdempotencyKey: string; clientTraceId: string };
export class ImageAdminValidationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "ImageAdminValidationError"; }
}
export function imageValidationFailure(code: string, message: string, status = 409): never { throw new ImageAdminValidationError(code, message, status); }
const row = (value: unknown): ImageValidationRow => value && typeof value === "object" && !Array.isArray(value) ? value as ImageValidationRow : {};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function configuredMoney(value: unknown) {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const amount = Number(value); return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
function serverOnly() { if (typeof window !== "undefined") imageValidationFailure("IMAGE_VALIDATION_SERVER_ONLY", "模型验证只允许在服务端执行", 500); }
export function assertImageValidationDatabase(db: Database) {
  serverOnly();
  let target: URL;
  try { target = new URL(String(db.supabaseUrl || "")); } catch { imageValidationFailure("IMAGE_VALIDATION_DATABASE_UNAVAILABLE", "无法确认当前应用数据库", 503); }
  // This server-created client already selects the deployment's database.
  // Public model reads and administrator validation must use that same client.
  if (!["http:", "https:"].includes(target.protocol) || target.pathname !== "/" || target.username || target.password || target.search || target.hash) {
    imageValidationFailure("IMAGE_VALIDATION_DATABASE_UNAVAILABLE", "当前应用数据库地址无效", 503);
  }
}
export function assertImageValidationAdministrator(authorization: AdminAuthorizationResult, userId?: string) {
  serverOnly();
  if (!authorization.ok) imageValidationFailure(authorization.code, authorization.error, authorization.status);
  if (authorization.user.role !== "admin" || authorization.user.is_active !== true
    || (authorization.user.status != null && authorization.user.status !== "active")
    || (userId && authorization.user.id !== userId)) imageValidationFailure("IMAGE_VALIDATION_ADMIN_REQUIRED", "请使用当前有效管理员身份", 403);
  return authorization.user.id;
}
export function assertImageValidationModelId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value) || value.startsWith("pm_")) {
    imageValidationFailure("IMAGE_VALIDATION_MODEL_ID_REQUIRED", "请选择明确的后台生图模型", 400);
  }
}
export type ImageAdminValidationContext = {
  schema: typeof SCHEMA; userId: string;
  /** Private: never serialize model or the context itself into an API response. */
  model: ImageValidationRow & { id: string };
  modelSnapshotHash: string; configurationHash: string; credentialReady: boolean; priceReady: boolean;
  epoch: number; validationId: string; validationKey: string;
  existing: ImageValidationRow | null; busy: boolean; retestReason: string;
};
function signature(userId: string, modelId: string, configurationHash: string, epoch: number, secret: string) {
  return `iav_${createHmac("sha256", secret).update(JSON.stringify({ schema: SCHEMA, userId, modelId, configurationHash, epoch })).digest("hex")}`;
}
export function buildImageValidationClaimId(modelId: string, configurationHash: string, epoch: number) {
  return `ivc_${sha(`image-validation-claim:v1:${modelId}:${configurationHash}:${epoch}`)}`;
}
export function imageValidationRequestIdentity(userId: string, key: string) {
  return { recordId: sha(`${userId}\u0000${key}`), billingKey: `image:h3_${sha(`${userId}:${key}`).slice(0, 48)}` };
}
export function imageModelConfigurationHash(model: ImageValidationRow & { id: string }, modelSnapshotHash: string, resolveCredential = resolveProviderSecret) {
  serverOnly();
  if (!/^[a-f0-9]{64}$/u.test(modelSnapshotHash)) imageValidationFailure("IMAGE_VALIDATION_BINDING_INVALID", "当前模型快照不可确认", 503);
  let credential = "";
  try { credential = resolveCredential(model.api_key).trim(); } catch { /* Only a readiness boolean leaves this scope. */ }
  return { credentialReady: Boolean(credential), configurationHash: sha(JSON.stringify({ schema: SCHEMA, modelId: model.id, modelSnapshotHash, resolvedCredentialHash: credential ? sha(credential) : "unresolved" })) };
}
export function buildImageAdminValidationContext(input: {
  model: ImageValidationRow & { id: string }; modelSnapshotHash: string; userId: string;
  latest?: ImageValidationRow | null; unresolved?: ImageValidationRow | null; retestReason?: string;
  resolveCredential?: (value: unknown) => string; signingSecret?: string;
}): ImageAdminValidationContext {
  serverOnly(); assertImageValidationModelId(input.model.id);
  if (!input.userId || !/^[a-f0-9]{64}$/u.test(input.modelSnapshotHash)) imageValidationFailure("IMAGE_VALIDATION_BINDING_INVALID", "当前模型快照不可确认", 503);
  const { configurationHash, credentialReady } = imageModelConfigurationHash(input.model, input.modelSnapshotHash, input.resolveCredential);
  const latest = input.latest || null;
  if (latest && (latest.model_id !== input.model.id || latest.configuration_hash !== configurationHash || latest.model_snapshot_hash !== input.modelSnapshotHash
    || !Number.isSafeInteger(latest.epoch) || Number(latest.epoch) < 0)) imageValidationFailure("IMAGE_VALIDATION_ATTEMPT_MISMATCH", "验证记录与当前配置不匹配", 503);
  const retestReason = input.retestReason?.trim() || "";
  if (retestReason && (!latest || latest.state !== "rejected" || retestReason.length < 8 || retestReason.length > 300 || input.unresolved)) {
    imageValidationFailure("IMAGE_VALIDATION_RETEST_NOT_ALLOWED", "只有明确拒绝的原请求可在填写复测原因后再验证", 409);
  }
  const epoch = latest ? Number(latest.epoch) + (retestReason ? 1 : 0) : 0;
  const unresolved = input.unresolved;
  const busy = Boolean(unresolved && (unresolved.user_id !== input.userId || unresolved.configuration_hash !== configurationHash))
    || Boolean(latest && latest.user_id !== input.userId && !retestReason);
  const secret = input.signingSecret ?? getJwtSecretString();
  if (!secret) imageValidationFailure("IMAGE_VALIDATION_SIGNING_UNAVAILABLE", "模型验证签名配置不可用", 503);
  return { schema: SCHEMA, userId: input.userId, model: input.model, modelSnapshotHash: input.modelSnapshotHash,
    configurationHash, credentialReady, priceReady: configuredMoney(input.model.selling_price) !== null && configuredMoney(input.model.cost_price) !== null,
    epoch, validationId: buildImageValidationClaimId(input.model.id, configurationHash, epoch),
    validationKey: signature(input.userId, input.model.id, configurationHash, epoch, secret),
    existing: retestReason ? null : latest, busy, retestReason };
}
export async function loadImageAdminValidationContext(db: Database, modelId: unknown, authorization: AdminAuthorizationResult, retestReason = "") {
  assertImageValidationDatabase(db); assertImageValidationModelId(modelId);
  const userId = assertImageValidationAdministrator(authorization);
  const modelResult = await db.rpc("read_image_model_validation_model", { p_model_id: modelId, p_user_id: userId });
  if (modelResult.error) imageValidationFailure("IMAGE_VALIDATION_SCHEMA_OR_MODEL_UNAVAILABLE", "生图验证配置暂不可读取，请确认当前环境迁移已就绪", 503);
  const payload = row(modelResult.data), model = row(payload.model);
  if (model.id !== modelId) imageValidationFailure("IMAGE_VALIDATION_MODEL_NOT_FOUND", "没有该生图模型", 404);
  const base = buildImageAdminValidationContext({ model: model as ImageValidationRow & { id: string }, modelSnapshotHash: String(payload.modelSnapshotHash), userId });
  const [latestResult, unresolvedResult] = await Promise.all([
    db.from("image_model_validations").select(ATTEMPT_COLUMNS).eq("model_id", modelId).eq("configuration_hash", base.configurationHash).order("epoch", { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(10_000)).maybeSingle(),
    db.from("image_model_validations").select(ATTEMPT_COLUMNS).eq("model_id", modelId).in("state", ["claimed", "unknown"]).limit(1).abortSignal(AbortSignal.timeout(10_000)).maybeSingle(),
  ]);
  if (latestResult.error || unresolvedResult.error) imageValidationFailure("IMAGE_VALIDATION_STORE_UNAVAILABLE", "原验证占用暂不可读取，未提交生成", 503);
  return buildImageAdminValidationContext({ model: base.model, modelSnapshotHash: base.modelSnapshotHash, userId,
    latest: latestResult.data ? row(latestResult.data) : null, unresolved: unresolvedResult.data ? row(unresolvedResult.data) : null, retestReason });
}
export function authorizeImageValidationProof(context: ImageAdminValidationContext, proof: ImageValidationProof, authorization: AdminAuthorizationResult) {
  assertImageValidationAdministrator(authorization, context.userId);
  if (!proof || proof.configurationHash !== context.configurationHash || proof.epoch !== context.epoch
    || proof.clientIdempotencyKey !== proof.validationKey || proof.clientTraceId !== proof.validationKey
    || !/^iav_[a-f0-9]{64}$/u.test(String(proof.validationKey))) imageValidationFailure("IMAGE_VALIDATION_PROOF_STALE", "验证证明或原请求键已变化，未提交生成");
  const received = Buffer.from(proof.validationKey), expected = Buffer.from(context.validationKey);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) imageValidationFailure("IMAGE_VALIDATION_PROOF_INVALID", "验证证明与当前管理员或配置不匹配", 403);
  if (!context.credentialReady) imageValidationFailure("IMAGE_VALIDATION_CREDENTIAL_UNAVAILABLE", "当前模型凭据尚未就绪", 503);
  if (!context.priceReady) imageValidationFailure("IMAGE_VALIDATION_PRICE_INVALID", "当前模型成本或售价尚未配置", 503);
  if (context.busy) imageValidationFailure("IMAGE_VALIDATION_BUSY", "该模型已有原验证请求，请等待或读取原记录");
}
export async function claimImageAdminValidation(input: {
  db: Database; context: ImageAdminValidationContext; authorization: AdminAuthorizationResult;
  proof: ImageValidationProof; confirmation: unknown; payloadFingerprint: string;
}) {
  assertImageValidationDatabase(input.db); authorizeImageValidationProof(input.context, input.proof, input.authorization);
  if (input.confirmation !== IMAGE_ADMIN_VALIDATION_CONFIRMATION) imageValidationFailure("IMAGE_VALIDATION_CONFIRMATION_REQUIRED", "请明确确认单次真实生图验证", 400);
  if (!/^[a-f0-9]{64}$/u.test(input.payloadFingerprint)) imageValidationFailure("IMAGE_VALIDATION_PAYLOAD_INVALID", "图片原请求参数摘要无效", 400);
  const context = input.context;
  let result;
  try { result = await input.db.rpc("claim_image_model_validation", {
    p_validation_id: context.validationId, p_model_id: context.model.id, p_user_id: context.userId,
    p_configuration_hash: context.configurationHash, p_model_snapshot_hash: context.modelSnapshotHash,
    p_epoch: context.epoch, p_client_key: context.validationKey, p_payload_fingerprint: input.payloadFingerprint, p_retest_reason: context.retestReason,
  }); } catch { imageValidationFailure("IMAGE_VALIDATION_CLAIM_UNKNOWN", "验证占用结果未知，请保留原证明查询，勿另建请求", 503); }
  if (result.error) imageValidationFailure("IMAGE_VALIDATION_CLAIM_UNKNOWN", "验证占用未确认，请保留原证明查询", 503);
  const data = row(result.data);
  if (data.busy === true) imageValidationFailure("IMAGE_VALIDATION_BUSY", "另一个原验证请求已占用该模型");
  const claimed = row(data.record), identity = imageValidationRequestIdentity(context.userId, context.validationKey);
  if (typeof data.created !== "boolean" || claimed.validation_id !== context.validationId || claimed.user_id !== context.userId
    || claimed.model_id !== context.model.id || claimed.configuration_hash !== context.configurationHash || claimed.epoch !== context.epoch
    || claimed.client_idempotency_key !== context.validationKey || claimed.client_trace_id !== context.validationKey
    || claimed.payload_fingerprint !== input.payloadFingerprint || claimed.image_record_id !== identity.recordId) {
    imageValidationFailure("IMAGE_VALIDATION_CLAIM_UNKNOWN", "验证占用收据不完整，请读取原记录", 503);
  }
  return { created: data.created, record: claimed, strictSingleSubmit: true as const, noRetry: true as const };
}
export async function readImageValidationAttempt(db: Database, context: ImageAdminValidationContext) {
  assertImageValidationDatabase(db);
  const attempt = context.existing;
  if (!attempt || context.busy || attempt.user_id !== context.userId) return { existingAttempt: null, busy: context.busy };
  const identity = imageValidationRequestIdentity(context.userId, context.validationKey);
  if (attempt.image_record_id !== identity.recordId || attempt.client_idempotency_key !== context.validationKey || attempt.client_trace_id !== context.validationKey) imageValidationFailure("IMAGE_VALIDATION_ATTEMPT_MISMATCH", "原验证请求身份不一致", 503);
  const result = await db.from("image_generation_requests").select("record_id,user_id,client_idempotency_key,client_trace_id,payload_fingerprint,state,response,delivery_state,delivery_asset_id").eq("record_id", identity.recordId).eq("user_id", context.userId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (result.error) imageValidationFailure("IMAGE_VALIDATION_REQUEST_UNAVAILABLE", "原图片请求暂不可读取", 503);
  const request = row(result.data);
  if (request.record_id && (request.payload_fingerprint !== attempt.payload_fingerprint || request.client_trace_id !== context.validationKey)) imageValidationFailure("IMAGE_VALIDATION_ATTEMPT_MISMATCH", "原图片参数不匹配", 503);
  return { busy: false, existingAttempt: { validationId: context.validationId, imageRecordId: identity.recordId, state: String(attempt.state),
    requestState: request.record_id ? String(request.state) : "not_recorded", deliveryState: String(request.delivery_state || "held"),
    assetId: attempt.state==="published" ? String(attempt.asset_id||"") : request.delivery_state === "delivered" ? String(request.delivery_asset_id || "") : null,
    ...(["provider_url","inline_ephemeral"].includes(String(row(request.response).deliveryMode)) ? {deliveryReceipt:{recordId:identity.recordId,deliveryMode:row(request.response).deliveryMode,cashCharged:Number(attempt.quoted_price_yuan),billingReferenceId:identity.billingKey,sha256:row(request.response).sha256,byteLength:row(request.response).byteLength,contentType:row(request.response).contentType,width:row(request.response).width,height:row(request.response).height}}:{}),
    hasProviderCheckpoint: row(request.response).schema === "image_provider_checkpoint.v1" } };
}
export async function recordImageAdminValidationOutcome(input: {
  db: Database; context: ImageAdminValidationContext; authorization: AdminAuthorizationResult;
  outcome: "unknown" | "completed" | "rejected";
  rejection?: ImageRequestRejection;
}) {
  assertImageValidationDatabase(input.db); assertImageValidationAdministrator(input.authorization, input.context.userId);
  if (input.outcome === "rejected" && !input.rejection) imageValidationFailure("IMAGE_VALIDATION_REJECTION_UNPROVEN", "缺少上游明确拒绝证据");
  const result = await input.db.rpc("record_image_model_validation_outcome", {
    p_validation_id: input.context.validationId, p_user_id: input.context.userId, p_outcome: input.outcome,
    p_rejection_code: input.rejection?.code || null, p_http_status: input.rejection?.upstreamStatus ?? null,
  });
  if (result.error || row(row(result.data).record).validation_id !== input.context.validationId) {
    imageValidationFailure("IMAGE_VALIDATION_OUTCOME_UNKNOWN", "验证状态暂未确认，必须保留原请求", 503);
  }
}
export function cleanImageModelText(model: ImageValidationRow, value: unknown) {
  let actualSecret = ""; try { actualSecret = resolveProviderSecret(model.api_key).trim(); } catch { /* No secret diagnostic. */ }

  let text = String(value || "");
  for (const secret of [String(model.api_key || ""), actualSecret]) if (secret) text = text.split(secret).join("[凭据已隐藏]");
  return text.replace(/https?:\/\/\S+/gu, "[链接已隐藏]").replace(/\bBearer\s+\S+/giu, "[凭据已隐藏]").slice(0, 180);
}

export function publicImageModelCapabilities(model: ImageValidationRow) {
  const rawCapabilities = getImageModelCapabilities(model);
  // Configuration text is untrusted even in an administrator-only response. Project every
  // field explicitly so future helper additions cannot expose a raw configuration value.
  return {
    resolutionOptions: rawCapabilities.resolutionOptions.filter(value => IMAGE_RESOLUTION_ORDER.includes(value)),
    defaultResolution: IMAGE_RESOLUTION_ORDER.includes(rawCapabilities.defaultResolution) ? rawCapabilities.defaultResolution : "1K",
    supportsReferenceInput: rawCapabilities.supportsReferenceInput === true,
    referenceInputMode: ["none", "single", "multi"].includes(rawCapabilities.referenceInputMode) ? rawCapabilities.referenceInputMode : "none",
    identityReferenceLevel: ["none", "single-subject", "multi-subject"].includes(rawCapabilities.identityReferenceLevel) ? rawCapabilities.identityReferenceLevel : "none",
    maxReferenceImages: Number.isSafeInteger(rawCapabilities.maxReferenceImages) && rawCapabilities.maxReferenceImages >= 0 ? rawCapabilities.maxReferenceImages : 0,
    maxCharacterReferences: Number.isSafeInteger(rawCapabilities.maxCharacterReferences) && rawCapabilities.maxCharacterReferences >= 0 ? rawCapabilities.maxCharacterReferences : 0,
    referenceCapabilityLabel: cleanImageModelText(model, rawCapabilities.referenceCapabilityLabel),
  };
}

export function toImageAdminValidationDto(context: ImageAdminValidationContext) {
  const clean = (value: unknown) => cleanImageModelText(context.model, value);
  const capabilities = publicImageModelCapabilities(context.model);
  const requiresReferenceInput = resolveImageProviderContract(context.model).requestProtocol === "images_edits";
  return { modelId: context.model.id, publicModelId: toPublicModelId("cover", context.model.id), name: clean(context.model.name), modelName: clean(context.model.model_name),
    active: context.model.is_active === true, hidden: context.model.is_hidden === true, credentialReady: context.credentialReady, priceReady: context.priceReady,
    capabilities, requiresReferenceInput, minReferenceImages: requiresReferenceInput ? 1 : 0, currentRetirementRule: isRetiredCoverModel(context.model),
    requiresComputeReadiness: context.model.provider === "autodl_h3_selfhost", acceptance: context.existing?.state === "published" ? "published" : "pending",
    quotedPriceYuan: configuredMoney(context.model.selling_price), costPriceYuan: configuredMoney(context.model.cost_price),
    confirmation: IMAGE_ADMIN_VALIDATION_CONFIRMATION, epoch: context.epoch, configurationHash: context.configurationHash,
    validationKey: context.busy ? null : context.validationKey, clientIdempotencyKey: context.busy ? null : context.validationKey, clientTraceId: context.busy ? null : context.validationKey,
    canRequestRetest: context.existing?.state === "rejected" && !context.busy, busy: context.busy, taskSubmitted: false };
}
