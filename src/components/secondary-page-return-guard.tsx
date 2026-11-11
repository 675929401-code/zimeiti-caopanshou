"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { markSecondaryPageReturn } from "@/lib/marketplace-navigation";
import styles from "./workbench-action-theme.module.css";
import layout from "./creation-workbench-layout.module.css";
import surfaces from "./creation-workbench-surfaces.module.css";

const MAIN_WORKBENCH_PATHS = [
  "/tools",
  "/tools/utility",
  "/storyboard-workbench",
  "/storyboard-workbench/history",
  "/storyboard-workbench/visual-assets",
  "/video",
  "/tools/video/kling-video",
  "/voice-studio/workspace",
  "/voice-studio/imitate",
  "/voice-studio/voices",
  "/cover",
  "/publish-center",
];

export function SecondaryPageReturnGuard() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/") markSecondaryPageReturn();
  }, [pathname]);

  const isHelpPage = pathname === "/help" || pathname.startsWith("/help/");
  const isMainWorkbench = MAIN_WORKBENCH_PATHS.includes(pathname);
  return isMainWorkbench || isHelpPage
    ? <span hidden aria-hidden="true" data-workbench-actions-scope="main" className={`${styles.scopeMarker} ${layout.scope}${isMainWorkbench ? ` ${surfaces.surfaceScope}` : ""}`} />
    : null;
}
