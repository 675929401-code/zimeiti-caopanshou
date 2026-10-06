import { createHash } from "node:crypto";
import sharp from "sharp";
import type { AdminAuthorizationResult } from "@/lib/admin-auth";
import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import {
  IMAGE_MODEL_PUBLICATION_CONFIRMATION, authorizeImageValidationProof, assertImageValidationDatabase,
  imageValidationFailure, imageValidationRequestIdentity, loadImageAdminValidationContext,
  type ImageValidationProof, type ImageValidationRow,
} from "./image-admin-validation";

type Database = ReturnType<typeof getSupabaseAdminClient>;
const row = (value: unknown): ImageValidationRow => value && typeof value === "object" && !Array.isArray(value) ? value as ImageValidationRow : {};
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
type VerifiedImage = { size: number; contentType: string; width: number; height: number; sha256: string };
function money(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : null;
}
function sameDatabaseIdentifier(left: unknown, right: unknown): boolean {
  const normalizedLeft = String(left ?? "").trim();
  const normalizedRight = String(right ?? "").trim();
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}
/** Read only the original owned COS object and decode its complete bytes. No provider call. */
export async function verifyImagePublicationObject(storageKey: string, storage: Pick<typeof storageManager, "head" | "readBounded"> = storageManager): Promise<VerifiedImage> {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("://") || /[\u0000\r\n\\]/u.test(storageKey) || storageKey.split("/").includes("..")) {
    imageValidationFailure("IMAGE_PUBLICATION_OBJECT_UNAVAILABLE", "原图片对象路径无效", 503);
  }
  const head = await storage.head(storageKey, "tencent_cos");
  if (!head || !Number.isInteger(head.size) || head.size <= 0 || head.size > 25 * 1024 * 1024 || !IMAGE_TYPES.has(head.contentType)) {
    imageValidationFailure("IMAGE_PUBLICATION_OBJECT_UNAVAILABLE", "原图片对象尚不可确认", 503);
  }
  const buffer = await storage.readBounded(storageKey, head.size, 20_000, "tencent_cos");
  if (buffer.length !== head.size) {
    imageValidationFailure("IMAGE_PUBLICATION_OBJECT_INCOMPLETE", "原图片下载不完整，不能发布", 503);
  }
  const decoder = sharp(buffer, { failOn: "error", limitInputPixels: 40_000_000 });
  const metadata = await decoder.metadata();
  const expectedFormat = head.contentType === "image/jpeg" ? "jpeg" : head.contentType.slice(6);
  if (metadata.format !== expectedFormat) imageValidationFailure("IMAGE_PUBLICATION_OBJECT_INCOMPLETE", "原图片格式与资产记录不匹配", 503);
  const decoded = await decoder.raw().toBuffer();
  const width = Number(metadata.width), height = Number(metadata.height);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || !decoded.length) imageValidationFailure("IMAGE_PUBLICATION_DECODE_FAILED", "原图片不能完整解码", 503);
  return { size: buffer.length, contentType: head.contentType, width, height,
    sha256: createHash("sha256").update(buffer).digest("hex") };
}

