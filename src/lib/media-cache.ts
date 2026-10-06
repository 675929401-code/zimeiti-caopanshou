"use client";

import {
  cacheExpiryFrom,
  cacheFailureMessage,
  cacheStateWithBlob,
  createMediaCacheKey,
  decideCacheWrite,
  expiredCacheKeys,
  mediaScopeKey,
  renewCacheExpiry,
  type MediaCacheMetadata,
  type StorageEstimateLike,
} from "@/lib/media-cache-policy";

const DB_NAME = "platform-media-cache-v1";
const DB_VERSION = 1;
const META_STORE = "metadata";
const CACHE_PREFIX = "platform-media-cache-v1";

function assertBrowserStorage() {
  if (typeof window === "undefined" || !globalThis.indexedDB || !globalThis.caches) {
    throw new Error("当前浏览器不支持媒体本地缓存");
  }
}

function openMetadataDb(): Promise<IDBDatabase> {
  assertBrowserStorage();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: "key" });
        store.createIndex("scopeKey", "scopeKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开媒体缓存索引"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("媒体缓存索引操作失败"));
  });
}

async function putMetadata(record: MediaCacheMetadata): Promise<void> {
  const db = await openMetadataDb();
  try {
    const transaction = db.transaction(META_STORE, "readwrite");
    await requestResult(transaction.objectStore(META_STORE).put(record));
  } finally {
    db.close();
  }
}

async function deleteMetadata(key: string): Promise<void> {
  const db = await openMetadataDb();
  try {
    const transaction = db.transaction(META_STORE, "readwrite");
    await requestResult(transaction.objectStore(META_STORE).delete(key));
  } finally {
    db.close();
  }
}

async function allMetadata(): Promise<MediaCacheMetadata[]> {
  const db = await openMetadataDb();
  try {
    const transaction = db.transaction(META_STORE, "readonly");
    return await requestResult(transaction.objectStore(META_STORE).getAll()) as MediaCacheMetadata[];
  } finally {
    db.close();
  }
}

function cacheName(scopeKey: string): string {
  return `${CACHE_PREFIX}-${scopeKey}`;
}

function cacheRequest(scopeKey: string, mediaId: string): Request {
  const path = `/__local_media_cache__/${scopeKey}/${encodeURIComponent(mediaId)}`;
  return new Request(new URL(path, window.location.origin).toString(), { method: "GET" });
}

async function storageEstimate(): Promise<StorageEstimateLike> {
  try {
    return await navigator.storage?.estimate?.() || {};
  } catch {
    return {};
  }
}

export interface CacheVideoInput {
  userId: string;
  mediaId: string;
  title: string;
  sourcePath: string;
  token: string;
}

export async function cacheVideoLocally(input: CacheVideoInput): Promise<MediaCacheMetadata> {
  const scopeKey = await mediaScopeKey(input.userId);
  const key = createMediaCacheKey(scopeKey, input.mediaId);
  const baseRecord: MediaCacheMetadata = {
    key,
    scopeKey,
    mediaId: input.mediaId,
    kind: "video",
    title: input.title,
    sourcePath: input.sourcePath,
    cachedAt: Date.now(),
    expiresAt: cacheExpiryFrom(Date.now()),
    pinned: false,
    sizeBytes: null,
    state: "failed",
    failureReason: "",
  };

  try {
    assertBrowserStorage();
    const response = await fetch(input.sourcePath, {
      headers: { Authorization: `Bearer ${input.token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`下载本地副本失败 (${response.status})`);
    const rawLength = Number(response.headers.get("content-length"));
    const contentLength = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : null;
    const decision = decideCacheWrite(await storageEstimate(), contentLength);
    if (!decision.allowed) throw new Error(decision.reason);

    const mediaCache = await caches.open(cacheName(scopeKey));
    await mediaCache.put(cacheRequest(scopeKey, input.mediaId), response.clone());
    const record: MediaCacheMetadata = {
      ...baseRecord,
      state: "ready",
      failureReason: "",
      sizeBytes: contentLength,
    };
    await putMetadata(record);
    return record;
  } catch (error) {
    const failed = { ...baseRecord, state: "failed" as const, failureReason: cacheFailureMessage(error) };
    try { await putMetadata(failed); } catch { /* cache failure must not affect the server result */ }
    return failed;
  }
}

export async function listUserMediaCache(userId: string): Promise<MediaCacheMetadata[]> {
  const scopeKey = await mediaScopeKey(userId);
  const records = (await allMetadata()).filter((record) => record.scopeKey === scopeKey);
  const mediaCache = await caches.open(cacheName(scopeKey));
  const reconciled = await Promise.all(records.map(async (record) => {
    const hasBlob = Boolean(await mediaCache.match(cacheRequest(scopeKey, record.mediaId)));
    const next = cacheStateWithBlob(record, hasBlob);
    if (next.state !== record.state || next.failureReason !== record.failureReason) await putMetadata(next);
    return next;
  }));
  return reconciled.sort((left, right) => right.cachedAt - left.cachedAt);
}

export async function cleanupExpiredMediaCache(userId: string, now = Date.now()): Promise<string[]> {
  const scopeKey = await mediaScopeKey(userId);
  const records = await allMetadata();
  const keys = new Set(expiredCacheKeys(records, scopeKey, now));
  if (!keys.size) return [];
  const mediaCache = await caches.open(cacheName(scopeKey));
  const removed: string[] = [];
  for (const record of records) {
    if (!keys.has(record.key)) continue;
    await mediaCache.delete(cacheRequest(scopeKey, record.mediaId));
    await deleteMetadata(record.key);
    removed.push(record.mediaId);
  }
  return removed;
}

export async function deleteLocalMediaCopy(userId: string, mediaId: string): Promise<void> {
  const scopeKey = await mediaScopeKey(userId);
  const key = createMediaCacheKey(scopeKey, mediaId);
  const mediaCache = await caches.open(cacheName(scopeKey));
  await mediaCache.delete(cacheRequest(scopeKey, mediaId));
  await deleteMetadata(key);
}

async function mutateRecord(
  userId: string,
  mediaId: string,
  mutate: (record: MediaCacheMetadata) => MediaCacheMetadata,
): Promise<MediaCacheMetadata | null> {
  const scopeKey = await mediaScopeKey(userId);
  const key = createMediaCacheKey(scopeKey, mediaId);
  const record = (await allMetadata()).find((item) => item.key === key);
  if (!record) return null;
  const next = mutate(record);
  await putMetadata(next);
  return next;
}

export function setLocalMediaPinned(userId: string, mediaId: string, pinned: boolean) {
  return mutateRecord(userId, mediaId, (record) => ({ ...record, pinned }));
}

export function renewLocalMediaCopy(userId: string, mediaId: string) {
  return mutateRecord(userId, mediaId, (record) => ({
    ...record,
    expiresAt: renewCacheExpiry(Date.now()),
    state: record.state === "failed" ? "failed" : "ready",
  }));
}

export async function getCachedMediaResponse(userId: string, mediaId: string): Promise<Response | null> {
  const scopeKey = await mediaScopeKey(userId);
  const mediaCache = await caches.open(cacheName(scopeKey));
  return await mediaCache.match(cacheRequest(scopeKey, mediaId)) || null;
}

export async function responseToDownloadBlob(response: Response): Promise<Blob> {
  if (!response.ok) throw new Error(`媒体下载失败 (${response.status})`);
  return await response.blob();
}

export async function readMediaStorageEstimate(): Promise<StorageEstimateLike> {
  return storageEstimate();
}

