import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { parseImageRequestRejectionReceipt, type ImageRequestRejection } from "@/lib/image-request-rejection";
import { assertImageDurableMetadata, isImageEphemeralReceipt, matchesImageEphemeralReceipt, type ImageEphemeralReceipt, type ImageTransientDelivery } from "@/lib/image-ephemeral-delivery";
import {
  assertImageProviderDispatchReceipt,
  assertImageProviderSubmissionReceipt,
  type ImageProviderDispatchReceipt,
  type ImageProviderSubmissionReceipt,
} from "@/lib/image-provider-request-audit";

export type { ImageRequestRejection } from "@/lib/image-request-rejection";

export const STRICT_GPT_IMAGE_PUBLIC_ID = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
export const STRICT_GPT_IMAGE_DATABASE_ID = "gpt-image-2-chA-1";

const STABLE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

export type ImageExactlyOnceRecord = {
  schemaVersion: "image_exactly_once.v1";
  recordId: string;
  userHash: string;
  clientIdempotencyKey: string;
  clientTraceId: string;
  payloadFingerprint: string;
  requestSnapshot?: Record<string, unknown>;
  providerDispatchReceipt?: ImageProviderDispatchReceipt;
  providerSubmissionReceipt?: ImageProviderSubmissionReceipt;
  state: "intent" | "completed" | "failed_unknown";
  response?: Record<string, unknown>;
  deliveryState?: "held" | "delivered";
  deliveryAssetId?: string;
  createdAt: string;
  updatedAt: string;
};

type ImageProviderResultMetadata = {
  schema: "image_provider_result.v1";
  mode: "local" | "workflow";
  selectedModelId: string;
  selectedCostPrice: number;
  provider: string;
  apiEndpoint: string;
  source: string;
};
export type ImageUrlProviderResult = ImageProviderResultMetadata & { kind?: "url"; rawUrl: string };
export type ImageInlineProviderResult = ImageProviderResultMetadata & { kind: "inline"; inlineDataUrl: string };
export type ImageProviderResult = ImageUrlProviderResult | ImageInlineProviderResult;

type ImageProviderCheckpoint = {
  schema: "image_provider_checkpoint.v1";
  providerResult: ImageUrlProviderResult;
  resultFingerprint: string;
  persistenceLease?: { owner: string; expiresAt: string };
};

const PERSISTENCE_LEASE_MS = 5 * 60 * 1000;
const IMAGE_RECORD_COLUMNS = "record_id,user_hash,client_idempotency_key,client_trace_id,payload_fingerprint,request_snapshot,provider_dispatch_receipt,provider_submission_receipt,state,response,delivery_state,delivery_asset_id,created_at,updated_at";

function providerResultFingerprint(result: ImageProviderResult) {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))));
}

function validProviderResult(value: unknown): value is ImageProviderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as ImageProviderResult;
  if (result.schema !== "image_provider_result.v1"
    || !["local", "workflow"].includes(result.mode)
    || typeof result.selectedModelId !== "string" || !result.selectedModelId
    || !Number.isFinite(result.selectedCostPrice) || result.selectedCostPrice < 0
    || typeof result.provider !== "string" || !result.provider
    || typeof result.apiEndpoint !== "string" || typeof result.source !== "string" || !result.source) return false;
  if (result.kind === "inline") return typeof result.inlineDataUrl === "string" && result.inlineDataUrl.startsWith("data:image/") && result.inlineDataUrl.length <= 42 * 1024 * 1024;
  if (result.kind && result.kind !== "url") return false;
  if (typeof result.rawUrl !== "string" || !result.rawUrl || result.rawUrl.length > 8192) return false;
  try {
    const url = new URL(result.rawUrl);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function providerCheckpoint(record: ImageExactlyOnceRecord): ImageProviderCheckpoint | null {
  const response = record.response as ImageProviderCheckpoint | undefined;
  return record.state === "intent" && response?.schema === "image_provider_checkpoint.v1"
    && validUrlProviderResult(response.providerResult)
    && response.resultFingerprint === providerResultFingerprint(response.providerResult) ? response : null;
}

function validUrlProviderResult(value: unknown): value is ImageUrlProviderResult {
  return validProviderResult(value) && value.kind !== "inline";
}

/** Status callers receive a boolean, never the private provider URL. */
export function hasImageProviderCheckpoint(record: ImageExactlyOnceRecord) {
  return providerCheckpoint(record) !== null;
}

/**
 * Exposes only lease timing, never the checkpoint's private provider URL.
 * A live persistence lease means another worker may still be saving the same
 * provider result, so the UI must not offer an immediate recovery click.
 */
export function getImageProviderCheckpointState(record: ImageExactlyOnceRecord, now = Date.now()) {
  const checkpoint = providerCheckpoint(record);
  if (!checkpoint) return { hasCheckpoint: false, persistenceInProgress: false, retryAfterMs: 0 };
  const expiresAt = checkpoint.persistenceLease?.expiresAt;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const retryAfterMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : 0;
  return {
    hasCheckpoint: true,
    persistenceInProgress: retryAfterMs > 0,
    retryAfterMs,
  };
}

function persistencePending(retryAfterMs = 0) {
  return new ImageExactlyOnceError(
    "IMAGE_RESULT_PERSISTENCE_PENDING",
    retryAfterMs > 0
      ? "上游图片结果已安全记录，系统仍在保存原结果；请稍后刷新，系统不会重新生图"
      : "上游图片结果已安全记录，系统将继续完成图片保存；不会再次调用生图模型",
    503,
    { retryAfterMs, canRecover: retryAfterMs <= 0 },
  );
}

export class ImageExactlyOnceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly recovery?: { retryAfterMs?: number; canRecover?: boolean; diagnosticCode?: string },
  ) {
    super(message);
    this.name = "ImageExactlyOnceError";
  }
}

/** A typed, definitive rejection; never construct this for a generic timeout, 5xx or an accepted task. */
export class ImageRequestRejectedError extends ImageExactlyOnceError {
  constructor(readonly rejection: ImageRequestRejection) {
    super(rejection.code, rejection.code === "IMAGE_PROVIDER_LINK_REQUIRED"
      ? "上游未返回可交付的图片链接；系统不会将内嵌图片另存为素材，预留费用将自动释放。"
      : rejection.code === "IMAGE_BILLING_RESERVATION_REJECTED"
      ? "本次图片预算预留未成功，未调用生成服务，也未扣费。请检查余额后重新提交。"
      : rejection.code === "IMAGE_PROVIDER_ADMISSION_BUSY"
        ? "上游生图通道当前并发已满，本次未调用供应商，预留费用将自动释放。"
        : rejection.code === "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE"
          ? "生图并发保护暂不可用，本次未调用供应商，预留费用将自动释放。"
      : rejection.code === "IMAGE_PLATFORM_REQUEST_INTERRUPTED"
        ? "本次图片任务中断且没有取得可交付结果，费用已自动退回。请重新提交一次。"
      : rejection.source === "input"
        ? "参考图未能安全读取，本次未提交生成。请重新上传或检查参考图后再试。"
      : rejection.code === "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH"
        ? `上游返回 ${rejection.actualDimensions || "未知尺寸"}，与所选 ${rejection.expectedAspectRatio || "画幅"} 不一致；结果未发放且未扣费，请重新生成`
      : rejection.code === "IMAGE_OUTPUT_RESOLUTION_MISMATCH"
        ? `上游返回 ${rejection.actualDimensions || "未知尺寸"}，未达到所选 ${rejection.expectedResolution || "分辨率"}${rejection.expectedDimensions ? `（目标 ${rejection.expectedDimensions}）` : ""}；结果未发放且未扣费，请重新生成`
      : rejection.code === "IMAGE_REFERENCE_REJECTED"
        ? "供应商明确拒绝了参考图，本次未生成图片。请检查参考图后重新提交。"
        : "供应商明确拒绝了本次生成请求。请检查输入或模型配置后重新提交。",
    rejection.code === "IMAGE_BILLING_RESERVATION_REJECTED" ? 402
      : rejection.code === "IMAGE_PROVIDER_ADMISSION_BUSY" ? 429
        : rejection.code === "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE" ? 503
          : rejection.source === "input" ? 400 : 502);
  }
}

