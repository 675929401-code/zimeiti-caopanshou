import { SafeFetchError, safeFetchStream, type SafeFetchDependencies } from "@/lib/safe-fetch";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeMediaAuthorization {
  origin: string;
  value: string;
}

export interface SafeMediaFetchOptions {
  headers?: HeadersInit;
  authorization?: SafeMediaAuthorization | null;
  timeoutMs?: number;
  maxRedirects?: number;
  trustedHostnames?: string[];
}

export interface SafeMediaFetchResult {
  response: Response;
  finalUrl: string;
}

export function trustedRelayHostnamesFromEnv() {
  return String(process.env.DIGITAL_HUMAN_TRUSTED_RELAY_HOSTNAMES || "")
    .split(/[\s,]+/u)
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
}

function normalizedAuthorization(input: SafeMediaAuthorization | null | undefined) {
  if (!input?.value) return null;
  try {
    return { origin: new URL(input.origin).origin, value: input.value };
  } catch {
    return null;
  }
}

/**
 * Stream-friendly remote media fetch with SSRF-safe redirect handling.
 * Authorization is rebuilt for every hop and is only sent to the exact
 * configured provider origin; a cross-origin redirect never receives it.
 */
export async function safeMediaFetch(
  input: string | URL,
  options: SafeMediaFetchOptions = {},
  dependencies: SafeFetchDependencies = {},
): Promise<SafeMediaFetchResult> {
  const trustedHostnames = options.trustedHostnames || trustedRelayHostnamesFromEnv();
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 5));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 300_000));
  const authorization = normalizedAuthorization(options.authorization);
  let current: URL;
  try { current = new URL(input); } catch { throw new SafeFetchError("URL 格式无效", "INVALID_URL"); }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let response: Response;
    try {
      const result = await safeFetchStream(current, {
        headers: options.headers,
        authorization,
        timeoutMs,
        trustedHostnames,
      }, dependencies);
      response = result.response;
      current = new URL(result.finalUrl);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError("远程媒体请求失败或超时", "MEDIA_FETCH_FAILED", 502);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current.toString() };
    }

    await response.body?.cancel().catch(() => undefined);
    if (redirectCount >= maxRedirects) {
      throw new SafeFetchError("远程媒体重定向次数过多", "MEDIA_TOO_MANY_REDIRECTS", 502);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new SafeFetchError("远程媒体重定向缺少目标", "MEDIA_INVALID_REDIRECT", 502);
    }
    current = new URL(location, current);
  }

  throw new SafeFetchError("远程媒体请求失败", "MEDIA_FETCH_FAILED", 502);
}
