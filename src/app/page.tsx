"use client";

import { useApp } from "@/contexts/app-context";
import { LandingPage } from "@/components/landing-page";
import dynamic from "next/dynamic";

const ChatView = dynamic(() => import("@/components/chat-view").then(mod => ({ default: mod.ChatView })), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm" role="status" aria-live="polite">
      正在加载对话...
    </div>
  ),
});

const AppSidebar = dynamic(() => import("@/components/app-sidebar").then(mod => ({ default: mod.AppSidebar })), {
  ssr: false,
  loading: () => <div className="h-full bg-[var(--sidebar)]" aria-hidden="true" />,
});

const AgentMarketplace = dynamic(() => import("@/components/agent-marketplace").then(mod => ({ default: mod.AgentMarketplace })), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      加载应用广场...
    </div>
  ),
});

import { useEffect, useCallback, useState, useRef } from "react";

import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { cn } from "@/lib/utils";
import { Menu, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { TrialPlanDialog } from "@/components/trial-plan-dialog";
import { getTitleFontFamily } from "@/types/coze";
import { consumeSecondaryPageReturn } from "@/lib/marketplace-navigation";
import {
  APP_DIALOG_CLAIMED_EVENT,
  APP_DIALOG_RELEASED_EVENT,
  claimAppDialog,
  currentAppDialogOwner,
  releaseAppDialog,
} from "@/lib/client-dialog-queue";

function ProfilePlaceholder() {
  return (
    <div className="flex-1 flex items-center justify-center bg-[var(--background)]">
      <div className="text-center text-[#6B7280]">
        <p className="text-sm">请从侧边栏访问个人中心</p>
      </div>
    </div>
  );
}

// Hook: 检测是否为移动端
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);

  return isMobile;
}

// 桌面侧栏与主内容之间原本留有一条偏窄的呼吸缝；小幅加宽后，导航、分类栏和卡片一起右移。
// 移动端抽屉保持原宽度，避免影响手机端可用空间。
const DESKTOP_SIDEBAR_EXTRA_WIDTH = 20;

