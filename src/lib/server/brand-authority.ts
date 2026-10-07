import "server-only";

import crypto from "node:crypto";
import {
  PLATFORM_BRAND_PROFILE_ID,
  extractPlatformBrandAssetIds,
  isPlatformBrandAssetPurpose,
  legacyPlatformBrandPayload,
  parsePlatformBrandPayload,
  stableLegacyBrandImageUrl,
  type PlatformBrandAssetPurpose,
  type PlatformBrandPayload,
  type PublicPlatformBrandAsset,
  type PublicPlatformBranding,
} from "@/lib/branding/contracts";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import type { StorageProviderType } from "@/storage/object";

export class PlatformBrandAuthorityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PlatformBrandAuthorityError";
  }
}

export interface PlatformBrandRevisionSummary {
  id: string;
  revisionVersion: number;
  status: "draft" | "published";
  brand: PlatformBrandPayload;
  snapshotSha256: string;
  parentRevisionId: string | null;
  rollbackTargetId: string | null;
  createdBy: string;
  publishedBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface PlatformBrandAssetSummary {
  id: string;
  purpose: PlatformBrandAssetPurpose;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
  createdBy: string;
  published: boolean;
  url: string | null;
}

export interface PlatformBrandEventSummary {
  id: number;
  actorId: string | null;
  action: "asset_upload" | "draft_save" | "publish" | "rollback";
  result: "success" | "failure";
  reasonCode: string;
  revisionId: string | null;
  assetId: string | null;
  generation: number | null;
  requestKey: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AdminPlatformBrandingState {
  migrationRequired: boolean;
  generation: number;
  draft: PlatformBrandRevisionSummary | null;
  published: PlatformBrandRevisionSummary | null;
  revisions: PlatformBrandRevisionSummary[];
  assets: PlatformBrandAssetSummary[];
  events: PlatformBrandEventSummary[];
  publicBranding: PublicPlatformBranding;
}

export interface PublishedPlatformBrandAssetSource {
  id: string;
  storageProvider: StorageProviderType;
  storageKey: string;
  sha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
}

export interface RegisteredPlatformBrandAsset {
  id: string;
  purpose: PlatformBrandAssetPurpose;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
}

type BrandEventAction = PlatformBrandEventSummary["action"];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value, -1);
  if (parsed < 1) throw new PlatformBrandAuthorityError(`${field} 数据无效`, "BRAND_DATA_INVALID");
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return text(object(error).message) || String(error || "");
}

function errorCode(error: unknown): string {
  return text(object(error).code);
}

function controlPlaneUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  const message = errorText(error).toLowerCase();
  return ["42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || /platform_brand_(?:profiles|revisions|assets|events)/u.test(message) && /does not exist|not find|schema cache/u.test(message)
    || /could not find the function .*platform_brand/u.test(message);
}

function authorityFailure(error: unknown): PlatformBrandAuthorityError {
  if (error instanceof PlatformBrandAuthorityError) return error;
  const message = errorText(error);
  const markers: Array<[string, string, string]> = [
    ["PLATFORM_BRAND_GENERATION_CONFLICT", "BRAND_GENERATION_CONFLICT", "品牌配置已被其他管理员更新，请刷新后重试"],
    ["PLATFORM_BRAND_REVISION_NOT_FOUND", "BRAND_REVISION_NOT_FOUND", "品牌修订不存在"],
    ["PLATFORM_BRAND_REVISION_NOT_CURRENT_DRAFT", "BRAND_REVISION_NOT_CURRENT_DRAFT", "该修订已不是当前草稿"],
    ["PLATFORM_BRAND_ROLLBACK_TARGET_INVALID", "BRAND_ROLLBACK_TARGET_INVALID", "只能回滚到已发布的历史版本"],
    ["PLATFORM_BRAND_ALREADY_CURRENT", "BRAND_ALREADY_CURRENT", "该修订已经是当前发布版本"],
    ["PLATFORM_BRAND_ASSET_REFERENCE_MISSING", "BRAND_ASSET_REFERENCE_MISSING", "草稿引用的品牌资产不存在"],
    ["PLATFORM_BRAND_ASSET_REFERENCE_INVALID", "BRAND_ASSET_REFERENCE_INVALID", "草稿引用的品牌资产用途不匹配"],
    ["PLATFORM_BRAND_ASSET_INVALID", "BRAND_ASSET_INVALID", "品牌资产元数据无效"],
  ];
  for (const [marker, code, publicMessage] of markers) {
    if (message.includes(marker)) return new PlatformBrandAuthorityError(publicMessage, code, error);
  }
  if (controlPlaneUnavailable(error)) {
    return new PlatformBrandAuthorityError("品牌中心数据库迁移尚未应用", "BRAND_MIGRATION_REQUIRED", error);
  }
  return new PlatformBrandAuthorityError("品牌中心数据操作失败", "BRAND_AUTHORITY_FAILURE", error);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalize(source[key])]));
}