/** Validation/persistence/charge are never synthesized here. Publication is the final locked DB mutation. */
export async function publishValidatedImageModel(input: {
  db: Database; authorization: AdminAuthorizationResult; modelId: string; imageRecordId: string;
  proof: ImageValidationProof; confirmation: unknown;
}, dependencies: { verifyObject?: (key: string) => Promise<VerifiedImage> } = {}) {
  assertImageValidationDatabase(input.db);
  if (input.confirmation !== IMAGE_MODEL_PUBLICATION_CONFIRMATION) imageValidationFailure("IMAGE_PUBLICATION_CONFIRMATION_REQUIRED", "请明确确认发布已完成验证的模型", 400);
  const context = await loadImageAdminValidationContext(input.db, input.modelId, input.authorization);
  authorizeImageValidationProof(context, input.proof, input.authorization);
  const attempt = context.existing, identity = imageValidationRequestIdentity(context.userId, context.validationKey);
  if (!attempt || attempt.user_id !== context.userId || attempt.validation_id !== context.validationId || attempt.image_record_id !== identity.recordId || input.imageRecordId !== identity.recordId) {
    imageValidationFailure("IMAGE_PUBLICATION_REQUEST_MISMATCH", "只允许发布当前配置的原验证请求");
  }
  if (attempt.state === "rejected") imageValidationFailure("IMAGE_PUBLICATION_REQUEST_INCOMPLETE", "原验证请求被明确拒绝，不能发布");
  const result = await input.db.from("image_generation_requests").select("record_id,user_id,client_idempotency_key,client_trace_id,payload_fingerprint,state,response,delivery_state,delivery_asset_id").eq("record_id", identity.recordId).eq("user_id", context.userId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (result.error) imageValidationFailure("IMAGE_PUBLICATION_REQUEST_UNAVAILABLE", "原图片请求暂不可读取", 503);
  const request = row(result.data), response = row(request.response);
  if (request.record_id !== identity.recordId || request.user_id !== context.userId || request.client_idempotency_key !== context.validationKey
    || request.client_trace_id !== context.validationKey || request.payload_fingerprint !== attempt.payload_fingerprint
    || request.state !== "completed" || request.delivery_state !== "delivered" || !request.delivery_asset_id || response.selectedModelId !== context.model.id) {
    imageValidationFailure("IMAGE_PUBLICATION_REQUEST_INCOMPLETE", "原图片尚未完成保存与归属交付");
  }
  const assetResult = await input.db.from("user_files").select("id,user_id,storage_key,storage_provider,file_size,content_type,meta").eq("id", request.delivery_asset_id).eq("user_id", context.userId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (assetResult.error) imageValidationFailure("IMAGE_PUBLICATION_ASSET_UNAVAILABLE", "原图片资产暂不可读取", 503);
  const asset = row(assetResult.data), meta = row(asset.meta), storageKey = String(asset.storage_key || "");
  if (asset.id !== request.delivery_asset_id || asset.user_id !== context.userId || !storageKey || /[\u0000\r\n]/u.test(storageKey)
    || storageKey.split("/").includes("..") || asset.storage_provider !== "tencent_cos" || !IMAGE_TYPES.has(String(asset.content_type))
    || !Number.isInteger(Number(asset.file_size)) || Number(asset.file_size) <= 0 || response.storageKey !== storageKey
    || response.storageProvider !== asset.storage_provider || Number(response.fileSize) !== Number(asset.file_size)
    || response.contentType !== asset.content_type || meta.traceId !== context.validationKey || meta.modelId !== context.model.id) {
    imageValidationFailure("IMAGE_PUBLICATION_ASSET_MISMATCH", "原图片与当前账号资产归属不匹配");
  }
  const price = money(context.model.selling_price), cost = money(context.model.cost_price);
  if (price === null || cost === null || money(attempt.quoted_price_yuan) !== price || money(attempt.cost_price_yuan) !== cost
    || money(response.selectedCostPrice) !== cost || money(meta.quotedPriceYuan) !== price || money(meta.actualCostPriceYuan) !== cost
    || meta.billingReferenceId !== identity.billingKey) imageValidationFailure("IMAGE_PUBLICATION_BILLING_INCOMPLETE", "原图片缺少匹配的报价与成本证据");
  const [operationResult, ledgerResult, revenueResult] = await Promise.all([
    input.db.from("wallet_operations").select("id,user_id,wallet,operation_kind,idempotency_key,status,amount,delta").eq("user_id", context.userId).eq("idempotency_key", identity.billingKey).abortSignal(AbortSignal.timeout(10_000)),
    input.db.from("wallet_ledger_entries").select("id,operation_id,user_id,wallet,operation_kind,idempotency_key,delta").eq("user_id", context.userId).eq("idempotency_key", identity.billingKey).abortSignal(AbortSignal.timeout(10_000)),
    input.db.from("revenue_records").select("user_id,model_id,task_id,cost_price,selling_price,record_type,cash_charged,billing_exempt").eq("user_id", context.userId).eq("task_id", identity.billingKey).eq("record_type", "image").abortSignal(AbortSignal.timeout(10_000)),
  ]);
  if (operationResult.error || ledgerResult.error || revenueResult.error) imageValidationFailure("IMAGE_PUBLICATION_BILLING_UNAVAILABLE", "原图片账务证据暂不可读取", 503);
  const operations = Array.isArray(operationResult.data) ? operationResult.data.map(row) : [];
  const ledger = Array.isArray(ledgerResult.data) ? ledgerResult.data.map(row) : [];
  const revenues = Array.isArray(revenueResult.data) ? revenueResult.data.map(row) : [];
  const revenue = revenues[0];
  if (revenues.length !== 1 || !revenue || revenue.user_id !== context.userId || revenue.model_id !== context.model.id
    || revenue.task_id !== identity.billingKey || money(revenue.cost_price) !== cost || money(revenue.selling_price) !== price
    || money(revenue.cash_charged) !== price || revenue.billing_exempt === true) {
    imageValidationFailure("IMAGE_PUBLICATION_BILLING_INCOMPLETE", "原图片缺少匹配且唯一的收益账务记录");
  }
  if (price === 0) {
    if (meta.billingExempt !== "true" || meta.billingExemptionReason !== "zero_price" || meta.billingOperationId !== ""
      || operations.length !== 0 || ledger.length !== 0) imageValidationFailure("IMAGE_PUBLICATION_BILLING_INCOMPLETE", "零价验证任务出现不一致账务记录");
  } else {
    const operation = operations[0], entry = ledger[0];
    if (meta.billingExempt !== "false" || meta.billingExemptionReason !== "none" || operations.length !== 1 || ledger.length !== 1
      || !operation || !entry || !sameDatabaseIdentifier(meta.billingOperationId, operation.id) || operation.wallet !== "cash"
      || operation.operation_kind !== "cash_charge" || operation.status !== "completed" || money(operation.amount) !== price
      || Number(operation.delta) !== -price || !sameDatabaseIdentifier(entry.operation_id, operation.id) || entry.wallet !== "cash"
      || entry.operation_kind !== "cash_charge" || Number(entry.delta) !== -price) {
      imageValidationFailure("IMAGE_PUBLICATION_BILLING_INCOMPLETE", "验证任务尚无匹配的原子扣费与账本记录");
    }
  }
  let verified: VerifiedImage;
  try { verified = await (dependencies.verifyObject || verifyImagePublicationObject)(storageKey); }
  catch { imageValidationFailure("IMAGE_PUBLICATION_OBJECT_UNAVAILABLE", "原图片读取或解码未通过，请保留原证明重试发布", 503); }
  if (verified.size !== Number(asset.file_size) || verified.contentType !== asset.content_type || verified.width !== Number(response.width)
    || verified.height !== Number(response.height) || !/^[a-f0-9]{64}$/u.test(verified.sha256)) imageValidationFailure("IMAGE_PUBLICATION_OBJECT_MISMATCH", "原图片完整内容与资产记录不匹配", 503);
  const latest = await loadImageAdminValidationContext(input.db, input.modelId, input.authorization);
  authorizeImageValidationProof(latest, input.proof, input.authorization);
  let saved;
  try { saved = await input.db.rpc("publish_image_model_validation", {
    p_validation_id: context.validationId, p_user_id: context.userId, p_configuration_hash: context.configurationHash,
    p_model_snapshot_hash: context.modelSnapshotHash, p_expected_active: latest.model.is_active, p_expected_hidden: latest.model.is_hidden,
    p_asset_id: String(asset.id), p_verified_key: storageKey, p_verified_size: verified.size, p_verified_type: verified.contentType,
    p_evidence: { schema: "image_decoded_asset.v1", sha256: verified.sha256, width: verified.width, height: verified.height },
  }); } catch { imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN", "发布结果未知，请保留原证明读取，不要重新生成", 503); }
  if (saved.error) {
    if (saved.error.code === "40001") imageValidationFailure("IMAGE_VALIDATION_CONFIGURATION_CHANGED", "发布期间配置已修改，原证明不能发布当前配置");
    imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN", "发布结果未确认，请保留原证明读取", 503);
  }
  const receipt = row(saved.data);
  if (receipt.success !== true || typeof receipt.alreadyPublished !== "boolean" || receipt.validationId !== context.validationId
    || receipt.modelId !== context.model.id || receipt.imageRecordId !== identity.recordId || receipt.assetId !== asset.id) {
    imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN", "发布收据不完整，请保留原证明读取", 503);
  }
  return { success: true, alreadyPublished: receipt.alreadyPublished, modelId: context.model.id, imageRecordId: identity.recordId, assetId: String(asset.id) };
}