/** The legacy SQL state remains compatible; only a bound receipt establishes rejection semantics. */
export function getImageRequestRejection(record: ImageExactlyOnceRecord): ImageRequestRejection | null {
  return record.state === "failed_unknown"
    ? parseImageRequestRejectionReceipt(record.response, record.payloadFingerprint)
    : null;
}

export type ImageRejectionBillingRelease = {
  schema: "image_billing_release.v1";
  state: "pending" | "confirmed";
  referenceId: string;
  amount: number;
  updatedAt: string;
};

function validBillingRelease(value: unknown): value is ImageRejectionBillingRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const release = value as Partial<ImageRejectionBillingRelease>;
  return release.schema === "image_billing_release.v1"
    && (release.state === "pending" || release.state === "confirmed")
    && typeof release.referenceId === "string" && /^image:[A-Za-z0-9:_-]{8,200}$/u.test(release.referenceId)
    && Number.isFinite(release.amount) && Number(release.amount) > 0
    && typeof release.updatedAt === "string" && Number.isFinite(Date.parse(release.updatedAt));
}

export function getImageRejectionBillingRelease(record: ImageExactlyOnceRecord): ImageRejectionBillingRelease | null {
  if (!getImageRequestRejection(record)) return null;
  const release = (record.response as { billingRelease?: unknown } | undefined)?.billingRelease;
  return validBillingRelease(release) ? release : null;
}

function rejectionReceipt(
  record: ImageExactlyOnceRecord,
  rejection: ImageRequestRejection,
  billingRelease?: ImageRejectionBillingRelease,
) {
  return {
    schema: "image_request_rejection.v1",
    payloadFingerprint: record.payloadFingerprint,
    ...rejection,
    ...(billingRelease ? { billingRelease } : {}),
  };
}

export interface ImageExactlyOnceStore {
  claim(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
    payloadFingerprint: string;
    requestSnapshot?: Record<string, unknown>;
  }): Promise<{ created: boolean; record: ImageExactlyOnceRecord }>;
  get(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
  }): Promise<ImageExactlyOnceRecord | null>;
  save(record: ImageExactlyOnceRecord): Promise<void>;
  claimProviderPersistence?(record: ImageExactlyOnceRecord, result: ImageUrlProviderResult, leaseOwner: string): Promise<ImageExactlyOnceRecord | null>;
  completeEphemeralDelivery?(record: ImageExactlyOnceRecord, userId: string, receipt: ImageEphemeralReceipt, billingReferenceId: string): Promise<ImageExactlyOnceRecord | null>;
  releaseProviderPersistence?(record: ImageExactlyOnceRecord, leaseOwner: string): Promise<ImageProviderPersistenceReleaseResult>;
  completeProviderPersistence?(record: ImageExactlyOnceRecord, response: Record<string, unknown>, leaseOwner: string): Promise<ImageExactlyOnceRecord | null>;
  recordProviderOutputRejection?(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, leaseOwner: string, billingRelease?: ImageRejectionBillingRelease): Promise<ImageExactlyOnceRecord | null>;
  recordRejection?(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, billingRelease?: ImageRejectionBillingRelease): Promise<ImageExactlyOnceRecord | null>;
  markRejectionBillingRelease?(record: ImageExactlyOnceRecord, billingRelease: ImageRejectionBillingRelease): Promise<ImageExactlyOnceRecord | null>;
  recordProviderDispatchReceipt?(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderDispatchReceipt): Promise<ImageExactlyOnceRecord | null>;
  recordProviderSubmissionReceipt?(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderSubmissionReceipt): Promise<ImageExactlyOnceRecord | null>;
}

export type ImageProviderPersistenceReleaseResult =
  | { kind: "released"; record: ImageExactlyOnceRecord }
  | { kind: "completed"; record: ImageExactlyOnceRecord }
  | { kind: "busy"; record: ImageExactlyOnceRecord; retryAfterMs: number }
  | { kind: "unconfirmed" };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateStrictImageClientKeys(clientIdempotencyKey: string, clientTraceId: string) {
  if (!STABLE_KEY_PATTERN.test(clientIdempotencyKey)) {
    throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_KEY_INVALID", "图片生成幂等键格式无效", 400);
  }
  if (!STABLE_KEY_PATTERN.test(clientTraceId)) {
    throw new ImageExactlyOnceError("IMAGE_TRACE_ID_INVALID", "图片生成追踪键格式无效", 400);
  }
}

export function strictImagePayloadFingerprint(payload: Record<string, unknown>) {
  return sha256(JSON.stringify(payload));
}

export function imageUpstreamAttemptLimit(strictSingleSubmit: boolean) {
  // 保留调用签名；所有模型均禁止在无法确认供应商受理状态时自动重发。
  void strictSingleSubmit;
  return 1;
}

export function restrictImageCandidatesForNoRetry<T>(candidates: T[], strictSingleSubmit: boolean) {
  // A timeout, 5xx or broken response after POST cannot prove that the first
  // relay rejected the job. Falling through to another configured channel can
  // create and charge a second image for one user action. Every surface now
  // dispatches exactly one candidate; a user may explicitly submit a fresh
  // request after a terminal rejection.
  void strictSingleSubmit;
  return candidates.slice(0, 1);
}

export class FileImageExactlyOnceStore implements ImageExactlyOnceStore {
  constructor(private readonly rootDir = path.join(resolveAppRuntimeDir(), "image-exactly-once")) {}

  private file(recordId: string) {
    return path.join(this.rootDir, `${recordId}.json`);
  }

