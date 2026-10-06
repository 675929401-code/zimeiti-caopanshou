export const MEDIA_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const MEDIA_CACHE_MAX_ITEM_BYTES = 512 * 1024 * 1024;
export const MEDIA_CACHE_MIN_FREE_BYTES = 96 * 1024 * 1024;
export const MEDIA_CACHE_MAX_QUOTA_SHARE = 0.35;

export type MediaCacheState = "ready" | "missing" | "failed";

export interface MediaCacheMetadata {
  key: string;
  scopeKey: string;
  mediaId: string;
  kind: "video";
  title: string;
  sourcePath: string;
  cachedAt: number;
  expiresAt: number;
  pinned: boolean;
  sizeBytes: number | null;
  state: MediaCacheState;
  failureReason: string;
}

export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

export interface CacheWriteDecision {
  allowed: boolean;
  reason: string;
}

export function createMediaCacheKey(scopeKey: string, mediaId: string): string {
  return `${scopeKey}:${mediaId}`;
}

export function cacheExpiryFrom(now: number): number {
  return now + MEDIA_CACHE_TTL_MS;
}

export function renewCacheExpiry(now: number): number {
  return cacheExpiryFrom(now);
}

export function isExpiredLocalCopy(
  record: Pick<MediaCacheMetadata, "expiresAt" | "pinned">,
  now: number,
): boolean {
  return !record.pinned && record.expiresAt <= now;
}

export function expiredCacheKeys(
  records: MediaCacheMetadata[],
  scopeKey: string,
  now: number,
): string[] {
  return records
    .filter((record) => record.scopeKey === scopeKey && isExpiredLocalCopy(record, now))
    .map((record) => record.key);
}

export function recordsForScope(records: MediaCacheMetadata[], scopeKey: string): MediaCacheMetadata[] {
  return records.filter((record) => record.scopeKey === scopeKey);
}

export function decideCacheWrite(
  estimate: StorageEstimateLike,
  contentLength: number | null,
): CacheWriteDecision {
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength <= 0)) {
    return { allowed: false, reason: "媒体大小无效，未写入本地缓存" };
  }
  if (contentLength !== null && contentLength > MEDIA_CACHE_MAX_ITEM_BYTES) {
    return { allowed: false, reason: "单个视频超过 512MB 本地缓存上限" };
  }

  const usage = Math.max(0, Number(estimate.usage) || 0);
  const quota = Math.max(0, Number(estimate.quota) || 0);
  if (!quota || contentLength === null) return { allowed: true, reason: "" };

  const free = Math.max(0, quota - usage);
  const protectedFree = Math.max(MEDIA_CACHE_MIN_FREE_BYTES, quota * 0.1);
  const projectLimit = quota * MEDIA_CACHE_MAX_QUOTA_SHARE;
  if (contentLength > projectLimit) {
    return { allowed: false, reason: "视频超过当前浏览器可用于本平台的缓存配额" };
  }
  if (contentLength + protectedFree > free) {
    return { allowed: false, reason: "浏览器存储空间不足，已保留安全余量" };
  }
  return { allowed: true, reason: "" };
}

export function cacheStateWithBlob(
  record: MediaCacheMetadata,
  hasBlob: boolean,
): MediaCacheMetadata {
  if (record.state === "failed") return record;
  if (hasBlob) return { ...record, state: "ready", failureReason: "" };
  return { ...record, state: "missing", failureReason: "本地元数据存在，但视频副本已丢失或被浏览器清理" };
}

export function cacheFailureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "浏览器本地配额不足，服务端生成结果仍然保留";
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 180);
  return "本地缓存失败，服务端生成结果仍然保留";
}

export async function mediaScopeKey(userId: string): Promise<string> {
  const normalized = userId.trim();
  if (!normalized) throw new Error("缺少用户作用域，不能访问本地媒体缓存");
  const bytes = new TextEncoder().encode(`media-cache:${normalized}`);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .slice(0, 16)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 2166136261;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

