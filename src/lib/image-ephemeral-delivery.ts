import { createHash } from "node:crypto";

export const IMAGE_EPHEMERAL_MAX_BYTES = 30 * 1024 * 1024;
export type ImageEphemeralReceipt = {
  schema: "image_ephemeral_receipt.v1";
  deliveryMode: "inline_ephemeral";
  recordId: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  /** Digest of decoded image bytes, not the provider HTTP response body. */
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  selectedModelId: string;
  selectedCostPrice: number;
  mediaAvailable: false;
  canRecover: false;
  billingReferenceId?: string;
  cashCharged?: number;
  billingOperationId?: string | null;
};
export type ImageTransientDelivery = {
  kind: "inline_ephemeral";
  dataUrl: string;
  contentType: ImageEphemeralReceipt["contentType"];
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
};

/** Called at every durable boundary, including the legacy no-checkpoint path. */
export function assertImageDurableMetadata(value: unknown): void {
  if (typeof value === "string") {
    if (/data:[^,\s]*;base64,|(?:^|\s)blob:https?:\/\//iu.test(value)) throw new Error("IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN");
    return;
  }
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new Error("IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN");
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:data|dataUrl|inlineDataUrl|base64|b64_json|bytes|buffer|transientDelivery|apiKey|api_key|authorization|cookie|secret|token)$/iu.test(key)) {
      throw new Error("IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN");
    }
    assertImageDurableMetadata(item);
  }
}

export function decodeInlineImage(dataUrl: string) {
  // Bounded, canonical base64 only; never pass an untrusted value into error/log text.
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(IMAGE_EPHEMERAL_MAX_BYTES / 3) * 4 + 64) throw new Error("IMAGE_INLINE_RESULT_INVALID");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new Error("IMAGE_INLINE_RESULT_INVALID");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > IMAGE_EPHEMERAL_MAX_BYTES || buffer.toString("base64") !== match[2]) throw new Error("IMAGE_INLINE_RESULT_INVALID");
  return { buffer, contentType: match[1] as ImageEphemeralReceipt["contentType"] };
}

export function createImageEphemeralDelivery(input: {
  recordId: string; buffer: Buffer; contentType: ImageEphemeralReceipt["contentType"];
  width: number; height: number; selectedModelId: string; selectedCostPrice: number;
}): { receipt: ImageEphemeralReceipt; transientDelivery: ImageTransientDelivery } {
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const receipt: ImageEphemeralReceipt = {
    schema: "image_ephemeral_receipt.v1", deliveryMode: "inline_ephemeral", recordId: input.recordId,
    contentType: input.contentType, sha256, byteLength: input.buffer.length,
    width: input.width, height: input.height, selectedModelId: input.selectedModelId, selectedCostPrice: input.selectedCostPrice,
    mediaAvailable: false, canRecover: false,
  };
  if (!isImageEphemeralReceipt(receipt)) throw new Error("IMAGE_EPHEMERAL_METADATA_INVALID");
  return { receipt, transientDelivery: {
    kind: "inline_ephemeral", dataUrl: `data:${input.contentType};base64,${input.buffer.toString("base64")}`,
    contentType: input.contentType, sha256, byteLength: input.buffer.length, width: input.width, height: input.height,
  } };
}

export function isImageEphemeralReceipt(value: unknown): value is ImageEphemeralReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as ImageEphemeralReceipt;
  const keys = ["schema", "deliveryMode", "recordId", "contentType", "sha256", "byteLength", "width", "height", "selectedModelId", "selectedCostPrice", "mediaAvailable", "canRecover", "billingReferenceId", "cashCharged", "billingOperationId"];
  return Object.keys(receipt).every(key => keys.includes(key))
    && receipt.schema === "image_ephemeral_receipt.v1" && receipt.deliveryMode === "inline_ephemeral"
    && /^[a-f0-9]{64}$/u.test(receipt.recordId) && /^[a-f0-9]{64}$/u.test(receipt.sha256)
    && ["image/png", "image/jpeg", "image/webp"].includes(receipt.contentType)
    && Number.isInteger(receipt.byteLength) && receipt.byteLength > 0 && receipt.byteLength <= IMAGE_EPHEMERAL_MAX_BYTES
    && [receipt.width, receipt.height].every(size => Number.isInteger(size) && size > 0 && size <= 32768)
    && /^[A-Za-z0-9_.:/-]{1,200}$/u.test(receipt.selectedModelId)
    && Number.isFinite(receipt.selectedCostPrice) && receipt.selectedCostPrice >= 0
    && receipt.mediaAvailable === false && receipt.canRecover === false
    && (receipt.billingReferenceId === undefined || /^image:[A-Za-z0-9:_-]{1,200}$/u.test(receipt.billingReferenceId))
    && (receipt.cashCharged === undefined || (Number.isFinite(receipt.cashCharged) && receipt.cashCharged >= 0))
    && (receipt.billingOperationId == null || /^[A-Za-z0-9_-]{1,200}$/u.test(receipt.billingOperationId));
}

export function matchesImageEphemeralReceipt(observed: unknown, expected: ImageEphemeralReceipt) {
  return isImageEphemeralReceipt(observed) && Object.entries(expected).every(([key, value]) => observed[key as keyof ImageEphemeralReceipt] === value);
}

export function imageEphemeralStatus(receipt: ImageEphemeralReceipt) {
  return { recordId: receipt.recordId, deliveryMode: "inline_ephemeral", retention: "current_page_only",
    mediaAvailable: false, transientAvailable: false, canRecover: false, canResubmit: false, sameKeyCanResubmit: false,
    deliveryReady: false, images: [], billingReferenceId: receipt.billingReferenceId, cashCharged: receipt.cashCharged,
    contentType: receipt.contentType, sha256: receipt.sha256, byteLength: receipt.byteLength, width: receipt.width, height: receipt.height };
}
