"use client";

import { FileText, Scissors, Text, Video, Wrench } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { CSSProperties } from "react";

export const TOOLBOX_ITEMS = [
  { id: "segment", label: "智能分段", description: "按语义和口播节奏切分", href: "/tools?tab=segment", Icon: Scissors, color: "#22c55e" },
  { id: "text", label: "文案提取", description: "提取字幕和口播文案", href: "/tools?tab=text", Icon: FileText, color: "#f59e0b" },
  { id: "video", label: "视频提取", description: "解析现有视频链接并下载", href: "/tools?tab=video", Icon: Video, color: "#06b6d4" },
  { id: "format", label: "文字排版", description: "清理格式并整理段落", href: "/tools?tab=format", Icon: Text, color: "#8b5cf6" },
] as const;

const DEFAULT_TOOLBOX_TAB = "segment";
type ToolboxItemId = (typeof TOOLBOX_ITEMS)[number]["id"];

function preferredToolboxHref() {
  let preferredTab: ToolboxItemId = DEFAULT_TOOLBOX_TAB;
  try {
    const savedTab = localStorage.getItem("toolbox_active_tab");
    if (TOOLBOX_ITEMS.some((item) => item.id === savedTab)) preferredTab = savedTab as ToolboxItemId;
  } catch {}
  return `/tools?tab=${preferredTab}`;
}

type ToolboxMenuProps = {
  variant?: "sidebar" | "navigation";
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  onNavigate?: () => void;
  navigate?: (href: string) => void;
  pending?: boolean;
  activeOverride?: boolean;
};

export function ToolboxMenu({
  variant = "navigation",
  className = "",
  style,
  disabled,
  onNavigate,
  navigate,
  pending = false,
  activeOverride,
}: ToolboxMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sidebar = variant === "sidebar";
  const active = activeOverride ?? pathname === "/tools";

  const openToolbox = () => {
    const href = preferredToolboxHref();
    if (navigate) navigate(href);
    else router.push(href);
    onNavigate?.();
  };

  const prefetchToolbox = () => {
    router.prefetch(preferredToolboxHref());
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="打开效率工具"
      aria-current={active ? "page" : undefined}
      aria-busy={pending || undefined}
      data-nav-pending={pending ? "true" : undefined}
      data-nav-key={sidebar ? undefined : "toolbox"}
      onClick={openToolbox}
      onFocus={prefetchToolbox}
      onPointerEnter={prefetchToolbox}
      className={`${sidebar
        ? "sidebar-tool-card sidebar-shortcut-card toolbox-trigger-sidebar flex min-h-16 flex-col items-center justify-center gap-1 overflow-hidden rounded-[10px] border px-1 py-1 transition-all duration-200 hover:-translate-y-px hover:shadow-sm"
        : `nav-pill toolbox-trigger-navigation select-none flex items-center gap-2 whitespace-nowrap transition-colors duration-200 ${active ? "nav-pill-active" : "nav-pill-default"}`
      } ${className}`}
      style={{ ...style, "--nav-icon-color": "#75a9dc" } as CSSProperties}
      title="打开效率工具"
    >
      {sidebar ? (
        <span className="toolbox-trigger-icon sidebar-shortcut-icon flex h-[30px] w-[30px] items-center justify-center rounded-[9px]" aria-hidden="true">
          <Wrench className="h-[18px] w-[18px]" />
        </span>
      ) : <Wrench className="nav-pill-icon shrink-0" style={{ color: "var(--nav-icon-color)" }} aria-hidden="true" />}
      <span className={sidebar ? "max-w-full text-center text-[clamp(13px,calc(13px*var(--sidebar-scale,1)),15px)] font-semibold leading-tight" : undefined}>效率工具</span>
    </button>
  );
}
