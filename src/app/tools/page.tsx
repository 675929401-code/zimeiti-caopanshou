"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useState } from "react";
import { FileText, Home, Scissors, Text, Video, Wrench } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { ToolboxProvider, type ToolboxTabId } from "@/components/toolbox-context";
import { BrandFooter } from "@/components/brand-footer";
import styles from "./tools.module.css";

const ExtractPage = dynamic(() => import("@/app/extract/page"), {
  loading: () => <div className={styles.loading}>正在加载提取工具...</div>,
});
const FormatterPage = dynamic(() => import("@/app/formatter/page"), {
  loading: () => <div className={styles.loading}>正在加载排版工具...</div>,
});
const SegmenterPage = dynamic(() => import("@/app/segmenter/page"), {
  loading: () => <div className={styles.loading}>正在加载分段工具...</div>,
});

const TOOL_TABS = [
  { id: "text", label: "文案提取", description: "提取字幕与口播正文", processing: "在线通道 · 提交前报价", Icon: FileText },
  { id: "video", label: "视频提取", description: "解析原视频并安全下载", processing: "在线通道 · 提交前报价", Icon: Video },
  { id: "format", label: "文字排版", description: "清理格式并整理段落", processing: "本地处理 · 免费", Icon: Text },
  { id: "segment", label: "智能分段", description: "按口播节奏切分文案", processing: "本地处理 · 免费", Icon: Scissors },
] as const;

type ToolTab = ToolboxTabId;
type ToolPanel = "extract" | "format" | "segment";
const DEFAULT_TOOL_TAB: ToolTab = "text";
const TOOLBOX_ACTIVE_TAB_KEY = "toolbox_active_tab";
const TOOLBOX_ACTIVE_TAB_READY_KEY = "toolbox_active_tab_ready";

function panelForTab(tab: ToolTab): ToolPanel {
  if (tab === "text" || tab === "video") return "extract";
  return tab;
}

function normalizeTab(value: string | null): ToolTab {
  return TOOL_TABS.some((tab) => tab.id === value) ? value as ToolTab : DEFAULT_TOOL_TAB;
}

function readStoredToolTab(): ToolTab {
  if (typeof window === "undefined") return DEFAULT_TOOL_TAB;
  try {
    if (window.localStorage.getItem(TOOLBOX_ACTIVE_TAB_READY_KEY) !== "1") return DEFAULT_TOOL_TAB;
    return normalizeTab(window.localStorage.getItem(TOOLBOX_ACTIVE_TAB_KEY));
  } catch {
    return DEFAULT_TOOL_TAB;
  }
}

function persistToolTab(tab: ToolTab) {
  try {
    window.localStorage.setItem(TOOLBOX_ACTIVE_TAB_KEY, tab);
    window.localStorage.setItem(TOOLBOX_ACTIVE_TAB_READY_KEY, "1");
  } catch {
    // A blocked storage backend must not prevent navigation or tool use.
  }
}

function toolHref(tab: ToolTab) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}

function ToolboxWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<ToolTab>(() => requestedTab ? normalizeTab(requestedTab) : readStoredToolTab());
  const [mountedPanels, setMountedPanels] = useState<Set<ToolPanel>>(
    () => new Set([panelForTab(normalizeTab(requestedTab))]),
  );

  useEffect(() => {
    const normalized = requestedTab ? normalizeTab(requestedTab) : readStoredToolTab();
    setActiveTab((current) => current === normalized ? current : normalized);
    if (requestedTab !== normalized) {
      window.history.replaceState(window.history.state, "", toolHref(normalized));
    }
  }, [requestedTab]);

  useEffect(() => {
    const panel = panelForTab(activeTab);
    setMountedPanels((current) => current.has(panel) ? current : new Set([...current, panel]));
  }, [activeTab]);

  useEffect(() => {
    const restoreTabFromHistory = () => {
      const params = new URLSearchParams(window.location.search);
      setActiveTab(normalizeTab(params.get("tab")));
    };
    window.addEventListener("popstate", restoreTabFromHistory);
    return () => window.removeEventListener("popstate", restoreTabFromHistory);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      router.push("/");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  const selectTab = useCallback((tab: ToolTab) => {
    persistToolTab(tab);
    if (tab === activeTab) return;
    setActiveTab(tab);
    window.history.pushState(window.history.state, "", toolHref(tab));
  }, [activeTab]);

  const moveTabFocus = (current: ToolTab, direction: -1 | 1) => {
    const currentIndex = TOOL_TABS.findIndex((tab) => tab.id === current);
    const nextIndex = (currentIndex + direction + TOOL_TABS.length) % TOOL_TABS.length;
    const nextTab = TOOL_TABS[nextIndex].id;
    selectTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tool-tab-${nextTab}`)?.focus());
  };

  const activeTool = TOOL_TABS.find((tab) => tab.id === activeTab) || TOOL_TABS[0];
  const activePanel = panelForTab(activeTab);

  return (
    <div className={styles.page} data-page="tools">
      <SubPageHeader
        title="工具箱"
        subtitle="分段、提取与排版集中处理"
        icon={<Wrench className="h-5 w-5 text-[var(--primary)]" />}
        rightSlot={<NavButton icon={Home} label="应用广场" href="/" title="返回应用广场" />}
      />

      <main className={styles.main}>
        <section className={styles.workbenchFrame} aria-label="短视频效率工具工作区">
          <aside className={styles.toolRail} aria-label="工具功能">
            <header className={styles.railHeader}>
              <strong>效率工具</strong>
              <span>提取、整理与分段</span>
            </header>

            <div className={styles.tabs} role="tablist" aria-label="工具箱功能" aria-orientation="vertical">
              {TOOL_TABS.map(({ id, label, description, Icon }) => (
                <button
                  key={id}
                  id={`tool-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === id}
                  aria-controls={`tool-panel-${panelForTab(id)}`}
                  tabIndex={activeTab === id ? 0 : -1}
                  className={activeTab === id ? styles.activeTab : undefined}
                  onClick={() => selectTab(id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                      event.preventDefault();
                      moveTabFocus(id, 1);
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
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
                  <span className={styles.tabIcon}><Icon aria-hidden="true" /></span>
                  <span><strong>{label}</strong><small>{description}</small></span>
                </button>
              ))}
            </div>
            <div className={styles.railSummary}>
              <span>当前工具</span>
              <strong>{activeTool.label}</strong>
              <small>{activeTool.processing}</small>
              <p>切换工具时，已输入的内容会保留</p>
            </div>
          </aside>

          <section className={styles.stage}>
            <h1 className={styles.srOnly}>{activeTool.label}</h1>

            <div className={styles.workspace}>
              <ToolboxProvider activeTab={activeTab} onTabChange={selectTab}>
                {mountedPanels.has("extract") && (
                  <div
                    id="tool-panel-extract"
                    role="tabpanel"
                    aria-labelledby={`tool-tab-${activeTab === "video" ? "video" : "text"}`}
                    className={styles.toolPanel}
                    hidden={activePanel !== "extract"}
                  >
                    <ExtractPage />
                  </div>
                )}
                {mountedPanels.has("format") && (
                  <div id="tool-panel-format" role="tabpanel" aria-labelledby="tool-tab-format" className={styles.toolPanel} hidden={activePanel !== "format"}>
                    <FormatterPage />
                  </div>
                )}
                {mountedPanels.has("segment") && (
                  <div id="tool-panel-segment" role="tabpanel" aria-labelledby="tool-tab-segment" className={styles.toolPanel} hidden={activePanel !== "segment"}>
                    <SegmenterPage />
                  </div>
                )}
              </ToolboxProvider>
            </div>
          </section>
        </section>
      </main>
      <BrandFooter />
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
