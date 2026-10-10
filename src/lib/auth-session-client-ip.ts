import { getClientIP } from "@/lib/security";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Session/IP exclusivity must never hash a shared "unknown" sentinel: doing so
 * would make unrelated users evict each other when a proxy header is missing.
 * Direct local preview is the only safe fallback because every request belongs
 * to the same local machine by definition.
 */
export function getAuthSessionClientIP(request: Request): string | null {
  const trusted = getClientIP(request).trim().toLowerCase();
  if (trusted && trusted !== "unknown") return trusted;

  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(hostname)) return "127.0.0.1";
  } catch {
    // An invalid URL cannot safely participate in an IP-scoped session policy.
  }

  return null;
}
