import { readImageDownloadBlob } from "./generated-image-download";

export class StoryboardImagePreviewError extends Error {
  constructor(public readonly mediaState: "expired" | "unavailable") {
    super(mediaState === "expired"
      ? "图片已生成，源文件已过期；原任务与费用收据保留"
      : "图片暂不可读取；原任务与费用收据保留，请稍后重新读取");
    this.name = "StoryboardImagePreviewError";
  }
}

export function isProtectedStoryboardPreview(value: string): boolean {
  try {
    const origin = typeof location === "undefined" ? "http://127.0.0.1:5000" : location.origin;
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname === "/api/media-history/content";
  } catch { return false; }
}

/** A decoded error bitmap is never evidence that the owned original is usable. */
export async function readStoryboardProtectedPreview(
  url: string,
  options: { timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<Blob | null> {
  if (!isProtectedStoryboardPreview(url)) return null;
  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StoryboardImagePreviewError("unavailable"));
    }, timeoutMs);
  });
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, deadline]);
  try {
    const response = await bounded((options.fetcher ?? fetch)(url, {
      signal: controller.signal, cache: "no-store", redirect: "error", credentials: "same-origin",
    }));
    if (response.status === 410) throw new StoryboardImagePreviewError("expired");
    if (!response.ok || response.headers.has("X-Media-Fallback")) {
      void response.body?.cancel().catch(() => undefined);
      throw new StoryboardImagePreviewError("unavailable");
    }
    const type = (response.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
    const maximumBytes = 30 * 1024 * 1024;
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)
      || Number(response.headers.get("Content-Length")) > maximumBytes || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new StoryboardImagePreviewError("unavailable");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    while (true) {
      const part = await bounded(reader.read());
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new StoryboardImagePreviewError("unavailable");
      chunks.push(new Uint8Array(part.value));
    }
    // Reuse the PNG/JPEG/WebP magic and size gate used by downloads.
    return await bounded(readImageDownloadBlob(
      { kind: "inline_ephemeral", blob: new Blob(chunks, { type }) }, "", controller.signal,
    ));
  } catch (error) {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    if (error instanceof StoryboardImagePreviewError) throw error;
    throw new StoryboardImagePreviewError("unavailable");
  } finally {
    if (timer) clearTimeout(timer);
    try { reader?.releaseLock(); } catch { /* A cancelled reader may already be detached. */ }
  }
}
