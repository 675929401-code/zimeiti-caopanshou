import { lookup as dnsLookup } from "node:dns/promises";

type LookupAddress = { address: string; family: number };
type MediaLookup = (hostname: string) => Promise<LookupAddress[]>;

const TRUSTED_EXTRACT_MEDIA_HOST_SUFFIXES = [
  "douyinvod.com",
  "douyinpic.com",
  "douyin.com",
  "bytedance.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "muscdn.com",
  "ibytedtos.com",
  "byteimg.com",
  "bytednsdoc.com",
  "bdydns.com",
  "snssdk.com",
  "douyin.wtf",
  "ppt6.top",
] as const;

// Coze currently returns these ByteDance video CDN hosts. Keep the synthetic
// DNS exception exact: trusting the whole zjcdn.com suffix would let an
// arbitrary tenant hostname bypass the pinned-address policy on proxy clients.
const TRUSTED_EXTRACT_MEDIA_EXACT_HOSTNAMES = new Set([
  "v5-dy-ov-experiment.zjcdn.com",
  "v5-hl-zenl-ov.zjcdn.com",
]);

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

export function isTrustedExtractMediaHostname(value: string): boolean {
  const hostname = normalizedHostname(value);
  return TRUSTED_EXTRACT_MEDIA_EXACT_HOSTNAMES.has(hostname)
    || TRUSTED_EXTRACT_MEDIA_HOST_SUFFIXES.some(
    suffix => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
}

/**
 * Local proxy clients commonly expose public DNS names through RFC benchmark
 * addresses. Those addresses must stay blocked for arbitrary URLs. For an
 * exact, reviewed media hostname we can let the OS proxy own resolution while
 * safeFetch still enforces HTTPS, port, response size and manual redirects.
 */
export function isSyntheticProxyAddress(value: string): boolean {
  const address = value.trim().toLowerCase().split("%", 1)[0];
  const ipv4 = address.split(".").map(part => Number(part));
  if (
    ipv4.length === 4
    && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19);
  }
  return /^2001:0*2:/u.test(address);
}

async function systemLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function temporaryExtractMediaNetworkOptions(
  parsed: URL,
  lookup: MediaLookup = systemLookup,
): Promise<
  | { networkPolicy: "system-dns-pinned" }
  | { trustedHostnames: [string] }
> {
  const hostname = normalizedHostname(parsed.hostname);
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || !isTrustedExtractMediaHostname(hostname)
  ) {
    return { networkPolicy: "system-dns-pinned" };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return { networkPolicy: "system-dns-pinned" };
  }
  if (!addresses.length || !addresses.every(entry => isSyntheticProxyAddress(entry.address))) {
    return { networkPolicy: "system-dns-pinned" };
  }
  return { trustedHostnames: [hostname] };
}
