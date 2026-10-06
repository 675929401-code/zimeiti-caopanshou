"use client";

import { YoucaiRouteError } from "@/app/youcai/error";

export default function FilmStudioError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <YoucaiRouteError
      {...props}
      title="影视创作工坊暂时无法打开"
      message="工坊页面模块加载失败，尚未创建项目或发起生成。请重试或返回创作中心。"
      backHref="/youcai/tools"
    />
  );
}
