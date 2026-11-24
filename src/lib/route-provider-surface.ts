export type RouteProviderSurface = "pending" | "main" | "commerce" | "publishing";

/** Match page paths only; never match similarly named APIs, admin pages or assets. */
export function resolveRouteProviderSurface(pathname: string | null | undefined): RouteProviderSurface {
  if (!pathname) return "pending";
  if (pathname === "/commerce" || pathname.startsWith("/commerce/")) return "commerce";
  if (pathname === "/publish-center" || pathname === "/publish-center/"
    || pathname === "/publish-center/native" || pathname.startsWith("/publish-center/native/")) return "publishing";
  return "main";
}

/** An already mounted main runtime owns ongoing streams and delayed persistence. */
export function retainMainProviderRuntime(previouslyMounted: boolean, surface: RouteProviderSurface): boolean {
  return previouslyMounted || surface === "main";
}
