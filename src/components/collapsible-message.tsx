"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

/**
 * ScrollableTextFrame — AI 消息滚动框组件
 *
 * 职责：为长内容的 AI 消息提供一个随内容增高、但有限制的滚动框。
 * - 起始高度（最小高度）≈ 名片最窄边（~180px）
 * - 最大高度 ≈ iPhone MAX 一屏高度（~852px）
 * - 内容少时框随内容增高；内容超出最大高度时固定框高 + 右侧滚动条
 * - 流式期间不限制高度（让打字机效果自然增长）
 *
 * ━━━ 替代旧 CollapsibleMessage ━━━
 * - 无"展开全文"/"收起"按钮
 * - 无渐变遮罩
 * - 用滚动条替代折叠交互
 */

/** 最小高度（px）：名片最窄边参考 */
const MIN_HEIGHT = 180;
/** 最大高度（px）：iPhone MAX 一屏高度参考 */
const MAX_HEIGHT = 852;

interface ScrollableTextFrameProps {
  /** 消息内容 */
  children: React.ReactNode;
  /** 是否正在流式输出 — 流式期间不限制高度 */
  isStreaming: boolean;
  /** 是否为用户消息 — 用户消息不套框 */
  isUser: boolean;
  /** 额外 className */
  className?: string;
}

export function ScrollableTextFrame({
  children,
  isStreaming,
  isUser,
  className,
}: ScrollableTextFrameProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // 测量内容高度，决定是否需要应用 min-height
  const measureAndApply = useCallback(() => {
    if (!contentRef.current) return;
    const height = contentRef.current.scrollHeight;
    // 如果内容高度 < MIN_HEIGHT，设置 min-height 让框保持名片最小尺寸
    // 如果内容高度 >= MIN_HEIGHT，让内容自然撑开（CSS auto）
    if (height < MIN_HEIGHT) {
      contentRef.current.style.minHeight = `${MIN_HEIGHT}px`;
    } else {
      contentRef.current.style.minHeight = '';
    }
  }, []);

  // 流式结束后测量
  useEffect(() => {
    if (isStreaming) return;
    // 延迟测量（等 DOM 渲染完成）
    const timer = setTimeout(measureAndApply, 150);
    return () => clearTimeout(timer);
  }, [isStreaming, measureAndApply]);

  // ─── 用户消息：不套框 ───
  if (isUser) {
    return <div className={className}>{children}</div>;
  }

  // ─── 流式期间：不限制高度，让内容自然增长 ───
  if (isStreaming) {
    return (
      <div
        ref={contentRef}
        className={cn("scrollable-text-frame", "scrollable-text-frame--streaming", className)}
      >
        {children}
      </div>
    );
  }

  // ─── 流式结束：应用滚动框约束 ───
  return (
    <div
      ref={contentRef}
      className={cn("scrollable-text-frame", className)}
    >
      {children}
    </div>
  );
}

// 向后兼容：保留 CollapsibleMessage 导出名为 ScrollableTextFrame 的别名
export { ScrollableTextFrame as CollapsibleMessage };
