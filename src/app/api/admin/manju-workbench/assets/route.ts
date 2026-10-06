import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, type JWTPayload } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { safeUploadFileName, UploadValidationError, validateUploadBuffer } from "@/lib/file-upload-security";
import {
  ManjuAssetMutationError,
  replaceManjuPublicAssetFile,
  defaultManjuPublicAssetCategory,
  getManjuPublicAssetRegistryPath,
  inferManjuPublicAssetMediaType,
  listManjuPublicAssetsSync,
  registerManjuPublicAsset,
  softDeleteManjuPublicAsset,
  updateManjuPublicAsset,
  type ManjuPublicAssetCategory,
} from "@/lib/server/manju-public-asset-registry";
import { resetPublicCatalogCache } from "@/lib/youcai-public-catalog";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie",
} as const;

const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const CATEGORY_VALUES = new Set([
  "character",
  "scene",
  "prop",
  "style",
  "shot",
  "film",
  "music",
  "voice",
  "audio",
  "sound-effect",
  "image",
  "video",
  "other",
] as const);

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

async function requireAdmin(request: NextRequest): Promise<JWTPayload | NextResponse> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return json({ ok: false, code: "AUTH_REQUIRED", error: "请先登录" }, 401);
  const actor = await verifyAdminToken(token);
  if (!actor) return json({ ok: false, code: "AUTH_INVALID", error: "登录状态无效或已过期" }, 401);
  if (actor.role !== "admin") return json({ ok: false, code: "ADMIN_REQUIRED", error: "仅管理员可管理漫剧素材" }, 403);
  return actor;
}

function categoryFrom(value: FormDataEntryValue | null, fallback: ManjuPublicAssetCategory): ManjuPublicAssetCategory {
  return typeof value === "string" && CATEGORY_VALUES.has(value as ManjuPublicAssetCategory)
    ? value as ManjuPublicAssetCategory
    : fallback;
}

function shortText(value: FormDataEntryValue | unknown, fallback: string, max: number): string {
  return (typeof value === "string" ? value : fallback).replace(/\s+/g, " ").trim().slice(0, max) || fallback;
}

function longText(value: FormDataEntryValue | unknown, fallback: string, max: number): string {
  return (typeof value === "string" ? value : fallback).replace(/\r\n/g, "\n").trim().slice(0, max) || fallback;
}

function assetPayload() {
  const assets = listManjuPublicAssetsSync({ includeDisabled: true });
  return {
    ok: true,
    version: "manju-public-assets.v1",
    registryPath: getManjuPublicAssetRegistryPath(),
    count: assets.length,
    activeCount: assets.filter((asset) => asset.enabled && !asset.deletedAt).length,
    assets,
  };
}

export async function GET(request: NextRequest) {
  const actor = await requireAdmin(request);
  if (actor instanceof NextResponse) return actor;
  return json(assetPayload());
}

