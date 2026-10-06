const PRIVATE_IPV4_PATTERNS = [
  /^0\./u,
  /^127\./u,
  /^10\./u,
  /^192\.168\./u,
  /^169\.254\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
];

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("::ffff:")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized)
  ) {
    return true;
  }

  // URL normalisation can retain an IPv4-mapped IPv6 literal.  Reject the
  // mapped form when its embedded IPv4 address is private/link-local too.
  const mappedIpv4 = normalized.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  return Boolean(mappedIpv4 && PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(mappedIpv4)));
}

export function isPublicVideoAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      hostname === "localhost"
      || hostname === "0.0.0.0"
      || hostname === "::1"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(hostname))
      || (hostname.includes(":") && isPrivateIpv6(hostname))
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function isPublicHttpsVideoAssetUrl(value: unknown): value is string {
  return isPublicVideoAssetUrl(value) && new URL(value).protocol === "https:";
}
