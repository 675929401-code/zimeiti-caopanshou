"use client";

import { YoucaiRouteError } from "@/app/youcai/error";

export default function CanvasError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <YoucaiRouteError
      {...props}
      title="漫剧画布暂时无法打开"
      message="画布模块加载失败，当前页面没有提交任何生成任务。请重试或返回创作中心。"
      backHref="/youcai/tools"
    />
  );
}