  async claim(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
    payloadFingerprint: string;
    requestSnapshot?: Record<string, unknown>;
  }) {
    assertImageDurableMetadata(input.requestSnapshot);
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    await mkdir(this.rootDir, { recursive: true });
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    const now = new Date().toISOString();
    const record: ImageExactlyOnceRecord = {
      schemaVersion: "image_exactly_once.v1",
      recordId,
      userHash: sha256(input.userId),
      clientIdempotencyKey: input.clientIdempotencyKey,
      clientTraceId: input.clientTraceId,
      payloadFingerprint: input.payloadFingerprint,
      ...(input.requestSnapshot ? { requestSnapshot: structuredClone(input.requestSnapshot) } : {}),
      state: "intent",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await writeFile(this.file(recordId), JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      return { created: true, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(this.file(recordId), "utf8")) as ImageExactlyOnceRecord;
      if (existing.payloadFingerprint !== input.payloadFingerprint) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "同一图片生成幂等键已绑定不同请求内容", 409);
      }
      if (existing.clientTraceId !== input.clientTraceId) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_TRACE_CONFLICT", "同一图片生成幂等键必须复用原 clientTraceId", 409);
      }
      if (existing.requestSnapshot && input.requestSnapshot
        && JSON.stringify(existing.requestSnapshot) !== JSON.stringify(input.requestSnapshot)) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "同一图片生成幂等键已绑定不同请求快照", 409);
      }
      return { created: false, record: existing };
    }
  }

  async get(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
  }) {
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    try {
      const record = JSON.parse(await readFile(this.file(recordId), "utf8")) as ImageExactlyOnceRecord;
      if (record.userHash !== sha256(input.userId)) return null;
      if (record.clientTraceId !== input.clientTraceId) {
        throw new ImageExactlyOnceError(
          "IMAGE_IDEMPOTENCY_TRACE_CONFLICT",
          "同一图片生成幂等键必须复用原 clientTraceId",
          409,
        );
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(record: ImageExactlyOnceRecord) {
    assertImageDurableMetadata(record);
    const next = { ...record, updatedAt: new Date().toISOString() };
    const target = this.file(record.recordId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    Object.assign(record, next);
  }
}

type DatabaseImageExactlyOnceRow = {
  record_id?: string;
  user_hash?: string;
  client_idempotency_key?: string;
  client_trace_id?: string;
  payload_fingerprint?: string;
  request_snapshot?: Record<string, unknown> | null;
  provider_dispatch_receipt?: ImageProviderDispatchReceipt | null;
  provider_submission_receipt?: ImageProviderSubmissionReceipt | null;
  state?: ImageExactlyOnceRecord["state"];
  response?: Record<string, unknown> | null;
  delivery_state?: "held" | "delivered" | null;
  delivery_asset_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

function isImageExactlyOnceMigrationMissing(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  return /image_generation_requests|request_snapshot|claim_image_generation_request_v2|claim_image_generation_request|save_image_generation_request|finalize_image_generation_delivery|schema cache|does not exist|could not find/i.test(message);
}

function databaseImageExactlyOnceError(error: unknown): never {
  if (error instanceof ImageExactlyOnceError) throw error;
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  if (/IMAGE_IDEMPOTENCY_TRACE_CONFLICT/i.test(message)) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_TRACE_CONFLICT",
      "同一图片生成幂等键必须复用原 clientTraceId",
      409,
    );
  }
  if (/IMAGE_IDEMPOTENCY_(?:CONFLICT|RESULT_CONFLICT)/i.test(message)) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_CONFLICT",
      "同一图片生成幂等键已绑定不同请求或结果",
      409,
    );
  }
  if (/IMAGE_REQUEST_SNAPSHOT_INVALID/i.test(message)) {
    throw new ImageExactlyOnceError(
      "IMAGE_REQUEST_SNAPSHOT_INVALID",
      "生图请求快照与数据库契约不一致，本次未调用图片模型或扣费，请管理员完成迁移后重试",
      503,
    );
  }
  if (/IMAGE_REQUEST_SNAPSHOT_CONFLICT/i.test(message)) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_CONFLICT",
      "同一图片生成幂等键已绑定不同请求快照",
      409,
    );
  }
  if (/IMAGE_IDEMPOTENCY_UNKNOWN_TERMINAL/i.test(message)) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_FAIL_CLOSED",
      "暂未取得可确认的图片结果，原请求已保留。请稍后刷新状态。",
      409,
    );
  }
  if (isImageExactlyOnceMigrationMissing(error)) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY",
      "图片生成幂等迁移尚未部署，已停止生成以避免重复调用和重复扣费",
      503,
    );
  }
  throw new ImageExactlyOnceError(
    "IMAGE_IDEMPOTENCY_STORE_UNAVAILABLE",
    "图片生成幂等服务暂时不可用，已停止生成以避免重复调用和重复扣费",
    503,
  );
}

