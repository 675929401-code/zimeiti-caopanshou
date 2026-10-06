import { createHash } from "node:crypto";
import { parseImageRequestRejectionReceipt, type ImageRequestRejection } from "@/lib/image-request-rejection";

export const IMAGE_FAILURE_HISTORY_SURFACE = "image-workbench" as const;
export const COVER_FAILURE_HISTORY_SURFACE = "cover-studio" as const;
export const STORYBOARD_FAILURE_HISTORY_SURFACE = "storyboard-workbench" as const;
export const FREE_CANVAS_FAILURE_HISTORY_SURFACE = "free-canvas" as const;
export const SHORT_DRAMA_FAILURE_HISTORY_SURFACE = "short-drama-film-studio" as const;
export const IMAGE_FAILURE_HISTORY_PAGE_SIZE = 20;

const IMAGE_FAILURE_HISTORY_SURFACES = new Set<string>([
  IMAGE_FAILURE_HISTORY_SURFACE,
  COVER_FAILURE_HISTORY_SURFACE,
  STORYBOARD_FAILURE_HISTORY_SURFACE,
  FREE_CANVAS_FAILURE_HISTORY_SURFACE,
  SHORT_DRAMA_FAILURE_HISTORY_SURFACE,
  "other",
]);

const REFERENCE_ID = /^ref_[a-f0-9]{32}$/u;
const RATIO = /^\d{1,3}:\d{1,3}$/u;
const RESOLUTION = /^(?:1K|2K|4K)$/u;

export type ImageFailureRequestSnapshot = {
  schema: "image_generation_request_snapshot.v1";
  surface: "image-workbench" | "cover-studio" | "storyboard-workbench" | "free-canvas" | "short-drama-film-studio" | "other";
  prompt: string;
  publicModelId: string;
  modelName: string;
  mode: "text-to-image" | "image-to-image";
  aspectRatio: string;
  resolution: "1K" | "2K" | "4K";
  referenceAssetRefs: string[];
  quotedPriceYuan: number;
  billingExempt: boolean;
  exactCoverText?: string;
};

function isImageFailureHistorySurface(value: unknown): value is ImageFailureRequestSnapshot["surface"] {
  return typeof value === "string" && IMAGE_FAILURE_HISTORY_SURFACES.has(value);
}

export type ImageTerminalFailure = ImageRequestRejection;

export type ImageFailureBillingState = "charged" | "not_charged" | "exempt" | "unknown";
export type ImageFailureWalletOperation = {
  idempotency_key: string;
  operation_kind: string;
  amount: number | string | null;
  status: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function referenceIdentity(value: string) {
  let canonical = value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // Query strings often contain expiring signatures. They must never enter
      // account history and must not make the same stored object look different.
      canonical = `${url.protocol}//${url.host}${url.pathname}`;
    }
  } catch {
    // Data URLs are hashed in full and are never persisted in the snapshot.
  }
  return `ref_${sha256(canonical).slice(0, 32)}`;
}

export function createImageFailureRequestSnapshot(input: {
  surface?: string;
  prompt: string;
  publicModelId: string;
  modelName: string;
  aspectRatio: string;
  resolution: string;
  referenceImageUrls: string[];
  quotedPriceYuan: number;
  billingExempt: boolean;
  exactCoverText?: string;
}): ImageFailureRequestSnapshot | null {
  const prompt = input.prompt.trim();
  const publicModelId = input.publicModelId.trim();
  const modelName = input.modelName.trim();
  const aspectRatio = input.aspectRatio.trim();
  const resolution = input.resolution.trim().toUpperCase();
  const referenceAssetRefs = [...new Set(input.referenceImageUrls.map(referenceIdentity))];
  const snapshot: ImageFailureRequestSnapshot = {
    schema: "image_generation_request_snapshot.v1",
    surface: isImageFailureHistorySurface(input.surface)
      ? input.surface
      : "other",
    prompt,
    publicModelId,
    modelName,
    mode: referenceAssetRefs.length ? "image-to-image" : "text-to-image",
    aspectRatio,
    resolution: resolution as ImageFailureRequestSnapshot["resolution"],
    referenceAssetRefs,
    quotedPriceYuan: input.quotedPriceYuan,
    billingExempt: input.billingExempt,
    ...(input.exactCoverText?.trim() ? { exactCoverText: input.exactCoverText.trim() } : {}),
  };
  return parseImageFailureRequestSnapshot(snapshot);
}

