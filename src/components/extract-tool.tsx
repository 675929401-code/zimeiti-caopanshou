"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useApp } from "@/contexts/app-context";
import { copyToClipboard } from "@/lib/utils";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  readExtractionJsonResponse,
  resolveBrowserClientAttempt,
  type BrowserClientAttempt,
} from "@/lib/extract-client-attempt";
import { downloadExtractMedia, requestExtractDownloadTicket } from "@/lib/extract-download-client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  Search,
  Play,
  Sparkles,
  Users,
  Hash,
  ThumbsUp,
  ListOrdered,
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
  duration?: number;
  width?: number;
  height?: number;
}

interface TextItem {
  row?: number;
  col?: number;
  platform?: string;
  success?: boolean;
  error?: string;
  content?: string;
  corrected_content?: string;
  title?: string;
  source?: string; // "title_only" 表示仅标题无口播, 其他为字段来源名
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
}

interface DouyinWtfResult {
  success: boolean;
  message: string;
  results: Array<{
    input: string;
    success: boolean;
    error?: string;
    video?: DouyinVideoResult;
  }>;
  source: "douyin_wtf";
}

/* ── Video Extract Plugin Response ── */
interface VideoExtractResult {
  row: number;
  col: number;
  platform: string;
  success: boolean;
  url?: string;
  title?: string;
  cover?: string;
  download_url?: string;
  error?: string;
  images?: string[];
}

interface VideoExtractResponse {
  success: boolean;
  results: VideoExtractResult[];
  mode: "video";
  provider: string;
  charged: boolean;
  price: number;
}

/* ── Unified API Response ── */
type ExtractAPIResponse = WorkflowOutput | DouyinWtfResult | VideoExtractResponse;

/* ── Coze Multifunction Extract Types ── */
interface CozeExtractResultItem {
  row: number;
  url: string;
  title: string;
  author: string;
  likes: number;
  success: boolean;
  content?: string;
  error?: string;
}

interface CozeExtractResponse {
  success: boolean;
  message: string;
  error?: string;
  mode: "single_video" | "creator_page" | "search";
  mode_label: string;
  results: CozeExtractResultItem[];
  final_result: string;
  summary: string;
  charged: boolean;
  price: number;
  total_cost: number;
}

/** Convert any API response to WorkflowOutput */
function normalizeResponse(data: Record<string, unknown>): WorkflowOutput {
  // Video extract plugin response (PPT6/cyanlis)
  // 使用显式 key 检查，避免 Turbopack 死代码消除
  const dataMode = data["mode"];
  const dataResults = data["results"];
  if (dataMode === "video" && Array.isArray(dataResults)) {
    const ve = data as unknown as VideoExtractResponse;
    const first = ve.results?.[0];
    if (first?.success && (first.url || first.download_url)) {
      return {
        success: true,
        message: "提取成功",
        videos: [{
          row: first.row ?? 1,
          title: first.title,
          url: first.url || first.download_url,
          download_url: first.download_url || first.url,
          cover: first.cover,
        }],
        texts: [],
        summary: first.title || "视频提取成功",
      };
    }
    return { success: false, message: first?.error || "提取失败", videos: [], texts: [], summary: first?.error || "提取失败" };
  }
  // douyin.wtf response
  if (data["source"] === "douyin_wtf") {
    const wtf = data as unknown as DouyinWtfResult;
    const firstResult = wtf.results?.[0];
    if (firstResult?.video) {
      const v = firstResult.video;
      return {
        success: true,
        message: "提取成功",
        videos: [{
          row: 1,
          title: v.desc,
          url: v.videoUrl,
          download_url: v.downloadUrl,
          cover: v.coverUrl,
          duration: v.duration,
          width: v.width,
          height: v.height,
        }],
        texts: v.desc ? [{ row: 1, content: v.desc, source: "douyin" }] : [],
        summary: v.desc?.slice(0, 60) || "提取成功",
      };
    }
    return { success: false, message: firstResult?.error || wtf.message || "提取失败", videos: [], texts: [], summary: firstResult?.error || wtf.message || "提取失败" };
  }
  return data as unknown as WorkflowOutput;
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
}

/* ── Platform Detection ── */
function detectPlatform(url: string): { name: string; icon: string; color: string } {
  const u = url.toLowerCase();
  if (u.includes("douyin.com") || u.includes("iesdouyin.com"))
    return { name: "抖音", icon: "🎵", color: "#000000" };
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com"))
    return { name: "小红书", icon: "📕", color: "#FE2C55" };
  if (u.includes("kuaishou.com") || u.includes("gifshow.com") || u.includes("v.kuaishou.com"))
    return { name: "快手", icon: "🎬", color: "#FF4906" };
  if (u.includes("weibo.com") || u.includes("weibo.cn"))
    return { name: "微博", icon: "📱", color: "#E6162D" };
  if (u.includes("bilibili.com") || u.includes("b23.tv"))
    return { name: "B站", icon: "📺", color: "#00A1D6" };
  if (u.includes("pipix.com") || u.includes("pipix"))
    return { name: "皮皮虾", icon: "🦐", color: "#FF2855" };
  if (u.includes("huoshan"))
    return { name: "火山", icon: "🌋", color: "#FF2855" };
  return { name: "未知", icon: "🔗", color: "#6B7280" };
}

/* ── Tabs Config ── */
const TABS = [
  { key: "text", label: "文案提取", icon: FileText },
  { key: "coze", label: "智能文案", icon: Sparkles },
  { key: "video", label: "视频提取", icon: Video },
  { key: "batch", label: "批量处理", icon: Package },
  { key: "history", label: "历史记录", icon: History },
] as const;

type TabKey = typeof TABS[number]["key"];

/* ── History Storage ── */
const HISTORY_KEY = "extract_history";
const STATE_KEY = "extract_state";
const EXPIRE_MS = 2 * 24 * 60 * 60 * 1000; // 2天

/** 过滤掉超过2天的记录 */
function filterExpired<T extends { timestamp: number }>(items: T[]): T[] {
  const cutoff = Date.now() - EXPIRE_MS;
  return items.filter(i => i.timestamp > cutoff);
}

function loadHistory(): ExtractResult[] {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (!saved) return [];
    const all: ExtractResult[] = JSON.parse(saved);
    const valid = filterExpired(all);
    if (valid.length !== all.length) {
      // 自动清理过期数据
      localStorage.setItem(HISTORY_KEY, JSON.stringify(valid.slice(0, 100)));
    }
    return valid;
  } catch { return []; }
}
function saveHistory(items: ExtractResult[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(filterExpired(items).slice(0, 100)));
  } catch { /* ignore */ }
}

/* ── Current State Persistence (survives view switch) ── */
interface ExtractPersistState {
  activeTab: TabKey;
  videoUrls: string;
  videoResults: ExtractResult[];
  textUrl: string;
  textResult: ExtractResult | null;
  textCorrections: { homophones: boolean; typos: boolean; punctuation: boolean; completeness: boolean };
  batchUrls: string;
  batchMode: "video" | "text";
  batchResults: ExtractResult[];
  cozeShareText: string;
  cozeMode: "auto" | "single_video" | "creator_page" | "search";
  cozeMinLikes: number;
  cozeMaxCount: number;
  cozeResults: CozeExtractResultItem[];
}

