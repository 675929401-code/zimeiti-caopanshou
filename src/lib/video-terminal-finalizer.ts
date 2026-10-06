import "server-only";

import { createHash } from "node:crypto";
import { executeCashDeduction } from "@/lib/billing-executor";
import { toPublicModelId } from "@/lib/public-model-dto";
import { recordRevenue } from "@/lib/revenue";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";
import { resolveVideoCharge, type VideoModelCapabilitySource } from "@/lib/video-model-capabilities";
import { trustedVideoProviderResultHostname } from "@/lib/video-provider-result-url";
import { recordVideoTerminalOutcome } from "@/lib/video-terminal-accounting";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const PERSISTENT_VIDEO_URI_PATTERN = /^object:\/\/tencent_cos\/[^?#]+$/u;

function isUpstreamVideoUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isVideoDeliveryUri(value: string) {
  return PERSISTENT_VIDEO_URI_PATTERN.test(value) || isUpstreamVideoUrl(value);
}
const terminalGlobal = globalThis as typeof globalThis & { __videoTerminalLocks?: Map<string, Promise<VideoTerminalOutcome>> };
const terminalLocks = terminalGlobal.__videoTerminalLocks ?? (terminalGlobal.__videoTerminalLocks = new Map<string, Promise<VideoTerminalOutcome>>());

type JsonObject = Record<string, unknown>;

export class VideoTerminalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 503,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "VideoTerminalError";
  }
}

export type VideoPriceSnapshot = {
  priceYuan: number;
  costPriceYuan: number;
  billingUnit: "per_use" | "output_second";
  billingQuantity: number;
  resolution: string;
  explicitlyFree: boolean;
};

export type VideoTaskReservation = {
  taskIdInternal: string;
  created: boolean;
  status: string;
  billingState: string;
  providerTaskId: string;
};

export type VideoTerminalOutcome = {
  state: "completed" | "finalizing" | "billing_pending";
  code?: "BILLING_DEDUCTION_FAILED" | "VIDEO_ASSET_PERSISTENCE_FAILED" | "VIDEO_FINALIZATION_FAILED";
  taskIdInternal: string;
  providerTaskId: string;
  playbackUrl?: string;
  stableStorageUrl?: string;
  priceCharged: number;
  billingState: string;
  message?: string;
  newlyCompleted?: boolean;
};

type ReserveVideoTaskInput = {
  taskIdInternal: string;
  userId: string;
  modelId: string;
  clientRequestId: string;
  requestFingerprint: string;
  price: VideoPriceSnapshot;
  billingExempt: boolean;
  providerTaskId?: string;
  dispatch?: import("@/lib/digital-video-dispatch").DigitalDispatchInput;
  task: {
    taskLabel?: unknown;
    batchId?: unknown;
    batchTopic?: unknown;
    cardIndex?: unknown;
    prompt: string;
    firstFrameUrl?: unknown;
    lastFrameUrl?: unknown;
    referenceImageUrl?: unknown;
    aspectRatio: string;
    resolution?: string;
    durationSeconds: number;
    contentUrl?: unknown;
  };
};

type FinalizeVideoInput = {
  taskIdInternal: string;
  userId: string;
  userRole: "admin" | "student";
  providerTaskId?: string;
  providerVideoUrl?: string;
  responseMs?: number;
};

