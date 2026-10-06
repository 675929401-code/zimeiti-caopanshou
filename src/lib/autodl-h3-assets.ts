import type { FileCategory, StorageProviderType } from "@/storage/object";

const H3_ASSET_PREFIX = "object://tencent_cos/";
const MAX_ASSET_KEY_LENGTH = 1024;
const SIGNED_INPUT_TTL_SECONDS = 60 * 60;

type H3InputCategory = Extract<FileCategory, "image" | "audio" | "video">;

export class AutodlH3AssetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AutodlH3AssetError";
  }
}

export interface AutodlH3OwnedAsset {
  provider: "tencent_cos";
  key: string;
  category: H3InputCategory;
}

export interface AutodlH3AssetDependencies {
  findOwnedAsset(input: {
    userId: string;
    provider: "tencent_cos";
    key: string;
    category: H3InputCategory;
  }): Promise<AutodlH3OwnedAsset | null>;
  exists(asset: AutodlH3OwnedAsset): Promise<boolean>;
  sign(asset: AutodlH3OwnedAsset, expireTimeSeconds: number): Promise<string>;
}

export interface AutodlH3InputCandidates {
  imageUrl?: unknown;
  lastFrameUrl?: unknown;
  referenceImageUrl?: unknown;
  audioUrl?: unknown;
  imageUrls?: unknown;
  audioUrls?: unknown;
  sourceVideoUrl?: unknown;
}

export interface AutodlH3StableInputAssets {
  imageAssetRef?: string;
  lastFrameAssetRef?: string;
  referenceImageAssetRef?: string;
  audioAssetRef?: string;
  imageAssetRefs?: string[];
  audioAssetRefs?: string[];
  sourceVideoAssetRef?: string;
}

function decodeAtMostThreeTimes(value: string) {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function normalizeAssetKey(value: string) {
  const key = decodeAtMostThreeTimes(value).replace(/^\/+/, "");
  if (!key || key.length > MAX_ASSET_KEY_LENGTH || /[\\\u0000-\u001f]/u.test(key)) {
    throw new AutodlH3AssetError("H3_ASSET_REF_INVALID", "H3 输入资产引用无效");
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new AutodlH3AssetError("H3_ASSET_REF_INVALID", "H3 输入资产引用无效");
  }
  return key;
}

export function createAutodlH3AssetRef(provider: StorageProviderType, key: string) {
  if (provider !== "tencent_cos") {
    throw new AutodlH3AssetError("H3_ASSET_PROVIDER_UNSUPPORTED", "H3 冷启动队列只接受已持久化的腾讯云 COS 资产");
  }
  return `${H3_ASSET_PREFIX}${encodeURIComponent(normalizeAssetKey(key))}`;
}

export function parseAutodlH3AssetRef(value: unknown): { provider: "tencent_cos"; key: string } | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith(H3_ASSET_PREFIX) || /[?#]/u.test(raw)) return null;
  try {
    return { provider: "tencent_cos", key: normalizeAssetKey(raw.slice(H3_ASSET_PREFIX.length)) };
  } catch {
    return null;
  }
}

function candidateStorageKey(value: unknown) {
  const stable = parseAutodlH3AssetRef(value);
  if (stable) return stable.key;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // The upload route used by H3 returns this exact Tencent COS virtual-host
    // form. Ignore all query credentials and use only the object pathname as
    // an ownership lookup hint; arbitrary HTTPS origins are not accepted.
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/iu.test(url.hostname)) {
      return null;
    }
    return normalizeAssetKey(url.pathname);
  } catch {
    return null;
  }
}

async function defaultDependencies(): Promise<AutodlH3AssetDependencies> {
  const [{ getSupabaseAdminClient }, { storageManager }] = await Promise.all([
    import("@/storage/database/supabase-client"),
    import("@/storage/object"),
  ]);
  return {
    async findOwnedAsset(input) {
      const db = getSupabaseAdminClient();
      const { data, error } = await db
        .from("user_files")
        .select("storage_provider, storage_key, file_category")
        .eq("user_id", input.userId)
        .eq("storage_provider", input.provider)
        .eq("storage_key", input.key)
        .eq("file_category", input.category)
        .limit(1);
      if (error) throw new AutodlH3AssetError("H3_ASSET_OWNERSHIP_LOOKUP_FAILED", "H3 输入资产归属校验暂时不可用");
      if (!data?.[0]) return null;
      return { provider: "tencent_cos", key: String(data[0].storage_key), category: input.category };
    },
    async exists(asset) {
      return storageManager.exists(asset.key, asset.provider);
    },
    async sign(asset, expireTimeSeconds) {
      return storageManager.getSignedUrl(asset.key, { expireTime: expireTimeSeconds }, asset.provider);
    },
  };
}

async function requireOwnedAsset(
  userId: string,
  candidate: unknown,
  category: H3InputCategory,
  dependencies: AutodlH3AssetDependencies,
) {
  const key = candidateStorageKey(candidate);
  if (!key) {
    throw new AutodlH3AssetError(
      "H3_ASSET_NOT_OWNED",
      "AutoDL H3 冷启动任务只能使用本账号已上传的稳定资产，请通过上传按钮重新添加",
    );
  }
  const owned = await dependencies.findOwnedAsset({ userId, provider: "tencent_cos", key, category });
  if (!owned) {
    throw new AutodlH3AssetError(
      "H3_ASSET_NOT_OWNED",
      "AutoDL H3 冷启动任务只能使用本账号已上传的稳定资产，请通过上传按钮重新添加",
    );
  }
  return owned;
}

function values(input: unknown, limit: number) {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, limit);
}

