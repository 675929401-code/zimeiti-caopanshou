const AUTH_ROUTE_PATHS = new Set(["/login", "/register", "/forgot-password"]);

function decodePathnameForValidation(pathname: string): string | null {
  let decoded = pathname;

  for (let depth = 0; depth < 5; depth += 1) {
    if (!decoded.includes("%")) return decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }

  return decoded.includes("%") ? null : decoded;
}

export function normalizeAuthRedirect(
  value: string | string[] | undefined,
  fallback = "/",
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  if (candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return fallback;

  const rawPathname = candidate.split(/[?#]/, 1)[0];
  const pathname = decodePathnameForValidation(rawPathname);
  if (
    !pathname ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    return fallback;
  }
  if (AUTH_ROUTE_PATHS.has(pathname)) return fallback;
  return candidate;
}
