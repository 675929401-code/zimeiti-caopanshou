import { parseAutodlH3AssetRef } from "@/lib/autodl-h3-assets";

export const VIDEO_REFERENCE_UPLOAD_SOURCE = "video-page-reference";

export type VideoReferenceCategory = "image" | "audio";
export type VideoReferenceCleanupClaimState = "claimed" | "object_deleted" | "completed";

export interface VideoReferenceAssetRow {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: string;
  file_category: string;
  source: string | null;
  meta: Record<string, unknown> | null;
}

export interface VideoReferenceCleanupIdentity {
  assetRef: string;
  rowId: string;
  key: string;
  provider: "tencent_cos";
  userId: string;
  source: typeof VIDEO_REFERENCE_UPLOAD_SOURCE;
  category: VideoReferenceCategory;
  uploadSession: string;
}

export interface VideoReferenceCleanupDependencies {
  findAssetsByKey(input: { key: string; provider: "tencent_cos" }): Promise<VideoReferenceAssetRow[]>;
  claimCleanup(input: VideoReferenceCleanupIdentity): Promise<VideoReferenceCleanupClaimState>;
  deleteObjectOnly(key: string, provider: "tencent_cos"): Promise<boolean>;
  markObjectDeleted(input: VideoReferenceCleanupIdentity): Promise<boolean>;
  completeMetadataCleanup(input: VideoReferenceCleanupIdentity): Promise<boolean>;
  recordCleanupFailure(input: VideoReferenceCleanupIdentity, errorCode: string): Promise<void>;
}

export class VideoReferenceCleanupError extends Error {
  constructor(
    readonly code:
      | "VIDEO_REFERENCE_DELETE_INVALID"
      | "VIDEO_REFERENCE_DELETE_AMBIGUOUS"
      | "VIDEO_REFERENCE_DELETE_FORBIDDEN"
      | "VIDEO_REFERENCE_DELETE_ACTIVE_TASK"
      | "VIDEO_REFERENCE_DELETE_STORAGE_FAILED"
      | "VIDEO_REFERENCE_DELETE_METADATA_FAILED"
      | "VIDEO_REFERENCE_DELETE_CLAIM_FAILED",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VideoReferenceCleanupError";
  }
}

const SESSION_PATTERN = /^[a-zA-Z0-9_-]{16,96}$/u;

function expectedPrefix(category: VideoReferenceCategory) {
  return category === "audio" ? "video-audio-inputs/" : "video-inputs/";
}

function safeDecode(value: string) {
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function tencentCosUrlKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/iu.test(url.hostname)) {
      return null;
    }
    const key = safeDecode(url.pathname).replace(/^\/+/, "");
    if (!key || /[\\\u0000-\u001f]/u.test(key) || key.split("/").some((segment) => segment === "." || segment === "..")) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

async function persistFailure(
  dependencies: VideoReferenceCleanupDependencies,
  identity: VideoReferenceCleanupIdentity,
  errorCode: string,
) {
  try {
    await dependencies.recordCleanupFailure(identity, errorCode);
  } catch {
    // The durable claim still blocks a later reservation. Preserve the
    // original cleanup failure instead of masking it with telemetry failure.
  }
}

export async function cleanupVideoReferenceAsset(
  input: {
    userId: string;
    assetRef: string;
    candidateUrl: string;
    category: VideoReferenceCategory;
    uploadSession: string;
  },
  dependencies: VideoReferenceCleanupDependencies,
) {
  const parsed = parseAutodlH3AssetRef(input.assetRef);
  if (input.assetRef.length > 1200 || input.candidateUrl.length > 4096
    || !parsed || !SESSION_PATTERN.test(input.uploadSession) || tencentCosUrlKey(input.candidateUrl) !== parsed.key) {
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_INVALID", "参考素材删除请求无效", 400);
  }

  const assets = await dependencies.findAssetsByKey({ key: parsed.key, provider: parsed.provider });
  if (assets.length === 0) return { deleted: false, alreadyDeleted: true } as const;
  if (assets.length !== 1) {
    throw new VideoReferenceCleanupError(
      "VIDEO_REFERENCE_DELETE_AMBIGUOUS",
      "参考素材记录不唯一，已停止删除",
      409,
    );
  }
  const asset = assets[0];

  const uploadSession = String(asset.meta?.videoPageUploadSession || "");
  const allowed = asset.user_id === input.userId
    && asset.storage_provider === parsed.provider
    && asset.source === VIDEO_REFERENCE_UPLOAD_SOURCE
    && asset.file_category === input.category
    && asset.storage_key === parsed.key
    && asset.storage_key.startsWith(expectedPrefix(input.category))
    && uploadSession === input.uploadSession;
  if (!allowed) {
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_FORBIDDEN", "无权删除该参考素材", 403);
  }

  const identity: VideoReferenceCleanupIdentity = {
    assetRef: input.assetRef,
    rowId: asset.id,
    key: asset.storage_key,
    provider: parsed.provider,
    userId: input.userId,
    source: VIDEO_REFERENCE_UPLOAD_SOURCE,
    category: input.category,
    uploadSession: input.uploadSession,
  };
  const claimState = await dependencies.claimCleanup(identity);
  if (claimState === "completed") return { deleted: false, alreadyDeleted: true } as const;

  if (claimState !== "object_deleted") {
    if (!await dependencies.deleteObjectOnly(identity.key, identity.provider)) {
      await persistFailure(dependencies, identity, "VIDEO_REFERENCE_DELETE_STORAGE_FAILED");
      throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_STORAGE_FAILED", "参考素材暂时无法删除", 503);
    }
    if (!await dependencies.markObjectDeleted(identity)) {
      await persistFailure(dependencies, identity, "VIDEO_REFERENCE_DELETE_OBJECT_STATE_FAILED");
      throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_METADATA_FAILED", "参考素材清理状态暂时无法保存", 503);
    }
  }

  if (!await dependencies.completeMetadataCleanup(identity)) {
    await persistFailure(dependencies, identity, "VIDEO_REFERENCE_DELETE_METADATA_FAILED");
    throw new VideoReferenceCleanupError("VIDEO_REFERENCE_DELETE_METADATA_FAILED", "参考素材记录暂时无法清理", 503);
  }

  return { deleted: true, alreadyDeleted: false } as const;
}
