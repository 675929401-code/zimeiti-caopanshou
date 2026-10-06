import "server-only";

import type { DigitalDispatchInput } from "@/lib/digital-video-dispatch";
import {
  VideoTerminalError,
  type VideoPriceSnapshot,
  type VideoTaskReservation,
} from "@/lib/video-terminal-finalizer";
import type { VideoRoutingSnapshot } from "@/lib/video-routing-snapshot";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type JsonObject = Record<string, unknown>;

type ReserveVideoTaskInput = {
  taskIdInternal: string;
  userId: string;
  modelId: string;
  clientRequestId: string;
  requestFingerprint: string;
  routingSnapshot: VideoRoutingSnapshot;
  price: VideoPriceSnapshot;
  billingExempt: boolean;
  providerTaskId?: string;
  dispatch?: DigitalDispatchInput;
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

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseRpcObject(value: unknown): JsonObject {
  if (Array.isArray(value)) return asObject(value[0]);
  return asObject(value);
}

function rpcErrorText(error: unknown) {
  const object = asObject(error);
  return `${String(object.message || "")} ${String(object.details || "")} ${String(object.hint || "")}`;
}

function budgetDetail(error: unknown) {
  const details = String(asObject(error).details || "").trim();
  if (!details.startsWith("{")) return {};
  try {
    return asObject(JSON.parse(details));
  } catch {
    return {};
  }
}

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
}

/**
 * Atomically creates the durable video task and reserves its wallet capacity.
 * The versioned RPC names are intentional: deploying application code before
 * the matching migration must fail closed instead of falling back to the old
 * per-request-id reservation that could overcommit one account concurrently.
 */
export async function reserveVideoGenerationTask(
  input: ReserveVideoTaskInput,
): Promise<VideoTaskReservation> {
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
    p_routing_snapshot: input.routingSnapshot,
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
    ? await db.rpc("reserve_queued_digital_video_task_routing_atomic", {
        p_task: reservationParams,
        p_dispatch: input.dispatch,
        p_routing_snapshot: input.routingSnapshot,
      })
    : await db.rpc("reserve_video_generation_task_routing_atomic", reservationParams);

  if (error) {
    const detail = rpcErrorText(error);
    if (detail.includes("VIDEO_TASK_CANCELLED_BEFORE_DISPATCH")) {
      throw new VideoTerminalError(
        "VIDEO_TASK_CANCELLED_BEFORE_DISPATCH",
        "该视频请求已由用户终止，本次未提交供应商且未扣费",
        409,
        false,
      );
    }
    if (detail.includes("DIGITAL_HUMAN_ACCOUNT_BUSY")) {
      throw new VideoTerminalError(
        "DIGITAL_HUMAN_ACCOUNT_BUSY",
        "当前账号已有数字人任务正在处理，请在作品与任务中查看，完成后再提交",
        429,
        false,
      );
    }
    if (detail.includes("VIDEO_REQUEST_IDEMPOTENCY_CONFLICT")) {
      throw new VideoTerminalError(
        "VIDEO_REQUEST_IDEMPOTENCY_CONFLICT",
        "该请求编号已经绑定到不同的视频参数，请新建任务后重试",
        409,
        false,
      );
    }
    if (detail.includes("VIDEO_BUDGET_RESERVATION_INSUFFICIENT")) {
      const budget = budgetDetail(error);
      const balance = money(budget.cash_balance);
      const reserved = money(budget.reserved_before);
      const requested = money(budget.requested_amount);
      const summary = balance && reserved && requested
        ? `当前现金余额 ¥${balance}，在途视频已预留 ¥${reserved}，本单需要 ¥${requested}`
        : "当前现金余额扣除在途视频预留后不足以支付本单";
      throw new VideoTerminalError(
        "VIDEO_BUDGET_RESERVATION_INSUFFICIENT",
        `${summary}，请等待任务完成或充值后重试`,
        402,
        false,
      );
    }
    throw new VideoTerminalError(
      detail.includes("Could not find the function") || detail.includes("schema cache")
        ? "VIDEO_ROUTING_MIGRATION_NOT_READY"
        : "VIDEO_TASK_RESERVATION_FAILED",
      "视频路由快照与预算原子预留暂时不可用，本次未提交供应商",
      503,
      true,
    );
  }

  const result = parseRpcObject(data);
  const taskIdInternal = String(result.task_id || input.taskIdInternal);
  if (taskIdInternal !== input.taskIdInternal) {
    throw new VideoTerminalError(
      "VIDEO_TASK_RESERVATION_MISMATCH",
      "视频任务登记结果不一致，本次未提交供应商",
      503,
      false,
    );
  }
  return {
    taskIdInternal,
    created: result.created === true,
    status: String(result.status || "submitting"),
    billingState: String(result.billing_state || "pending"),
    providerTaskId: String(result.provider_task_id || ""),
  };
}
