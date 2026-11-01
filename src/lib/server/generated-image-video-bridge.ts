import "server-only";
import { createHash } from "node:crypto";
import type { GeneratedImageReference } from "@/lib/generated-image-reference";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";
import { GeneratedImageReferenceError, readGeneratedImageMaterial } from "@/lib/server/generated-image-reference";
import type { storageManager } from "@/storage/object";

type BridgeDependencies = {
  readMaterial: typeof readGeneratedImageMaterial;
  upload: typeof storageManager.upload;
};
const defaults: BridgeDependencies = {
  readMaterial: readGeneratedImageMaterial,
  upload: async (...args) => (await import("@/storage/object")).storageManager.upload(...args),
};
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Reuses an owned delivered result; never regenerates it or registers a user file. */
export async function bridgeGeneratedImageForVideoProvider(
  input: { userId: string; reference: GeneratedImageReference },
  deps: BridgeDependencies = defaults,
): Promise<string> {
  if (!input.userId.trim()) throw new GeneratedImageReferenceError("GENERATED_IMAGE_NOT_OWNED", "生成图片不属于当前账号", 403);
  // Ownership, delivered state, expiry, provider URL safety and crop bounds are
  // enforced by the existing material reader before any inference-copy write.
  const material = await deps.readMaterial({ ...input, maxBytes: MAX_IMAGE_BYTES });
  if (!material.buffer.length || material.buffer.length > MAX_IMAGE_BYTES) {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_TOO_LARGE", "生成图片为空或超过当前通道大小限制");
  }
  const validated = validateUploadBuffer(material.buffer, material.contentType);
  if (!["image/png", "image/jpeg", "image/webp"].includes(validated.contentType)) {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_TYPE_UNSUPPORTED", "当前视频通道仅支持 PNG、JPEG 或 WebP 参考图片");
  }
  const ownerNamespace = createHash("sha256").update(input.userId).digest("hex").slice(0, 16);
  const digest = createHash("sha256").update(material.buffer).digest("hex");
  const prefix = `video-inputs/generated-provider-bridge/${ownerNamespace}/`;
  const fileName = `${digest}${validated.extension}`;
  const datePath = new Date().toISOString().slice(0, 10).replace(/-/gu, "/");
  const expectedKey = `${prefix}${datePath}/${fileName}`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.resolve().then(() => deps.upload(material.buffer, fileName, validated.contentType, {
      providerType: "tencent_cos", strictProvider: true, publicRead: true,
      category: "image", prefix, fileName, source: "video-provider-generated-image-bridge",
      // Intentionally no userId/requireOwnershipRecord: the source record is the
      // ownership authority; this inference copy must not create user_files rows.
    })),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new GeneratedImageReferenceError("GENERATED_IMAGE_BRIDGE_TIMEOUT", "生成图片推理副本写入未确认，本次未提交视频，请稍后重试", 503)), 60_000);
    }),
  ]).finally(() => { if (timeout) clearTimeout(timeout); });
  // A timed-out COS write can finish later under the same content-addressed
  // key. Never delete that shared key or dispatch a video without its receipt.
  const url = new URL(result.url);
  if (result.provider !== "tencent_cos" || !result.isPublic || result.key !== expectedKey
    || result.size !== material.buffer.length || result.contentType !== validated.contentType
    || !isPublicVideoAssetUrl(result.url) || url.protocol !== "https:" || url.port
    || !/^[a-z0-9][a-z0-9-]{0,62}\.cos\.[a-z0-9-]+\.myqcloud\.com$/iu.test(url.hostname)
    || url.search || url.hash || url.username || url.password || url.pathname !== `/${expectedKey}`) {
    throw new GeneratedImageReferenceError("GENERATED_IMAGE_BRIDGE_INVALID", "生成图片转存后未返回可安全读取的公开推理地址", 503);
  }
  return result.url;
}
