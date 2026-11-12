const PUBLIC_UNAUTHENTICATED_PATHS = new Set([
  "/",
  "/about",
  "/admin/login",
  "/admin/superzhujunguo",
  "/announcements",
  "/articles",
  "/demo/experience",
  "/demo/popup-styles",
  "/forgot-password",
  "/help",
  "/login",
  "/payment/result",
  "/plugin-guide",
  "/register",
]);

const PUBLIC_UNAUTHENTICATED_PREFIXES = [
  "/articles/",
  "/commerce/canvas-share/",
  "/help/",
  "/share/canvas/",
];

function normalizePathname(pathname: string): string {
  const clean = pathname.trim().split(/[?#]/u, 1)[0] || "/";
  if (clean === "/") return clean;
  return clean.replace(/\/+$/u, "") || "/";
}

/**
 * Product workbenches are account-owned. A browser without a session returns
 * to the public home instead of exposing a half-mounted secondary shell.
 * Explicit public/auth/share routes remain reachable without a session.
 */
export function shouldReturnUnauthenticatedVisitorHome(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (PUBLIC_UNAUTHENTICATED_PATHS.has(normalized)) return false;
  return !PUBLIC_UNAUTHENTICATED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
