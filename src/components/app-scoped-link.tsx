"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";
import { toAppScopedHref } from "@/lib/youcai-routes";

type NextLinkProps = ComponentProps<typeof Link>;

function scopeLinkHref(pathname: string, href: NextLinkProps["href"]): NextLinkProps["href"] {
  if (typeof href === "string") return toAppScopedHref(pathname, href);
  if (href.protocol || href.host || href.hostname) return href;
  if (typeof href.pathname !== "string") return href;
  const query = href.query && typeof href.query === "object" ? href.query : undefined;
  const redirect = query?.redirect;
  return {
    ...href,
    pathname: toAppScopedHref(pathname, href.pathname),
    query: typeof redirect === "string"
      ? { ...query, redirect: toAppScopedHref(pathname, redirect) }
      : href.query,
  };
}

/**
 * A path-aware Next Link. It behaves exactly like a normal Link on the main
 * site, while local frontend routes stay under /youcai when rendered inside
 * the isolated Youcai application. Shared authentication and billing routes
 * are handled by the central route policy.
 */
export function AppScopedLink({ href, ...props }: NextLinkProps) {
  const pathname = usePathname();
  return <Link href={scopeLinkHref(pathname, href)} {...props} />;
}
