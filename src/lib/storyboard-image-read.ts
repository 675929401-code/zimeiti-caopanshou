import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { storageManager, type StorageProviderType } from "@/storage/object";

const SIGNED_URL_TTL_SECONDS = 15 * 60;
const ASSET_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const STORAGE_PROVIDERS = new Set<StorageProviderType>(["coze_s3", "tencent_cos", "local"]);

type OwnedImageAsset = {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: string;
  file_category: string;
};

export class StoryboardImageReadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoryboardImageReadError";
  }
}

export function parseStoryboardImageReadQuery(request: NextRequest) {
  const storageKey = request.nextUrl.searchParams.get("storageKey") || "";
  const assetId = request.nextUrl.searchParams.get("assetId") || "";
  if (storageKey && (
    storageKey.length > 2_048
    || storageKey.startsWith("/")
    || storageKey.startsWith("\\")
    || storageKey.includes("://")
    || /[\u0000\r\n\\]/u.test(storageKey)
    || storageKey.split("/").includes("..")
  )) {
    throw new StoryboardImageReadError("INVALID_STORAGE_KEY", 400, "图片存储标识无效");
  }
  if (assetId && !ASSET_ID.test(assetId)) {
    throw new StoryboardImageReadError("INVALID_ASSET_ID", 400, "图片资产标识无效");
  }
  if (!storageKey && !assetId) {
    throw new StoryboardImageReadError("IMAGE_REFERENCE_REQUIRED", 400, "请提供图片资产标识或存储标识");
  }
  return { storageKey: storageKey || undefined, assetId: assetId || undefined };
}

export async function resolveOwnedStoryboardImageUrl(input: {
  db: SupabaseClient;
  userId: string;
  storageKey?: string;
  assetId?: string;
  signer?: Pick<typeof storageManager, "getSignedUrl">;
}) {
  let lookup = input.db
    .from("user_files")
    .select("id,user_id,storage_key,storage_provider,file_category")
    .eq("user_id", input.userId)
    .eq("file_category", "image");
  if (input.storageKey) lookup = lookup.eq("storage_key", input.storageKey);
  if (input.assetId) lookup = lookup.eq("id", input.assetId);

  const result = await lookup.limit(2);
  if (result.error) {
    throw new StoryboardImageReadError("ASSET_LOOKUP_UNAVAILABLE", 503, "图片归属暂时无法确认，请稍后重试");
  }
  const assets = (result.data || []) as OwnedImageAsset[];
  if (!assets.length) {
    throw new StoryboardImageReadError("IMAGE_NOT_FOUND", 404, "图片不存在或无权访问");
  }
  if (!input.assetId && assets.length > 1) {
    throw new StoryboardImageReadError("ASSET_ID_REQUIRED", 409, "同一存储标识存在多条图片记录，请携带资产标识重试");
  }

  const asset = assets[0];
  if (
    asset.user_id !== input.userId
    || (input.storageKey && asset.storage_key !== input.storageKey)
    || asset.file_category !== "image"
    || (input.assetId && asset.id !== input.assetId)
  ) {
    throw new StoryboardImageReadError("IMAGE_NOT_FOUND", 404, "图片不存在或无权访问");
  }
  if (!STORAGE_PROVIDERS.has(asset.storage_provider as StorageProviderType)) {
    throw new StoryboardImageReadError("INVALID_STORAGE_PROVIDER", 503, "图片存储配置无效，请联系管理员");
  }

  try {
    const url = await (input.signer || storageManager).getSignedUrl(
      asset.storage_key,
      { expireTime: SIGNED_URL_TTL_SECONDS },
      asset.storage_provider as StorageProviderType,
    );
    return { url, assetId: asset.id, storageKey: asset.storage_key };
  } catch {
    throw new StoryboardImageReadError("IMAGE_SIGNING_UNAVAILABLE", 503, "图片暂时无法读取，请稍后重试");
  }
}
