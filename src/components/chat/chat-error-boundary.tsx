"use client";

import React from "react";
import { reportClientRenderError } from "@/lib/client-error-telemetry";

/**
 * ChatErrorBoundary — 聊天区域错误边界
 * 捕获 MessageBubble/MessageContent 渲染异常，防止单条消息崩溃导致整个页面白屏
 * 错误仅上报到最小匿名诊断入口，不携带消息、堆栈或内部凭据
 */
interface ChatErrorBoundaryProps {
  children: React.ReactNode;
  /** 保留调用方上下文标签兼容性；该值不进入匿名遥测 */
  context?: string;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ChatErrorBoundary extends React.Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  constructor(props: ChatErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, errorMessage: error.message || "未知错误" };
  }

  componentDidCatch() {
    console.error("[ChatErrorBoundary] 消息渲染异常");
    reportClientRenderError();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-6 text-center gap-3">
          <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">消息渲染出错</p>
            <p className="text-xs text-[var(--muted-foreground)] mt-1 max-w-xs break-all">{this.state.errorMessage}</p>
          </div>
          <button
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--primary)] text-white hover:opacity-90 transition-opacity"
            onClick={() => this.setState({ hasError: false, errorMessage: "" })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
