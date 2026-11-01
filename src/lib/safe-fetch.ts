import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetchPinnedPublicAddress, lookupFixedPublicDns, usesDevelopmentPublicDns, PINNED_MAX_REQUEST_BYTES, PinnedRequestError, type PinnedFetch, type PublicDnsAddress } from "./safe-fetch-public-dns";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type SafeFetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SafeFetchDependencies {
  lookup?: SafeLookup;
  fetch?: SafeFetchImplementation;
  pinnedFetch?: PinnedFetch;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Resolve through the fixed public resolver and pin every redirect hop to an audited IP. */
  networkPolicy?: "default" | "fixed-public-dns-pinned" | "system-dns-pinned";
  allowedContentTypes?: string[];
  allowedPorts?: number[];
  trustedHostnames?: string[];
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: Headers;
  contentType: string;
  buffer: Buffer;
}

export class SafeFetchError extends Error {
  readonly upstreamStatus?: number;
  readonly requestDispatched?: boolean;

  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    details: { upstreamStatus?: number; requestDispatched?: boolean } = {},
  ) {
    super(message);
    this.name = "SafeFetchError";
    this.upstreamStatus = details.upstreamStatus;
    this.requestDispatched = details.requestDispatched;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0];
  const mappedIpv4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    const octets = parseIpv4(mappedIpv4[2]);
    if (!octets) return null;
    value = `${mappedIpv4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const groups = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].map((group) => Number.parseInt(group || "0", 16));

  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return groups;
}

export function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = parseIpv4(address);
    if (!octets) return true;
    const [a, b, c] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }

  if (version === 6) {
    const groups = expandIpv6(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5] = groups;

    if (groups.every((group) => group === 0)) return true;
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
    if ((g0 & 0xfe00) === 0xfc00) {
      return true;
    }
    if ((g0 & 0xffc0) === 0xfe80) return true;
    if ((g0 & 0xffc0) === 0xfec0) return true;
    if ((g0 & 0xff00) === 0xff00) return true;
    if (g0 === 0x2001 && g1 === 0x0db8) return true;
    if (g0 === 0x2001 && g1 === 0x0002) return true;
    if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true;
    if (g0 === 0x2001 && g1 === 0x0000) return true;
    if (g0 === 0x2002) return true;
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    if (g0 === 0x0064 && g1 === 0xff9b) return true;

    const isIpv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
    if (isIpv4Mapped) {
      const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      return isBlockedIpAddress(mapped);
    }

    // Unspecified/IPv4-compatible and other reserved ::/96 addresses.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
    return false;
  }

  return true;
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  return allowed.some((rule) => {
    const normalized = rule.toLowerCase();
    if (normalized.endsWith("/*")) return contentType.startsWith(normalized.slice(0, -1));
    return contentType === normalized;
  });
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function resolveSafeTarget(
  input: string | URL,
  options: Pick<SafeFetchOptions, "allowedPorts" | "trustedHostnames"> = {},
  dependencies: Pick<SafeFetchDependencies, "lookup"> = {},
  publicDns = usesDevelopmentPublicDns(),
): Promise<{ url: URL; addresses: PublicDnsAddress[] }> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new SafeFetchError("URL 格式无效", "INVALID_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("仅允许 HTTP/HTTPS URL", "UNSUPPORTED_PROTOCOL");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("URL 不得包含凭据", "URL_CREDENTIALS_FORBIDDEN");
  }

  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  const allowedPorts = options.allowedPorts || [80, 443];
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    throw new SafeFetchError("目标端口不允许访问", "PORT_FORBIDDEN");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SafeFetchError("目标主机不允许访问", "HOST_FORBIDDEN");
  }

  const directIpVersion = isIP(hostname);
  if (directIpVersion) {
    if (isBlockedIpAddress(hostname)) {
      throw new SafeFetchError("目标地址不允许访问", "IP_FORBIDDEN");
    }
    return { url, addresses: [{ address: hostname, family: directIpVersion }] };
  }

  const trustedHostnames = (options.trustedHostnames || []).map(normalizeHostname);
  if (!publicDns && url.protocol === "https:" && trustedHostnames.includes(hostname)) {
    return { url, addresses: [] };
  }

  const lookup = dependencies.lookup || (publicDns ? lookupFixedPublicDns : defaultLookup);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new SafeFetchError("目标主机无法解析", "DNS_LOOKUP_FAILED", 502);
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => isBlockedIpAddress(address) || (publicDns && isIP(address) !== family))) {
    throw new SafeFetchError("目标地址不允许访问", "IP_FORBIDDEN");
  }
  return { url, addresses };
}

export async function validateSafeUrl(
  input: string | URL,
  options: Pick<SafeFetchOptions, "allowedPorts" | "trustedHostnames"> = {},
  dependencies: Pick<SafeFetchDependencies, "lookup"> = {},
): Promise<URL> {
  // Validation-only callers may subsequently use a different transport. Keep
  // their system-DNS behavior; public DNS is safe only together with IP pinning.
  return (await resolveSafeTarget(input, options, dependencies, false)).url;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SafeFetchError("远程内容超过大小限制", "RESPONSE_TOO_LARGE", 413);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SafeFetchError("远程内容超过大小限制", "RESPONSE_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function sanitizedHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const name of ["authorization", "cookie", "proxy-authorization", "host", "x-api-key"]) {
    headers.delete(name);
  }
  return headers;
}

export interface SafeFetchJsonPostOptions extends Pick<SafeFetchOptions, "timeoutMs" | "maxBytes" | "allowedPorts" | "headers" | "signal"> {
  maxRequestBytes?: number;
  authorization?: { origin: string; value: string } | null;
}

export interface SafeFetchJsonPostResult<T> extends SafeFetchResult {
  json: T;
}

function jsonPostLimit(value: number | undefined, fallback: number, ceiling: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) {
    throw new SafeFetchError("远程请求限制无效", "INVALID_FETCH_LIMITS");
  }
  return limit;
}

function withJsonPostAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

async function readJsonPostBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new SafeFetchError("远程响应长度无效", "INVALID_CONTENT_LENGTH", 502);
  }
  if (declared !== null && Number(declared) > maxBytes) {
    throw new SafeFetchError("远程内容超过大小限制", "RESPONSE_TOO_LARGE", 413);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withJsonPostAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        throw new SafeFetchError("远程内容超过大小限制", "RESPONSE_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** One bounded HTTPS JSON POST, pinned in every environment. Never redirects or retries. */
export async function safeFetchJsonPost<T = unknown>(
  input: string | URL,
  serializedJson: string | Uint8Array,
  options: SafeFetchJsonPostOptions = {},
  dependencies: Pick<SafeFetchDependencies, "lookup" | "pinnedFetch"> = {},
): Promise<SafeFetchJsonPostResult<T>> {
  let requestDispatched = false;
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  try {
    const timeoutMs = jsonPostLimit(options.timeoutMs, 20_000, 120_000);
    const maxBytes = jsonPostLimit(options.maxBytes, 2 * 1024 * 1024, 10 * 1024 * 1024);
    const maxRequestBytes = jsonPostLimit(options.maxRequestBytes, 256 * 1024, PINNED_MAX_REQUEST_BYTES);
    if (options.signal?.aborted) throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
    if (typeof serializedJson !== "string" && !(serializedJson instanceof Uint8Array)) {
      throw new SafeFetchError("请求体必须为 JSON 文本或字节", "INVALID_JSON_BODY");
    }
    const requestBytes = typeof serializedJson === "string" ? Buffer.byteLength(serializedJson, "utf8") : serializedJson.byteLength;
    if (requestBytes > maxRequestBytes) throw new SafeFetchError("请求内容超过大小限制", "REQUEST_TOO_LARGE", 413);
    // Copy byte inputs before any await, so callers cannot mutate validated JSON.
    const body = typeof serializedJson === "string" ? Buffer.from(serializedJson, "utf8") : Buffer.from(serializedJson);
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new SafeFetchError("请求体不是有效 JSON", "INVALID_JSON_BODY"); }
    let parsed: URL;
    try { parsed = new URL(input.toString()); }
    catch { throw new SafeFetchError("URL 格式无效", "INVALID_URL"); }
    if (parsed.protocol !== "https:") throw new SafeFetchError("JSON 请求仅允许 HTTPS", "HTTPS_REQUIRED");

    timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) controller.abort();
    // Do not pass trustedHostnames: POST must resolve and validate every address,
    // even for legacy trusted hosts in production, before its socket is pinned.
    const target = await withJsonPostAbort(resolveSafeTarget(parsed, { allowedPorts: options.allowedPorts || [443] }, dependencies, usesDevelopmentPublicDns()), controller.signal);
    if (target.addresses.length === 0 || target.addresses.some(({ address, family }) => isIP(address) !== family)) {
      throw new SafeFetchError("目标地址不允许访问", "IP_FORBIDDEN");
    }
    const headers = sanitizedHeaders(options.headers);
    for (const name of ["content-length", "transfer-encoding", "trailer", "expect"]) headers.delete(name);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("accept", "application/json");
    headers.set("content-length", String(body.byteLength));
    if (options.authorization?.value) {
      let scope: URL | undefined;
      try { scope = new URL(options.authorization.origin); } catch { /* Invalid scopes never send credentials. */ }
      if (scope?.protocol === "https:" && !scope.username && !scope.password && scope.origin === target.url.origin) {
        headers.set("authorization", options.authorization.value);
      }
    }
    if (controller.signal.aborted) throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
    const address = target.addresses.find((entry) => entry.family === 4) || target.addresses[0];
    requestDispatched = true;
    response = await withJsonPostAbort((dependencies.pinnedFetch || fetchPinnedPublicAddress)(target.url, address, {
      method: "POST", body, headers, redirect: "manual", signal: controller.signal,
    }), controller.signal);
    if (REDIRECT_STATUSES.has(response.status) || response.redirected) {
      throw new SafeFetchError("JSON 请求不允许重定向", "REDIRECT_FORBIDDEN", 502, { upstreamStatus: response.status });
    }
    if (!response.ok) throw new SafeFetchError("远程服务器返回错误", "UPSTREAM_STATUS", 502, { upstreamStatus: response.status });
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(contentType)) {
      throw new SafeFetchError("远程响应必须为 JSON", "CONTENT_TYPE_FORBIDDEN", 415);
    }
    const buffer = await readJsonPostBody(response, maxBytes, controller.signal);
    let json: T;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as T; }
    catch { throw new SafeFetchError("远程响应不是有效 JSON", "INVALID_JSON_RESPONSE", 502); }
    return { url: target.url.toString(), status: response.status, headers: response.headers, contentType, buffer, json };
  } catch (error) {
    const explicitDispatch = error && typeof error === "object" && "requestDispatched" in error ? error.requestDispatched : undefined;
    if (typeof explicitDispatch === "boolean") requestDispatched = explicitDispatch;
    if (error instanceof SafeFetchError) {
      throw new SafeFetchError(error.message, error.code, error.status, { upstreamStatus: error.upstreamStatus, requestDispatched });
    }
    throw new SafeFetchError(controller.signal.aborted ? "远程请求超时或已取消" : "远程请求失败",
      controller.signal.aborted ? "FETCH_ABORTED" : "FETCH_FAILED", controller.signal.aborted ? 504 : 502, { requestDispatched });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
}

export interface SafeFetchStreamOptions extends Pick<SafeFetchOptions, "timeoutMs" | "allowedPorts" | "trustedHostnames" | "headers" | "signal" | "networkPolicy"> {
  authorization?: { origin: string; value: string } | null;
}

const RETRYABLE_GET_CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"]);

/**
 * All addresses have already passed resolveSafeTarget together. Only a GET
 * connection that failed before response headers may move to another address
 * from that same DNS answer; TLS/HTTP/body errors never cause another request.
 */
async function fetchPinnedGet(
  url: URL,
  addresses: PublicDnsAddress[],
  init: RequestInit,
  pinnedFetch: PinnedFetch,
): Promise<Response> {
  if (init.method !== "GET" || init.body != null) throw new PinnedRequestError("PINNED_GET_REQUIRED", false);
  const candidates = [...new Map(addresses.map(address => [`${address.family}:${address.address}`, address])).values()]
    .sort((left, right) => left.family - right.family).slice(0, 3);
  for (let index = 0; index < candidates.length; index += 1) {
    if (init.signal?.aborted) throw new PinnedRequestError("PINNED_REQUEST_ABORTED", false);
    const connection = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, connection.signal]) : connection.signal;
    // The last candidate retains the caller's remaining timeout, including
    // single-address hosts whose first byte can legitimately take longer.
    const timer = index < candidates.length - 1 ? setTimeout(() => connection.abort(), 5_000) : undefined;
    try {
      // The connection timer is cleared as soon as headers arrive. The outer
      // caller's signal continues to control the already-open response body.
      return await pinnedFetch(url, candidates[index], { ...init, signal });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const connectionFailed = connection.signal.aborted
        || (error instanceof PinnedRequestError && RETRYABLE_GET_CONNECTION_CODES.has(error.transportCode || ""));
      if (!connectionFailed || index === candidates.length - 1) throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new PinnedRequestError("PINNED_ADDRESS_MISSING", false);
}

/**
 * One validated streaming GET. Redirects are returned untouched so each caller
 * can enforce its own hostname rules before requesting the next hop.
 */
export async function safeFetchStream(
  input: string | URL,
  options: SafeFetchStreamOptions = {},
  dependencies: SafeFetchDependencies = {},
): Promise<{ response: Response; finalUrl: string }> {
  const fixedPublicDns = options.networkPolicy === "fixed-public-dns-pinned"
    || (options.networkPolicy === undefined && usesDevelopmentPublicDns());
  const pinnedTransport = fixedPublicDns || options.networkPolicy === "system-dns-pinned";
  const targetOptions = pinnedTransport ? { ...options, trustedHostnames: [] } : options;
  if (options.signal?.aborted) throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
  const target = await resolveSafeTarget(input, targetOptions, dependencies, fixedPublicDns);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 300_000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers = sanitizedHeaders(options.headers);
  if (options.authorization?.value) {
    let authorizationOrigin = "";
    try { authorizationOrigin = new URL(options.authorization.origin).origin; } catch { /* Invalid authorization scope sends no credentials. */ }
    if (authorizationOrigin === target.url.origin) headers.set("authorization", options.authorization.value);
  }
  const init: RequestInit = { method: "GET", headers, redirect: "manual", signal };
  try {
    const response = pinnedTransport
      ? await fetchPinnedGet(target.url, target.addresses, init, dependencies.pinnedFetch || fetchPinnedPublicAddress)
      : await (dependencies.fetch || fetch)(target.url, init);
    return { response, finalUrl: target.url.toString() };
  } catch {
    if (signal.aborted) throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
    throw new SafeFetchError("远程请求失败", "FETCH_FAILED", 502);
  }
}

export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
  dependencies: SafeFetchDependencies = {},
): Promise<SafeFetchResult> {
  const fetchImplementation = dependencies.fetch || fetch;
  // An explicit system-DNS policy is used for signed media CDNs in the local
  // production preview, where the audited pinned transport must remain active
  // but the opt-in fixed DoH resolver may be unreachable. Explicit caller
  // policy takes precedence over the environment default.
  const fixedPublicDns = options.networkPolicy === "fixed-public-dns-pinned"
    || (options.networkPolicy === undefined && usesDevelopmentPublicDns());
  const pinnedTransport = fixedPublicDns || options.networkPolicy === "system-dns-pinned";
  const targetOptions = pinnedTransport ? { ...options, trustedHostnames: [] } : options;
  // 媒体资产转存可能超过 30 秒（慢 CDN 上 100MB 视频），与流式变体一致放宽到 5 分钟。
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 300_000));
  const maxBytes = Math.max(1, options.maxBytes || DEFAULT_MAX_BYTES);
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 5));
  if (pinnedTransport && options.signal?.aborted) throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
  let target = await resolveSafeTarget(input, targetOptions, dependencies, fixedPublicDns);
  let current = target.url;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (pinnedTransport && options.signal?.aborted) controller.abort();

    let response: Response;
    try {
      const init: RequestInit = {
        method: "GET",
        headers: sanitizedHeaders(options.headers),
        redirect: "manual",
        signal: controller.signal,
      };
      if (pinnedTransport) {
        response = await fetchPinnedGet(current, target.addresses, init, dependencies.pinnedFetch || fetchPinnedPublicAddress);
      } else response = await fetchImplementation(current, init);
    } catch {
      if (controller.signal.aborted) {
        throw new SafeFetchError("远程请求超时或已取消", "FETCH_ABORTED", 504);
      }
      throw new SafeFetchError("远程请求失败", "FETCH_FAILED", 502);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError("远程重定向次数过多", "TOO_MANY_REDIRECTS", 502);
      }
      const location = response.headers.get("location");
      if (!location) throw new SafeFetchError("远程重定向缺少目标", "INVALID_REDIRECT", 502);
      target = await resolveSafeTarget(new URL(location, current), targetOptions, dependencies, fixedPublicDns);
      current = target.url;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new SafeFetchError("远程服务器返回错误", "UPSTREAM_STATUS", 502, { upstreamStatus: response.status });
    }

    const contentType = (response.headers.get("content-type") || "application/octet-stream")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (options.allowedContentTypes?.length && !contentTypeAllowed(contentType, options.allowedContentTypes)) {
      await response.body?.cancel();
      throw new SafeFetchError("远程内容类型不允许", "CONTENT_TYPE_FORBIDDEN", 415);
    }

    const bodyTimer = setTimeout(() => controller.abort(), timeoutMs);
    if (pinnedTransport) options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (pinnedTransport && options.signal?.aborted) controller.abort();
    try {
      const buffer = await readLimitedBody(response, maxBytes);
      return {
        url: current.toString(),
        status: response.status,
        headers: response.headers,
        contentType,
        buffer,
      };
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (controller.signal.aborted) {
        throw new SafeFetchError("Remote response timed out", "FETCH_ABORTED", 504);
      }
      throw new SafeFetchError("Remote response failed", "FETCH_FAILED", 502);
    } finally {
      clearTimeout(bodyTimer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  throw new SafeFetchError("远程请求失败", "FETCH_FAILED", 502);
}
