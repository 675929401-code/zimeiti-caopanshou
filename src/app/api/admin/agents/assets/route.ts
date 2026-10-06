import crypto from "node:crypto";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import {
  UploadValidationError,
  safeUploadFileName,
  validateUploadBuffer,
} from "@/lib/file-upload-security";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const ORPHAN_GRACE_HOURS = 24;
const ORPHAN_SWEEP_LIMIT = 50;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
type AgentImagePurpose = "avatar" | "cover";

type OwnedAgentImageRow = {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_size: number;
  content_type: string;
  source: string;
  meta: Record<string, unknown> | null;
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function isPurpose(value: unknown): value is AgentImagePurpose {
  return value === "avatar" || value === "cover";
}

function validationError(error: unknown): NextResponse {
  if (error instanceof UploadValidationError) {
    return json({ success: false, error: "图片内容与格式不匹配", code: error.code }, 415);
  }
  const message = error instanceof Error ? error.message : "图片上传失败";
  const known = message.startsWith("AGENT_IMAGE_");
  return json({ success: false, error: known ? message.slice("AGENT_IMAGE_".length) : "图片上传失败", code: known ? message : "AGENT_IMAGE_UPLOAD_FAILED" }, known ? 400 : 500);
}

async function normalizeImage(source: Buffer, mimeType: string, purpose: AgentImagePurpose) {
  try {
    const image = sharp(source, { failOn: "error", limitInputPixels: MAX_PIXELS, animated: false });
    const metadata = await image.metadata();
    if ((metadata.pages || 1) !== 1) throw new Error("AGENT_IMAGE_仅支持单帧图片");
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);
    const minimum = purpose === "avatar" ? 64 : 180;
    if (width < minimum || height < minimum || width > 8192 || height > 8192) {
      throw new Error(`AGENT_IMAGE_${purpose === "avatar" ? "头像" : "背景图"}像素尺寸无效`);
    }
    const ratio = width / height;
    if (purpose === "avatar" && (ratio < 0.75 || ratio > 1.34)) {
      throw new Error("AGENT_IMAGE_头像长宽比应接近正方形（3:4 到 4:3）");
    }
    if (purpose === "cover" && (ratio < 1.2 || ratio > 2.5)) {
      throw new Error("AGENT_IMAGE_背景图长宽比应在 6:5 到 5:2 之间");
    }
    const pipeline = image.rotate();
    const bytes = mimeType === "image/png"
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : mimeType === "image/jpeg"
        ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : await pipeline.webp({ quality: 92, smartSubsample: true }).toBuffer();
    if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("AGENT_IMAGE_规范化后的图片必须在 5MB 以内");
    }
    const normalized = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
    return { bytes, width: Number(normalized.width || width), height: Number(normalized.height || height) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AGENT_IMAGE_")) throw error;
    throw new Error("AGENT_IMAGE_图片无法安全解码");
  }
}

function assertAgentImageKey(key: string, purpose?: AgentImagePurpose): void {
  const prefix = purpose ? `agent-images/${purpose}/` : "agent-images/";
  if (!key.startsWith(prefix)
    || key.length > 512
    || key.includes("://")
    || /[\\\u0000\r\n?#]/u.test(key)
    || key.split("/").includes("..")) {
    throw new Error("AGENT_IMAGE_对象存储 key 无效");
  }
}

async function readOwnedAsset(actorId: string, key: string): Promise<OwnedAgentImageRow | null> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("user_files")
    .select("id,storage_key,storage_provider,file_size,content_type,source,meta")
    .eq("user_id", actorId)
    .eq("storage_key", key)
    .eq("source", "agent-image-upload")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("AGENT_IMAGE_无法核验图片资产归属");
  return data as OwnedAgentImageRow | null;
}