function loadPersistState(): Partial<ExtractPersistState> {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved);
    // 过滤掉过期的 results
    if (parsed.videoResults) parsed.videoResults = filterExpired(parsed.videoResults);
    if (parsed.textResult && parsed.textResult.timestamp < Date.now() - EXPIRE_MS) parsed.textResult = null;
    if (parsed.batchResults) parsed.batchResults = filterExpired(parsed.batchResults);
    return parsed;
  } catch { return {}; }
}
function savePersistState(s: ExtractPersistState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ...s,
      videoResults: filterExpired(s.videoResults),
      batchResults: filterExpired(s.batchResults),
      textResult: s.textResult && s.textResult.timestamp >= Date.now() - EXPIRE_MS ? s.textResult : null,
    }));
  } catch { /* ignore */ }
}

/* ══════════════════════════════════════════
   Extract Tool Component (embedded)
   ══════════════════════════════════════════ */
export default function ExtractTool() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const ps = loadPersistState();
    return ps.activeTab || "text";
  });
  const [history, setHistory] = useState<ExtractResult[]>(loadHistory);

  useEffect(() => { setHistory(loadHistory()); }, []);

  const addHistory = useCallback((item: ExtractResult) => {
    setHistory(prev => {
      const next = [item, ...prev].slice(0, 100);
      saveHistory(next);
      return next;
    });
  }, []);

  const removeHistory = useCallback((id: string) => {
    setHistory(prev => {
      const next = prev.filter(i => i.id !== id);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  // 持久化当前tab
  useEffect(() => {
    savePersistState({ ...loadPersistState() as ExtractPersistState, activeTab });
  }, [activeTab]);

  if (!state.auth.isAuthenticated) return null;

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--background)" }}>
      <main className="flex-1 overflow-y-auto max-w-4xl mx-auto w-full px-4 py-5">
        {/* Tab Navigation */}
        <div className="flex items-center gap-1 mb-5 p-1 rounded-xl" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex-1 justify-center ${
                  isActive
                    ? "brand-action text-white shadow-md"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>
	        
        {/* 帮助提示：在线解析网站 */}
        <div className="mb-4 rounded-xl p-3" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          <p className="text-[11px] text-[var(--muted-foreground)] flex items-center gap-1.5 mb-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            提取失败？试试免费在线解析网站：
          </p>
          <div className="flex flex-wrap gap-2">
            <a 
              href="https://snapany.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: "var(--accent)", color: "var(--foreground)" }}
            >
              🔗 snapany.com（免费无水印）
            </a>
            <a 
              href="https://douyin.wtf" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: "var(--accent)", color: "var(--foreground)" }}
            >
              🔗 douyin.wtf（纯净无广告）
            </a>
          </div>
        </div>

        {activeTab === "video" && <VideoExtractTab addHistory={addHistory} />}
        {activeTab === "text" && <TextExtractTab addHistory={addHistory} />}
        {activeTab === "coze" && <CozeExtractTab addHistory={addHistory} />}
        {activeTab === "batch" && <BatchExtractTab addHistory={addHistory} />}
        {activeTab === "history" && (
          <HistoryTab history={history} onRemove={removeHistory} onClear={clearHistory} />
        )}
      </main>
    </div>
  );
}

/* ══════════════════════════════════════════
   Shared API Call
   ══════════════════════════════════════════ */
async function callExtractAPI(
  token: string,
  userScope: string,
  links: string[],
  extractionMode: string
): Promise<ExtractAPIResponse> {
  const requestPayload = { links, extraction_mode: extractionMode };
  const fingerprint = await buildClientRequestFingerprint(requestPayload);
  const storageKey = `extract-tool:${userScope}:${extractionMode}`;
  const attempt = {
    storageKey,
    ...resolveBrowserClientAttempt({ storageKey, fingerprint, prefix: "extract-tool" }),
  };
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": attempt.clientRequestId,
    },
    body: JSON.stringify({ ...requestPayload, client_request_id: attempt.clientRequestId }),
  });

  const data = await readExtractionJsonResponse<ExtractAPIResponse & {
    error?: string;
    attempt_id?: string;
    provider_call_started?: boolean;
  }>(res);

  settleExtractAttempt(attempt, res.status, data);

  if (!res.ok) {
    throw new Error(`${data.error || "提取失败"}${data.attempt_id ? `（请求号 ${data.attempt_id}）` : ""}`);
  }

  return data as ExtractAPIResponse;
}

function settleExtractAttempt(
  attempt: BrowserClientAttempt & { storageKey: string },
  status: number,
  body: { provider_call_started?: boolean },
) {
  if (status >= 200 && status < 400) {
    clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
    return;
  }
  if (body.provider_call_started === false || (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status))) {
    clearBrowserClientAttempt(attempt.storageKey, attempt.clientRequestId);
  }
}

/* ── Shared download helper ── */
async function downloadVideoFile(token: string, url: string, filename: string) {
  return downloadExtractMedia({
    token,
    url,
    filename: filename.endsWith(".mp4") ? filename : `${filename}.mp4`,
  });
}

/* ══════════════════════════════════════════
   Video Extract Tab
   ══════════════════════════════════════════ */
