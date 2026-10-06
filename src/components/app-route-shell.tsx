"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { AppScopedLink } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import {
  Bot,
  BrainCircuit,
  ChevronLeft,
  CircleHelp,
  CreditCard,
  Film,
  FolderOpen,
  Gift,
  Home,
  Lightbulb,
  Menu,
  Moon,
  Palette,
  Sparkles,
  Tv,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { DEFAULT_PLATFORM_LOGO_URL, platformBrandLogoUrl, usePlatformBranding } from "@/hooks/use-platform-branding";
import { isYoucaiPath, toYoucaiHref } from "@/lib/youcai-routes";
import {
  readManjuShowcaseCatalog,
  type ManjuShowcaseCatalogV1,
} from "@/lib/manju-showcase-runtime";
import styles from "./app-route-shell.module.css";

interface NavigationItem {
  label: string;
  href: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  matches?: readonly string[];
  excludes?: readonly string[];
}

export type ManjuRuntimeState = "idle" | "loading" | "ready" | "stale" | "unavailable";

interface ManjuRuntimeView {
  state: ManjuRuntimeState;
  brandName: string;
  navigation: ReadonlySet<string> | null;
  featureFlags: Readonly<Record<string, boolean>>;
  showcaseCatalog: ManjuShowcaseCatalogV1 | null;
  issueCode?: string;
  issueMessage?: string;
}

const DEFAULT_MANJU_RUNTIME: ManjuRuntimeView = {
  state: "idle",
  brandName: "漫剧工作台",
  navigation: null,
  featureFlags: {},
  showcaseCatalog: null,
};

const ManjuRuntimeContext = createContext<ManjuRuntimeView>(DEFAULT_MANJU_RUNTIME);

export function useManjuShowcaseCatalog(): ManjuShowcaseCatalogV1 | null {
  return useContext(ManjuRuntimeContext).showcaseCatalog;
}

export function useManjuRuntimeState(): ManjuRuntimeState {
  return useContext(ManjuRuntimeContext).state;
}

const MANJU_RUNTIME_CACHE_TTL_MS = 15_000;
const MANJU_RUNTIME_UNAVAILABLE_RETRY_MS = 5_000;
const MANJU_RUNTIME_LAST_KNOWN_GOOD_MS = 5 * 60_000;
let manjuRuntimeCache: {
  value: ManjuRuntimeView;
  etag: string | null;
  expiresAt: number;
  staleUntil: number;
} | null = null;
let manjuRuntimeRequest: Promise<ManjuRuntimeView> | null = null;

function readCachedManjuRuntime() {
  if (!manjuRuntimeCache) return null;
  if (manjuRuntimeCache.expiresAt <= Date.now()) return null;
  return manjuRuntimeCache.value;
}