export async function POST(request: NextRequest) {
  const actor = await requireAdmin(request);
  if (actor instanceof NextResponse) return actor;

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return json({ ok: false, code: "CONTENT_LENGTH_REQUIRED", error: "缺少有效的请求大小" }, 411);
    }
    if (contentLength > MAX_ASSET_BYTES + 1024 * 1024) {
      return json({ ok: false, code: "REQUEST_TOO_LARGE", error: "请求体过大" }, 413);
    }

    if (listManjuPublicAssetsSync({ includeDisabled: true }).length >= 1_000) return json({ ok: false, code: "ASSET_REGISTRY_FULL", error: "素材目录已达到容量上限，请先整理素材" }, 409);
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return json({ ok: false, code: "FILE_REQUIRED", error: "请选择要上传的素材文件" }, 400);
    }
    if (file.size <= 0 || file.size > MAX_ASSET_BYTES) {
      return json({ ok: false, code: "FILE_TOO_LARGE", error: "素材文件必须在 100MB 以内" }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const validated = validateUploadBuffer(buffer, file.type || "application/octet-stream");
    const mediaType = inferManjuPublicAssetMediaType(validated.contentType);
    if (!["image", "video", "audio"].includes(mediaType)) {
      return json({ ok: false, code: "MEDIA_TYPE_UNSUPPORTED", error: "漫剧展示素材只接受图片、视频或音频" }, 415);
    }
    const category = categoryFrom(formData.get("category"), defaultManjuPublicAssetCategory(mediaType));
    const safeName = safeUploadFileName(validated.extension);
    const uploaded = await storageManager.upload(buffer, safeName, validated.contentType, {
      category: mediaType,
      prefix: `manju-${mediaType}`,
      fileName: safeName,
      publicRead: true,
      userId: actor.userId,
      source: "漫剧工作台后台素材上传",
      meta: {
        source: "manju-workbench-admin-upload",
        originalName: file.name.slice(0, 180),
      },
    });
    const asset = registerManjuPublicAsset({
      storageProvider: uploaded.provider,
      storageKey: uploaded.key,
      contentType: uploaded.contentType,
      size: uploaded.size,
      title: shortText(formData.get("title"), file.name.replace(/\.[^.]+$/u, "") || "后台上传素材", 120),
      summary: shortText(formData.get("summary"), "漫剧工作台后台上传并登记的公开素材。", 300),
      prompt: longText(formData.get("prompt"), "该素材由管理员上传，可作为漫剧工作台展示、参考图或画布示例素材。", 12_000),
      filename: file.name,
      createdBy: actor.userId,
      category,
    });
    resetPublicCatalogCache();
    return json({ ok: true, asset, registry: assetPayload() });
  } catch (error) {
    if (error instanceof ManjuAssetMutationError) return json({ ok: false, code: error.code, error: error.message }, error.status);
    if (error instanceof UploadValidationError) {
      return json({ ok: false, code: error.code, error: "文件内容或格式无效" }, 415);
    }
    console.error("[manju-assets] upload failed", error instanceof Error ? error.message : error);
    return json({ ok: false, code: "UPLOAD_FAILED", error: "素材上传或登记失败" }, 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await requireAdmin(request);
    if (actor instanceof NextResponse) return actor;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, code: "INVALID_JSON", error: "请求体不是有效 JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ ok: false, code: "INVALID_REQUEST", error: "请求参数不合法" }, 400);
    }
    const record = body as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!/^manju-[a-z0-9][a-z0-9_-]{8,120}$/u.test(id)) {
      return json({ ok: false, code: "INVALID_ASSET_ID", error: "素材编号无效" }, 400);
    }
    if (record.action === "replace-file") {
      const sourceAssetId = typeof record.sourceAssetId === "string" ? record.sourceAssetId : "";
      const expectedUpdatedAt = typeof record.expectedUpdatedAt === "string" ? record.expectedUpdatedAt : "";
      const expectedSourceUpdatedAt = typeof record.expectedSourceUpdatedAt === "string" ? record.expectedSourceUpdatedAt : "";
      if (!/^manju-[a-z0-9][a-z0-9_-]{8,120}$/u.test(sourceAssetId) || !expectedUpdatedAt || !expectedSourceUpdatedAt) {
        return json({ ok: false, code: "INVALID_REPLACEMENT", error: "请选择已登记的替换素材并刷新版本信息" }, 400);
      }
      const asset = replaceManjuPublicAssetFile(id, sourceAssetId, expectedUpdatedAt, expectedSourceUpdatedAt);
      resetPublicCatalogCache();
      return json({ ok: true, asset, registry: assetPayload() });
    }
    const patch = {
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
      ...(typeof record.category === "string" ? { category: record.category as ManjuPublicAssetCategory } : {}),
      ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    };
    const asset = updateManjuPublicAsset(id, patch);
    if (!asset) return json({ ok: false, code: "ASSET_NOT_FOUND", error: "素材不存在" }, 404);
    resetPublicCatalogCache();
    return json({ ok: true, asset, registry: assetPayload() });
  } catch (error) {
    if (error instanceof ManjuAssetMutationError) return json({ ok: false, code: error.code, error: error.message }, error.status);
    return json({ ok: false, code: "ASSET_UPDATE_FAILED", error: "素材更新失败，请稍后重试" }, 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await requireAdmin(request);
    if (actor instanceof NextResponse) return actor;
    const id = request.nextUrl.searchParams.get("id") || "";
    if (!/^manju-[a-z0-9][a-z0-9_-]{8,120}$/u.test(id)) {
      return json({ ok: false, code: "INVALID_ASSET_ID", error: "素材编号无效" }, 400);
    }
    const asset = softDeleteManjuPublicAsset(id);
    if (!asset) return json({ ok: false, code: "ASSET_NOT_FOUND", error: "素材不存在" }, 404);
    resetPublicCatalogCache();
    return json({ ok: true, asset, registry: assetPayload(), message: "素材已下线；文件本体未硬删除，避免误删导致页面断链。" });
  } catch (error) {
    if (error instanceof ManjuAssetMutationError) return json({ ok: false, code: error.code, error: error.message }, error.status);
    return json({ ok: false, code: "ASSET_UPDATE_FAILED", error: "素材更新失败，请稍后重试" }, 500);
  }
}
