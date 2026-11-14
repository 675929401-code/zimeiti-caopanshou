"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPublishingPlugin, PublishingPluginError } from "@/lib/publishing-plugin";

export type PublishingPluginState = "checking" | "present" | "missing" | "unauthorized";

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** One detection owner for the account page and the sidebar status. */
export function usePublishingPlugin() {
  const [state, setState] = useState<PublishingPluginState>("checking");
  const [lastIssue, setLastIssue] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const check = useCallback(async () => {
    const current = ++sequence.current;
    setState("checking");
    setLastIssue(null);
    // The extension injects Web API after document_idle; a single immediate
    // probe can miss a freshly authorized page. Retry briefly, then report a
    // stable result instead of silently flickering back to "未安装".
    let lastReason: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(250 * attempt);
      if (!mounted.current || sequence.current !== current) return;
      try {
        await detectPublishingPlugin();
        if (!mounted.current || sequence.current !== current) return;
        setState("present");
        setCheckedAt(Date.now());
        return;
      } catch (reason) {
        lastReason = reason;
        if (reason instanceof PublishingPluginError && !["not_installed", "invalid_plugin"].includes(reason.code)) break;
      }
    }
    if (!mounted.current || sequence.current !== current) return;
    const code = lastReason instanceof PublishingPluginError ? lastReason.code : "not_installed";
    setState(code === "not_authorized" ? "unauthorized" : "missing");
    setLastIssue(code === "not_authorized"
      ? "已检测到插件，但尚未授权当前网站。请在扩展「仅授权」中添加本站域名并确认授权，然后刷新页面。"
      : "未检测到已授权本站的发布插件。若扩展已安装，请在扩展「仅授权」的“允许注入的域名”中添加本站地址，保存并确认授权后刷新页面。");
    setCheckedAt(Date.now());
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
  return { state, check, lastIssue, checkedAt };
}
