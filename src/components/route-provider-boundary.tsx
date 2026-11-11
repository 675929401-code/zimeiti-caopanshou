"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppProvider } from "@/contexts/app-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { MemberFeatureBoundary, MemberPermissionProvider } from "@/components/member-permission-boundary";
import { SecondaryPageReturnGuard } from "@/components/secondary-page-return-guard";
import { SecurityInterruptionDialog } from "@/components/security-interruption-dialog";
import { AnnouncementPopup } from "@/components/announcement-popup";
import { AccountNotificationCenter } from "@/components/account-notification-center";
import { DiagnosticSentry } from "@/components/diagnostic-sentry";
import { VersionChecker } from "@/components/version-checker";
import { Toaster } from "@/components/ui/sonner";
import { resolveRouteProviderSurface, retainMainProviderRuntime } from "@/lib/route-provider-surface";

/**
 * A cold publishing page uses its own authenticated host-session projection.
 * Once this document has mounted the main runtime, retain that exact provider:
 * SPA navigation must not tear down a running chat stream or its pending save.
 */
export function RouteProviderBoundary({ children }: { children: ReactNode }) {
  const surface = resolveRouteProviderSurface(usePathname());
  const [mainRuntimeMounted, setMainRuntimeMounted] = useState(surface === "main");
  const keepMainRuntime = retainMainProviderRuntime(mainRuntimeMounted, surface);
  // This one-way update happens before children commit; an unresolved pathname
  // never mounts the main runtime, even briefly during the first client render.
  if (keepMainRuntime && !mainRuntimeMounted) setMainRuntimeMounted(true);

  const page = surface === "pending" ? null : <ErrorBoundary>
    {surface === "main" ? <MemberFeatureBoundary>{children}</MemberFeatureBoundary> : children}
  </ErrorBoundary>;

  return <>
    {keepMainRuntime ? <AppProvider>
      <MemberPermissionProvider>
        {surface !== "pending" && <SecondaryPageReturnGuard />}
        {page}
        {surface === "main" && <>
          <ErrorBoundary><SecurityInterruptionDialog /></ErrorBoundary>
          <ErrorBoundary><AnnouncementPopup /></ErrorBoundary>
          <ErrorBoundary><AccountNotificationCenter /></ErrorBoundary>
        </>}
        <Toaster position="top-center" richColors />
      </MemberPermissionProvider>
    </AppProvider> : surface === "publishing" ? <>
      <SecondaryPageReturnGuard />
      {page}
      <Toaster position="top-center" richColors />
    </> : null}
    {surface !== "pending" && <>
      <DiagnosticSentry />
      <VersionChecker />
    </>}
  </>;
}
