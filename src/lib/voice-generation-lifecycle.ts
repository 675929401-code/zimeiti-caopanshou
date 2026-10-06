import "server-only";

import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export type VoiceGenerationPhase = "seed-audio" | "mix" | "dual" | "tts";
export type VoiceGenerationState =
  | "submitting"
  | "completed"
  | "refunded"
  | "failed_unknown"
  | "recovery_required";

type JsonObject = Record<string, unknown>;

type VoiceGenerationRow = {
  request_id?: string;
  user_id?: string;
  client_request_id?: string;
  phase?: VoiceGenerationPhase;
  payload_fingerprint?: string;
  model_id?: string;
  billing_idempotency_key?: string;
  quoted_credits?: number | string;
  charge_credits?: number | string;
  refunded_credits?: number | string;
  billing_exempt?: boolean;
  state?: VoiceGenerationState;
  wallet_operation_id?: number | string | null;
  refund_scopes?: JsonObject | null;
  asset_id?: string | null;
  generation_id?: string | null;
  provider_task_id?: string | null;
  response?: JsonObject | null;
  error?: JsonObject | null;
  price_snapshot?: JsonObject | null;
  metadata?: JsonObject | null;
  started_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  refunded_at?: string | null;
};

export type VoiceGenerationRecord = {
  requestId: string;
  userId: string;
  clientRequestId: string;
  phase: VoiceGenerationPhase;
  payloadFingerprint: string;
  modelId: string;
  billingIdempotencyKey: string;
  quotedCredits: number;
  chargeCredits: number;
  refundedCredits: number;
  billingExempt: boolean;
  state: VoiceGenerationState;
  walletOperationId: string | null;
  refundScopes: JsonObject;
  assetId: string | null;
  generationId: string | null;
  providerTaskId: string | null;
  response: JsonObject | null;
  error: JsonObject | null;
  priceSnapshot: JsonObject;
  metadata: JsonObject;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  refundedAt: string | null;
};

export class VoiceGenerationLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VoiceGenerationLifecycleError";
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function rowToRecord(row: VoiceGenerationRow): VoiceGenerationRecord {
  if (
    !row.request_id
    || !row.user_id
    || !row.client_request_id
    || !row.phase
    || !row.payload_fingerprint
    || !row.model_id
    || !row.billing_idempotency_key
    || !row.state
    || !row.started_at
    || !row.updated_at
  ) {
    throw new VoiceGenerationLifecycleError(
      "VOICE_LIFECYCLE_RECORD_INVALID",
      "语音任务记录不完整，已停止继续调用以避免重复扣费",
      503,
    );
  }
  return {
    requestId: row.request_id,
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    phase: row.phase,
    payloadFingerprint: row.payload_fingerprint,
    modelId: row.model_id,
    billingIdempotencyKey: row.billing_idempotency_key,
    quotedCredits: asNumber(row.quoted_credits),
    chargeCredits: asNumber(row.charge_credits),
    refundedCredits: asNumber(row.refunded_credits),
    billingExempt: row.billing_exempt === true,
    state: row.state,
    walletOperationId: row.wallet_operation_id == null ? null : String(row.wallet_operation_id),
    refundScopes: asObject(row.refund_scopes),
    assetId: row.asset_id || null,
    generationId: row.generation_id || null,
    providerTaskId: row.provider_task_id || null,
    response: row.response ? asObject(row.response) : null,
    error: row.error ? asObject(row.error) : null,
    priceSnapshot: asObject(row.price_snapshot),
    metadata: asObject(row.metadata),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    refundedAt: row.refunded_at || null,
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return String(error || "");
}

function throwLifecycleError(error: unknown): never {
  if (error instanceof VoiceGenerationLifecycleError) throw error;
  const message = errorMessage(error);
  if (/INSUFFICIENT_CREDITS/u.test(message)) {
    throw new VoiceGenerationLifecycleError("INSUFFICIENT_CREDITS", "积分余额不足", 402);
  }
  if (/VOICE_LIFECYCLE_(?:IDEMPOTENCY|RESULT|REFUND)_CONFLICT/u.test(message)) {
    throw new VoiceGenerationLifecycleError(
      "VOICE_LIFECYCLE_IDEMPOTENCY_CONFLICT",
      "同一语音请求标识已绑定不同内容或结果，已禁止重复提交",
      409,
    );
  }
  if (/VOICE_LIFECYCLE_REQUEST_(?:TERMINAL|NOT_FOUND)/u.test(message)) {
    const notFound = /NOT_FOUND/u.test(message);
    throw new VoiceGenerationLifecycleError(
      notFound ? "VOICE_LIFECYCLE_REQUEST_NOT_FOUND" : "VOICE_LIFECYCLE_REQUEST_TERMINAL",
      notFound ? "未找到语音任务" : "语音任务已进入终态，不能再次提交",
      notFound ? 404 : 409,
    );
  }
  if (/VOICE_LIFECYCLE_(?:REFUND_EXCEEDS_CHARGE|TERMINAL_REFUND_INCOMPLETE|INPUT_INVALID|PRICE_INVALID|EXEMPTION_INVALID|METADATA_INVALID|FINALIZE_INVALID|REFUND_INVALID)/u.test(message)) {
    throw new VoiceGenerationLifecycleError(
      "VOICE_LIFECYCLE_INPUT_INVALID",
      "语音任务状态或计费参数无效，已停止处理",
      409,
    );
  }
  if (
    /voice_generation_requests|begin_voice_generation_atomic|finalize_voice_generation_atomic|refund_voice_generation_atomic|PGRST20[245]|42P01|42883|schema cache|does not exist|could not find/i.test(message)
  ) {
    throw new VoiceGenerationLifecycleError(
      "VOICE_LIFECYCLE_MIGRATION_NOT_READY",
      "语音任务原子计费迁移尚未部署，已停止生成以避免重复扣费",
      503,
    );
  }
  throw new VoiceGenerationLifecycleError(
    "VOICE_LIFECYCLE_UNAVAILABLE",
    "语音任务服务暂时不可用，已停止生成以避免重复扣费",
    503,
  );
}

export async function beginVoiceGenerationAtomic(input: {
  requestId: string;
  userId: string;
  clientRequestId: string;
  phase: VoiceGenerationPhase;
  payloadFingerprint: string;
  modelId: string;
  billingIdempotencyKey: string;
  quotedCredits: number;
  chargeCredits: number;
  billingExempt: boolean;
  priceSnapshot?: JsonObject;
  metadata?: JsonObject;
}) {
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("begin_voice_generation_atomic", {
      p_request_id: input.requestId,
      p_user_id: input.userId,
      p_client_request_id: input.clientRequestId,
      p_phase: input.phase,
      p_payload_fingerprint: input.payloadFingerprint,
      p_model_id: input.modelId,
      p_billing_idempotency_key: input.billingIdempotencyKey,
      p_quoted_credits: input.quotedCredits,
      p_charge_credits: input.chargeCredits,
      p_billing_exempt: input.billingExempt,
      p_price_snapshot: input.priceSnapshot || {},
      p_metadata: input.metadata || {},
    });
    if (error) throwLifecycleError(error);
    const result = asObject(data);
    const row = asObject(result.request) as VoiceGenerationRow;
    const record = rowToRecord(row);
    return {
      created: result.created === true,
      alreadyFulfilled: result.already_fulfilled === true,
      code: typeof result.code === "string" ? result.code : null,
      success: result.success === true,
      state: record.state,
      record,
      response: result.response ? asObject(result.response) : record.response,
      wallet: result.wallet ? asObject(result.wallet) : null,
    };
  } catch (error) {
    throwLifecycleError(error);
  }
}