export function platformBrandSnapshotSha256(payload: PlatformBrandPayload): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function publicAssetUrl(assetId: string): string {
  return `/api/branding/assets/${assetId}`;
}

async function readLegacyPlatformBranding(): Promise<PublicPlatformBranding> {
  const { data, error } = await getSupabaseAdminClient()
    .from("platform_settings")
    .select("setting_key,setting_value")
    .in("setting_key", ["platform_name", "platform_cover", "welcome_message"]);
  if (error) throw authorityFailure(error);
  const settings: Record<string, string> = {};
  for (const row of data || []) {
    if (typeof row?.setting_key === "string" && typeof row?.setting_value === "string") {
      settings[row.setting_key] = row.setting_value;
    }
  }
  const rawLogo = settings.platform_cover?.trim() || "";
  const legacyLogoUrl = stableLegacyBrandImageUrl(rawLogo);
  return {
    source: "legacy",
    generation: 0,
    revisionId: null,
    revisionVersion: null,
    publishedAt: null,
    brand: legacyPlatformBrandPayload(settings),
    assets: {},
    ...(legacyLogoUrl ? { legacyLogoUrl } : {}),
    ...(rawLogo && !legacyLogoUrl ? { legacyLogoOmitted: true } : {}),
  };
}

function publicBrandingFromPublished(value: unknown): PublicPlatformBranding {
  const row = object(value);
  const brand = parsePlatformBrandPayload(row.snapshot);
  const rawAssets = object(row.assets);
  const assets: Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>> = {};

  for (const { purpose, assetId } of extractPlatformBrandAssetIds(brand)) {
    const raw = object(rawAssets[purpose]);
    const id = text(raw.id).toLowerCase();
    const mimeType = text(raw.mimeType || raw.mime_type);
    const sha256 = text(raw.sha256).toLowerCase();
    if (
      id !== assetId
      || !isUuid(id)
      || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
      || !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new PlatformBrandAuthorityError("已发布品牌资产合同无效", "BRAND_DATA_INVALID");
    }
    assets[purpose] = {
      id,
      purpose,
      url: publicAssetUrl(id),
      mimeType: mimeType as PublicPlatformBrandAsset["mimeType"],
      width: positiveInteger(raw.width, "品牌资产宽度"),
      height: positiveInteger(raw.height, "品牌资产高度"),
      bytes: positiveInteger(raw.bytes, "品牌资产大小"),
      sha256,
    };
  }

  const revisionId = text(row.revisionId || row.revision_id).toLowerCase();
  if (!isUuid(revisionId)) throw new PlatformBrandAuthorityError("已发布品牌修订编号无效", "BRAND_DATA_INVALID");
  return {
    source: "published",
    generation: integer(row.generation),
    revisionId,
    revisionVersion: positiveInteger(row.revisionVersion || row.revision_version, "品牌修订版本"),
    publishedAt: nullableText(row.publishedAt || row.published_at),
    brand,
    assets,
  };
}

/**
 * 品牌控制面 schema 缺席判定（2026-10-08 R868 生产修复）。
 * 生产数据库尚未应用 platform_brand_* 迁移时 RPC 返回 PGRST202，
 * 语义等价于"该站点从未发布过品牌修订"——回退 legacy platform_settings
 * 是设计内行为（与 RPC 返回 null 相同）。控制面已安装但调用失败
 * （如连接错误、权限错误）依然 503，不触发本回退。
 */
function isPlatformBrandSchemaAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string; details?: string };
  const code = String(value.code || "");
  const message = `${value.message || ""} ${value.details || ""}`;
  return ["42P01", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || /read_published_platform_brand/iu.test(message);
}

export async function readPublishedPlatformBranding(): Promise<PublicPlatformBranding> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("read_published_platform_brand");
    if (error) {
      if (isPlatformBrandSchemaAbsent(error)) return readLegacyPlatformBranding();
      throw error;
    }
    // The RPC returning null is the only authoritative proof that this site
    // has never published a brand revision. Legacy settings are strictly a
    // pre-first-publish compatibility source; control-plane failures must not
    // revive stale legacy branding after a publication.
    if (!data) return readLegacyPlatformBranding();
    return publicBrandingFromPublished(data);
  } catch (error) {
    throw authorityFailure(error);
  }
}

function revisionSummary(value: unknown): PlatformBrandRevisionSummary {
  const row = object(value);
  const id = text(row.id).toLowerCase();
  const status = row.status === "draft" || row.status === "published" ? row.status : null;
  if (!isUuid(id) || !status) throw new PlatformBrandAuthorityError("品牌修订记录无效", "BRAND_DATA_INVALID");
  return {
    id,
    revisionVersion: positiveInteger(row.revision_version, "品牌修订版本"),
    status,
    brand: parsePlatformBrandPayload(row.snapshot),
    snapshotSha256: text(row.snapshot_sha256),
    parentRevisionId: nullableText(row.parent_revision_id),
    rollbackTargetId: nullableText(row.rollback_target_id),
    createdBy: text(row.created_by),
    publishedBy: nullableText(row.published_by),
    createdAt: text(row.created_at),
    publishedAt: nullableText(row.published_at),
  };
}

