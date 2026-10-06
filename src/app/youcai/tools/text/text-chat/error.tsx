"use client";

import { YoucaiRouteError } from "@/app/youcai/error";

export default function AgentError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <YoucaiRouteError
      {...props}
      title="创作 Agent 暂时无法启动"
      message="Agent 页面模块加载失败，尚未发送对话或工具请求。请重试或返回创作中心。"
      backHref="/youcai/tools"
    />
  );
}
