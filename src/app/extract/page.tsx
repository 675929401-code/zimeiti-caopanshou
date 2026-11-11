"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { resolveWorkbenchIdentity } from "@/lib/workbench-user-storage";
import { clearRetiredPageDrafts } from "@/lib/retired-page-drafts";
import { useExtractionHistory } from "@/hooks/use-extraction-history";
import { useRouter } from "next/navigation";
import { useApp } from "@/contexts/app-context";
import { copyToClipboard } from "@/lib/utils";
import { useExtractionAttemptStatus } from "@/hooks/use-extraction-attempt-status";
import { readableExtractionError } from "@/lib/extraction-provider-error";
import { SubPageHeader, NavButton } from "@/components/sub-page-header";
import { BrandFooter } from "@/components/brand-footer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToolboxHost } from "@/components/toolbox-context";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeGetItem, safeRemoveItem, safeSetItem } from "@/lib/safe-storage";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  readExtractionJsonResponse,
  isDefinitiveExtractionFailure,
  resolveBrowserClientAttempt,
  type BrowserClientAttempt,
} from "@/lib/extract-client-attempt";
import { downloadExtractMedia, requestExtractDownloadTicket } from "@/lib/extract-download-client";
import { prepareExtractSegmentDraft } from "@/lib/extract-segment-handoff";
import type { ExtractionRetryInput } from "@/lib/extraction-history";
import { useToolRuntimeCatalog, type ToolRuntimeQuote } from "@/hooks/use-tool-runtime-catalog";
import { isDeliverableExtractVideo, temporaryExtractVideoExpiresAt } from "@/lib/extract-client-result";
import {
  Video,
  FileText,
  Package,
  History,
  Download,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  Trash2,
  ClipboardPaste,
  X,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Clock3,
  Search,
  Play,
  Zap,
  LayoutGrid,
  XCircle,
} from "lucide-react";

/* ── Workflow Response Types ── */
interface VideoItem {
  row?: number;
  col?: number;
  platform?: string;
  success?: boolean;
  error?: string;
  url?: string;
  title?: string;
  cover?: string;
  download_url?: string;
  asset_id?: string;
  temporary_url?: string;
  temporary_expires_at?: number;
  duration?: number;
  width?: number;
  height?: number;
  images?: string[];
}

interface TextItem {
  url?: string;
  row?: number;
  col?: number;
  platform?: string;
  success?: boolean;
  error?: string;
  content?: string;
  corrected_content?: string;
  title?: string;
  author?: string;
  source?: string; // "title_only" 表示仅标题无口播, 其他为字段来源名
  awemeId?: string;
  likes?: number;
  debug_fields?: string[]; // 工作流返回的所有字段名（调试用）
}

interface WorkflowOutput {
  success?: boolean;
  message?: string;
  videos: VideoItem[];
  texts: TextItem[];
  summary: string;
  run_id?: string;
  author?: string;
  debug_fields?: string[];
}

/* ── douyin.wtf API Response Types ── */
interface DouyinVideoResult {
  success: boolean;
  desc: string;
  author: string;
  authorAvatar: string;
  awemeId: string;
  coverUrl: string;
  videoUrl: string;
  downloadUrl: string;
  dynamicCoverUrl: string;
  duration: number;
  width: number;
  height: number;
  stats: {
    diggCount: number;
    commentCount: number;
    shareCount: number;
    playCount: number;
    collectCount: number;
  };
  createTime: number;
  musicTitle: string;
  musicAuthor: string;
  musicUrl: string;
  asset_id?: string;
  temporary_url?: string;
  temporary_expires_at?: number;
}

interface DouyinWtfResult {
  success: boolean;
  message: string;
  results: Array<{
    input: string;
    success: boolean;
    error?: string;
    video?: DouyinVideoResult;
    transcript?: string | null;
    transcriptMethod?: string;
  }>;
  source: "douyin_wtf";
}

/* ── Unified API Response ── */
type ExtractAPIResponse = WorkflowOutput | DouyinWtfResult;

/** Convert any API response to WorkflowOutput */
function normalizeResponse(data: ExtractAPIResponse): WorkflowOutput {
  if ("source" in data && data.source === "douyin_wtf") {
    const wtf = data as DouyinWtfResult;
    const firstResult = wtf.results?.[0];
    if (firstResult?.video) {
      const v = firstResult.video;
      const transcript = firstResult.transcript;
      return {
        success: true,
        message: "提取成功",
        videos: [{
          row: 1,
          title: v.desc,
          asset_id: v.asset_id,
          temporary_url: v.temporary_url,
          temporary_expires_at: v.temporary_expires_at,
          duration: v.duration,
          width: v.width,
          height: v.height,
        }],
        texts: [{
          row: 1,
          content: transcript || "",
          source: transcript ? "asr_llm" : "none",
        }],
        summary: transcript ? (v.desc?.slice(0, 60) || "提取成功") : "口播文案提取失败",
      };
    }
    return { success: false, message: firstResult?.error || wtf.message || "提取失败", videos: [], texts: [], summary: firstResult?.error || wtf.message || "提取失败" };
  }
  return data as WorkflowOutput;
}

/* ── UI Types ── */
interface ExtractResult {
  id: string;
  url: string;
  platform: string;
  mode: string;
  timestamp: number;
  result?: WorkflowOutput;
  error?: string;
  status: "success" | "error" | "loading";
  pending?: boolean;
  attemptState?: string;
  clientRequestId?: string;
  canLoadForRetry?: boolean;
  retryInput?: ExtractionRetryInput;
  retryUnavailableReason?: string;
}

type ExtractionRetryDraft = {
  nonce: number;
  input: Exclude<ExtractionRetryInput, { requestKind: 'coze' }>;
};

type RuntimeGate = { quote?: ToolRuntimeQuote; loading: boolean; error: string; onRefresh: () => void };

function publicRuntimePriceLabel(quote?: ToolRuntimeQuote) {
  if (!quote) return "以提交前报价为准";
  if (quote.unitPrice === 0) return "免费";
  if (quote.unitPrice === null) return "按实际用量结算";
  const amount = quote.unitPrice.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  });
  return `¥${amount}/${quote.unit}`;
}

function RuntimeQuoteCard({ gate }: { gate: RuntimeGate }) {
  if (gate.loading) return <p role="status" className="mb-3 text-xs text-[var(--muted-foreground)]">正在核对通道配置与价格…</p>;
  if (gate.error || !gate.quote?.available) return (
    <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-[var(--error)]">
      <span>{gate.error ? "无法读取通道配置，提交已暂停" : "通道未就绪，提交已暂停"}</span>
      <button type="button" className="shrink-0 underline" onClick={gate.onRefresh}>重新读取</button>
    </div>
  );
  const priceLabel = publicRuntimePriceLabel(gate.quote);
  return (
    <p role="status" className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--accent)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]">
      <strong className="text-[var(--foreground)]">通道已配置</strong> · 计费：<strong className="text-[var(--foreground)]">{priceLabel}</strong>
    </p>
  );
}

function confirmLoadedRetry(draft: ExtractionRetryDraft | null, kind: 'video' | 'text' | 'batch' | 'search', gate: RuntimeGate) {
  if (!draft) return true;
  const matches = draft.input.requestKind === 'single'
    ? draft.input.mode === kind
    : draft.input.requestKind === kind;
  if (!matches) return true;
  const price = publicRuntimePriceLabel(gate.quote);
  return window.confirm(`确认按当前公开价格 ${price} 创建一个全新的请求？`);
}

interface CreatorBatchApiResponse {
  success?: boolean;
  error?: string;
  texts?: TextItem[];
  filtered_count?: number;
}

interface SearchApiText {
  success?: boolean;
  content?: string;
  url?: string;
  error?: string;
  caption?: string;
  text?: string;
  title?: string;
  desc?: string;
  nickname?: string;
  author?: string;
  digg_count?: number;
  likes?: number;
}

interface SearchBatchApiResponse {
  success?: boolean;
  error?: string;
  texts?: SearchApiText[];
  filtered_count?: number;
}

/* ── Platform Detection ── */
function detectPlatform(url: string): { name: string; icon: string; color: string } {
  const u = url.toLowerCase();
  if (u.includes("douyin.com") || u.includes("iesdouyin.com"))
    return { name: "抖音", icon: "🎵", color: "#000000" };
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com"))
    return { name: "小红书", icon: "📕", color: "#FE2C55" };
  if (u.includes("kuaishou.com") || u.includes("gifshow.com"))
    return { name: "快手", icon: "🎬", color: "#FF4906" };
  if (u.includes("bilibili.com") || u.includes("b23.tv"))
    return { name: "B站", icon: "📺", color: "#00A1D6" };
  if (u.includes("weibo.com") || u.includes("weibo.cn"))
    return { name: "微博", icon: "🔥", color: "#E6162D" };
  return { name: "其他", icon: "🔗", color: "#6B7280" };
}

// Inputs and temporary results belong only to the mounted editor.
const ExtractOwnerContext = createContext("");

/* ── Tabs Config ── */
const TABS = [
  { key: "text", label: "文案提取", icon: FileText },
  { key: "video", label: "视频提取", icon: Video },
  { key: "batch", label: "批量处理", icon: Package },
  { key: "history", label: "历史记录", icon: History },
] as const;

type TabKey = typeof TABS[number]["key"];

/* ══════════════════════════════════════════
   Main Page Component
   ══════════════════════════════════════════ */
export default function ExtractPage() {
  const { state } = useApp();
  const ownerUserId = resolveWorkbenchIdentity(state.auth)?.userId || "";
  useEffect(() => {
    try { clearRetiredPageDrafts('extract', ownerUserId, localStorage, sessionStorage); } catch {}
  }, [ownerUserId]);
  return <ExtractOwnerContext.Provider value={ownerUserId}><ExtractPageForAccount key={ownerUserId || "signed-out"} /></ExtractOwnerContext.Provider>;
}

