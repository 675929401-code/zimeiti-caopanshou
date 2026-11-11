"use client";

import { Component, type ReactNode } from "react";
import { reportClientRenderError } from "@/lib/client-error-telemetry";
import { isChunkLoadError } from "@/lib/chunk-load-error";

interface FallbackProps {
  error: Error;
  moduleName: string;
  onRetry: () => void;
}

function DefaultFallback({ error, moduleName, onRetry }: FallbackProps) {
  const chunkLoadFailed = isChunkLoadError(error);

  return (
    <div className="flex flex-col items-center justify-center p-6 m-2 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20">
      <div className="w-10 h-10 mb-2 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
        <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-red-700 dark:text-red-400 mb-1">
        {chunkLoadFailed ? `「${moduleName}」页面资源加载失败` : `「${moduleName}」模块出现异常`}
      </h3>
      <p className={`text-xs text-red-500/70 mb-3 max-w-xs text-center${chunkLoadFailed ? "" : " truncate"}`}>
        {chunkLoadFailed
          ? "刷新会重新加载页面。请先保存其他未提交内容，再刷新页面恢复。"
          : error.message}
      </p>
      <button
        onClick={onRetry}
        className="px-3 py-1.5 text-xs font-medium text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors"
      >
        {chunkLoadFailed ? "刷新页面恢复" : "重试模块"}
      </button>
    </div>
  );
}

interface Props {
  children: ReactNode;
  moduleName: string;
  fallback?: (props: FallbackProps) => ReactNode;
  /**
   * fill（默认）：渲染 h-full 包裹层，供需要撑满父容器高度的功能视图使用。
   * inline：不渲染包裹层，直接输出 children —— 用于弹窗/浮层类内容，
   * 否则内容为 null 时会留下一个占满一屏的空 div，把页面撑出额外的可滚动高度。
   */
  variant?: "fill" | "inline";
}

interface State {
  error: Error | null;
  key: number;
}

/**
 * 功能级错误隔离组件
 *
 * 包裹在任何功能模块外部，确保该模块崩溃时：
 * 1. 不会影响页面上其他模块的正常运行
 * 2. 普通错误可局部重试；资源加载失败由用户明确点击刷新页面恢复
 * 3. 错误被限制在模块内部
 *
 * 使用示例：
 * ```tsx
 * <FeatureErrorBoundary moduleName="智能体市场">
 *   <AgentMarketplace />
 * </FeatureErrorBoundary>
 * ```
 */
export class FeatureErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, key: 0 };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, key: 0 };
  }

  componentDidCatch() {
    console.error("[FeatureErrorBoundary] 模块渲染异常");
    reportClientRenderError();
  }

  handleRetry = () => {
    if (isChunkLoadError(this.state.error)) {
      // React.lazy/dynamic imports can cache a rejected Promise until a new document loads.
      window.location.reload();
      return;
    }
    this.setState({ error: null, key: this.state.key + 1 });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback({
          error: this.state.error,
          moduleName: this.props.moduleName,
          onRetry: this.handleRetry,
        });
      }
      return (
        <DefaultFallback
          error={this.state.error}
          moduleName={this.props.moduleName}
          onRetry={this.handleRetry}
        />
      );
    }

    if (this.props.variant === "inline") {
      return this.props.children;
    }
    return <div key={this.state.key} className="h-full overflow-hidden">{this.props.children}</div>;
  }
}
