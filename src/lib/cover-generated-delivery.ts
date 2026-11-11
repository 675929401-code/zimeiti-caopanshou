import { createHash } from "node:crypto";
import { renderCoverComposition } from "@/lib/cover-composition-server";
import { coverCompositionTextReceipt, type CoverCompositionPlan } from "@/lib/cover-composition";
import type { ImageExactlyOnceRecord } from "@/lib/image-exactly-once";
import { decodeInlineImage, isImageEphemeralReceipt } from "@/lib/image-ephemeral-delivery";
import { readGeneratedImageMaterial } from "@/lib/server/generated-image-reference";
import { imageFailureBillingReferenceId } from "@/lib/image-failure-history";

export const COVER_TEMPORARY_DELIVERY_CODE = "COVER_DURABLE_DELIVERY_NOT_APPLICABLE";
export const COVER_TEMPORARY_COMPOSITION_ERROR = "COVER_TEMPORARY_COMPOSITION_FAILED";
/** The caller obtains this record by exact owner + original request key + trace. */
export function coverGeneratedReceipt(record: ImageExactlyOnceRecord | null, binding?: { userId: string; clientIdempotencyKey: string }) {
  if (!record || record.state !== "completed" || record.deliveryState !== "delivered") return null;
  const response = record.response || {};
  const inline = isImageEphemeralReceipt(response);
  if (!inline && response.deliveryMode !== "provider_url") return null;
  const cashCharged = Number(response.cashCharged ?? record.requestSnapshot?.quotedPriceYuan ?? 0);
  if (!Number.isFinite(cashCharged) || cashCharged < 0) return null;
  const billingReferenceId = typeof response.billingReferenceId === "string" ? response.billingReferenceId
    : binding && binding.clientIdempotencyKey === record.clientIdempotencyKey
      ? imageFailureBillingReferenceId(binding.userId, binding.clientIdempotencyKey) : undefined;
  return {
    recordId: record.recordId, generationCompleted: true, deliveryMode: "inline_ephemeral", retention: "current_page_only",
    mediaAvailable: false, canRecover: false, canResubmit: false,
    cashCharged,
    ...(billingReferenceId ? { billingReferenceId } : {}),
  };
}

/** One request's composition bytes; no persistence, background retries or implicit upload. */
export async function composeGeneratedCover(input: {
  userId: string; record: ImageExactlyOnceRecord; response: Record<string, unknown>; plan: CoverCompositionPlan;
}) {
  const receipt = coverGeneratedReceipt(input.record, { userId: input.userId, clientIdempotencyKey: input.record.clientIdempotencyKey });
  if (!receipt || input.response.recordId !== input.record.recordId) throw new Error("COVER_IMAGE_RECEIPT_MISMATCH");
  let bytes: Buffer;
  if (isImageEphemeralReceipt(input.record.response)) {
    const image = Array.isArray(input.response.images) ? input.response.images[0] as Record<string, unknown> | undefined : undefined;
    if (image?.recordId !== input.record.recordId || image.deliveryMode !== "inline_ephemeral" || typeof image.url !== "string") throw new Error("COVER_IMAGE_TRANSIENT_MISSING");
    const decoded = decodeInlineImage(image.url);
    if (decoded.buffer.length !== input.record.response.byteLength || createHash("sha256").update(decoded.buffer).digest("hex") !== input.record.response.sha256) throw new Error("COVER_IMAGE_TRANSIENT_MISMATCH");
    bytes = decoded.buffer;
  } else {
    bytes = (await readGeneratedImageMaterial({ userId: input.userId, reference: { schema: "generated_image_ref.v1", recordId: input.record.recordId } })).buffer;
  }
  const rendered = await renderCoverComposition(bytes, input.plan);
  if (!rendered.bytes.length || rendered.bytes.length > 30 * 1024 * 1024) throw new Error("COVER_COMPOSITION_SIZE_INVALID");
  return {
    ...receipt, mediaAvailable: true, contentType: "image/png", width: rendered.width, height: rendered.height,
    ...coverCompositionTextReceipt(input.plan),
    byteLength: rendered.bytes.length, sha256: createHash("sha256").update(rendered.bytes).digest("hex"),
    images: [{ url: `data:image/png;base64,${rendered.bytes.toString("base64")}`, recordId: input.record.recordId,
      deliveryMode: "inline_ephemeral", ephemeral: true, width: rendered.width, height: rendered.height, dimensionsVerified: true }],
  };
}