export async function readAdminPlatformBrandingState(): Promise<AdminPlatformBrandingState> {
  const client = getSupabaseAdminClient();
  try {
    const profileResult = await client.from("platform_brand_profiles")
      .select("generation,draft_revision_id,published_revision_id")
      .eq("id", PLATFORM_BRAND_PROFILE_ID)
      .maybeSingle();
    if (profileResult.error) throw profileResult.error;
    if (!profileResult.data) throw new PlatformBrandAuthorityError("品牌中心数据库迁移尚未应用", "BRAND_MIGRATION_REQUIRED");

    const [revisionResult, assetResult, eventResult, publicBranding] = await Promise.all([
      client.from("platform_brand_revisions")
        .select("id,revision_version,status,snapshot,snapshot_sha256,parent_revision_id,rollback_target_id,created_by,published_by,created_at,published_at")
        .eq("profile_id", PLATFORM_BRAND_PROFILE_ID)
        .order("revision_version", { ascending: false })
        .limit(50),
      client.from("platform_brand_assets")
        .select("id,purpose,sha256,mime_type,bytes,width,height,created_by,created_at")
        .eq("profile_id", PLATFORM_BRAND_PROFILE_ID)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
      client.from("platform_brand_events")
        .select("id,actor_id,action,result,reason_code,revision_id,asset_id,generation,request_key,details,created_at")
        .eq("profile_id", PLATFORM_BRAND_PROFILE_ID)
        .order("created_at", { ascending: false })
        .limit(100),
      readPublishedPlatformBranding(),
    ]);
    if (revisionResult.error) throw revisionResult.error;
    if (assetResult.error) throw assetResult.error;
    if (eventResult.error) throw eventResult.error;

    const revisions: PlatformBrandRevisionSummary[] = ((revisionResult.data || []) as unknown[]).map(revisionSummary);
    const profile = object(profileResult.data);
    const draftId = text(profile.draft_revision_id);
    const publishedId = text(profile.published_revision_id);
    const publishedAssetIds = new Set(Object.values(publicBranding.assets).flatMap((asset) => asset ? [asset.id] : []));
    const assets = ((assetResult.data || []) as unknown[]).map((raw): PlatformBrandAssetSummary => {
      const row = object(raw);
      const id = text(row.id).toLowerCase();
      const purpose = row.purpose;
      const mimeType = text(row.mime_type);
      if (!isUuid(id) || !isPlatformBrandAssetPurpose(purpose) || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
        throw new PlatformBrandAuthorityError("品牌资产记录无效", "BRAND_DATA_INVALID");
      }
      const published = publishedAssetIds.has(id);
      return {
        id,
        purpose,
        mimeType: mimeType as PlatformBrandAssetSummary["mimeType"],
        bytes: positiveInteger(row.bytes, "品牌资产大小"),
        width: positiveInteger(row.width, "品牌资产宽度"),
        height: positiveInteger(row.height, "品牌资产高度"),
        sha256: text(row.sha256),
        createdAt: text(row.created_at),
        createdBy: text(row.created_by),
        published,
        url: published ? publicAssetUrl(id) : null,
      };
    });
    const events = ((eventResult.data || []) as unknown[]).map((raw): PlatformBrandEventSummary => {
      const row = object(raw);
      const action = row.action;
      const result = row.result;
      if (!(["asset_upload", "draft_save", "publish", "rollback"] as unknown[]).includes(action)
          || !(["success", "failure"] as unknown[]).includes(result)) {
        throw new PlatformBrandAuthorityError("品牌事件记录无效", "BRAND_DATA_INVALID");
      }
      return {
        id: positiveInteger(row.id, "品牌事件编号"),
        actorId: nullableText(row.actor_id),
        action: action as PlatformBrandEventSummary["action"],
        result: result as PlatformBrandEventSummary["result"],
        reasonCode: text(row.reason_code),
        revisionId: nullableText(row.revision_id),
        assetId: nullableText(row.asset_id),
        generation: row.generation == null ? null : integer(row.generation),
        requestKey: text(row.request_key),
        details: object(row.details),
        createdAt: text(row.created_at),
      };
    });

    return {
      migrationRequired: false,
      generation: integer(profile.generation),
      draft: revisions.find((revision) => revision.id === draftId) || null,
      published: revisions.find((revision) => revision.id === publishedId) || null,
      revisions,
      assets,
      events,
      publicBranding,
    };
  } catch (error) {
    if (!controlPlaneUnavailable(error) && !(error instanceof PlatformBrandAuthorityError && error.code === "BRAND_MIGRATION_REQUIRED")) {
      throw authorityFailure(error);
    }
    return {
      migrationRequired: true,
      generation: 0,
      draft: null,
      published: null,
      revisions: [],
      assets: [],
      events: [],
      publicBranding: await readLegacyPlatformBranding(),
    };
  }
}

async function brandRpc(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseAdminClient().rpc(name, params);
  if (error) throw authorityFailure(error);
  return object(data);
}