function VideoExtractTab({ addHistory }: { addHistory: (item: ExtractResult) => void }) {
  const { state } = useApp();
  const auth = state.auth;
  const [urls, setUrls] = useState<string>(() => {
    const ps = loadPersistState();
    return ps.videoUrls || "";
  });
  const [loading, setLoading] = useState(false);
  const extractInFlightRef = useRef(false);
  const [results, setResults] = useState<ExtractResult[]>(() => {
    const ps = loadPersistState();
    return filterExpired(ps.videoResults || []);
  });
  const [batchDownloading, setBatchDownloading] = useState(false);

  // 实时持久化
  useEffect(() => {
    const ps = loadPersistState() as ExtractPersistState;
    savePersistState({ ...ps, videoUrls: urls, videoResults: results });
  }, [urls, results]);

  // 提取后自动清空输入框
  const clearInputAfterExtract = useRef(false);
  useEffect(() => {
    if (clearInputAfterExtract.current && !loading) {
      setUrls("");
      clearInputAfterExtract.current = false;
    }
  }, [loading]);

  // 成功的结果数量
  const successCount = results.filter(r => r.status === "success" && (r.result?.videos?.[0]?.download_url || r.result?.videos?.[0]?.url)).length;

  const handleExtract = async () => {
    if (extractInFlightRef.current) return;
    const linkList = urls.split("\n").map(u => u.trim()).filter(Boolean);
    if (linkList.length === 0) return;

    extractInFlightRef.current = true;
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
      const output = await callExtractAPI(auth.token || "", auth.user?.id || "anonymous", linkList, "video");
      clearInputAfterExtract.current = output.success === true;

      // 直接从 API 响应中提取视频数据，绕过 normalizeResponse（Turbopack 会删除其内部分支）
      const anyOutput = output as unknown as Record<string, unknown>;
      let videoItems: Array<{ title?: string; url?: string; download_url?: string; cover?: string; platform?: string; success?: boolean; error?: string }> = [];

      // 格式1：视频提取插件响应 {mode:"video", results:[{success,url,download_url,cover,title}]}
      if (anyOutput["mode"] === "video" && Array.isArray(anyOutput["results"])) {
        const pluginResults = anyOutput["results"] as Array<Record<string, unknown>>;
        videoItems = pluginResults.map(r => ({
          title: (r["title"] as string) || (r["desc"] as string) || "",
          url: (r["url"] as string) || (r["download_url"] as string) || "",
          download_url: (r["download_url"] as string) || (r["url"] as string) || "",
          cover: (r["cover"] as string) || "",
          platform: (r["platform"] as string) || "",
          success: r["success"] as boolean,
          error: r["error"] as string,
        }));
      }
      // 格式2：douyin.wtf 响应 {source:"douyin_wtf", results:[{video:{...}}]}
      else if (anyOutput["source"] === "douyin_wtf" && Array.isArray(anyOutput["results"])) {
        const wtfResults = anyOutput["results"] as Array<Record<string, unknown>>;
        videoItems = wtfResults.map(r => {
          const v = r["video"] as Record<string, unknown> | undefined;
          return {
            title: (v?.["desc"] as string) || "",
            url: (v?.["videoUrl"] as string) || (v?.["downloadUrl"] as string) || "",
            download_url: (v?.["downloadUrl"] as string) || (v?.["videoUrl"] as string) || "",
            cover: (v?.["coverUrl"] as string) || "",
            success: !!v?.["videoUrl"],
          };
        });
      }
      // 格式3：工作流响应 {videos:[...], texts:[...]}
      else if (Array.isArray(anyOutput["videos"])) {
        videoItems = (anyOutput["videos"] as Array<Record<string, unknown>>).map(v => ({
          title: (v["title"] as string) || "",
          url: (v["url"] as string) || (v["download_url"] as string) || "",
          download_url: (v["download_url"] as string) || (v["url"] as string) || "",
          cover: (v["cover"] as string) || "",
          success: !!(v["url"] || v["download_url"]),
        }));
      }

      for (let i = 0; i < linkList.length; i++) {
        const resultId = newResults[i].id;
        const videoItem = videoItems[i];
        const platform = detectPlatform(linkList[i]);

        if (videoItem && videoItem.success && (videoItem.url || videoItem.download_url)) {
          const updated: ExtractResult = {
            ...newResults[i],
            status: "success",
            platform: videoItem.platform || platform.name,
            result: {
              success: true,
              message: "提取成功",
              videos: [videoItem],
              texts: [],
              summary: videoItem.title || "视频提取成功",
            },
          };
          setResults(prev => prev.map(r => r.id === resultId ? updated : r));
          addHistory(updated);
        } else {
          const updated: ExtractResult = {
            ...newResults[i],
            status: "error",
            platform: videoItem?.platform || platform.name,
            error: videoItem?.error || "提取失败",
          };
          setResults(prev => prev.map(r => r.id === resultId ? updated : r));
          addHistory(updated);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "网络请求失败";
      for (const newResult of newResults) {
        setResults(prev => prev.map(r =>
          r.id === newResult.id ? { ...r, status: "error" as const, error: errorMsg } : r
        ));
        addHistory({ ...newResult, status: "error", error: errorMsg });
      }
    }
    extractInFlightRef.current = false;
    setLoading(false);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrls(prev => prev ? prev + "\n" + text : text);
    } catch { /* clipboard not available */ }
  };

  // 一键批量下载所有成功的结果
  const handleBatchDownload = async () => {
    const downloadable = results.filter(
      r => r.status === "success" && (r.result?.videos?.[0]?.download_url || r.result?.videos?.[0]?.url)
    );
    if (downloadable.length === 0) return;

    setBatchDownloading(true);
    for (let i = 0; i < downloadable.length; i++) {
      const r = downloadable[i];
      const videoItem = r.result?.videos?.[0];
      const url = videoItem?.download_url || videoItem?.url || "";
      const title = videoItem?.title || `video_${i + 1}`;
      if (url) {
        await downloadVideoFile(auth.token || "", url, `${title}.mp4`);
        // 每个下载间隔1秒，避免浏览器拦截
        if (i < downloadable.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    setBatchDownloading(false);
  };

  // 清空所有结果
  const handleClearResults = () => {
    setResults([]);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        <h3 className="text-sm font-semibold mb-3 text-[var(--foreground)] flex items-center gap-2">
          <Video className="w-4 h-4 text-[var(--primary)]" />
          输入视频链接或分享文本
        </h3>
        <div className="relative">
          <Textarea
            value={urls}
            onChange={e => setUrls(e.target.value)}
            placeholder={"直接粘贴分享文本，系统自动解析链接\n\n例如：7.87 Pjm:/ 复制打开抖音，看到【xxx】很棒！ https://v.douyin.com/xxxxx\n\n也支持纯链接：https://v.douyin.com/xxxxx\n多条链接每行一个"}
            className="min-h-[100px] resize-none pr-20 text-sm"
            style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
          />
          <div className="absolute top-2 right-2 flex gap-1">
            <Button variant="ghost" size="sm" onClick={handlePaste} className="h-7 px-2 text-[11px]">
              <ClipboardPaste className="w-3.5 h-3.5" />
            </Button>
            {urls && (
              <Button variant="ghost" size="sm" onClick={() => setUrls("")} className="h-7 px-2 text-[11px]">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-[11px] text-[var(--muted-foreground)]">支持平台：</span>
          {[
            { name: "抖音", icon: "🎵" },
            { name: "小红书", icon: "📕" },
            { name: "快手", icon: "🎬" },
            { name: "微博", icon: "📱" },
            { name: "B站", icon: "📺" },
          ].map(p => (
            <span key={p.name} className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
              {p.icon} {p.name}
            </span>
          ))}
        </div>

        <Button
          onClick={handleExtract}
          disabled={loading || !urls.trim()}
          className="brand-action w-full mt-4 h-10 font-medium"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 提取中...</>
          ) : (
            <><Video className="w-4 h-4 mr-2" /> 开始提取视频</>
          )}
        </Button>
      </div>

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
              <Download className="w-4 h-4 text-[var(--primary)]" />
              提取结果
              <span className="text-[11px] font-normal text-[var(--muted-foreground)]">
                共 {results.length} 条{successCount > 0 && ` · ${successCount} 个可下载`}
              </span>
            </h3>
            <div className="flex items-center gap-2">
              {successCount > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBatchDownload}
                  disabled={batchDownloading}
                  className="h-7 px-3 text-[11px] gap-1"
                  style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                >
                  {batchDownloading ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> 下载中...</>
                  ) : (
                    <><Download className="w-3 h-3" /> 一键全部下载({successCount})</>
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearResults}
                className="h-7 px-2 text-[11px] text-[var(--muted-foreground)] hover:text-red-400"
              >
                <Trash2 className="w-3 h-3 mr-1" /> 清空
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {results.map(item => (
              <VideoResultCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   Text Extract Tab
   ══════════════════════════════════════════ */
function TextExtractTab({ addHistory }: { addHistory: (item: ExtractResult) => void }) {
  const { state } = useApp();
  const auth = state.auth;
  const [url, setUrl] = useState<string>(() => {
    const ps = loadPersistState();
    return ps.textUrl || "";
  });
  const [loading, setLoading] = useState(false);
  const extractInFlightRef = useRef(false);
  const [result, setResult] = useState<ExtractResult | null>(() => {
    const ps = loadPersistState();
    const r = ps.textResult || null;
    if (r && r.timestamp < Date.now() - EXPIRE_MS) return null;
    return r;
  });
  const [corrections, setCorrections] = useState<{ homophones: boolean; typos: boolean; punctuation: boolean; completeness: boolean }>(() => {
    const ps = loadPersistState();
    return ps.textCorrections || { homophones: true, typos: true, punctuation: true, completeness: false };
  });
  const [showOriginal, setShowOriginal] = useState(false);
  const [copied, setCopied] = useState(false);

  // 实时持久化
  useEffect(() => {
    const ps = loadPersistState() as ExtractPersistState;
    savePersistState({ ...ps, textUrl: url, textResult: result, textCorrections: corrections });
  }, [url, result, corrections]);

  const handleExtract = async () => {
    if (extractInFlightRef.current || !url.trim()) return;
    extractInFlightRef.current = true;
    setLoading(true);
    setResult(null);

    try {
      const output = await callExtractAPI(auth.token || "", auth.user?.id || "anonymous", [url.trim()], "text");
      const platform = detectPlatform(url);

      // 统一用 normalizeResponse 处理所有响应格式
      const norm = normalizeResponse(output as unknown as Record<string, unknown>);
      const textItem = norm.texts?.[0];
      const videoItem = norm.videos?.[0];

      const resultItem: ExtractResult = {
        id: `t-${Date.now()}`,
        url: url.trim(),
        platform: textItem?.platform || videoItem?.platform || platform.name,
        mode: "text",
        timestamp: Date.now(),
        status: norm.success !== false && (textItem || videoItem) ? "success" : "error",
        result: norm,
        error: norm.success === false ? norm.message : undefined,
      };
      setResult(resultItem);
      addHistory(resultItem);
    } catch (err) {
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
    }
    extractInFlightRef.current = false;
    setLoading(false);
  };

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 返回: original(原始口播), corrected(纠正后口播), title(视频标题), isTitleOnly(是否仅标题无口播), debugFields(调试字段)
  const getTextContent = (item: ExtractResult | null): { original: string; corrected: string; title: string; isTitleOnly: boolean; debugFields: string[] } => {
    if (!item?.result) return { original: "", corrected: "", title: "", isTitleOnly: false, debugFields: [] };
    const textItem = item.result.texts?.[0];
    const debugFields = item.result.debug_fields || [];
    if (!textItem) {
      return { original: item.result.summary || "", corrected: "", title: "", isTitleOnly: false, debugFields };
    }
    const source = textItem.source || "";
    // source === "title_only" 表示工作流只返回了标题，没有口播内容
    const isTitleOnly = source === "title_only";
    return {
      original: textItem.content || "",
      corrected: textItem.corrected_content || textItem.content || "",
      title: textItem.title || "",
      isTitleOnly,
      debugFields,
    };
  };

  const { original, corrected, title, isTitleOnly, debugFields } = getTextContent(result);
  const displayText = corrected || original;

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        <h3 className="text-sm font-semibold mb-3 text-[var(--foreground)] flex items-center gap-2">
          <FileText className="w-4 h-4 text-[var(--primary)]" />
          输入链接提取文案
        </h3>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="粘贴抖音内容链接"
            className="flex-1 text-sm"
            style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
            onKeyDown={e => e.key === "Enter" && handleExtract()}
          />
          <Button
            onClick={handleExtract}
            disabled={loading || !url.trim()}
            className="brand-action px-5 font-medium shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>

        <div className="mt-4 space-y-2">
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
                  aria-label={opt.label}
                  checked={corrections[opt.key]}
                  onCheckedChange={v => setCorrections(prev => ({ ...prev, [opt.key]: !!v }))}
                  className="data-[state=checked]:bg-[var(--primary)] data-[state=checked]:border-[var(--primary)]"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div className="rounded-xl p-5 flex items-center justify-center py-12 gap-3" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          <Loader2 className="w-5 h-5 animate-spin text-[var(--primary)]" />
          <span className="text-sm text-[var(--muted-foreground)]">正在提取文案，请稍候...</span>
        </div>
      )}

      {result?.status === "error" && (
        <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 py-2 text-red-400">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm">{result.error || "提取失败，请检查链接是否有效"}</span>
          </div>
        </div>
      )}

      {result?.status === "success" && displayText && (
        <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          {/* 仅标题警告 */}
          {isTitleOnly && (
            <div className="mb-3 p-3 rounded-lg flex items-start gap-2" style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)" }}>
              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <span className="text-sm text-amber-600 font-medium">当前仅提取到视频标题，口播内容未提取到</span>
                <span className="text-[11px] text-amber-500/80 block mt-0.5">请检查工作流是否输出了 video_caption 字段</span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: "var(--primary)/15", color: "var(--primary)" }}>
                {detectPlatform(result.url).icon} {result.platform}
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: isTitleOnly ? "rgba(245,158,11,0.15)" : "rgba(34,197,94,0.15)", color: isTitleOnly ? "#f59e0b" : "#22c55e" }}>
                {isTitleOnly ? "仅标题" : "口播文案"}
              </span>
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {new Date(result.timestamp).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {original && corrected && original !== corrected && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowOriginal(!showOriginal)}
                  className="h-7 px-2 text-[11px]"
                >
                  {showOriginal ? <ChevronUp className="w-3.5 h-3.5 mr-1" /> : <ChevronDown className="w-3.5 h-3.5 mr-1" />}
                  {showOriginal ? "隐藏原文" : "查看原文"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy(displayText)}
                className="h-7 px-2 text-[11px]"
              >
                {copied ? <Check className="w-3.5 h-3.5 mr-1 text-green-500" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                {copied ? "已复制" : "复制"}
              </Button>
            </div>
          </div>

          {showOriginal && original && (
            <div className="mb-3 p-3 rounded-lg text-[12px] leading-relaxed border" style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--muted-foreground)" }}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1 block">原文</span>
              <span className="whitespace-pre-wrap">{original}</span>
            </div>
          )}

          {/* 标题区域（如果标题和口播内容都存在，分区展示） */}
          {title && !isTitleOnly && (
            <div className="mb-3 p-3 rounded-lg border" style={{ background: "var(--background)", borderColor: "var(--border)" }}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1 block">视频标题</span>
              <span className="text-[13px] font-medium whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>{title}</span>
            </div>
          )}

          {/* 口播内容区域 */}
          <div className="p-3 rounded-lg text-[13px] leading-[1.7] whitespace-pre-wrap" style={{ background: "var(--background)", color: "var(--foreground)" }}>
            {displayText}
          </div>

          {result.result?.summary && (
            <div className="mt-2 text-[11px] text-[var(--muted-foreground)]">
              {result.result.summary}
            </div>
          )}

          {/* 调试字段（管理员参考） */}
          {debugFields && debugFields.length > 0 && (
            <div className="mt-2 text-[10px] text-[var(--muted-foreground)] opacity-50">
              工作流返回字段: {debugFields.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   Coze Multifunction Extract Tab (扣子智能文案)
   ══════════════════════════════════════════ */
function CozeExtractTab({ addHistory }: { addHistory: (item: ExtractResult) => void }) {
  const { state } = useApp();
  const auth = state.auth;

  const [shareText, setShareText] = useState<string>(() => {
    const ps = loadPersistState() as Partial<ExtractPersistState>;
    return ps.cozeShareText || "";
  });
  const [cozeMode, setCozeMode] = useState<"auto" | "single_video" | "creator_page" | "search">(() => {
    const ps = loadPersistState() as Partial<ExtractPersistState>;
    return ps.cozeMode || "auto";
  });
  const [minLikes, setMinLikes] = useState<number>(() => {
    const ps = loadPersistState() as Partial<ExtractPersistState>;
    return ps.cozeMinLikes ?? 0;
  });
  const [maxCount, setMaxCount] = useState<number>(() => {
    const ps = loadPersistState() as Partial<ExtractPersistState>;
    return ps.cozeMaxCount ?? 10;
  });
  const [loading, setLoading] = useState(false);
  const extractInFlightRef = useRef(false);
  const [cozeResults, setCozeResults] = useState<CozeExtractResultItem[]>(() => {
    const ps = loadPersistState() as Partial<ExtractPersistState>;
    return ps.cozeResults || [];
  });
  const [cozeSummary, setCozeSummary] = useState<string>("");
  const [cozeModeLabel, setCozeModeLabel] = useState<string>("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [allCopied, setAllCopied] = useState(false);

  // 实时持久化
  useEffect(() => {
    const ps = loadPersistState() as ExtractPersistState;
    savePersistState({
      ...ps,
      cozeShareText: shareText,
      cozeMode,
      cozeMinLikes: minLikes,
      cozeMaxCount: maxCount,
      cozeResults,
    });
  }, [shareText, cozeMode, minLikes, maxCount, cozeResults]);

  // 根据输入内容自动推荐模式
  const detectedMode = useMemo<"single_video" | "creator_page" | "search">(() => {
    const text = shareText.trim();
    if (text.includes("/user/")) return "creator_page";
    if (text.includes("/video/") || /https?:\/\//.test(text)) return "single_video";
    return "search";
  }, [shareText]);

  const effectiveMode = cozeMode === "auto" ? detectedMode : cozeMode;

  const handleExtract = async () => {
    if (extractInFlightRef.current || !shareText.trim()) return;
    extractInFlightRef.current = true;
    setLoading(true);
    setCozeResults([]);
    setCozeSummary("");
    setCozeModeLabel("");

    try {
      const requestPayload = {
        share_text: shareText.trim(),
        min_likes: minLikes,
        max_count: maxCount,
        mode: cozeMode === "auto" ? "" : cozeMode === "single_video" ? "video" : cozeMode === "creator_page" ? "homepage" : "search",
      };
      const fingerprint = await buildClientRequestFingerprint(requestPayload);
      const storageKey = `extract-tool:${auth.user?.id || "anonymous"}:coze`;
      const attempt = {
        storageKey,
        ...resolveBrowserClientAttempt({ storageKey, fingerprint, prefix: "extract-coze" }),
      };
      const res = await fetch("/api/extract/coze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token || ""}`,
          "Idempotency-Key": attempt.clientRequestId,
        },
        body: JSON.stringify({
          ...requestPayload,
          client_request_id: attempt.clientRequestId,
        }),
      });

      const data = await readExtractionJsonResponse<CozeExtractResponse & { attempt_id?: string; provider_call_started?: boolean }>(res);
      settleExtractAttempt(attempt, res.status, data);

      if (!res.ok) {
        throw new Error(`${data.error || data.message || "提取失败"}${data.attempt_id ? `（请求号 ${data.attempt_id}）` : ""}`);
      }

      setCozeResults(data.results || []);
      setCozeSummary(data.summary || "");
      setCozeModeLabel(data.mode_label || "");

      // 添加到历史记录
      const successCount = (data.results || []).filter(r => r.success).length;
      const historyItem: ExtractResult = {
        id: `coze-${Date.now()}`,
        url: shareText.trim(),
        platform: "抖音",
        mode: "text",
        timestamp: Date.now(),
        status: successCount > 0 ? "success" : "error",
        result: {
          success: successCount > 0,
          message: data.message,
          videos: [],
          texts: (data.results || []).filter(r => r.success).map(r => ({
            row: r.row,
            content: r.content || "",
            title: r.title,
            source: "coze_extract",
          })),
          summary: data.summary,
        },
        error: successCount === 0 ? data.message : undefined,
      };
      addHistory(historyItem);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "网络请求失败";
      setCozeSummary(errorMsg);
      setCozeResults([]);
    }
    extractInFlightRef.current = false;
    setLoading(false);
  };

  const handleCopyItem = async (text: string, idx: number) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    }
  };

  const handleCopyAll = async () => {
    const allText = cozeResults
      .filter(r => r.success && r.content)
      .map((r) => {
        let text = "";
        if (r.title) text += `【标题】${r.title}\n`;
        if (r.author) text += `【作者】${r.author}\n`;
        if (r.likes > 0) text += `【点赞】${r.likes.toLocaleString()}\n`;
        text += `【文案】${r.content}`;
        return text;
      })
      .join("\n\n---\n\n");

    const ok = await copyToClipboard(allText);
    if (ok) {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    }
  };

  const successCount = cozeResults.filter(r => r.success).length;
  const failCount = cozeResults.filter(r => !r.success).length;

  const modeOptions = [
    { key: "auto" as const, label: "自动识别", icon: Sparkles, desc: "根据输入内容自动判断模式" },
    { key: "single_video" as const, label: "单视频", icon: Video, desc: "视频链接提取文案" },
    { key: "creator_page" as const, label: "博主主页", icon: Users, desc: "博主主页批量提取" },
    { key: "search" as const, label: "搜索提取", icon: Hash, desc: "关键词搜索批量提取" },
  ];

  return (
    <div className="space-y-5">
      {/* 输入区 */}
      <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        {/* 顶部渐变条 */}
        <div className="h-1 -mt-5 -mx-5 mb-4 rounded-t-xl" style={{ background: "linear-gradient(90deg, #8b5cf6, #a855f7)" }} />

        <h3 className="text-sm font-semibold mb-3 text-[var(--foreground)] flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-500" />
          智能文案提取
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-500 font-normal">AI驱动</span>
        </h3>

        {/* 模式选择 */}
        <div className="mb-4">
          <span className="text-[12px] font-medium text-[var(--muted-foreground)] mb-2 block">提取模式</span>
          <div className="grid grid-cols-4 gap-2">
            {modeOptions.map(opt => {
              const Icon = opt.icon;
              const isActive = cozeMode === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => setCozeMode(opt.key)}
                  className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg text-[11px] font-medium transition-all ${
                    isActive
                      ? "brand-action text-white shadow-sm"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                  }`}
                  style={isActive ? undefined : { background: "var(--background)", border: "1px solid var(--border)" }}
                  title={opt.desc}
                >
                  <Icon className="w-4 h-4" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
          {cozeMode === "auto" && shareText.trim() && (
            <p className="text-[11px] text-violet-500 mt-1.5">
              已识别为：<span className="font-medium">{detectedMode === "single_video" ? "单视频模式" : detectedMode === "creator_page" ? "博主主页模式" : "搜索模式"}</span>
            </p>
          )}
        </div>

        {/* 输入框 */}
        <div className="relative">
          <Textarea
            value={shareText}
            onChange={e => setShareText(e.target.value)}
            placeholder={
              effectiveMode === "single_video"
                ? "粘贴抖音视频分享文本或链接\n\n例如：7.87 Pjm:/ 复制打开抖音，看到【xxx】很棒！ https://v.douyin.com/xxxxx\n\n也支持纯链接：https://v.douyin.com/xxxxx"
                : effectiveMode === "creator_page"
                  ? "粘贴抖音博主主页链接或分享文本\n\n例如：https://www.douyin.com/user/MS4wLjABAAAA...\n或博主主页分享文本"
                  : "输入搜索关键词\n\n例如：狗狗情感、美食教程、旅行vlog\n支持多关键词搜索"
            }
            className="min-h-[100px] resize-none pr-20 text-sm"
            style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
          />
          <div className="absolute top-2 right-2 flex gap-1">
            <Button variant="ghost" size="sm" onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                setShareText(prev => prev ? prev + "\n" + text : text);
              } catch { /* clipboard not available */ }
            }} className="h-7 px-2 text-[11px]">
              <ClipboardPaste className="w-3.5 h-3.5" />
            </Button>
            {shareText && (
              <Button variant="ghost" size="sm" onClick={() => setShareText("")} className="h-7 px-2 text-[11px]">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* 参数设置（博主主页和搜索模式显示） */}
        {(effectiveMode === "creator_page" || effectiveMode === "search") && (
          <div className="mt-4 p-3 rounded-lg space-y-3" style={{ background: "var(--background)", border: "1px solid var(--border)" }}>
            <span className="text-[12px] font-medium text-[var(--muted-foreground)] flex items-center gap-1.5">
              <ListOrdered className="w-3.5 h-3.5" />
              提取参数
            </span>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block flex items-center gap-1">
                  <ThumbsUp className="w-3 h-3" />
                  最低点赞数
                </label>
                <Input
                  type="number"
                  min={0}
                  value={minLikes}
                  onChange={e => setMinLikes(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="0=不限"
                  className="h-8 text-sm"
                  style={{ background: "var(--card)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <span className="text-[10px] text-[var(--muted-foreground)] mt-0.5 block">
                  {minLikes === 0 ? "不筛选点赞数" : `仅提取 ${minLikes.toLocaleString()} 赞以上`}
                </span>
              </div>
              <div>
                <label className="text-[11px] text-[var(--muted-foreground)] mb-1 block flex items-center gap-1">
                  <ListOrdered className="w-3 h-3" />
                  最大提取条数
                </label>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={maxCount}
                  onChange={e => setMaxCount(Math.min(30, Math.max(1, parseInt(e.target.value) || 10)))}
                  className="h-8 text-sm"
                  style={{ background: "var(--card)", borderColor: "var(--border)", color: "var(--foreground)" }}
                />
                <span className="text-[10px] text-[var(--muted-foreground)] mt-0.5 block">
                  最多提取 {maxCount} 条视频文案
                </span>
              </div>
            </div>
            {/* 快速点赞阈值 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-[var(--muted-foreground)]">快速设置点赞：</span>
              {[0, 1000, 5000, 10000, 50000].map(v => (
                <button
                  key={v}
                  onClick={() => setMinLikes(v)}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${
                    minLikes === v
                      ? "brand-action text-white"
                      : "hover:bg-[var(--accent)]"
                  }`}
                  style={minLikes === v
                    ? undefined
                    : { background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted-foreground)" }
                  }
                >
                  {v === 0 ? "不限" : v >= 10000 ? `${v / 10000}w` : `${v / 1000}k`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 单视频模式提示 */}
        {effectiveMode === "single_video" && (
          <div className="mt-3 p-2.5 rounded-lg flex items-start gap-2" style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.2)" }}>
            <Video className="w-3.5 h-3.5 text-violet-500 shrink-0 mt-0.5" />
            <div>
              <span className="text-[11px] text-violet-600 font-medium">单视频文案提取</span>
              <span className="text-[10px] text-violet-500/80 block mt-0.5">粘贴抖音分享文本或视频链接，自动提取口播文案</span>
            </div>
          </div>
        )}

        <Button
          onClick={handleExtract}
          disabled={loading || !shareText.trim()}
          className="w-full mt-4 h-10 font-medium"
          style={{ background: "linear-gradient(135deg, #8b5cf6, #a855f7)", color: "white" }}
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> AI提取中...</>
          ) : (
            <><Sparkles className="w-4 h-4 mr-2" /> 开始智能提取</>
          )}
        </Button>
      </div>

      {/* 结果区 */}
      {loading && (
        <div className="rounded-xl p-5 flex items-center justify-center py-12 gap-3" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
          <div>
            <span className="text-sm text-[var(--muted-foreground)]">AI正在提取文案，请稍候...</span>
            <span className="text-[11px] text-violet-500/60 block mt-0.5">批量提取可能需要1-2分钟</span>
          </div>
        </div>
      )}

      {!loading && cozeResults.length > 0 && (
        <div className="space-y-3">
          {/* 结果统计栏 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-violet-500" />
                提取结果
              </h3>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-500">
                {cozeModeLabel}
              </span>
              <span className="text-[11px] text-[var(--muted-foreground)]">
                共 {cozeResults.length} 条 · 成功 {successCount} 条{failCount > 0 ? ` · 失败 ${failCount} 条` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {successCount > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyAll}
                  className="h-7 px-3 text-[11px] gap-1"
                  style={{ borderColor: "var(--border)", color: "var(--foreground)" }}
                >
                  {allCopied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                  {allCopied ? "已复制全部" : "复制全部文案"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setCozeResults([]); setCozeSummary(""); }}
                className="h-7 px-2 text-[11px] text-[var(--muted-foreground)] hover:text-red-400"
              >
                <Trash2 className="w-3 h-3 mr-1" /> 清空
              </Button>
            </div>
          </div>

          {/* 结果列表 */}
          <div className="space-y-2">
            {cozeResults.map((item, idx) => (
              <div
                key={idx}
                className="rounded-xl overflow-hidden"
                style={{ background: "var(--card)", border: "1px solid var(--border)" }}
              >
                {/* 结果头部 */}
                <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: item.success ? "1px solid var(--border)" : "none" }}>
                  {item.success ? (
                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  )}
                  <span className="text-[11px] font-medium px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
                    #{item.row}
                  </span>
                  {item.title && (
                    <span className="text-[12px] font-medium truncate flex-1" style={{ color: "var(--foreground)" }}>
                      {item.title}
                    </span>
                  )}
                  {item.author && (
                    <span className="text-[11px] text-violet-500 shrink-0 flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {item.author}
                    </span>
                  )}
                  {item.likes > 0 && (
                    <span className="text-[11px] text-amber-500 shrink-0 flex items-center gap-0.5">
                      <ThumbsUp className="w-3 h-3" />
                      {item.likes >= 10000 ? `${(item.likes / 10000).toFixed(1)}w` : item.likes.toLocaleString()}
                    </span>
                  )}
                  {item.success && item.content && (
                    <button
                      onClick={() => handleCopyItem(item.content!, idx)}
                      className="shrink-0 text-[var(--muted-foreground)] hover:text-violet-500 transition-colors"
                    >
                      {copiedIdx === idx ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>

                {/* 文案内容 */}
                {item.success && item.content && (
                  <div className="px-4 py-3">
                    <p className="text-[13px] leading-[1.7] whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>
                      {item.content}
                    </p>
                  </div>
                )}

                {/* 错误信息 */}
                {!item.success && item.error && (
                  <div className="px-4 py-2">
                    <p className="text-[11px] text-red-400">{item.error}</p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 汇总信息 */}
          {cozeSummary && (
            <div className="text-[11px] text-[var(--muted-foreground)] text-center pt-1">
              {cozeSummary}
            </div>
          )}
        </div>
      )}

      {/* 空状态 - 无结果且不在加载 */}
      {!loading && cozeResults.length === 0 && cozeSummary && (
        <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 py-2 text-red-400">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm">{cozeSummary}</span>
          </div>
        </div>
      )}

      {/* 使用说明 */}
      <div className="rounded-xl p-4" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        <h4 className="text-[12px] font-medium text-[var(--muted-foreground)] mb-2">使用说明</h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
          <div className="flex items-start gap-2 p-2 rounded-lg" style={{ background: "var(--background)" }}>
            <Video className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-medium text-[var(--foreground)]">单视频提取</span>
              <span className="text-[var(--muted-foreground)] block">粘贴抖音分享文本或视频链接，提取口播文案</span>
            </div>
          </div>
          <div className="flex items-start gap-2 p-2 rounded-lg" style={{ background: "var(--background)" }}>
            <Users className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-medium text-[var(--foreground)]">博主主页批量</span>
              <span className="text-[var(--muted-foreground)] block">输入博主主页链接，按点赞数筛选批量提取</span>
            </div>
          </div>
          <div className="flex items-start gap-2 p-2 rounded-lg" style={{ background: "var(--background)" }}>
            <Hash className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-medium text-[var(--foreground)]">搜索批量提取</span>
              <span className="text-[var(--muted-foreground)] block">输入关键词搜索，批量提取相关视频文案</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   Batch Extract Tab
   ══════════════════════════════════════════ */
function BatchExtractTab({ addHistory }: { addHistory: (item: ExtractResult) => void }) {
  const { state } = useApp();
  const auth = state.auth;
  const [urls, setUrls] = useState<string>(() => {
    const ps = loadPersistState();
    return ps.batchUrls || "";
  });
  const [mode, setMode] = useState<"video" | "text">(() => {
    const ps = loadPersistState();
    return ps.batchMode || "video";
  });
  const [processing, setProcessing] = useState(false);
  const extractInFlightRef = useRef(false);
  const [progress, setProgress] = useState({ total: 0, done: 0, success: 0, fail: 0 });
  const [batchResults, setBatchResults] = useState<ExtractResult[]>(() => {
    const ps = loadPersistState();
    return filterExpired(ps.batchResults || []);
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 实时持久化
  useEffect(() => {
    const ps = loadPersistState() as ExtractPersistState;
    savePersistState({ ...ps, batchUrls: urls, batchMode: mode, batchResults });
  }, [urls, mode, batchResults]);

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
    const linkList = urls.split("\n").map(u => u.trim()).filter(Boolean);
    if (linkList.length === 0) return;

    extractInFlightRef.current = true;
    setProcessing(true);
    setProgress({ total: linkList.length, done: 0, success: 0, fail: 0 });
    setBatchResults([]);

    const results: ExtractResult[] = [];
    try {
      const output = await callExtractAPI(auth.token || "", auth.user?.id || "anonymous", linkList, mode);
      const normalized = normalizeResponse(output as unknown as Record<string, unknown>);
      const items = mode === "video" ? normalized.videos : normalized.texts;

      for (let i = 0; i < linkList.length; i++) {
        const url = linkList[i];
        const item = items?.[i];
        const platform = detectPlatform(url);
        const itemSucceeded = Boolean(item && item.success !== false && (mode === "video"
          ? (item as VideoItem).download_url || (item as VideoItem).url
          : (item as TextItem).corrected_content || (item as TextItem).content));

        const resultItem: ExtractResult = {
          id: `b-${Date.now()}-${i}`,
          url,
          platform: item?.platform || platform.name,
          mode,
          timestamp: Date.now(),
          status: itemSucceeded ? "success" : "error",
          result: { ...normalized, success: itemSucceeded, videos: mode === "video" && item ? [item as VideoItem] : [], texts: mode === "text" && item ? [item as TextItem] : [] },
          error: itemSucceeded ? undefined : item?.error || "接口未返回该条目的有效结果",
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
      for (let i = 0; i < linkList.length; i++) {
        const resultItem: ExtractResult = {
          id: `b-${Date.now()}-${i}`,
          url: linkList[i],
          platform: detectPlatform(linkList[i]).name,
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

  const progressPct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <div className="space-y-5">
      <div className="rounded-xl p-5" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
        <h3 className="text-sm font-semibold mb-3 text-[var(--foreground)] flex items-center gap-2">
          <Package className="w-4 h-4 text-[var(--primary)]" />
          批量提取
        </h3>

        <div className="flex gap-2 mb-3">
          {(["video", "text"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                mode === m
                  ? "brand-action text-white"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
              }`}
            >
              {m === "video" ? <Video className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
              {m === "video" ? "视频提取" : "文案提取"}
            </button>
          ))}
        </div>

        <Textarea
          value={urls}
          onChange={e => setUrls(e.target.value)}
          placeholder={"每行一个链接，支持批量提取\n也可点击下方按钮上传TXT文件"}
          className="min-h-[120px] resize-none text-sm"
          style={{ background: "var(--background)", borderColor: "var(--border)", color: "var(--foreground)" }}
        />

        <div className="flex items-center gap-2 mt-2">
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
        </div>

        <Button
          onClick={handleBatchExtract}
          disabled={processing || !urls.trim()}
          className="brand-action w-full mt-4 h-10 font-medium"
        >
          {processing ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> 处理中 ({progress.done}/{progress.total})</>
          ) : (
            <><Package className="w-4 h-4 mr-2" /> 开始批量提取</>
          )}
        </Button>

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
          <h3 className="text-sm font-semibold text-[var(--foreground)]">处理结果</h3>
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
function HistoryTab({ history, onRemove, onClear }: {
  history: ExtractResult[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { state } = useApp();
  const auth = state.auth;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
      const textItem = item.result.texts?.[0];
      return textItem?.corrected_content || textItem?.content || item.result.summary || "";
    }
    const videoItem = item.result.videos?.[0];
    if (videoItem?.url || videoItem?.download_url) {
      return videoItem.title || videoItem.url || videoItem.download_url || "";
    }
    return item.result.summary || JSON.stringify(item.result, null, 2);
  };

  return (
    <div className="space-y-4">
      {history.length > 0 && (
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const allIds = new Set(history.map(i => i.id));
                setSelectedIds(prev => prev.size === allIds.size ? new Set() : allIds);
              }}
              className="text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              {selectedIds.size === history.length ? "取消全选" : "全选"}
            </Button>
            {selectedIds.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const items = history.filter(i => selectedIds.has(i.id) && i.mode === "video" && i.result?.videos?.[0]?.download_url);
                  for (let i = 0; i < items.length; i++) {
                    const v = items[i].result!.videos![0];
                    await downloadVideoFile(
                      auth.token || "",
                      v.download_url || v.url!,
                      `${v.title || "video"}_${i + 1}.mp4`,
                    );
                    await new Promise(r => setTimeout(r, 800));
                  }
                  setSelectedIds(new Set());
                }}
                className="text-[12px] text-[var(--primary)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/10"
              >
                <Download className="w-3.5 h-3.5 mr-1" /> 下载选中 ({selectedIds.size})
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="text-[12px] text-red-400 hover:text-red-500 hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" /> 清空历史
          </Button>
        </div>
      )}

      {history.length === 0 && (
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
                className="rounded-lg p-3 transition-colors cursor-pointer hover:bg-[var(--accent)]"
                style={{ background: "var(--card)", border: "1px solid var(--border)" }}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Checkbox
                      aria-label={`${selectedIds.has(item.id) ? "取消选择" : "选择"}${item.mode === "video" ? "视频" : "文案"}提取记录`}
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={(checked) => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                      onClick={e => e.stopPropagation()}
                      className="shrink-0"
                    />
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
                    {item.status === "success" && <Check className="w-3.5 h-3.5 text-green-500" />}
                    {item.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                    {item.status === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" />}
                    <button
                      onClick={e => { e.stopPropagation(); onRemove(item.id); }}
                      className="text-[var(--muted-foreground)] hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {expandedId === item.id && (
                  <div className="mt-2 pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                    <p className="text-[12px] text-[var(--muted-foreground)] break-all">
                      链接: {item.url}
                    </p>
                    {item.error && (
                      <p className="text-[12px] text-red-400 mt-1">错误: {item.error}</p>
                    )}
                    {item.result?.summary && (
                      <p className="text-[12px] text-[var(--muted-foreground)] mt-1">{item.result.summary}</p>
                    )}
                    {getHistoryText(item) && (
                      <div className="mt-2 p-2 rounded text-[12px] whitespace-pre-wrap max-h-[200px] overflow-y-auto" style={{ background: "var(--background)", color: "var(--foreground)" }}>
                        {getHistoryText(item)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════
   Shared Sub-Components
   ══════════════════════════════════════════ */

function VideoResultCard({ item }: { item: ExtractResult }) {
  const { state } = useApp();
  const auth = state.auth;
  const [copied, setCopied] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [signedVideoUrl, setSignedVideoUrl] = useState("");
  const platform = detectPlatform(item.url);

  const videoItem = item.result?.videos?.[0];
  const rawVideoUrl = videoItem?.url || videoItem?.download_url || "";
  const downloadUrl = videoItem?.download_url || videoItem?.url || "";
  const canPlay = Boolean(rawVideoUrl);
  const title = videoItem?.title || item.url;
  const coverUrl = videoItem?.cover || "";
  const summary = item.result?.summary || "";

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const startPlayback = async () => {
    if (!rawVideoUrl || videoLoading) return;
    setShowVideo(true);
    setVideoLoading(true);
    setVideoError(false);
    try {
      const ticket = await requestExtractDownloadTicket({
        token: auth.token || "",
        url: rawVideoUrl,
        filename: `${title}.mp4`,
        mode: "play",
      });
      setSignedVideoUrl(ticket.url);
    } catch (error) {
      setSignedVideoUrl("");
      setVideoError(true);
      console.error("[extract-tool] 播放凭证获取失败:", error instanceof Error ? error.message : "unknown");
    } finally {
      setVideoLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadUrl) return;
    try {
      await downloadVideoFile(auth.token || "", downloadUrl, `${title}.mp4`);
    } catch (error) {
      setVideoError(true);
      setShowVideo(true);
      console.error("[extract-tool] 下载凭证获取失败:", error instanceof Error ? error.message : "unknown");
    }
  };

  return (
    <div
      className="rounded-xl overflow-hidden transition-all hover:shadow-md"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      {item.status === "loading" && (
        <div className="flex items-center justify-center py-8 gap-2 text-[var(--muted-foreground)]">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">提取中...</span>
        </div>
      )}

      {item.status === "error" && (
        <div className="p-4">
          <div className="flex items-center gap-2 text-red-400 mb-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-[12px] font-medium">提取失败</span>
          </div>
          <p className="text-[12px] text-[var(--muted-foreground)]">{item.error || "请检查链接是否有效"}</p>
        </div>
      )}

      {item.status === "success" && (
        <>
          {/* Video Player / Cover */}
          {showVideo && canPlay ? (
            <div className="relative bg-black">
              {videoLoading ? (
                <div className="w-full aspect-video flex items-center justify-center text-white/80 gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">正在获取安全播放凭证...</span>
                </div>
              ) : videoError || !signedVideoUrl ? (
                <div className="w-full aspect-video flex flex-col items-center justify-center text-white/80 gap-3 px-4 text-center">
                  <AlertCircle className="w-9 h-9 text-amber-400" />
                  <p className="text-sm">播放凭证不可用，请重新登录或尝试下载</p>
                </div>
              ) : (
                <video
                  src={signedVideoUrl}
                  controls
                  autoPlay
                  muted
                  playsInline
                  preload="metadata"
                  className="w-full aspect-video object-contain"
                  poster={coverUrl}
                  onError={() => setVideoError(true)}
                />
              )}
              <button
                onClick={() => { setShowVideo(false); setVideoError(false); setSignedVideoUrl(""); }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : coverUrl ? (
            <div className="relative aspect-video bg-black/5 overflow-hidden cursor-pointer group">
              {/* eslint-disable-next-line @next/next/no-img-element -- Runtime third-party CDN URL must retain its original signature. */}
              <img src={coverUrl} alt={title} className="w-full h-full object-cover" />
              {canPlay && (
                <button
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
            <div
              className="relative aspect-video bg-black/5 overflow-hidden cursor-pointer flex items-center justify-center"
              onClick={() => void startPlayback()}
            >
              <div className="w-14 h-14 rounded-full bg-[var(--primary)]/20 flex items-center justify-center">
                <Play className="w-7 h-7 text-[var(--primary)] ml-1" />
              </div>
            </div>
          ) : null}

          <div className="p-3 pb-2">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: platform.color }}>
                {platform.icon} {item.platform || platform.name}
              </span>
              {summary && (
                <span className="text-[10px] text-[var(--muted-foreground)] truncate">
                  {summary}
                </span>
              )}
            </div>
            <p className="text-[12px] font-medium line-clamp-2" style={{ color: "var(--foreground)" }}>
              {title}
            </p>
          </div>

          <div className="px-3 pb-3 flex items-center gap-2">
            {downloadUrl && (
              <button
                onClick={() => void handleDownload()}
                className="brand-action flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              >
                <Download className="w-3 h-3" /> 下载视频
              </button>
            )}
            {canPlay && !showVideo && (
              <button
                onClick={() => void startPlayback()}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                style={{ background: "var(--accent)", color: "var(--foreground)" }}
              >
                <Play className="w-3 h-3" /> 播放
              </button>
            )}
            {canPlay && (
              <button
                onClick={() => handleCopy(rawVideoUrl)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                style={{ background: "var(--accent)", color: copied ? "green" : "var(--foreground)" }}
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? "已复制" : "复制链接"}
              </button>
            )}
            {!canPlay && !downloadUrl && (
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {summary || "未获取到视频链接"}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BatchResultItem({ item }: { item: ExtractResult }) {
  const platform = detectPlatform(item.url);

  const getResultText = (): string => {
    if (!item.result) return "";
    if (item.mode === "text") {
      const textItem = item.result.texts?.[0];
      return textItem?.content?.slice(0, 80) || "";
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
      {item.status === "success" && <Check className="w-4 h-4 text-green-500 shrink-0" />}
      {item.status === "error" && <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}

      <span className="text-[11px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--accent)", color: "var(--muted-foreground)" }}>
        {platform.icon} {platform.name}
      </span>

      <span className="text-[12px] truncate flex-1" style={{ color: "var(--foreground)" }}>
        {getResultText() || (item.url.length > 50 ? item.url.slice(0, 50) + "..." : item.url)}
      </span>

      {item.error && (
        <span className="text-[11px] text-red-400 shrink-0">{item.error}</span>
      )}
    </div>
  );
}
