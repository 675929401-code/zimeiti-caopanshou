"use client";

import { VIDEO_HISTORY_RETENTION_MS, videoHistoryTerminalTime, type VideoHistorySurface } from "./video-history-policy";

/** This namespace stores completed storyboard media only; it never submits jobs. */
export interface StoryboardHistoryItem {
  surface?: VideoHistorySurface;
  taskId: string;
  batchId?: string;
  batchTopic?: string;
  cardIndex?: number;
  status: string;
  createdAt: string;
  completedAt?: string;
  posterUrl?: string; // Memory only. Never copied into IndexedDB.
  modelName?: string;
  duration?: number;
  hidden?: boolean;
  tombstone?: boolean;
}

export interface StoryboardLocalVideoRecord {
  surface?: VideoHistorySurface;
  key: string;
  scopeKey: string;
  taskId: string;
  batchId?: string;
  batchTopic?: string;
  cardIndex?: number;
  createdAt: string;
  completedAt?: string;
  modelName?: string;
  duration?: number;
  bytesKey: string;
  posterBytesKey?: string;
  posterSize: number;
  size: number;
  sha256: string;
  mime: string;
  savedAt: number;
  hidden?: boolean;
}

export interface StoryboardLocalVideoEntry {
  record: StoryboardLocalVideoRecord;
  available: boolean;
}

export interface StoryboardHistoryEntry extends StoryboardHistoryItem {
  local?: StoryboardLocalVideoRecord;
  localAvailable: boolean;
}

export const STORYBOARD_LOCAL_VIDEO_MAX_BYTES = 256 * 1024 * 1024;
export const STORYBOARD_LOCAL_VIDEO_NAMESPACE_MAX_BYTES = 1024 * 1024 * 1024;
const POSTER_MAX_BYTES = 4 * 1024 * 1024;
const DB_NAME = "storyboard-local-video-v1";
const STORE = "videos";
const TOMBSTONES = "tombstones";
const CACHE_NAME = "storyboard-local-video-bytes-v1";
const TASK_ID = /^[a-zA-Z0-9_-]{8,128}$/u;
const MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const queue = new Map<string, Promise<unknown>>();
const pendingSaves = new Map<string, Map<string, Set<AbortController>>>();

const surfaceOf = (item: { surface?: VideoHistorySurface }) => item.surface || "storyboard-workbench";
const expired = (item: { createdAt: string; completedAt?: string }, now = Date.now()) => {
  const terminalAt = videoHistoryTerminalTime(item);
  return Number.isFinite(terminalAt) && now - terminalAt >= VIDEO_HISTORY_RETENTION_MS;
};
function cancelPending(scope: string, taskIds?: readonly string[]): void {
  for (const [taskId, controllers] of pendingSaves.get(scope) || []) {
    if (!taskIds || taskIds.includes(taskId)) for (const controller of controllers) controller.abort();
  }
}

export class StoryboardLocalVideoError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus?: number) { super(message); this.name = "StoryboardLocalVideoError"; }
}
const failure = (code: string, message: string): never => { throw new StoryboardLocalVideoError(code, message); };
export function storyboardLocalVideoError(error: unknown): string {
  if (error instanceof StoryboardLocalVideoError) return error.message;
  if (error instanceof Error && error.name === "QuotaExceededError") return "浏览器存储空间不足，本机副本未保存";
  if (error instanceof Error && error.name === "AbortError") return "本机保存已中断，可稍后重新读取原视频";
  return "本机视频读取或保存失败，线上任务不会重新生成";
}
const stamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const text = (value: string | undefined, max = 140) => typeof value === "string" ? value.replace(/[\r\n\0]/gu, " ").slice(0, max) : undefined;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
const digest = async (blob: Blob) => hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));

/** A missing remote row is not a deletion. An explicit tombstone always wins. */
export function mergeStoryboardHistory<T extends StoryboardHistoryItem>(remote: readonly T[], local: readonly StoryboardLocalVideoEntry[]): Array<StoryboardHistoryEntry & T> {
  const hidden = new Set([...remote.filter(x => x.hidden || x.tombstone).map(x => x.taskId), ...local.filter(x => x.record.hidden).map(x => x.record.taskId)]);
  const byTask = new Map<string, StoryboardHistoryEntry>();
  for (const { record, available } of local) {
    if (!hidden.has(record.taskId) && !expired(record)) byTask.set(record.taskId, { surface: surfaceOf(record), taskId: record.taskId, batchId: record.batchId, batchTopic: record.batchTopic, cardIndex: record.cardIndex, status: "completed", createdAt: record.createdAt, completedAt: record.completedAt, modelName: record.modelName, duration: record.duration, local: record, localAvailable: available });
  }
  for (const item of remote) {
    if (!hidden.has(item.taskId)) byTask.set(item.taskId, { ...item, local: byTask.get(item.taskId)?.local, localAvailable: byTask.get(item.taskId)?.localAvailable ?? false });
  }
  // Every submission is a distinct attempt, including retries of the same card.
  return [...byTask.values()].sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt)) as Array<StoryboardHistoryEntry & T>;
}

