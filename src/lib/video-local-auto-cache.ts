"use client";

import { StoryboardLocalVideoError, StoryboardLocalVideoSession, type StoryboardHistoryItem } from "./storyboard-local-video-cache";
import { VIDEO_HISTORY_RETENTION_MS, type VideoHistorySurface } from "./video-history-policy";
import { subscribeVideoHistoryRemovals } from "./video-history-removal-sync";
import { requestMediaHistoryVideoUrl } from "./media-history-video-preview";
import { recordOfflineSession, recordOfflineTask } from "./media-history-offline-auth";

/** Result is for UI feedback; it never implies that a cloud copy exists. */
export type AutoCacheResult =
  | { state: "saved" }
  | { state: "not_ready" | "expired" | "unavailable" | "removed" | "cancelled" | "queue_full" | "invalid" }
  | { state: "failed"; reason: "network" | "timeout" | "storage" | "unknown" };

type Session = Pick<StoryboardLocalVideoSession, "save" | "applyTombstones" | "dispose">;
type SessionFactory = (userId: string, token: string, fetcher: typeof fetch, surface: VideoHistorySurface) => Session;
type Options = {
  userId: string;
  token: string;
  surface: VideoHistorySurface;
  fetcher?: typeof fetch;
  /** Trusted injection point for offline tests; production uses the existing browser session. */
  sessionFactory?: SessionFactory;
  /** Report an unsuccessful local tombstone write after a deletion signal. */
  onRemovalSyncFailure?: (taskIds: readonly string[]) => void;
};
type Entry = { taskId: string; controller: AbortController; resolve: (value: AutoCacheResult) => void; promise: Promise<AutoCacheResult> };
const TASK_ID = /^[a-zA-Z0-9_-]{8,128}$/u;
const MAX_QUEUE = 100;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 20_000;
const TICKET_TIMEOUT_MS = 5_000;
const COMPLETE_BILLING = new Set(["settled", "not_required", "exempt", "legacy_h3_settled"]);
const TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function validTime(value: unknown): number {
  return typeof value === "string" && TIME_WITH_ZONE.test(value) ? Date.parse(value) : NaN;
}

function withAbort<T>(signal: AbortSignal, work: PromiseLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if ("error" in result) reject(result.error); else resolve(result.value);
    };
    const abort = () => finish({ error: new DOMException("Aborted", "AbortError") });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(work).then(value => finish({ value }), error => finish({ error }));
  });
}

/** One instance belongs to one signed-in account and one workbench surface. */
export class VideoLocalAutoCache {
  private readonly controller = new AbortController();
  private readonly session: Session;
  private readonly fetcher: typeof fetch;
  private readonly userId: string;
  private readonly token: string;
  private readonly surface: VideoHistorySurface;
  private readonly queue: Entry[] = [];
  private readonly pending = new Map<string, Entry>();
  private readonly removed = new Set<string>();
  private readonly stopRemovalSync: () => void;
  private active: Entry | null = null;

  constructor(options: Options) {
    if (!options.userId || options.userId.trim() !== options.userId || options.userId.length > 128 ||
        !options.token || options.token.trim() !== options.token ||
        !["storyboard-workbench", "video-page"].includes(options.surface)) {
      throw new Error("VIDEO_AUTO_CACHE_SCOPE_INVALID");
    }
    this.fetcher = options.fetcher || fetch;
    this.userId = options.userId;
    this.token = options.token;
    this.surface = options.surface;
    const factory = options.sessionFactory || ((userId, token, fetcher, surface) => new StoryboardLocalVideoSession(userId, token, fetcher, surface));
    this.session = factory(options.userId, options.token, this.fetcher, options.surface);
    this.stopRemovalSync = subscribeVideoHistoryRemovals(options.userId, options.surface, ids => {
      void this.applyTombstones(ids).then(ok => {
        if (!ok && !this.controller.signal.aborted) {
          try { options.onRemovalSyncFailure?.(ids); } catch { /* A UI callback must not break synchronization. */ }
        }
      });
    }, ids => { this.blockRemoved(ids); });
  }

