import { isIP } from "node:net";
import { validateSafeUrl } from "./safe-fetch";
import { fetchPinnedPublicAddress, lookupFixedPublicDns, PinnedRequestError, type PinnedFetch, type PublicDnsAddress } from "./safe-fetch-public-dns";

export class ExtractionProviderGetError extends Error {
  constructor(readonly code: string, readonly requestDispatched: boolean, readonly transportCode?: string) {
    super(code);
    this.name = "ExtractionProviderGetError";
  }
}

function transportCode(error: unknown): string | undefined {
  if (error instanceof PinnedRequestError) return error.transportCode && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.transportCode) ? error.transportCode : undefined;
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) return code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

const reachableAddresses = new Map<string, { address: PublicDnsAddress; expires: number }>();

/** PPT6 creates billable work only in the one credentialed GET. HEAD probes contain no credentials or input URL. */
export async function fetchExtractionProviderGetOnce(
  input: string,
  options: { configuredBaseUrl: string; timeoutMs?: number; maxBytes?: number; probeReachability?: boolean },
  dependencies: { lookup?: (hostname: string) => Promise<PublicDnsAddress[]>; pinnedFetch?: PinnedFetch; probeFetch?: PinnedFetch } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 60_000, 120_000));
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 4 * 1024 * 1024));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatched = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { void reader?.cancel().catch(() => undefined); };
  controller.signal.addEventListener("abort", abort, { once: true });
  const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const onAbort = () => reject(new ExtractionProviderGetError("EXTRACTION_PROVIDER_DEADLINE", dispatched));
    if (controller.signal.aborted) { void work.catch(() => undefined); onAbort(); return; }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
  });
  try {
    let url: URL, configured: URL;
    try { url = new URL(input); configured = new URL(options.configuredBaseUrl); }
    catch { throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_URL_INVALID", false); }
    if (url.origin !== configured.origin || url.pathname !== configured.pathname || configured.search || configured.hash
      || configured.username || configured.password || url.hash) {
      throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_TARGET_MISMATCH", false);
    }
    let addresses: PublicDnsAddress[] = [];
    await bounded(validateSafeUrl(url, { allowedPorts: [80, 443] }, { lookup: async hostname => {
      addresses = await (dependencies.lookup || lookupFixedPublicDns)(hostname);
      if (addresses.some(item => isIP(item.address) !== item.family || ![4, 6].includes(item.family))) {
        throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_DNS_INVALID", false);
      }
      return addresses;
    } }));
    // Literal addresses are validated by validateSafeUrl without calling lookup.
    const literalHost = url.hostname.replace(/^\[|\]$/gu, "");
    if (!addresses.length && isIP(literalHost)) addresses = [{ address: literalHost, family: isIP(literalHost) }];
    let address = [...addresses].sort((left, right) => left.family - right.family)[0];
    if (options.probeReachability && addresses.length > 1) {
      const key = configured.origin + configured.pathname;
      const cached = reachableAddresses.get(key);
      const cachedAddress = cached && cached.expires > Date.now()
        ? addresses.find(value => value.address === cached.address.address && value.family === cached.address.family) : undefined;
      if (cachedAddress) address = cachedAddress;
      else {
        let reachable: PublicDnsAddress | undefined;
        for (const candidate of [...addresses].sort((a, b) => a.family - b.family)) {
          if (controller.signal.aborted) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_DEADLINE", false);
          const probeController = new AbortController();
          const probeTimer = setTimeout(() => probeController.abort(), Math.min(2500, timeoutMs));
          try {
            const probe = await bounded((dependencies.probeFetch || fetchPinnedPublicAddress)(configured, candidate, {
              method: "HEAD", redirect: "manual", headers: { Accept: "application/json" },
              signal: AbortSignal.any([controller.signal, probeController.signal]),
            }));
            await probe.body?.cancel();
            if ([301, 302, 303, 307, 308].includes(probe.status) || probe.status >= 500) continue;
            // 任何HTTP响应(含429/430等业务状态)都证明上游在线,可选定该地址继续正式调用
            reachable = candidate; break;
          } catch (error) {
            if (error instanceof ExtractionProviderGetError) throw error;
            // Only a credential-free HEAD may move to another validated public address.
          } finally { clearTimeout(probeTimer); }
        }
        if (!reachable) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_TARGET_UNAVAILABLE", false);
        address = reachable;
        if (reachableAddresses.size >= 128) reachableAddresses.delete(reachableAddresses.keys().next().value!);
        reachableAddresses.set(key, { address, expires: Date.now() + 30_000 });
      }
    }
    if (!address) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_DNS_EMPTY", false);
    if (controller.signal.aborted) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_DEADLINE", false);
    dispatched = true;
    response = await bounded((dependencies.pinnedFetch || fetchPinnedPublicAddress)(url, address, {
      method: "GET", redirect: "manual", headers: { Accept: "application/json" }, signal: controller.signal,
    }));
    if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) {
      throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_REDIRECT_REJECTED", true);
    }
    const rawLength = response.headers.get("content-length");
    const declaredLength = rawLength === null ? undefined : Number(rawLength);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes)) {
      throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_SIZE_INVALID", true);
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_ENCODING_UNSUPPORTED", true);
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const chunk = await bounded(reader.read());
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_SIZE_INVALID", true);
        chunks.push(chunk.value);
      }
    }
    if (controller.signal.aborted) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_DEADLINE", true);
    if (declaredLength !== undefined && declaredLength !== size) throw new ExtractionProviderGetError("EXTRACTION_PROVIDER_BODY_INCOMPLETE", true);
    const body = [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks);
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (dispatched) reachableAddresses.delete(new URL(options.configuredBaseUrl).origin + new URL(options.configuredBaseUrl).pathname);
    if (error instanceof ExtractionProviderGetError) throw error;
    if (error instanceof PinnedRequestError) dispatched = error.requestDispatched;
    throw new ExtractionProviderGetError(controller.signal.aborted ? "EXTRACTION_PROVIDER_DEADLINE" : dispatched ? "EXTRACTION_PROVIDER_TRANSPORT_FAILED" : "EXTRACTION_PROVIDER_TARGET_UNAVAILABLE", dispatched, transportCode(error));
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}