/** Convert request URLs into durable, tenant-owned object refs before enqueue. */
export async function stabilizeAutodlH3InputAssets(
  input: { userId: string; candidates: AutodlH3InputCandidates },
  dependencies?: AutodlH3AssetDependencies,
): Promise<AutodlH3StableInputAssets> {
  const deps = dependencies || await defaultDependencies();
  const output: AutodlH3StableInputAssets = {};
  const one = async (candidate: unknown, category: H3InputCategory) => {
    if (typeof candidate !== "string" || !candidate.trim()) return undefined;
    const asset = await requireOwnedAsset(input.userId, candidate, category, deps);
    return createAutodlH3AssetRef(asset.provider, asset.key);
  };

  output.imageAssetRef = await one(input.candidates.imageUrl, "image");
  output.lastFrameAssetRef = await one(input.candidates.lastFrameUrl, "image");
  output.referenceImageAssetRef = await one(input.candidates.referenceImageUrl, "image");
  output.audioAssetRef = await one(input.candidates.audioUrl, "audio");
  output.sourceVideoAssetRef = await one(input.candidates.sourceVideoUrl, "video");
  output.imageAssetRefs = await Promise.all(values(input.candidates.imageUrls, 9).map(async (candidate) => {
    const asset = await requireOwnedAsset(input.userId, candidate, "image", deps);
    return createAutodlH3AssetRef(asset.provider, asset.key);
  }));
  output.audioAssetRefs = await Promise.all(values(input.candidates.audioUrls, 3).map(async (candidate) => {
    const asset = await requireOwnedAsset(input.userId, candidate, "audio", deps);
    return createAutodlH3AssetRef(asset.provider, asset.key);
  }));
  return output;
}

/** Resolve a stored object ref for an authenticated owner's UI preview. */
export async function signAutodlH3OwnedAssetRefForUser(
  input: { userId: string; assetRef: string; category: H3InputCategory },
  dependencies?: AutodlH3AssetDependencies,
) {
  if (!parseAutodlH3AssetRef(input.assetRef)) return input.assetRef;
  const deps = dependencies || await defaultDependencies();
  const owned = await requireOwnedAsset(input.userId, input.assetRef, input.category, deps);
  if (!await deps.exists(owned)) {
    throw new AutodlH3AssetError("H3_ASSET_MISSING", "H3 输入资产已不存在");
  }
  const signed = await deps.sign(owned, SIGNED_INPUT_TTL_SECONDS);
  if (candidateStorageKey(signed) !== owned.key) {
    throw new AutodlH3AssetError("H3_ASSET_SIGN_FAILED", "H3 输入资产无法生成安全预览地址");
  }
  return signed;
}

const LEGACY_URL_FIELDS = [
  "imageUrl", "lastFrameUrl", "referenceImageUrl", "audioUrl", "imageUrls", "audioUrls", "sourceVideoUrl",
] as const;

/** Re-validate ownership/existence and sign immediately before H3 dispatch. */
export async function resolveAutodlH3QueuedAssetPayload(
  input: { userId: string; payload: Record<string, unknown> },
  dependencies?: AutodlH3AssetDependencies,
) {
  const deps = dependencies || await defaultDependencies();
  for (const field of LEGACY_URL_FIELDS) {
    const value = input.payload[field];
    if ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && typeof value !== "undefined" && value !== null && value !== "")) {
      throw new AutodlH3AssetError("H3_LEGACY_URL_PAYLOAD_FORBIDDEN", "H3 队列中存在未稳定化的输入地址，已阻止派发");
    }
  }

  const result: Record<string, unknown> = { ...input.payload };
  const hydrate = async (ref: unknown, category: H3InputCategory) => {
    if (typeof ref !== "string" || !ref.trim()) return undefined;
    const parsed = parseAutodlH3AssetRef(ref);
    if (!parsed) throw new AutodlH3AssetError("H3_ASSET_REF_INVALID", "H3 输入资产引用无效");
    const owned = await requireOwnedAsset(input.userId, ref, category, deps);
    if (!await deps.exists(owned)) {
      throw new AutodlH3AssetError("H3_ASSET_MISSING", "H3 输入资产已不存在，已阻止派发");
    }
    const signed = await deps.sign(owned, SIGNED_INPUT_TTL_SECONDS);
    if (candidateStorageKey(signed) !== owned.key) {
      throw new AutodlH3AssetError("H3_ASSET_SIGN_FAILED", "H3 输入资产无法生成安全取件地址");
    }
    return signed;
  };

  const mapping: Array<[keyof AutodlH3StableInputAssets, string, H3InputCategory]> = [
    ["imageAssetRef", "imageUrl", "image"],
    ["lastFrameAssetRef", "lastFrameUrl", "image"],
    ["referenceImageAssetRef", "referenceImageUrl", "image"],
    ["audioAssetRef", "audioUrl", "audio"],
    ["sourceVideoAssetRef", "sourceVideoUrl", "video"],
  ];
  for (const [refField, urlField, category] of mapping) {
    const hydrated = await hydrate(input.payload[refField], category);
    delete result[refField];
    if (hydrated) result[urlField] = hydrated;
  }

  const imageRefs = values(input.payload.imageAssetRefs, 9);
  const audioRefs = values(input.payload.audioAssetRefs, 3);
  delete result.imageAssetRefs;
  delete result.audioAssetRefs;
  if (imageRefs.length) result.imageUrls = await Promise.all(imageRefs.map((ref) => hydrate(ref, "image")));
  if (audioRefs.length) result.audioUrls = await Promise.all(audioRefs.map((ref) => hydrate(ref, "audio")));
  return result;
}
