"use client";

import { YoucaiRouteError } from "@/app/youcai/error";

export default function VideoError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <YoucaiRouteError
      {...props}
      title="视频创作工作台暂时无法打开"
      message="视频页面模块加载失败，系统不会因此发起模型调用或扣费。请重试或返回创作中心。"
      backHref="/youcai/tools"
    />
  );
}