async function verifyPersistedAsset(input: {
  actorId: string;
  key: string;
  provider: StorageProviderType;
  purpose: AgentImagePurpose;
  expectedBytes: Buffer;
  expectedMimeType: string;
  expectedWidth: number;
  expectedHeight: number;
  expectedDigest: string;
}): Promise<OwnedAgentImageRow> {
  assertAgentImageKey(input.key, input.purpose);
  const [head, storedBytes, owned] = await Promise.all([
    storageManager.head(input.key, input.provider),
    storageManager.read(input.key, input.provider),
    readOwnedAsset(input.actorId, input.key),
  ]);
  if (!head || !owned) throw new Error("AGENT_IMAGE_图片资产持久化回执缺失");
  if (head.size !== input.expectedBytes.byteLength
    || head.contentType !== input.expectedMimeType
    || owned.file_size !== input.expectedBytes.byteLength
    || owned.content_type !== input.expectedMimeType
    || owned.storage_provider !== input.provider) {
    throw new Error("AGENT_IMAGE_对象存储返回的图片元数据不一致");
  }
  if (storedBytes.byteLength !== input.expectedBytes.byteLength
    || storedBytes.byteLength > MAX_FILE_BYTES
    || crypto.createHash("sha256").update(storedBytes).digest("hex") !== input.expectedDigest) {
    throw new Error("AGENT_IMAGE_对象存储中的图片内容校验失败");
  }
  const detected = validateUploadBuffer(storedBytes, head.contentType);
  if (detected.contentType !== input.expectedMimeType) {
    throw new Error("AGENT_IMAGE_对象存储中的图片格式不一致");
  }
  const metadata = await sharp(storedBytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
  if (Number(metadata.width || 0) !== input.expectedWidth || Number(metadata.height || 0) !== input.expectedHeight) {
    throw new Error("AGENT_IMAGE_对象存储中的图片尺寸不一致");
  }
  const meta = owned.meta || {};
  if (String(meta.purpose || "") !== input.purpose
    || String(meta.sha256 || "") !== input.expectedDigest
    || String(meta.width || "") !== String(input.expectedWidth)
    || String(meta.height || "") !== String(input.expectedHeight)) {
    throw new Error("AGENT_IMAGE_图片资产元数据不完整");
  }
  return owned;
}

async function assetReferenceCount(key: string): Promise<number> {
  const db = getSupabaseAdminClient();
  const [avatarResult, coverResult] = await Promise.all([
    db.from("agents").select("id", { count: "exact", head: true }).eq("avatar", key),
    db.from("agents").select("id", { count: "exact", head: true }).eq("cover_url", key),
  ]);
  if (avatarResult.error || coverResult.error) {
    throw new Error("AGENT_IMAGE_无法核验图片引用状态");
  }
  return (avatarResult.count || 0) + (coverResult.count || 0);
}

async function deleteOwnedAsset(actorId: string, owned: OwnedAgentImageRow): Promise<void> {
  const removed = await storageManager.delete(owned.storage_key, owned.storage_provider);
  if (!removed) throw new Error("AGENT_IMAGE_对象存储删除失败");
  const db = getSupabaseAdminClient();
  const { error } = await db.from("user_files")
    .delete()
    .eq("id", owned.id)
    .eq("user_id", actorId)
    .eq("storage_key", owned.storage_key);
  if (error) throw new Error("AGENT_IMAGE_图片资产记录清理失败");
}

async function sweepOwnedOrphans(actorId: string, maxAgeHours = ORPHAN_GRACE_HOURS) {
  const db = getSupabaseAdminClient();
  const cutoff = new Date(Date.now() - Math.max(1, maxAgeHours) * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from("user_files")
    .select("id,storage_key,storage_provider,file_size,content_type,source,meta")
    .eq("user_id", actorId)
    .eq("source", "agent-image-upload")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(ORPHAN_SWEEP_LIMIT);
  if (error) throw new Error("AGENT_IMAGE_无法读取待清理图片");
  let deleted = 0;
  let inUse = 0;
  let failed = 0;
  for (const candidate of (data || []) as OwnedAgentImageRow[]) {
    try {
      assertAgentImageKey(candidate.storage_key);
      if (await assetReferenceCount(candidate.storage_key)) {
        inUse += 1;
        continue;
      }
      await deleteOwnedAsset(actorId, candidate);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: (data || []).length, deleted, inUse, failed, cutoff };
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "agents.manage", {
    operation: "agent_image_upload",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;

  let uploaded: { key: string; provider: StorageProviderType } | null = null;
  try {
    void sweepOwnedOrphans(authorization.actor.userId).catch((error) => {
      console.warn("[agent-images] opportunistic orphan sweep failed", error instanceof Error ? error.message : error);
    });
    if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      throw new Error("AGENT_IMAGE_请使用图片上传控件提交文件");
    }
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      throw new Error("AGENT_IMAGE_图片必须在 5MB 以内");
    }
    const form = await request.formData();
    const purpose = form.get("purpose");
    const file = form.get("file");
    if (!isPurpose(purpose)) throw new Error("AGENT_IMAGE_图片用途无效");
    if (!(file instanceof File)) throw new Error("AGENT_IMAGE_请选择图片");
    if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error("AGENT_IMAGE_图片必须在 5MB 以内");

    const original = Buffer.from(await file.arrayBuffer());
    if (original.byteLength !== file.size || original.byteLength > MAX_FILE_BYTES) {
      throw new Error("AGENT_IMAGE_图片大小校验失败");
    }
    const validated = validateUploadBuffer(original, file.type || "application/octet-stream");
    if (!ALLOWED_MIME_TYPES.has(validated.contentType)) {
      throw new Error("AGENT_IMAGE_只支持 PNG、JPEG 或 WebP");
    }
    const normalized = await normalizeImage(original, validated.contentType, purpose);
    const digest = crypto.createHash("sha256").update(normalized.bytes).digest("hex");
    const fileName = safeUploadFileName(validated.extension);
    const result = await storageManager.upload(normalized.bytes, fileName, validated.contentType, {
      category: "image",
      prefix: `agent-images/${purpose}/`,
      fileName,
      publicRead: false,
      userId: authorization.actor.userId,
      source: "agent-image-upload",
      requireOwnershipRecord: true,
      meta: {
        purpose,
        sha256: digest,
        width: String(normalized.width),
        height: String(normalized.height),
      },
    });
    uploaded = { key: result.key, provider: result.provider };
    const owned = await verifyPersistedAsset({
      actorId: authorization.actor.userId,
      key: result.key,
      provider: result.provider,
      purpose,
      expectedBytes: normalized.bytes,
      expectedMimeType: validated.contentType,
      expectedWidth: normalized.width,
      expectedHeight: normalized.height,
      expectedDigest: digest,
    });
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "agents.manage",
      action: "agent_image_upload",
      result: "success",
      reasonCode: "AGENT_IMAGE_UPLOAD_SUCCEEDED",
      resource: "agent_image",
      request,
      metadata: { purpose, assetId: owned.id, storageKey: result.key, bytes: result.size, width: normalized.width, height: normalized.height },
    });
    return json({
      success: true,
      asset: {
        assetId: owned.id,
        key: result.key,
        url: `/api/avatars?key=${encodeURIComponent(result.key)}`,
        purpose,
        mimeType: result.contentType,
        bytes: result.size,
        width: normalized.width,
        height: normalized.height,
      },
    }, 201);
  } catch (error) {
    if (uploaded) {
      await storageManager.delete(uploaded.key, uploaded.provider).catch(() => false);
      await getSupabaseAdminClient().from("user_files")
        .delete()
        .eq("user_id", authorization.actor.userId)
        .eq("storage_key", uploaded.key)
        .eq("source", "agent-image-upload")
        .then(() => undefined, () => undefined);
    }
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "agents.manage",
      action: "agent_image_upload",
      result: "failure",
      reasonCode: error instanceof Error ? error.message.slice(0, 120) : "AGENT_IMAGE_UPLOAD_FAILED",
      resource: "agent_image",
      request,
      metadata: {},
    });
    return validationError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "agents.manage", {
    operation: "agent_image_discard",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const payload = await request.json().catch(() => ({}));
    const key = String(payload?.key || "").trim();
    const requestedAssetId = String(payload?.assetId || "").trim();
    if (!key) return json({ success: false, error: "缺少图片 key", code: "AGENT_IMAGE_KEY_REQUIRED" }, 400);
    assertAgentImageKey(key);
    const owned = await readOwnedAsset(authorization.actor.userId, key);
    if (!owned) return json({ success: false, error: "图片不存在或不属于当前管理员", code: "AGENT_IMAGE_NOT_OWNED" }, 404);
    if (requestedAssetId && requestedAssetId !== owned.id) {
      return json({ success: false, error: "图片资产身份不匹配", code: "AGENT_IMAGE_ASSET_ID_MISMATCH" }, 409);
    }
    if (await assetReferenceCount(key)) {
      return json({ success: false, error: "图片正在被智能体使用，不能清理", code: "AGENT_IMAGE_IN_USE" }, 409);
    }
    await deleteOwnedAsset(authorization.actor.userId, owned);
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "agents.manage",
      action: "agent_image_discard",
      result: "success",
      reasonCode: "AGENT_IMAGE_DISCARDED",
      resource: "agent_image",
      request,
      metadata: { assetId: owned.id, storageKey: key },
    });
    return json({ success: true, deletedAssetId: owned.id });
  } catch (error) {
    console.error("[agent-images] discard failed", error instanceof Error ? error.message : error);
    return json({ success: false, error: "图片清理失败", code: "AGENT_IMAGE_DISCARD_FAILED" }, 500);
  }
}

