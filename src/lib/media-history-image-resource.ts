"use client";

/** A transient, account-scoped in-flight request shared by mounted consumers. */
export type MediaHistoryImageHandle = { promise: Promise<Blob>; release(): void };
type Entry = { key: string; controller: AbortController; subscribers: Set<() => void>; promise: Promise<Blob> };

const DEFAULT_TIMEOUT_MS = 20_000;
const abortError = () => new DOMException("Image request cancelled", "AbortError");

function imagePath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("图片预览地址无效");
  const parsed = new URL(path, "https://media-history.invalid");
  if (parsed.origin !== "https://media-history.invalid" || parsed.hash || parsed.searchParams.has("download") ||
      !(parsed.pathname === "/api/media-history/content" || /^\/api\/media-history\/commerce\/content\/[^/]+$/u.test(parsed.pathname))) {
    throw new Error("图片预览地址无效");
  }
  return parsed.pathname + parsed.search;
}

/** One instance belongs to one account AND token. Never share across auth scopes. */
export class MediaHistoryImageResource {
  private readonly entries = new Map<string, Entry>();
  // Completed entries do not serve new subscribers, but remain tracked until
  // their existing consumers release so account changes can cancel delivery.
  private readonly liveEntries = new Set<Entry>();
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(userId: string, token: string, fetcher: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!userId || userId.trim() !== userId || userId.length > 128 || !token || token.trim() !== token ||
        !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("IMAGE_RESOURCE_SCOPE_INVALID");
    this.token = token; this.fetcher = fetcher; this.timeoutMs = timeoutMs;
  }

  acquire(path: string): MediaHistoryImageHandle {
    if (this.disposed) throw abortError();
    const key = imagePath(path);
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: Entry = { key, controller, subscribers: new Set(), promise: Promise.resolve(new Blob()) };
      this.entries.set(key, created);
      this.liveEntries.add(created);
      created.promise = this.request(key, controller.signal).then(blob => {
        // A later click must revalidate access and expiry with the server. Do
        // not let an already completed card authorize a new preview session.
        if (this.entries.get(key) === created) this.entries.delete(key);
        return blob;
      }, error => {
        if (this.entries.get(key) === created) this.entries.delete(key);
        throw error;
      });
      entry = created;
    }
    const current = entry;
    let released = false;
    let rejectCancellation!: (error: DOMException) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = () => { if (!released) { released = true; current.subscribers.delete(cancel); rejectCancellation(abortError()); } };
    current.subscribers.add(cancel);
    const promise = Promise.race([current.promise, cancellation]).then(blob => {
      if (released || this.disposed) throw abortError();
      return blob;
    });
    // A React effect may release during unmount before its consumer attaches a
    // rejection handler. Mark it handled without changing the returned promise.
    void promise.catch(() => undefined);
    return { promise, release: () => {
      cancel();
      if (!current.subscribers.size) {
        this.liveEntries.delete(current);
        if (this.entries.get(key) === current) {
          this.entries.delete(key);
          current.controller.abort();
        }
      }
    } };
  }

  /** Invalidate only after the server confirms this particular record removal. */
  invalidate(path: string): void {
    const key = imagePath(path);
    for (const entry of [...this.liveEntries]) {
      if (entry.key !== key) continue;
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.liveEntries.delete(entry);
      for (const cancel of [...entry.subscribers]) cancel();
      entry.controller.abort();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.liveEntries) {
      for (const cancel of [...entry.subscribers]) cancel();
      entry.controller.abort();
    }
    this.entries.clear();
    this.liveEntries.clear();
  }

  private async request(path: string, signal: AbortSignal): Promise<Blob> {
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort();
    signal.addEventListener("abort", relayAbort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    // Race abort independently: an injected or nonconforming fetcher may ignore
    // AbortSignal; late responses must never revive a disposed account scope.
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(timedOut ? new Error("图片读取超时，请重试") : abortError());
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const read = async () => {
      // Native browser fetch is a Window method in some engines and rejects a
      // resource instance as its receiver. Bind to the current global rather
      // than accidentally invoking it as a method of this class.
      const response = await this.fetcher.call(globalThis, path, { headers: { Authorization: `Bearer ${this.token}` }, cache: "no-store", redirect: "error", signal: controller.signal });
      if (controller.signal.aborted) throw abortError();
      if (response.status !== 200 || response.headers.has("content-range")) throw new Error("图片暂时无法读取，请稍后重试");
      const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!mime.startsWith("image/")) throw new Error("图片格式无法预览");
      const blob = await response.blob();
      if (controller.signal.aborted) throw abortError();
      if (!blob.size || !blob.type.toLowerCase().startsWith("image/")) throw new Error("图片格式无法预览");
      return blob;
    };
    try { return await Promise.race([read(), cancelled]); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relayAbort);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    }
  }
}
