import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export type PublicDnsAddress = { address: string; family: number };
export type PinnedHttpRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type PinnedFetch = (url: URL, address: PublicDnsAddress, init: RequestInit) => Promise<Response>;
export const PINNED_MAX_REQUEST_BYTES = 1024 * 1024;

export class PinnedRequestError extends Error {
  constructor(message: string, readonly requestDispatched: boolean, readonly transportCode?: string) {
    super(message);
    this.name = "PinnedRequestError";
  }
}
function sanitizedTransportCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : undefined;
}
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_ADDRESS = { address: "1.1.1.1", family: 4 } as const;
const DNS_TIMEOUT_MS = 8_000;
const DNS_MAX_BYTES = 64 * 1024;

export function usesDevelopmentPublicDns(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const localAcceptance = environment.LOCAL_ACCEPTANCE_PREVIEW === "true"
    && environment.COZE_SUPABASE_URL === "http://127.0.0.1:54321"
    && [".next-local-acceptance", ".next-local-acceptance-next"].includes(environment.LOCAL_VALIDATION_DIST_DIR || "");
  return (environment.NODE_ENV === "development" || localAcceptance)
    && environment.SAFE_FETCH_PUBLIC_DNS === "cloudflare-doh-v1";
}

/** The caller has checked every DNS answer; this transport never resolves again. */
export function fetchPinnedPublicAddress(
  url: URL,
  address: PublicDnsAddress,
  init: RequestInit,
  dependencies: { request?: PinnedHttpRequest } = {},
): Promise<Response> {
  if (isIP(address.address) !== address.family || ![4, 6].includes(address.family)) return Promise.reject(new PinnedRequestError("PINNED_ADDRESS_INVALID", false));
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") return Promise.reject(new PinnedRequestError("PINNED_PROTOCOL_INVALID", false));
  const method = (init.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "HEAD") return Promise.reject(new PinnedRequestError("PINNED_METHOD_INVALID", false));
  let requestBody: Buffer | undefined;
  if (method === "POST") {
    if (init.body != null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) return Promise.reject(new PinnedRequestError("PINNED_BODY_INVALID", false));
    const bodyBytes = typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : init.body?.byteLength || 0;
    if (bodyBytes > PINNED_MAX_REQUEST_BYTES) return Promise.reject(new PinnedRequestError("PINNED_REQUEST_TOO_LARGE", false));
    requestBody = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : Buffer.from(init.body || new Uint8Array());
  } else if (init.body != null) return Promise.reject(new PinnedRequestError("PINNED_GET_BODY_FORBIDDEN", false));
  if (init.signal?.aborted) return Promise.reject(new PinnedRequestError("PINNED_REQUEST_ABORTED", false));
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  headers.set("accept-encoding", "identity");
  if (method === "POST") {
    for (const name of ["content-length", "transfer-encoding", "trailer", "expect"]) headers.delete(name);
    headers.set("content-length", String(requestBody!.byteLength));
  }
  // An explicit fresh native agent avoids global fetch dispatchers and proxy
  // agents. The socket connects to an IP literal, while TLS verifies the URL host.
  const agent = secure ? new HttpsAgent({ keepAlive: false, rejectUnauthorized: true, maxCachedSessions: 0 }) : new HttpAgent({ keepAlive: false });
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    method,
    path: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(headers),
    agent,
    signal: init.signal || undefined,
    ...(secure ? { servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true } : {}),
    // IP literals never need a lookup. Fail closed if a future transport tries one.
    lookup: (_hostname, _options, callback) => callback(new Error("PINNED_DNS_LOOKUP_FORBIDDEN"), "", 0),
  };
  return new Promise((resolve, reject) => {
    const request = dependencies.request || (secure ? httpsRequest : httpRequest);
    let requestDispatched = false;
    try {
      const req = request(options, (incoming) => {
        incoming.once("close", () => agent.destroy());
        try {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          const status = incoming.statusCode || 502;
          const noBody = method === "HEAD" || [204, 205, 304].includes(status);
          if (noBody) incoming.resume();
          const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, headers }));
        } catch {
          incoming.destroy();
          agent.destroy();
          reject(new PinnedRequestError("PINNED_RESPONSE_INVALID", true));
        }
      });
      req.once("error", (error) => { agent.destroy(); reject(new PinnedRequestError("PINNED_REQUEST_FAILED", requestDispatched, sanitizedTransportCode(error))); });
      // Once end() may write bytes, a connection error cannot prove non-acceptance.
      requestDispatched = true;
      if (requestBody !== undefined) req.end(requestBody); else req.end();
    } catch (error) {
      agent.destroy();
      reject(new PinnedRequestError("PINNED_REQUEST_FAILED", requestDispatched, sanitizedTransportCode(error)));
    }
  });
}

function parseDnsAnswers(value: unknown, hostname: string, type: "A" | "AAAA"): PublicDnsAddress[] {
  if (!value || typeof value !== "object") throw new Error("PUBLIC_DNS_RESPONSE_INVALID");
  const result = value as Record<string, unknown>;
  if (result.Status !== 0 || result.TC === true || result.CD === true) throw new Error("PUBLIC_DNS_QUERY_FAILED");
  const questions = result.Question;
  const expectedType = type === "A" ? 1 : 28;
  if (!Array.isArray(questions) || questions.length !== 1 || questions[0]?.type !== expectedType
    || String(questions[0]?.name || "").replace(/\.$/u, "").toLowerCase() !== hostname.toLowerCase()) throw new Error("PUBLIC_DNS_QUESTION_MISMATCH");
  if (result.Answer === undefined) return [];
  if (!Array.isArray(result.Answer) || result.Answer.length > 128) throw new Error("PUBLIC_DNS_ANSWER_INVALID");
  const addresses: PublicDnsAddress[] = [];
  for (const answer of result.Answer) {
    if (!answer || typeof answer !== "object") throw new Error("PUBLIC_DNS_ANSWER_INVALID");
    if (answer.type !== 1 && answer.type !== 28) continue; // CNAME and metadata are not socket targets.
    const family = answer.type === 1 ? 4 : 6;
    if (typeof answer.data !== "string" || isIP(answer.data) !== family) throw new Error("PUBLIC_DNS_ADDRESS_INVALID");
    addresses.push({ address: answer.data, family });
  }
  return addresses;
}

/** Fixed HTTPS resolver, with no system-DNS or insecure fallback. */
export async function lookupFixedPublicDns(hostname: string, dependencies: { fetchPinned?: PinnedFetch } = {}): Promise<PublicDnsAddress[]> {
  const fetchPinned = dependencies.fetchPinned || fetchPinnedPublicAddress;
  const responses = await Promise.all((["A", "AAAA"] as const).map(async (type) => {
    const url = new URL(DOH_URL);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetchPinned(url, DOH_ADDRESS, { method: "GET", redirect: "manual", headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("PUBLIC_DNS_HTTP_FAILED"); }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (contentType !== "application/dns-json" && contentType !== "application/json") { await response.body.cancel(); throw new Error("PUBLIC_DNS_CONTENT_TYPE_INVALID"); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > DNS_MAX_BYTES) { await reader.cancel(); throw new Error("PUBLIC_DNS_RESPONSE_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return parseDnsAnswers(JSON.parse(Buffer.concat(chunks).toString("utf8")), hostname, type);
  }));
  const addresses = responses.flat();
  if (addresses.length === 0) throw new Error("PUBLIC_DNS_NO_ADDRESSES");
  return [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
}
