"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { startDiagnosticMonitoring } from "@/lib/diagnostic-sentry";
import {
  recordProductUsageEvent,
  recordProductUsageEvents,
  type ProductUsageClientEvent,
} from "@/lib/product-usage-client";

const PRODUCT_USAGE_HEARTBEAT_MS = 5 * 60 * 1_000;

function usageContext(pathname: string): Pick<ProductUsageClientEvent, "featureKey" | "pageKey"> | null {
  if (pathname === "/") return { featureKey: "app_market", pageKey: "home" };
  if (pathname === "/tools") return { featureKey: "app_market", pageKey: "tools" };
  if (pathname.startsWith("/cover")) return { featureKey: "cover_studio", pageKey: "cover" };
  if (pathname.startsWith("/storyboard")) return { featureKey: "storyboard", pageKey: "storyboard" };
  if (pathname.startsWith("/video")) return { featureKey: "video_generation", pageKey: "video" };
  if (pathname.startsWith("/voice")) return { featureKey: "voice_generation", pageKey: "voice" };
  if (pathname.startsWith("/media-history")) return { featureKey: "media_history", pageKey: "media_history" };
  if (pathname.startsWith("/commerce")) return { featureKey: "commerce", pageKey: "commerce" };
  if (pathname.startsWith("/profile")) return { featureKey: "member_center", pageKey: "member" };
  if (pathname.startsWith("/help")) return { featureKey: "help_center", pageKey: "help" };
  return null;
}

/**
 * 诊断哨兵初始化组件
 * 放在 AppProvider 内部，客户端挂载后启动健康监测
 */
export function DiagnosticSentry() {
  const pathname = usePathname();
  const lastPageViewRef = useRef<string | null>(null);

  useEffect(() => {
    startDiagnosticMonitoring();
  }, []);

  useEffect(() => {
    const context = usageContext(pathname);
    if (!context || lastPageViewRef.current === pathname) return;
    lastPageViewRef.current = pathname;
    void recordProductUsageEvents([
      {
        eventType: "page_view",
        featureKey: context.featureKey,
        pageKey: context.pageKey,
        entryPoint: "navigation",
      },
      {
        eventType: "feature_open",
        featureKey: context.featureKey,
        pageKey: context.pageKey,
        entryPoint: "navigation",
      },
    ]);
  }, [pathname]);

  useEffect(() => {
    const context = usageContext(pathname);
    if (!context) return;
    let timer: number | null = null;
    let stopped = false;

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (stopped || document.visibilityState === "hidden" || navigator.onLine === false) return;
      timer = window.setTimeout(async () => {
        timer = null;
        if (stopped || document.visibilityState === "hidden" || navigator.onLine === false) return;
        await recordProductUsageEvent({
          eventType: "session_heartbeat",
          featureKey: context.featureKey,
          pageKey: context.pageKey,
        });
        schedule();
      }, PRODUCT_USAGE_HEARTBEAT_MS);
    };
    const resume = () => schedule();
    schedule();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [pathname]);

  return null;
}
