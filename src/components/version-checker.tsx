"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * 版本检测器：定时轮询 /api/version，发现部署更新后提示用户刷新
 *
 * 设计原则：
 * - 绝不自动刷新页面，只在右下角显示温和但醒目的提示
 * - 用户主动点击才刷新，不打断任何操作
 * - 开发环境(hash=dev)下跳过版本检测
 * - 基于 git hash 判断是否真正更新，避免时间戳变化误报
 * - 提示只出现一次，不重复弹窗
 * - 渐进式轮询：首次 30s 后检查，之后每 3 分钟检查一次
 * - 醒目的卡片式弹窗 + 脉冲动画 + 渐变强调
 */
export function VersionChecker() {
  const currentHash = useRef<string>("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [newVersion, setNewVersion] = useState<string>("");
  const checked = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  useEffect(() => {
    // 首次加载记录当前版本
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        currentHash.current = data.hash || "";
        // 开发环境(hash=dev)不检测版本变化
        if (data.hash === "dev") return;
        checked.current = true;
      })
      .catch(() => {});

    const checkForUpdate = async () => {
      if (!checked.current) return;

      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        const data = await res.json();

        // 开发环境跳过
        if (data.hash === "dev") return;

        const newHash = data.hash || "";

        // git hash 变化才是真正的代码更新
        if (newHash && newHash !== currentHash.current && newHash !== "dev") {
          currentHash.current = newHash;
          setNewVersion(data.version || newHash);
          setUpdateAvailable(true);
          setDismissed(false);
        }
      } catch {
        // 网络错误静默忽略
      }
    };

    // 渐进式轮询策略：
    // - 首次检查延迟 30s（给页面加载缓冲）
    // - 之后每 3 分钟检查一次（比 5 分钟更及时，又不至于太频繁）
    const initialTimer = setTimeout(() => {
      checkForUpdate();
      const interval = setInterval(checkForUpdate, 3 * 60 * 1000);
      timersRef.current.push(interval as unknown as ReturnType<typeof setTimeout>);
    }, 30 * 1000);

    timersRef.current.push(initialTimer);

    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current = [];
    };
  }, []);

  if (!updateAvailable || dismissed) return null;

  return (
    <div
      className="fixed bottom-5 right-5 z-[9999] animate-in slide-in-from-bottom-6 fade-in duration-500"
    >
      {/* 脉冲背景光晕 */}
      <div className="absolute -inset-2 rounded-2xl bg-indigo-500/10 animate-pulse" />

      <div
        className="relative flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl border backdrop-blur-sm"
        style={{
          background: "color-mix(in srgb, var(--card) 95%, transparent)",
          borderColor: "color-mix(in srgb, var(--primary) 40%, transparent)",
        }}
      >
        {/* 图标 */}
        <div
          className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </div>

        {/* 文本区域 */}
        <div className="flex flex-col gap-0.5">
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            发现新版本
          </span>
          {newVersion && (
            <span
              className="text-[11px] font-mono tracking-wide"
              style={{ color: "var(--muted-foreground)" }}
            >
              {newVersion}
            </span>
          )}
        </div>

        {/* 刷新按钮 */}
        <button
          onClick={handleReload}
          className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all duration-200 hover:scale-105 active:scale-95 shadow-md hover:shadow-lg"
          style={{
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          }}
        >
          立即刷新
        </button>

        {/* 关闭按钮 */}
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110"
          style={{
            color: "var(--muted-foreground)",
            background: "color-mix(in srgb, var(--muted-foreground) 10%, transparent)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--foreground)";
            e.currentTarget.style.background = "color-mix(in srgb, var(--muted-foreground) 20%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--muted-foreground)";
            e.currentTarget.style.background = "color-mix(in srgb, var(--muted-foreground) 10%, transparent)";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
