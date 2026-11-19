"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPublishingPlugin, PublishingPluginError } from "@/lib/publishing-plugin";

export type PublishingPluginState = "checking" | "present" | "missing" | "unauthorized" | "incompatible";

export const publishingPluginSetupHints = {
  checking: "正在检测当前浏览器是否已给本站授权。",
  missing: "请在当前 Chrome 或 Edge 中安装并启用插件。",
  unauthorized: "打开扩展，选择「仅授权」，添加当前工作台的网址。",
  incompatible: "插件没有正常响应。请更新或重新启用扩展。",
} satisfies Record<Exclude<PublishingPluginState, "present">, string>;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** One detection owner for the account page and the sidebar status. */
export function usePublishingPlugin() {
  const [state, setState] = useState<PublishingPluginState>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const check = useCallback(async () => {
    const current = ++sequence.current;
    setState("checking");
    setVersion(null);
    // The extension injects Web API after document_idle; a single immediate
    // probe can miss a freshly authorized page. Retry briefly, then report a
    // stable result instead of silently flickering back to "未安装".
    let lastReason: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(250 * attempt);
      if (!mounted.current || sequence.current !== current) return;
      try {
        const result = await detectPublishingPlugin();
        if (!mounted.current || sequence.current !== current) return;
        setVersion(result.version);
        setState("present");
        return;
      } catch (reason) {
        lastReason = reason;
        if (reason instanceof PublishingPluginError && reason.code !== "not_installed") break;
      }
    }
    if (!mounted.current || sequence.current !== current) return;
    const code = lastReason instanceof PublishingPluginError ? lastReason.code : "invalid_plugin";
    setState(code === "not_authorized" ? "unauthorized" : code === "not_installed" ? "missing" : "incompatible");
  }, []);
  useEffect(() => {
    mounted.current = true;
    void check();
    const recheck = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [check]);
  return { state, check, version };
}

export type PublishingPluginControl = ReturnType<typeof usePublishingPlugin>;
