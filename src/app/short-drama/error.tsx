"use client";

import { useEffect } from "react";
import { RouteErrorPanel } from "@/features/short-drama/route-state";

export default function ShortDramaError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("short-drama route error", error);
  }, [error]);

  return (
    <RouteErrorPanel
      title="影视工坊暂时无法显示"
      message="页面结构加载失败。你可以重新加载，或先返回主站使用现有工作台。"
      reset={reset}
    />
  );
}

