import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withAuth } from "@/lib/api-middleware";
import { storageManager, type StorageProviderType } from "@/storage/object";
import { GeneratedImageReferenceError } from "@/lib/server/generated-image-reference";
import { parseVisualAssetLabels, parseVisualAssetQuery, queryVisualAssetLibrary, resolveStoryboardVisualAssetReference } from "@/lib/server/storyboard-visual-asset-reference";

export const dynamic = "force-dynamic";

const ROLES = new Set(["character", "pet", "environment", "prop"]);
const ID = /^[A-Za-z0-9:_-]{8,160}$/u;
const MAX_NAME = 120;
const MAX_PROMPT = 50_000;
const SCENE_ID = /^[a-z][a-z0-9_-]{2,63}$/u;
const ASSET_ID = /^[A-Za-z0-9:_-]{1,200}$/u;
const CAMERA_COVERAGES = new Set(["wide", "front", "side", "reverse", "detail"]);

type VisualAssetMeta = {
  enabled?: boolean;
  role?: string;
  name?: string;
  prompt?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  customCategory?: string;
  sceneId?: string;
  sceneZone?: string;
  cameraCoverage?: "wide" | "front" | "side" | "reverse" | "detail";
  fixedAnchors?: string[];
  allowedSegmentKinds?: string[];
  derivedFromAssetId?: string;
};
type AssetRow = {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_size?: number;
  content_type?: string;
  source?: string;
  meta?: Record<string, unknown> | null;
  created_at: string;
};

function errorResponse(message = "视觉资产暂时无法读取", status = 503) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function visualMeta(meta: unknown): VisualAssetMeta | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).storyboardVisualAsset;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const role = String(record.role || "").trim();
  if (!ROLES.has(role) || record.enabled === false) return null;
  return {
    enabled: true,
    role,
    name: String(record.name || "").trim().slice(0, MAX_NAME),
    prompt: String(record.prompt || "").slice(0, MAX_PROMPT),
    projectId: String(record.projectId || "").trim(),
    createdAt: String(record.createdAt || "").trim(),
    updatedAt: String(record.updatedAt || "").trim(),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12).map((tag) => tag.slice(0, 32)) : [],
    customCategory: typeof record.customCategory === "string" ? record.customCategory.slice(0, 40) : "",
    ...(typeof record.sceneId === "string" && SCENE_ID.test(record.sceneId) ? { sceneId: record.sceneId } : {}),
    ...(typeof record.sceneZone === "string" && record.sceneZone.trim() ? { sceneZone: record.sceneZone.trim().slice(0, 80) } : {}),
    ...(typeof record.cameraCoverage === "string" && CAMERA_COVERAGES.has(record.cameraCoverage) ? { cameraCoverage: record.cameraCoverage as VisualAssetMeta["cameraCoverage"] } : {}),
    ...(Array.isArray(record.fixedAnchors) && record.fixedAnchors.length ? { fixedAnchors: record.fixedAnchors.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 16).map((value) => value.slice(0, 160)) } : {}),
    ...(Array.isArray(record.allowedSegmentKinds) && record.allowedSegmentKinds.length ? { allowedSegmentKinds: record.allowedSegmentKinds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 24).map((value) => value.slice(0, 80)) } : {}),
    ...(typeof record.derivedFromAssetId === "string" && ASSET_ID.test(record.derivedFromAssetId) ? { derivedFromAssetId: record.derivedFromAssetId } : {}),
  };
}

