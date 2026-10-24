import "server-only";

import { createHash } from "node:crypto";
import { parseGeneratedImageReferenceUri } from "@/lib/generated-image-reference";

import type { DigitalDispatchInput } from "@/lib/digital-video-dispatch";
import {
  VideoTerminalError,
  type VideoPriceSnapshot,
  type VideoTaskReservation,
} from "@/lib/video-terminal-finalizer";
import type { VideoRoutingSnapshot } from "@/lib/video-routing-snapshot";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type JsonObject = Record<string, unknown>;

export const VIDEO_GENERATION_REQUEST_SNAPSHOT_SCHEMA = "video_generation_request_snapshot.v1" as const;

export type VideoRequestAssetRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_image_list"
  | "reference_audio"
  | "reference_audio_list"
  | "source_video"
  | "person_asset"
  | "audio_asset";

export type VideoRequestAssetRef = {
  role: VideoRequestAssetRole;
  index: number;
  ref: string;
};

export type VideoPromptNormalization = {
  name: string;
  applied: boolean;
  detail?: string;
};

export type VideoGenerationRequestSnapshotV1 = {
  schema: typeof VIDEO_GENERATION_REQUEST_SNAPSHOT_SCHEMA;
  userPrompt: string;
  effectivePrompt: string;
  promptNormalizations: VideoPromptNormalization[];
  negativePrompt: string;
  referenceAssets: VideoRequestAssetRef[];
  targetDurationSeconds: number;
  effectiveDurationSeconds: number;
  aspectRatio: string;
  resolution: string;
  fps: number | null;
  seed: string | null;
  generateAudio: boolean | null;
  publicModelId: string;
  routingConfigHash: string;
  adapterVersion: string;
  providerPayloadHash: string;
};

export type BuildVideoGenerationRequestSnapshotInput = Omit<
  VideoGenerationRequestSnapshotV1,
  "schema" | "providerPayloadHash"
> & {
  providerPayload: unknown;
};

export type ReserveVideoTaskInput = {
  taskIdInternal: string;
  userId: string;
  modelId: string;
  clientRequestId: string;
  requestFingerprint: string;
  routingSnapshot: VideoRoutingSnapshot;
  requestSnapshot?: VideoGenerationRequestSnapshotV1;
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

const SHA256 = /^[a-f0-9]{64}$/u;
const ASPECT_RATIO = /^\d{1,4}:\d{1,4}$/u;
const ASSET_ROLES = new Set<VideoRequestAssetRole>([
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_image_list",
  "reference_audio",
  "reference_audio_list",
  "source_video",
  "person_asset",
  "audio_asset",
]);

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error("VIDEO_REQUEST_SNAPSHOT_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("VIDEO_REQUEST_SNAPSHOT_NON_FINITE_NUMBER");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (!value || typeof value !== "object") throw new Error("VIDEO_REQUEST_SNAPSHOT_NON_JSON_VALUE");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item, depth + 1)]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestText(value: unknown, code: string, maximum: number, allowEmpty = false, trim = true) {
  if (typeof value !== "string") throw new Error(code);
  const result = trim ? value.trim() : value;
  if ((!allowEmpty && !result.trim()) || result.length > maximum || /\u0000/u.test(result)) throw new Error(code);
  return result;
}

function finiteNumber(value: unknown, code: string, minimum: number, maximum: number) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(code);
  return result;
}

