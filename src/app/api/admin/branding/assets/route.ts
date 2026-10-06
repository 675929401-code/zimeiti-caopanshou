import crypto from "node:crypto";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import {
  PlatformBrandValidationError,
  isPlatformBrandAssetPurpose,
} from "@/lib/branding/contracts";
import {
  PlatformBrandAuthorityError,
  appendPlatformBrandFailureEvent,
  platformBrandErrorCode,
  registerPlatformBrandAsset,
} from "@/lib/server/brand-authority";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import {
  UploadValidationError,
  safeUploadFileName,
  validateUploadBuffer,
} from "@/lib/file-upload-security";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;
const ACCEPTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function requestKey(request: NextRequest): string {
  const supplied = request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "";
  return (supplied.trim() || crypto.randomUUID()).slice(0, 200);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof UploadValidationError) {
    return json({ ok: false, error: "品牌图片内容或格式无效", code: error.code }, 415);
  }
  if (error instanceof PlatformBrandValidationError) {
    const code = error.code;
    const status = code === "BRAND_ASSET_TOO_LARGE" ? 413
      : code === "BRAND_ASSET_TYPE_UNSUPPORTED" || code === "BRAND_ASSET_DECODE_FAILED" ? 415
        : 400;
    return json({ ok: false, error: error.message, code }, status);
  }
  if (error instanceof PlatformBrandAuthorityError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.code === "BRAND_MIGRATION_REQUIRED" ? 503 : 500,
    );
  }
  return json({ ok: false, error: "品牌资产上传失败", code: "BRAND_ASSET_UPLOAD_FAILED" }, 500);
}

async function normalizedBrandImage(
  source: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const input = sharp(source, {
      failOn: "error",
      limitInputPixels: MAX_PIXELS,
      animated: false,
    });
    const sourceMetadata = await input.metadata();
    if ((sourceMetadata.pages || 1) !== 1) {
      throw new PlatformBrandValidationError("品牌图仅支持单帧图片", "BRAND_ASSET_ANIMATION_FORBIDDEN");
    }
    const sourceWidth = Number(sourceMetadata.width || 0);
    const sourceHeight = Number(sourceMetadata.height || 0);
    if (sourceWidth < 16 || sourceHeight < 16 || sourceWidth > MAX_DIMENSION || sourceHeight > MAX_DIMENSION) {
      throw new PlatformBrandValidationError("品牌图宽高必须在 16 到 8192 像素之间", "BRAND_ASSET_DIMENSIONS_INVALID");
    }

    const pipeline = input.rotate();
    const bytes = mimeType === "image/png"
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : mimeType === "image/jpeg"
        ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : await pipeline.webp({ quality: 92, smartSubsample: true }).toBuffer();
    if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) {
      throw new PlatformBrandValidationError("规范化后的品牌图必须在 5MB 以内", "BRAND_ASSET_TOO_LARGE");
    }
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    if (width < 16 || height < 16 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new PlatformBrandValidationError("品牌图像素尺寸无效", "BRAND_ASSET_DIMENSIONS_INVALID");
    }
    return { bytes, width, height };
  } catch (error) {
    if (error instanceof PlatformBrandValidationError) throw error;
    throw new PlatformBrandValidationError("品牌图片无法安全解码", "BRAND_ASSET_DECODE_FAILED");
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "platform_brand_asset_upload",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  const key = requestKey(request);
  let uploaded: { key: string; provider: StorageProviderType } | null = null;

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new PlatformBrandValidationError("请使用 multipart/form-data 上传品牌图", "BRAND_ASSET_REQUEST_INVALID");
    }
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      throw new PlatformBrandValidationError("品牌图必须在 5MB 以内", "BRAND_ASSET_TOO_LARGE");
    }
    const form = await request.formData();
    const purpose = form.get("purpose");
    const file = form.get("file");
    if (!isPlatformBrandAssetPurpose(purpose)) {
      throw new PlatformBrandValidationError("品牌资产用途无效", "BRAND_ASSET_PURPOSE_INVALID");
    }
    if (!(file instanceof File)) {
      throw new PlatformBrandValidationError("请选择品牌图片", "BRAND_ASSET_FILE_REQUIRED");
    }
    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
      throw new PlatformBrandValidationError("品牌图必须在 5MB 以内", "BRAND_ASSET_TOO_LARGE");
    }

    const original = Buffer.from(await file.arrayBuffer());
    if (original.byteLength !== file.size || original.byteLength > MAX_FILE_BYTES) {
      throw new PlatformBrandValidationError("品牌图大小校验失败", "BRAND_ASSET_TOO_LARGE");
    }
    const validated = validateUploadBuffer(original, file.type || "application/octet-stream");
    if (!ACCEPTED_MIME_TYPES.has(validated.contentType)) {
      throw new PlatformBrandValidationError("品牌图只支持 PNG、JPEG 或 WebP", "BRAND_ASSET_TYPE_UNSUPPORTED");
    }
    const normalized = await normalizedBrandImage(original, validated.contentType);
    const digest = crypto.createHash("sha256").update(normalized.bytes).digest("hex");
    const safeName = safeUploadFileName(validated.extension);

    const storage = await storageManager.upload(normalized.bytes, safeName, validated.contentType, {
      category: "image",
      prefix: "platform-branding",
      fileName: safeName,
      publicRead: false,
      userId: authorization.actor.userId,
      source: "platform-branding",
      requireOwnershipRecord: true,
      meta: {
        purpose,
        sha256: digest,
        width: String(normalized.width),
        height: String(normalized.height),
      },
    });
    uploaded = { key: storage.key, provider: storage.provider };
    if (storage.size !== normalized.bytes.byteLength || storage.contentType !== validated.contentType) {
      throw new PlatformBrandValidationError("对象存储返回的品牌图元数据不一致", "BRAND_ASSET_STORAGE_MISMATCH");
    }

    const asset = await registerPlatformBrandAsset({
      purpose,
      storageProvider: storage.provider,
      storageKey: storage.key,
      sha256: digest,
      mimeType: validated.contentType as "image/png" | "image/jpeg" | "image/webp",
      bytes: normalized.bytes.byteLength,
      width: normalized.width,
      height: normalized.height,
      actorId: authorization.actor.userId,
      requestKey: key,
    });
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "brand.settings.manage",
      action: "platform_brand_asset_upload",
      result: "success",
      reasonCode: "BRAND_ASSET_UPLOAD_SUCCEEDED",
      resource: "platform_branding_asset",
      request,
      requestKey: key,
      metadata: { assetId: asset.id, purpose, bytes: asset.bytes, width: asset.width, height: asset.height },
    });
    return json({
      ok: true,
      asset: { ...asset, url: null },
      requestKey: key,
    }, 201);
  } catch (error) {
    if (uploaded) {
      await storageManager.delete(uploaded.key, uploaded.provider).catch((cleanupError) => {
        console.error("[branding] orphan cleanup failed", cleanupError instanceof Error ? cleanupError.message : cleanupError);
      });
    }
    const code = error instanceof PlatformBrandValidationError || error instanceof UploadValidationError
      ? error.code
      : platformBrandErrorCode(error);
    await appendPlatformBrandFailureEvent({
      action: "asset_upload",
      actorId: authorization.actor.userId,
      reasonCode: code,
      requestKey: key,
    });
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "brand.settings.manage",
      action: "platform_brand_asset_upload",
      result: "failure",
      reasonCode: code,
      resource: "platform_branding_asset",
      request,
      requestKey: key,
      metadata: {},
    });
    console.error("[branding] asset upload failed", { code });
    return errorResponse(error);
  }
}
