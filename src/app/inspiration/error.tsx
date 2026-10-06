"use client";

import { useEffect } from "react";
import { RouteErrorPanel } from "@/features/short-drama/route-state";

export default function InspirationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("inspiration route error", error);
  }, [error]);

  return (
    <RouteErrorPanel
      title="灵感广场暂时无法显示"
      message="本地示例配置加载失败。请重新加载，或返回影视工坊继续使用其他入口。"
      reset={reset}
    />
  );
}