function normalizeAssetRef(value: unknown): VideoRequestAssetRef {
  const asset = asObject(value);
  const role = requestText(asset.role, "VIDEO_REQUEST_ASSET_ROLE_INVALID", 32) as VideoRequestAssetRole;
  const index = finiteNumber(asset.index, "VIDEO_REQUEST_ASSET_INDEX_INVALID", 0, 255);
  const ref = requestText(asset.ref, "VIDEO_REQUEST_ASSET_REF_INVALID", 4096);
  const durableRef = Boolean(parseGeneratedImageReferenceUri(ref)) || /^(?:object|asset):\/\/[^\s?#\u0000-\u001f]+$/u.test(ref)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(ref)
    || (() => {
      try {
        const url = new URL(ref);
        return ["http:", "https:"].includes(url.protocol)
          && !url.username
          && !url.password
          && !url.search
          && !url.hash;
      } catch {
        return false;
      }
    })();
  if (!ASSET_ROLES.has(role) || !Number.isSafeInteger(index) || !durableRef) {
    throw new Error("VIDEO_REQUEST_ASSET_REF_INVALID");
  }
  return { role, index, ref };
}

function normalizePromptNormalization(value: unknown): VideoPromptNormalization {
  const item = asObject(value);
  if (typeof item.applied !== "boolean") throw new Error("VIDEO_REQUEST_NORMALIZATION_INVALID");
  const detail = item.detail === undefined
    ? undefined
    : requestText(item.detail, "VIDEO_REQUEST_NORMALIZATION_INVALID", 2000, true);
  return {
    name: requestText(item.name, "VIDEO_REQUEST_NORMALIZATION_INVALID", 120),
    applied: item.applied,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export function hashVideoProviderPayload(providerPayload: unknown) {
  return sha256(`video-provider-payload:v1:${stableJson(providerPayload)}`);
}

export function videoGenerationRequestSnapshotHash(snapshot: VideoGenerationRequestSnapshotV1) {
  return sha256(`video-generation-request-snapshot:v1:${stableJson(snapshot)}`);
}

export function parseVideoGenerationRequestSnapshot(value: unknown): VideoGenerationRequestSnapshotV1 {
  const input = asObject(value);
  if (input.schema !== VIDEO_GENERATION_REQUEST_SNAPSHOT_SCHEMA) {
    throw new Error("VIDEO_REQUEST_SNAPSHOT_VERSION_UNSUPPORTED");
  }
  if (!Array.isArray(input.promptNormalizations) || input.promptNormalizations.length > 64) {
    throw new Error("VIDEO_REQUEST_NORMALIZATIONS_INVALID");
  }
  if (!Array.isArray(input.referenceAssets) || input.referenceAssets.length > 64) {
    throw new Error("VIDEO_REQUEST_ASSETS_INVALID");
  }
  const fps = input.fps === null ? null : finiteNumber(input.fps, "VIDEO_REQUEST_FPS_INVALID", 1, 240);
  const seed = input.seed === null ? null : requestText(input.seed, "VIDEO_REQUEST_SEED_INVALID", 160);
  if (input.generateAudio !== null && typeof input.generateAudio !== "boolean") {
    throw new Error("VIDEO_REQUEST_GENERATE_AUDIO_INVALID");
  }
  const snapshot: VideoGenerationRequestSnapshotV1 = {
    schema: VIDEO_GENERATION_REQUEST_SNAPSHOT_SCHEMA,
    userPrompt: requestText(input.userPrompt, "VIDEO_REQUEST_USER_PROMPT_INVALID", 50_000, true, false),
    effectivePrompt: requestText(input.effectivePrompt, "VIDEO_REQUEST_EFFECTIVE_PROMPT_INVALID", 50_000, true, false),
    promptNormalizations: input.promptNormalizations.map(normalizePromptNormalization),
    negativePrompt: requestText(input.negativePrompt, "VIDEO_REQUEST_NEGATIVE_PROMPT_INVALID", 20_000, true, false),
    referenceAssets: input.referenceAssets.map(normalizeAssetRef),
    targetDurationSeconds: finiteNumber(input.targetDurationSeconds, "VIDEO_REQUEST_TARGET_DURATION_INVALID", 0.01, 3600),
    effectiveDurationSeconds: finiteNumber(input.effectiveDurationSeconds, "VIDEO_REQUEST_EFFECTIVE_DURATION_INVALID", 0.01, 3600),
    aspectRatio: requestText(input.aspectRatio, "VIDEO_REQUEST_ASPECT_RATIO_INVALID", 32),
    resolution: requestText(input.resolution, "VIDEO_REQUEST_RESOLUTION_INVALID", 120),
    fps,
    seed,
    generateAudio: input.generateAudio as boolean | null,
    publicModelId: requestText(input.publicModelId, "VIDEO_REQUEST_PUBLIC_MODEL_ID_INVALID", 240),
    routingConfigHash: requestText(input.routingConfigHash, "VIDEO_REQUEST_ROUTING_HASH_INVALID", 64).toLowerCase(),
    adapterVersion: requestText(input.adapterVersion, "VIDEO_REQUEST_ADAPTER_VERSION_INVALID", 240),
    providerPayloadHash: requestText(input.providerPayloadHash, "VIDEO_REQUEST_PROVIDER_PAYLOAD_HASH_INVALID", 64).toLowerCase(),
  };
  if (!ASPECT_RATIO.test(snapshot.aspectRatio)
      || !SHA256.test(snapshot.routingConfigHash)
      || !SHA256.test(snapshot.providerPayloadHash)
      || Buffer.byteLength(stableJson(snapshot), "utf8") > 131_072) {
    throw new Error("VIDEO_REQUEST_SNAPSHOT_INVALID");
  }
  const identities = new Set<string>();
  for (const asset of snapshot.referenceAssets) {
    const identity = `${asset.role}:${asset.index}`;
    if (identities.has(identity)) throw new Error("VIDEO_REQUEST_ASSET_ROLE_DUPLICATE");
    identities.add(identity);
  }
  return snapshot;
}

export function buildVideoGenerationRequestSnapshot(
  input: BuildVideoGenerationRequestSnapshotInput,
): VideoGenerationRequestSnapshotV1 {
  return parseVideoGenerationRequestSnapshot({
    ...input,
    schema: VIDEO_GENERATION_REQUEST_SNAPSHOT_SCHEMA,
    providerPayloadHash: hashVideoProviderPayload(input.providerPayload),
    providerPayload: undefined,
  });
}

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
  if (!input.requestSnapshot) {
    throw new VideoTerminalError(
      "VIDEO_REQUEST_SNAPSHOT_REQUIRED",
      "视频请求快照不完整，本次未提交供应商",
      503,
      false,
    );
  }
  let requestSnapshot: VideoGenerationRequestSnapshotV1;
  try {
    requestSnapshot = parseVideoGenerationRequestSnapshot(input.requestSnapshot);
  } catch {
    throw new VideoTerminalError(
      "VIDEO_REQUEST_SNAPSHOT_INVALID",
      "视频请求快照校验失败，本次未提交供应商",
      503,
      false,
    );
  }
  if (requestSnapshot.routingConfigHash !== input.routingSnapshot.configVersion
      || requestSnapshot.userPrompt !== input.task.prompt
      || requestSnapshot.aspectRatio !== input.task.aspectRatio.trim()
      || requestSnapshot.resolution !== String(input.task.resolution || "").trim()
      || requestSnapshot.targetDurationSeconds !== input.task.durationSeconds) {
    throw new VideoTerminalError(
      "VIDEO_REQUEST_SNAPSHOT_IDENTITY_MISMATCH",
      "视频请求快照与任务参数不一致，本次未提交供应商",
      409,
      false,
    );
  }
  const db = getSupabaseAdminClient();
  const requestSnapshotHash = videoGenerationRequestSnapshotHash(requestSnapshot);
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
    p_request_snapshot: requestSnapshot,
    p_request_snapshot_hash: requestSnapshotHash,
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
  const { data, error } = input.price.tokenQuote
    ? await db.rpc("reserve_video_token_task_v1_atomic", {
        p_task: reservationParams,
        p_routing_snapshot: input.routingSnapshot,
        p_request_snapshot: requestSnapshot,
        p_token_quote: input.price.tokenQuote,
      })
    : input.dispatch
    ? await db.rpc("reserve_queued_digital_video_task_request_snapshot_v1_atomic", {
        p_task: reservationParams,
        p_dispatch: input.dispatch,
        p_routing_snapshot: input.routingSnapshot,
        p_request_snapshot: requestSnapshot,
        p_request_snapshot_hash: requestSnapshotHash,
      })
    : await db.rpc("reserve_video_generation_task_request_snapshot_v1_atomic", reservationParams);

  if (error) {
    const detail = rpcErrorText(error);
    if (detail.includes("VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS")) {
      throw new VideoTerminalError(
        "VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS",
        "参考素材已移除或正在清理，请重新上传后再提交",
        409,
        false,
      );
    }
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
        ? "VIDEO_REQUEST_SNAPSHOT_MIGRATION_NOT_READY"
        : "VIDEO_TASK_RESERVATION_FAILED",
      "视频请求快照、路由快照与预算原子预留暂时不可用，本次未提交供应商",
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
