"use client";

import { useEffect } from "react";
import { reportClientRenderError } from "@/lib/client-error-telemetry";

/**
 * 全局错误边界页面
 * 当整个应用抛出未捕获异常时显示，不白屏
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = error.digest;

  useEffect(() => {
    // 浏览器端只记录无敏感内容的错误标识；消息、堆栈、URL 和凭据均不上报。
    console.error("[AppErrorBoundary] 未捕获渲染异常");
    reportClientRenderError(digest);
  }, [digest]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center bg-background">
      <div className="w-20 h-20 mb-6 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
        <svg className="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">应用遇到了问题</h2>
      <p className="text-muted-foreground mb-6 max-w-md">
        页面发生了意外错误，请尝试刷新。如果问题持续，请联系管理员。
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-5 py-2.5 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          重新加载
        </button>
        <a
          href="/"
          className="px-5 py-2.5 text-sm font-medium text-primary border border-primary rounded-lg hover:bg-primary/5 transition-colors"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}
