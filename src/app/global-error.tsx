"use client";

import { useEffect } from "react";
import { reportClientRenderError } from "@/lib/client-error-telemetry";

/**
 * 全局错误边界 — 捕获根布局中的客户端异常
 * 当 error.tsx 无法处理（如根 layout 崩溃）时，此文件生效
 * 必须定义自己的 <html> 和 <body> 标签，因为它替代根 layout
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const digest = error.digest;
  const message = error.message;

  useEffect(() => {
    console.error("[GlobalError] 根布局渲染异常");
    reportClientRenderError(digest);

    // Chunk加载失败 → 自动强制刷新（部署新版本后浏览器缓存旧runtime导致）
    const isChunkError = /Loading chunk|ChunkLoadError|loading CSS chunk/i.test(message);
    if (isChunkError) {
      try {
        // 标记已刷新，避免死循环；受限存储环境失败时保留错误页。
        if (!sessionStorage.getItem("__chunk_reloaded")) {
          sessionStorage.setItem("__chunk_reloaded", "1");
          window.location.reload();
          return;
        }
      } catch {}
    }

  }, [digest, message]);

  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "2rem",
          textAlign: "center",
          backgroundColor: "#f9fafb",
        }}>
          <div style={{
            width: "64px",
            height: "64px",
            marginBottom: "1.5rem",
            borderRadius: "50%",
            backgroundColor: "#fef2f2",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="#ef4444">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem", color: "#111827" }}>
            页面遇到了问题
          </h2>
          <p style={{ color: "#6b7280", marginBottom: "1.5rem", maxWidth: "28rem" }}>
            页面发生了意外错误，请尝试刷新。如果问题持续，请联系管理员。
          </p>
          <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "1rem", maxWidth: "28rem", wordBreak: "break-all" }}>
            错误信息: {error.message || "未知错误"}
          </div>
          <button
            onClick={reset}
            style={{
              padding: "0.5rem 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: "#fff",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