export function storyboardCacheAllowance(estimate: { usage?: number; quota?: number }, namespaceBytes: number, incomingBytes: number, posterBytes = 0): void {
  const quota = Number(estimate.quota), usage = Number(estimate.usage);
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(usage) || usage < 0) failure("ESTIMATE_UNAVAILABLE", "浏览器无法确认存储余量，暂未保存本机副本");
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes <= 0 || incomingBytes > STORYBOARD_LOCAL_VIDEO_MAX_BYTES) failure("VIDEO_TOO_LARGE", "单个视频超过 256MB 或大小无效，未保存本机副本");
  const spare = Math.max(96 * 1024 * 1024, quota * 0.2);
  if (!Number.isSafeInteger(posterBytes) || posterBytes < 0 || posterBytes > POSTER_MAX_BYTES) failure("INVALID_POSTER", "视频封面大小无效");
  if (quota - usage < incomingBytes + posterBytes + spare) failure("INSUFFICIENT_SPACE", "浏览器存储空间不足，已保留安全余量");
  if (namespaceBytes + incomingBytes + posterBytes > Math.min(STORYBOARD_LOCAL_VIDEO_NAMESPACE_MAX_BYTES, quota * 0.35)) failure("NAMESPACE_FULL", "分镜本机缓存空间不足，请先明确清理不需要的副本");
}