  /** The argument is the server's internal task ID, never an unverified provider ID. */
  enqueue(taskId: string): Promise<AutoCacheResult> {
    if (this.controller.signal.aborted) return Promise.resolve({ state: "cancelled" });
    if (!TASK_ID.test(taskId)) return Promise.resolve({ state: "invalid" });
    if (this.removed.has(taskId)) return Promise.resolve({ state: "removed" });
    const existing = this.pending.get(taskId);
    if (existing) return existing.promise;
    if (this.pending.size >= MAX_QUEUE) return Promise.resolve({ state: "queue_full" });
    let resolve!: (result: AutoCacheResult) => void;
    const promise = new Promise<AutoCacheResult>(done => { resolve = done; });
    const entry: Entry = { taskId, controller: new AbortController(), resolve, promise };
    this.pending.set(taskId, entry);
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  /** Call only for IDs the server explicitly confirmed removed by this account. */
  async applyTombstones(taskIds: readonly string[]): Promise<boolean> {
    if (this.controller.signal.aborted) return false;
    const ids = [...new Set(taskIds.filter(id => TASK_ID.test(id)))];
    if (!ids.length) return true;
    this.blockRemoved(ids);
    // The server has already confirmed these removals. Revoke before touching
    // IndexedDB so an unsuccessful tombstone write cannot preserve a grant.
    await Promise.all(ids.map(id => recordOfflineTask(this.userId, this.token, id, true)));
    try {
      await this.session.applyTombstones(ids);
      return !this.controller.signal.aborted;
    } catch {
      // Keep IDs blocked for this scope even when the durable marker fails.
      return false;
    }
  }

  private blockRemoved(ids: readonly string[]): void {
    for (const id of ids) {
      this.removed.add(id);
      this.pending.get(id)?.controller.abort();
    }
  }

  private async revokeForStatus(taskId: string, status: number, stillCurrent: () => boolean): Promise<void> {
    if (status === 401 || status === 403) await recordOfflineSession(this.userId, this.token, "denied", stillCurrent);
    else if (status === 404 || status === 410) await recordOfflineTask(this.userId, this.token, taskId, true, stillCurrent);
  }

  /** Call before changing account/token/surface and when the owning page unmounts. */
  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.stopRemovalSync();
    this.active?.controller.abort();
    this.session.dispose();
    for (const entry of this.queue.splice(0)) {
      this.pending.delete(entry.taskId);
      entry.resolve({ state: "cancelled" });
    }
  }

  private pump(): void {
    if (this.active || this.controller.signal.aborted) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    void this.run(entry).catch((): AutoCacheResult => ({ state: "failed", reason: "unknown" })).then(result => {
      if (this.pending.get(entry.taskId) === entry) this.pending.delete(entry.taskId);
      if (this.active === entry) this.active = null;
      entry.resolve(result);
      this.pump();
    });
  }

