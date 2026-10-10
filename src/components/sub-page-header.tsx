"use client";

import { ExternalLink, Home, type LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";

/**
 * 统一快捷导航按钮 — 等高等宽，位置一致
 * - primary: 主题色淡底 + 主题色文字（用于"下一步"跳转）
 * - ghost:   muted底 + muted文字（用于辅助功能如"历史""规则"）
 */
export function NavButton({
  icon: Icon,
  label,
  onClick,
  href,
  variant = "primary",
  active,
  title,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "ghost";
  active?: boolean;
  title?: string;
}) {
  const router = useAppScopedRouter();

  const handleClick = () => {
    if (href) {
      router.push(href);
    } else {
      onClick?.();
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="sub-page-nav-button flex items-center justify-center gap-1.5 shrink-0 transition-all active:scale-95 whitespace-nowrap"
      data-variant={variant}
      data-active={active ? "true" : undefined}
      title={title || label}
    >
      <Icon className="sub-page-nav-icon shrink-0" />
      <span>{label}</span>
    </button>
  );
}

interface SubPageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  backHref?: string; // 自定义返回路径，默认 "/"
  onBack?: () => void; // 自定义返回回调，优先于 backHref
  /** @deprecated 主题入口统一保留在左下侧栏；兼容旧调用，不再在页头渲染。 */
  showThemeSwitcher?: boolean;
}

/**
 * 二级页面统一顶部导航栏
 * - 左侧：大图标返回按钮 + 新窗口打开按钮
 * - 中间：页面标题 + 副标题
 * - 右侧：自定义内容（可选）
 */
export function SubPageHeader({ title, subtitle, icon, rightSlot, backHref = "/", onBack }: SubPageHeaderProps) {
  const router = useAppScopedRouter();

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      router.push(backHref);
    }
  }, [router, backHref, onBack]);

  const handleNewWindow = useCallback(() => {
    // Preserve handoff/review query parameters. Dropping them opens a visually
    // similar page with a different workflow identity in the new window.
    window.open(`${window.location.pathname}${window.location.search}${window.location.hash}`, "_blank");
  }, []);

  return (
    <header
      className="sub-page-header shrink-0 z-30 border-b"
    >
      <div className="sub-page-header-inner max-w-7xl mx-auto flex items-center justify-between">
        {/* 左侧：返回 + 新窗口 */}
        <div className="sub-page-left flex items-center shrink-0">
          {/* 返回按钮 - 大图标醒目 */}
          <button
            type="button"
            onClick={handleBack}
            className="sub-page-back flex items-center justify-center transition-all active:scale-95"
            title="返回主页"
          >
            <Home className="sub-page-back-icon" />
            <span className="hidden sm:inline">返回主页</span>
          </button>

          {/* 新窗口打开按钮 */}
          <button
            type="button"
            onClick={handleNewWindow}
            className="sub-page-open flex items-center justify-center transition-all active:scale-95"
            title="在新窗口中打开此页面"
          >
            <ExternalLink className="sub-page-open-icon" />
            <span className="hidden sm:inline">新窗口</span>
          </button>
        </div>

        {/* 中间：标题 + 副标题 */}
        <div className="sub-page-heading flex items-center flex-1 justify-center min-w-0">
          {icon && <span className="shrink-0">{icon}</span>}
          <div className="flex flex-col items-center">
            <h1
            className="sub-page-title font-bold truncate"
            >
              {title}
            </h1>
            {subtitle && (
              <p
                className="sub-page-subtitle truncate"
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* 右侧：自定义内容 */}
        <div className="sub-page-actions flex items-center shrink-0 overflow-x-auto">
          {rightSlot}
        </div>
      </div>
    </header>
  );
}