export function parseImageFailureRequestSnapshot(value: unknown): ImageFailureRequestSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<ImageFailureRequestSnapshot>;
  if (row.schema !== "image_generation_request_snapshot.v1"
    || !isImageFailureHistorySurface(row.surface)
    || typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 50_000
    || typeof row.publicModelId !== "string" || !row.publicModelId.trim() || row.publicModelId.length > 200
    || typeof row.modelName !== "string" || !row.modelName.trim() || row.modelName.length > 200
    || (row.mode !== "text-to-image" && row.mode !== "image-to-image")
    || typeof row.aspectRatio !== "string" || !RATIO.test(row.aspectRatio)
    || typeof row.resolution !== "string" || !RESOLUTION.test(row.resolution)
    || !Array.isArray(row.referenceAssetRefs) || row.referenceAssetRefs.length > 9
    || row.referenceAssetRefs.some(item => typeof item !== "string" || !REFERENCE_ID.test(item))
    || new Set(row.referenceAssetRefs).size !== row.referenceAssetRefs.length
    || !Number.isFinite(row.quotedPriceYuan) || Number(row.quotedPriceYuan) < 0 || Number(row.quotedPriceYuan) > 1_000_000
    || typeof row.billingExempt !== "boolean"
    || (row.exactCoverText !== undefined && (typeof row.exactCoverText !== "string" || row.exactCoverText.length > 200))) return null;
  if ((row.mode === "text-to-image") !== (row.referenceAssetRefs.length === 0)) return null;
  return {
    schema: row.schema,
    surface: row.surface,
    prompt: row.prompt,
    publicModelId: row.publicModelId,
    modelName: row.modelName,
    mode: row.mode,
    aspectRatio: row.aspectRatio,
    resolution: row.resolution as ImageFailureRequestSnapshot["resolution"],
    referenceAssetRefs: [...row.referenceAssetRefs],
    quotedPriceYuan: Number(row.quotedPriceYuan),
    billingExempt: row.billingExempt,
    ...(row.exactCoverText ? { exactCoverText: row.exactCoverText } : {}),
  };
}

export function parseImageTerminalFailure(response: unknown, payloadFingerprint: string): ImageTerminalFailure | null {
  return parseImageRequestRejectionReceipt(response, payloadFingerprint);
}

export function imageTerminalFailureMessage(failure: ImageTerminalFailure) {
  if (failure.code === "IMAGE_BILLING_RESERVATION_REJECTED") return "本次图片预算预留未成功，未调用生成服务，也未扣费。请检查余额后重新提交。";
  if (failure.code === "IMAGE_PLATFORM_REQUEST_INTERRUPTED") return "本次图片任务中断且没有取得可交付结果，费用已自动退回。请重新提交一次。";
  if (failure.source === "input") return "参考图未能安全读取，本次未提交生成。请重新上传或检查参考图后再试。";
  if (failure.code === "IMAGE_REFERENCE_REJECTED") return "参考图未通过生成服务检查，本次未生成图片。请检查参考图后重新提交。";
  if (failure.code === "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE") return "当前渠道没有可用账户，本次未生成图片。请更换模型或稍后重新提交。";
  if (failure.code === "IMAGE_UPSTREAM_TERMINAL_EVENT") return "生成服务已明确结束本次请求，未生成图片。请稍后重新提交。";
  if (failure.code === "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH") {
    return `上游返回 ${failure.actualDimensions || "未知尺寸"}，与所选 ${failure.expectedAspectRatio || "画幅"} 不一致；结果未发放且未扣费。`;
  }
  if (failure.code === "IMAGE_OUTPUT_RESOLUTION_MISMATCH") {
    return `上游返回 ${failure.actualDimensions || "未知尺寸"}，未达到所选 ${failure.expectedResolution || "分辨率"}；结果未发放且未扣费。`;
  }
  return "生成服务未接受本次请求。请检查输入或更换可用模型后重新提交。";
}

export function imageFailureBillingReferenceId(userId: string, clientIdempotencyKey: string) {
  return `image:h3_${sha256(`${userId}:${clientIdempotencyKey}`).slice(0, 48)}`;
}

/** Resolve net billing, including the idempotent release written after a definitive rejection. */
export function imageFailureBillingStateFromOperations(input: {
  billingReferenceId: string;
  billingExempt: boolean;
  operations: ImageFailureWalletOperation[];
  queryFailed?: boolean;
}): { state: ImageFailureBillingState; chargedAmount?: number } {
  if (input.queryFailed) return { state: "unknown" };
  const chargeRows = input.operations.filter((row) => row.idempotency_key === input.billingReferenceId
    && row.operation_kind === "cash_charge");
  const refundRows = input.operations.filter((row) => row.idempotency_key === `${input.billingReferenceId}:release`
    && row.operation_kind === "cash_refund");
  const charge = chargeRows.find((row) => row.status === "completed" && Number.isFinite(Number(row.amount)));
  const refund = refundRows.find((row) => row.status === "completed" && Number.isFinite(Number(row.amount)));
  if (charge) {
    const chargedAmount = Math.max(0, Number(charge.amount));
    if (refund && Number(refund.amount) + 0.000001 >= chargedAmount) return { state: "not_charged" };
    if (refundRows.length) return { state: "unknown" };
    return { state: "charged", chargedAmount };
  }
  if (chargeRows.length || refundRows.length) return { state: "unknown" };
  return { state: input.billingExempt ? "exempt" : "not_charged" };
}

export function imageFailureRetryEligibility(billingState: ImageFailureBillingState) {
  if (billingState === "not_charged" || billingState === "exempt") {
    return { canLoadForRetry: true as const };
  }
  return {
    canLoadForRetry: false as const,
    retryBlockReason: billingState === "charged"
      ? "该失败请求存在已扣费账单，请先完成对账或退款，暂不可再次提交。"
      : "该失败请求的计费状态尚未确认，请先完成对账，暂不可再次提交。",
  };
}

export function isImageFailureHistoryMigrationMissing(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  return /request_snapshot|failure_hidden_at|claim_image_generation_request_v2|schema cache|does not exist|could not find/i.test(message);
}