export default function Home() {
  const { state, dispatch, fetchAgents, checkAuth } = useApp();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showTrialDialog, setShowTrialDialog] = useState(false);
  const trialDialogOpenRef = useRef(false);
  const deferredTrialDialogRef = useRef(false);

  const openTrialDialog = useCallback(() => {
    const owner = currentAppDialogOwner();
    if (owner && owner !== "trial") {
      deferredTrialDialogRef.current = true;
      return;
    }
    deferredTrialDialogRef.current = false;
    claimAppDialog("trial");
    trialDialogOpenRef.current = true;
    setShowTrialDialog(true);
  }, []);

  const closeTrialDialog = useCallback(() => {
    deferredTrialDialogRef.current = false;
    trialDialogOpenRef.current = false;
    setShowTrialDialog(false);
    releaseAppDialog("trial");
  }, []);

  useEffect(() => {
    const onClaimed = (event: Event) => {
      const owner = (event as CustomEvent<{ owner?: string }>).detail?.owner;
      if (owner === "trial" || !trialDialogOpenRef.current) return;
      deferredTrialDialogRef.current = true;
      trialDialogOpenRef.current = false;
      setShowTrialDialog(false);
    };
    const onReleased = () => {
      if (!deferredTrialDialogRef.current) return;
      window.setTimeout(() => {
        if (deferredTrialDialogRef.current && !currentAppDialogOwner()) openTrialDialog();
      }, 80);
    };
    window.addEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
    window.addEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
    return () => {
      window.removeEventListener(APP_DIALOG_CLAIMED_EVENT, onClaimed);
      window.removeEventListener(APP_DIALOG_RELEASED_EVENT, onReleased);
      releaseAppDialog("trial");
    };
  }, [openTrialDialog]);

  // ── 入口守卫：sessionStorage entered_app 标记 ──
  // sessionStorage 在关闭标签页/浏览器时自动清除，刷新（F5）时保留
  // 未标记 entered_app → 显示首页 LandingPage（无论是否登录）
  // 已标记 entered_app → 显示应用（marketplace/chat，根据 localStorage 恢复）
  const [enteredApp, setEnteredApp] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [returnedFromSecondaryPage, setReturnedFromSecondaryPage] = useState(false);

  useEffect(() => {
    const shouldShowMarketplace = consumeSecondaryPageReturn();
    if (shouldShowMarketplace) {
      dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
      setReturnedFromSecondaryPage(true);
    }
    setEnteredApp(shouldShowMarketplace || sessionStorage.getItem("entered_app") === "1");
    setHasHydrated(true);
  }, [dispatch]);

  useEffect(() => {
    if (!returnedFromSecondaryPage) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
      setReturnedFromSecondaryPage(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [dispatch, returnedFromSecondaryPage]);

  const handleEnterApp = useCallback(() => {
    sessionStorage.setItem("entered_app", "1");
    setEnteredApp(true);
    dispatch({ type: "SET_VIEW", payload: "marketplace" });
  }, [dispatch]);

  // 检测是否应该弹出试用套餐提示
  useEffect(() => {
    if (!enteredApp) return;
    if (state.auth.isAuthenticated && state.auth.user) {
      const memberStatus = state.auth.user.memberStatus;
      const role = state.auth.user.role;
      // 非管理员 + 会员未激活或已过期 → 弹出试用套餐/卡密兑换提示
      if (role !== "admin" && (memberStatus === "inactive" || memberStatus === "expired")) {
        // 检查是否已经弹过（同一次登录只弹一次）
        const trialDismissed = sessionStorage.getItem("trial_dialog_dismissed");
        if (!trialDismissed) {
          // 延迟1.5秒弹窗，避免登录刷新时闪烁
          const timer = setTimeout(openTrialDialog, 1500);
          return () => clearTimeout(timer);
        }
      }
    }
  }, [enteredApp, openTrialDialog, state.auth.isAuthenticated, state.auth.user]);

  // 加载全局字体设置并应用CSS变量
  const applyGlobalFontSettings = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        // 优先从 page_layout 读取，降级到 card_layout
        const pl = d.settings?.page_layout;
        const cl = d.settings?.card_layout;
        const raw = pl || cl;
        if (!raw) return;
        try {
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          // page_layout 格式: { card: { globalTitleSize, ... }, nav: {}, category: {} }
          // card_layout 格式: { globalTitleSize, ... } (旧格式)
          const fontSrc = parsed.card || parsed;
          const root = document.documentElement;
          if (fontSrc.globalTitleSize) root.style.setProperty("--font-title-size", `${fontSrc.globalTitleSize}px`);
          if (fontSrc.globalTitleColor) root.style.setProperty("--font-title-color", fontSrc.globalTitleColor);
          if (fontSrc.globalBodySize) root.style.setProperty("--font-body-size", `${fontSrc.globalBodySize}px`);
          if (fontSrc.globalBodyColor) root.style.setProperty("--font-body-color", fontSrc.globalBodyColor);
          if (fontSrc.globalAuxSize) root.style.setProperty("--font-aux-size", `${fontSrc.globalAuxSize}px`);
          if (fontSrc.globalAuxColor) root.style.setProperty("--font-aux-color", fontSrc.globalAuxColor);
          // 应用标题字体选择
          const titleFontId = fontSrc.titleFontFamily || "";
          if (titleFontId) {
            const family = getTitleFontFamily(titleFontId);
            if (family) root.style.setProperty("--font-title", family);
          }
        } catch {}
      })
      .catch(() => {});
  }, []);

  // 智能体目录属于当前认证身份。登录、退出、换号或 token 轮换后都必须
  // 重新读取并整体替换，不能让游客请求或上一账号的迟到响应留在页面上。
  const agentCatalogRequestVersionRef = useRef(0);
  const agentCatalogQueueRef = useRef<Promise<void>>(Promise.resolve());
  const agentCatalogIdentityKey = state.auth.isAuthenticated
    ? `user:${state.auth.user?.id || "pending"}:${state.auth.user?.role || "unknown"}:${state.auth.token || "missing-token"}`
    : "guest";
  useEffect(() => {
    if (!enteredApp) return;
    const requestVersion = ++agentCatalogRequestVersionRef.current;

    // 身份切换的同一帧先清空旧目录。后续请求按队列执行，旧身份请求完成后
    // 会再次清空，随后才允许最新身份请求写入，避免乱序响应覆盖新目录。
    dispatch({ type: "SET_AGENTS", payload: [] });
    agentCatalogQueueRef.current = agentCatalogQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (requestVersion !== agentCatalogRequestVersionRef.current) return;
        dispatch({ type: "SET_AGENTS", payload: [] });
        await fetchAgents();
        if (requestVersion !== agentCatalogRequestVersionRef.current) {
          dispatch({ type: "SET_AGENTS", payload: [] });
          return;
        }
        if (state.auth.isAuthenticated) applyGlobalFontSettings();
      });
  }, [agentCatalogIdentityKey, applyGlobalFontSettings, dispatch, enteredApp, fetchAgents, state.auth.isAuthenticated]);

  // 侧边栏导航时自动关闭移动端抽屉
  const handleSidebarNavigate = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const activeView = returnedFromSecondaryPage ? "marketplace" : state.view;
  const isFullscreen = state.isChatFullscreen && activeView === "chat";
  const sidebarBaseWidth = state.sidebarWidth || 300;
  const desktopSidebarWidth = sidebarBaseWidth + (!isMobile ? DESKTOP_SIDEBAR_EXTRA_WIDTH : 0);

  // 桌面端侧边栏折叠状态
  const isSidebarCollapsed = !isMobile && !isFullscreen && state.sidebarCollapsed;
  // ── 入口守卫：sessionStorage entered_app 标记 ──
  // 未标记 entered_app → 始终显示首页 LandingPage（平台介绍 + 登录入口）
  // 已标记 entered_app → 显示应用主体（marketplace/chat 按状态恢复）
  if (!hasHydrated) {
    return <div className="h-screen bg-[var(--background)]" aria-hidden="true" />;
  }

  if (!enteredApp) {
    return (
      <>
        <LandingPage onEnterApp={handleEnterApp} />
      </>
    );
  }

  return (
    <div className="app-shell h-screen overflow-clip bg-[var(--background)]">
      {/* 移动端汉堡菜单按钮 */}
      {isMobile && !isFullscreen && (
        <button
          className="mobile-menu-btn"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="打开菜单"
        >
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      )}

      {/* 桌面端侧边栏 — fixed 定位 + translate-x 滑动动画（对标参考站） */}
      {!isMobile && !isFullscreen && (
        <div
          className={cn(
            "app-sidebar-frame fixed top-0 left-0 z-40 h-full bg-[var(--sidebar)] border-r border-[var(--sidebar-border)]",
            "transition-all duration-500 ease-in-out",
            isSidebarCollapsed ? "-translate-x-full" : "translate-x-0"
          )}
          style={{ width: `${desktopSidebarWidth}px` }}
        >
          <div className="h-full relative">
            <FeatureErrorBoundary moduleName="侧边导航栏">
              <AppSidebar onNavigate={handleSidebarNavigate} />
            </FeatureErrorBoundary>
            {/* 收起按钮 — 侧边栏右上角 */}
            <button
              onClick={() => dispatch({ type: "SET_SIDEBAR_COLLAPSED", payload: true })}
              className="absolute top-3 right-2 z-10 w-7 h-7 rounded-lg flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
              title="收起侧边栏"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 桌面端侧边栏折叠时 — 侧边展开按钮 */}
      {!isMobile && !isFullscreen && isSidebarCollapsed && (
        <button
          onClick={() => dispatch({ type: "SET_SIDEBAR_COLLAPSED", payload: false })}
          className="fixed top-3 left-3 z-30 w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--card)] border border-[var(--border)] shadow-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition-all duration-200"
          title="展开侧边栏"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {/* 移动端侧边栏 — 抽屉覆盖层 */}
      {isMobile && (
        <>
          {/* 遮罩层 */}
          <div
            className="sidebar-overlay"
            data-state={sidebarOpen ? "open" : "closed"}
            onClick={() => setSidebarOpen(false)}
          />
          {/* 侧边栏抽屉 */}
          <div
            className="sidebar-drawer fixed top-0 left-0 z-50 h-full"
            data-state={sidebarOpen ? "open" : "closed"}
          >
            <FeatureErrorBoundary moduleName="侧边导航栏">
              <AppSidebar isMobile onNavigate={handleSidebarNavigate} />
            </FeatureErrorBoundary>
          </div>
        </>
      )}

      {/* 主内容区 — padding-left 避让 + 平滑过渡（对标参考站 transition-[padding]） */}
      <main
        className={cn(
          "app-main-stage h-screen overflow-hidden transition-[padding] duration-500 ease-in-out",
          isFullscreen && "w-full !pl-0"
        )}
        style={{
          paddingLeft: (!isMobile && !isFullscreen && !isSidebarCollapsed) ? `${desktopSidebarWidth}px` : "0px",
        }}
      >
        <div key={activeView} className="animate-content-reveal h-full overflow-hidden">
          <FeatureErrorBoundary moduleName={activeView === "chat" ? "AI对话" : activeView === "profile" ? "个人中心" : "智能体市场"}>
            {activeView === "chat" ? <ChatView /> : activeView === "profile" ? <ProfilePlaceholder /> : <AgentMarketplace />}
          </FeatureErrorBoundary>
        </div>
      </main>

      {/* 试用套餐提示弹窗 */}
      <FeatureErrorBoundary moduleName="试用套餐弹窗" variant="inline">
        <TrialPlanDialog
        open={showTrialDialog}
        onClose={() => {
          closeTrialDialog();
          sessionStorage.setItem("trial_dialog_dismissed", "1");
        }}
        onActivated={() => {
          closeTrialDialog();
          sessionStorage.setItem("trial_dialog_dismissed", "1");
          // 刷新用户信息
          checkAuth();
        }}
      />
      </FeatureErrorBoundary>
    </div>
  );
}
