import "server-only";

import crypto from "node:crypto";

import {
  extractPlatformBrandAssetIds,
  parsePlatformBrandPayload,
  type PlatformBrandAssetPurpose,
  type PlatformBrandPayload,
  type PublicPlatformBrandAsset,
} from "@/lib/branding/contracts";
import {
  readPublishedPlatformBrandAsset,
  readPublishedPlatformBranding,
  type PublishedPlatformBrandAssetSource,
} from "@/lib/server/brand-authority";
import {
  WhiteLabelHostError,
  isPlatformDisplayHost,
  normalizeDirectHostHeader,
} from "@/lib/white-label-host";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import type { StorageProviderType } from "@/storage/object";

export interface HostResolvedPublicBranding {
  displayScope: "platform" | "white_label";
  hostname: string;
  source: "published" | "legacy";
  generation: number;
  revisionId: string | null;
  revisionVersion: number | null;
  publishedAt: string | null;
  brand: PlatformBrandPayload;
  assets: Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>>;
  legacyLogoUrl?: string;
  legacyLogoOmitted?: boolean;
}

export interface ResolvedDisplayBrand {
  hostname: string;
  scope: "platform" | "white_label";
  branding: HostResolvedPublicBranding;
  revisionToken: string;
}

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export interface DisplayBrandReaders {
  readPlatform(): Promise<Awaited<ReturnType<typeof readPublishedPlatformBranding>>>;
  readWhiteLabel(hostname: string): Promise<{ data: unknown; error: unknown }>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new WhiteLabelHostError("已发布白标品牌数据无效", "WHITE_LABEL_PUBLIC_DATA_INVALID", 503);
  }
  return parsed;
}

function uuid(value: unknown): string {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new WhiteLabelHostError("已发布白标品牌修订无效", "WHITE_LABEL_PUBLIC_DATA_INVALID", 503);
  }
  return normalized;
}

function revisionAssetUrl(
  assetId: string,
  revisionToken: string,
): string {
  return `/api/branding/assets/${assetId}?revision=${encodeURIComponent(revisionToken)}`;
}

function withRevisionUrls(
  assets: Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>>,
  revisionToken: string,
): Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>> {
  return Object.fromEntries(Object.entries(assets).map(([purpose, asset]) => [
    purpose,
    { ...asset, url: revisionAssetUrl(asset.id, revisionToken) },
  ])) as Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>>;
}

