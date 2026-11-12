"use client";

import { useCallback, useEffect, useState } from "react";
import { detectPublishingPlugin, PublishingPluginError } from "@/lib/publishing-plugin";

export type PublishingPluginState = "checking" | "present" | "missing" | "unauthorized";

/** One detection owner for the account page and the sidebar status. */
export function usePublishingPlugin() {
  const [state, setState] = useState<PublishingPluginState>("checking");
  const check = useCallback(async () => {
    setState("checking");
    try {
      await detectPublishingPlugin();
      setState("present");
    } catch (reason) {
      const code = reason instanceof PublishingPluginError ? reason.code : "not_installed";
      setState(code === "not_authorized" ? "unauthorized" : "missing");
    }
  }, []);
  useEffect(() => { void check(); }, [check]);
  return { state, check };
}