export async function savePlatformBrandDraft(params: {
  expectedGeneration: number;
  brand: PlatformBrandPayload;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  return brandRpc("save_platform_brand_draft_atomic", {
    p_expected_generation: params.expectedGeneration,
    p_snapshot: params.brand,
    p_snapshot_sha256: platformBrandSnapshotSha256(params.brand),
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
}

export async function publishPlatformBrandRevision(params: {
  expectedGeneration: number;
  revisionId: string;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  return brandRpc("publish_platform_brand_revision_atomic", {
    p_expected_generation: params.expectedGeneration,
    p_revision_id: params.revisionId,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
}

export async function rollbackPlatformBrandRevision(params: {
  expectedGeneration: number;
  revisionId: string;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  return brandRpc("rollback_platform_brand_revision_atomic", {
    p_expected_generation: params.expectedGeneration,
    p_revision_id: params.revisionId,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
}

export async function registerPlatformBrandAsset(params: {
  purpose: PlatformBrandAssetPurpose;
  storageProvider: StorageProviderType;
  storageKey: string;
  sha256: string;
  mimeType: RegisteredPlatformBrandAsset["mimeType"];
  bytes: number;
  width: number;
  height: number;
  actorId: string;
  requestKey: string;
}): Promise<RegisteredPlatformBrandAsset> {
  const row = await brandRpc("register_platform_brand_asset_atomic", {
    p_purpose: params.purpose,
    p_storage_provider: params.storageProvider,
    p_storage_key: params.storageKey,
    p_sha256: params.sha256,
    p_mime_type: params.mimeType,
    p_bytes: params.bytes,
    p_width: params.width,
    p_height: params.height,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
  const id = text(row.id).toLowerCase();
  if (!isUuid(id)) throw new PlatformBrandAuthorityError("品牌资产登记返回无效", "BRAND_DATA_INVALID");
  return {
    id,
    purpose: params.purpose,
    mimeType: params.mimeType,
    bytes: params.bytes,
    width: params.width,
    height: params.height,
    sha256: params.sha256,
    createdAt: text(row.createdAt || row.created_at),
  };
}

export async function appendPlatformBrandFailureEvent(params: {
  action: BrandEventAction;
  actorId: string;
  reasonCode: string;
  requestKey: string;
  revisionId?: string | null;
  assetId?: string | null;
}): Promise<void> {
  try {
    const { error } = await getSupabaseAdminClient().from("platform_brand_events").insert({
      profile_id: PLATFORM_BRAND_PROFILE_ID,
      actor_id: params.actorId,
      action: params.action,
      result: "failure",
      reason_code: params.reasonCode.slice(0, 120),
      revision_id: params.revisionId || null,
      asset_id: params.assetId || null,
      request_key: params.requestKey.slice(0, 200),
      details: {},
    });
    if (error) throw error;
  } catch (error) {
    console.error("[branding] failure audit unavailable", errorText(error));
  }
}

function platformBrandAssetSource(
  raw: unknown,
  requestedAssetId: string,
): PublishedPlatformBrandAssetSource {
    const row = object(raw);
    const id = text(row.id).toLowerCase();
    const storageProvider = text(row.storage_provider);
    const storageKey = text(row.storage_key);
    const mimeType = text(row.mime_type);
    const sha256 = text(row.sha256).toLowerCase();
    if (
      id !== requestedAssetId.toLowerCase()
      || !isUuid(id)
      || !["coze_s3", "tencent_cos", "local"].includes(storageProvider)
      || !storageKey
      || storageKey.length > 1024
      || /^(?:https?:)?\/\//iu.test(storageKey)
      || /[?#]/u.test(storageKey)
      || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
      || !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new PlatformBrandAuthorityError("品牌资产读取合同无效", "BRAND_DATA_INVALID");
    }
    return {
      id,
      storageProvider: storageProvider as StorageProviderType,
      storageKey,
      sha256,
      mimeType: mimeType as PublishedPlatformBrandAssetSource["mimeType"],
      bytes: positiveInteger(row.bytes, "品牌资产大小"),
      width: positiveInteger(row.width, "品牌资产宽度"),
      height: positiveInteger(row.height, "品牌资产高度"),
    };
}

/**
 * Read any non-deleted platform-brand asset for the protected administrator
 * preview route. Public callers must continue to use the published-only RPC.
 */
export async function readAdminPlatformBrandAsset(assetId: string): Promise<PublishedPlatformBrandAssetSource | null> {
  if (!isUuid(assetId.toLowerCase())) return null;
  try {
    const { data, error } = await getSupabaseAdminClient()
      .from("platform_brand_assets")
      .select("id,storage_provider,storage_key,sha256,mime_type,bytes,width,height")
      .eq("profile_id", PLATFORM_BRAND_PROFILE_ID)
      .eq("id", assetId.toLowerCase())
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    return data ? platformBrandAssetSource(data, assetId) : null;
  } catch (error) {
    throw authorityFailure(error);
  }
}

export async function readPublishedPlatformBrandAsset(assetId: string): Promise<PublishedPlatformBrandAssetSource | null> {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc("read_published_platform_brand_asset", {
      p_asset_id: assetId,
    });
    if (error) throw error;
    const raw = Array.isArray(data) ? data[0] : data;
    return raw ? platformBrandAssetSource(raw, assetId) : null;
  } catch (error) {
    throw authorityFailure(error);
  }
}

export function platformBrandErrorCode(error: unknown): string {
  return error instanceof PlatformBrandAuthorityError ? error.code : "BRAND_UNKNOWN_FAILURE";
}
