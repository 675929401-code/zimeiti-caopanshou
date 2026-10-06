export const YOUCAI_BASE_PATH = "/youcai";

const SHARED_MAIN_SITE_PATHS = [
  "/login",
  "/register",
  "/forgot-password",
  "/payment",
  "/api",
  "/admin",
] as const;

const SHARED_AUTH_PATHS = ["/login", "/register", "/forgot-password"] as const;

const YOUCAI_FRONTEND_ALIASES = [
  { source: "/voice-platform", target: "/voice-studio" },
] as const;

function splitLocalHref(href: string): { pathname: string; suffix: string } {
  const match = /^([^?#]*)(.*)$/u.exec(href);
  return {
    pathname: match?.[1] || href,
    suffix: match?.[2] || "",
  };
}

function scopeSharedAuthRedirect(pathname: string, suffix: string): string {
  if (!suffix || !SHARED_AUTH_PATHS.includes(pathname as (typeof SHARED_AUTH_PATHS)[number])) {
    return `${pathname}${suffix}`;
  }

  const url = new URL(`${pathname}${suffix}`, "http://youcai.local");
  const redirect = url.searchParams.get("redirect");
  if (redirect?.startsWith("/") && !redirect.startsWith("//")) {
    url.searchParams.set("redirect", toYoucaiHref(redirect));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Keep the imported Youcai application inside its own same-domain route branch.
 * Authentication, billing and other explicitly shared main-site services remain
 * on their original routes so both applications use one account and service layer.
 */
export function toYoucaiHref(href: string): string {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(href)
  ) return href;

  const { pathname, suffix } = splitLocalHref(href);
  if (pathname === YOUCAI_BASE_PATH || pathname.startsWith(`${YOUCAI_BASE_PATH}/`)) return href;
  if (SHARED_MAIN_SITE_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return scopeSharedAuthRedirect(pathname, suffix);
  }
  if (pathname === "/") return `${YOUCAI_BASE_PATH}${suffix}`;
  if (!pathname.startsWith("/")) return href;
  const alias = YOUCAI_FRONTEND_ALIASES.find(({ source }) => (
    pathname === source || pathname.startsWith(`${source}/`)
  ));
  const scopedPathname = alias
    ? `${alias.target}${pathname.slice(alias.source.length)}`
    : pathname;
  return `${YOUCAI_BASE_PATH}${scopedPathname}${suffix}`;
}

export function isYoucaiPath(pathname: string): boolean {
  return pathname === YOUCAI_BASE_PATH || pathname.startsWith(`${YOUCAI_BASE_PATH}/`);
}

export function toAppScopedHref(currentPathname: string, href: string): string {
  return isYoucaiPath(currentPathname) ? toYoucaiHref(href) : href;
}