function loadManjuRuntime(forceRevalidate = false) {
  const cached = forceRevalidate ? null : readCachedManjuRuntime();
  if (cached) return Promise.resolve(cached);
  if (manjuRuntimeRequest) return manjuRuntimeRequest;

  manjuRuntimeRequest = (async () => {
    const previous = manjuRuntimeCache;
    try {
      const response = await fetch("/api/youcai/runtime-config", {
        credentials: "same-origin",
        cache: "no-cache",
        headers: previous?.etag ? { "If-None-Match": previous.etag } : undefined,
      });
      if (response.status === 304 && previous) {
        const now = Date.now();
        const value = { ...previous.value, state: "ready" } satisfies ManjuRuntimeView;
        manjuRuntimeCache = {
          value,
          etag: previous.etag,
          expiresAt: now + MANJU_RUNTIME_CACHE_TTL_MS,
          staleUntil: now + MANJU_RUNTIME_LAST_KNOWN_GOOD_MS,
        };
        return value;
      }
      const body = await response.json() as {
        ok?: boolean;
        etag?: unknown;
        code?: unknown;
        error?: unknown;
        message?: unknown;
        domains?: {
          content?: { brand?: unknown; navigation?: unknown };
          feature_flags?: Record<string, unknown>;
          media?: unknown;
        };
      };
      if (!response.ok || body.ok !== true || !body.domains) {
        const issueCode = typeof body.code === "string" && body.code.trim()
          ? body.code.trim()
          : "MANJU_RUNTIME_UNAVAILABLE";
        const issueMessage = typeof body.error === "string" && body.error.trim()
          ? body.error.trim()
          : typeof body.message === "string" && body.message.trim()
            ? body.message.trim()
            : "";
        throw new Error(issueMessage ? `${issueCode}: ${issueMessage}` : issueCode);
      }
      const content = body.domains.content;
      const showcaseCatalog = readManjuShowcaseCatalog(body.domains.media);
      if (
        typeof content?.brand !== "string"
        || !content.brand.trim()
        || !Array.isArray(content.navigation)
        || content.navigation.some((value) => typeof value !== "string")
        || !body.domains.feature_flags
        || typeof body.domains.feature_flags !== "object"
        || !showcaseCatalog
      ) {
        throw new Error("MANJU_RUNTIME_CONTRACT_INVALID");
      }
      const brandName = content.brand.trim();
      const navigation = new Set(content.navigation as string[]);
      const featureFlags = Object.fromEntries(
        Object.entries(body.domains.feature_flags)
          .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
      );
      const runtime = {
        state: "ready",
        brandName,
        navigation,
        featureFlags,
        showcaseCatalog,
      } satisfies ManjuRuntimeView;
      const now = Date.now();
      manjuRuntimeCache = {
        value: runtime,
        etag: response.headers.get("etag")
          ?? (typeof body.etag === "string" ? body.etag : null),
        expiresAt: now + MANJU_RUNTIME_CACHE_TTL_MS,
        staleUntil: now + MANJU_RUNTIME_LAST_KNOWN_GOOD_MS,
      };
      return runtime;
    } catch (reason) {
      const now = Date.now();
      if (previous && previous.staleUntil > now && (previous.value.state === "ready" || previous.value.state === "stale")) {
        const stale = { ...previous.value, state: "stale" } satisfies ManjuRuntimeView;
        manjuRuntimeCache = {
          ...previous,
          value: stale,
          expiresAt: now + MANJU_RUNTIME_UNAVAILABLE_RETRY_MS,
        };
        return stale;
      }
      const rawIssue = reason instanceof Error ? reason.message : "MANJU_RUNTIME_UNAVAILABLE";
      const [issueCode, ...messageParts] = rawIssue.split(":");
      const unavailable = {
        ...DEFAULT_MANJU_RUNTIME,
        state: "unavailable",
        issueCode: issueCode.trim() || "MANJU_RUNTIME_UNAVAILABLE",
        issueMessage: messageParts.join(":").trim(),
      } satisfies ManjuRuntimeView;
      manjuRuntimeCache = {
        value: unavailable,
        etag: null,
        expiresAt: now + MANJU_RUNTIME_UNAVAILABLE_RETRY_MS,
        staleUntil: now,
      };
      return unavailable;
    }
  })().finally(() => {
      manjuRuntimeRequest = null;
    });

  return manjuRuntimeRequest;
}

const NAVIGATION_FEATURES: Readonly<Record<string, string>> = {
  "/assets": "assets",
  "/tools/text/text-chat": "creative_agent",
  "/tools/film-studio": "film_studio",
  "/tools/canvas": "canvas",
  "/inspiration": "inspiration",
};

