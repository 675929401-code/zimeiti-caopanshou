"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toAppScopedHref } from "@/lib/youcai-routes";

export function useAppScopedRouter() {
  const pathname = usePathname();
  const router = useRouter();
  const scopeHref = useCallback(
    (href: string) => toAppScopedHref(pathname, href),
    [pathname],
  );

  return useMemo(() => ({
    back: () => router.back(),
    forward: () => router.forward(),
    refresh: () => router.refresh(),
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(scopeHref(href), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(scopeHref(href), options),
    prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(scopeHref(href), options),
    scopeHref,
  }), [router, scopeHref]);
}