async function toPublicAsset(row: AssetRow, meta: VisualAssetMeta | null) {
  const previewUrl = await storageManager.getSignedUrl(row.storage_key, { expireTime: 3600 }, row.storage_provider);
  return {
    assetId: row.id,
    classified: meta !== null,
    storageKey: row.storage_key,
    previewUrl,
    name: meta?.name || "未命名视觉资产",
    role: meta?.role || "prop",
    prompt: meta?.prompt || "",
    projectId: meta?.projectId || "",
    createdAt: meta?.createdAt || row.created_at,
    updatedAt: meta?.updatedAt || row.created_at,
    fileSize: Number(row.file_size || 0),
    contentType: String(row.content_type || ""),
    tags: meta?.tags || [],
    customCategory: meta?.customCategory || "",
    ...(meta?.sceneId ? { sceneId: meta.sceneId } : {}),
    ...(meta?.sceneZone ? { sceneZone: meta.sceneZone } : {}),
    ...(meta?.cameraCoverage ? { cameraCoverage: meta.cameraCoverage } : {}),
    ...(meta?.fixedAnchors?.length ? { fixedAnchors: meta.fixedAnchors } : {}),
    ...(meta?.allowedSegmentKinds?.length ? { allowedSegmentKinds: meta.allowedSegmentKinds } : {}),
    ...(meta?.derivedFromAssetId ? { derivedFromAssetId: meta.derivedFromAssetId } : {}),
  };
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    try {
      const parsed = parseVisualAssetQuery(request.nextUrl.searchParams);
      if ("recordId" in parsed) {
        return NextResponse.json(await resolveStoryboardVisualAssetReference(user.id, parsed.recordId), { headers: { "Cache-Control": "private, no-store" } });
      }
      const { role, offset, limit, includeUnclassified } = parsed;
      const result = await queryVisualAssetLibrary(db, user.id, parsed);
      if (result.error) throw result.error;
      const rows = (result.data || []) as AssetRow[];
      const assets = await Promise.all(rows.flatMap((row) => {
        const meta = visualMeta(row.meta);
        if (!meta && !includeUnclassified) return [];
        if (role && (meta?.role || "prop") !== role) return [];
        return [toPublicAsset(row, meta).catch(() => null)];
      }));
      const count = result.count ?? rows.length;
      const hasMore = offset + rows.length < count;
      const nextOffset = hasMore ? offset + limit : null;
      return NextResponse.json({ assets: assets.filter(Boolean), count, hasMore, nextOffset, nextPage: nextOffset }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof GeneratedImageReferenceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
      console.error("[Storyboard/VisualAssets] GET failed", error instanceof Error ? error.message : "UNKNOWN");
      return errorResponse();
    }
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const assetId = String(body?.assetId || "").trim();
    const role = String(body?.role || "").trim();
    const name = String(body?.name || "").trim().slice(0, MAX_NAME);
    const prompt = String(body?.prompt || "").slice(0, MAX_PROMPT);
    const projectId = String(body?.projectId || "").trim();
    if (!ID.test(assetId) || !ROLES.has(role)) return errorResponse("视觉资产标识或类别无效", 400);
    if (projectId && !ID.test(projectId)) return errorResponse("视觉资产项目标识无效", 400);
    try {
      const labels = parseVisualAssetLabels(body || {});
      const sceneId = String(body?.sceneId || "").trim();
      const sceneZone = String(body?.sceneZone || "").trim().slice(0, 80);
      const cameraCoverage = String(body?.cameraCoverage || "").trim();
      const fixedAnchorsValue = body?.fixedAnchors;
      const fixedAnchors = Array.isArray(fixedAnchorsValue) ? fixedAnchorsValue.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 16).map((value) => value.trim().slice(0, 160)) : [];
      const allowedSegmentKindsValue = body?.allowedSegmentKinds;
      const allowedSegmentKinds = Array.isArray(allowedSegmentKindsValue) ? allowedSegmentKindsValue.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 24).map((value) => value.trim().slice(0, 80)) : [];
      const derivedFromAssetId = String(body?.derivedFromAssetId || "").trim();
      if (sceneId && !SCENE_ID.test(sceneId)) return errorResponse("场景标识无效", 400);
      if (cameraCoverage && !CAMERA_COVERAGES.has(cameraCoverage)) return errorResponse("场景机位无效", 400);
      if (derivedFromAssetId && !ASSET_ID.test(derivedFromAssetId)) return errorResponse("来源资产标识无效", 400);
      const existing = await db.from("user_files")
        .select("id,storage_key,storage_provider,file_size,content_type,source,meta,created_at")
        .eq("id", assetId).eq("user_id", user.id).eq("file_category", "image").maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) return errorResponse("图片资产不存在或不属于当前账号", 403);
      const row = existing.data as AssetRow;
      const previousMeta = visualMeta(row.meta);
      const now = new Date().toISOString();
      const nextMeta = {
        ...((row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)) ? row.meta : {}),
        storyboardVisualAsset: { enabled: true, role, name: name || "未命名视觉资产", prompt, projectId,
          tags: body && "tags" in body ? labels.tags : previousMeta?.tags || [],
          customCategory: body && "customCategory" in body ? labels.customCategory : previousMeta?.customCategory || "",
          ...(sceneId ? { sceneId } : previousMeta?.sceneId ? { sceneId: previousMeta.sceneId } : {}),
          ...(sceneZone ? { sceneZone } : previousMeta?.sceneZone ? { sceneZone: previousMeta.sceneZone } : {}),
          ...(cameraCoverage ? { cameraCoverage } : previousMeta?.cameraCoverage ? { cameraCoverage: previousMeta.cameraCoverage } : {}),
          ...(body && "fixedAnchors" in body ? { fixedAnchors } : previousMeta?.fixedAnchors ? { fixedAnchors: previousMeta.fixedAnchors } : {}),
          ...(body && "allowedSegmentKinds" in body ? { allowedSegmentKinds } : previousMeta?.allowedSegmentKinds ? { allowedSegmentKinds: previousMeta.allowedSegmentKinds } : {}),
          ...(derivedFromAssetId ? { derivedFromAssetId } : previousMeta?.derivedFromAssetId ? { derivedFromAssetId: previousMeta.derivedFromAssetId } : {}),
          createdAt: previousMeta?.createdAt || now, updatedAt: now },
      };
      const updated = await db.from("user_files").update({ meta: nextMeta }).eq("id", assetId).eq("user_id", user.id).select("id,storage_key,storage_provider,file_size,content_type,source,meta,created_at").maybeSingle();
      if (updated.error) throw updated.error;
      if (!updated.data) return errorResponse("视觉资产保存未确认，请稍后重试", 503);
      return NextResponse.json({ asset: await toPublicAsset(updated.data as AssetRow, visualMeta((updated.data as AssetRow).meta)) });
    } catch (error) {
      if (error instanceof GeneratedImageReferenceError) return errorResponse(error.message, error.status);
      console.error("[Storyboard/VisualAssets] POST failed", error instanceof Error ? error.message : "UNKNOWN");
      return errorResponse("视觉资产保存暂时失败，请稍后重试");
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    const assetId = String(request.nextUrl.searchParams.get("assetId") || "").trim();
    if (!ID.test(assetId)) return errorResponse("视觉资产标识无效", 400);
    const row = await db.from("user_files").select("id,meta").eq("id", assetId).eq("user_id", user.id).eq("file_category", "image").maybeSingle();
    if (row.error) return errorResponse();
    if (!row.data) return errorResponse("视觉资产不存在或不属于当前账号", 403);
    const meta = row.data.meta && typeof row.data.meta === "object" && !Array.isArray(row.data.meta) ? row.data.meta as Record<string, unknown> : {};
    const updated = await db.from("user_files").update({ meta: { ...meta, storyboardVisualAsset: { enabled: false, updatedAt: new Date().toISOString() } } }).eq("id", assetId).eq("user_id", user.id);
    if (updated.error) return errorResponse("视觉资产移出收藏失败");
    return NextResponse.json({ ok: true });
  });
}