export async function finalizeVoiceGenerationAtomic(input: {
  requestId: string;
  userId: string;
  payloadFingerprint: string;
  assetId: string;
  generationId: string;
  providerTaskId: string;
  response: JsonObject;
  metadata?: JsonObject;
}) {
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("finalize_voice_generation_atomic", {
      p_request_id: input.requestId,
      p_user_id: input.userId,
      p_payload_fingerprint: input.payloadFingerprint,
      p_asset_id: input.assetId,
      p_generation_id: input.generationId,
      p_provider_task_id: input.providerTaskId,
      p_response: input.response,
      p_metadata: input.metadata || {},
    });
    if (error) throwLifecycleError(error);
    const result = asObject(data);
    const record = rowToRecord(asObject(result.request) as VoiceGenerationRow);
    if (result.success !== true || record.state !== "completed" || !record.response) {
      throw new VoiceGenerationLifecycleError(
        "VOICE_LIFECYCLE_FINALIZE_UNCONFIRMED",
        "语音任务成功状态未确认，已停止发放结果",
        503,
      );
    }
    return { alreadyFulfilled: result.already_fulfilled === true, record, response: record.response };
  } catch (error) {
    throwLifecycleError(error);
  }
}

export async function refundVoiceGenerationAtomic(input: {
  requestId: string;
  userId: string;
  payloadFingerprint: string;
  refundCredits: number;
  refundScope: string;
  refundIdempotencyKey: string;
  reason: string;
  error?: JsonObject;
  terminal?: boolean;
}) {
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc("refund_voice_generation_atomic", {
      p_request_id: input.requestId,
      p_user_id: input.userId,
      p_payload_fingerprint: input.payloadFingerprint,
      p_refund_credits: input.refundCredits,
      p_refund_scope: input.refundScope,
      p_refund_idempotency_key: input.refundIdempotencyKey,
      p_reason: input.reason,
      p_error: input.error || {},
      p_terminal: input.terminal !== false,
    });
    if (error) throwLifecycleError(error);
    const result = asObject(data);
    const record = rowToRecord(asObject(result.request) as VoiceGenerationRow);
    if (result.success !== true) {
      throw new VoiceGenerationLifecycleError(
        "VOICE_LIFECYCLE_REFUND_UNCONFIRMED",
        "语音任务退款状态未确认",
        503,
      );
    }
    return { alreadyFulfilled: result.already_fulfilled === true, record };
  } catch (error) {
    throwLifecycleError(error);
  }
}

export async function getVoiceGenerationStatus(input: {
  userId: string;
  requestId?: string;
  clientRequestId?: string;
  phase?: VoiceGenerationPhase;
}) {
  try {
    const db = getSupabaseAdminClient();
    let query = db
      .from("voice_generation_requests")
      .select("request_id,user_id,client_request_id,phase,payload_fingerprint,model_id,billing_idempotency_key,quoted_credits,charge_credits,refunded_credits,billing_exempt,state,wallet_operation_id,refund_scopes,asset_id,generation_id,provider_task_id,response,error,price_snapshot,metadata,started_at,updated_at,completed_at,refunded_at")
      .eq("user_id", input.userId);
    if (input.requestId) {
      query = query.eq("request_id", input.requestId);
    } else if (input.clientRequestId && input.phase) {
      query = query.eq("client_request_id", input.clientRequestId).eq("phase", input.phase);
    } else {
      throw new VoiceGenerationLifecycleError(
        "VOICE_LIFECYCLE_STATUS_INPUT_INVALID",
        "查询语音任务需要 requestId，或 clientRequestId 与 phase",
        400,
      );
    }
    const { data, error } = await query.maybeSingle();
    if (error) throwLifecycleError(error);
    return data ? rowToRecord(data as VoiceGenerationRow) : null;
  } catch (error) {
    throwLifecycleError(error);
  }
}