function useManjuRuntime(insideYoucai: boolean, refreshKey: string): ManjuRuntimeView {
  const [runtime, setRuntime] = useState<ManjuRuntimeView>(() => (
    insideYoucai ? readCachedManjuRuntime() ?? DEFAULT_MANJU_RUNTIME : DEFAULT_MANJU_RUNTIME
  ));

  useEffect(() => {
    if (!insideYoucai) {
      setRuntime(DEFAULT_MANJU_RUNTIME);
      return;
    }
    let active = true;
    const refresh = (forceRevalidate = false) => {
      if (!readCachedManjuRuntime()) {
        setRuntime((current) => current.state === "idle"
          ? { ...current, state: "loading" }
          : current);
      }
      void loadManjuRuntime(forceRevalidate).then((nextRuntime) => {
        if (active) setRuntime(nextRuntime);
      });
    };
    refresh();
    const interval = window.setInterval(() => refresh(), MANJU_RUNTIME_UNAVAILABLE_RETRY_MS);
    const handleFocus = () => refresh(true);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refresh(true);
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [insideYoucai, refreshKey]);

  return runtime;
}

const MAIN_COMPAT_NAVIGATION_GROUPS: readonly (readonly NavigationItem[])[] = [
  [{ label: "个人资产", href: "/assets", icon: FolderOpen, matches: ["/assets"] }],
  [
    {
      label: "创作中心",
      href: "/tools",
      icon: Sparkles,
      matches: ["/tools"],
      excludes: ["/tools/text/text-chat", "/tools/film-studio", "/tools/canvas", "/tools/utility"],
    },
    { label: "创作 Agent", href: "/tools/text/text-chat", icon: Bot, matches: ["/tools/text/text-chat"] },
    { label: "影视工坊", href: "/tools/film-studio", icon: Film, matches: ["/tools/film-studio", "/short-drama"] },
    { label: "实用工具箱", href: "/tools/utility", icon: Wrench, matches: ["/tools/utility"] },
  ],
  [
    { label: "灵感广场", href: "/inspiration", icon: Lightbulb },
    { label: "成片广场", href: "/youcai-tv", icon: Tv },
  ],
  [
    { label: "帮助中心", href: "/articles", icon: CircleHelp, matches: ["/articles", "/help"] },
    { label: "积分充值", href: "/recharge", icon: CreditCard, matches: ["/recharge", "/payment"] },
    { label: "推荐计划", href: "/referral", icon: Gift },
  ],
] as const;

const YOUCAI_NAVIGATION_GROUPS: readonly (readonly NavigationItem[])[] = [
  [
    { label: "个人资产", href: "/assets", icon: FolderOpen, matches: ["/assets"] },
    { label: "Skill 专家", href: "/skills", icon: BrainCircuit, matches: ["/skills"] },
  ],
  [
    {
      label: "创作中心",
      href: "/tools",
      icon: Sparkles,
      matches: ["/tools"],
      excludes: ["/tools/text/text-chat", "/tools/film-studio", "/tools/canvas"],
    },
    { label: "创作 Agent", href: "/tools/text/text-chat", icon: Bot, matches: ["/tools/text/text-chat"] },
    { label: "影视工坊", href: "/tools/film-studio", icon: Film, matches: ["/tools/film-studio"] },
    { label: "漫剧画布", href: "/tools/canvas", icon: Palette, matches: ["/tools/canvas", "/share/canvas"] },
  ],
  [
    { label: "灵感广场", href: "/inspiration", icon: Lightbulb },
    { label: "漫剧TV", href: "/youcai-tv", icon: Tv },
  ],
  [
    { label: "帮助中心", href: "/articles", icon: CircleHelp, matches: ["/articles"] },
    { label: "积分充值", href: "/recharge", icon: CreditCard, matches: ["/recharge", "/payment"] },
    { label: "推荐计划", href: "/referral", icon: Gift },
  ],
] as const;

function Brand({ insideYoucai, brandName = "漫剧工作台" }: { insideYoucai: boolean; brandName?: string }) {
  const platformBranding = usePlatformBranding();
  const mainBrandName = platformBranding.brand.name || "自媒体操盘手";
  const mainLogoUrl = platformBrandLogoUrl(platformBranding, "square");
  return (
    <AppScopedLink
      className={styles.brand}
      data-youcai={insideYoucai ? "true" : undefined}
      href="/"
      aria-label={insideYoucai ? "返回漫剧工作台首页" : `返回${mainBrandName}主站`}
    >
      <span className={styles.brandMark} data-platform-logo={insideYoucai ? undefined : "true"} aria-hidden="true">
        {insideYoucai ? (
          <svg viewBox="0 0 30 30" role="presentation">
            <path d="M14.8 2.8c.7 5.7 2.5 8 8.1 8.8-5.6.8-7.4 3.1-8.1 8.8-.8-5.7-2.6-8-8.2-8.8 5.6-.8 7.4-3.1 8.2-8.8Z" fill="#ffe02b" stroke="#111827" strokeWidth="2.2" strokeLinejoin="round" />
            <path d="M23.6 17.1c.4 3.4 1.5 4.8 4.8 5.3-3.3.5-4.4 1.9-4.8 5.3-.5-3.4-1.6-4.8-4.9-5.3 3.3-.5 4.4-1.9 4.9-5.3Z" fill="#9df5e7" stroke="#111827" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M5.3 3.5c.3 2.5 1.1 3.5 3.5 3.8-2.4.4-3.2 1.4-3.5 3.9-.4-2.5-1.2-3.5-3.6-3.9 2.4-.3 3.2-1.3 3.6-3.8Z" fill="#8b5cf6" stroke="#111827" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        ) : (
          <img
            src={mainLogoUrl}
            alt=""
            className={styles.brandLogoImage}
            onError={(event) => {
              event.currentTarget.onerror = null;
              event.currentTarget.src = DEFAULT_PLATFORM_LOGO_URL;
            }}
          />
        )}
      </span>
      <span>{insideYoucai ? brandName : mainBrandName}</span>
    </AppScopedLink>
  );
}

function MainHomeLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      className={styles.mainHomeLink}
      href="/"
      aria-label="返回自媒体操盘手主页"
      onClick={onNavigate}
    >
      <Home size={18} strokeWidth={1.9} aria-hidden="true" />
      <span>返回主页</span>
    </Link>
  );
}

