"use client";

import { useEffect } from "react";

/** Prevent silent loss of an editable workbench draft on reload/close. */
export function useUnsavedWorkWarning(enabled: boolean, message = "当前工作台还有未保存内容，确定离开吗？") {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
      return message;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [enabled, message]);
}
