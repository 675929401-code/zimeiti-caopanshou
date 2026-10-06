"use client";

import { useCallback, useEffect, useState } from "react";

export type ToolRuntimeQuote = {
  available: boolean;
  service: string;
  provider?: string;
  model?: string;
  processingMode?: "local_rules";
  unitPrice: number | null;
  currency: "CNY";
  unit: string;
};

export type ToolRuntimeCatalog = Partial<Record<"video" | "text" | "batch" | "search" | "formatter" | "segmenter", ToolRuntimeQuote>>;

export function useToolRuntimeCatalog(token: string) {
  const [items, setItems] = useState<ToolRuntimeCatalog>({});
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!token) { setItems({}); setLoading(false); setError("请先登录后读取运行配置"); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/tools/runtime-catalog", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.items) throw new Error(data.error || "工具运行配置暂时无法读取");
      setItems(data.items);
    } catch (failure) {
      setItems({});
      setError(failure instanceof Error ? failure.message : "工具运行配置暂时无法读取");
    } finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { items, loading, error, refresh };
}
