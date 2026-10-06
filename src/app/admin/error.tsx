"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * 管理后台错误边界
 * 管理后台崩溃时显示，不影响学员端页面
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[AdminError] 管理后台异常:", error.message);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center bg-background">
      <div className="w-16 h-16 mb-4 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center">
        <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-foreground mb-2">管理后台加载异常</h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-md">
        管理后台遇到了问题，学员端不受影响。请刷新重试。
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors"
        >
          重试
        </button>
        <Link
          href="/"
          className="px-4 py-2 text-sm font-medium text-primary border border-primary rounded-lg hover:bg-primary/5 transition-colors"
        >
          返回首页
        </Link>
      </div>
    </div>
  );
}
