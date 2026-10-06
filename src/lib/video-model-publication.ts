import { updateVideoModelAtomic } from "@/lib/video-model-atomic-update";
import { createHash } from "node:crypto";
import type { AdminAuthorizationResult } from "@/lib/admin-auth";
import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import { authorizeCompletedVideoAdminValidationProof, buildVideoAdminValidationClaimKey, buildVideoAdminValidationContext, loadVideoAdminValidationContext, VideoAdminValidationError, type CompletedVideoValidationProof, type VideoAdminValidationContext } from "@/lib/video-admin-validation";
import { inspectVideoModelActivationReadiness, issueVideoModelAcceptanceEvidence, makePendingVideoProtocolConfig, MODEL_ACTIVATION_GATE_KEY, persistVideoModelAcceptanceEvidence, stripClientActivationGate, videoActivationBindingSha256V2, type VideoActivationBinding } from "@/lib/model-activation-gate";
import { resolveVideoCharge } from "@/lib/video-model-capabilities";
import { VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION } from "@/lib/video-channel-health-release";
import { persistStableVideoFromUrl } from "@/lib/video-persistence";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { trustedVideoProviderResultHostname } from "@/lib/video-provider-result-url";

type Database = ReturnType<typeof getSupabaseAdminClient>;
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const VIDEO_MODEL_PUBLICATION_CONFIRMATION = "PUBLISH_VALIDATED_VIDEO_MODEL";
const TASK_COLUMNS = "id,user_id,model_id,client_request_id,task_id_external,status,duration_seconds,resolution,billing_state,billing_exempt,explicitly_free,billing_price_yuan,billing_cost_price_yuan,price_charged,billing_operation_id,billing_idempotency_key,video_url,storage_url,provider_result_url,completed_at";
const PERSISTENT_VIDEO_URI_PATTERN = /^object:\/\/tencent_cos\/[^?#]+$/u;

function failure(code: string, message: string, status = 409): never { throw new VideoAdminValidationError(code, message, status); }
function taskIdentity(context: VideoAdminValidationContext, proof: CompletedVideoValidationProof) {
  const claim = buildVideoAdminValidationClaimKey({ ...context, configurationHash: proof.configurationHash, healthEpoch: proof.healthEpoch });
  const digest = createHash("sha256").update(`video-task:v1:video-channel-validation:${claim}`).digest("hex");
  const taskId = `vt_${digest.slice(0, 40)}`;
  // The reservation RPC persists this key from p_task_id, not from the untruncated digest.
  return { taskId, billingKey: `video-terminal:${taskId}` };
}
function readPublication(context: VideoAdminValidationContext): Row {
  return record(record(record(context.model.api_protocol_config)[MODEL_ACTIVATION_GATE_KEY]).publication);
}
function publicationConfigurationFingerprint(context: VideoAdminValidationContext) {
  // Publication itself changes gate/visibility, but must not excuse price, duration, or other config edits.
  return buildVideoAdminValidationContext({ model: { ...context.model, is_active: false, is_hidden: true, api_protocol_config: stripClientActivationGate(context.model.api_protocol_config) }, health: context.health, userId: context.userId }).configurationHash;
}

async function persistReleaseVerifiedHealth(input: {
  db: Database;
  context: VideoAdminValidationContext;
  proof: CompletedVideoValidationProof;
  taskId: string;
  assetId: string;
}) {
  const health = record(input.context.health);
  const lastSuccessAt = String(health.last_success_at || "");
  const updatedAt = String(health.updated_at || "");
  const existingEvidence = record(health.verification_evidence);
  if (health.health_protocol_version === VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION
      && health.verification_state === "verified"
      && existingEvidence.task_id === input.taskId
      && existingEvidence.evidence_id === `asset:${input.assetId}`
      && existingEvidence.configuration_hash === input.proof.configurationHash) return;
  if (!lastSuccessAt || !Number.isFinite(Date.parse(lastSuccessAt)) || health.is_healthy !== true) {
    failure("VIDEO_PUBLICATION_HEALTH_UNAVAILABLE", "验证任务已完成，但当前健康结果尚不能发布", 503);
  }
  const verifiedAt = new Date(Math.max(Date.now(), Date.parse(lastSuccessAt))).toISOString();
  let update = input.db.from("video_channel_health").update({
    health_protocol_version: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
    verification_state: "verified",
    verified_at: verifiedAt,
    verification_evidence: {
      evidence_id: `asset:${input.assetId}`,
      task_id: input.taskId,
      model_id: input.context.model.id,
      configuration_hash: input.proof.configurationHash,
      health_epoch: input.proof.healthEpoch,
      verified_by: input.context.userId,
    },
  }).eq("channel_id", input.context.model.id).eq("is_healthy", true).eq("last_success_at", lastSuccessAt);
  if (updatedAt) update = update.eq("updated_at", updatedAt);
  const { data, error } = await update.select("channel_id,verification_state,verified_at").abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (error) failure("VIDEO_PUBLICATION_HEALTH_SAVE_UNKNOWN", "模型已发布，但健康证明暂不能确认；请保留原证明并重试发布", 503);
  if (!data || data.verification_state !== "verified") failure("VIDEO_PUBLICATION_HEALTH_RACE", "发布期间健康状态已变化，请重新检查原任务", 409);
}
function acceptedReplay(context: VideoAdminValidationContext, proof: CompletedVideoValidationProof, taskId?: string) {
  const publication = readPublication(context);
  return publication.validationKey === proof.validationKey && publication.configurationHash === proof.configurationHash
    && publication.healthEpoch === proof.healthEpoch && publication.userId === context.userId
    && (!taskId || publication.taskId === taskId)
    && publication.configurationBindingHash === publicationConfigurationFingerprint(context)
    && inspectVideoModelActivationReadiness(context.model as VideoActivationBinding).ready
    && context.model.is_active === true && context.model.is_hidden === false;
}
export function authorizeVideoPublicationProof(context: VideoAdminValidationContext, proof: CompletedVideoValidationProof, authorization: AdminAuthorizationResult, taskId?: string) {
  const replay = acceptedReplay(context, proof, taskId);
  authorizeCompletedVideoAdminValidationProof(context, proof, authorization, replay ? { acceptedConfigurationHash: proof.configurationHash } : {});
  return replay;
}

/** GET-only recovery: another administrator's reservation is represented only as busy. */
export async function readVideoValidationAttempt(db: Database, context: VideoAdminValidationContext, proof: CompletedVideoValidationProof) {
  const identity = taskIdentity(context, proof);
  const { data, error } = await db.from("video_tasks").select(TASK_COLUMNS).eq("id", identity.taskId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (error) failure("VIDEO_VALIDATION_TASK_LOOKUP_UNAVAILABLE", "暂时无法读取原验证任务", 503);
  const task = record(data);
  if (!task.id) return { existingTask: null, busy: false };
  if (task.user_id !== context.userId) return { existingTask: null, busy: true };
  if (task.model_id !== context.model.id || task.client_request_id !== proof.clientRequestId) failure("VIDEO_VALIDATION_TASK_IDENTITY_MISMATCH", "验证任务身份不匹配");
  return { busy: false, existingTask: {
    taskId: String(task.task_id_external || task.id), businessTaskId: String(task.id), providerTaskId: String(task.task_id_external || ""),
    status: String(task.status || "unknown"), billingState: String(task.billing_state || "unknown"),
    ...proof,
  } };
}

function finiteMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || (typeof value !== "number" && typeof value !== "string")) return null;
  const amount = Number(value); return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

async function ensureValidationPublicationAsset(input: {
  db: Database;
  context: VideoAdminValidationContext;
  task: Row;
}) {
  const existingStable = String(input.task.storage_url || "");
  if (PERSISTENT_VIDEO_URI_PATTERN.test(existingStable) && input.task.video_url === existingStable) return input.task;

  const providerResultUrl = String(input.task.provider_result_url || input.task.video_url || "").trim();
  if (!providerResultUrl || PERSISTENT_VIDEO_URI_PATTERN.test(providerResultUrl)) {
    failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "验证视频尚无可归档的供应商结果");
  }
  let trustedProviderResultHost = "";
  try {
    trustedProviderResultHost = trustedVideoProviderResultHostname(providerResultUrl, {
      protocolType: input.context.model.protocol_type,
      apiProtocolConfig: input.context.model.api_protocol_config,
      apiEndpoint: input.context.model.api_endpoint,
    });
  } catch {
    failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "验证视频的供应商结果地址未通过当前渠道校验");
  }

  let stableStorageUrl = "";
  try {
    const protocolType = String(input.context.model.protocol_type || "");
    stableStorageUrl = await persistStableVideoFromUrl(
      providerResultUrl,
      String(input.task.id),
      input.context.userId,
      {
        trimDurationSeconds: Number(input.task.duration_seconds) || undefined,
        sourceDurationSeconds: Number(input.task.duration_seconds) || undefined,
        providerProtocol: protocolType,
        providerEndpoint: String(input.context.model.api_endpoint || ""),
        providerApiKey: ["suanlicheng_video", "gaorui_video"].includes(protocolType)
          ? resolveProviderSecret(input.context.model.api_key)
          : undefined,
        providerTaskId: String(input.task.task_id_external || ""),
        trustedProviderResultHostname: trustedProviderResultHost,
      },
    );
  } catch {
    failure("VIDEO_PUBLICATION_ASSET_PERSISTENCE_FAILED", "验证视频已生成，但稳定资产归档失败；请保留原任务后重试发布", 503);
  }
  if (!PERSISTENT_VIDEO_URI_PATTERN.test(stableStorageUrl)) {
    failure("VIDEO_PUBLICATION_ASSET_PERSISTENCE_FAILED", "验证视频归档未返回稳定资产标识", 503);
  }

  const { data, error } = await input.db.from("video_tasks").update({
    storage_url: stableStorageUrl,
    video_url: stableStorageUrl,
    provider_result_url: providerResultUrl,
  }).eq("id", input.task.id)
    .eq("user_id", input.context.userId)
    .eq("model_id", input.context.model.id)
    .eq("client_request_id", input.task.client_request_id)
    .eq("status", "completed")
    .eq("task_id_external", input.task.task_id_external)
    .select(TASK_COLUMNS)
    .abortSignal(AbortSignal.timeout(10_000))
    .maybeSingle();
  if (error) failure("VIDEO_PUBLICATION_ASSET_SAVE_UNKNOWN", "验证视频已归档，但任务记录暂不能确认；请保留原任务后重试发布", 503);
  const updated = record(data);
  if (!updated.id || updated.storage_url !== stableStorageUrl || updated.video_url !== stableStorageUrl) {
    failure("VIDEO_PUBLICATION_ASSET_RACE", "验证视频归档期间任务状态已变化，请重新读取原任务", 409);
  }
  return updated;
}

