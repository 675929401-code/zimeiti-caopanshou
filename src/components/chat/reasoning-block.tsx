"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Brain, ChevronDown, ChevronRight } from "lucide-react";

/**
 * ReasoningBlock — 深度思考折叠组件
 * 从 chat-view.tsx 提取，负责展示 LLM 推理过程
 */

export function ReasoningBlock({ content, isThinking, defaultCollapsed }: { content: string; isThinking: boolean; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed !== false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!userToggledRef.current) {
      setCollapsed(defaultCollapsed !== false);
    }
  }, [defaultCollapsed]);

  // 自动滚动到底部
  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, collapsed]);

  return (
    <div className="mb-2">
      {/* 标题栏 - 浅灰背景圆角条 */}
      <div
        className="flex items-center gap-2 px-3 py-[6px] rounded-lg cursor-pointer select-none transition-colors"
        style={{ background: 'var(--msg-think-header-bg, #f1f3f4)' }}
        onClick={() => {
          userToggledRef.current = true;
          setCollapsed((current) => !current);
        }}
      >
        {/* 思考图标 */}
        {isThinking ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--foreground)', opacity: 0.5 }} />
        ) : (
          <Brain className="w-3.5 h-3.5" style={{ color: 'var(--foreground)', opacity: 0.4 }} />
        )}
        {/* 标题文字 */}
        <span className="text-[13px] font-medium" style={{ color: 'var(--foreground)', opacity: 0.55 }}>
          {isThinking ? '深度思考中' : '已深度思考'}
        </span>
        <div className="flex-1" />
        {/* 思考中跳动点 */}
        {isThinking && (
          <span className="flex gap-[3px] items-center mr-1">
            <span className="w-[3px] h-[3px] rounded-full bg-[var(--muted-foreground)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-[3px] h-[3px] rounded-full bg-[var(--muted-foreground)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-[3px] h-[3px] rounded-full bg-[var(--muted-foreground)] animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        )}
        {/* 展开/折叠箭头 */}
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--foreground)', opacity: 0.35 }} />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--foreground)', opacity: 0.35 }} />
        )}
      </div>

      {/* 思考内容 - 左侧竖线引用样式，白色背景 */}
      {!collapsed && (
        <div className="flex mt-1">
          {/* 左侧竖线 */}
          <div className="w-[2px] rounded-full ml-3 mr-3 flex-shrink-0" style={{ background: 'var(--msg-think-line, #e0e0e0)' }} />
          {/* 内容区 */}
          <div
            ref={scrollRef}
            className="flex-1 py-2 pr-3 text-[13px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words"
            style={{ color: 'var(--foreground)', opacity: 0.6 }}
          >
            {content}
            {/* 思考中光标 */}
            {isThinking && (
              <span className="inline-block w-[2px] h-[14px] bg-[var(--muted-foreground)]/50 animate-pulse ml-0.5 align-middle rounded-sm" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