export async function PUT(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "agents.manage", {
    operation: "agent_image_orphan_sweep",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const payload = await request.json().catch(() => ({}));
    const requestedHours = Number(payload?.maxAgeHours ?? ORPHAN_GRACE_HOURS);
    const maxAgeHours = Number.isFinite(requestedHours)
      ? Math.min(720, Math.max(1, Math.floor(requestedHours)))
      : ORPHAN_GRACE_HOURS;
    const result = await sweepOwnedOrphans(authorization.actor.userId, maxAgeHours);
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: authorization.access.adminLevel,
      permissionKey: "agents.manage",
      action: "agent_image_orphan_sweep",
      result: result.failed ? "failure" : "success",
      reasonCode: result.failed ? "AGENT_IMAGE_ORPHAN_SWEEP_PARTIAL" : "AGENT_IMAGE_ORPHAN_SWEEP_SUCCEEDED",
      resource: "agent_image",
      request,
      metadata: result,
    });
    return json({ success: result.failed === 0, ...result }, result.failed ? 207 : 200);
  } catch (error) {
    console.error("[agent-images] orphan sweep failed", error instanceof Error ? error.message : error);
    return json({ success: false, error: "孤立图片清理失败", code: "AGENT_IMAGE_ORPHAN_SWEEP_FAILED" }, 500);
  }
}
