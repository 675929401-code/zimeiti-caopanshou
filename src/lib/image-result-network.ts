import { safeFetch, SafeFetchError, validateSafeUrl, type SafeFetchDependencies, type SafeFetchOptions } from "./safe-fetch";
import { lookupFixedPublicDns } from "./safe-fetch-public-dns";

function mayResolvePublicDns(error: unknown) {
  return error instanceof SafeFetchError && ["IP_FORBIDDEN", "DNS_LOOKUP_FAILED"].includes(error.code);
}

/** Validation of an owned image reference forwarded as provider input. This
 * does not fetch media; all addresses must still pass the shared IP checks. */
export async function validatePublicImageResultUrl(url: string, dependencies: Pick<SafeFetchDependencies, "lookup"> = {}) {
  try { return await validateSafeUrl(url, {}, dependencies); }
  catch (error) {
    if (!mayResolvePublicDns(error)) throw error;
    return validateSafeUrl(url, {}, { lookup: dependencies.lookup || lookupFixedPublicDns });
  }
}

/** Retrieve existing provider output; never send a generation request. Every
 * redirect is pinned to a validated public address. Proxy fake-IP DNS can use
 * the existing public resolver without allowing private IPs or host bypasses. */
export async function readPublicImageResult(
  url: string,
  options: Omit<SafeFetchOptions, "networkPolicy" | "trustedHostnames">,
  dependencies: SafeFetchDependencies = {},
) {
  try {
    return await safeFetch(url, { ...options, networkPolicy: "system-dns-pinned" }, dependencies);
  } catch (error) {
    if (!mayResolvePublicDns(error)) throw error;
    return safeFetch(url, { ...options, networkPolicy: "fixed-public-dns-pinned" }, dependencies);
  }
}
