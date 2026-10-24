import { GeneratedImageReferenceSchema, type GeneratedImageReference } from "@/lib/generated-image-reference";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";
import { SafeFetchError } from "@/lib/safe-fetch";

export class GeneratedImageReferenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

type OwnedImageRecord = { state: unknown; delivery_state: unknown; response: unknown };
export type GeneratedImageReferenceDependencies = {
  findOwned(recordId: string, userId: string): Promise<OwnedImageRecord | null>;
  validateUrl(url: string): Promise<unknown>;
};
const defaults: GeneratedImageReferenceDependencies = {
  async findOwned(recordId, userId) {
    const { data, error } = await getSupabaseAdminClient().from("image_generation_requests")
      .select("state,delivery_state,response").eq("record_id", recordId).eq("user_id", userId).maybeSingle();
    if (error) throw new GeneratedImageReferenceError("GENERATED_IMAGE_LOOKUP_UNAVAILABLE", "生成图片归属暂时无法确认，本次未提交", 503);
    return data;
  },
  validateUrl: async (url) => {
    const { validateProviderImageUrl } = await import("@/lib/image-provider-delivery");
    return validateProviderImageUrl(url);
  },
};

/** Storage may retain an unavailable receipt, but this grants no media access. */
export async function validateOwnedGeneratedImageReceipt(input: { userId: string; reference: GeneratedImageReference }, deps = defaults) {
  const ref = GeneratedImageReferenceSchema.parse(input.reference);
  if (!input.userId) throw new GeneratedImageReferenceError("GENERATED_IMAGE_NOT_OWNED", "生成图片不属于当前账号", 403);
  const row = await deps.findOwned(ref.recordId, input.userId);
  if (!row) throw new GeneratedImageReferenceError("GENERATED_IMAGE_NOT_OWNED", "生成图片不存在或不属于当前账号", 403);
  const delivery = row.response && typeof row.response === "object" ? row.response as Record<string, unknown> : {};
  if (row.state !== "completed" || row.delivery_state !== "delivered" || delivery.deliveryMode !== "provider_url") {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_NOT_AVAILABLE", "生成图片尚未交付或已确认失效；不会重新生成或扣费");
  }
  return delivery;
}

/** Resolves only a verified owner's available completed record; never regenerates. */
export async function validateOwnedGeneratedImageReference(input: { userId: string; reference: GeneratedImageReference }, deps = defaults) {
  const delivery = await validateOwnedGeneratedImageReceipt(input, deps);
  if (delivery.sourceExpiredAt) throw new GeneratedImageReferenceError("GENERATED_IMAGE_NOT_AVAILABLE", "生成图片已确认失效；不会重新生成或扣费");
  return delivery;
}

export async function resolveGeneratedImageReference(input: { userId: string; reference: GeneratedImageReference; queued?: boolean }, deps = defaults) {
  const delivery = await validateOwnedGeneratedImageReference(input, deps);
  if (input.reference.transform) throw new GeneratedImageReferenceError("GENERATED_IMAGE_CROP_UNSUPPORTED", "当前视频通道仅接受图片链接，尚不支持内存裁切；本次未提交或扣费");
  const url = typeof delivery.providerUrl === "string" ? delivery.providerUrl : "";
  if (!isPublicVideoAssetUrl(url)) {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_PRIVATE_INPUT_UNSUPPORTED", "当前视频通道尚不支持直接复用 H3 私有生成图片，请选择公开上游图片或主动上传参考素材；本次未提交或扣费");
  }
  try {
    await deps.validateUrl(url);
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    const transient = error.code === "DNS_LOOKUP_FAILED" || error.status >= 500;
    throw new GeneratedImageReferenceError(
      transient ? "GENERATED_IMAGE_URL_CHECK_UNAVAILABLE" : "GENERATED_IMAGE_URL_UNSAFE",
      transient ? "生成图片地址暂时无法安全核对，本次未提交或扣费" : "生成图片地址未通过安全校验，本次未提交或扣费",
      transient ? 503 : 422,
    );
  }
  return url;
}

/** Only the established multipart adapter consumes these RAM bytes. */
export async function readGeneratedImageMaterial(input: { userId: string; reference: GeneratedImageReference; maxBytes?: number }) {
  const ref = GeneratedImageReferenceSchema.parse(input.reference);
  const delivery = await validateOwnedGeneratedImageReference(input);
  const { readProviderImage } = await import("@/lib/image-provider-delivery");
  const material = await readProviderImage(delivery, false, { recordId: ref.recordId, userId: input.userId });
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024;
  if (!material || material.buffer.length > maxBytes) throw new GeneratedImageReferenceError("GENERATED_IMAGE_TOO_LARGE", "生成图片超过当前通道大小限制");
  if (!ref.transform) return { buffer: material.buffer, contentType: material.contentType };
  const { default: sharp } = await import("sharp");
  const decoder = sharp(material.buffer, { failOn: "error", limitInputPixels: 40_000_000 });
  const dimensions = await decoder.metadata();
  const crop = ref.transform;
  const width = Number(dimensions.width), height = Number(dimensions.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || crop.x + crop.width > width || crop.y + crop.height > height) throw new GeneratedImageReferenceError("GENERATED_IMAGE_CROP_INVALID", "裁切范围超出实际解码图片尺寸");
  const buffer = await decoder.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toBuffer();
  if (!buffer.length || buffer.length > maxBytes) throw new GeneratedImageReferenceError("GENERATED_IMAGE_TOO_LARGE", "裁切图片超过当前通道大小限制");
  return { buffer, contentType: "image/png" };
}