function Navigation({
  insideYoucai,
  onNavigate,
  prefetch,
  runtime,
}: {
  insideYoucai: boolean;
  onNavigate?: () => void;
  prefetch?: boolean;
  runtime: ManjuRuntimeView;
}) {
  const pathname = usePathname();
  const router = useAppScopedRouter();
  const scopePath = (href: string) => insideYoucai ? toYoucaiHref(href) : href;
  const groups = insideYoucai ? YOUCAI_NAVIGATION_GROUPS : MAIN_COMPAT_NAVIGATION_GROUPS;
  const hasPublishedNavigation = insideYoucai
    && (runtime.state === "ready" || runtime.state === "stale")
    && runtime.navigation instanceof Set;

  return (
    <nav className={styles.navigation} aria-label={insideYoucai ? "漫剧工作台主导航" : "影视工坊主导航"}>
      {groups.map((group, groupIndex) => (
        <div className={styles.navigationGroup} key={groupIndex}>
          {group.filter((item) => {
            if (!insideYoucai) return true;
            if (!hasPublishedNavigation) return true;
            const flagName = NAVIGATION_FEATURES[item.href];
            if (flagName && runtime.featureFlags[flagName] !== true) return false;
            return runtime.navigation?.has(toYoucaiHref(item.href)) === true;
          }).map((item) => {
            const Icon = item.icon;
            const excluded = (item.excludes || []).some((prefix) => (
              pathname === scopePath(prefix) || pathname.startsWith(`${scopePath(prefix)}/`)
            ));
            const active = !excluded && (item.matches || [item.href]).some((prefix) => (
              pathname === scopePath(prefix) || pathname.startsWith(`${scopePath(prefix)}/`)
            ));
            return (
              <AppScopedLink
                className={styles.navigationLink}
                data-active={active ? "true" : undefined}
                href={item.href}
                key={`${groupIndex}-${item.label}`}
                onClick={onNavigate}
                onFocus={() => {
                  if (prefetch !== false) router.prefetch(item.href);
                }}
                onPointerEnter={() => {
                  if (prefetch !== false) router.prefetch(item.href);
                }}
                prefetch={false}
              >
                <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                <span>{item.label}</span>
              </AppScopedLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function AccountSummary({ insideYoucai }: { insideYoucai: boolean }) {
  const { state } = useApp();
  const user = state.auth.user;
  const displayName = user?.username || "登录";
  const userBalance = user as (typeof user & { cashBalance?: number | string | null; cash_balance?: number | string | null });
  const userCashBalance = Number(userBalance?.cashBalance ?? userBalance?.cash_balance ?? 0);
  const credits = Number(state.credits?.remaining ?? user?.credits ?? 0);
  const cashBalance = Number(state.cashBalance ?? userCashBalance ?? 0);
  const creditsLabel = credits.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const cashBalanceLabel = cashBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!user && insideYoucai) {
    return (
      <div className={styles.accountArea} data-signed-out="true">
        <div className={styles.themeRow} aria-hidden="true"><Moon size={17} /><ChevronLeft size={17} /></div>
        <div className={styles.signedOutActions}>
          <Link href="/login?redirect=%2Fyoucai%2Fprofile">登录</Link>
          <Link href="/register?redirect=%2Fyoucai%2Fprofile">注册</Link>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={styles.accountArea}>
        <div className={styles.themeRow} aria-hidden="true"><Moon size={17} /></div>
        <Link className={styles.accountLink} href="/login">
          <span className={styles.avatar}><UserRound size={16} /></span>
          <span className={styles.accountCopy}>
            <strong>登录</strong>
            <small>登录后同步会员与积分</small>
          </span>
        </Link>
      </div>
    );
  }

  const accountContent = (
    <>
      <span className={styles.avatar}><UserRound size={16} /></span>
      <span className={styles.accountCopy}>
        <strong>{displayName}</strong>
        <span className={styles.balancePills} aria-hidden="true">
          <small className={styles.creditBalance}>{creditsLabel} 积分</small>
          <small className={styles.cashBalance}>¥{cashBalanceLabel} 现金</small>
        </span>
      </span>
    </>
  );

  return (
    <div className={styles.accountArea}>
      <div className={styles.themeRow} aria-hidden="true"><Moon size={17} /></div>
      {insideYoucai ? (
        <AppScopedLink
          aria-label={`进入个人中心，当前余额：${creditsLabel}积分，现金${cashBalanceLabel}元`}
          className={styles.accountLink}
          data-testid="youcai-account-profile-link"
          href="/profile"
        >
          {accountContent}
        </AppScopedLink>
      ) : (
        <div className={styles.accountCard} role="group" aria-label={`账号余额：${creditsLabel}积分，现金${cashBalanceLabel}元`}>
          {accountContent}
        </div>
      )}
    </div>
  );
}

function Sidebar({
  insideYoucai,
  mobile,
  onNavigate,
  runtime,
}: {
  insideYoucai: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
  runtime: ManjuRuntimeView;
}) {
  return (
    <aside
      className={mobile ? styles.mobileDrawer : styles.desktopSidebar}
      data-testid={mobile ? "film-studio-mobile-drawer" : "film-studio-sidebar"}
      data-youcai={insideYoucai ? "true" : undefined}
    >
      <Brand insideYoucai={insideYoucai} brandName={runtime.brandName} />
      {insideYoucai && <MainHomeLink onNavigate={onNavigate} />}
      <Navigation insideYoucai={insideYoucai} onNavigate={onNavigate} prefetch={mobile ? false : undefined} runtime={runtime} />
      <AccountSummary insideYoucai={insideYoucai} />
    </aside>
  );
}

function manjuRuntimeRecoveryNotice(runtime: ManjuRuntimeView): {
  title: string;
  detail: string;
  action: string;
} {
  const code = runtime.issueCode ?? "MANJU_RUNTIME_UNAVAILABLE";
  if (code === "MIGRATION_NOT_READY" || code === "CONFIG_STORAGE_STATE_MISSING") {
    return {
      title: "部分扩展功能正在准备中",
      detail: "当前继续提供基础创作功能，暂不可用的内容不会提交或产生费用。",
      action: "服务恢复后会自动启用完整功能，请稍后刷新。",
    };
  }
  if (code === "CONFIG_STORE_CORRUPT") {
    return {
      title: "扩展配置暂时无法读取",
      detail: "当前继续使用基础创作配置，已有项目和素材不会受影响。",
      action: "系统正在恢复服务，请稍后刷新。",
    };
  }
  if (code === "CONFIG_INCOMPLETE") {
    return {
      title: "部分创作能力暂不可用",
      detail: "当前继续使用可用的基础能力，未就绪的功能保持关闭。",
      action: "服务恢复后会自动启用，请稍后刷新。",
    };
  }
  return {
    title: "创作服务暂时不可用",
    detail: "系统会自动重试，当前不会提交生成或产生费用。",
    action: "请稍后刷新页面。",
  };
}

const AppShellOwnerContext = createContext(false);

type AppRouteShellProps = { children: ReactNode; className?: string; sidebarVariant?: "full" | "navigation" };

/** Shared layouts own navigation. Existing page wrappers only provide their local theme. */
export function AppRouteShell(props: AppRouteShellProps) {
  const inherited = useContext(AppShellOwnerContext);
  if (inherited) return props.className ? <div className={props.className}>{props.children}</div> : <>{props.children}</>;
  return <AppRouteShellFrame {...props} />;
}

function AppRouteShellFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
  sidebarVariant?: "full" | "navigation";
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const insideYoucai = isYoucaiPath(pathname);
  const manjuRuntime = useManjuRuntime(insideYoucai, pathname);
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => { mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "instant" }); setMobileOpen(false); }, [pathname]);
  const recoveryNotice = manjuRuntime.state === "unavailable"
    ? manjuRuntimeRecoveryNotice(manjuRuntime)
    : null;

  return (
    <AppShellOwnerContext.Provider value={true}>
    <ManjuRuntimeContext.Provider value={manjuRuntime}>
      <div
        className={`${styles.shell}${className ? ` ${className}` : ""}`}
        data-manju-runtime={insideYoucai ? manjuRuntime.state : undefined}
      >
        <Sidebar insideYoucai={insideYoucai} runtime={manjuRuntime} />

      <header className={styles.mobileHeader} data-testid="film-studio-mobile-header">
        <Brand insideYoucai={insideYoucai} brandName={manjuRuntime.brandName} />
        <button
          type="button"
          className={styles.mobileMenuButton}
          aria-label={mobileOpen ? "关闭导航" : "打开导航"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </header>

      <button
        type="button"
        className={styles.mobileBackdrop}
        data-open={mobileOpen ? "true" : undefined}
        aria-label="关闭导航遮罩"
        onClick={() => setMobileOpen(false)}
      />
      <div className={styles.mobileDrawerWrap} data-open={mobileOpen ? "true" : undefined}>
          <Sidebar
            insideYoucai={insideYoucai}
            mobile
            onNavigate={() => setMobileOpen(false)}
            runtime={manjuRuntime}
          />
      </div>

        <main
          ref={mainRef}
          className={styles.main}
          data-testid={insideYoucai ? "manju-content" : "app-route-content"}
        >
          {insideYoucai && manjuRuntime.state === "stale" ? (
            <div className={styles.runtimeNotice} role="status" aria-live="polite">
              配置服务暂时不可用，当前显示最近一次已发布配置，系统正在自动重试。
            </div>
          ) : null}
          {insideYoucai && manjuRuntime.state === "unavailable" ? (
            <div className={`${styles.runtimeNotice} ${styles.runtimeNoticeUnavailable}`} role="alert">
              <strong>{recoveryNotice?.title}</strong>
              <span>{recoveryNotice?.detail}</span>
              <span>{recoveryNotice?.action}</span>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </ManjuRuntimeContext.Provider>
    </AppShellOwnerContext.Provider>
  );
}