function databaseRowToRecord(row: DatabaseImageExactlyOnceRow): ImageExactlyOnceRecord {
  const state = row.state;
  if (
    !row.record_id
    || !row.user_hash
    || !row.client_idempotency_key
    || !row.client_trace_id
    || !row.payload_fingerprint
    || (state !== "intent" && state !== "completed" && state !== "failed_unknown")
    || !row.created_at
    || !row.updated_at
  ) {
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_RECORD_INVALID",
      "图片生成幂等记录无效，已停止继续调用",
      503,
    );
  }
  return {
    schemaVersion: "image_exactly_once.v1",
    recordId: row.record_id,
    userHash: row.user_hash,
    clientIdempotencyKey: row.client_idempotency_key,
    clientTraceId: row.client_trace_id,
    payloadFingerprint: row.payload_fingerprint,
    ...(row.request_snapshot && typeof row.request_snapshot === "object" ? { requestSnapshot: row.request_snapshot } : {}),
    ...(row.provider_dispatch_receipt && typeof row.provider_dispatch_receipt === "object"
      ? (assertImageProviderDispatchReceipt(row.provider_dispatch_receipt), { providerDispatchReceipt: row.provider_dispatch_receipt })
      : {}),
    ...(row.provider_submission_receipt && typeof row.provider_submission_receipt === "object"
      ? (assertImageProviderSubmissionReceipt(row.provider_submission_receipt), { providerSubmissionReceipt: row.provider_submission_receipt })
      : {}),
    state,
    ...(row.response && typeof row.response === "object" ? { response: row.response } : {}),
    ...(row.delivery_state === "held" || row.delivery_state === "delivered"
      ? { deliveryState: row.delivery_state }
      : {}),
    ...(row.delivery_asset_id ? { deliveryAssetId: row.delivery_asset_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Production store for provider-call idempotency.
 *
 * The claim is performed by one PostgreSQL RPC with a unique
 * (user_id, client_idempotency_key) constraint. An incomplete/unknown request
 * is intentionally not resubmitted: the caller must reconcile it manually.
 */
export class DatabaseImageExactlyOnceStore implements ImageExactlyOnceStore {
  async readProviderPersistenceBinding(input: {
    recordId: string; userId: string; payloadFingerprint: string; persistenceAttemptId: string; result: ImageUrlProviderResult;
  }) {
    const { data, error } = await getSupabaseAdminClient().from("image_generation_requests")
      .select(IMAGE_RECORD_COLUMNS).eq("record_id", input.recordId).eq("user_id", input.userId).eq("state", "intent").maybeSingle();
    if (error || !data) throw new ImageExactlyOnceError("IMAGE_H3_CHECKPOINT_BINDING_UNAVAILABLE", "原图片结果归属暂时无法确认，系统不会重新生成", 503);
    const record = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    const checkpoint = providerCheckpoint(record);
    if (record.recordId !== input.recordId || record.userHash !== sha256(input.userId)
      || record.payloadFingerprint !== input.payloadFingerprint || !checkpoint
      || checkpoint.persistenceLease?.owner !== input.persistenceAttemptId
      || Date.parse(checkpoint.persistenceLease.expiresAt) <= Date.now()
      || !Number.isFinite(Date.parse(checkpoint.persistenceLease.expiresAt))
      || providerResultFingerprint(checkpoint.providerResult) !== providerResultFingerprint(input.result)) {
      throw new ImageExactlyOnceError("IMAGE_H3_CHECKPOINT_BINDING_UNAVAILABLE", "原图片结果归属暂时无法确认，系统不会重新生成", 503);
    }
    return checkpoint.providerResult;
  }
  async completeEphemeralDelivery(record: ImageExactlyOnceRecord, userId: string, receipt: ImageEphemeralReceipt, billingReferenceId: string) {
    if (!isImageEphemeralReceipt(receipt) || receipt.recordId !== record.recordId) throw new ImageExactlyOnceError("IMAGE_EPHEMERAL_METADATA_INVALID", "临时图片收据无效，原请求保持锁定", 503);
    const { data, error } = await getSupabaseAdminClient().rpc("complete_image_ephemeral_delivery", {
      p_record_id: record.recordId, p_user_id: userId, p_client_trace_id: record.clientTraceId,
      p_payload_fingerprint: record.payloadFingerprint,
      p_dispatch_receipt_sha256: record.providerDispatchReceipt?.receiptSha256 || "",
      p_submission_receipt_sha256: record.providerSubmissionReceipt?.receiptSha256 || "",
      p_billing_reference_id: billingReferenceId, p_metadata: receipt,
    });
    if (error) databaseImageExactlyOnceError(error);
    const row = (data as { record?: DatabaseImageExactlyOnceRow } | null)?.record;
    return row ? databaseRowToRecord(row) : null;
  }
  async recordProviderDispatchReceipt(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderDispatchReceipt) {
    assertImageProviderDispatchReceipt(receipt);
    const { data, error } = await getSupabaseAdminClient().rpc("record_image_provider_dispatch_receipt_atomic", {
      p_record_id: record.recordId,
      p_user_id: userId,
      p_client_trace_id: record.clientTraceId,
      p_payload_fingerprint: record.payloadFingerprint,
      p_receipt: receipt,
    });
    if (error) databaseImageExactlyOnceError(error);
    const row = (data as { record?: DatabaseImageExactlyOnceRow } | null)?.record;
    if (!row) return null;
    const saved = databaseRowToRecord(row);
    if (saved.providerDispatchReceipt?.receiptSha256 !== receipt.receiptSha256) return null;
    Object.assign(record, saved);
    return saved;
  }

  async recordProviderSubmissionReceipt(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderSubmissionReceipt) {
    assertImageProviderSubmissionReceipt(receipt);
    const { data, error } = await getSupabaseAdminClient().rpc("record_image_provider_submission_receipt_atomic", {
      p_record_id: record.recordId,
      p_user_id: userId,
      p_client_trace_id: record.clientTraceId,
      p_payload_fingerprint: record.payloadFingerprint,
      p_dispatch_receipt_sha256: receipt.dispatchReceiptSha256,
      p_receipt: receipt,
    });
    if (error) databaseImageExactlyOnceError(error);
    const row = (data as { record?: DatabaseImageExactlyOnceRow } | null)?.record;
    if (!row) return null;
    const saved = databaseRowToRecord(row);
    if (saved.providerSubmissionReceipt?.receiptSha256 !== receipt.receiptSha256) return null;
    Object.assign(record, saved);
    return saved;
  }

  async reconcileStaleIntent(record: ImageExactlyOnceRecord, userId: string, staleAfterSeconds = 600) {
    const { data, error } = await getSupabaseAdminClient().rpc("reconcile_stale_image_generation_request_atomic", {
      p_record_id: record.recordId,
      p_user_id: userId,
      p_stale_after_seconds: staleAfterSeconds,
    });
    if (error) databaseImageExactlyOnceError(error);
    const result = data as { record?: DatabaseImageExactlyOnceRow } | null;
    if (!result?.record) return null;
    const reconciled = databaseRowToRecord(result.record);
    if (reconciled.recordId !== record.recordId
      || reconciled.userHash !== record.userHash
      || reconciled.payloadFingerprint !== record.payloadFingerprint) {
      throw new ImageExactlyOnceError(
        "IMAGE_STALE_RECONCILIATION_INVALID",
        "中断图片任务的核对结果无效，原请求继续保持锁定",
        503,
      );
    }
    return reconciled;
  }

  async recordRejection(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, billingRelease?: ImageRejectionBillingRelease) {
    if (record.state !== "intent" || record.response) return null;
    const response = rejectionReceipt(record, rejection, billingRelease);
    const { data, error } = await getSupabaseAdminClient().from("image_generation_requests")
      .update({ state: "failed_unknown", response, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "intent").is("response", null)
      .select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (error) databaseImageExactlyOnceError(error);
    if (!data) return null;
    const saved = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    const confirmed = getImageRequestRejection(saved);
    if (saved.recordId !== record.recordId || saved.userHash !== record.userHash || saved.payloadFingerprint !== record.payloadFingerprint
      || !confirmed || confirmed.code !== rejection.code || confirmed.source !== rejection.source || confirmed.upstreamStatus !== rejection.upstreamStatus) return null;
    return saved;
  }

  async markRejectionBillingRelease(record: ImageExactlyOnceRecord, billingRelease: ImageRejectionBillingRelease) {
    const rejection = getImageRequestRejection(record);
    const currentRelease = getImageRejectionBillingRelease(record);
    if (!rejection || !currentRelease || !validBillingRelease(billingRelease)
      || currentRelease.referenceId !== billingRelease.referenceId
      || Math.abs(currentRelease.amount - billingRelease.amount) > 0.000001) return null;
    const response = rejectionReceipt(record, rejection, billingRelease);
    let query = getSupabaseAdminClient().from("image_generation_requests")
      .update({ response, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "failed_unknown")
      .eq("response->>schema", "image_request_rejection.v1")
      .eq("response->>code", rejection.code);
    query = query.eq("response->billingRelease->>referenceId", currentRelease.referenceId)
      .eq("response->billingRelease->>state", currentRelease.state);
    const { data, error } = await query.select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (error) databaseImageExactlyOnceError(error);
    if (!data) return null;
    const saved = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    const confirmed = getImageRejectionBillingRelease(saved);
    return confirmed?.referenceId === billingRelease.referenceId && confirmed.state === billingRelease.state
      ? saved
      : null;
  }

  async claimProviderPersistence(record: ImageExactlyOnceRecord, result: ImageUrlProviderResult, leaseOwner: string) {
    assertImageDurableMetadata(result);
    if (!validUrlProviderResult(result)) throw new Error("IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN");
    const previous = providerCheckpoint(record);
    if (record.state !== "intent" || (record.response && !previous)) throw persistencePending();
    if (previous?.persistenceLease && Date.parse(previous.persistenceLease.expiresAt) > Date.now()) {
      throw persistencePending(getImageProviderCheckpointState(record).retryAfterMs);
    }
    const response: ImageProviderCheckpoint = {
      schema: "image_provider_checkpoint.v1", providerResult: previous?.providerResult || result,
      resultFingerprint: previous?.resultFingerprint || providerResultFingerprint(result),
      persistenceLease: { owner: leaseOwner, expiresAt: new Date(Date.now() + PERSISTENCE_LEASE_MS).toISOString() },
    };
    // The existing RPC deliberately makes completed results immutable. Keep the
    // private checkpoint in intent, using existing service_role table permission
    // and a compare-and-set. No provider call or download occurs in this method.
    const db = getSupabaseAdminClient();
    let query = db.from("image_generation_requests")
      .update({ response, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "intent");
    if (previous) {
      query = query.eq("response->>resultFingerprint", previous.resultFingerprint);
      query = previous.persistenceLease
        ? query.eq("response->persistenceLease->>owner", previous.persistenceLease.owner)
        : query.is("response->persistenceLease->>owner", null);
    } else query = query.is("response", null);
    const { data, error } = await query.select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (error) databaseImageExactlyOnceError(error);
    if (!data) {
      // A zero-row CAS can mean that another request acquired the lease or
      // completed the record between our read and update. Re-read the
      // authoritative row so callers never offer an unsafe immediate retry or
      // repeat the provider-side persistence work.
      const { data: currentData, error: currentError } = await db.from("image_generation_requests")
        .select(IMAGE_RECORD_COLUMNS)
        .eq("record_id", record.recordId)
        .eq("user_hash", record.userHash)
        .maybeSingle();
      if (currentError) databaseImageExactlyOnceError(currentError);
      if (!currentData) return null;
      const current = databaseRowToRecord(currentData as DatabaseImageExactlyOnceRow);
      if (current.payloadFingerprint !== record.payloadFingerprint) {
        throw new ImageExactlyOnceError("IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED", "上游结果记录尚未确认，已停止保存图片；请保留原请求号核查，勿重新生图", 503);
      }
      if (current.state === "completed" && current.response) return current;
      const currentCheckpoint = providerCheckpoint(current);
      if (currentCheckpoint?.resultFingerprint === response.resultFingerprint) {
        throw persistencePending(getImageProviderCheckpointState(current).retryAfterMs);
      }
      return null;
    }
    const saved = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    const checkpoint = providerCheckpoint(saved);
    if (saved.recordId !== record.recordId || saved.userHash !== record.userHash
      || saved.payloadFingerprint !== record.payloadFingerprint || !checkpoint
      || checkpoint.persistenceLease?.owner !== leaseOwner
      || checkpoint.resultFingerprint !== response.resultFingerprint) {
      throw new ImageExactlyOnceError("IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED", "上游结果记录尚未确认，已停止保存图片；请保留原请求号核查，勿重新生图", 503);
    }
    return saved;
  }

  async releaseProviderPersistence(record: ImageExactlyOnceRecord, leaseOwner: string) {
    const previous = providerCheckpoint(record);
    if (!previous || previous.persistenceLease?.owner !== leaseOwner) return { kind: "unconfirmed" as const };
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("image_generation_requests")
      .update({ response: { schema: previous.schema, providerResult: previous.providerResult, resultFingerprint: previous.resultFingerprint }, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "intent")
      .eq("response->>resultFingerprint", previous.resultFingerprint)
      .eq("response->persistenceLease->>owner", leaseOwner)
      .select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (data) {
      const released = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
      const checkpoint = providerCheckpoint(released);
      if (released.recordId === record.recordId && released.userHash === record.userHash
        && released.payloadFingerprint === record.payloadFingerprint && checkpoint
        && !checkpoint.persistenceLease && checkpoint.resultFingerprint === previous.resultFingerprint) {
        return { kind: "released" as const, record: released };
      }
    }

    // UPDATE may have committed while its acknowledgement was lost, or the
    // completion CAS may already have won. Read back the authoritative row
    // before declaring the lease busy; this prevents an unnecessary 5-minute
    // recovery lockout without ever clearing another worker's lease.
    const { data: currentData, error: currentError } = await db.from("image_generation_requests")
      .select(IMAGE_RECORD_COLUMNS)
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint)
      .maybeSingle();
    if (currentError) databaseImageExactlyOnceError(currentError);
    if (currentData) {
      const current = databaseRowToRecord(currentData as DatabaseImageExactlyOnceRow);
      if (current.state === "completed" && current.response) return { kind: "completed" as const, record: current };
      const checkpoint = providerCheckpoint(current);
      if (checkpoint?.resultFingerprint === previous.resultFingerprint) {
        if (!checkpoint.persistenceLease) return { kind: "released" as const, record: current };
        return {
          kind: "busy" as const,
          record: current,
          retryAfterMs: getImageProviderCheckpointState(current).retryAfterMs,
        };
      }
    }
    if (error) databaseImageExactlyOnceError(error);
    return { kind: "unconfirmed" as const };
  }

  async completeProviderPersistence(record: ImageExactlyOnceRecord, response: Record<string, unknown>, leaseOwner: string) {
    assertImageDurableMetadata(response);
    const checkpoint = providerCheckpoint(record);
    if (!checkpoint || checkpoint.persistenceLease?.owner !== leaseOwner) return null;
    const db = getSupabaseAdminClient();
    // Fence a late worker after lease takeover. The old save RPC cannot check
    // the lease; this conditional transition retains its completed immutability
    // and held delivery state without replacing the RPC or changing the schema.
    const { data, error } = await db.from("image_generation_requests")
      .update({ state: "completed", response, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "intent")
      .eq("response->>resultFingerprint", checkpoint.resultFingerprint)
      .eq("response->persistenceLease->>owner", leaseOwner)
      .select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (error) databaseImageExactlyOnceError(error);
    if (!data) return null;
    const completed = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    if (completed.state !== "completed" || !completed.response || completed.recordId !== record.recordId
      || completed.payloadFingerprint !== record.payloadFingerprint) throw persistencePending();
    return completed;
  }

  async recordProviderOutputRejection(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, leaseOwner: string, billingRelease?: ImageRejectionBillingRelease) {
    const checkpoint = providerCheckpoint(record);
    if (!checkpoint || checkpoint.persistenceLease?.owner !== leaseOwner || rejection.source !== "provider") return null;
    const response = rejectionReceipt(record, rejection, billingRelease);
    const { data, error } = await getSupabaseAdminClient().from("image_generation_requests")
      .update({ state: "failed_unknown", response, updated_at: new Date().toISOString() })
      .eq("record_id", record.recordId).eq("user_hash", record.userHash)
      .eq("payload_fingerprint", record.payloadFingerprint).eq("state", "intent")
      .eq("response->>resultFingerprint", checkpoint.resultFingerprint)
      .eq("response->persistenceLease->>owner", leaseOwner)
      .select(IMAGE_RECORD_COLUMNS).maybeSingle();
    if (error) databaseImageExactlyOnceError(error);
    if (!data) return null;
    const saved = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
    const confirmed = getImageRequestRejection(saved);
    return confirmed?.code === rejection.code ? saved : null;
  }

  async claim(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
    payloadFingerprint: string;
    requestSnapshot?: Record<string, unknown>;
  }) {
    assertImageDurableMetadata(input.requestSnapshot);
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("claim_image_generation_request_v2", {
        p_record_id: recordId,
        p_user_id: input.userId,
        p_user_hash: sha256(input.userId),
        p_client_idempotency_key: input.clientIdempotencyKey,
        p_client_trace_id: input.clientTraceId,
        p_payload_fingerprint: input.payloadFingerprint,
        p_request_snapshot: input.requestSnapshot || null,
      });
      if (error) databaseImageExactlyOnceError(error);
      const result = data as { created?: boolean; record?: DatabaseImageExactlyOnceRow } | null;
      if (typeof result?.created !== "boolean" || !result.record) {
        throw new ImageExactlyOnceError(
          "IMAGE_IDEMPOTENCY_CLAIM_INVALID",
          "图片生成幂等服务返回无效结果，已停止生成",
          503,
        );
      }
      return { created: result.created, record: databaseRowToRecord(result.record) };
    } catch (error) {
      databaseImageExactlyOnceError(error);
    }
  }

  async get(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
  }) {
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db
        .from("image_generation_requests")
        .select(IMAGE_RECORD_COLUMNS)
        .eq("record_id", recordId)
        .maybeSingle();
      if (error) databaseImageExactlyOnceError(error);
      if (!data) return null;
      const record = databaseRowToRecord(data as DatabaseImageExactlyOnceRow);
      if (record.userHash !== sha256(input.userId)) return null;
      if (record.clientTraceId !== input.clientTraceId) {
        throw new ImageExactlyOnceError(
          "IMAGE_IDEMPOTENCY_TRACE_CONFLICT",
          "同一图片生成幂等键必须复用原 clientTraceId",
          409,
        );
      }
      return record;
    } catch (error) {
      databaseImageExactlyOnceError(error);
    }
  }

  async save(record: ImageExactlyOnceRecord) {
    try {
      assertImageDurableMetadata(record);
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("save_image_generation_request", {
        p_record_id: record.recordId,
        p_payload_fingerprint: record.payloadFingerprint,
        p_state: record.state,
        p_response: record.response || null,
      });
      if (error) databaseImageExactlyOnceError(error);
      const saved = (data as { record?: DatabaseImageExactlyOnceRow } | null)?.record;
      if (!saved) {
        throw new ImageExactlyOnceError(
          "IMAGE_IDEMPOTENCY_SAVE_INVALID",
          "图片生成幂等结果未确认保存，已停止发放结果",
          503,
        );
      }
      Object.assign(record, databaseRowToRecord(saved));
    } catch (error) {
      databaseImageExactlyOnceError(error);
    }
  }
}

/** Billing-bound metadata delivery; intentionally creates no user_files row. */
export async function finalizeImageProviderDelivery(input: { recordId: string; userId: string; providerUrl: string }) {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("finalize_image_provider_delivery", {
      p_record_id: input.recordId, p_user_id: input.userId, p_provider_url: input.providerUrl,
    });
    if (error) databaseImageExactlyOnceError(error);
    if ((data as { deliveryState?: string } | null)?.deliveryState !== "delivered") {
      throw new ImageExactlyOnceError("IMAGE_DELIVERY_NOT_CONFIRMED", "图片交付尚未确认，请用原请求恢复", 503);
    }
    return { assetId: undefined, deliveryState: "delivered" as const };
  } catch (error) { databaseImageExactlyOnceError(error); }
}

export async function finalizeImageExactlyOnceDelivery(input: {
  recordId: string;
  userId: string;
  storageKey: string;
  storageProvider: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  source: string;
  meta: Record<string, string>;
}) {
  if (
    !input.recordId
    || !input.userId
    || !input.storageKey
    || !input.storageProvider
    || !input.fileName
    || !Number.isInteger(input.fileSize)
    || input.fileSize <= 0
    || !input.contentType.startsWith("image/")
  ) {
    throw new ImageExactlyOnceError(
      "IMAGE_DELIVERY_INPUT_INVALID",
      "图片交付信息不完整，已停止发放结果",
      503,
    );
  }
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("finalize_image_generation_delivery", {
      p_record_id: input.recordId,
      p_user_id: input.userId,
      p_storage_key: input.storageKey,
      p_storage_provider: input.storageProvider,
      p_file_name: input.fileName,
      p_file_size: input.fileSize,
      p_content_type: input.contentType,
      p_source: input.source,
      p_meta: input.meta,
    });
    if (error) databaseImageExactlyOnceError(error);
    const result = data as { deliveryAssetId?: string; deliveryState?: string } | null;
    if (!result?.deliveryAssetId || result.deliveryState !== "delivered") {
      throw new ImageExactlyOnceError(
        "IMAGE_DELIVERY_NOT_CONFIRMED",
        "图片资产归属未确认，已停止发放结果",
        503,
      );
    }
    return { assetId: result.deliveryAssetId, deliveryState: "delivered" as const };
  } catch (error) {
    databaseImageExactlyOnceError(error);
  }
}

export class MemoryImageExactlyOnceStore implements ImageExactlyOnceStore {
  async completeEphemeralDelivery(record: ImageExactlyOnceRecord, userId: string, receipt: ImageEphemeralReceipt, billingReferenceId: string) {
    const stored = this.records.get(record.recordId);
    if (!stored || stored.userHash !== sha256(userId) || stored.clientTraceId !== record.clientTraceId
      || stored.payloadFingerprint !== record.payloadFingerprint || !isImageEphemeralReceipt(receipt)
      || receipt.recordId !== record.recordId || !stored.providerDispatchReceipt || !stored.providerSubmissionReceipt
      || stored.providerSubmissionReceipt.dispatchReceiptSha256 !== stored.providerDispatchReceipt.receiptSha256) return null;
    if (stored.state === "completed") return matchesImageEphemeralReceipt(stored.response, receipt) ? structuredClone(stored) : null;
    if (stored.state !== "intent" || stored.response) return null;
    const next: ImageExactlyOnceRecord = { ...stored, state: "completed", deliveryState: "delivered", response: {
      ...receipt, billingReferenceId, cashCharged: Number(stored.requestSnapshot?.quotedPriceYuan || 0),
    }, updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    return structuredClone(next);
  }
  private readonly records = new Map<string, ImageExactlyOnceRecord>();

  async recordProviderDispatchReceipt(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderDispatchReceipt) {
    void userId;
    assertImageProviderDispatchReceipt(receipt);
    const stored = this.records.get(record.recordId);
    if (!stored || stored.state !== "intent" || stored.payloadFingerprint !== record.payloadFingerprint) return null;
    if (stored.providerDispatchReceipt) {
      return stored.providerDispatchReceipt.receiptSha256 === receipt.receiptSha256 ? structuredClone(stored) : null;
    }
    const next = { ...stored, providerDispatchReceipt: structuredClone(receipt), updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    Object.assign(record, next);
    return structuredClone(next);
  }

  async recordProviderSubmissionReceipt(record: ImageExactlyOnceRecord, userId: string, receipt: ImageProviderSubmissionReceipt) {
    void userId;
    assertImageProviderSubmissionReceipt(receipt);
    const stored = this.records.get(record.recordId);
    if (!stored || stored.state !== "intent" || stored.payloadFingerprint !== record.payloadFingerprint
      || stored.providerDispatchReceipt?.receiptSha256 !== receipt.dispatchReceiptSha256) return null;
    if (stored.providerSubmissionReceipt) {
      return stored.providerSubmissionReceipt.receiptSha256 === receipt.receiptSha256 ? structuredClone(stored) : null;
    }
    const next = { ...stored, providerSubmissionReceipt: structuredClone(receipt), updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    Object.assign(record, next);
    return structuredClone(next);
  }

  async recordRejection(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, billingRelease?: ImageRejectionBillingRelease) {
    const stored = this.records.get(record.recordId);
    if (!stored || stored.state !== "intent" || stored.response || stored.payloadFingerprint !== record.payloadFingerprint) return null;
    const next = { ...stored, state: "failed_unknown" as const, response: rejectionReceipt(record, rejection, billingRelease), updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    return structuredClone(next);
  }

  async markRejectionBillingRelease(record: ImageExactlyOnceRecord, billingRelease: ImageRejectionBillingRelease) {
    const stored = this.records.get(record.recordId);
    const rejection = stored && getImageRequestRejection(stored);
    const currentRelease = stored && getImageRejectionBillingRelease(stored);
    if (!stored || !rejection || !currentRelease || !validBillingRelease(billingRelease)
      || currentRelease.referenceId !== billingRelease.referenceId
      || Math.abs(currentRelease.amount - billingRelease.amount) > 0.000001) return null;
    const next = {
      ...stored,
      response: rejectionReceipt(stored, rejection, billingRelease),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(record.recordId, structuredClone(next));
    return structuredClone(next);
  }

  async claimProviderPersistence(record: ImageExactlyOnceRecord, result: ImageUrlProviderResult, leaseOwner: string) {
    assertImageDurableMetadata(result);
    if (!validUrlProviderResult(result)) throw new Error("IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN");
    const stored = this.records.get(record.recordId);
    if (!stored || stored.payloadFingerprint !== record.payloadFingerprint) return null;
    if (stored.state === "completed" && stored.response) return structuredClone(stored);
    if (stored.state !== "intent") return null;
    const previous = providerCheckpoint(stored);
    if (stored.response && !previous) return null;
    if (previous?.persistenceLease && Date.parse(previous.persistenceLease.expiresAt) > Date.now()) {
      throw persistencePending(getImageProviderCheckpointState(stored).retryAfterMs);
    }
    if (JSON.stringify(stored.response) !== JSON.stringify(record.response)) {
      if (previous?.resultFingerprint === providerResultFingerprint(result)) {
        throw persistencePending(getImageProviderCheckpointState(stored).retryAfterMs);
      }
      return null;
    }
    const next = { ...stored, response: {
      schema: "image_provider_checkpoint.v1", providerResult: previous?.providerResult || result,
      resultFingerprint: previous?.resultFingerprint || providerResultFingerprint(result),
      persistenceLease: { owner: leaseOwner, expiresAt: new Date(Date.now() + PERSISTENCE_LEASE_MS).toISOString() },
    }, updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    return structuredClone(next);
  }

  async releaseProviderPersistence(record: ImageExactlyOnceRecord, leaseOwner: string) {
    const stored = this.records.get(record.recordId);
    const checkpoint = stored && providerCheckpoint(stored);
    if (!stored) return { kind: "unconfirmed" as const };
    if (stored.state === "completed" && stored.response) return { kind: "completed" as const, record: structuredClone(stored) };
    if (!checkpoint) return { kind: "unconfirmed" as const };
    if (checkpoint.persistenceLease?.owner !== leaseOwner) {
      return { kind: "busy" as const, record: structuredClone(stored), retryAfterMs: getImageProviderCheckpointState(stored).retryAfterMs };
    }
    const released = { ...stored, response: {
      schema: checkpoint.schema, providerResult: checkpoint.providerResult, resultFingerprint: checkpoint.resultFingerprint,
    }, updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, released);
    return { kind: "released" as const, record: structuredClone(released) };
  }

  async completeProviderPersistence(record: ImageExactlyOnceRecord, response: Record<string, unknown>, leaseOwner: string) {
    assertImageDurableMetadata(response);
    const stored = this.records.get(record.recordId);
    const checkpoint = stored && providerCheckpoint(stored);
    if (!stored || !checkpoint || checkpoint.persistenceLease?.owner !== leaseOwner) return null;
    const completed = { ...stored, state: "completed" as const, response: structuredClone(response), updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, completed);
    return structuredClone(completed);
  }

  async recordProviderOutputRejection(record: ImageExactlyOnceRecord, rejection: ImageRequestRejection, leaseOwner: string, billingRelease?: ImageRejectionBillingRelease) {
    const stored = this.records.get(record.recordId);
    const checkpoint = stored && providerCheckpoint(stored);
    if (!stored || !checkpoint || checkpoint.persistenceLease?.owner !== leaseOwner || rejection.source !== "provider") return null;
    const rejected = {
      ...stored,
      state: "failed_unknown" as const,
      response: rejectionReceipt(stored, rejection, billingRelease),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(record.recordId, structuredClone(rejected));
    return structuredClone(rejected);
  }

  async claim(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
    payloadFingerprint: string;
    requestSnapshot?: Record<string, unknown>;
  }) {
    assertImageDurableMetadata(input.requestSnapshot);
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    const existing = this.records.get(recordId);
    if (existing) {
      if (existing.payloadFingerprint !== input.payloadFingerprint) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "同一图片生成幂等键已绑定不同请求内容", 409);
      }
      if (existing.clientTraceId !== input.clientTraceId) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_TRACE_CONFLICT", "同一图片生成幂等键必须复用原 clientTraceId", 409);
      }
      if (existing.requestSnapshot && input.requestSnapshot
        && JSON.stringify(existing.requestSnapshot) !== JSON.stringify(input.requestSnapshot)) {
        throw new ImageExactlyOnceError("IMAGE_IDEMPOTENCY_CONFLICT", "同一图片生成幂等键已绑定不同请求快照", 409);
      }
      return { created: false, record: structuredClone(existing) };
    }
    const now = new Date().toISOString();
    const record: ImageExactlyOnceRecord = {
      schemaVersion: "image_exactly_once.v1",
      recordId,
      userHash: sha256(input.userId),
      clientIdempotencyKey: input.clientIdempotencyKey,
      clientTraceId: input.clientTraceId,
      payloadFingerprint: input.payloadFingerprint,
      ...(input.requestSnapshot ? { requestSnapshot: structuredClone(input.requestSnapshot) } : {}),
      state: "intent",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(recordId, structuredClone(record));
    return { created: true, record };
  }

  async get(input: {
    userId: string;
    clientIdempotencyKey: string;
    clientTraceId: string;
  }) {
    validateStrictImageClientKeys(input.clientIdempotencyKey, input.clientTraceId);
    const recordId = sha256(`${input.userId}\u0000${input.clientIdempotencyKey}`);
    const record = this.records.get(recordId);
    if (!record) return null;
    if (record.clientTraceId !== input.clientTraceId) {
      throw new ImageExactlyOnceError(
        "IMAGE_IDEMPOTENCY_TRACE_CONFLICT",
        "同一图片生成幂等键必须复用原 clientTraceId",
        409,
      );
    }
    return structuredClone(record);
  }

  async save(record: ImageExactlyOnceRecord) {
    assertImageDurableMetadata(record);
    const next = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(record.recordId, structuredClone(next));
    Object.assign(record, next);
  }
}

export async function runImageExactlyOnce(options: {
  store: ImageExactlyOnceStore;
  userId: string;
  clientIdempotencyKey: string;
  clientTraceId: string;
  payloadFingerprint: string;
  requestSnapshot?: Record<string, unknown>;
  rejectionBilling?: { referenceId: string; amount: number };
  /**
   * Runs only for the request that created the durable intent, after the
   * intent is stored and before any provider-capable callback. Use this for
   * an atomic wallet reservation: concurrent/replayed callers never execute
   * the hook and therefore cannot reserve or submit a second time.
   */
  beforeSubmitOnce?: (record: ImageExactlyOnceRecord) => Promise<void>;
  submitOnce: (receiptContext: {
    recordProviderDispatchReceipt: (receipt: ImageProviderDispatchReceipt) => Promise<ImageProviderDispatchReceipt>;
    recordProviderSubmissionReceipt: (receipt: ImageProviderSubmissionReceipt) => Promise<ImageProviderSubmissionReceipt>;
  }) => Promise<Record<string, unknown>>;
  persistProviderResult?: (result: ImageUrlProviderResult, context: { persistenceAttemptId: string; recordId: string; payloadFingerprint: string }) => Promise<Record<string, unknown>>;
  prepareEphemeralResult?: (result: ImageInlineProviderResult, recordId: string) => Promise<{ receipt: ImageEphemeralReceipt; transientDelivery: ImageTransientDelivery }>;
  billingReferenceId?: string;
}) {
  assertImageDurableMetadata(options.requestSnapshot);
  if (options.prepareEphemeralResult && (!options.store.completeEphemeralDelivery || !options.billingReferenceId)) {
    throw new ImageExactlyOnceError("IMAGE_EPHEMERAL_STORE_REQUIRED", "临时图片交付尚未就绪，本次不会调用模型或扣费", 503);
  }
  if (options.persistProviderResult && (!options.store.claimProviderPersistence || !options.store.releaseProviderPersistence || !options.store.completeProviderPersistence)) {
    throw new ImageExactlyOnceError("IMAGE_CHECKPOINT_STORE_REQUIRED", "图片结果恢复存储尚未就绪，本次不会调用模型", 503);
  }
  const claimed = await options.store.claim(options);

  const receiptContext = {
    recordProviderDispatchReceipt: async (receipt: ImageProviderDispatchReceipt) => {
      if (!options.store.recordProviderDispatchReceipt) {
        throw new ImageExactlyOnceError("IMAGE_PROVIDER_RECEIPT_STORE_REQUIRED", "供应商派发回执存储尚未就绪，本次不会调用图片模型", 503);
      }
      const saved = await options.store.recordProviderDispatchReceipt(claimed.record, options.userId, receipt);
      if (!saved?.providerDispatchReceipt || saved.providerDispatchReceipt.receiptSha256 !== receipt.receiptSha256) {
        throw new ImageExactlyOnceError("IMAGE_PROVIDER_DISPATCH_RECEIPT_UNCONFIRMED", "供应商派发回执未确认，本次不会调用图片模型", 503);
      }
      Object.assign(claimed.record, saved);
      return saved.providerDispatchReceipt;
    },
    recordProviderSubmissionReceipt: async (receipt: ImageProviderSubmissionReceipt) => {
      if (!options.store.recordProviderSubmissionReceipt) {
        throw new ImageExactlyOnceError("IMAGE_PROVIDER_RECEIPT_STORE_REQUIRED", "供应商响应回执存储尚未就绪，原请求保持锁定", 503);
      }
      const saved = await options.store.recordProviderSubmissionReceipt(claimed.record, options.userId, receipt);
      if (!saved?.providerSubmissionReceipt || saved.providerSubmissionReceipt.receiptSha256 !== receipt.receiptSha256) {
        throw new ImageExactlyOnceError("IMAGE_PROVIDER_SUBMISSION_RECEIPT_UNCONFIRMED", "供应商响应回执未确认，原请求保持锁定且不会自动重提", 503);
      }
      Object.assign(claimed.record, saved);
      return saved.providerSubmissionReceipt;
    },
  };

  const pendingBillingRelease = (error: ImageRequestRejectedError): ImageRejectionBillingRelease | undefined => {
    if (!options.rejectionBilling || error.rejection.code === "IMAGE_BILLING_RESERVATION_REJECTED") return undefined;
    return {
      schema: "image_billing_release.v1",
      state: "pending",
      referenceId: options.rejectionBilling.referenceId,
      amount: options.rejectionBilling.amount,
      updatedAt: new Date().toISOString(),
    };
  };

  let ephemeralFinalizationAttempted = false;
  async function preserveFailure(error: unknown): Promise<never> {
    if (ephemeralFinalizationAttempted) throw error; // Never overwrite a possibly committed atomic completion.
    if (error instanceof ImageRequestRejectedError) {
      let saved: ImageExactlyOnceRecord | null = null;
      try { saved = await options.store.recordRejection?.(claimed.record, error.rejection, pendingBillingRelease(error)) || null; } catch { /* The write acknowledgement may have been lost. */ }
      if (!saved || !getImageRequestRejection(saved)) {
        // Never clear a possibly committed receipt/checkpoint through the old save RPC.
        throw new ImageExactlyOnceError("IMAGE_REJECTION_RECEIPT_UNCONFIRMED", "拒绝状态尚未安全记录，请保留原请求号查询，勿重新提交生成", 503);
      }
      Object.assign(claimed.record, saved);
      throw error;
    }
    claimed.record.state = "failed_unknown";
    await options.store.save(claimed.record).catch(() => undefined);
    throw error;
  }

  async function persistCheckpoint(result: ImageUrlProviderResult, replayed: boolean) {
    const leaseOwner = randomUUID();
    let acquired: ImageExactlyOnceRecord | null;
    try {
      acquired = await options.store.claimProviderPersistence!(claimed.record, result, leaseOwner);
    } catch (error) {
      if (error instanceof ImageExactlyOnceError && error.code === "IMAGE_RESULT_PERSISTENCE_PENDING") throw error;
      // The write may have committed despite a lost acknowledgement. Never
      // clear/overwrite its checkpoint, download an unconfirmed result or resubmit.
      throw new ImageExactlyOnceError("IMAGE_PROVIDER_CHECKPOINT_NOT_CONFIRMED", "上游结果记录尚未确认，已停止保存图片；请保留原请求号核查，勿重新生图", 503);
    }
    if (!acquired) throw persistencePending(getImageProviderCheckpointState(claimed.record).retryAfterMs);
    if (acquired.state === "completed" && acquired.response) {
      return { response: acquired.response, replayed: true, record: acquired };
    }
    const acquiredCheckpoint = providerCheckpoint(acquired);
    if (!acquiredCheckpoint || acquiredCheckpoint.persistenceLease?.owner !== leaseOwner) {
      throw persistencePending(getImageProviderCheckpointState(acquired).retryAfterMs);
    }
    try {
      const response = await options.persistProviderResult!(acquiredCheckpoint.providerResult, {
        persistenceAttemptId: leaseOwner, recordId: acquired.recordId, payloadFingerprint: acquired.payloadFingerprint,
      });
      const completed = await options.store.completeProviderPersistence!(acquired, response, leaseOwner);
      if (!completed) throw persistencePending();
      return { response: completed.response!, replayed, record: completed };
    } catch (error) {
      if (error instanceof ImageRequestRejectedError && error.rejection.source === "provider") {
        let rejected: ImageExactlyOnceRecord | null = null;
        try {
          rejected = await options.store.recordProviderOutputRejection?.(acquired, error.rejection, leaseOwner, pendingBillingRelease(error)) || null;
        } catch { /* A lost acknowledgement must remain fail-closed. */ }
        if (rejected && getImageRequestRejection(rejected)) {
          Object.assign(claimed.record, rejected);
          throw error;
        }
      }
      // Only release our lease, never the provider checkpoint. A completed RPC
      // acknowledgement loss also leaves the committed stable result untouched.
      const release = await options.store.releaseProviderPersistence!(acquired, leaseOwner)
        .catch(() => ({ kind: "unconfirmed" as const }));
      if (release.kind === "completed") {
        return { response: release.record.response!, replayed, record: release.record };
      }
      if (release.kind === "released") throw persistencePending(0);
      if (release.kind === "busy") throw persistencePending(release.retryAfterMs);
      throw persistencePending(getImageProviderCheckpointState(acquired).retryAfterMs);
    }
  }

  if (!claimed.created) {
    const rejection = getImageRequestRejection(claimed.record);
    if (rejection) throw new ImageRequestRejectedError(rejection);
    if (claimed.record.state === "completed" && claimed.record.response) {
      return { response: claimed.record.response, replayed: true, record: claimed.record };
    }
    const checkpoint = providerCheckpoint(claimed.record);
    if (checkpoint && options.persistProviderResult) return persistCheckpoint(checkpoint.providerResult, true);
    throw new ImageExactlyOnceError(
      "IMAGE_IDEMPOTENCY_FAIL_CLOSED",
      "暂未取得可确认的图片结果，原请求已保留。请稍后刷新状态。",
      409,
    );
  }

  if (options.persistProviderResult || options.prepareEphemeralResult) {
    let result: Record<string, unknown>;
    try {
      await options.beforeSubmitOnce?.(claimed.record);
      result = await options.submitOnce(receiptContext);
      if (!validProviderResult(result)) throw new ImageExactlyOnceError("IMAGE_PROVIDER_RESULT_INVALID", "上游未返回可保存的明确图片结果，请保留请求号核查", 503);
      if (result.kind === "inline") {
        if (!options.prepareEphemeralResult) throw new ImageExactlyOnceError("IMAGE_EPHEMERAL_STORE_REQUIRED", "临时图片交付尚未就绪，原请求保持锁定", 503);
        const prepared = await options.prepareEphemeralResult(result, claimed.record.recordId);
        if (!isImageEphemeralReceipt(prepared.receipt) || prepared.receipt.recordId !== claimed.record.recordId
          || prepared.transientDelivery.sha256 !== prepared.receipt.sha256 || prepared.transientDelivery.byteLength !== prepared.receipt.byteLength) {
          throw new ImageExactlyOnceError("IMAGE_EPHEMERAL_METADATA_INVALID", "临时图片收据校验失败，原请求保持锁定", 503);
        }
        let completed: ImageExactlyOnceRecord | null = null;
        ephemeralFinalizationAttempted = true;
        try { completed = await options.store.completeEphemeralDelivery!(claimed.record, options.userId, prepared.receipt, options.billingReferenceId!); }
        catch { /* A lost write ACK is confirmed only by the same owner's durable row. */ }
        if (!completed) completed = await options.store.get(options).catch(() => null);
        if (!completed || completed.state !== "completed" || completed.deliveryState !== "delivered"
          || completed.recordId !== claimed.record.recordId || completed.userHash !== claimed.record.userHash
          || completed.payloadFingerprint !== claimed.record.payloadFingerprint || completed.clientTraceId !== claimed.record.clientTraceId
          || !matchesImageEphemeralReceipt(completed.response, prepared.receipt)
          || completed.response?.billingReferenceId !== options.billingReferenceId
          || completed.response?.cashCharged !== Number(options.requestSnapshot?.quotedPriceYuan)) {
          throw new ImageExactlyOnceError("IMAGE_EPHEMERAL_COMPLETION_UNCONFIRMED", "图片临时交付状态待确认，请保留请求号查询，系统不会重新生成", 503, { canRecover: false });
        }
        return { response: completed.response!, transientDelivery: prepared.transientDelivery, replayed: false, record: completed };
      }
    } catch (error) {
      return preserveFailure(error);
    }
    if (!options.persistProviderResult) throw new ImageExactlyOnceError("IMAGE_CHECKPOINT_STORE_REQUIRED", "图片链接交付未配置，原请求保持锁定", 503);
    assertImageDurableMetadata(result);
    return persistCheckpoint(result, false);
  }

  try {
    await options.beforeSubmitOnce?.(claimed.record);
    const response = await options.submitOnce(receiptContext);
    assertImageDurableMetadata(response);
    claimed.record.response = response;
    claimed.record.state = "completed";
    await options.store.save(claimed.record);
    return { response, replayed: false, record: claimed.record };
  } catch (error) {
    return preserveFailure(error);
  }
}