function assertStorage(): void {
  if (typeof window === "undefined" || !globalThis.indexedDB || !globalThis.caches || !globalThis.crypto?.subtle) failure("STORAGE_UNAVAILABLE", "当前浏览器不支持分镜视频本机缓存");
}
function openDb(): Promise<IDBDatabase> {
  assertStorage();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      for (const name of [STORE, TOMBSTONES]) if (!request.result.objectStoreNames.contains(name)) {
        const store = request.result.createObjectStore(name, { keyPath: "key" });
        store.createIndex("scopeKey", "scopeKey", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new StoryboardLocalVideoError("INDEX_BLOCKED", "本机视频索引正被另一个页面占用"));
  });
}
async function indexOperation<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>, signal?: AbortSignal, storeName = STORE): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let value: T;
      const abort = () => { try { tx.abort(); } catch { /* already completed */ } };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      tx.oncomplete = () => { cleanup(); resolve(value); };
      tx.onabort = tx.onerror = () => { cleanup(); reject(tx.error || new DOMException("Index transaction aborted", "AbortError")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { const request = action(tx.objectStore(storeName)); request.onsuccess = () => { value = request.result; }; }
      catch (error) { abort(); cleanup(); reject(error); }
    });
  } finally { db.close(); }
}
const allRecords = () => indexOperation("readonly", store => store.getAll()) as Promise<StoryboardLocalVideoRecord[]>;
const putRecord = (record: StoryboardLocalVideoRecord, signal?: AbortSignal) => indexOperation("readwrite", store => store.put(record), signal);
const removeRecord = (key: string, signal?: AbortSignal) => indexOperation("readwrite", store => store.delete(key), signal);
interface LocalTombstone { key: string; scopeKey: string; taskId: string; expiresAt?: number }
const allTombstones = () => indexOperation("readonly", store => store.getAll(), undefined, TOMBSTONES) as Promise<LocalTombstone[]>;
const putTombstone = (scopeKey: string, taskId: string, expiresAt?: number) => indexOperation("readwrite", store => store.put({ key: `${scopeKey}:${taskId}`, scopeKey, taskId, expiresAt } satisfies LocalTombstone), undefined, TOMBSTONES);
function byteRequest(key: string) { return new Request(new URL(key, window.location.origin)); }
const safeByteKey = (key: string, scope: string) => key.startsWith(`/__storyboard_local_videos__/${scope}/`) && !/[?#]/u.test(key);

export function assertCompleteStoryboardVideoResponse(response: Response): { mime: string; declared: number | null } {
  // Preserve explicit authorization/removal responses from our authenticated
  // proxy; network, quota, decoding and other HTTP errors remain separate.
  if ([401, 403, 404, 410].includes(response.status)) throw new StoryboardLocalVideoError("VIDEO_ACCESS_DENIED", "原视频当前不可访问，本机副本未更新", response.status);
  if (response.status !== 200 || response.headers.has("content-range")) failure("PARTIAL_RESPONSE", "原视频未完整返回，未将片段保存为本机副本");
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!MIME_TYPES.has(mime)) failure("INVALID_VIDEO_MIME", "返回内容不是支持的视频文件，未保存本机副本");
  const raw = response.headers.get("content-length"), declared = raw === null ? null : Number(raw);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > STORYBOARD_LOCAL_VIDEO_MAX_BYTES)) failure("VIDEO_TOO_LARGE", "原视频大小无效或超过 256MB 本机缓存上限");
  if (!response.body) failure("EMPTY_VIDEO", "原视频没有完整数据");
  return { mime, declared };
}
async function boundedBlob(response: Response, signal: AbortSignal, max = STORYBOARD_LOCAL_VIDEO_MAX_BYTES): Promise<Blob> {
  const { mime, declared } = assertCompleteStoryboardVideoResponse(response), reader = response.body!.getReader();
  const chunks: BlobPart[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) failure("VIDEO_TOO_LARGE", "视频实际数据超过本机缓存上限");
      chunks.push(chunk.value as Uint8Array<ArrayBuffer>);
    }
    if (!size || (declared !== null && size !== declared)) failure("INCOMPLETE_VIDEO", "原视频传输不完整，未保存本机副本");
    const blob = new Blob(chunks, { type: mime });
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const webm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    const atom = new TextDecoder().decode(head.slice(4, 8));
    if ((mime === "video/webm" && !webm) || (mime !== "video/webm" && !["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(atom))) failure("INVALID_VIDEO_BYTES", "返回内容未通过视频文件检查");
    return blob;
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function posterFromVideo(blob: Blob, signal: AbortSignal): Promise<Blob | undefined> {
  if (typeof document === "undefined") return undefined;
  const url = URL.createObjectURL(blob), video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.playsInline = true;
  try {
    return await new Promise<Blob | undefined>(resolve => {
      const finish = (result?: Blob) => { clearTimeout(timer); signal.removeEventListener("abort", abort); video.onloadeddata = video.onerror = null; resolve(result); };
      const abort = () => finish();
      const timer = setTimeout(() => finish(), 10000);
      signal.addEventListener("abort", abort, { once: true });
      video.onerror = () => finish();
      video.onloadeddata = () => {
        if (signal.aborted || !video.videoWidth || !video.videoHeight) { finish(); return; }
        try {
          const canvas = document.createElement("canvas"), scale = Math.min(1, 480 / video.videoWidth);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(result => finish(result && result.size <= POSTER_MAX_BYTES ? result : undefined), "image/png");
        } catch { finish(); }
      };
      video.src = url;
    });
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}

async function serialized<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (navigator.locks) return navigator.locks.request("storyboard-local-video-v1-write", { signal }, work);
  const previous = queue.get(CACHE_NAME) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => { if (signal.aborted) throw new DOMException("Aborted", "AbortError"); return work(); });
  queue.set(CACHE_NAME, next);
  try { return await next; } finally { if (queue.get(CACHE_NAME) === next) queue.delete(CACHE_NAME); }
}

export class StoryboardLocalVideoSession {
  private readonly controller = new AbortController();
  private readonly scope: Promise<string>;
  constructor(private readonly userId: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch, private readonly surface: VideoHistorySurface = "storyboard-workbench") {
    assertStorage();
    if (!userId || !token) failure("AUTH_REQUIRED", "请先登录后读取本账号的本机视频");
    // Preserve the existing storyboard namespace during the surface migration.
    this.scope = crypto.subtle.digest("SHA-256", new TextEncoder().encode(`storyboard-local-video-v1:${userId}${surface === "video-page" ? ":video-page" : ""}`)).then(hex);
  }
  dispose(): void { this.controller.abort(); }
  get active(): boolean { return !this.controller.signal.aborted; }
  private check(): void { if (!this.active) throw new DOMException("Account context changed", "AbortError"); }
  private async records(): Promise<StoryboardLocalVideoRecord[]> {
    const scope = await this.scope; this.check();
    const rows = (await allRecords()).filter(row => row.scopeKey === scope && surfaceOf(row) === this.surface && TASK_ID.test(row.taskId) && row.key === `${scope}:${row.taskId}` && safeByteKey(row.bytesKey, scope) && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= STORYBOARD_LOCAL_VIDEO_MAX_BYTES && /^[a-f0-9]{64}$/u.test(row.sha256) && MIME_TYPES.has(row.mime));
    this.check(); return rows;
  }
  private async erase(row: StoryboardLocalVideoRecord, cache: Cache): Promise<void> {
    const scope = await this.scope;
    // Bytes first: failed deletion leaves a retryable index instead of orphan media.
    if (safeByteKey(row.bytesKey, scope)) await cache.delete(byteRequest(row.bytesKey));
    if (row.posterBytesKey && safeByteKey(row.posterBytesKey, scope)) await cache.delete(byteRequest(row.posterBytesKey));
    await removeRecord(row.key);
  }
  private async purgeExpired(): Promise<void> {
    await serialized(async () => {
      const rows = await this.records(), cache = await caches.open(CACHE_NAME), scope = await this.scope;
      const tombstones = await allTombstones(); this.check();
      const hidden = new Set(tombstones.map(row => row.key));
      for (const row of rows) if (expired(row) || row.hidden || hidden.has(row.key)) {
        this.check();
        if (row.hidden && !hidden.has(row.key)) {
          const terminalAt = videoHistoryTerminalTime(row);
          await putTombstone(scope, row.taskId, Number.isFinite(terminalAt) ? terminalAt + VIDEO_HISTORY_RETENTION_MS + 180000 : undefined);
        }
        await this.erase(row, cache);
      }
      for (const row of tombstones) if (row.scopeKey === scope && Number.isFinite(row.expiresAt) && Date.now() >= row.expiresAt!) {
        await indexOperation("readwrite", store => store.delete(row.key), this.controller.signal, TOMBSTONES);
      }
    }, this.controller.signal);
  }
  async list(): Promise<StoryboardLocalVideoEntry[]> {
    await this.purgeExpired();
    const records = await this.records(), cache = await caches.open(CACHE_NAME); this.check();
    const tombstones = new Set((await allTombstones()).map(row => row.key)); this.check();
    const entries: StoryboardLocalVideoEntry[] = [];
    for (const record of records) {
      if (tombstones.has(record.key) || record.hidden || expired(record)) continue;
      const response = await cache.match(byteRequest(record.bytesKey)); this.check();
      entries.push({ record, available: Boolean(response?.status === 200 && response.headers.get("x-storyboard-sha256") === record.sha256 && Number(response.headers.get("content-length")) === record.size && response.headers.get("content-type") === record.mime) });
    }
    return entries;
  }
  async load(taskId: string): Promise<Blob | null> {
    await this.purgeExpired();
    this.check(); const record = (await this.records()).find(row => row.taskId === taskId && !row.hidden); if (!record) return null;
    if ((await allTombstones()).some(row => row.key === record.key)) return null;
    const cache = await caches.open(CACHE_NAME), response = await cache.match(byteRequest(record.bytesKey)); if (!response) return null;
    const blob = await boundedBlob(response, this.controller.signal); this.check();
    if (blob.size !== record.size || await digest(blob) !== record.sha256) failure("LOCAL_BYTES_MISMATCH", "本机视频副本不完整，请重新读取原视频");
    const cleared = (await allTombstones()).some(row => row.key === record.key);
    this.check(); return cleared || expired(record) ? null : blob;
  }
  async poster(taskId: string): Promise<Blob | null> {
    await this.purgeExpired();
    const scope = await this.scope, record = (await this.records()).find(row => row.taskId === taskId && !row.hidden);
    if (record && (await allTombstones()).some(row => row.key === record.key)) return null;
    if (!record?.posterBytesKey || !safeByteKey(record.posterBytesKey, scope)) return null;
    const response = await (await caches.open(CACHE_NAME)).match(byteRequest(record.posterBytesKey)); this.check();
    if (!response || response.headers.get("content-type") !== "image/png" || Number(response.headers.get("content-length")) > POSTER_MAX_BYTES) return null;
    const blob = await response.blob();
    const cleared = (await allTombstones()).some(row => row.key === record.key);
    this.check(); return !cleared && !expired(record) && blob.size === record.posterSize && blob.size <= POSTER_MAX_BYTES ? blob : null;
  }
  async save(item: StoryboardHistoryItem, options: { replace?: boolean } = {}): Promise<StoryboardLocalVideoRecord> {
    if (!TASK_ID.test(item.taskId) || item.status !== "completed" || item.hidden || item.tombstone) failure("NOT_COMPLETED", "仅能保存已完成且可见的原视频");
    if (surfaceOf(item) !== this.surface) failure("SURFACE_MISMATCH", "视频不属于当前工作台");
    if (expired(item)) failure("VIDEO_EXPIRED", "视频已超过五天历史保留期，未保存本机副本");
    const scope = await this.scope; this.check();
    const localAbort = new AbortController(), abort = () => localAbort.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (!pendingSaves.has(scope)) pendingSaves.set(scope, new Map());
    const tasks = pendingSaves.get(scope)!;
    if (!tasks.has(item.taskId)) tasks.set(item.taskId, new Set());
    tasks.get(item.taskId)!.add(localAbort);
    const checkSave = () => { this.check(); if (localAbort.signal.aborted) throw new DOMException("Local save cancelled", "AbortError"); if (expired(item)) failure("VIDEO_EXPIRED", "视频已超过五天历史保留期，未保存本机副本"); };
    try {
      // Register before waiting for any lock, so a simultaneous clear also
      // cancels saves that are still waiting for expiry cleanup.
      await this.purgeExpired(); checkSave();
      return await serialized(async () => {
      checkSave(); const records = await allRecords(); checkSave();
      const key = `${scope}:${item.taskId}`, old = records.find(row => row.key === key), cache = await caches.open(CACHE_NAME);
      if (old?.hidden || (await allTombstones()).some(row => row.key === key)) failure("HIDDEN_VIDEO", "该视频历史已清理，不重新保存本机副本");
      if (old && !options.replace) { const response = await cache.match(byteRequest(old.bytesKey)); if (response?.status === 200 && response.headers.get("x-storyboard-sha256") === old.sha256 && Number(response.headers.get("content-length")) === old.size && response.headers.get("content-type") === old.mime) { checkSave(); return old; } }
      const namespaceBytes = records.reduce((n, row) => n + (Number(row.size) || 0) + (Number(row.posterSize) || 0), 0);
      const estimate = await navigator.storage.estimate(); checkSave();
      storyboardCacheAllowance(estimate, namespaceBytes, 1);
      const timeout = setTimeout(abort, 180000);
      let bytesKey = "", posterBytesKey = "", committed = false;
      try {
        const url = new URL("/api/video/proxy-download", window.location.origin); url.searchParams.set("taskId", item.taskId); url.searchParams.set("name", "storyboard-video");
        const fetcher = this.fetcher;
        const response = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${this.token}` }, method: "GET", cache: "no-store", redirect: "error", signal: localAbort.signal });
        const { declared } = assertCompleteStoryboardVideoResponse(response);
        const capacity = Math.floor(Math.min(STORYBOARD_LOCAL_VIDEO_MAX_BYTES, Math.min(STORYBOARD_LOCAL_VIDEO_NAMESPACE_MAX_BYTES, Number(estimate.quota) * 0.35) - namespaceBytes - POSTER_MAX_BYTES, Number(estimate.quota) - Number(estimate.usage) - Math.max(96 * 1024 * 1024, Number(estimate.quota) * 0.2) - POSTER_MAX_BYTES));
        if (declared !== null) storyboardCacheAllowance(estimate, namespaceBytes, declared, POSTER_MAX_BYTES);
        const blob = await boundedBlob(response, localAbort.signal, capacity); checkSave();
        const sha256 = await digest(blob); checkSave(); const poster = await posterFromVideo(blob, localAbort.signal); checkSave();
        storyboardCacheAllowance(await navigator.storage.estimate(), namespaceBytes, blob.size, poster?.size || 0); checkSave();
        bytesKey = `/__storyboard_local_videos__/${scope}/${item.taskId}/${crypto.randomUUID()}`;
        await cache.put(byteRequest(bytesKey), new Response(blob, { status: 200, headers: { "content-type": blob.type, "content-length": String(blob.size), "x-storyboard-sha256": sha256 } })); checkSave();
        if (poster) { posterBytesKey = `${bytesKey}-poster`; await cache.put(byteRequest(posterBytesKey), new Response(poster, { headers: { "content-type": "image/png", "content-length": String(poster.size) } })); checkSave(); }
        // Older browsers may lack cross-tab Web Locks. Recheck the durable
        // marker on both sides of the commit so their late writes stay hidden.
        if ((await allTombstones()).some(row => row.key === key)) failure("HIDDEN_VIDEO", "该视频历史已清理，不重新保存本机副本");
        checkSave();
        const record: StoryboardLocalVideoRecord = { surface: this.surface, key, scopeKey: scope, taskId: item.taskId, batchId: text(item.batchId), batchTopic: text(item.batchTopic), cardIndex: Number.isInteger(item.cardIndex) && item.cardIndex! >= 0 ? item.cardIndex : undefined, createdAt: text(item.createdAt, 40) || "", completedAt: text(item.completedAt, 40), modelName: text(item.modelName, 80), duration: Number.isFinite(item.duration) && item.duration! > 0 ? item.duration : undefined, bytesKey, posterBytesKey: posterBytesKey || undefined, posterSize: poster?.size || 0, size: blob.size, sha256, mime: blob.type, savedAt: Date.now() };
        await putRecord(record, localAbort.signal); committed = true;
        if ((await allTombstones()).some(row => row.key === key)) { await removeRecord(key); committed = false; failure("HIDDEN_VIDEO", "该视频历史已清理，不重新保存本机副本"); }
        // If account/token changed at the transaction boundary, restore the prior index.
        if (!this.active || localAbort.signal.aborted || expired(item)) { if (old) await putRecord(old); else await removeRecord(key); committed = false; checkSave(); }
        if (old) { await cache.delete(byteRequest(old.bytesKey)).catch(() => {}); if (old.posterBytesKey) await cache.delete(byteRequest(old.posterBytesKey)).catch(() => {}); }
        return record;
      } catch (error) {
        if (!committed) { if (bytesKey) await cache.delete(byteRequest(bytesKey)).catch(() => {}); if (posterBytesKey) await cache.delete(byteRequest(posterBytesKey)).catch(() => {}); }
        if (error instanceof StoryboardLocalVideoError || (error instanceof Error && ["AbortError", "QuotaExceededError"].includes(error.name))) throw error;
        return failure("SAVE_FAILED", "原视频读取或本机保存失败，线上任务不会重新生成");
      } finally { clearTimeout(timeout); }
    }, localAbort.signal); } finally {
      this.controller.signal.removeEventListener("abort", abort);
      tasks.get(item.taskId)?.delete(localAbort);
      if (!tasks.get(item.taskId)?.size) tasks.delete(item.taskId);
      if (!tasks.size) pendingSaves.delete(scope);
    }
  }
  async applyTombstones(taskIds: readonly string[]): Promise<void> {
    await this.clearLocal(taskIds);
  }
  /** Deletes only this account/surface's cache. Durable markers prevent late saves. */
  async clearLocal(taskIds?: readonly string[]): Promise<void> {
    const scope = await this.scope; this.check();
    const ids = taskIds ? [...new Set(taskIds.filter(taskId => TASK_ID.test(taskId)))] : undefined;
    if (ids && !ids.length) return;
    // Cancel current and queued saves before waiting for their write lock.
    const pending = [...(pendingSaves.get(scope)?.keys() || [])];
    cancelPending(scope, ids);
    await serialized(async () => {
      const rows = await this.records(), cache = await caches.open(CACHE_NAME);
      const markers = new Map((await allTombstones()).map(row => [row.key, row])); this.check();
      const selected = rows.filter(row => !ids || ids.includes(row.taskId));
      const deletedIds = ids || [...new Set([...selected.map(row => row.taskId), ...pending])];
      for (const taskId of deletedIds) {
        this.check(); const row = selected.find(row => row.taskId === taskId);
        const terminalAt = row ? videoHistoryTerminalTime(row) : NaN;
        const previous = markers.get(`${scope}:${taskId}`);
        const expiresAt = Number.isFinite(terminalAt) ? terminalAt + VIDEO_HISTORY_RETENTION_MS + 180000
          : row ? undefined : previous ? previous.expiresAt : Date.now() + VIDEO_HISTORY_RETENTION_MS + 180000;
        await putTombstone(scope, taskId, expiresAt);
      }
      // Re-read after marker commits to include writes from tabs without Web Locks.
      const latest = (await this.records()).filter(row => deletedIds.includes(row.taskId));
      const media = new Map([...selected, ...latest].map(row => [row.bytesKey, row]));
      for (const row of media.values()) { this.check(); await this.erase(row, cache); }
    }, this.controller.signal);
  }
  async deleteLocal(taskId: string): Promise<void> {
    await this.clearLocal([taskId]);
  }
}
