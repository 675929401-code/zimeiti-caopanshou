"use client";

import { YoucaiRouteError } from "@/app/youcai/error";

export default function ImageError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <YoucaiRouteError
      {...props}
      title="图片创作工具暂时无法打开"
      message="图片页面模块加载失败，系统不会把错误当作生成成功。请重试或返回创作中心。"
      backHref="/youcai/tools"
    />
  );
}