function parseWhiteLabelBrand(value: unknown, expectedHostname: string): HostResolvedPublicBranding {
  const row = object(value);
  if (text(row.hostname) !== expectedHostname || text(row.source) !== "white_label") {
    throw new WhiteLabelHostError("已发布白标 Host 合同无效", "WHITE_LABEL_PUBLIC_DATA_INVALID", 503);
  }
  const revisionId = uuid(row.revisionId);
  const generation = positiveInteger(row.generation);
  const brand = parsePlatformBrandPayload(row.snapshot);
  const rawAssets = object(row.assets);
  const assets: Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>> = {};
  for (const { purpose, assetId } of extractPlatformBrandAssetIds(brand)) {
    const raw = object(rawAssets[purpose]);
    const id = uuid(raw.id);
    const mimeType = text(raw.mimeType);
    const sha256 = text(raw.sha256).toLowerCase();
    if (id !== assetId || !["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new WhiteLabelHostError("已发布白标资产合同无效", "WHITE_LABEL_PUBLIC_DATA_INVALID", 503);
    }
    assets[purpose] = {
      id,
      purpose,
      url: revisionAssetUrl(id, revisionId),
      mimeType: mimeType as PublicPlatformBrandAsset["mimeType"],
      bytes: positiveInteger(raw.bytes),
      width: positiveInteger(raw.width),
      height: positiveInteger(raw.height),
      sha256,
    };
  }
  return {
    displayScope: "white_label",
    hostname: expectedHostname,
    source: "published",
    generation,
    revisionId,
    revisionVersion: positiveInteger(row.revisionVersion),
    publishedAt: text(row.publishedAt) || null,
    brand,
    assets,
  };
}

export async function resolveDisplayBrandWithReaders(
  hostHeader: string | null,
  readers: DisplayBrandReaders,
): Promise<ResolvedDisplayBrand> {
  // Host is a display-brand selector only. It must never become a tenant
  // identity or a business-data authorization claim.
  const hostname = normalizeDirectHostHeader(hostHeader);
  if (isPlatformDisplayHost(hostname)) {
    const platform = await readers.readPlatform();
    const revisionToken = platform.revisionId || `legacy-${platform.generation}`;
    return {
      hostname,
      scope: "platform",
      revisionToken,
      branding: {
        ...platform,
        displayScope: "platform",
        hostname,
        assets: withRevisionUrls(platform.assets, revisionToken),
      },
    };
  }

  const { data, error } = await readers.readWhiteLabel(hostname);
  if (error) {
    throw new WhiteLabelHostError("白标品牌运行态暂不可读取", "WHITE_LABEL_RUNTIME_UNAVAILABLE", 503);
  }
  if (!data) {
    throw new WhiteLabelHostError("该 Host 未登记或尚未发布", "BRAND_HOST_NOT_PUBLISHED", 421);
  }
  const branding = parseWhiteLabelBrand(data, hostname);
  return { hostname, scope: "white_label", revisionToken: branding.revisionId!, branding };
}

export async function resolveDisplayBrand(hostHeader: string | null): Promise<ResolvedDisplayBrand> {
  return resolveDisplayBrandWithReaders(hostHeader, {
    readPlatform: readPublishedPlatformBranding,
    readWhiteLabel: async (hostname) => (getSupabaseAdminClient() as unknown as RpcClient).rpc(
      "read_published_white_label_brand",
      { p_hostname: hostname },
    ),
  });
}

function parseAssetSource(raw: unknown, expectedAssetId: string): PublishedPlatformBrandAssetSource {
  const row = object(raw);
  const id = uuid(row.id);
  const storageProvider = text(row.storage_provider);
  const storageKey = text(row.storage_key);
  const mimeType = text(row.mime_type);
  const sha256 = text(row.sha256).toLowerCase();
  if (
    id !== expectedAssetId
    || !["coze_s3", "tencent_cos", "local"].includes(storageProvider)
    || !storageKey || storageKey.length > 1024 || /^(?:https?:)?\/\//iu.test(storageKey) || /[?#]/u.test(storageKey)
    || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
    || !/^[a-f0-9]{64}$/u.test(sha256)
  ) {
    throw new WhiteLabelHostError("白标资产读取合同无效", "WHITE_LABEL_PUBLIC_DATA_INVALID", 503);
  }
  return {
    id,
    storageProvider: storageProvider as StorageProviderType,
    storageKey,
    mimeType: mimeType as PublishedPlatformBrandAssetSource["mimeType"],
    sha256,
    bytes: positiveInteger(row.bytes),
    width: positiveInteger(row.width),
    height: positiveInteger(row.height),
  };
}

export async function readResolvedPublishedAsset(
  resolution: ResolvedDisplayBrand,
  assetId: string,
): Promise<PublishedPlatformBrandAssetSource | null> {
  if (!displayBrandOwnsAsset(resolution, assetId)) return null;
  if (resolution.scope === "platform") return readPublishedPlatformBrandAsset(assetId);
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc(
    "read_published_white_label_asset",
    {
      p_hostname: resolution.hostname,
      p_release_id: resolution.branding.revisionId,
      p_asset_id: assetId,
    },
  );
  if (error) throw new WhiteLabelHostError("白标品牌资产暂不可读取", "WHITE_LABEL_RUNTIME_UNAVAILABLE", 503);
  const raw = Array.isArray(data) ? data[0] : data;
  return raw ? parseAssetSource(raw, assetId) : null;
}

export function displayBrandOwnsAsset(resolution: ResolvedDisplayBrand, assetId: string): boolean {
  return Object.values(resolution.branding.assets).some((asset) => asset?.id === assetId);
}

export function displayBrandCacheKey(resolution: ResolvedDisplayBrand): string {
  const hostHash = crypto.createHash("sha256").update(resolution.hostname).digest("hex").slice(0, 16);
  return `${hostHash}-${resolution.revisionToken}`;
}
