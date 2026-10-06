export const ADMIN_LOGIN_PATH = "/admin/superzhujunguo";
export const LEGACY_ADMIN_LOGIN_PATH = "/admin/login";

export function isAdminLoginPath(pathname: string): boolean {
  return [ADMIN_LOGIN_PATH, LEGACY_ADMIN_LOGIN_PATH].some(
    (entryPath) => pathname === entryPath || pathname.startsWith(`${entryPath}/`),
  );
}

export function safeAdminRedirect(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/admin") || isAdminLoginPath(candidate)) return "/admin";
  return candidate;
}
