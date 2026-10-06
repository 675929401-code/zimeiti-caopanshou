"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppRouteShell } from "@/components/app-route-shell";

/** Keep the shared workspace frame mounted across navigation and Suspense boundaries. */
export function ManjuPersistentLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // These aliases already own their full-screen header and scroll container.
  const standalone = pathname === "/youcai/video" || pathname === "/youcai/voice-studio" || pathname.startsWith("/youcai/voice-studio/");
  return standalone ? <>{children}</> : <AppRouteShell>{children}</AppRouteShell>;
}
