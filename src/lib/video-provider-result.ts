import { safeMediaFetch } from "./safe-media-fetch";
import { validateUploadBuffer } from "./file-upload-security";
import type { SafeFetchDependencies } from "./safe-fetch";

/** Relative result paths belong to the configured provider, never the website. */
export function resolveVideoProviderResultUrl(value: string, providerEndpoint: string): string {
  const base = new URL(providerEndpoint);
  const result = new URL(value, base);
  if (!["https:", "http:"].includes(result.protocol) || result.username || result.password) {
    throw new Error("VIDEO_PROVIDER_RESULT_URL_INVALID");
  }
  return result.toString();
}

/** Credentials are sent only to the configured origin, including across redirects. */
export async function readVideoProviderResult(
  value: string,
  providerEndpoint: string,
  providerApiKey: string,
  maxBytes = 512 * 1024 * 1024,
) {
  const url = resolveVideoProviderResultUrl(value, providerEndpoint);
  const { response } = await safeMediaFetch(url, {
    authorization: providerApiKey ? { origin: new URL(providerEndpoint).origin, value: `Bearer ${providerApiKey}` } : null,
    headers: { Accept: "video/mp4,application/octet-stream" },
    timeoutMs: 120_000,
    maxRedirects: 3,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`VIDEO_PROVIDER_RESULT_HTTP_${response.status}`);
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const declared = response.headers.get("content-length");
  if (!["video/mp4", "application/octet-stream"].includes(contentType)
    || (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes))) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("VIDEO_PROVIDER_RESULT_CONTENT_INVALID");
  }
  if (!response.body) throw new Error("VIDEO_PROVIDER_RESULT_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("VIDEO_PROVIDER_RESULT_TOO_LARGE");
      chunks.push(chunk);
    }
    if (!size || (declared !== null && Number(declared) !== size)) throw new Error("VIDEO_PROVIDER_RESULT_LENGTH_INVALID");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  const validated = validateUploadBuffer(buffer, "video/mp4");
  if (validated.contentType !== "video/mp4") throw new Error("VIDEO_PROVIDER_RESULT_FORMAT_INVALID");
  return { buffer, contentType: validated.contentType };
}

/** Reject complete-looking prefixes: every top-level MP4 box must fit in the received file. */
export function assertCompleteVideoMp4(buffer: Buffer) {
  let offset = 0;
  const boxes = new Set<string>();
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) throw new Error("GAORUI_RESULT_MP4_TRUNCATED");
    let size = buffer.readUInt32BE(offset);
    const kind = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (buffer.length - offset < 16) throw new Error("GAORUI_RESULT_MP4_TRUNCATED");
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GAORUI_RESULT_MP4_INVALID");
      size = Number(extended); headerSize = 16;
    } else if (size === 0) size = buffer.length - offset;
    if (size < headerSize || size > buffer.length - offset) throw new Error("GAORUI_RESULT_MP4_TRUNCATED");
    boxes.add(kind); offset += size;
  }
  if (!boxes.has("ftyp") || !boxes.has("moov") || !boxes.has("mdat")) throw new Error("GAORUI_RESULT_MP4_INCOMPLETE");
}