/** No task finalization, generation, debit, or health mutation occurs here. */
export async function publishValidatedVideoModel(input: {
  db: Database; authorization: AdminAuthorizationResult; modelId: string; taskId: string; proof: CompletedVideoValidationProof; confirmation: unknown;
}, dependencies: { head?: (key: string) => Promise<{ size: number; contentType: string } | null> } = {}) {
  if (!input.authorization.ok) failure("VIDEO_VALIDATION_ADMIN_REQUIRED", "请使用当前有效管理员身份", 403);
  if (input.confirmation !== VIDEO_MODEL_PUBLICATION_CONFIRMATION) failure("VIDEO_PUBLICATION_CONFIRMATION_REQUIRED", "请明确确认发布已验证模型", 400);
  const { db, authorization, proof } = input;
  const context = await loadVideoAdminValidationContext(db, input.modelId, authorization.user.id);
  const alreadyPublished = authorizeVideoPublicationProof(context, proof, authorization, input.taskId);
  const identity = taskIdentity(context, proof);
  if (input.taskId !== identity.taskId) failure("VIDEO_PUBLICATION_TASK_MISMATCH", "只能使用原配置的受控验证任务发布");
  const { data, error } = await db.from("video_tasks").select(TASK_COLUMNS).eq("id", input.taskId).eq("user_id", context.userId).eq("model_id", context.model.id).eq("client_request_id", proof.clientRequestId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (error) failure("VIDEO_PUBLICATION_EVIDENCE_UNAVAILABLE", "暂时无法读取任务证据", 503);
  let task = record(data);
  if (!task.id || task.user_id !== context.userId || task.model_id !== context.model.id || task.client_request_id !== proof.clientRequestId) failure("VIDEO_PUBLICATION_TASK_MISMATCH", "原管理员、模型与验证任务不匹配");
  if (task.status !== "completed" || !task.task_id_external || !Number.isFinite(Date.parse(String(task.completed_at || "")))) failure("VIDEO_PUBLICATION_TASK_INCOMPLETE", "原验证任务尚未完成，不能发布");
  task = await ensureValidationPublicationAsset({ db, context, task });
  const stable = String(task.storage_url || "");
  if (!/^object:\/\/tencent_cos\/[^?#]+$/u.test(stable) || task.video_url !== stable) failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "验证视频尚无稳定结果");
  let storageKey = "";
  try { storageKey = decodeURIComponent(stable.slice("object://tencent_cos/".length)); } catch { failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "稳定结果标识无效"); }
  if (!storageKey || /[\u0000\r\n]/u.test(storageKey) || storageKey.split("/").includes("..")) failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "稳定结果标识无效");
  const { data: assetData, error: assetError } = await db.from("user_files").select("id,user_id,storage_key,storage_provider,file_size,content_type,source,meta").eq("user_id", context.userId).eq("storage_provider", "tencent_cos").eq("storage_key", storageKey).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (assetError) failure("VIDEO_PUBLICATION_EVIDENCE_UNAVAILABLE", "暂时无法读取资产归属证据", 503);
  const asset = record(assetData);
  if (!asset.id || asset.user_id !== context.userId || asset.storage_key !== storageKey || asset.storage_provider !== "tencent_cos" || !String(asset.content_type).startsWith("video/") || !(Number(asset.file_size) > 0) || record(asset.meta).taskId !== input.taskId) failure("VIDEO_PUBLICATION_ASSET_INCOMPLETE", "原验证任务的自有视频记录尚未闭环");
  const price = finiteMoney(task.billing_price_yuan), cost = finiteMoney(task.billing_cost_price_yuan), charged = finiteMoney(task.price_charged);
  if (price === null || cost === null || charged === null || task.billing_idempotency_key !== identity.billingKey) failure("VIDEO_PUBLICATION_BILLING_INCOMPLETE", "验证任务账务快照不完整");
  const expectedBilling = resolveVideoCharge(context.model, task.resolution, task.duration_seconds);
  // Submission stores customer charges in cents and supplier costs to four decimals.
  const expectedPrice = Math.round((expectedBilling.publicPrice + Number.EPSILON) * 100) / 100;
  if (price !== expectedPrice || cost !== expectedBilling.costPrice) failure("VIDEO_PUBLICATION_BILLING_INCOMPLETE", "原任务报价与已签名模型配置不一致");
  const { data: operationData, error: operationError } = await db.from("wallet_operations").select("id,user_id,wallet,operation_kind,idempotency_key,status,amount,delta").eq("user_id", context.userId).eq("idempotency_key", identity.billingKey).abortSignal(AbortSignal.timeout(10_000));
  if (operationError) failure("VIDEO_PUBLICATION_EVIDENCE_UNAVAILABLE", "暂时无法读取账务证据", 503);
  const operations = Array.isArray(operationData) ? operationData.map(record) : [];
  if (task.billing_exempt === true || task.explicitly_free === true) {
    if (task.billing_state !== "not_required" || charged !== 0 || task.billing_operation_id || operations.length !== 0) failure("VIDEO_PUBLICATION_BILLING_INCOMPLETE", "免费验证任务出现不一致账务记录");
  } else {
    const operation = operations.find(row => row.id === task.billing_operation_id);
    if (task.billing_state !== "settled" || !(price > 0) || charged !== Math.round(price * 100) / 100 || operations.length !== 1 || !operation || operation.wallet !== "cash" || operation.operation_kind !== "cash_charge" || operation.status !== "completed" || Number(operation.amount) !== price || Number(operation.delta) !== -price) failure("VIDEO_PUBLICATION_BILLING_INCOMPLETE", "验证任务尚无匹配的原子结算记录");
  }
  let head: { size: number; contentType: string } | null = null;
  try { head = await (dependencies.head || ((key: string) => storageManager.head(key, "tencent_cos")))(storageKey); } catch { failure("VIDEO_PUBLICATION_ASSET_UNAVAILABLE", "暂时无法确认稳定视频可读取，请保留原任务后重试发布", 503); }
  if (!head || head.size !== Number(asset.file_size) || !head.contentType.startsWith("video/")) failure("VIDEO_PUBLICATION_ASSET_UNAVAILABLE", "稳定视频尚不能读取或元数据不匹配", 503);
  if (alreadyPublished) {
    await persistReleaseVerifiedHealth({ db, context, proof, taskId: input.taskId, assetId: String(asset.id) });
    return { success: true, modelId: context.model.id, taskId: input.taskId, active: true, hidden: false, alreadyPublished: true };
  }
  // Reload after external asset verification. The conditional config write then fences concurrent edits.
  const latest = await loadVideoAdminValidationContext(db, context.model.id, context.userId);
  authorizeCompletedVideoAdminValidationProof(latest, proof, authorization);
  const binding = { ...latest.model, api_protocol_config: makePendingVideoProtocolConfig(latest.model.api_protocol_config, { binding: latest.model as VideoActivationBinding }) } as VideoActivationBinding;
  const evidenceRef = `task:${input.taskId}`;
  const check = { evidenceRef, checkedAt: String(task.completed_at) };
  const evidence = issueVideoModelAcceptanceEvidence(binding, { secretResolution: check, endpointConnectivity: check, protocolFixture: check, canary: check, resultPersistence: { evidenceRef: `asset:${asset.id}`, checkedAt: String(task.completed_at) } }, { issuedBy: context.userId });
  const config = persistVideoModelAcceptanceEvidence(binding.api_protocol_config, evidence);
  const gate = record(config[MODEL_ACTIVATION_GATE_KEY]);
  config[MODEL_ACTIVATION_GATE_KEY] = { ...gate, publication: { ...proof, taskId: input.taskId, userId: context.userId, assetId: String(asset.id), publishedAt: new Date().toISOString(), bindingSha256: videoActivationBindingSha256V2(binding), configurationBindingHash: publicationConfigurationFingerprint(latest) } };
  // Compare every configuration field, including the signed quote, under the database row lock.
  const { data: updated, error: updateError } = await updateVideoModelAtomic(db, latest.model, { api_protocol_config: config, is_active: true, is_hidden: false });
  if (updateError) failure("VIDEO_PUBLICATION_SAVE_UNKNOWN", "发布结果暂不能确认，请保留原证明查询或重试发布", 503);
  if (!updated) failure("VIDEO_PUBLICATION_CONFIGURATION_RACE", "发布期间模型已被修改，请重新检查配置");
  await persistReleaseVerifiedHealth({ db, context, proof, taskId: input.taskId, assetId: String(asset.id) });
  return { success: true, modelId: context.model.id, taskId: input.taskId, active: true, hidden: false, alreadyPublished: false };
}
