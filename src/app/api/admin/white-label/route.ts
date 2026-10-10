import crypto from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";

import {
  PlatformBrandValidationError,
} from "@/lib/branding/contracts";
import type { AdminLevel } from "@/lib/admin-governance";
import {
  UploadValidationError,
  safeUploadFileName,
  validateUploadBuffer,
} from "@/lib/file-upload-security";
import { appendAdminGovernanceAudit, authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  WhiteLabelAuthorityError,
  publishWhiteLabelDraft,
  readWhiteLabelAdminState,
  registerWhiteLabelAsset,
  recordWhiteLabelDomainVerification,
  saveWhiteLabelDraft,
} from "@/lib/server/white-label-profile";
import {
  WhiteLabelValidationError,
  parseWhiteLabelAssetUploadFields,
  parseWhiteLabelDraftInput,
  parseWhiteLabelPublicationInput,
  parseWhiteLabelVerificationInput,
} from "@/lib/white-label-profile-contract";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Cookie" };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const ACCEPTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function requestKey(request: NextRequest): string {
  const supplied = (request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "").trim();
  return (supplied.length >= 8 ? supplied : crypto.randomUUID()).slice(0, 200);
}

function cnameTarget(): string | null {
  for (const candidate of [process.env.WHITE_LABEL_CNAME_TARGET, process.env.APP_BASE_URL, process.env.NEXT_PUBLIC_SITE_URL]) {
    if (!candidate?.trim()) continue;
    try {
      const hostname = candidate.includes("://") ? new URL(candidate).hostname : candidate.trim().replace(/\.$/u, "");
      if (hostname && hostname !== "localhost" && isIP(hostname) === 0 && hostname.includes(".")) return hostname.toLowerCase();
    } catch { /* try the next configured source */ }
  }
  return null;
}

function errorResponse(error: unknown) {
  if (error instanceof UploadValidationError) return json({ ok: false, error: "白标品牌图片内容或格式无效", code: error.code }, 415);
  if (error instanceof PlatformBrandValidationError) return json({ ok: false, error: error.message, code: error.code }, 400);
  if (error instanceof WhiteLabelValidationError) return json({ ok: false, error: error.message, code: error.code }, 400);
  if (error instanceof WhiteLabelAuthorityError) {
    const status = error.code === "WHITE_LABEL_REVISION_CONFLICT" ? 409
      : error.code === "WHITE_LABEL_PROFILE_NOT_FOUND" ? 404
        : error.code === "WHITE_LABEL_MIGRATION_REQUIRED" ? 503
          : 500;
    return json({ ok: false, error: error.message, code: error.code }, status);
  }
  return json({ ok: false, error: "贴牌配置操作失败", code: "WHITE_LABEL_UNKNOWN_FAILURE" }, 500);
}

async function normalizedWhiteLabelImage(
  source: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  try {
    const input = sharp(source, { failOn: "error", limitInputPixels: MAX_PIXELS, animated: false });
    const sourceMetadata = await input.metadata();
    if ((sourceMetadata.pages || 1) !== 1) {
      throw new WhiteLabelValidationError("白标品牌图仅支持单帧图片", "WHITE_LABEL_ASSET_ANIMATION_FORBIDDEN");
    }
    const sourceWidth = Number(sourceMetadata.width || 0);
    const sourceHeight = Number(sourceMetadata.height || 0);
    if (sourceWidth < 16 || sourceHeight < 16 || sourceWidth > 8192 || sourceHeight > 8192) {
      throw new WhiteLabelValidationError("白标品牌图宽高必须在 16 到 8192 像素之间", "WHITE_LABEL_ASSET_DIMENSIONS_INVALID");
    }
    const pipeline = input.rotate();
    const bytes = mimeType === "image/png"
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : mimeType === "image/jpeg"
        ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : await pipeline.webp({ quality: 92, smartSubsample: true }).toBuffer();
    if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) {
      throw new WhiteLabelValidationError("白标品牌图必须在 5MB 以内", "WHITE_LABEL_ASSET_TOO_LARGE");
    }
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
    return { bytes, width: Number(metadata.width || 0), height: Number(metadata.height || 0) };
  } catch (error) {
    if (error instanceof WhiteLabelValidationError) throw error;
    throw new WhiteLabelValidationError("白标品牌图片无法安全解码", "WHITE_LABEL_ASSET_DECODE_FAILED");
  }
}

