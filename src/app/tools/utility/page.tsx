"use client";

import { Suspense, useEffect } from "react";
import { FileText, Home, Scissors, Text, Video, Wrench } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import ExtractPage from "@/app/extract/page";
import FormatterPage from "@/app/formatter/page";
import SegmenterPage from "@/app/segmenter/page";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { ToolboxProvider, type ToolboxTabId } from "@/components/toolbox-context";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import styles from "../tools.module.css";

const TOOL_TABS = [
  { id: "text", label: "文案提取", description: "提取字幕与口播文案", Icon: FileText },
  { id: "video", label: "视频提取", description: "解析视频链接并下载", Icon: Video },
  { id: "format", label: "文字排版", description: "清理格式与段落", Icon: Text },
  { id: "segment", label: "智能分段", description: "按口播节奏切分文案", Icon: Scissors },
] as const;

type ToolTab = ToolboxTabId;

function normalizeTab(value: string | null): ToolTab {
  return TOOL_TABS.some((tab) => tab.id === value) ? value as ToolTab : "text";
}

function ToolboxWorkspace() {
  const router = useAppScopedRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = normalizeTab(searchParams.get("tab"));

  useEffect(() => {
    const requested = searchParams.get("tab");
    if (requested === activeTab || window.location.pathname !== pathname
      || new URLSearchParams(window.location.search).get("tab") !== requested) return;
    // This only normalizes the current URL; avoid a second RSC navigation.
    window.history.replaceState(null, "", `${pathname}?tab=${activeTab}`);
  }, [activeTab, pathname, searchParams]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      router.push("/tools");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  const selectTab = (tab: ToolTab) => {
    router.push(`/tools/utility?tab=${tab}`, { scroll: false });
  };

  const moveTabFocus = (current: ToolTab, direction: -1 | 1) => {
    const currentIndex = TOOL_TABS.findIndex((tab) => tab.id === current);
    const nextIndex = (currentIndex + direction + TOOL_TABS.length) % TOOL_TABS.length;
    const nextTab = TOOL_TABS[nextIndex].id;
    selectTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tool-tab-${nextTab}`)?.focus());
  };

  return (
    <div className={styles.page} data-page="tools-utility">
      <SubPageHeader
        title="实用工具箱"
        subtitle="分段、提取与排版集中处理"
        icon={<Wrench className="h-5 w-5 text-[var(--primary)]" />}
        rightSlot={<NavButton icon={Home} label="创作中心" href="/tools" title="返回创作中心" />}
      />

      <main className={`${styles.main} workspace-depth-frame`}>
        <header className={styles.intro}>
          <div>
            <h1>短视频内容工具</h1>
            <p>原工具箱功能完整保留在独立入口，切换不会改动原任务和历史。</p>
          </div>
          <span>内容处理工具</span>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="工具箱功能">
          {TOOL_TABS.map(({ id, label, description, Icon }) => (
            <button
              key={id}
              id={`tool-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls="toolbox-active-panel"
              tabIndex={activeTab === id ? 0 : -1}
              className={activeTab === id ? styles.activeTab : undefined}
              onClick={() => selectTab(id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveTabFocus(id, 1);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveTabFocus(id, -1);
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  const targetTab = event.key === "Home" ? TOOL_TABS[0].id : TOOL_TABS[TOOL_TABS.length - 1].id;
                  selectTab(targetTab);
                  requestAnimationFrame(() => document.getElementById(`tool-tab-${targetTab}`)?.focus());
                }
              }}
            >
              <Icon aria-hidden="true" />
              <span><strong>{label}</strong><small>{description}</small></span>
            </button>
          ))}
        </div>

        <section
          id="toolbox-active-panel"
          role="tabpanel"
          aria-labelledby={`tool-tab-${activeTab}`}
          className={`${styles.workspace} workspace-depth-canvas`}
        >
          <ToolboxProvider activeTab={activeTab} onTabChange={selectTab}>
            {activeTab === "segment" && <SegmenterPage />}
            {(activeTab === "text" || activeTab === "video") && <ExtractPage />}
            {activeTab === "format" && <FormatterPage />}
          </ToolboxProvider>
        </section>
      </main>
    </div>
  );
}

export default function ToolboxPage() {
  return (
    <Suspense fallback={<div className={styles.loading}>正在打开工具箱...</div>}>
      <ToolboxWorkspace />
    </Suspense>
  );
}