function ExtractPageForAccount() {
  const ownerUserId = useContext(ExtractOwnerContext);
  const { state, dispatch, checkAuth } = useApp();
  const auth = state.auth;
  type RestoredAuth = { token: string; user: NonNullable<typeof auth.user> };
  const router = useRouter();
  const toolboxHost = useToolboxHost();
  const embedded = Boolean(toolboxHost);
  const authCheckRef = useRef<Promise<RestoredAuth | null> | null>(null);
  const [authGuardStatus, setAuthGuardStatus] = useState<"checking" | "checked" | "ready" | "denied" | "error">(
    auth.isAuthenticated && auth.user?.id && auth.token ? "ready" : "checking",
  );
  const [activeTab, setActiveTab] = useState<TabKey>("text");
  const [embeddedPanel, setEmbeddedPanel] = useState<"history" | "batch" | null>(null);
  const accountHistory = useExtractionHistory<ExtractResult>(auth.token || "", ownerUserId);
  const runtimeCatalog = useToolRuntimeCatalog(auth.token || "");
  const history = accountHistory.history;
  const [retryDraft, setRetryDraft] = useState<ExtractionRetryDraft | null>(null);


  useEffect(() => {
    if (embedded) {
      setEmbeddedPanel(null);
      return;
    }
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    if (requestedTab && TABS.some((tab) => tab.key === requestedTab)) {
      setActiveTab(requestedTab as TabKey);
    }
  }, [embedded, toolboxHost?.activeTab]);

  // Esc 快捷键返回首页（仅在非输入框时生效）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape" && !inInput && !embedded) router.push("/");
      // 阻止内嵌浏览器把删除键误判成后退导航
      if ((e.key === "Backspace" || e.key === "Delete") && !inInput) e.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [embedded, router]);

  const displayedTab: TabKey = embeddedPanel || (
    embedded && (toolboxHost?.activeTab === "text" || toolboxHost?.activeTab === "video")
      ? toolboxHost.activeTab
      : activeTab
  );

  const selectStandaloneTab = (tab: TabKey) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const refreshAccountHistory = accountHistory.refresh;
  const addHistory = useCallback(() => refreshAccountHistory(), [refreshAccountHistory]);
  const removeHistory = (id: string) => { void accountHistory.remove(id); };
  const clearHistory = () => { void accountHistory.remove(); };
  const loadHistoryInputForRetry = (item: ExtractResult) => {
    if (!item.canLoadForRetry || !item.retryInput || item.retryInput.requestKind === 'coze') return;
    const input = item.retryInput;
    const oldRequestId = item.clientRequestId || '';
    if (oldRequestId) {
      const keys = input.requestKind === 'single'
        ? [`extract:${ownerUserId}:${input.mode}`, `extract-tool:${ownerUserId}:${input.mode}`]
        : [`extract:${ownerUserId}:${input.requestKind === 'batch' ? 'creator' : 'search'}`];
      keys.forEach(key => clearBrowserClientAttempt(key, oldRequestId));
    }
    setRetryDraft({ nonce: Date.now(), input });
    if (input.requestKind === 'single') {
      setEmbeddedPanel(null);
      if (embedded) toolboxHost?.onTabChange?.(input.mode);
      else selectStandaloneTab(input.mode);
      return;
    }
    if (embedded) {
      toolboxHost?.onTabChange?.('text');
      setEmbeddedPanel('batch');
    } else {
      selectStandaloneTab('batch');
    }
  };

  // AppContext 会异步恢复登录态；token 存在但用户缓存缺失时，先向服务端校验再决定跳转。
  useEffect(() => {
    if (auth.isAuthenticated && auth.user?.id && auth.token) {
      setAuthGuardStatus("ready");
      return;
    }

    if (authGuardStatus !== "checking") return;
    if (!authCheckRef.current) {
      authCheckRef.current = (async () => {
        const storedToken = safeGetItem(STORAGE_KEYS.AUTH_TOKEN);
        if (!storedToken) return null;

        const response = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${storedToken}` },
        });
        if (response.status === 401 || response.status === 403) {
          safeRemoveItem(STORAGE_KEYS.AUTH_TOKEN);
          safeRemoveItem(STORAGE_KEYS.AUTH_USER);
          return null;
        }
        if (!response.ok) throw new Error(`Auth verification failed: ${response.status}`);

        const data = await response.json() as { user?: RestoredAuth["user"] };
        if (!data.user) throw new Error("Auth verification response is missing user data");
        return { token: storedToken, user: data.user };
      })();
    }

    let active = true;
    authCheckRef.current
      .then((restored) => {
        if (!active) return;
        if (!restored) {
          setAuthGuardStatus("checked");
          return;
        }

        safeSetItem(STORAGE_KEYS.AUTH_USER, JSON.stringify(restored.user));
        dispatch({ type: "SET_AUTH", payload: restored });
        setAuthGuardStatus("ready");
        // 恢复缓存后交回全局认证流程，同步主题与余额；不阻塞工具首屏。
        void checkAuth();
      })
      .catch(() => {
        if (active) {
          setAuthGuardStatus((current) => current === "checking" ? "error" : current);
        }
      });

    return () => {
      active = false;
    };
  }, [auth.isAuthenticated, auth.token, auth.user?.id, authGuardStatus, checkAuth, dispatch]);

  useEffect(() => {
    if (authGuardStatus !== "checked") return;
    if (auth.isAuthenticated && auth.user?.id && auth.token) {
      setAuthGuardStatus("ready");
      return;
    }

    setAuthGuardStatus("denied");
    if (!embedded) router.replace("/");
  }, [auth.isAuthenticated, auth.token, auth.user?.id, authGuardStatus, embedded, router]);

  const retryAuthCheck = () => {
    authCheckRef.current = null;
    setAuthGuardStatus("checking");
  };

  if (authGuardStatus !== "ready" || !ownerUserId) {
    const isError = authGuardStatus === "error";
    const isDenied = authGuardStatus === "denied";
    return (
      <div
        className={`secondary-workbench voice-studio-root vs-workbench grid place-items-center ${embedded ? "min-h-[340px]" : "min-h-screen"}`}
        role="status"
        aria-live="polite"
      >
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-sm text-muted-foreground">
          {isError || isDenied ? <AlertCircle className="h-6 w-6 text-destructive" /> : <Loader2 className="h-6 w-6 animate-spin" />}
          <p>{isError ? "登录状态校验失败，请重试。" : isDenied ? "文案与视频提取需要登录后使用。" : "正在恢复登录状态…"}</p>
          {isError && (
            <Button type="button" variant="outline" size="sm" onClick={retryAuthCheck}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              重新校验
            </Button>
          )}
          {isDenied && embedded && (
            <Button type="button" variant="outline" size="sm" onClick={() => router.push("/")}>
              返回首页登录
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`secondary-workbench voice-studio-root vs-workbench flex flex-col overflow-hidden ${embedded ? "toolbox-embedded-workspace h-full" : "h-screen"}`}>
      {!embedded && <SubPageHeader
        title="视频文案提取"
        subtitle="支持抖音/小红书/快手/B站 · 一键提取视频与文案"
        icon={<Video className="w-5 h-5" />}
        rightSlot={
          <div className="flex items-center gap-1.5">
            <NavButton icon={LayoutGrid} label="应用广场" onClick={() => dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" })} title="前往应用广场" />
          </div>
        }
      />}

      {embedded && (
        <div className="toolbox-embedded-toolbar">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-[var(--foreground)]">
              {embeddedPanel === "history" ? "提取历史" : embeddedPanel === "batch" ? "批量与搜索" : toolboxHost?.activeTab === "video" ? "视频链接提取" : "字幕与文案提取"}
            </p>
            <p className="mt-0.5 truncate text-[10px] text-[var(--muted-foreground)]">
              {embeddedPanel === "history" ? "查看、下载和管理提取记录" : embeddedPanel === "batch" ? "从链接列表、博主主页或关键词提取文案" : toolboxHost?.activeTab === "video" ? "解析原视频链接并下载" : "粘贴分享链接，提取口播正文"}
            </p>
          </div>
          {toolboxHost?.activeTab === "text" && (
            <Button type="button" variant="outline" size="sm" className="toolbox-toolbar-action"
              aria-pressed={embeddedPanel === "batch"}
              onClick={() => setEmbeddedPanel(current => current === "batch" ? null : "batch")}>
              {embeddedPanel === "batch" ? <X className="h-3.5 w-3.5" /> : <Package className="h-3.5 w-3.5" />}
              {embeddedPanel === "batch" ? "返回单条" : "批量与搜索"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="toolbox-toolbar-action"
            aria-pressed={embeddedPanel === "history"}
            onClick={() => setEmbeddedPanel((current) => current === "history" ? null : "history")}
          >
            {embeddedPanel === "history" ? <X className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
            {embeddedPanel === "history" ? "返回提取" : "历史记录"}
          </Button>
        </div>
      )}

      <main className={`flex-1 overflow-y-auto max-w-[1400px] mx-auto w-full ${embedded ? "toolbox-extract-main min-h-0 px-4 py-4" : "px-6 py-8"}`}>
        {/* Tab Navigation */}
        {!embedded && <div className="flex items-center gap-1 mb-6 p-1 rounded-xl" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => selectStandaloneTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex-1 justify-center ${
                  isActive
                    ? "text-[var(--primary-foreground)] shadow-md"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]"
                }`}
                style={isActive ? { background: "var(--primary)" } : undefined}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>}

        {/* 使用 display:none/block 代替条件渲染，保证 tab 切换时组件不卸载，进行中的任务不中断 */}
        <div className="toolbox-extract-panel-host" style={{ display: displayedTab === "video" ? "block" : "none" }}>
          <VideoExtractTab addHistory={addHistory} retryDraft={retryDraft} runtimeGate={{ quote: runtimeCatalog.items.video, loading: runtimeCatalog.loading, error: runtimeCatalog.error, onRefresh: runtimeCatalog.refresh }} />
        </div>
        <div className="toolbox-extract-panel-host" style={{ display: displayedTab === "text" ? "block" : "none" }}>
          <TextExtractTab addHistory={addHistory} retryDraft={retryDraft} runtimeGate={{ quote: runtimeCatalog.items.text, loading: runtimeCatalog.loading, error: runtimeCatalog.error, onRefresh: runtimeCatalog.refresh }} onOpenHistory={() => { accountHistory.refresh(); if (embedded) setEmbeddedPanel('history'); else selectStandaloneTab('history'); }} />
        </div>
        <div className="toolbox-extract-panel-host" style={{ display: displayedTab === "batch" ? "block" : "none" }}>
          <BatchExtractTab addHistory={addHistory} retryDraft={retryDraft} runtimeCatalog={runtimeCatalog} />
        </div>
        <div className="toolbox-extract-panel-host" style={{ display: displayedTab === "history" ? "block" : "none" }}>
          <HistoryTab history={history} onRemove={removeHistory} onClear={clearHistory} loading={accountHistory.loading} ready={accountHistory.ready} error={accountHistory.error} retryReady={accountHistory.retryReady} retryUnavailableReason={accountHistory.retryUnavailableReason} onLoadRetry={loadHistoryInputForRetry} onRefresh={accountHistory.refresh} hasMore={accountHistory.hasMore} onLoadMore={accountHistory.loadMore} />
        </div>
      </main>

      {!embedded && <BrandFooter />}
    </div>
  );
}

/* ══════════════════════════════════════════
   Shared API Call
   ══════════════════════════════════════════ */
type ExtractAttempt = BrowserClientAttempt & { storageKey: string };

type PendingExtractionReason = "timeout" | "user_stop" | "transport";

class PendingExtractionRequestError extends Error {
  readonly name = "PendingExtractionRequestError";
  constructor(
    message: string,
    readonly attempt: ExtractAttempt,
    readonly reason: PendingExtractionReason,
  ) {
    super(message);
  }
}

function extractionClientTimeoutMs(mode: string): number {
  // 文案工作流可能继续在服务端处理数分钟，但前台不能一直像“没反应”。
  // 30 秒后把原请求交给状态接口跟踪；服务端仍按同一幂等请求完成保存与结算。
  return mode === "video" ? 210_000 : 30_000;
}

async function callExtractAPI(
  token: string,
  userScope: string,
  links: string[],
  extractionMode: string,
  externalSignal?: AbortSignal,
  douyinShareText?: string,
  attemptScope?: string,
): Promise<ExtractAPIResponse> {
  const timeoutMs = extractionClientTimeoutMs(extractionMode);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let attempt: ExtractAttempt | null = null;
  let responseReceived = false;

  // 如果外部signal被abort，也终止内部controller
  let onExternalAbort: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("请求已终止", "AbortError");
    }
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener("abort", onExternalAbort);
  }

  try {
    const requestPayload = {
      links,
      extraction_mode: extractionMode,
      ...(douyinShareText ? { douyin_share_text: douyinShareText } : {}),
    };
    const normalizedAttemptScope = attemptScope
      ?.replace(/[^a-zA-Z0-9:_-]/g, "")
      .slice(0, 96);
    attempt = await createExtractAttempt({
      storageKey: `extract:${userScope}:${extractionMode}${normalizedAttemptScope ? `:${normalizedAttemptScope}` : ""}`,
      prefix: `extract-${extractionMode}`,
      payload: requestPayload,
    });
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Idempotency-Key": attempt.clientRequestId,
      },
      body: JSON.stringify({ ...requestPayload, client_request_id: attempt.clientRequestId }),
      signal: controller.signal,
    });
    responseReceived = true;

    let data: ExtractAPIResponse & {
      error?: string;
      attempt_id?: string;
      recovery_pending?: boolean;
      retry_safe?: boolean;
      upstream_completed?: boolean;
      billing_unknown?: boolean;
    };
    try {
      data = await readJsonResponse<typeof data>(res);
    } catch {
      if (attempt) {
        throw new PendingExtractionRequestError(
          `结果暂未确认（HTTP ${res.status}），正在按原请求编号查询处理状态`,
          attempt,
          "transport",
        );
      }
      throw new Error(`结果暂未确认（HTTP ${res.status}），请稍后刷新状态`);
    }

    if (!res.ok) {
      if (attempt && !isDefinitiveExtractionFailure(res.status, data)) {
        const message = data.recovery_pending === true || data.upstream_completed === true
          ? "结果已生成，正在按原请求编号完成保存与结算"
          : "结果暂未确认，正在按原请求编号查询处理状态";
        throw new PendingExtractionRequestError(
          `${message}${data.attempt_id ? `（请求号 ${data.attempt_id}）` : ""}`,
          attempt,
          "transport",
        );
      }
      clearAttemptAfterDefinitiveHttpFailure(attempt, res.status, data);
      throw new Error(`${data.error || "提取失败"}${data.attempt_id ? `（请求号 ${data.attempt_id}）` : ""}`);
    }

    clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
    return data as ExtractAPIResponse;
  } catch (error) {
    if (attempt && (controller.signal.aborted || !responseReceived)) {
      const reason: PendingExtractionReason = controller.signal.aborted
        ? (timedOut ? "timeout" : "user_stop")
        : "transport";
      const message = reason === "timeout"
        ? "等待超时，正在按原请求编号查询处理状态"
        : reason === "user_stop"
          ? "已停止等待，任务仍会按原请求编号继续处理"
          : "连接中断，正在按原请求编号查询处理状态";
      throw new PendingExtractionRequestError(message, attempt, reason);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function createExtractAttempt(input: {
  storageKey: string;
  prefix: string;
  payload: unknown;
}): Promise<ExtractAttempt> {
  const fingerprint = await buildClientRequestFingerprint(input.payload);
  return {
    storageKey: input.storageKey,
    ...resolveBrowserClientAttempt({
      storageKey: input.storageKey,
      fingerprint,
      prefix: input.prefix,
    }),
  };
}

async function readJsonResponse<T extends { error?: string }>(response: Response): Promise<T> {
  return readExtractionJsonResponse<T>(response);
}

function clearAttemptAfterDefinitiveHttpFailure(attempt: ExtractAttempt, status: number, responseBody?: unknown) {
  if (isDefinitiveExtractionFailure(status, responseBody)) {
    clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
  }
}

async function triggerExtractDownload(url: string, filename: string, token: string, assetId?: string) {
  return downloadExtractMedia({ token, url, assetId, filename });
}

function downloadTemporaryExtractVideo(temporaryUrl: string) {
  const link = document.createElement("a");
  link.href = `${temporaryUrl}${temporaryUrl.includes("?") ? "&" : "?"}mode=download`;
  link.download = "extracted-video.mp4";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ── Helper: check if response is from douyin.wtf ── */
function isDouyinWtfResult(data: ExtractAPIResponse): data is DouyinWtfResult {
  return "source" in data && data.source === "douyin_wtf";
}

/* ── Helper: auto-clean share text to extract URL only ── */
function autoCleanShareText(text: string): string {
  const trimmed = text.trim();

  // If it looks like a pure URL already, return as-is
  if (/^https?:\/\//.test(trimmed)) return trimmed;

  // Try to extract URL from share text patterns
  // Pattern: "4.64 复制打开抖音，看看... https://v.douyin.com/xxx/ :7pm S@Y.MW qrR:/ 12/04"
  const urlPatterns = [
    /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/,
    /https?:\/\/www\.douyin\.com\/video\/\d+/,
    /https?:\/\/www\.iesdouyin\.com\/share\/video\/\d+/,
    /https?:\/\/[a-zA-Z0-9.-]+\.(douyin|iesdouyin)\.(com|cn)\/[^\s]*/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmed.match(pattern);
    if (match) return match[0].replace(/\/$/, "");
  }

  // Try to extract a pure numeric video ID (15-22 digits)
  const idMatch = trimmed.match(/\b(\d{15,22})\b/);
  if (idMatch) return idMatch[1];

  return trimmed;
}

function videoShareInputs(value: string): string[] {
  const lines = value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  // A copied share often puts the title and the copy instructions on their own lines.
  const targets = lines.filter(line => /https?:\/\/\S+/iu.test(line) || /^\d{15,22}$/u.test(line));
  return (targets.length ? targets : lines).map(autoCleanShareText).filter(Boolean);
}

/* ── Helper: format number ── */
function formatNum(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* ══════════════════════════════════════════
   Video Extract Tab
   ══════════════════════════════════════════ */
function VideoExtractTab({ addHistory, retryDraft, runtimeGate }: { addHistory: (item?: ExtractResult) => void; retryDraft: ExtractionRetryDraft | null; runtimeGate: RuntimeGate }) {
  const { state } = useApp();
  const embedded = Boolean(useToolboxHost());
  const auth = state.auth;
  const abortRef = useRef<AbortController | null>(null);
  const stoppedByUserRef = useRef(false);
  const extractInFlightRef = useRef(false);
  const videoInputRef = useRef<HTMLTextAreaElement>(null);
  const [urls, setUrls] = useState("");
  const [loading, setLoading] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [results, setResults] = useState<ExtractResult[]>([]);

  useEffect(() => {
    if (retryDraft?.input.requestKind !== 'single' || retryDraft.input.mode !== 'video') return;
    setUrls(retryDraft.input.links.join('\n'));
    setResults([]);
    setClipboardNotice('已载入失败记录的原链接；旧请求号已清除。请核对价格后点击“开始提取”创建新任务。');
    requestAnimationFrame(() => videoInputRef.current?.focus());
  }, [retryDraft]);

  useEffect(() => {
    const textarea = videoInputRef.current;
    if (!textarea) return;
    if (embedded) {
      textarea.style.removeProperty("height");
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(144, Math.max(96, textarea.scrollHeight))}px`;
  }, [embedded, urls]);

  const handleExtract = async () => {
    if (extractInFlightRef.current) return;
    if (runtimeGate.loading || runtimeGate.error || !runtimeGate.quote?.available) return;
    const linkList = videoShareInputs(urls);
    if (linkList.length === 0) return;
    if (!confirmLoadedRetry(retryDraft, 'video', runtimeGate)) return;

    extractInFlightRef.current = true;
    // 创建新的 AbortController
    stoppedByUserRef.current = false;
    abortRef.current = new AbortController();
    setLoading(true);
    const newResults: ExtractResult[] = linkList.map((url, i) => ({
      id: `v-${Date.now()}-${i}`,
      url,
      platform: detectPlatform(url).name,
      mode: "video",
      timestamp: Date.now(),
      status: "loading" as const,
    }));
    setResults(prev => [...newResults, ...prev]);

    try {
      // Submit every URL as its own durable attempt. This keeps supplier,
      // settlement and recovery state isolated while the UI still supports a
      // convenient multi-line queue.
      for (let i = 0; i < linkList.length; i++) {
        const current = newResults[i];
        const platform = detectPlatform(linkList[i]);
        try {
          const itemAttemptScope = await buildClientRequestFingerprint({
            kind: "video-item",
            url: linkList[i],
          });
          const output = await callExtractAPI(
            auth.token || "",
            auth.user?.id || "anonymous",
            [linkList[i]],
            "video",
            abortRef.current.signal,
            undefined,
            `item:${itemAttemptScope}`,
          );

          let updated: ExtractResult;
          if (isDouyinWtfResult(output)) {
            const apiResult = output.results?.[0];
            if (apiResult?.success && apiResult.video) {
              const v = apiResult.video;
              updated = {
                ...current,
                status: "success",
                platform: "抖音",
                result: {
                  success: true,
                  message: output.message,
                  videos: [{
                    row: 1, col: 1, platform: "抖音", success: true,
                    url: v.videoUrl,
                    download_url: v.downloadUrl || v.videoUrl,
                    title: v.desc || "抖音视频",
                    cover: v.coverUrl,
                  }],
                  texts: [],
                  summary: `${v.author} · ${formatNum(v.stats?.playCount || 0)}播放`,
                },
              };
            } else {
              updated = {
                ...current,
                status: "error",
                platform: platform.name,
                error: apiResult?.error || output.message || "提取失败",
                result: normalizeResponse(output),
              };
            }
          } else {
            const normalized = normalizeResponse(output);
            const videoItem = normalized.videos?.[0];
            const textItem = normalized.texts?.[0];
            const hasVideo = isDeliverableExtractVideo(videoItem);
            const hasText = textItem && textItem.success !== false && textItem.content;
            updated = hasVideo
              ? {
                ...current,
                status: "success",
                platform: videoItem?.platform || textItem?.platform || platform.name,
                result: {
                  ...normalized,
                  summary: normalized.summary || (hasText ? "文案与视频均已提取" : "视频提取成功"),
                },
              }
              : {
                ...current,
                status: "error",
                platform: videoItem?.platform || textItem?.platform || platform.name,
                error: videoItem?.error || textItem?.error || normalized.message || "视频提取失败",
                result: normalized,
              };
          }
          setResults(prev => prev.map(result => result.id === current.id ? updated : result));
          addHistory(updated);
        } catch (err) {
          const pending = err instanceof PendingExtractionRequestError;
          const aborted = err instanceof DOMException && err.name === "AbortError";
          const clientRequestId = pending ? err.attempt.clientRequestId : undefined;
          const errorMessage = pending
            ? err.message
            : aborted
              ? stoppedByUserRef.current
                ? "已停止等待，当前任务仍会在历史中继续处理"
                : "等待超时，当前任务状态请在历史中查看"
              : err instanceof Error ? err.message : "网络请求失败";
          const updated: ExtractResult = {
            ...current,
            status: "error",
            error: errorMessage,
            pending: Boolean(clientRequestId),
            attemptState: clientRequestId ? "running" : undefined,
            clientRequestId,
          };
          setResults(prev => prev.map(result => result.id === current.id ? updated : result));
          addHistory(updated);

          if (pending || aborted) {
            for (const queued of newResults.slice(i + 1)) {
              const skipped: ExtractResult = {
                ...queued,
                status: "error",
                error: "前一项仍在处理，当前链接尚未提交；可稍后重新开始",
              };
              setResults(prev => prev.map(result => result.id === queued.id ? skipped : result));
              addHistory(skipped);
            }
            break;
          }
        }
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
      stoppedByUserRef.current = false;
      extractInFlightRef.current = false;
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardNotice("剪贴板里没有可用的分享文本或链接");
        return;
      }
      setUrls(text.trim());
      setResults([]);
      setClipboardNotice("已粘贴，可直接开始提取");
      requestAnimationFrame(() => videoInputRef.current?.focus());
    } catch {
      setClipboardNotice("无法读取剪贴板，请允许剪贴板权限或手动粘贴");
    }
  };

  const handleClear = () => {
    setUrls("");
    setResults([]);
    setClipboardNotice(null);
    requestAnimationFrame(() => videoInputRef.current?.focus());
  };

  return (
    <div className={embedded ? "toolbox-two-column toolbox-extract-layout toolbox-video-layout" : "space-y-5"}>
      <div className={embedded ? "toolbox-primary-pane" : "contents"}>
      {/* Input Section */}
      <div
        className={`toolbox-input-surface toolbox-extract-card toolbox-video-input-card rounded-xl ${embedded ? "p-4 flex flex-col" : "p-5"}`}
        style={{
          background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)",
          border: `1px solid ${embedded ? "var(--toolbox-crystal-line)" : "var(--border)"}`,
          boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : undefined,
        }}
      >
        <div className="toolbox-extract-heading">
          <h3 className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
            <Video className="w-4 h-4 text-[var(--primary)]" />
            输入分享文本或视频链接
          </h3>
          <div className="toolbox-heading-actions">
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              disabled={loading || (!urls && results.length === 0)}
              className="toolbox-clear-button"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              清空
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handlePaste}
              disabled={loading}
              className="toolbox-extract-paste-button h-9 shrink-0 px-3 text-xs"
              title="从剪贴板粘贴分享文本或视频链接"
            >
              <ClipboardPaste className="mr-1.5 h-4 w-4" />
              一键粘贴
            </Button>
          </div>
        </div>
        {embedded && (
          <div className="toolbox-inline-options toolbox-operation-options" aria-label="视频提取支持平台">
            <span className="toolbox-toolbar-label">支持平台</span>
            <span className="toolbox-platform-summary">抖音 · 小红书 · 快手 · B站 · 微博</span>
            <span className="toolbox-toolbar-note">支持完整分享文本，自动识别链接</span>
          </div>
        )}
        <RuntimeQuoteCard gate={runtimeGate} />

        <Textarea
          ref={videoInputRef}
          value={urls}
          onChange={e => {
            setUrls(e.target.value);
            setResults([]);
            setClipboardNotice(null);
          }}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleExtract();
          }}
          aria-label="视频分享文本或链接"
          aria-describedby={clipboardNotice ? "video-clipboard-notice" : undefined}
          placeholder={"粘贴完整分享文本或视频链接\n支持抖音 / 小红书 / 快手 / B站 / 微博\n例如：https://v.douyin.com/xxx/"}
          className={`toolbox-extract-textarea toolbox-video-textarea min-h-[96px] max-h-[144px] resize-none overflow-y-auto text-sm ${embedded ? "toolbox-field" : ""}`}
          style={{ background: embedded ? "var(--toolbox-crystal-field)" : "var(--background)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)", color: "var(--foreground)" }}
        />

        {clipboardNotice && (
          <p id="video-clipboard-notice" className="mt-2 text-xs text-[var(--muted-foreground)]" role="status" aria-live="polite">
            {clipboardNotice}
          </p>
        )}

        {/* Platform hints */}
        {!embedded && <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-[11px] text-[var(--muted-foreground)]">支持平台：</span>
          {[
            { name: "抖音", icon: "🎵" },
            { name: "小红书", icon: "📕" },
            { name: "快手", icon: "🎬" },
            { name: "B站", icon: "📺" },
            { name: "微博", icon: "🔥" },
          ].map(p => (
            <span key={p.name} className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
              {p.icon} {p.name}
            </span>
          ))}
        </div>}

        <div className={`toolbox-primary-actions toolbox-card-actions toolbox-command-row ${loading ? "toolbox-command-row-two" : "toolbox-command-row-one"} w-full flex gap-2 mt-3`}>

          <Button
            onClick={handleExtract}
            disabled={loading || !urls.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
            className="flex-1 h-10 font-medium"
            style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 提取中...</>
            ) : (
              <><Video className="w-4 h-4 mr-2" /> 开始提取</>
            )}
          </Button>
          {loading && (
            <Button
              variant="outline"
              onClick={() => { stoppedByUserRef.current = true; abortRef.current?.abort(); }}
              className="h-10 px-4 text-[var(--error)] border-red-300 hover:bg-red-50 hover:text-[var(--error)]"
            >
              <XCircle className="w-4 h-4 mr-1" /> 停止等待
            </Button>
          )}
        </div>
      </div>
      </div>

      {/* Results Section */}
      <div className={embedded ? "toolbox-result-pane" : "contents"} aria-busy={loading}>
      {results.length > 0 && (
        <div className="toolbox-results-block toolbox-video-results h-full rounded-lg border border-[var(--border)]">
          <h3 className="toolbox-video-results-heading text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--primary)]" />
            <span>提取结果</span>
            <small>{results.length} 条</small>
          </h3>
          <div className="toolbox-video-grid">
            {results.map(item => (
              <VideoResultCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
      {embedded && results.length === 0 && (
        <div className="toolbox-results-block toolbox-video-results toolbox-video-empty rounded-lg border border-[var(--border)]">
          <h3 className="toolbox-video-results-heading text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--primary)]" />
            <span>提取结果</span>
          </h3>
          <div className="toolbox-video-empty-body">
            <Download className="mx-auto mb-2 h-5 w-5 text-[var(--muted-foreground)]" />
            <p>粘贴视频链接并开始提取，结果将在这里集中显示。</p>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   Text Extract Tab
   ══════════════════════════════════════════ */
function TextExtractTab({ addHistory, retryDraft, runtimeGate, onOpenHistory }: { addHistory: (item?: ExtractResult) => void; retryDraft: ExtractionRetryDraft | null; runtimeGate: RuntimeGate; onOpenHistory: () => void }) {
  const ownerUserId = useContext(ExtractOwnerContext);
  const { state } = useApp();
  const router = useRouter();
  const toolboxHost = useToolboxHost();
  const embedded = Boolean(toolboxHost);
  const auth = state.auth;
  const abortRef = useRef<AbortController | null>(null);
  const stoppedByUserRef = useRef(false);
  const extractInFlightRef = useRef(false);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [corrections, setCorrections] = useState({ homophones: true, typos: true, punctuation: true, completeness: false });
  const [showOriginal, setShowOriginal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const pendingAttempt = useExtractionAttemptStatus({
    message: result?.pending ? result.error : "",
    clientRequestId: result?.pending ? result.clientRequestId : undefined,
    token: auth.token || "",
    userId: auth.user?.id || "",
    mode: "text",
  });
  const settledPendingAttemptRef = useRef("");

  useEffect(() => {
    if (retryDraft?.input.requestKind !== 'single' || retryDraft.input.mode !== 'text') return;
    setUrl(retryDraft.input.douyinShareText || retryDraft.input.links.join('\n'));
    setResult(null);
    setClipboardNotice('已载入失败记录的原输入；旧请求号已清除。请核对价格后点击“提取文案”创建新任务。');
    requestAnimationFrame(() => textInputRef.current?.focus());
  }, [retryDraft]);

  useEffect(() => {
    const attempt = pendingAttempt.data;
    if (!result?.pending || !result.clientRequestId || !attempt) return;
    if (attempt.clientRequestId !== result.clientRequestId || !["succeeded", "failed"].includes(attempt.state)) return;
    const settlementKey = `${attempt.clientRequestId}:${attempt.state}:${attempt.checkedAt}`;
    if (settledPendingAttemptRef.current === settlementKey) return;
    settledPendingAttemptRef.current = settlementKey;

    const response = attempt.response && typeof attempt.response === "object" && !Array.isArray(attempt.response)
      ? attempt.response as ExtractAPIResponse & { error?: string; message?: string }
      : null;
    if (attempt.state === "succeeded" && response) {
      const normalized = normalizeResponse(response);
      const textItem = normalized.texts?.[0];
      const content = textItem?.corrected_content || textItem?.content || "";
      const succeeded = normalized.success !== false && textItem?.success !== false && Boolean(content.trim());
      const next: ExtractResult = {
        ...result,
        status: succeeded ? "success" : "error",
        pending: false,
        attemptState: "succeeded",
        result: normalized,
        error: succeeded ? undefined : (textItem?.error || normalized.message || "任务已完成，但没有返回可用文案"),
      };
      setResult(next);
      addHistory(next);
      return;
    }

    const next: ExtractResult = {
      ...result,
      status: "error",
      pending: false,
      attemptState: "failed",
      error: response?.error || response?.message || "原提取任务已结束，但没有返回可用文案",
    };
    setResult(next);
    addHistory(next);
  }, [addHistory, pendingAttempt.data, result]);

  useEffect(() => {
    const textarea = textInputRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(144, Math.max(88, textarea.scrollHeight))}px`;
  }, [url]);

  const handleExtract = async () => {
    if (extractInFlightRef.current) return;
    if (runtimeGate.loading || runtimeGate.error || !runtimeGate.quote?.available) return;
    // 文案提取：保留完整分享文本，传给后端工作流（工作流内部解析链接+提取文案）
    const trimmedText = url.trim();
    if (!trimmedText) return;
    if (!confirmLoadedRetry(retryDraft, 'text', runtimeGate)) return;
    if (result?.pending) return;
    extractInFlightRef.current = true;
    stoppedByUserRef.current = false;
    abortRef.current = new AbortController();
    setLoading(true);
    setResult(null);

    try {
      // 文案提取模式：把完整分享文本传给后端，后端优先走Coze工作流
      const output = await callExtractAPI(auth.token || "", auth.user?.id || "anonymous", [trimmedText], "text", abortRef.current?.signal, trimmedText);
      const platform = detectPlatform(trimmedText);

      // Handle douyin.wtf response format
      if (isDouyinWtfResult(output)) {
        const apiResult = output.results?.[0];
        if (apiResult?.success && apiResult.video) {
          const v = apiResult.video;
          const transcript = apiResult.transcript;
          const resultItem: ExtractResult = {
            id: `t-${Date.now()}`,
            url: trimmedText,
            platform: "抖音",
            mode: "text",
            timestamp: Date.now(),
            status: "success",
            result: {
              success: true,
              message: output.message,
              videos: [{
                row: 1, col: 1, platform: "抖音", success: true,
                url: v.videoUrl,
                download_url: v.downloadUrl || v.videoUrl,
                title: v.desc || "抖音视频",
                cover: v.coverUrl,
              }],
              texts: [{
                row: 1, col: 1, platform: "抖音", success: true,
                content: transcript || "",
                title: transcript ? "视频口播文案" : "口播文案提取失败",
              }],
              summary: transcript
                ? `${v.author} · 口播文案已提取`
                : `${v.author} · 口播文案提取失败`,
            },
          };
          setResult(resultItem);
          addHistory(resultItem);
        } else {
          const resultItem: ExtractResult = {
            id: `t-${Date.now()}`,
            url: url.trim(),
            platform: platform.name,
            mode: "text",
            timestamp: Date.now(),
            status: "error",
            error: apiResult?.error || output.message || "文案提取失败",
            result: normalizeResponse(output),
          };
          setResult(resultItem);
          addHistory(resultItem);
        }
      } else {
        // Original workflow response format
        const norm = normalizeResponse(output);
        const textItem = norm.texts?.[0];

        const resultItem: ExtractResult = {
          id: `t-${Date.now()}`,
          url: url.trim(),
          platform: textItem?.platform || platform.name,
          mode: "text",
          timestamp: Date.now(),
          status: norm.success !== false && textItem?.success !== false ? "success" : "error",
          result: norm,
          error: norm.success === false ? (norm.message || textItem?.error) : textItem?.error,
        };
        setResult(resultItem);
        addHistory(resultItem);
      }
    } catch (err) {
      if (err instanceof PendingExtractionRequestError || (err instanceof DOMException && err.name === "AbortError")) {
        const clientRequestId = err instanceof PendingExtractionRequestError ? err.attempt.clientRequestId : undefined;
        const stoppedMessage = err instanceof PendingExtractionRequestError
          ? err.message
          : stoppedByUserRef.current
            ? "已停止等待，任务仍会在历史中继续处理"
            : "等待超时，任务状态请在历史中查看";
        const pendingResult: ExtractResult = {
          id: `t-${Date.now()}`,
          url: url.trim(),
          platform: detectPlatform(url).name,
          mode: "text",
          timestamp: Date.now(),
          status: "error",
          error: stoppedMessage,
          pending: Boolean(clientRequestId),
          attemptState: clientRequestId ? "running" : undefined,
          clientRequestId,
        };
        setResult(pendingResult);
        addHistory(pendingResult);
      } else {
        const errorMsg = err instanceof Error ? err.message : "网络请求失败";
        setResult({
          id: `t-${Date.now()}`,
          url: url.trim(),
          platform: detectPlatform(url).name,
          mode: "text",
          timestamp: Date.now(),
          status: "error",
          error: errorMsg,
        });
        addHistory();
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
      stoppedByUserRef.current = false;
      extractInFlightRef.current = false;
    }
  };

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePasteText = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setClipboardNotice("剪贴板里没有可用的分享文本或链接");
        return;
      }
      setUrl(text.trim());
      setResult(null);
      setClipboardNotice("已粘贴，可直接开始提取");
      requestAnimationFrame(() => textInputRef.current?.focus());
    } catch {
      setClipboardNotice("无法读取剪贴板，请允许剪贴板权限或手动粘贴");
    }
  };

  const handleClearText = () => {
    setUrl("");
    setResult(null);
    setClipboardNotice(null);
    requestAnimationFrame(() => textInputRef.current?.focus());
  };

  // Extract text content from workflow output
  // 返回: original(原始文案), corrected(纠正后文案), title(视频标题), isTranscript(是否语音转文字), isTitleOnly(是否仅标题无口播), debugFields(调试字段), channel(提取渠道), channelLabel(渠道显示名)
  const getTextContent = (item: ExtractResult | null): {
    original: string; corrected: string; title: string; isTranscript: boolean; isTitleOnly: boolean; debugFields: string[]; channel: string; channelLabel: string; isPpt6Format: boolean;
  } => {
    if (!item?.result) return { original: "", corrected: "", title: "", isTranscript: false, isTitleOnly: false, debugFields: [], channel: "", channelLabel: "", isPpt6Format: false };
    const textItem = item.result.texts?.[0];
    const debugFields = (textItem as { debug_fields?: string[] })?.debug_fields || item.result.debug_fields || [];
    if (!textItem) {
      return { original: item.result.summary || "", corrected: "", title: "", isTranscript: false, isTitleOnly: false, debugFields, channel: "", channelLabel: "", isPpt6Format: false };
    }
    const content = textItem.content || "";
    const title = textItem.title || "";
    const source = textItem.source || "";
    // PPT6 第三方差价渠道：PPT6获取视频URL → ASR转写口播文案
    const isPpt6ThirdParty = source === "ppt6_third_party";
    // source === "title_only" 表示工作流只返回了标题，没有口播内容
    const isTitleOnly = source === "title_only";
    // 判断是否为语音转文字结果（asr/llm 来源）
    const isTranscript = source === "asr_llm" || source === "asr" || source === "llm";
    const channel = isPpt6ThirdParty ? "ppt6" : (isTranscript ? "asr_llm" : "workflow");
    // 渠道标签：PPT6+ASR 优先显示口播转写
    const channelLabel = isTranscript ? "语音转文字" : (isTitleOnly ? "仅标题" : "口播文案");
    // PPT6 格式：desc\n title，需要拆分展示
    const isPpt6Format = isPpt6ThirdParty && content.includes("\n");
    return {
      original: content,
      corrected: textItem.corrected_content || content,
      title,
      isTranscript,
      isTitleOnly,
      debugFields,
      channel,
      channelLabel,
      isPpt6Format,
    };
  };

  const { original, corrected, isTranscript, channelLabel, isPpt6Format } = getTextContent(result);
  const displayText = corrected || original;
  const pendingState = result?.pending ? (pendingAttempt.data?.state || result.attemptState || "running") : "";
  const pendingTitle = pendingAttempt.trackingState === 'unavailable'
    ? '原请求需要重新验证登录'
    : pendingAttempt.trackingState === 'retrying'
      ? '状态查询暂时中断，正在重试'
      : pendingState === 'failed_unknown'
        ? '原请求结果待核对'
        : '正在跟踪原请求状态';
  const pendingMessage = pendingAttempt.trackingState === 'unavailable'
    ? '原请求已保留。请重新登录后刷新状态，不要再次提交。'
    : pendingAttempt.trackingState === 'retrying'
      ? '暂时无法读到最新状态，页面会自动重试；原请求的结果和费用尚未确认，请勿重复提交。'
      : pendingState === 'failed_unknown'
        ? '上游结果或费用仍待核对，页面会继续查询结案状态，请勿重复提交。'
        : '页面正在查询已提交的原请求，取得终态后会回填结果。切回本页会立即刷新，也可打开提取历史查看。';
  const handleSendToSegment = () => {
    try {
      prepareExtractSegmentDraft(displayText, ownerUserId);
      if (embedded) toolboxHost?.onTabChange?.("segment");
      else router.push("/segmenter");
    } catch {
      setClipboardNotice("分段草稿保存失败，请复制文案后粘贴到分段工具。");
    }
  };

  return (
    <div className={embedded ? "toolbox-two-column toolbox-extract-layout" : "space-y-5"}>
      <div className={embedded ? "toolbox-primary-pane" : "contents"}>
      {/* Input Section */}
      <div
        className={`toolbox-input-surface toolbox-extract-card rounded-xl ${embedded ? "p-4 flex flex-col" : "p-5"}`}
        style={{
          background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)",
          border: `1px solid ${embedded ? "var(--toolbox-crystal-line)" : "var(--border)"}`,
          boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : undefined,
        }}
      >
        <div className="toolbox-extract-heading">
          <h3 className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--primary)]" />
            输入分享文本或链接
          </h3>
          <div className="toolbox-heading-actions">
            <Button
              type="button"
              variant="outline"
              onClick={handleClearText}
              disabled={loading || (!url && !result)}
              className="toolbox-clear-button"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              清空
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handlePasteText}
              disabled={loading}
              className="toolbox-extract-paste-button h-9 shrink-0 px-3 text-xs"
              title="从剪贴板粘贴分享文本或链接"
            >
              <ClipboardPaste className="mr-1.5 h-4 w-4" />
              一键粘贴
            </Button>
          </div>
        </div>
        {embedded && (
          <div className="toolbox-inline-options toolbox-operation-options" aria-label="文案纠正规则">
            <span className="toolbox-toolbar-label">纠正规则</span>
            {([
              { key: "homophones", label: "谐音字" },
              { key: "typos", label: "错别字" },
              { key: "punctuation", label: "标点" },
              { key: "completeness", label: "完整性" },
            ] as const).map((option) => (
              <label key={option.key} className="toolbox-check-chip" data-active={corrections[option.key] ? "true" : "false"}>
                <Checkbox
                  checked={corrections[option.key]}
                  onCheckedChange={(value) => setCorrections((previous) => ({ ...previous, [option.key]: Boolean(value) }))}
                  className="h-3.5 w-3.5 data-[state=checked]:bg-[var(--primary)] data-[state=checked]:border-[var(--primary)]"
                />
                {option.label}
              </label>
            ))}
          </div>
        )}
        <RuntimeQuoteCard gate={runtimeGate} />

        <Textarea
          ref={textInputRef}
          value={url}
          onChange={e => { setUrl(e.target.value); setClipboardNotice(null); }}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") handleExtract();
          }}
          aria-label="文案分享文本或链接"
          aria-describedby={clipboardNotice ? "text-clipboard-notice" : undefined}
          placeholder={"粘贴完整分享文本或链接\n也可直接输入纯链接，例如：https://v.douyin.com/xxx/"}
          className={`toolbox-extract-textarea min-h-[88px] max-h-[144px] resize-none overflow-y-auto text-sm ${embedded ? "toolbox-field" : ""}`}
          style={{ background: embedded ? "var(--toolbox-crystal-field)" : "var(--background)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)", color: "var(--foreground)" }}
        />

        {clipboardNotice && (
          <p id="text-clipboard-notice" className="mt-2 text-xs text-[var(--muted-foreground)]" role="status" aria-live="polite">
            {clipboardNotice}
          </p>
        )}

        <div className="toolbox-card-actions toolbox-command-row toolbox-command-row-one flex items-center gap-2 mt-3">

          <Button
            type="button"
            onClick={handleExtract}
            disabled={loading || Boolean(result?.pending) || !url.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
            className="h-10 flex-1 font-medium"
            style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            {loading ? "正在提取" : "提取文案"}
          </Button>
        </div>

        {/* Correction Options */}
        {!embedded && <div className="mt-4 space-y-2">
          <span className="text-[12px] font-medium text-[var(--muted-foreground)]">文案纠正选项</span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: "homophones", label: "谐音字纠正" },
              { key: "typos", label: "错别字纠正" },
              { key: "punctuation", label: "标点符号规范" },
              { key: "completeness", label: "语句完整性补全" },
            ] as const).map(opt => (
              <label
                key={opt.key}
                className="flex items-center gap-2 text-[12px] cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--accent)] transition-colors"
                style={{ color: "var(--foreground)" }}
              >
                <Checkbox
                  checked={corrections[opt.key]}
                  onCheckedChange={v => setCorrections(prev => ({ ...prev, [opt.key]: !!v }))}
                  className="data-[state=checked]:bg-[var(--primary)] data-[state=checked]:border-[var(--primary)]"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>}
      </div>
      </div>

      {/* Result Section */}
      <div className={embedded ? "toolbox-result-pane toolbox-text-result-pane" : "contents"} aria-busy={loading}>
      {embedded && (
        <div className="toolbox-result-pane-heading">
          <FileText className="h-4 w-4" aria-hidden="true" />
          <span>文案结果</span>
        </div>
      )}
      {loading && (
        <div
          className="toolbox-results-block toolbox-state-surface h-full rounded-xl border p-5 flex flex-col items-center justify-center py-12 gap-3"
          style={{ background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
        >
          <Loader2 className="w-6 h-6 animate-spin text-[var(--primary)]" />
          <span className="text-sm text-[var(--muted-foreground)]">正在提交并等待首个结果...</span>
          <span className="text-[11px] text-[var(--muted-foreground)] opacity-70">超过 30 秒会按原请求编号查询状态，不会重新提交提取</span>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 text-[var(--error)] border-red-300 hover:bg-red-50 dark:hover:bg-red-950"
            onClick={() => { stoppedByUserRef.current = true; abortRef.current?.abort(); }}
            title="结束前台等待，按原请求编号查询结果，不会重新提交"
          >
            <XCircle className="w-4 h-4 mr-1" /> 转为状态跟踪
          </Button>
        </div>
      )}

      {result?.status === "error" && result.pending && (
        <div
          className="toolbox-results-block toolbox-state-surface h-full rounded-xl border p-5"
          style={{ background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
          role="status"
          aria-live="polite"
          data-extraction-pending-state={pendingState}
          data-extraction-tracking-state={pendingAttempt.trackingState}
        >
          <div className="flex items-start gap-3 py-2 text-[var(--primary)]">
            {pendingAttempt.refreshing ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" /> : <Clock3 className="mt-0.5 h-5 w-5 shrink-0" />}
            <div className="space-y-1">
              <strong className="block text-sm">{pendingTitle}</strong>
              <p className="text-xs leading-5 text-[var(--muted-foreground)]">{pendingMessage}</p>
              {result.clientRequestId && <p className="break-all text-[11px] text-[var(--muted-foreground)]">原请求编号：{result.clientRequestId}</p>}
              {pendingAttempt.data?.billingMessage && <p className="text-xs text-[var(--muted-foreground)]">{pendingAttempt.data.billingMessage}</p>}
              {pendingAttempt.error && <p className="text-xs text-[var(--error)]">{pendingAttempt.error}</p>}
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={pendingAttempt.refresh} disabled={pendingAttempt.refreshing}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${pendingAttempt.refreshing ? "animate-spin" : ""}`} />
            刷新原请求状态
          </Button>
          <Button type="button" variant="outline" size="sm" className="ml-2 mt-3" onClick={onOpenHistory}>
            <History className="mr-1.5 h-4 w-4" /> 查看提取历史
          </Button>
        </div>
      )}

      {result?.status === "error" && !result.pending && (
        <div
          className="toolbox-results-block toolbox-state-surface h-full rounded-xl border p-5"
          style={{ background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
        >
          <div className="flex items-center gap-2 py-2 text-[var(--error)]">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm">{readableExtractionError(result.error || "提取失败，请检查链接是否有效", "text")}</span>
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={handleExtract} disabled={!url.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            重新提取
          </Button>
        </div>
      )}

      {result?.status === "success" && !displayText && (
        <div
          className="toolbox-results-block toolbox-state-surface h-full rounded-xl border p-5"
          style={{ background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
        >
          <div className="flex items-center gap-2 py-2 text-[var(--warning)]">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm">视频信息已获取，但口播文案提取失败（语音识别和视频理解均未成功）。该视频可能无语音内容或音频质量较差。</span>
          </div>
        </div>
      )}

      {result?.status === "success" && displayText && (
        <div
          className="toolbox-results-block toolbox-state-surface h-full overflow-y-auto rounded-xl border p-5"
          style={{ background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)", borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
        >
          {/* Result header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)", color: "var(--primary)" }}>
                {detectPlatform(result.url).icon} {result.platform}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: isTranscript ? "color-mix(in srgb, var(--success) 12%, transparent)" : "var(--accent)", color: isTranscript ? "var(--success)" : "var(--muted-foreground)" }}>
                {channelLabel}
              </span>
              <span className="text-xs text-[var(--muted-foreground)]">
                {new Date(result.timestamp).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="sm" onClick={handleSendToSegment} className="h-8 px-2.5 text-xs">
                <Zap className="mr-1 h-3.5 w-3.5" />
                送去分段
              </Button>
              {original && corrected && original !== corrected && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowOriginal(!showOriginal)}
                  className="h-8 px-2.5 text-xs"
                >
                  {showOriginal ? <ChevronUp className="w-3.5 h-3.5 mr-1" /> : <ChevronDown className="w-3.5 h-3.5 mr-1" />}
                  {showOriginal ? "隐藏原文" : "查看原文"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExtract}
                disabled={loading || !url.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
                className="h-8 px-2.5 text-xs"
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                重新提取
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy(displayText)}
                className="h-8 px-2.5 text-xs"
              >
                {copied ? <Check className="w-3.5 h-3.5 mr-1 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                {copied ? "已复制" : "复制"}
              </Button>
            </div>
          </div>

          {/* Original text (collapsible) */}
          {showOriginal && original && (
            <div className="mb-3 p-3 rounded-lg text-sm leading-[1.75] border" style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--muted-foreground)" }}>
              <span className="text-xs font-semibold tracking-wide text-[var(--muted-foreground)] mb-1 block">原文</span>
              <span className="whitespace-pre-wrap">{original}</span>
            </div>
          )}

          {/* 口播文案主体 - 只展示纯口播逐字稿，不展示标题/解说 */}

          {/* Corrected / main text */}
          {isPpt6Format ? (
            /* PPT6 渠道：分区域展示标题和描述 */
            <div className="space-y-2">
              {displayText.split("\n").map((line, idx) => (
                <div key={idx} className="p-3 rounded-lg" style={{ background: "var(--background)" }}>
                  {idx === 0 && line ? (
                    <>
                      <span className="text-xs font-semibold tracking-wide text-[var(--muted-foreground)] mb-1 block">标题</span>
                      <span className="text-base font-medium leading-[1.75] text-[var(--foreground)]">{line}</span>
                    </>
                  ) : line ? (
                    <>
                      <span className="text-xs font-semibold tracking-wide text-[var(--muted-foreground)] mb-1 block">描述文案</span>
                      <span className="text-base leading-[1.75] text-[var(--foreground)] whitespace-pre-wrap">{line}</span>
                    </>
                  ) : null}
                </div>
              ))}

            </div>
          ) : (
            <div className="p-3 rounded-lg text-base leading-[1.75] whitespace-pre-wrap" style={{ background: "var(--background)", color: "var(--foreground)" }}>
              {displayText}
            </div>
          )}


        </div>
      )}
      {embedded && !loading && !result && (
        <div className="toolbox-empty-result">
          <div>
            <FileText className="mx-auto mb-2 h-5 w-5 text-[var(--muted-foreground)]" />
            <h3>等待提取内容</h3>
            <p>输入分享文本或链接，提取后的口播文案会显示在这里。</p>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   Batch Extract Tab
   ══════════════════════════════════════════ */
function BatchExtractTab({ addHistory, retryDraft, runtimeCatalog }: { addHistory: (item?: ExtractResult) => void; retryDraft: ExtractionRetryDraft | null; runtimeCatalog: ReturnType<typeof useToolRuntimeCatalog> }) {
  const { state } = useApp();
  const auth = state.auth;
  const [urls, setUrls] = useState("");
  const [mode, setMode] = useState<"video" | "text">("text");
  const [inputMode, setInputMode] = useState<"links" | "creator" | "search">("links");
  const [creatorUrl, setCreatorUrl] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [likesThreshold, setLikesThreshold] = useState(1000);
  const [creatorMaxCount, setCreatorMaxCount] = useState(10);
  const [processing, setProcessing] = useState(false);
  const extractInFlightRef = useRef(false);
  const [progress, setProgress] = useState({ total: 0, done: 0, success: 0, fail: 0 });
  const [batchResults, setBatchResults] = useState<ExtractResult[]>([]);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  const [maxCount, setMaxCount] = useState(20);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quoteKey = inputMode === 'creator' ? 'batch' : inputMode === 'search' ? 'search' : mode;
  const runtimeGate: RuntimeGate = { quote: runtimeCatalog.items[quoteKey], loading: runtimeCatalog.loading, error: runtimeCatalog.error, onRefresh: runtimeCatalog.refresh };

  useEffect(() => {
    if (!retryDraft || retryDraft.input.requestKind === 'single') return;
    if (retryDraft.input.requestKind === 'batch') {
      setInputMode('creator');
      setMode('text');
      setCreatorUrl(retryDraft.input.creatorUrl);
      setLikesThreshold(retryDraft.input.likesThreshold);
      setCreatorMaxCount(retryDraft.input.maxCount);
    } else {
      setInputMode('search');
      setMode('text');
      setSearchKeyword(retryDraft.input.keyword);
      setLikesThreshold(retryDraft.input.likesThreshold);
      setCreatorMaxCount(retryDraft.input.maxCount);
    }
    setBatchResults([]);
    setDuplicateNotice('已载入失败记录的原参数；旧请求号已清除。请核对价格后主动提交新任务。');
  }, [retryDraft]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (text) setUrls(text);
    };
    reader.readAsText(file);
  };

  const handleBatchExtract = async () => {
    if (extractInFlightRef.current) return;
    if (runtimeGate.loading || runtimeGate.error || !runtimeGate.quote?.available) return;
    const linkList = urls.split("\n").map(u => u.trim()).filter(Boolean);
    if (linkList.length === 0) return;
    if (!confirmLoadedRetry(retryDraft, mode, runtimeGate)) return;

    // 按数量限制截取。视频链接由客户端去重后逐条提交，每条都有独立
    // request id / provider / settlement / recovery boundary。
    const requestLimit = mode === "video" ? Math.min(maxCount, 10) : Math.min(maxCount, 30);
    const cappedLinks = linkList.slice(0, requestLimit);
    const limitedLinks = mode === "video" ? [...new Set(cappedLinks)] : cappedLinks;

    extractInFlightRef.current = true;
    setProcessing(true);
    setProgress({ total: limitedLinks.length, done: 0, success: 0, fail: 0 });
    setBatchResults([]);

    setDuplicateNotice(cappedLinks.length > limitedLinks.length
      ? `已跳过 ${cappedLinks.length - limitedLinks.length} 条完全重复的视频链接，每个唯一链接将创建独立任务。`
      : null);
    const results: ExtractResult[] = [];

    if (mode === "video") {
      for (let i = 0; i < limitedLinks.length; i++) {
        const url = limitedLinks[i];
        let resultItem: ExtractResult;
        try {
          const itemAttemptScope = await buildClientRequestFingerprint({
            kind: "video-batch-item",
            url,
          });
          const output = await callExtractAPI(
            auth.token || "",
            auth.user?.id || "anonymous",
            [url],
            "video",
            undefined,
            undefined,
            `batch:${itemAttemptScope}`,
          );
          const normalized = normalizeResponse(output);
          const video = normalized.videos?.[0];
          const succeeded = isDeliverableExtractVideo(video);
          resultItem = {
            id: `b-${Date.now()}-${i}`,
            url,
            platform: video?.platform || detectPlatform(url).name,
            mode: "video",
            timestamp: Date.now(),
            status: succeeded ? "success" : "error",
            result: { ...normalized, success: succeeded, videos: video ? [video] : [], texts: [] },
            error: succeeded ? undefined : video?.error || normalized.message || "这条内容未取得有效视频，请检查链接后重试",
          };
        } catch (err) {
          const pending = err instanceof PendingExtractionRequestError;
          resultItem = {
            id: `b-${Date.now()}-${i}`,
            url,
            platform: detectPlatform(url).name,
            mode: "video",
            timestamp: Date.now(),
            status: "error",
            error: err instanceof Error ? err.message : "网络请求失败",
            pending,
            attemptState: pending ? "running" : undefined,
            clientRequestId: pending ? err.attempt.clientRequestId : undefined,
          };
        }
        results.push(resultItem);
        addHistory(resultItem);
        setProgress(prev => ({
          ...prev,
          done: prev.done + 1,
          success: prev.success + (resultItem.status === "success" ? 1 : 0),
          fail: prev.fail + (resultItem.status === "success" ? 0 : 1),
        }));
        setBatchResults([...results]);
        if (resultItem.pending) {
          for (let queuedIndex = i + 1; queuedIndex < limitedLinks.length; queuedIndex++) {
            const queuedUrl = limitedLinks[queuedIndex];
            const skipped: ExtractResult = {
              id: `b-${Date.now()}-${queuedIndex}`,
              url: queuedUrl,
              platform: detectPlatform(queuedUrl).name,
              mode: "video",
              timestamp: Date.now(),
              status: "error",
              error: "前一项仍在处理，当前链接尚未提交；可稍后重新开始",
            };
            results.push(skipped);
            addHistory(skipped);
          }
          setBatchResults([...results]);
          break;
        }
      }
      extractInFlightRef.current = false;
      setProcessing(false);
      return;
    }

    // Text extraction retains its channel-specific batch contract.
    try {
      const output = await callExtractAPI(auth.token || "", auth.user?.id || "anonymous", limitedLinks, mode);
      const counts = output as ExtractAPIResponse & { duplicate_count?: number; unique_count?: number };
      if (Number(counts.duplicate_count) > 0) setDuplicateNotice(`已合并 ${counts.duplicate_count} 条重复链接，仅处理 ${counts.unique_count} 个唯一链接；结果按输入顺序显示。`);
      const normalized = normalizeResponse(output);
      const items = normalized.texts;

      for (let i = 0; i < limitedLinks.length; i++) {
        const url = limitedLinks[i];
        const item = items?.[i];
        const platform = detectPlatform(url);
        const itemSucceeded = Boolean(item && item.success !== false
          && ((item as TextItem).corrected_content?.trim() || (item as TextItem).content?.trim()));
        const itemResult: WorkflowOutput = {
          ...normalized,
          success: itemSucceeded,
          videos: [],
          texts: item ? [item as TextItem] : [],
          summary: itemSucceeded
            ? ((item as TextItem).corrected_content || (item as TextItem).content || "").slice(0, 60)
            : item?.error || "这条内容未取得有效结果，请检查链接后重试",
        };

        const resultItem: ExtractResult = {
          id: `b-${Date.now()}-${i}`,
          url,
          platform: item?.platform || platform.name,
          mode,
          timestamp: Date.now(),
          status: itemSucceeded ? "success" : "error",
          result: itemResult,
          error: itemSucceeded ? undefined : item?.error || "这条内容未取得有效结果，请检查链接后重试",
        };

        results.push(resultItem);
        addHistory(resultItem);
        setProgress(prev => ({
          ...prev,
          done: prev.done + 1,
          success: prev.success + (itemSucceeded ? 1 : 0),
          fail: prev.fail + (itemSucceeded ? 0 : 1),
        }));
        setBatchResults([...results]);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "网络请求失败";
      for (let i = 0; i < limitedLinks.length; i++) {
        const resultItem: ExtractResult = {
          id: `b-${Date.now()}-${i}`,
          url: limitedLinks[i],
          platform: detectPlatform(limitedLinks[i]).name,
          mode,
          timestamp: Date.now(),
          status: "error",
          error: errorMsg,
        };
        results.push(resultItem);
        setProgress(prev => ({ ...prev, done: prev.done + 1, fail: prev.fail + 1 }));
      }
      setBatchResults([...results]);
    }

    extractInFlightRef.current = false;
    setProcessing(false);
  };

  /** 博主主页批量提取文案 */
  const handleCreatorBatchExtract = async () => {
    if (extractInFlightRef.current || !creatorUrl.trim()) return;
    if (runtimeGate.loading || runtimeGate.error || !runtimeGate.quote?.available) return;
    if (!confirmLoadedRetry(retryDraft, 'batch', runtimeGate)) return;

    extractInFlightRef.current = true;
    setProcessing(true);
    setProgress({ total: creatorMaxCount, done: 0, success: 0, fail: 0 });
    setBatchResults([]);

    try {
      const requestPayload = {
        creator_url: creatorUrl.trim(),
        likes_threshold: likesThreshold,
        max_count: creatorMaxCount,
      };
      const attempt = await createExtractAttempt({
        storageKey: `extract:${auth.user?.id || "anonymous"}:creator`,
        prefix: "extract-creator",
        payload: requestPayload,
      });
      const res = await fetch("/api/extract/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${auth.token || ""}`,
          "Idempotency-Key": attempt.clientRequestId,
        },
        body: JSON.stringify({ ...requestPayload, client_request_id: attempt.clientRequestId }),
        signal: AbortSignal.timeout(300000), // 5分钟超时
      });

      const data = await readJsonResponse<CreatorBatchApiResponse>(res);

      if (!res.ok || data.success === false || !data.texts?.length) {
        clearAttemptAfterDefinitiveHttpFailure(attempt, res.status, data);
        const resultItem: ExtractResult = {
          id: `cb-${Date.now()}`,
          url: creatorUrl,
          platform: "抖音",
          mode: "text",
          timestamp: Date.now(),
          status: "error",
          error: data.error || (res.ok ? "没有找到符合条件的口播文案，可降低点赞数筛选条件后再试。" : "暂未取得文案，请稍后查询原请求状态。"),
        };
        setBatchResults([resultItem]);
        addHistory(resultItem);
        setProgress({ total: 1, done: 1, success: 0, fail: 1 });
      } else {
        clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
        // 解析返回的批量结果
        const texts = data.texts || [];
        const filteredCount = data.filtered_count || texts.length;
        const successCount = texts.filter((t: TextItem) => t.success).length;

        const results: ExtractResult[] = texts.map((t: TextItem, idx: number) => ({
          id: `cb-${Date.now()}-${idx}`,
          url: t.url || (t.awemeId ? `https://www.douyin.com/video/${t.awemeId}` : creatorUrl),
          platform: "抖音",
          mode: "text",
          timestamp: Date.now(),
          status: t.success ? "success" : "error",
          result: {
            success: t.success,
            message: t.success ? "提取成功" : (t.error || "提取失败"),
            videos: [],
            texts: [t],
            summary: t.content?.substring(0, 60) || t.error || "",
          },
          error: t.error,
        }));

        setBatchResults(results);
        results.forEach(r => addHistory(r));
        setProgress({
          total: filteredCount,
          done: texts.length,
          success: successCount,
          fail: texts.length - successCount,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "网络请求失败";
      const resultItem: ExtractResult = {
        id: `cb-${Date.now()}`,
        url: creatorUrl,
        platform: "抖音",
        mode: "text",
        timestamp: Date.now(),
        status: "error",
        error: errorMsg,
      };
      setBatchResults([resultItem]);
      addHistory(resultItem);
      setProgress({ total: 1, done: 1, success: 0, fail: 1 });
    }

    extractInFlightRef.current = false;
    setProcessing(false);
  };

  /** 关键词搜索批量提取文案 */
  const handleKeywordSearch = async () => {
    if (extractInFlightRef.current || !searchKeyword.trim()) return;
    if (runtimeGate.loading || runtimeGate.error || !runtimeGate.quote?.available) return;
    if (!confirmLoadedRetry(retryDraft, 'search', runtimeGate)) return;

    extractInFlightRef.current = true;
    setProcessing(true);
    setProgress({ total: creatorMaxCount, done: 0, success: 0, fail: 0 });
    setBatchResults([]);

    try {
      const requestPayload = {
        keyword: searchKeyword.trim(),
        likes_threshold: likesThreshold,
        max_count: creatorMaxCount,
      };
      const attempt = await createExtractAttempt({
        storageKey: `extract:${auth.user?.id || "anonymous"}:search`,
        prefix: "extract-search",
        payload: requestPayload,
      });
      const res = await fetch("/api/extract/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${auth.token || ""}`,
          "Idempotency-Key": attempt.clientRequestId,
        },
        body: JSON.stringify({ ...requestPayload, client_request_id: attempt.clientRequestId }),
        signal: AbortSignal.timeout(300000), // 5分钟超时
      });

      const data = await readJsonResponse<SearchBatchApiResponse>(res);

      if (!res.ok || data.success === false || !data.texts?.length) {
        clearAttemptAfterDefinitiveHttpFailure(attempt, res.status, data);
        const resultItem: ExtractResult = {
          id: `search-${Date.now()}`,
          url: `搜索: ${searchKeyword}`,
          platform: "抖音",
          mode: "text",
          timestamp: Date.now(),
          status: "error",
          error: data.error || (res.ok ? "没有找到符合条件的口播文案，可更换关键词或降低点赞数筛选条件后再试。" : "暂未取得文案，请稍后查询原请求状态。"),
        };
        setBatchResults([resultItem]);
        addHistory(resultItem);
        setProgress({ total: 1, done: 1, success: 0, fail: 1 });
      } else {
        clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
        const texts = data.texts || [];
        const filteredCount = data.filtered_count || texts.length;

        const results: ExtractResult[] = texts.map((t, i: number) => {
          const content = (t.content || t.caption || t.text || "").trim();
          const success = t.success !== false && !t.error && content.length > 0;
          const title = t.title || t.desc || "";
          const author = t.nickname || t.author || "";
          const likes = t.digg_count || t.likes || 0;
          return {
            id: `search-${Date.now()}-${i}`,
            url: t.url || `搜索结果 #${i + 1}`,
            platform: "抖音",
            mode: "text",
            timestamp: Date.now(),
            status: success ? "success" : "error",
            result: {
              success,
              message: success ? "提取成功" : t.error || "未返回有效文案",
              videos: [],
              texts: [{
                row: i + 1,
                col: 1,
                platform: "抖音",
                success,
                content,
                corrected_content: content,
                title,
                author,
                likes,
                error: success ? undefined : t.error || "未返回有效文案",
              }],
              summary: content.slice(0, 60) || t.error || "未返回有效文案",
            },
            error: success ? undefined : t.error || "未返回有效文案",
          };
        });

        setBatchResults(results);
        results.forEach(r => addHistory(r));
        setProgress({
          total: filteredCount,
          done: filteredCount,
          success: results.filter(r => r.status === "success").length,
          fail: results.filter(r => r.status === "error").length,
        });
      }
    } catch (err: unknown) {
      const resultItem: ExtractResult = {
        id: `search-err-${Date.now()}`,
        url: `搜索: ${searchKeyword}`,
        platform: "抖音",
        mode: "text",
        timestamp: Date.now(),
        status: "error",
        error: err instanceof Error ? err.message : "搜索请求超时或网络异常",
      };
      setBatchResults([resultItem]);
      addHistory(resultItem);
      setProgress({ total: 1, done: 1, success: 0, fail: 1 });
    }

    extractInFlightRef.current = false;
    setProcessing(false);
  };

  const progressPct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        <h3 className="text-sm font-semibold mb-3 text-[var(--foreground)] flex items-center gap-2">
          <Package className="w-4 h-4 text-[var(--primary)]" />
          批量提取
        </h3>
        <RuntimeQuoteCard gate={runtimeGate} />
        {duplicateNotice && <p role="status" className="mb-3 text-xs text-[var(--muted-foreground)]">{duplicateNotice}</p>}

        {/* 输入方式选择：链接列表 / 博主主页 / 关键词搜索 */}
        <div className="flex gap-2 mb-3">
          {([
            { key: "links", label: "链接列表", icon: FileText },
            { key: "creator", label: "博主主页", icon: Search },
            { key: "search", label: "关键词搜索", icon: Zap },
          ] as const).map(im => {
            const Icon = im.icon;
            return (
              <button
                key={im.key}
                onClick={() => setInputMode(im.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                  inputMode === im.key
                    ? "text-[var(--primary-foreground)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                }`}
                style={inputMode === im.key ? { background: "var(--primary)" } : undefined}
              >
                <Icon className="w-3.5 h-3.5" />
                {im.label}
              </button>
            );
          })}
        </div>

        {/* ═══ 链接列表模式 ═══ */}
        {inputMode === "links" && (
          <>
            {/* Mode Selection: 视频/文案 */}
            <div className="flex gap-2 mb-3">
              {(["text", "video"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setMaxCount((current) => m === "video" ? 10 : Math.min(current, 30));
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                    mode === m
                      ? "text-[var(--primary-foreground)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                  }`}
                  style={mode === m ? { background: "var(--primary)" } : undefined}
                >
                  {m === "video" ? <Video className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                  {m === "video" ? "视频提取" : "文案提取"}
                </button>
              ))}
            </div>

            {/* 文案提取模式提示 */}
            {mode === "text" && (
              <div className="mb-3 p-2.5 rounded-lg text-[11px] leading-relaxed" style={{ background: "color-mix(in srgb, var(--primary) 8%, var(--card))", color: "var(--foreground)" }}>
                粘贴抖音分享文本或链接，每行一条。支持从抖音APP复制分享文本（自动提取链接）。
              </div>
            )}

            <Textarea
              value={urls}
              onChange={e => setUrls(e.target.value)}
              placeholder={mode === "text"
                ? "每行粘贴一条抖音分享文本或链接，如：\n7.99 复制打开抖音，看看... https://v.douyin.com/xxx/\nhttps://www.douyin.com/video/7348416970327889187\n也可点击下方按钮上传TXT文件"
                : "每行一个链接，支持批量提取\n也可点击下方按钮上传TXT文件"}
              className="min-h-[120px] resize-none text-sm"
              style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            />

            <div className="flex items-center gap-3 mt-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="text-[12px]">
                📄 上传TXT文件
              </Button>
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {urls ? `${urls.split("\n").filter(u => u.trim()).length} 条链接` : "未输入链接"}
              </span>
              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-[11px] text-[var(--muted-foreground)]">提取上限</span>
                <select
                  value={maxCount}
                  onChange={e => setMaxCount(Number(e.target.value))}
                  className="text-[11px] px-2 py-1 rounded border"
                  style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
                >
                  {(mode === "video" ? [10] : [10, 20, 30]).map(n => (
                    <option key={n} value={n}>{n}条</option>
                  ))}
                </select>
              </div>
            </div>

            <Button
              onClick={handleBatchExtract}
              disabled={processing || !urls.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
              className="w-full mt-4 h-10 font-medium"
              style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
            >
              {processing ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 处理中 ({progress.done}/{progress.total})</>
              ) : (
                <><Package className="w-4 h-4 mr-2" /> 开始批量提取</>
              )}
            </Button>
          </>
        )}

        {/* ═══ 博主主页模式 ═══ */}
        {inputMode === "creator" && (
          <>
            <div className="mb-3 p-2.5 rounded-lg text-[11px] leading-relaxed" style={{ background: "color-mix(in srgb, var(--primary) 8%, var(--card))", color: "var(--foreground)" }}>
              粘贴抖音博主主页链接，自动获取视频列表并按条件筛选提取文案。
            </div>

            {/* 博主主页链接输入 */}
            <Input
              value={creatorUrl}
              onChange={e => setCreatorUrl(e.target.value)}
              placeholder="粘贴抖音博主主页链接，如：https://www.douyin.com/user/MS4wLjABAAAA..."
              className="text-sm"
              style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            />

            {/* 筛选条件 — 自由输入 */}
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block">点赞数阈值</label>
                <Input
                  type="number"
                  value={likesThreshold}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    setLikesThreshold(isNaN(val) ? 0 : Math.max(0, val));
                  }}
                  min={0}
                  step={1}
                  placeholder="0"
                  className="text-sm"
                  style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">低于此点赞数的视频跳过，0表示不筛选</p>
              </div>
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block">提取数量</label>
                <Input
                  type="number"
                  value={creatorMaxCount}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    setCreatorMaxCount(isNaN(val) ? 10 : Math.min(30, Math.max(1, val)));
                  }}
                  min={1}
                  max={30}
                  step={1}
                  placeholder="10"
                  className="text-sm"
                  style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">1-30条，按点赞数从高到低</p>
              </div>
            </div>


            <Button
              onClick={handleCreatorBatchExtract}
              disabled={processing || !creatorUrl.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
              className="w-full mt-4 h-10 font-medium"
              style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
            >
              {processing ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 正在获取博主视频并提取文案...</>
              ) : (
                <><Search className="w-4 h-4 mr-2" /> 开始批量提取博主文案</>
              )}
            </Button>
          </>
        )}

        {/* ═══ 关键词搜索模式 ═══ */}
        {inputMode === "search" && (
          <>
            <div className="mb-3 p-2.5 rounded-lg text-[11px] leading-relaxed" style={{ background: "color-mix(in srgb, var(--primary) 8%, var(--card))", color: "var(--foreground)" }}>
              输入关键词搜索抖音视频，自动获取搜索结果并按条件筛选提取文案。
            </div>

            {/* 关键词输入 */}
            <Input
              value={searchKeyword}
              onChange={e => setSearchKeyword(e.target.value)}
              placeholder="输入搜索关键词，如：AI工具推荐、短视频运营..."
              className="text-sm"
              style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            />

            {/* 筛选条件 */}
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block">点赞数阈值</label>
                <Input
                  type="number"
                  value={likesThreshold}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    setLikesThreshold(isNaN(val) ? 0 : Math.max(0, val));
                  }}
                  min={0}
                  step={1}
                  placeholder="0"
                  className="text-sm"
                  style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">0表示不筛选</p>
              </div>
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block">提取数量</label>
                <Input
                  type="number"
                  value={creatorMaxCount}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    setCreatorMaxCount(isNaN(val) ? 10 : Math.min(30, Math.max(1, val)));
                  }}
                  min={1}
                  max={30}
                  step={1}
                  placeholder="10"
                  className="text-sm"
                  style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">1-30条，按点赞数从高到低</p>
              </div>
            </div>

            <Button
              onClick={handleKeywordSearch}
              disabled={processing || !searchKeyword.trim() || runtimeGate.loading || Boolean(runtimeGate.error) || !runtimeGate.quote?.available}
              className="w-full mt-4 h-10 font-medium"
              style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
            >
              {processing ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 正在搜索并提取文案...</>
              ) : (
                <><Zap className="w-4 h-4 mr-2" /> 开始关键词搜索提取</>
              )}
            </Button>
          </>
        )}

        {processing && (
          <div className="mt-3">
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--accent)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%`, background: "var(--primary)" }}
              />
            </div>
            <div className="flex justify-between mt-1 text-[11px] text-[var(--muted-foreground)]">
              <span>成功 {progress.success} · 失败 {progress.fail}</span>
              <span>{Math.round(progressPct)}%</span>
            </div>
          </div>
        )}
      </div>

      {batchResults.length > 0 && (
        <div className="space-y-2">
          {duplicateNotice && <p role="status" className="text-xs text-[var(--muted-foreground)]">{duplicateNotice}</p>}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              {inputMode === "creator" ? "博主文案提取结果" : inputMode === "search" ? "搜索文案提取结果" : "处理结果"}
            </h3>
            {(mode === "text" || inputMode === "creator" || inputMode === "search") && batchResults.some(r => r.status === "success") && (
              <Button
                variant="outline"
                size="sm"
                className="text-[11px] h-7"
                onClick={async () => {
                  const allTexts = batchResults
                    .filter(r => r.status === "success" && (r.result?.texts?.[0]?.corrected_content || r.result?.texts?.[0]?.content))
                    .map((r, idx) => `--- 第${idx + 1}条 ---\n${r.result!.texts![0]!.corrected_content || r.result!.texts![0]!.content}`)
                    .join("\n\n");
                  const ok = await copyToClipboard(allTexts);
                  if (ok) {
                    const btn = document.activeElement as HTMLElement;
                    btn.textContent = "已复制!";
                    setTimeout(() => { btn.textContent = "📋 复制全部文案"; }, 2000);
                  }
                }}
              >
                📋 复制全部文案
              </Button>
            )}
          </div>
          {batchResults.map(item => (
            <BatchResultItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   History Tab
   ══════════════════════════════════════════ */
function HistoryTab({ history, onRemove, onClear, loading, ready, error, retryReady, retryUnavailableReason, onLoadRetry, onRefresh, hasMore, onLoadMore }: {
  history: ExtractResult[];
  onRemove: (id: string) => void;
  onClear: () => void;
  loading: boolean;
  ready: boolean;
  error: string;
  retryReady: boolean;
  retryUnavailableReason: string;
  onLoadRetry: (item: ExtractResult) => void;
  onRefresh: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const { state } = useApp();
  const auth = state.auth;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedHistoryId, setCopiedHistoryId] = useState<string | null>(null);
  const [historyNow, setHistoryNow] = useState(0);

  useEffect(() => {
    const refresh = () => setHistoryNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const videoHistoryItems = history.filter(
    item => item.mode === "video"
      && item.status === "success"
      && item.result?.videos?.some(video => isDeliverableExtractVideo(video, historyNow || Number.POSITIVE_INFINITY))
  );
  useEffect(() => {
    const available = new Set(history.filter(item => item.mode !== "video" || item.result?.videos?.some(
      video => isDeliverableExtractVideo(video, historyNow || Number.POSITIVE_INFINITY),
    )).map(item => item.id));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
    setExpandedId(previous => previous && available.has(previous) ? previous : null);
  }, [history, historyNow]);

  const allVideoSelected = videoHistoryItems.length > 0 && videoHistoryItems.every(item => selectedIds.has(item.id));

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allVideoSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        videoHistoryItems.forEach(item => next.delete(item.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        videoHistoryItems.forEach(item => next.add(item.id));
        return next;
      });
    }
  };

  const downloadSelected = async () => {
    const selected = history.filter(item => selectedIds.has(item.id)).flatMap(item =>
      (item.result?.videos || []).filter(video => isDeliverableExtractVideo(video)).map(video => ({ ...item, result: { ...item.result!, videos: [video] } })));
    if (selectedIds.size > 0 && selected.length === 0) {
      window.alert("所选临时视频已过期，请重新提取");
      setSelectedIds(new Set());
      return;
    }
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const videoItem = item.result?.videos?.[0];
      if (isDeliverableExtractVideo(videoItem)) {
        try {
          if (videoItem?.temporary_url) {
            downloadTemporaryExtractVideo(videoItem.temporary_url);
            continue;
          }
          await triggerExtractDownload(
            videoItem.download_url || videoItem.url || "",
            `${videoItem.title || "video"}_${i + 1}.mp4`,
            auth.token || "",
            videoItem.asset_id,
          );
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "下载凭证获取失败");
          break;
        }
        if (i < selected.length - 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  const grouped = history.reduce<Record<string, ExtractResult[]>>((acc, item) => {
    const d = new Date(item.timestamp);
    const today = new Date();
    let key: string;
    if (d.toDateString() === today.toDateString()) key = "今天";
    else {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) key = "昨天";
      else key = d.toLocaleDateString();
    }
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const getHistoryText = (item: ExtractResult): string => {
    if (!item.result) return item.error || "";
    if (item.mode === "text") {
      return item.result.texts?.map(textItem => textItem.corrected_content || textItem.content || "").filter(Boolean).join("\n\n") || item.result.summary || "";
    }
    const videoItem = item.result.videos?.[0];
    if (videoItem && (videoItem.temporary_url || videoItem.asset_id)) {
      return videoItem.title || (videoItem.asset_id ? "站内视频" : "临时视频");
    }
    return item.result.summary || JSON.stringify(item.result, null, 2);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-sm">
        <div><p className="font-medium">账户历史</p><p role={error ? "alert" : "status"} className="mt-1 text-xs text-[var(--muted-foreground)]">{loading ? "正在读取历史…" : error || "文案记录保留 10 天；视频提取仅供当次预览和下载，不保存文件或历史结果"}</p></div>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={onRefresh}>{error ? "重试" : "刷新历史"}</Button>
      </div>
      {!retryReady && retryUnavailableReason && (
        <p role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-[var(--warning)]">
          {retryUnavailableReason}
        </p>
      )}
      {history.length > 0 && (
        <div className="flex justify-between items-center">
          {videoHistoryItems.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: "var(--muted-foreground)" }}>
                <input
                  type="checkbox"
                  checked={allVideoSelected}
                  onChange={toggleSelectAll}
                  className="w-3.5 h-3.5 rounded border cursor-pointer"
                />
                全选 ({selectedIds.size})
              </label>
              {selectedIds.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={downloadSelected}
                  className="text-[12px] text-[var(--success)] hover:text-[var(--success)] hover:bg-green-500/10 h-7 px-2"
                >
                  <Download className="w-3.5 h-3.5 mr-1" /> 下载选中
                </Button>
              )}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={loading || !ready}
            className="text-[12px] text-[var(--error)] hover:text-[var(--error)] hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" /> 清空历史
          </Button>
        </div>
      )}

      {history.length === 0 && !loading && !error && (
        <div className="text-center py-12">
          <History className="w-10 h-10 mx-auto text-[var(--muted-foreground)] mb-3 opacity-30" />
          <p className="text-sm text-[var(--muted-foreground)]">暂无提取记录</p>
        </div>
      )}

      {Object.entries(grouped).map(([date, items]) => (
        <div key={date}>
          <h4 className="text-[11px] font-semibold text-[var(--muted-foreground)] mb-2 uppercase tracking-wider">{date}</h4>
          <div className="space-y-2">
            {items.map(item => (
              <div
                key={item.id}
                data-extract-history-id={item.id}
                className="rounded-lg p-3 transition-colors cursor-pointer hover:bg-[var(--accent)]"
                style={{ background: "var(--card)", border: "1px solid var(--border)" }}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {item.mode === "video" && item.status === "success" && item.result?.videos?.some(
                      video => isDeliverableExtractVideo(video, historyNow || Number.POSITIVE_INFINITY),
                    ) && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onClick={event => event.stopPropagation()}
                        onChange={e => { e.stopPropagation(); toggleSelect(item.id); }}
                        className="w-3.5 h-3.5 rounded border shrink-0 cursor-pointer"
                      />
                    )}
                    <span className="text-[11px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
                      {detectPlatform(item.url).icon} {item.platform}
                    </span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--primary)/10", color: "var(--primary)" }}>
                      {item.mode === "video" ? "视频" : "文案"}
                    </span>
                    <span className="text-[12px] truncate" style={{ color: "var(--foreground)" }}>
                      {item.url.length > 40 ? item.url.slice(0, 40) + "..." : item.url}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {item.status === "success" && <Check className="w-3.5 h-3.5 text-[var(--success)]" />}
                    {item.pending && <Clock3 className="w-3.5 h-3.5 text-[var(--info)]" />}
                    {item.status === "error" && !item.pending && <AlertCircle className="w-3.5 h-3.5 text-[var(--error)]" />}
                    {item.status === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" />}
                    <button
                      type="button"
                      aria-label="删除这条提取记录"
                      disabled={loading || !ready}
                      onClick={e => { e.stopPropagation(); onRemove(item.id); }}
                      className="text-[var(--muted-foreground)] hover:text-[var(--error)] transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {expandedId === item.id && (
                  <div className="mt-2 pt-2 border-t" style={{ borderColor: "var(--border)" }} onClick={event => event.stopPropagation()}>
                    {/^https?:\/\//.test(item.url) && <p className="text-[12px] text-[var(--muted-foreground)] break-all">链接: {item.url}</p>}
                    {item.error && item.mode !== "video" && (
                      <p className={`text-[12px] mt-1 ${item.pending ? "text-[var(--info)]" : "text-[var(--error)]"}`}>{readableExtractionError(item.error, item.mode === "video" ? "video" : "text").replace(/（请求号\s*[a-f0-9]{64}）/gi, "")}</p>
                    )}
                    {item.status === 'error' && !item.pending && item.canLoadForRetry && (
                      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => onLoadRetry(item)}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> 载入原输入后重试
                      </Button>
                    )}
                    {item.status === 'error' && !item.pending && !item.canLoadForRetry && item.retryUnavailableReason && (
                      <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">{item.retryUnavailableReason}</p>
                    )}
                    {item.result?.summary && (
                      <p className="text-[12px] text-[var(--muted-foreground)] mt-1">{item.result.summary}</p>
                    )}
                    {item.mode === "video" && (item.result?.videos?.length ? item.result.videos.map((video, index) => <VideoResultCard key={index} item={{ ...item, result: { ...item.result!, videos: [video], texts: [] } }} />) : <VideoResultCard item={item} />)}
                    {item.mode !== "video" && item.status === "success" && getHistoryText(item) && (
                      <div className="mt-2 p-2 rounded text-[12px] whitespace-pre-wrap max-h-[200px] overflow-y-auto" style={{ background: "var(--background)", color: "var(--foreground)" }}>
                        {getHistoryText(item)}
                      </div>
                    )}
                    {item.mode === "text" && item.status === "success" && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={async event => { event.stopPropagation(); if (await copyToClipboard(getHistoryText(item))) setCopiedHistoryId(item.id); }}>{copiedHistoryId === item.id ? "已复制" : "复制文案"}</Button>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {hasMore && <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={onLoadMore}>加载更多历史</Button>}
    </div>
  );
}

/* ══════════════════════════════════════════
   Shared Sub-Components
   ══════════════════════════════════════════ */

/** Video result card with embedded player */
function VideoResultCard({ item }: { item: ExtractResult }) {
  const { state } = useApp();
  const auth = state.auth;
  const attempt = useExtractionAttemptStatus({
    message: item.error || '',
    clientRequestId: item.clientRequestId,
    token: auth.token || '',
    userId: auth.user?.id || '',
    mode: item.mode,
  });
  if (attempt.data?.state === 'succeeded') {
    if (attempt.data.response) {
      const restored = normalizeResponse(attempt.data.response as ExtractAPIResponse);
      const hasVideo = restored.videos.some(isDeliverableExtractVideo);
      item = { ...item, pending: false, attemptState: 'succeeded', status: hasVideo ? 'success' : 'error', result: restored,
        error: hasVideo ? undefined : '这次提取没有可用的视频下载链接。' };
    } else {
      item = { ...item, pending: false, attemptState: 'succeeded', status: 'error',
        error: attempt.data.contentUnavailableReason || '任务已结束，但结果记录中没有可交付的视频。' };
    }
  }
  if (attempt.data?.state === 'failed') {
    const failedResponse = attempt.data.response as { error?: string; message?: string } | undefined;
    item = { ...item, status: 'error', pending: false, attemptState: 'failed',
      error: failedResponse?.error || failedResponse?.message || '这次提取已结束，但没有取得可交付的视频。' };
  }
  const pending = item.status === 'error' && (item.pending || (attempt.data
    ? ['running', 'failed_unknown'].includes(attempt.data.state)
    : /终态未知|结果无法确认|结果暂未确认|等待对账|人工对账|结算记录未确认/.test(item.error || '')));
  const failureMessage = /迁移尚未部署|迁移未完成|MIGRATION_NOT_READY/.test(item.error || '')
    ? '这条历史请求未成功提交，本次未扣费。请重新提取。'
    : pending ? '暂未取得可确认的结果，原请求已保留。'
    : readableExtractionError(item.error || '请检查链接是否有效', 'video').replace(/（请求号\s*[a-f0-9]{64}）/gi, '');

  const [copied, setCopied] = useState(false);
  const [copiedText, setCopiedText] = useState("");
  const [showVideo, setShowVideo] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [videoErrorMessage, setVideoErrorMessage] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [videoLoading, setVideoLoading] = useState(false);
  const [signedVideoUrl, setSignedVideoUrl] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const platform = detectPlatform(item.url);

  const videoItem = item.result?.videos?.[0];
  const textItem = item.result?.texts?.[0];
  const temporaryVideoUrl = videoItem?.temporary_url || "";
  const temporaryExpiresAt = temporaryExtractVideoExpiresAt(videoItem) || 0;
  const temporaryExpired = Boolean(temporaryVideoUrl && (
    currentTime === 0 || !temporaryExpiresAt || temporaryExpiresAt <= currentTime
  ));
  const activeTemporaryVideoUrl = temporaryVideoUrl && !temporaryExpired ? temporaryVideoUrl : "";
  const rawVideoUrl = activeTemporaryVideoUrl;
  const downloadUrl = activeTemporaryVideoUrl;
  const hasOwnedVideo = Boolean(videoItem?.asset_id?.trim());
  const canPlay = hasOwnedVideo || Boolean(activeTemporaryVideoUrl);
  const canDownload = hasOwnedVideo || Boolean(activeTemporaryVideoUrl);
  const title = videoItem?.title || textItem?.title || item.url;
  const coverUrl = typeof videoItem?.cover === "string" && /^\/(?!\/)/u.test(videoItem.cover)
    ? videoItem.cover
    : "";

  useEffect(() => {
    setCurrentTime(Date.now());
    if (!temporaryExpiresAt) return;
    const delay = Math.max(0, Math.min(2_147_483_647, temporaryExpiresAt - Date.now() + 25));
    const timer = window.setTimeout(() => setCurrentTime(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [temporaryExpiresAt]);

  // 文案内容：优先取纠正后的文案，其次取原始文案
  const textContent = textItem?.corrected_content || textItem?.content || "";
  const hasTextOnly = !canPlay && !canDownload && !coverUrl && textContent;
  const hasMedia = item.status === "success" && !hasTextOnly && (canPlay || Boolean(coverUrl));

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async (url: string, filename: string, assetId?: string) => {
    setDownloadError("");
    if (temporaryVideoUrl) {
      if (temporaryExpired) {
        setDownloadError("临时视频已过期，请重新提取");
        return;
      }
      downloadTemporaryExtractVideo(temporaryVideoUrl);
      return;
    }
    try {
      await triggerExtractDownload(url, filename, auth.token || "", assetId);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "下载暂时失败，请重试");
      console.error("[extract] 下载凭证获取失败:", error instanceof Error ? error.message : "unknown");
    }
  };

  const startPlayback = async () => {
    if (!canPlay || videoLoading) return;
    setShowVideo(true);
    setVideoLoading(true);
    setVideoError(false);
    setVideoErrorMessage("");
    try {
      if (temporaryVideoUrl) {
        if (temporaryExpired) throw new Error("临时视频已过期，请重新提取");
        setSignedVideoUrl(temporaryVideoUrl);
        return;
      }
      const ticket = await requestExtractDownloadTicket({
        token: auth.token || "",
        url: rawVideoUrl,
        assetId: videoItem?.asset_id,
        filename: `${title}.mp4`,
        mode: "play",
      });
      setSignedVideoUrl(ticket.url);
    } catch (error) {
      setSignedVideoUrl("");
      setVideoError(true);
      setVideoErrorMessage(error instanceof Error ? error.message : "播放暂时失败，请重试");
      console.error("[extract] 播放凭证获取失败:", error instanceof Error ? error.message : "unknown");
    } finally {
      setVideoLoading(false);
    }
  };

  return (
    <div
      className="toolbox-video-card rounded-xl overflow-hidden transition-all hover:shadow-md"
      data-video-layout={hasMedia ? "media" : "stacked"}
      data-video-status={item.status}
    >
      {item.status === "loading" && (
        <div className="flex items-center justify-center py-8 gap-2 text-[var(--muted-foreground)]">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">提取中...</span>
        </div>
      )}

      {item.status === "error" && (
        <div className="p-4">
          <div className={"flex items-center gap-2 mb-2 " + (pending ? 'text-[var(--primary)]' : 'text-[var(--error)]')}>
            {pending ? <Clock3 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span className="text-[12px] font-medium">{pending ? '结果待确认' : '提取失败'}</span>
          </div>
          <p className="text-[12px] text-[var(--muted-foreground)]">{failureMessage}</p>
          {attempt.data && <p className="mt-2 text-[12px] text-[var(--muted-foreground)]">{attempt.data.billingMessage}</p>}
          {attempt.attemptId && <div className="mt-3 flex items-center gap-2 text-xs">
            <button type="button" disabled={attempt.refreshing} onClick={attempt.refresh} className="rounded-md border border-[var(--border)] px-2 py-1 text-[var(--primary)] disabled:opacity-50">{attempt.refreshing ? '正在查询状态…' : '刷新状态'}</button>
            {attempt.error && <span className="text-[var(--muted-foreground)]">{attempt.error}</span>}
          </div>}
        </div>
      )}

      {item.status === "success" && hasTextOnly && (
        <div className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "var(--foreground)" }}>
              {platform.icon} {item.platform || platform.name}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-[var(--success)]">文案提取成功</span>
          </div>
          <div className="rounded-lg p-3 text-base leading-[1.75] whitespace-pre-wrap max-h-[300px] overflow-y-auto" style={{ background: "var(--accent)", color: "var(--foreground)" }}>
            {textContent}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={async () => {
                const ok = await copyToClipboard(textContent);
                if (ok) {
                  setCopied(true);
                  setCopiedText("textContent");
                  setTimeout(() => { setCopied(false); setCopiedText(""); }, 2000);
                }
              }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
              style={{ background: "var(--primary)" }}
            >
              {copied && copiedText === "textContent" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied && copiedText === "textContent" ? "已复制" : "复制文案"}
            </button>
          </div>
        </div>
      )}

      {item.status === "success" && !hasTextOnly && (
        <>
          {/* Video Player / Cover */}
          {showVideo && canPlay ? (
            <div className="toolbox-video-media relative bg-black">
              {videoLoading ? (
                <div className="w-full h-full flex items-center justify-center text-white/80 gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">正在获取安全播放凭证...</span>
                </div>
              ) : videoError || !signedVideoUrl ? (
                <div className="w-full h-full flex flex-col items-center justify-center text-white/80 gap-3">
                  <AlertCircle className="w-10 h-10 text-[var(--warning)]" />
                  <div className="text-center px-4">
                    <p role="alert" className="text-sm font-medium mb-1">{videoErrorMessage || "视频暂时无法播放"}</p>
                    <p className="text-xs text-white/50">可以重试播放，或下载视频后查看</p>
                    <button type="button" onClick={() => void startPlayback()} className="mt-3 rounded-lg border border-white/30 px-3 py-1.5 text-xs">重试播放</button>
                  </div>
                  {canDownload && (
                    <button
                      onClick={() => handleDownload(downloadUrl, `${title}.mp4`, videoItem?.asset_id)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
                      style={{ background: "var(--primary)" }}
                    >
                      <Download className="w-4 h-4" /> 下载视频
                    </button>
                  )}
                </div>
              ) : (
                <video
                  src={signedVideoUrl}
                  controls
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                  poster={coverUrl}
                  onError={event => {
                    setVideoError(true);
                    const code = event.currentTarget.error?.code;
                    setVideoErrorMessage(code === 2 ? "视频加载中断，请检查连接后重试" : code === 3 || code === 4 ? "浏览器无法播放当前视频，可下载后查看" : "视频暂时无法播放，请重试");
                  }}
                />
              )}
              <button
                type="button"
                aria-label="关闭视频预览"
                onClick={() => { setShowVideo(false); setVideoError(false); setSignedVideoUrl(""); }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : coverUrl ? (
            <div className={`toolbox-video-media relative overflow-hidden bg-black/5 ${canPlay ? "cursor-pointer group" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- Runtime third-party CDN URL must retain its original signature. */}
              <img src={coverUrl} alt={title} className="w-full h-full object-contain" />
              {canPlay && (
                <button
                  type="button"
                  aria-label="播放视频"
                  onClick={() => void startPlayback()}
                  className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                    <Play className="w-7 h-7 text-[var(--primary)] ml-1" />
                  </div>
                </button>
              )}
            </div>
          ) : canPlay ? (
            <button
              type="button"
              aria-label="播放视频"
              className="toolbox-video-media relative flex w-full cursor-pointer items-center justify-center overflow-hidden border-0 bg-black/5"
              onClick={() => void startPlayback()}
            >
              <div className="w-14 h-14 rounded-full bg-[var(--primary)]/20 flex items-center justify-center">
                <Play className="w-7 h-7 text-[var(--primary)] ml-1" />
              </div>
            </button>
          ) : null}

          <div className="toolbox-video-meta px-3 pt-3">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="toolbox-video-platform rounded px-1.5 py-0.5 text-xs">
                {platform.icon} {item.platform || platform.name}
              </span>
              <span className="toolbox-video-success rounded px-1.5 py-0.5 text-xs">视频提取成功</span>
            </div>
            <p className="line-clamp-2 text-sm font-semibold leading-[1.6]" title={title} style={{ color: "var(--foreground)" }}>{title}</p>
            <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]" title={item.url}>{item.url}</p>
            {temporaryVideoUrl && (
              <p className="mt-1 text-xs font-medium text-[var(--warning)]">
                {temporaryExpired
                  ? "临时视频已过期，已停止播放、下载和复制；请重新提取"
                  : "临时视频 · 30分钟内可播放/下载，到期自动清除"}
              </p>
            )}
          </div>

          {downloadError && <p role="alert" className="px-3 pt-2 text-xs text-[var(--error)]">{downloadError}</p>}
          {/* Action buttons */}
          <div className="toolbox-video-actions px-3 pt-2 pb-3 flex items-center gap-2 flex-wrap">
            {canDownload && (
              <button
                onClick={() => handleDownload(downloadUrl, `${title}.mp4`, videoItem?.asset_id)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
                style={{ background: "var(--primary)" }}
              >
                <Download className="w-3 h-3" /> 下载视频
              </button>
            )}
            {canPlay && !showVideo && (
              <button
                onClick={() => void startPlayback()}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ background: "var(--accent)", color: "var(--foreground)" }}
              >
                <Play className="w-3 h-3" /> 播放
              </button>
            )}
            {canPlay && rawVideoUrl && !hasOwnedVideo && (
              <button
                onClick={() => handleCopy(rawVideoUrl)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ background: "var(--accent)", color: copied ? "var(--success)" : "var(--foreground)" }}
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? "已复制" : "复制链接"}
              </button>
            )}
            {!canPlay && !canDownload && (
              <span className="text-xs text-[var(--muted-foreground)]">
                {temporaryExpired ? "临时视频已过期，请重新提取" : "未获取到可交付的视频"}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Batch result item */
function BatchResultItem({ item }: { item: ExtractResult }) {
  const platform = detectPlatform(item.url);

  // Get result text for display
  const getResultText = (): string => {
    if (!item.result) return "";
    if (item.mode === "text") {
      const textItem = item.result.texts?.[0];
      return (textItem?.corrected_content || textItem?.content)?.slice(0, 80) || "";
    }
    const videoItem = item.result.videos?.[0];
    return videoItem?.title || videoItem?.url || "";
  };

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      {item.status === "loading" && <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)] shrink-0" />}
      {item.status === "success" && <Check className="w-4 h-4 text-[var(--success)] shrink-0" />}
      {item.status === "error" && <AlertCircle className="w-4 h-4 text-[var(--error)] shrink-0" />}

      <span className="text-[11px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
        {platform.icon} {platform.name}
      </span>

      <span className="text-[12px] truncate flex-1" style={{ color: "var(--foreground)" }}>
        {getResultText() || (item.url.length > 50 ? item.url.slice(0, 50) + "..." : item.url)}
      </span>

      {item.error && (
        <span className="text-[11px] text-[var(--error)] shrink-0">{item.error}</span>
      )}
    </div>
  );
}