async function uploadWhiteLabelAsset(params: {
  request: NextRequest;
  actorId: string;
  actorLevel: AdminLevel | null;
  requestKey: string;
}) {
  const declaredLength = Number(params.request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new WhiteLabelValidationError("白标品牌图必须在 5MB 以内", "WHITE_LABEL_ASSET_TOO_LARGE");
  }
  const form = await params.request.formData();
  if (form.get("action") !== "upload-asset") {
    throw new WhiteLabelValidationError("不支持的贴牌操作", "WHITE_LABEL_ACTION_INVALID");
  }
  const fields = parseWhiteLabelAssetUploadFields({
    profileId: form.get("profileId"),
    expectedRevision: form.get("expectedRevision"),
    purpose: form.get("purpose"),
  });
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1 || file.size > MAX_FILE_BYTES) {
    throw new WhiteLabelValidationError("请选择 5MB 以内的白标品牌图片", "WHITE_LABEL_ASSET_FILE_REQUIRED");
  }
  const original = Buffer.from(await file.arrayBuffer());
  const validated = validateUploadBuffer(original, file.type || "application/octet-stream");
  if (!ACCEPTED_MIME_TYPES.has(validated.contentType)) {
    throw new WhiteLabelValidationError("白标品牌图只支持 PNG、JPEG 或 WebP", "WHITE_LABEL_ASSET_TYPE_UNSUPPORTED");
  }
  const normalized = await normalizedWhiteLabelImage(original, validated.contentType);
  const digest = crypto.createHash("sha256").update(normalized.bytes).digest("hex");
  const safeName = safeUploadFileName(validated.extension);
  let uploaded: { key: string; provider: StorageProviderType } | null = null;
  try {
    const storage = await storageManager.upload(normalized.bytes, safeName, validated.contentType, {
      category: "image",
      prefix: `white-label/${fields.profileId}`,
      fileName: safeName,
      publicRead: false,
      userId: params.actorId,
      source: "white-label-branding",
      requireOwnershipRecord: true,
      meta: { profileId: fields.profileId, purpose: fields.purpose, sha256: digest },
    });
    uploaded = { key: storage.key, provider: storage.provider };
    if (storage.size !== normalized.bytes.byteLength || storage.contentType !== validated.contentType) {
      throw new WhiteLabelValidationError("对象存储返回的白标品牌图元数据不一致", "WHITE_LABEL_ASSET_STORAGE_MISMATCH");
    }
    const asset = await registerWhiteLabelAsset({
      ...fields,
      storageProvider: storage.provider,
      storageKey: storage.key,
      sha256: digest,
      mimeType: validated.contentType as "image/png" | "image/jpeg" | "image/webp",
      bytes: normalized.bytes.byteLength,
      width: normalized.width,
      height: normalized.height,
      actorId: params.actorId,
      requestKey: params.requestKey,
    });
    if (asset.replayed && uploaded && uploaded.key !== asset.storageKey) {
      await storageManager.delete(uploaded.key, uploaded.provider).catch(() => undefined);
      uploaded = null;
    }
    await appendAdminGovernanceAudit({
      actorId: params.actorId, actorLevel: params.actorLevel,
      permissionKey: "white_label.manage", action: "white_label_asset_upload", result: "success",
      reasonCode: asset.replayed ? "WHITE_LABEL_ASSET_UPLOAD_REPLAYED" : "WHITE_LABEL_ASSET_UPLOAD_SUCCEEDED",
      resource: "white_label_asset", request: params.request, requestKey: params.requestKey,
      metadata: { profileId: fields.profileId, assetId: asset.id, purpose: asset.purpose },
    });
    return json({
      ok: true,
      asset: {
        id: asset.id,
        profileId: asset.profileId,
        purpose: asset.purpose,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        width: asset.width,
        height: asset.height,
        sha256: asset.sha256,
        createdAt: asset.createdAt,
        replayed: asset.replayed,
        url: null,
      },
      requestKey: params.requestKey,
    }, 201);
  } catch (error) {
    if (uploaded) await storageManager.delete(uploaded.key, uploaded.provider).catch(() => undefined);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "white_label.manage", { operation: "white_label_profile_read" });
  if (!authorization.ok) return authorization.response;
  try {
    return json({ ok: true, state: await readWhiteLabelAdminState(), cnameTarget: cnameTarget() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "white_label.manage", {
    operation: "white_label_profile_write",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  const key = requestKey(request);
  let action = "invalid";
  try {
    if ((request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      action = "upload-asset";
      return await uploadWhiteLabelAsset({
        request,
        actorId: authorization.actor.userId,
        actorLevel: authorization.access.adminLevel,
        requestKey: key,
      });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    action = body.action === "verify-domain" ? "verify-domain"
      : body.action === "save-draft" ? "save-draft"
        : body.action === "publish" ? "publish"
          : "invalid";
    if (action === "save-draft") {
      const draft = parseWhiteLabelDraftInput(body);
      const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
      const receipt = await saveWhiteLabelDraft({ draft, tokenHash, actorId: authorization.actor.userId, requestKey: key });
      await appendAdminGovernanceAudit({
        actorId: authorization.actor.userId, actorLevel: authorization.access.adminLevel,
        permissionKey: "white_label.manage", action: "white_label_draft_save", result: "success",
        reasonCode: "WHITE_LABEL_DRAFT_SAVED", resource: "white_label_profile", request, requestKey: key,
        metadata: { profileId: receipt.profileId, revision: receipt.revision },
      });
      return json({ ok: true, receipt });
    }
    if (action === "publish") {
      const publication = parseWhiteLabelPublicationInput(body);
      const receipt = await publishWhiteLabelDraft({
        ...publication,
        actorId: authorization.actor.userId,
        requestKey: key,
      });
      await appendAdminGovernanceAudit({
        actorId: authorization.actor.userId, actorLevel: authorization.access.adminLevel,
        permissionKey: "white_label.manage", action: "white_label_publish", result: "success",
        reasonCode: "WHITE_LABEL_BRAND_PUBLISHED", resource: "white_label_profile", request, requestKey: key,
        metadata: { profileId: publication.profileId, publishedReleaseId: receipt.publishedReleaseId, generation: receipt.generation },
      });
      return json({ ok: true, receipt });
    }
    if (action !== "verify-domain") throw new WhiteLabelValidationError("不支持的贴牌操作", "WHITE_LABEL_ACTION_INVALID");

    const verification = parseWhiteLabelVerificationInput(body);
    const state = await readWhiteLabelAdminState();
    const target = state.profiles.find((item) => item.profileId === verification.profileId);
    if (!target) throw new WhiteLabelAuthorityError("贴牌配置不存在或已失效", "WHITE_LABEL_PROFILE_NOT_FOUND");
    if (target.revision !== verification.expectedRevision) {
      throw new WhiteLabelAuthorityError("该贴牌配置已被其他窗口更新，请刷新后再验证", "WHITE_LABEL_REVISION_CONFLICT");
    }
    const expectedValue = `zimeiti-verification=${target.expectedTxtValue}`;
    let observed: string[] = [];
    let dnsErrorCode = "";
    try {
      const rows = await Promise.race([
        resolveTxt(target.expectedTxtName),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS_LOOKUP_TIMEOUT")), 8_000)),
      ]);
      observed = rows.map((parts) => parts.join("").trim()).filter(Boolean).sort();
    } catch (error) {
      dnsErrorCode = String((error as { code?: string; message?: string })?.code || (error as Error)?.message || "DNS_LOOKUP_FAILED")
        .toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 120);
    }
    const passed = observed.includes(expectedValue) || observed.includes(target.expectedTxtValue);
    if (!passed && !dnsErrorCode) dnsErrorCode = "DNS_VALUE_MISMATCH";
    const observedValuesHash = crypto.createHash("sha256").update(JSON.stringify(observed)).digest("hex");
    const evidenceSha256 = crypto.createHash("sha256").update(JSON.stringify({
      recordName: target.expectedTxtName,
      expectedValueHash: crypto.createHash("sha256").update(expectedValue).digest("hex"),
      observedValuesHash,
      passed,
      resolver: "node:dns/promises.resolveTxt",
    })).digest("hex");
    const receipt = await recordWhiteLabelDomainVerification({
      profileId: target.profileId,
      expectedRevision: target.revision,
      passed,
      observedValuesHash,
      evidenceSha256,
      resolverName: "node:dns/promises.resolveTxt",
      errorCode: dnsErrorCode,
      actorId: authorization.actor.userId,
      requestKey: key,
    });
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId, actorLevel: authorization.access.adminLevel,
      permissionKey: "white_label.manage", action: "white_label_domain_verify",
      result: passed ? "success" : "failure", reasonCode: passed ? "DNS_OWNERSHIP_VERIFIED" : dnsErrorCode,
      resource: "white_label_profile", request, requestKey: key,
      metadata: { profileId: target.profileId, hostname: target.hostname, observedValueCount: observed.length },
    });
    return json({ ok: true, verified: passed, receipt, errorCode: passed ? null : dnsErrorCode });
  } catch (error) {
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId, actorLevel: authorization.access.adminLevel,
      permissionKey: "white_label.manage", action: `white_label_${action.replaceAll("-", "_")}`,
      result: "failure", reasonCode: error instanceof WhiteLabelValidationError || error instanceof WhiteLabelAuthorityError ? error.code : "WHITE_LABEL_UNKNOWN_FAILURE",
      resource: "white_label_profile", request, requestKey: key,
    });
    return errorResponse(error);
  }
}