async function ensureVideoRevenue(input: {
  userId: string;
  userRole: "admin" | "student";
  modelId: string;
  taskId: string;
  costPrice: number;
  sellingPrice: number;
  cashCharged: number;
  billingExempt: boolean;
}) {
  try {
    await recordRevenue({
      userId: input.userId,
      userRole: input.userRole,
      modelId: input.modelId,
      taskId: input.taskId,
      costPrice: input.costPrice,
      sellingPrice: input.sellingPrice,
      recordType: "video",
      cashCharged: input.cashCharged,
      billingExempt: input.billingExempt,
    });
  } catch {
    throw new VideoTerminalError(
      "VIDEO_REVENUE_PENDING",
      "视频资产与钱包终态已确认，但收益流水尚未确认；请刷新原任务，系统不会重复扣费",
      503,
      true,
    );
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function finiteMoney(value: unknown, decimals: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  const factor = 10 ** decimals;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseRpcObject(value: unknown): JsonObject {
  if (Array.isArray(value)) return asObject(value[0]);
  return asObject(value);
}

function rpcErrorCode(error: unknown) {
  const object = asObject(error);
  return `${String(object.message || "")} ${String(object.details || "")} ${String(object.hint || "")}`;
}

export function normalizeVideoClientRequestId(value: unknown) {
  const normalized = String(value || "").trim();
  if (!CLIENT_REQUEST_ID_PATTERN.test(normalized)) {
    throw new VideoTerminalError(
      "VIDEO_CLIENT_REQUEST_ID_REQUIRED",
      "收费视频任务缺少稳定的客户端请求编号，请新建任务后重试",
      400,
      false,
    );
  }
  return normalized;
}

export function buildVideoTaskIdentity(userId: string, clientRequestId: string) {
  const digest = createHash("sha256")
    .update(`video-task:v1:${userId}:${clientRequestId}`)
    .digest("hex");
  return {
    taskIdInternal: `vt_${digest.slice(0, 40)}`,
    providerIdempotencyKey: `video-submit:${digest}`,
    billingIdempotencyKey: `video-terminal:${digest}`,
  };
}

export function buildVideoRequestFingerprint(payload: JsonObject) {
  return createHash("sha256")
    .update(`video-request:v1:${stableJson(payload)}`)
    .digest("hex");
}

export function isExplicitlyFreeVideoModel(model: VideoModelCapabilitySource) {
  const protocol = asObject(model.api_protocol_config);
  return protocol.explicitly_free === true || String(protocol.billing_mode || "").trim().toLowerCase() === "free";
}

export function requireVideoPriceSnapshot(
  model: VideoModelCapabilitySource,
  resolution: unknown,
  durationSeconds: unknown,
): VideoPriceSnapshot {
  const resolved = resolveVideoCharge(model, resolution, durationSeconds);
  const explicitlyFree = isExplicitlyFreeVideoModel(model);
  const priceYuan = finiteMoney(resolved.publicPrice, 2);
  const costPriceYuan = finiteMoney(resolved.costPrice, 4);
  if (!Number.isFinite(priceYuan) || priceYuan < 0 || (!explicitlyFree && priceYuan <= 0)) {
    throw new VideoTerminalError(
      "VIDEO_PRICE_CONFIGURATION_INVALID",
      "当前视频模型没有可结算的有效单价，任务未提交，请联系管理员配置成本价和销售价",
      503,
      false,
    );
  }
  if (!Number.isFinite(costPriceYuan) || costPriceYuan < 0) {
    throw new VideoTerminalError(
      "VIDEO_COST_CONFIGURATION_INVALID",
      "当前视频模型成本价配置无效，任务未提交",
      503,
      false,
    );
  }
  return {
    priceYuan: explicitlyFree ? 0 : priceYuan,
    costPriceYuan,
    billingUnit: resolved.billingUnit,
    billingQuantity: resolved.billingQuantity,
    resolution: resolved.resolution,
    explicitlyFree,
  };
}

export async function reserveVideoGenerationTask(input: ReserveVideoTaskInput): Promise<VideoTaskReservation> {
  const db = getSupabaseAdminClient();
  const reservationParams = {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_model_id: input.modelId,
    p_client_request_id: input.clientRequestId,
    p_request_fingerprint: input.requestFingerprint,
    p_billing_price_yuan: input.price.priceYuan,
    p_billing_cost_price_yuan: input.price.costPriceYuan,
    p_billing_unit: input.price.billingUnit,
    p_billing_quantity: input.price.billingQuantity,
    p_explicitly_free: input.price.explicitlyFree,
    p_billing_exempt: input.billingExempt,
    p_provider_task_id: input.providerTaskId || null,
    p_task_label: typeof input.task.taskLabel === "string" ? input.task.taskLabel : null,
    p_batch_id: typeof input.task.batchId === "string" ? input.task.batchId : null,
    p_batch_topic: typeof input.task.batchTopic === "string" ? input.task.batchTopic : null,
    p_card_index: Number.isInteger(Number(input.task.cardIndex)) ? Number(input.task.cardIndex) : null,
    p_prompt: input.task.prompt,
    p_first_frame_url: typeof input.task.firstFrameUrl === "string" ? input.task.firstFrameUrl : null,
    p_last_frame_url: typeof input.task.lastFrameUrl === "string" ? input.task.lastFrameUrl : null,
    p_reference_image_url: typeof input.task.referenceImageUrl === "string" ? input.task.referenceImageUrl : null,
    p_aspect_ratio: input.task.aspectRatio,
    p_resolution: input.task.resolution || null,
    p_duration_seconds: input.task.durationSeconds,
    p_content_url: typeof input.task.contentUrl === "string" ? input.task.contentUrl : null,
  };
  const { data, error } = input.dispatch
    ? await db.rpc("reserve_queued_digital_video_task", { p_task: reservationParams, p_dispatch: input.dispatch })
    : await db.rpc("reserve_video_generation_task_atomic", reservationParams);
  if (error) {
    const detail = rpcErrorCode(error);
    if (detail.includes("DIGITAL_HUMAN_ACCOUNT_BUSY")) {
      throw new VideoTerminalError("DIGITAL_HUMAN_ACCOUNT_BUSY", "当前账号已有数字人任务正在处理，请在作品与任务中查看，完成后再提交", 429, false);
    }
    if (detail.includes("VIDEO_REQUEST_IDEMPOTENCY_CONFLICT")) {
      throw new VideoTerminalError(
        "VIDEO_REQUEST_IDEMPOTENCY_CONFLICT",
        "该请求编号已经绑定到不同的视频参数，请新建任务后重试",
        409,
        false,
      );
    }
    throw new VideoTerminalError(
      detail.includes("Could not find the function") || detail.includes("schema cache")
        ? "VIDEO_TERMINAL_MIGRATION_NOT_READY"
        : "VIDEO_TASK_RESERVATION_FAILED",
      "视频任务幂等登记暂时不可用，本次未提交供应商",
      503,
      true,
    );
  }
  const result = parseRpcObject(data);
  const taskIdInternal = String(result.task_id || input.taskIdInternal);
  if (taskIdInternal !== input.taskIdInternal) {
    throw new VideoTerminalError("VIDEO_TASK_RESERVATION_MISMATCH", "视频任务登记结果不一致，本次未提交供应商", 503, false);
  }
  return {
    taskIdInternal,
    created: result.created === true,
    status: String(result.status || "submitting"),
    billingState: String(result.billing_state || "pending"),
    providerTaskId: String(result.provider_task_id || ""),
  };
}

export async function bindVideoProviderTask(input: {
  taskIdInternal: string;
  userId: string;
  requestFingerprint: string;
  providerTaskId: string;
  contentUrl?: string;
}) {
  if (!input.providerTaskId.trim()) {
    throw new VideoTerminalError("VIDEO_PROVIDER_TASK_ID_MISSING", "供应商未返回任务编号，任务无法安全追踪", 502, false);
  }
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc("bind_video_provider_task_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_request_fingerprint: input.requestFingerprint,
    p_provider_task_id: input.providerTaskId,
    p_content_url: input.contentUrl || null,
  });
  if (error) {
    const detail = rpcErrorCode(error);
    throw new VideoTerminalError(
      detail.includes("VIDEO_PROVIDER_TASK_CONFLICT")
        ? "VIDEO_PROVIDER_TASK_CONFLICT"
        : "VIDEO_PROVIDER_TASK_BIND_FAILED",
      "供应商任务已接收，但本地幂等绑定失败；请保留原任务编号并联系管理员，勿重复提交",
      detail.includes("CONFLICT") ? 409 : 503,
      false,
    );
  }
  return parseRpcObject(data);
}

export async function markVideoSubmissionFailed(input: {
  taskIdInternal: string;
  userId: string;
  requestFingerprint: string;
  errorCode: string;
  errorMessage: string;
}) {
  const db = getSupabaseAdminClient();
  const { error } = await db.rpc("fail_video_generation_submission_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_request_fingerprint: input.requestFingerprint,
    p_error_code: input.errorCode,
    p_error_message: input.errorMessage,
  });
  if (error) console.error("[VideoTerminal] Failed to persist provider submission failure", error);
}

export async function finalizeVideoGenerationFailure(input: {
  taskIdInternal: string;
  userId: string;
  providerTaskId: string;
  errorCode: string;
  errorMessage: string;
}) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc("finalize_video_generation_failure_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_provider_task_id: input.providerTaskId,
    p_error_code: input.errorCode,
    p_error_message: input.errorMessage,
  });
  if (error) {
    const detail = rpcErrorCode(error);
    if (detail.includes("VIDEO_FAILED_TASK_BILLING_RECONCILIATION_REQUIRED")) {
      throw new VideoTerminalError(
        "VIDEO_FAILED_TASK_BILLING_RECONCILIATION_REQUIRED",
        "视频生成失败，系统正在自动核对原任务账本；请稍后刷新，勿重复提交",
        503,
        true,
      );
    }
    if (detail.includes("VIDEO_PROVIDER_TASK_CONFLICT")) {
      throw new VideoTerminalError("VIDEO_PROVIDER_TASK_CONFLICT", "视频任务编号校验失败，系统已停止结算", 409, false);
    }
    throw new VideoTerminalError(
      "VIDEO_FAILURE_FINALIZATION_FAILED",
      "视频生成失败，系统暂时无法写入失败终态；请稍后刷新，勿重复提交",
      503,
      true,
    );
  }
  const result = parseRpcObject(data);
  if (String(result.status || "") !== "failed" || String(result.billing_state || "") !== "failed") {
    throw new VideoTerminalError("VIDEO_FAILURE_FINALIZATION_INCOMPLETE", "视频失败终态尚未完成，请稍后刷新", 503, true);
  }
  return {
    taskIdInternal: String(result.task_id || input.taskIdInternal),
    billingState: "failed",
    priceCharged: 0,
    alreadyFailed: result.already_failed === true,
  };
}