  private async run(entry: Entry): Promise<AutoCacheResult> {
    const interrupted = (): AutoCacheResult | null => this.controller.signal.aborted ? { state: "cancelled" }
      : this.removed.has(entry.taskId) ? { state: "removed" } : null;
    const stopped = interrupted(); if (stopped) return stopped;
    let timedOut = false;
    let saving = false;
    const timer = setTimeout(() => { timedOut = true; entry.controller.abort(); }, READ_TIMEOUT_MS);
    try {
      const query = new URLSearchParams({ surface: this.surface, taskId: entry.taskId });
      const response = await withAbort(entry.controller.signal, this.fetcher(`/api/video/history?${query.toString()}`, {
        method: "GET", headers: { Authorization: `Bearer ${this.token}` },
        cache: "no-store", redirect: "error", signal: entry.controller.signal,
      }));
      const afterFetch = interrupted(); if (afterFetch) return afterFetch;
      if (timedOut || entry.controller.signal.aborted) return { state: "failed", reason: "timeout" };
      if (!response.ok) {
        await this.revokeForStatus(entry.taskId, response.status, () => !interrupted() && !entry.controller.signal.aborted);
        return [401, 403, 404, 410].includes(response.status) ? { state: "unavailable" } : { state: "failed", reason: "network" };
      }
      const body = await withAbort(entry.controller.signal, response.json()) as { tasks?: unknown; serverTime?: unknown };
      const afterJson = interrupted(); if (afterJson) return afterJson;
      if (timedOut || entry.controller.signal.aborted) return { state: "failed", reason: "timeout" };
      if (!Array.isArray(body.tasks) || body.tasks.length !== 1 || !body.tasks[0] || typeof body.tasks[0] !== "object") return { state: "unavailable" };
      const row = body.tasks[0] as Record<string, unknown>;
      if (row.id !== entry.taskId || row.status !== "completed" || typeof row.billingState !== "string" || !COMPLETE_BILLING.has(row.billingState)) return { state: "not_ready" };
      const label = String(row.taskLabel || "");
      if ((this.surface === "storyboard-workbench" && !label.startsWith("分镜工作台")) ||
          (this.surface === "video-page" && (label.startsWith("分镜工作台") || label.startsWith("digital-human:"))) ||
          row.mediaAvailable === false || row.hidden === true || row.tombstone === true) return { state: "not_ready" };
      const serverAt = validTime(body.serverTime), createdAt = validTime(row.createdAt), completedAt = validTime(row.completedAt);
      if (![serverAt, createdAt, completedAt].every(Number.isFinite) || createdAt > completedAt || completedAt > serverAt ||
          Math.abs(Date.now() - serverAt) > MAX_CLOCK_SKEW_MS) return { state: "not_ready" };
      if (serverAt - completedAt >= VIDEO_HISTORY_RETENTION_MS) return { state: "expired" };
      const item: StoryboardHistoryItem = {
        surface: this.surface, taskId: entry.taskId, status: "completed", createdAt: row.createdAt as string,
        completedAt: row.completedAt as string,
        batchId: typeof row.batchId === "string" ? row.batchId : undefined,
        batchTopic: typeof row.batchTopic === "string" ? row.batchTopic : undefined,
        cardIndex: typeof row.cardIndex === "number" && Number.isSafeInteger(row.cardIndex) ? row.cardIndex : undefined,
        modelName: typeof row.modelName === "string" ? row.modelName : undefined,
        duration: typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds) ? row.durationSeconds : undefined,
      };
      clearTimeout(timer);
      saving = true;
      await withAbort(entry.controller.signal, this.session.save(item));
      const afterSave = interrupted(); if (afterSave) return afterSave;
      // An existing cache entry can make save() return without fetching media.
      // Obtain a fresh, task-specific playback ticket only after the local save;
      // the ticket helper grants this page's offline access only while its
      // account, task, denial versions and abort signal are still current.
      // A missing ticket does not discard an otherwise successful local save.
      const ticketTimeout = setTimeout(() => entry.controller.abort(), TICKET_TIMEOUT_MS);
      try {
        await withAbort(entry.controller.signal, requestMediaHistoryVideoUrl(
          `/api/video/storage/${entry.taskId}`, this.token,
          { userId: this.userId, signal: entry.controller.signal },
        ));
      } catch { /* A later online preview may verify this saved copy. */ }
      finally { clearTimeout(ticketTimeout); }
      return interrupted() || { state: "saved" };
    } catch (error) {
      const afterError = interrupted(); if (afterError) return afterError;
      if (timedOut) return { state: "failed", reason: "timeout" };
      if (error instanceof StoryboardLocalVideoError && error.httpStatus !== undefined) {
        await this.revokeForStatus(entry.taskId, error.httpStatus, () => !interrupted() && !entry.controller.signal.aborted);
      }
      if (saving) return { state: "failed", reason: "storage" };
      return { state: "failed", reason: "network" };
    } finally { clearTimeout(timer); }
  }
}