function waitForMedia<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("GAORUI_RESULT_DOWNLOAD_TIMEOUT"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("GAORUI_RESULT_DOWNLOAD_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readGaoruiCompleteResult(url: URL, input: { providerOrigin: string; providerApiKey: string; maxBytes: number; timeoutMs: number; requestedPaths: Set<string>; trustedHostnames: string[] }, dependencies: SafeFetchDependencies) {
  const { safeFetchStream } = await import("./safe-fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const deadline = Date.now() + input.timeoutMs;
  let response: Response | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const requestPath = current.origin + current.pathname;
      if (input.requestedPaths.has(requestPath)) throw new Error("GAORUI_RESULT_REDIRECT_LOOP");
      input.requestedPaths.add(requestPath);
      const downloaded = await waitForMedia(safeFetchStream(current, {
        // safeFetchStream rebuilds Authorization for the exact configured origin on EVERY hop.
        authorization: input.providerApiKey ? { origin: input.providerOrigin, value: `Bearer ${input.providerApiKey}` } : null,
        headers: { Accept: "video/mp4,application/octet-stream" },
        trustedHostnames: input.trustedHostnames,
        timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal,
      }, dependencies), controller.signal);
      response = downloaded.response;
      if (response.redirected) throw new Error("GAORUI_RESULT_UNCONTROLLED_REDIRECT");
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await waitForMedia(response.body?.cancel().catch(() => undefined) || Promise.resolve(), controller.signal);
      if (!location || redirects === 3) throw new Error("GAORUI_RESULT_REDIRECT_INVALID");
      current = new URL(resolveVideoProviderResultUrl(location, current.toString()));
    }
    if (!response || response.status !== 200) throw new Error(`GAORUI_RESULT_HTTP_${response?.status || 0}`);
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const declared = response.headers.get("content-length");
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (!["video/mp4", "application/octet-stream"].includes(contentType) || (contentEncoding && contentEncoding !== "identity")
      || (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) <= 0 || Number(declared) > input.maxBytes))) throw new Error("GAORUI_RESULT_CONTENT_INVALID");
    if (!response.body) throw new Error("GAORUI_RESULT_EMPTY");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await waitForMedia(reader.read(), controller.signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > input.maxBytes) throw new Error("GAORUI_RESULT_TOO_LARGE");
      chunks.push(chunk.value);
    }
    if (!size || (declared !== null && Number(declared) !== size)) throw new Error("GAORUI_RESULT_LENGTH_INVALID");
    const buffer = Buffer.concat(chunks);
    const validated = validateUploadBuffer(buffer, "video/mp4");
    if (validated.contentType !== "video/mp4") throw new Error("GAORUI_RESULT_FORMAT_INVALID");
    assertCompleteVideoMp4(buffer);
    return { buffer, contentType: "video/mp4" };
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}

/** Read only the SAME already-generated task. At most one result GET chain and one content GET chain. */
export async function readGaoruiVideoProviderResult(input: {
  resultUrl: string; providerEndpoint: string; providerApiKey: string; providerTaskId?: string;
  trustedProviderResultHostname?: string;
  maxBytes?: number; primaryTimeoutMs?: number; contentTimeoutMs?: number;
}, dependencies: SafeFetchDependencies = {}) {
  const provider = new URL(resolveVideoProviderResultUrl(input.providerEndpoint, input.providerEndpoint));
  const primary = input.resultUrl ? new URL(resolveVideoProviderResultUrl(input.resultUrl, provider.toString())) : null;
  const taskId = typeof input.providerTaskId === "string" ? input.providerTaskId.trim() : "";
  const content = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(taskId)
    ? new URL(`/v1/videos/${encodeURIComponent(taskId)}/content`, provider.origin) : null;
  const trustedResultHostname = String(input.trustedProviderResultHostname || "").trim().toLowerCase();
  const trustedHostnames = primary?.protocol === "https:"
    && primary.hostname.toLowerCase() === trustedResultHostname
    && !primary.port && !primary.username && !primary.password
    ? [trustedResultHostname]
    : [];
  const settings = { providerOrigin: provider.origin, providerApiKey: input.providerApiKey, maxBytes: input.maxBytes ?? 512 * 1024 * 1024, requestedPaths: new Set<string>(), trustedHostnames };
  const sameContent = primary && content && primary.origin === content.origin && primary.pathname === content.pathname;
  if (sameContent) return readGaoruiCompleteResult(primary, { ...settings, timeoutMs: input.contentTimeoutMs ?? 120_000 }, dependencies);
  if (primary) {
    try { return await readGaoruiCompleteResult(primary, { ...settings, timeoutMs: input.primaryTimeoutMs ?? 30_000 }, dependencies); }
    catch { /* Do not log URLs/credentials or resubmit. Try only this task's configured content resource. */ }
  }
  if (!content) throw new Error("GAORUI_RESULT_DOWNLOAD_FAILED_NO_TASK_ID");
  if (settings.requestedPaths.has(content.origin + content.pathname)) throw new Error("GAORUI_RESULT_DOWNLOAD_FAILED_CONTENT_UNAVAILABLE");
  if (!input.providerApiKey.trim()) throw new Error("GAORUI_RESULT_CONTENT_CREDENTIAL_REQUIRED");
  try { return await readGaoruiCompleteResult(content, { ...settings, timeoutMs: input.contentTimeoutMs ?? 120_000 }, dependencies); }
  catch { throw new Error("GAORUI_RESULT_DOWNLOAD_FAILED_CONTENT_UNAVAILABLE"); }
}