async function attestLegacyH3Settlement(input: {
  taskIdInternal: string;
  userId: string;
  modelId: string;
  stableStorageUrl: string;
  priceYuan: number;
}) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("autodl_h3_settlements")
    .select("video_task_internal_id,user_id,model_id,stable_asset_url,price_yuan,charged_yuan")
    .eq("video_task_internal_id", input.taskIdInternal)
    .eq("user_id", input.userId)
    .eq("model_id", input.modelId)
    .eq("stable_asset_url", input.stableStorageUrl)
    .limit(1);
  if (error) return null;
  const row = asObject(data?.[0]);
  if (!row.video_task_internal_id) return null;
  const charged = finiteMoney(row.charged_yuan, 2);
  const price = finiteMoney(row.price_yuan, 2);
  if (price !== input.priceYuan || charged !== input.priceYuan) return null;
  return row;
}

async function finalizeVideoGenerationSuccessUnlocked(input: FinalizeVideoInput): Promise<VideoTerminalOutcome> {
  const db = getSupabaseAdminClient();
  const { data: taskData, error: taskError } = await db
    .from("video_tasks")
    .select("id,user_id,model_id,task_id_external,status,video_url,storage_url,provider_result_url,billing_price_yuan,billing_cost_price_yuan,billing_state,billing_operation_id,billing_idempotency_key,request_fingerprint,explicitly_free,billing_exempt,duration_seconds,resolution,price_charged")
    .eq("id", input.taskIdInternal)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (taskError || !taskData) {
    throw new VideoTerminalError("VIDEO_TASK_NOT_FOUND", "视频任务不存在或无权访问", 404, false);
  }
  const task = asObject(taskData);
  const modelId = String(task.model_id || "");
  // The provider task ID bound to our task is the authoritative identity.
  // A caller-supplied value is only a compatibility fallback before a binding exists.
  const providerTaskId = String(task.task_id_external || input.providerTaskId || "");
  const priceYuan = finiteMoney(task.billing_price_yuan, 2);
  const costPriceYuan = finiteMoney(task.billing_cost_price_yuan, 4);
  const explicitlyFree = task.explicitly_free === true;
  const billingExempt = task.billing_exempt === true;
  if (!Number.isFinite(priceYuan) || priceYuan < 0 || (!explicitlyFree && !billingExempt && priceYuan <= 0)) {
    throw new VideoTerminalError("VIDEO_PRICE_SNAPSHOT_INVALID", "视频任务缺少有效且不可变的计费快照，禁止交付", 503, false);
  }
  if (!Number.isFinite(costPriceYuan) || costPriceYuan < 0) {
    throw new VideoTerminalError("VIDEO_COST_SNAPSHOT_INVALID", "视频任务成本快照无效，禁止交付", 503, false);
  }

  if (task.status === "completed") {
    const stableStorageUrl = String(task.storage_url || task.provider_result_url || task.video_url || "");
    if (!isVideoDeliveryUri(stableStorageUrl)) throw new VideoTerminalError("VIDEO_DELIVERY_SOURCE_REQUIRED", "视频播放源尚未就绪", 503, true);
    const { data, error } = await db.rpc("finalize_video_generation_task_atomic", {
      p_task_id: input.taskIdInternal, p_user_id: input.userId,
      p_provider_task_id: providerTaskId || null, p_stable_storage_url: stableStorageUrl,
      p_billing_operation_id: task.billing_operation_id || null,
      p_legacy_h3_settled: task.billing_state === "legacy_h3_settled",
    });
    const completed = parseRpcObject(data);
    if (error || completed.already_completed !== true) throw new VideoTerminalError("VIDEO_FINALIZATION_INCOMPLETE", "无法确认原视频的完成状态", 503, true);
    const chargedYuan = finiteMoney(completed.price_charged, 2);
    await ensureVideoRevenue({
      userId: input.userId,
      userRole: input.userRole,
      modelId,
      taskId: input.taskIdInternal,
      costPrice: costPriceYuan,
      sellingPrice: priceYuan,
      cashCharged: chargedYuan,
      billingExempt,
    });
    return {
      state: "completed", taskIdInternal: input.taskIdInternal, providerTaskId, stableStorageUrl,
      playbackUrl: await createVideoAccessUrl({ taskId: input.taskIdInternal, userId: input.userId, role: input.userRole, scope: "playback" }),
      priceCharged: chargedYuan, billingState: String(completed.billing_state || task.billing_state), newlyCompleted: false,
    };
  }
  if (["failed", "cancelled", "expired"].includes(String(task.status))) {
    throw new VideoTerminalError("VIDEO_TASK_TERMINAL_CONFLICT", "视频任务已有终态，请刷新历史记录", 409, false);
  }

  const { data: modelData, error: modelError } = await db
    .from("video_models")
    .select("id,name,model_name,protocol_type,api_endpoint,api_key,duration_seconds,max_duration,api_protocol_config")
    .eq("id", modelId)
    .maybeSingle();
  if (modelError || !modelData) {
    throw new VideoTerminalError("VIDEO_MODEL_NOT_FOUND", "视频模型配置不存在，禁止交付", 503, false);
  }
  const model = asObject(modelData);
  let stableStorageUrl = String(task.storage_url || "");
  const providerResultUrl = String(input.providerVideoUrl || task.provider_result_url || task.video_url || "").trim();
  // Ordinary video history is retained for three days. Deliver the provider's
  // own media URL immediately through our authenticated proxy instead of
  // downloading and re-uploading the complete file to Tencent COS first.
  // Existing object:// rows remain replayable, but new results do not create a
  // second platform-owned copy.
  if (!PERSISTENT_VIDEO_URI_PATTERN.test(stableStorageUrl)) stableStorageUrl = providerResultUrl;
  if (providerResultUrl && !PERSISTENT_VIDEO_URI_PATTERN.test(stableStorageUrl)) {
    try {
      trustedVideoProviderResultHostname(providerResultUrl, {
        protocolType: model.protocol_type,
        apiProtocolConfig: model.api_protocol_config,
        apiEndpoint: model.api_endpoint,
      });
    } catch {
      throw new VideoTerminalError(
        "VIDEO_PROVIDER_RESULT_URL_FORBIDDEN",
        "供应商返回的视频地址未通过当前渠道安全校验",
        502,
        true,
      );
    }
  }
  if (!isVideoDeliveryUri(stableStorageUrl)) {
    throw new VideoTerminalError("VIDEO_DELIVERY_SOURCE_REQUIRED", "供应商未返回可播放的视频地址", 503, true);
  }
  const usesPersistentCopy = PERSISTENT_VIDEO_URI_PATTERN.test(stableStorageUrl);

  const { data: persistedState, error: persistedError } = await db.from("video_tasks").update({
    status: "finalizing",
    storage_url: usesPersistentCopy ? stableStorageUrl : null,
    video_url: stableStorageUrl,
    provider_result_url: providerResultUrl || null,
    billing_state: billingExempt || explicitlyFree ? "not_required" : "billing_pending",
    error_message: billingExempt || explicitlyFree ? "上游视频已就绪，正在确认交付" : "上游视频已就绪，正在完成原子扣费",
    completed_at: null,
    price_charged: 0,
  }).eq("id", input.taskIdInternal).eq("user_id", input.userId)
    .not("status", "in", "(completed,failed,cancelled,expired)")
    .select("id,status").maybeSingle();
  if (persistedError || !persistedState) {
    throw new VideoTerminalError("VIDEO_DELIVERY_STATE_PERSIST_FAILED", "视频播放源状态无法确认，禁止扣费和交付", 503, true);
  }

  let billingOperationId = "";
  let legacyH3Settled = false;
  if (!billingExempt && !explicitlyFree && priceYuan > 0) {
    const legacySettlement = usesPersistentCopy ? await attestLegacyH3Settlement({
      taskIdInternal: input.taskIdInternal,
      userId: input.userId,
      modelId,
      stableStorageUrl,
      priceYuan,
    }) : null;
    if (legacySettlement) {
      legacyH3Settled = true;
    } else {
      const billingIdempotencyKey = String(task.billing_idempotency_key || "").trim();
      if (!billingIdempotencyKey) {
        throw new VideoTerminalError("VIDEO_BILLING_IDEMPOTENCY_KEY_MISSING", "视频任务缺少稳定计费编号，禁止交付", 503, false);
      }
      const billing = await executeCashDeduction({
        userId: input.userId,
        amount: priceYuan,
        idempotencyKey: billingIdempotencyKey,
        modelName: String(model.name || modelId),
        description: `视频生成: ${String(model.name || modelId)}`,
        phase: "video_terminal",
        publicModelId: toPublicModelId("video", modelId),
        priceSnapshot: {
          price_yuan: priceYuan,
          cost_price_yuan: costPriceYuan,
          requested_public_model_id: toPublicModelId("video", modelId),
          resolution: task.resolution || null,
          duration_seconds: task.duration_seconds || null,
          request_fingerprint: task.request_fingerprint || null,
        },
        metadata: {
          video_task_id: input.taskIdInternal,
          provider_task_id: providerTaskId || null,
          delivery_mode: usesPersistentCopy ? "persistent_object" : "provider_proxy",
        },
      });
      if (!billing.success || !billing.operationId) {
        await db.from("video_tasks").update({
          status: "finalizing",
          billing_state: "failed",
          error_message: `BILLING_DEDUCTION_FAILED: ${billing.error || "原子钱包结算未成功"}`,
          completed_at: null,
          price_charged: 0,
        }).eq("id", input.taskIdInternal).eq("user_id", input.userId).not("status", "in", "(completed,failed,cancelled,expired)");
        return {
          state: "billing_pending",
          code: "BILLING_DEDUCTION_FAILED",
          taskIdInternal: input.taskIdInternal,
          providerTaskId,
          stableStorageUrl,
          priceCharged: 0,
          billingState: "failed",
          message: "视频已生成并永久保存，但原子钱包扣费未成功；结果暂不交付，请补充余额后重试查询",
        };
      }
      billingOperationId = billing.operationId;
    }
  }

  const { data: finalizeData, error: finalizeError } = await db.rpc("finalize_video_generation_task_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_provider_task_id: providerTaskId || null,
    p_stable_storage_url: stableStorageUrl,
    p_billing_operation_id: billingOperationId || null,
    p_legacy_h3_settled: legacyH3Settled,
  });
  if (finalizeError) {
    await db.from("video_tasks").update({
      status: "finalizing",
      billing_state: billingOperationId || legacyH3Settled ? "settled_pending_commit" : "not_required",
      error_message: `VIDEO_FINALIZATION_FAILED: ${rpcErrorCode(finalizeError).slice(0, 500)}`,
      completed_at: null,
    }).eq("id", input.taskIdInternal).eq("user_id", input.userId).not("status", "in", "(completed,failed,cancelled,expired)");
    return {
      state: "billing_pending",
      code: "VIDEO_FINALIZATION_FAILED",
      taskIdInternal: input.taskIdInternal,
      providerTaskId,
      stableStorageUrl,
      priceCharged: 0,
      billingState: billingOperationId || legacyH3Settled ? "settled_pending_commit" : "not_required",
      message: "视频资产和结算已确认，但交付事务尚未完成；请重试查询，系统不会重复扣费",
    };
  }
  const finalized = parseRpcObject(finalizeData);
  if (String(finalized.status || "") !== "completed") {
    throw new VideoTerminalError("VIDEO_FINALIZATION_INCOMPLETE", "视频终态事务未返回完成状态，禁止交付", 503, true);
  }
  const chargedYuan = finiteMoney(finalized.price_charged, 2);
  const newlyCompleted = finalized.already_completed !== true;
  const playbackUrl = await createVideoAccessUrl({
    taskId: input.taskIdInternal,
    userId: input.userId,
    role: input.userRole,
    scope: "playback",
  });
  if (newlyCompleted) {
    await recordVideoTerminalOutcome({
      modelId,
      outcome: "success",
      responseMs: Math.max(0, Number(input.responseMs) || 0),
    }).catch((error) => console.warn("[VideoTerminal] Failed to record terminal accounting", error));
  }
  await ensureVideoRevenue({
    userId: input.userId,
    userRole: input.userRole,
    modelId,
    taskId: input.taskIdInternal,
    costPrice: costPriceYuan,
    sellingPrice: priceYuan,
    cashCharged: chargedYuan,
    billingExempt,
  });
  return {
    state: "completed",
    taskIdInternal: input.taskIdInternal,
    providerTaskId,
    playbackUrl,
    stableStorageUrl,
    priceCharged: Number.isFinite(chargedYuan) ? chargedYuan : 0,
    billingState: String(finalized.billing_state || (billingExempt || explicitlyFree ? "not_required" : "settled")),
    newlyCompleted,
  };
}

export function finalizeVideoGenerationSuccess(input: FinalizeVideoInput): Promise<VideoTerminalOutcome> {
  const key = `${input.userId}:${input.taskIdInternal}`;
  const existing = terminalLocks.get(key);
  if (existing) return existing;
  const pending = finalizeVideoGenerationSuccessUnlocked(input).finally(() => {
    if (terminalLocks.get(key) === pending) terminalLocks.delete(key);
  });
  terminalLocks.set(key, pending);
  return pending;
}

export function videoTerminalErrorResponse(error: unknown) {
  if (error instanceof VideoTerminalError) {
    return {
      status: error.httpStatus,
      body: {
        error: error.message,
        error_code: error.code,
        retryable: error.retryable,
        task_submitted: false,
      },
    };
  }
  return null;
}
