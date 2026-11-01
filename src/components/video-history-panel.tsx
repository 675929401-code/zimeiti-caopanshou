"use client";
/* eslint-disable @next/next/no-img-element -- Covers include browser Blob URLs and upstream images; never proxy them through the image optimizer. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, Film, Loader2, Play, RefreshCw, Trash2, X } from "lucide-react";
import { mergeStoryboardHistory, storyboardLocalVideoError, StoryboardLocalVideoError, StoryboardLocalVideoSession, type StoryboardLocalVideoEntry } from "@/lib/storyboard-local-video-cache";
import { groupVideoHistory, isVideoHistoryExpired, isVideoHistoryProtected, videoHistoryTerminalTime, VIDEO_HISTORY_RETENTION_MS, type VideoHistorySurface } from "@/lib/video-history-policy";
import { compactPublicVideoModelName } from "@/lib/video-history-presentation";
import { storyboardRecordState } from "@/lib/storyboard-history-view";
import { mergeStoryboardInlineHistory } from "@/lib/storyboard-history-local-view";
import { videoDownloadFile } from "@/lib/video-download-file";
import { MediaHistoryVideoNetworkError, requestMediaHistoryVideoUrl } from "@/lib/media-history-video-preview";
import { offlineAccessAllowed, recordOfflineSession, recordOfflineTask, subscribeOfflineAuthRevocation, suspendOfflineTask } from "@/lib/media-history-offline-auth";
import { publishVideoHistoryRemoval, subscribeVideoHistoryRemovals } from "@/lib/video-history-removal-sync";
import { StoryboardHistoryBrowser } from "./storyboard-history-browser";
import "./storyboard-history-panel.css";

export interface VideoHistoryItem {
  taskId: string; batchId?: string; batchTopic?: string; cardIndex?: number;
  status: string; createdAt: string; completedAt?: string; posterUrl?: string;
  modelName?: string; duration?: number; hidden?: boolean; tombstone?: boolean;
  videoUrl?: string; storageUrl?: string; taskLabel?: string; prompt?: string;
  resolution?: string; aspectRatio?: string; durationSeconds?: number;
  billingState?: string; priceCharged?: number; errorMessage?: string; canRetry?: boolean;
  progress?: number; statusDetail?: string;
  deliveryState?: "saving" | "saved" | "failed" | "expired"; retainedUntil?: string; mediaAvailable?: boolean;
}
export interface VideoHistoryPanelProps {
  open: boolean; onClose: () => void; userId: string; token: string;
  items: readonly VideoHistoryItem[]; loading: boolean; error?: string;
  onRefresh: () => void; recoveryContent?: ReactNode;
  surface?: VideoHistorySurface; presentation?: "dialog" | "inline";
  hasMore?: boolean; onLoadMore?: () => void; onRetry?: (taskId: string) => void;
  selectedTaskIds?: readonly string[] | ReadonlySet<string>;
  onToggleSelect?: (taskId: string) => void; onCleared?: (taskIds: string[]) => void;
}
const statusLabel = (status: string) => ({ completed: "已完成", failed: "失败", cancelled: "已取消", expired: "已过期", billing_pending: "费用确认中", pending: "等待中", queued: "排队中", processing: "生成中", generating: "生成中", finalizing: "处理中" }[status] || "待确认");
const ACTIVE_STATUSES = new Set(["queued", "pending", "processing", "generating", "finalizing"]);
const isActiveStatus = (status: string) => ACTIVE_STATUSES.has(status);
const elapsedLabel = (createdAt?: string) => {
  const started = Date.parse(String(createdAt || ""));
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const previewExpired = (item: VideoHistoryItem, local: boolean) => (!local && item.deliveryState === "expired") || isVideoHistoryExpired(item) || (local && Number.isFinite(videoHistoryTerminalTime(item)) && Date.now() - videoHistoryTerminalTime(item) >= VIDEO_HISTORY_RETENTION_MS);
const safePoster = (value?: string) => {
  if (!value) return "";
  if (value.startsWith("blob:") || value.startsWith("data:image/")) return value;
  if (value.startsWith("/") && !value.startsWith("//")) {
    // History cards load via <img> (no Bearer). Keep same-origin thumbnail only when media_ticket is present.
    if (value.includes("/api/video/thumbnail")) {
      try {
        const parsed = new URL(value, window.location.origin);
        if (!parsed.searchParams.get("media_ticket")) return "";
        return value;
      } catch {
        return "";
      }
    }
    return value;
  }
  try { return new URL(value).protocol === "https:" ? value : ""; } catch { return ""; }
};
async function ticket(taskId: string, token: string, scope: "playback" | "download" | "thumbnail", signal: AbortSignal, userId: string) {
  if (scope !== "thumbnail") return requestMediaHistoryVideoUrl(`/api/video/storage/${taskId}`, token, { signal, userId, download: scope === "download" });
  const response = await fetch(`/api/video/access-ticket?${new URLSearchParams({ taskId, scope })}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
  if (!response.ok) await panelHttpDenial(response.status, userId, token, taskId, () => !signal.aborted);
  const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
  const raw = typeof data.url === "string" ? data.url : "";
  const parsed = new URL(raw || "/", window.location.origin);
  const pathOk = parsed.pathname.startsWith("/api/video/thumbnail/");
  if (!response.ok || !raw.startsWith("/") || raw.startsWith("//") || parsed.origin !== window.location.origin || !pathOk || !parsed.searchParams.has("media_ticket")) throw new Error(data.error || "无法取得视频地址，请重新加载");
  return raw;
}
/** Replacement URLs render a fresh image, including after an expired ticket. */
function VideoHistoryCover({ item, token, userId, localPoster }: { item: VideoHistoryItem; token: string; userId: string; localPoster?: string }) {
  const initial = localPoster || safePoster(item.posterUrl);
  const [url, setUrl] = useState(initial);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // Generating cards can receive their first signed cover after this component
    // mounted. Keep an already loaded image stable when polling re-signs it.
    if (initial && attempt === 0 && !loaded) { setUrl(initial); setFailed(false); }
  }, [initial, attempt, loaded]);
  const shouldRequestCover = item.status === "completed"
    && (item.mediaAvailable !== false || Boolean(localPoster))
    && !(initial && attempt === 0);
  useEffect(() => {
    if (!shouldRequestCover) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    const delay = window.setTimeout(() => {
      timeout = window.setTimeout(() => { controller.abort(); setFailed(true); }, 15000);
      void ticket(item.taskId, token, "thumbnail", controller.signal, userId)
        .then(value => { if (!controller.signal.aborted) { setUrl(value); setFailed(false); } })
        .catch(() => { if (!controller.signal.aborted) setFailed(true); })
        .finally(() => window.clearTimeout(timeout));
    }, attempt ? 30000 * attempt : 0);
    return () => { controller.abort(); window.clearTimeout(timeout); window.clearTimeout(delay); };
  }, [item.taskId, token, userId, shouldRequestCover, attempt]);
  const fail = () => {
    setUrl(""); setLoaded(false);
    // Image loads cannot expose Retry-After. Wait at least the server's 30s
    // cooldown; bounded retries also recover cards queued behind slow captures.
    if (attempt < 3) { setFailed(false); setAttempt(value => value + 1); }
    else setFailed(true);
  };
  return <>
    {url && <img key={url} src={url} alt={item.cardIndex == null ? "视频首帧" : `第${item.cardIndex + 1}段视频首帧`} loading="lazy" onLoad={() => setLoaded(true)} onError={fail} />}
    {item.status === "completed" && !loaded && <span className="sbh-cover-hint">{item.mediaAvailable === false && !localPoster ? "视频来源不可用" : failed ? "首帧暂不可用 · 可点击尝试播放" : "正在读取视频首帧…"}</span>}
  </>;
}
function deliveryLabel(item: VideoHistoryItem) {
  if (item.deliveryState === "expired") return "云端缓存已到期 · 任务记录仍保留";
  if (item.mediaAvailable === false) return "云端媒体暂不可用 · 任务记录仍保留";
  if (item.deliveryState === "saving") return "后台保存中 · 可立即播放";
  if (item.deliveryState === "failed") return "后台保存暂未完成 · 建议及时下载";
  if (item.deliveryState !== "saved") return "";
  const until = Date.parse(item.retainedUntil || "");
  return Number.isFinite(until) ? `服务器已保存 · 至 ${new Date(until).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "服务器已保存";
}
function downloadUrl(url: string, name: string) {
  const link = document.createElement("a"); link.href = url; link.download = name; link.rel = "noreferrer"; link.target = "_blank";
  document.body.appendChild(link); link.click(); link.remove();
}

type PanelWritable = { write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> };
type SaveFilePicker = (options?: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable: () => Promise<PanelWritable> }>;
type DirectoryPicker = () => Promise<{ getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{ createWritable: () => Promise<PanelWritable> }> }>;

const pickerWindow = () => window as unknown as { showSaveFilePicker?: SaveFilePicker; showDirectoryPicker?: DirectoryPicker };
type PanelMediaAccess = { userId: string; token: string; taskId: string; signal: AbortSignal; session: Pick<StoryboardLocalVideoSession, "load"> | null; current: () => boolean };
async function panelHttpDenial(status: number, userId: string, token: string, taskId: string | undefined, current: () => boolean) {
  if (status === 401 || status === 403) await recordOfflineSession(userId, token, "denied", current);
  else if ((status === 404 || status === 410) && taskId) await recordOfflineTask(userId, token, taskId, true, current);
}
function assertPanelMediaCurrent(access: PanelMediaAccess) {
  if (access.signal.aborted || !access.current()) throw new DOMException("媒体操作已取消", "AbortError");
}
async function panelLocalFallback(access: PanelMediaAccess, failure: unknown): Promise<Blob> {
  assertPanelMediaCurrent(access);
  if (!(failure instanceof MediaHistoryVideoNetworkError) || !access.session
    || !await offlineAccessAllowed(access.userId, access.token, access.taskId)) throw failure;
  assertPanelMediaCurrent(access);
  const blob = await access.session.load(access.taskId);
  assertPanelMediaCurrent(access);
  if (!await offlineAccessAllowed(access.userId, access.token, access.taskId)) throw new Error("当前作品尚未重新验证，无法读取本机副本");
  assertPanelMediaCurrent(access);
  if (!blob?.size || !blob.type.startsWith("video/")) throw new Error("本机视频副本暂不可用");
  return blob;
}
async function readPanelVideo(access: PanelMediaAccess): Promise<Blob> {
  assertPanelMediaCurrent(access);
  try {
    const url = await ticket(access.taskId, access.token, "download", access.signal, access.userId);
    assertPanelMediaCurrent(access);
    let response: Response;
    try { response = await fetch(url, { cache: "no-store", signal: access.signal }); }
    catch (failure) {
      assertPanelMediaCurrent(access);
      if (failure instanceof TypeError || (failure instanceof DOMException && failure.name === "NetworkError")) throw new MediaHistoryVideoNetworkError();
      throw failure;
    }
    assertPanelMediaCurrent(access);
    if (!response.ok) {
      await panelHttpDenial(response.status, access.userId, access.token, access.taskId, access.current);
      throw new Error(`视频读取失败（${response.status}）`);
    }
    // Count the actual stream even when Content-Length is absent or dishonest.
    // This bounded Blob path supports the browser-download fallback as well as pickers.
    const limit = 128 * 1024 * 1024;
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const length = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const tooLarge = "视频超过本页单文件 128 MB 下载上限，请使用作品页下载入口保存";
    if (response.status !== 200 || response.headers.has("content-range") || (encoding && encoding.toLowerCase() !== "identity")) { await response.body?.cancel(); throw new Error("视频响应不是完整文件，请刷新后重试下载"); }
    if (!type.startsWith("video/") || (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length))))) { await response.body?.cancel(); throw new Error("视频响应格式无效，请刷新后重试下载"); }
    if (length !== null && Number(length) > limit) { await response.body?.cancel(); throw new Error(tooLarge); }
    if (!response.body) throw new Error("视频内容为空，请刷新后重试下载");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        assertPanelMediaCurrent(access);
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error(tooLarge);
        const chunk = new Uint8Array(value.byteLength); chunk.set(value); chunks.push(chunk);
      }
    } catch (failure) { await reader.cancel().catch(() => {}); throw failure; }
    finally { reader.releaseLock(); }
    if (length !== null && size !== Number(length)) throw new Error("视频内容不完整，请刷新后重试下载");
    const blob = new Blob(chunks, { type });
    assertPanelMediaCurrent(access);
    if (!blob.size || !blob.type.startsWith("video/")) throw new Error("视频文件格式无效，请重新加载后下载");
    return blob;
  } catch (failure) {
    const blob = await panelLocalFallback(access, failure);
    if (blob.size > 128 * 1024 * 1024) throw new Error("视频超过本页单文件 128 MB 下载上限，请使用作品页下载入口保存");
    return blob;
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  try { downloadUrl(url, name); }
  finally { window.setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

const isPickerActivationError = (failure: unknown) => failure instanceof DOMException && failure.name === "SecurityError";

/** 单文件：弹出系统“另存为”，用户自己选目录和文件名。 */
async function saveWithPicker(load: () => Promise<Blob>, name: string, signal?: AbortSignal) {
  const picker = pickerWindow().showSaveFilePicker;
  const blob = await load();
  signal?.throwIfAborted();
  const file = videoDownloadFile(name, blob.type);
  if (!picker) { downloadBlob(blob, file.name); return "fallback" as const; }
  let handle: Awaited<ReturnType<SaveFilePicker>>;
  try { handle = await picker({ suggestedName: file.name, types: [{ description: "视频文件", accept: { [file.mime]: [file.extension] } }] }); }
  catch (failure) {
    // A slow ticket/media read may outlive browser user activation. The already
    // fetched bytes remain downloadable without opening another system picker.
    if (!isPickerActivationError(failure)) throw failure;
    signal?.throwIfAborted(); downloadBlob(blob, file.name); return "fallback" as const;
  }
  signal?.throwIfAborted();
  const writable = await handle.createWritable();
  try { signal?.throwIfAborted(); await writable.write(blob); signal?.throwIfAborted(); await writable.close(); }
  catch (failure) { await writable.abort?.().catch(() => {}); throw failure; }
  return "picked" as const;
}

/** 批量：只选一次文件夹，逐个写入，文件名沿用卡片段号。 */
async function saveManyToDirectory(files: Array<{ load: () => Promise<Blob>; name: string }>, signal?: AbortSignal, onProgress?: (done: number, total: number, name: string) => void) {
  const picker = pickerWindow().showDirectoryPicker;
  let directory: Awaited<ReturnType<DirectoryPicker>> | undefined;
  try { directory = picker ? await picker() : undefined; }
  catch (failure) { if (!isPickerActivationError(failure)) throw failure; }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const blob = await file.load();
    signal?.throwIfAborted();
    const deliveredFile = videoDownloadFile(file.name, blob.type);
    if (!directory) { downloadBlob(blob, deliveredFile.name); onProgress?.(index + 1, files.length, deliveredFile.name); continue; }
    const handle = await directory.getFileHandle(deliveredFile.name, { create: true });
    signal?.throwIfAborted();
    const writable = await handle.createWritable();
    try { signal?.throwIfAborted(); await writable.write(blob); signal?.throwIfAborted(); await writable.close(); }
    catch (failure) { await writable.abort?.().catch(() => {}); throw failure; }
    onProgress?.(index + 1, files.length, deliveredFile.name);
  }
  return directory ? "picked" as const : "fallback" as const;
}
/** 卡片标题、批次、下载文件名共用同一套“第 N 段”口径。 */
function segmentTitle(item: { cardIndex?: number; taskLabel?: string }) {
  return item.cardIndex == null ? (item.taskLabel || "视频") : `第${item.cardIndex + 1}段`;
}
function historyFileName(item: { cardIndex?: number; taskLabel?: string; createdAt?: string }, batch: string, stamp?: string, taskIdentity?: string) {
  const safe = (value: string) => String(value || "").replace(/[\\/:*?"<>|·]+/gu, "-").replace(/\s+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);
  const parts = [safe(batch || "分镜"), safe(stamp || ""), segmentTitle(item)].filter(Boolean);
  const identity = taskIdentity ? encodeURIComponent(taskIdentity).replace(/[!'()*]/gu, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`) : "";
  return `${parts.join("-")}${identity ? `-${identity}` : ""}.mp4`;
}
function batchStamp(items: ReadonlyArray<{ createdAt?: string }>) {
  const latest = items.reduce((max, item) => Math.max(max, Date.parse(String(item.createdAt || "")) || 0), 0);
  if (!latest) return "";
  const date = new Date(latest);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
/** 批次标题旁的时间，用来区分同一天里的多个批次。 */
function batchTimeLabel(items: ReadonlyArray<{ createdAt?: string }>) {
  const latest = items.reduce((max, item) => Math.max(max, Date.parse(String(item.createdAt || "")) || 0), 0);
  if (!latest) return "";
  return new Date(latest).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}
interface Context {
  active: boolean; controller: AbortController; session: StoryboardLocalVideoSession | null;
  mediaController: AbortController;
  urls: Set<string>; hidden: Set<string>; localRevision: number;
}

export function VideoHistoryPanel(props: VideoHistoryPanelProps) {
  // Remount the complete UI on account/session changes so old media cannot flash.
  return <VideoHistoryPanelContent key={`${props.userId}:${props.token}:${props.surface || "storyboard-workbench"}:${props.open}`} {...props} />;
}

function VideoHistoryPanelContent({ open, onClose, userId, token, items, loading, error, onRefresh, recoveryContent, surface = "storyboard-workbench", presentation = "dialog", hasMore, onLoadMore, onRetry, selectedTaskIds, onToggleSelect, onCleared }: VideoHistoryPanelProps) {
  const storyboardInline = surface === "storyboard-workbench" && presentation === "inline";
  const ctx = useRef<Context | null>(null);
  const refreshRef = useRef(onRefresh);
  const clearedRef = useRef(onCleared);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const playerDialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [local, setLocal] = useState<StoryboardLocalVideoEntry[]>([]);
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [coverRevision, setCoverRevision] = useState(0);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<VideoHistoryItem | null>(null);
  const [source, setSource] = useState("");
  const [playerError, setPlayerError] = useState("");
  const [playerLoading, setPlayerLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [needsPlay, setNeedsPlay] = useState(false);
  const [localSource, setLocalSource] = useState(false);
  const localSourceRef = useRef(false);
  useEffect(() => { localSourceRef.current = localSource; }, [localSource]);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [cacheWarning, setCacheWarning] = useState("");
  const [cacheSupported, setCacheSupported] = useState(false);
  const [busy, setBusy] = useState("");
  const [batchBusy, setBatchBusy] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const clearCutoff = useRef<string | null>(null);
  const clearPendingIds = useRef<string[]>([]);
  const retryPlayback = useRef(false);
  const selectedRef = useRef(selected);
  const closeRef = useRef(onClose);
  useEffect(() => { refreshRef.current = onRefresh; clearedRef.current = onCleared; closeRef.current = onClose; selectedRef.current = selected; }, [onRefresh, onCleared, onClose, selected]);
  const ownedUrl = useCallback((context: Context, blob: Blob) => { const url = URL.createObjectURL(blob); context.urls.add(url); return url; }, []);
  const removeHidden = useCallback((context: Context, ids: string[]) => {
    if (!context.active) return;
    ids.forEach(id => context.hidden.add(id)); setHiddenIds(new Set(context.hidden));
    setLocal(rows => rows.filter(row => !context.hidden.has(row.record.taskId)));
    if (selectedRef.current && context.hidden.has(selectedRef.current.taskId)) { video.current?.pause(); setSelected(null); setSource(""); }
  }, []);
  const mediaAccess = useCallback((context: Context, taskId: string, extraSignal?: AbortSignal): PanelMediaAccess => {
    const signal = AbortSignal.any([context.controller.signal, context.mediaController.signal, ...(extraSignal ? [extraSignal] : [])]);
    return { userId, token, taskId, signal, session: context.session,
      current: () => context.active && ctx.current === context && !signal.aborted && !context.hidden.has(taskId) };
  }, [userId, token]);
  const loadLocal = useCallback(async (context: Context, strict = false) => {
    if (!context.session || !context.active) return;
    const revision = ++context.localRevision;
    try {
      let rows = await context.session.list();
      // Reconcile cached IDs even when their remote rows are outside the first page.
      for (let i = 0; i < rows.length; i += 200) {
        try {
          const response = await fetch(`/api/video/history?${new URLSearchParams({ surface, reconcileTaskIds: rows.slice(i, i + 200).map(row => row.record.taskId).join(",") })}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: context.controller.signal });
          if (!response.ok) { await panelHttpDenial(response.status, userId, token, undefined, () => context.active); if (strict) throw new Error("本机副本尚未完成核对，请重试"); rows = []; break; }
          const data = await response.json(); const ids: string[] = Array.isArray(data.hiddenTaskIds) ? data.hiddenTaskIds.filter((id: unknown) => typeof id === "string") : [];
          removeHidden(context, ids);
          if (ids.length) await publishVideoHistoryRemoval({ userId, token, surface, taskIds: ids });
        } catch (failure) { if (!context.active) return; if (strict) throw failure; /* Offline: verified, unexpired local copy remains usable. */ }
      }
      if (!context.active || revision !== context.localRevision) return;
      const permitted = await Promise.all(rows.map(row => offlineAccessAllowed(userId, token, row.record.taskId)));
      if (!context.active || revision !== context.localRevision) return;
      rows = rows.filter((row, index) => permitted[index] && !context.hidden.has(row.record.taskId)); setLocal(rows);
      const next: Record<string, string> = {};
      for (const row of rows) {
        const blob = await context.session.poster(row.record.taskId).catch(() => null);
        if (!context.active || revision !== context.localRevision) { Object.values(next).forEach(url => { URL.revokeObjectURL(url); context.urls.delete(url); }); return; }
        if (blob) next[row.record.taskId] = ownedUrl(context, blob);
      }
      if (!context.active || revision !== context.localRevision) return;
      setPosters(previous => { Object.values(previous).forEach(url => { URL.revokeObjectURL(url); context.urls.delete(url); }); return next; });
    } catch (failure) { if (context.active) setCacheWarning(storyboardLocalVideoError(failure)); if (strict) throw failure; }
  }, [ownedUrl, removeHidden, surface, token, userId]);

  useEffect(() => {
    if (!open || !userId || !token) return;
    const context: Context = { active: true, controller: new AbortController(), mediaController: new AbortController(), session: null, urls: new Set(), hidden: new Set(), localRevision: 0 };
    ctx.current = context; setLocal([]); setPosters({}); setCoverRevision(0); setHiddenIds(new Set()); setSelected(null); setSource(""); setNotice(""); setCacheWarning(""); setBusy(""); setConfirmClear(false); clearCutoff.current = null; clearPendingIds.current = [];
    try { context.session = new StoryboardLocalVideoSession(userId, token, fetch, surface); setCacheSupported(true); } catch (failure) { setCacheSupported(false); setCacheWarning(storyboardLocalVideoError(failure)); }
    const sync = () => { if (context.active && document.visibilityState === "visible") { refreshRef.current(); void loadLocal(context); const current = selectedRef.current; if (current && previewExpired(current, localSourceRef.current)) { video.current?.pause(); setSelected(null); setSource(""); } } };
    const receive = (data: unknown) => {
      if (!data || typeof data !== "object" || !("ids" in data) || !Array.isArray(data.ids)) return;
      const ids: string[] = data.ids.filter((id: unknown): id is string => typeof id === "string");
      removeHidden(context, ids); clearedRef.current?.(ids);
      void (async () => { try { await context.session?.applyTombstones(ids); } catch { if (context.active) setCacheWarning("本机清理未完成，请重试清空历史"); } if (context.active) sync(); })();
    };
    const stopRemoval = subscribeVideoHistoryRemovals(userId, surface, ids => receive({ ids }), ids => removeHidden(context, ids));
    const stopAuth = subscribeOfflineAuthRevocation(userId, token, null, () => {
      if (!context.active) return;
      context.localRevision++;
      context.mediaController.abort(); context.mediaController = new AbortController();
      video.current?.pause(); setSource(""); setSelected(null); setLocal([]); setPosters({});
      context.urls.forEach(url => URL.revokeObjectURL(url)); context.urls.clear();
      setNotice("视频访问状态已变化，请联网重新验证。");
    });
    window.addEventListener("focus", sync); document.addEventListener("visibilitychange", sync);
    let localLoading = false;
    const tick = () => { if (context.active && document.visibilityState === "visible") { refreshRef.current(); if (!localLoading) { localLoading = true; void loadLocal(context).finally(() => { localLoading = false; }); } const current = selectedRef.current; if (current && previewExpired(current, localSourceRef.current)) { video.current?.pause(); setSelected(null); setSource(""); } setHiddenIds(new Set(context.hidden)); } };
    const timer = window.setInterval(tick, 15000); refreshRef.current(); void loadLocal(context);
    return () => {
      context.active = false; context.controller.abort(); context.mediaController.abort(); context.session?.dispose(); stopRemoval(); stopAuth();
      window.clearInterval(timer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync);
      context.urls.forEach(url => URL.revokeObjectURL(url)); context.urls.clear(); if (ctx.current === context) ctx.current = null;
    };
  }, [open, userId, token, surface, loadLocal, removeHidden]);

  useEffect(() => {
    if (!open || presentation !== "dialog") return;
    const dialog = historyDialog.current; const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); };
  }, [open, presentation]);
  useEffect(() => {
    if (!open || !selected) return;
    const dialog = playerDialog.current; const element = video.current; const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal(); return () => { element?.pause(); dialog?.close(); previous?.focus(); };
  }, [open, selected]); // Opening a player never depends on cache availability.

  useEffect(() => {
    const context = ctx.current;
    return () => { if (source.startsWith("blob:")) { URL.revokeObjectURL(source); context?.urls.delete(source); } };
  }, [source]);

  useEffect(() => {
    const context = ctx.current; if (!open || !selected || !context) return;
    const item = selected; let active = true; const controller = new AbortController();
    const access = mediaAccess(context, item.taskId, controller.signal);
    const abort = () => controller.abort(); context.controller.signal.addEventListener("abort", abort);
    setSource(""); setPlayerError(""); setPlayerLoading(true); setNeedsPlay(false); setLocalSource(false);
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    void (async () => {
      try {
        let url = "";
        try { url = await ticket(item.taskId, token, "playback", access.signal, userId); }
        catch (failure) {
          if (!active) return;
          const blob = await panelLocalFallback(access, failure);
          url = ownedUrl(context, blob); if (active && context.active) setLocalSource(true);
        }
        if (active && access.current()) setSource(url);
      } catch (failure) { if (active && context.active) { setPlayerLoading(false); setPlayerError(controller.signal.aborted ? "读取视频超时，请重新加载或稍后再试" : messageOf(failure, "视频加载失败，请重新加载")); } }
      finally { window.clearTimeout(timeout); }
    })();
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); context.controller.signal.removeEventListener("abort", abort); };
  }, [open, selected, reload, token, userId, ownedUrl, mediaAccess]);

  useEffect(() => {
    if (!source || !playerLoading) return;
    const timer = window.setTimeout(() => { setPlayerLoading(false); setPlayerError("视频读取较慢或暂时不可用，请重新加载，也可尝试下载后播放。"); }, 25000);
    return () => window.clearTimeout(timer);
  }, [source, playerLoading]);

  const play = async () => {
    const element = video.current; const context = ctx.current;
    if (!element || !context?.active) return;
    const expectedSource = element.currentSrc;
    try { await element.play(); if (context.active && element === video.current && element.currentSrc === expectedSource) { setNeedsPlay(false); setPlayerError(""); } }
    catch (failure) { if (context.active && element === video.current && element.currentSrc === expectedSource) { setNeedsPlay(true); if (!(failure instanceof DOMException && failure.name === "NotAllowedError")) setPlayerError("播放未开始，请点击播放或重新加载"); } }
  };
  const playbackFailure = async () => {
    const context = ctx.current; const item = selectedRef.current; if (!context?.active || !item) return;
    // Native media errors do not expose an HTTP status. They cannot authorize
    // a local fallback; a new online ticket is required before another read.
    suspendOfflineTask(userId, item.taskId);
    setPlayerError(storyboardInline ? "视频暂时无法播放，请稍后重试。" : "视频暂时无法播放，请重新加载或尝试下载。若已有本机文件，可直接播放；当前任务与费用记录仍会保留。");
  };
  const saveLocal = async () => {
    const context = ctx.current; const item = selected; if (!context?.session || !item || busy) return;
    setBusy("save"); setCacheWarning("");
    try { const access = mediaAccess(context, item.taskId); await ticket(item.taskId, token, "playback", access.signal, userId); assertPanelMediaCurrent(access); await context.session.save({ ...item, surface }); if (access.current()) { await loadLocal(context); if (access.current()) setNotice("完整视频已保存到本浏览器"); } }
    catch (failure) {
      if (failure instanceof StoryboardLocalVideoError && failure.code === "VIDEO_ACCESS_DENIED" && typeof failure.httpStatus === "number") await panelHttpDenial(failure.httpStatus, userId, token, item.taskId, () => context.active);
      if (context.active) setCacheWarning(storyboardLocalVideoError(failure));
    }
    finally { if (context.active) setBusy(""); }
  };
  const download = async (requested?: VideoHistoryItem) => {
    const context = ctx.current; const item = requested || selected; if (!context?.active || !item || busy || batchBusy) return;
    if (storyboardInline && !canUseMedia(item)) return;
    setBusy("download");
    try {
      const access = mediaAccess(context, item.taskId);
      const name = historyFileName(item, "分镜", undefined, storyboardInline ? item.taskId : undefined);
      const mode = await saveWithPicker(() => readPanelVideo(access), name, access.signal);
      if (context.active) setNotice(mode === "picked" ? "视频已保存" : "已开始下载，请在浏览器下载列表查看");
    } catch (failure) {
      if (context.active) setNotice(failure instanceof DOMException && failure.name === "AbortError" ? "已取消保存视频" : messageOf(failure, "下载失败，请重试"));
    }
    finally { if (context.active) setBusy(""); }
  };
  // 批量下载：只弹出一次“选择文件夹”，按段序写入，文件名与卡片标题一致。
  const saveItems = async (items: VideoHistoryItem[], label: string, busyKey = label) => {
    const context = ctx.current;
    if (!context?.active || batchBusy || busy) return;
    const ordered = [...items].filter(item => item.status === "completed" && canUseMedia(item))
      .sort((a, b) => (a.cardIndex ?? 9999) - (b.cardIndex ?? 9999) || String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!ordered.length) { setNotice("所选记录里还没有可下载的已完成视频"); return; }
    setBatchBusy(busyKey);
    const files: Array<{ load: () => Promise<Blob>; name: string }> = [];
    const signal = AbortSignal.any([context.controller.signal, context.mediaController.signal]);
    try {
      for (const item of ordered) {
        const access = mediaAccess(context, item.taskId, signal);
        if (!context.active) return;
        const name = historyFileName(item, label, batchStamp(ordered), storyboardInline ? item.taskId : undefined);
        files.push({ load: () => readPanelVideo(access), name });
      }
      const mode = await saveManyToDirectory(files, signal, (done, total, name) => {
        if (context.active) setNotice(storyboardInline ? `正在保存 ${done}/${total}` : `正在保存 ${done}/${total}：${name}`);
      });
      if (context.active) setNotice(mode === "picked"
        ? `已保存 ${files.length} 段视频到所选文件夹`
        : "已请求按顺序下载，请在浏览器下载列表查看并允许多文件下载");
    } catch (failure) {
      if (context.active) setNotice(`下载未完成：${messageOf(failure, "请重试或改用单段下载")}`);
    } finally { if (context.active) { setBatchBusy(""); } }
  };
  const downloadBatch = async (batch: { batchId: string; batchTopic?: string; items: VideoHistoryItem[] }) => {
    await saveItems(batch.items, batchLabel(batch.batchTopic), batch.batchId);
  };
  const togglePick = (taskId: string) => {
    setPicked(current => { const next = new Set(current); if (next.has(taskId)) next.delete(taskId); else next.add(taskId); return next; });
  };
  /** 跨批次勾选下载：按各自批次命名，只弹一次文件夹选择。 */
  const downloadSelected = async () => {
    const context = ctx.current;
    if (!context?.active || batchBusy || busy) return;
    const chosen = visible.filter(item => picked.has(item.taskId) && item.status === "completed" && canUseMedia(item));
    if (!chosen.length) { setNotice("请先勾选已完成的视频"); return; }
    setBatchBusy("selected");
    const signal = AbortSignal.any([context.controller.signal, context.mediaController.signal]);
    try {
      const files: Array<{ load: () => Promise<Blob>; name: string }> = [];
      const byBatch = new Map<string, VideoHistoryItem[]>();
      for (const item of chosen) {
        const key = item.batchId || "single";
        byBatch.set(key, [...(byBatch.get(key) || []), item]);
      }
      for (const items of byBatch.values()) {
        const label = batchLabel(items[0]?.batchTopic);
        const stamp = batchStamp(items);
        const ordered = [...items].sort((a, b) => (a.cardIndex ?? 9999) - (b.cardIndex ?? 9999));
        for (const item of ordered) {
          const access = mediaAccess(context, item.taskId, signal);
          if (!context.active) return;
          const name = historyFileName(item, label, stamp, storyboardInline ? item.taskId : undefined);
          files.push({ load: () => readPanelVideo(access), name });
        }
      }
      const mode = await saveManyToDirectory(files, signal, (done, total, name) => {
        if (context.active) setNotice(`正在保存 ${done}/${total}：${name}`);
      });
      if (context.active) setNotice(mode === "picked" ? `已保存 ${files.length} 段视频到所选文件夹` : "已请求按顺序下载，请在浏览器下载列表查看并允许多文件下载");
    } catch (failure) {
      if (context.active) setNotice(`下载未完成：${messageOf(failure, "请重试")}`);
    } finally { if (context.active) setBatchBusy(""); }
  };
  const clear = async () => {
    const context = ctx.current; if (!context?.active || busy) return;
    setBusy("clear"); setNotice("");
    try {
      if (!clearCutoff.current) {
        const clockResponse = await fetch(`/api/video/history?${new URLSearchParams({ surface, reconcileTaskIds: "" })}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: context.controller.signal });
        if (!clockResponse.ok) await panelHttpDenial(clockResponse.status, userId, token, undefined, () => context.active);
        const clockData = await clockResponse.json();
        if (!clockResponse.ok || !Number.isFinite(Date.parse(clockData.serverTime))) throw new Error("无法确认清理时间，请重试");
        if (!context.active) return;
        clearCutoff.current = clockData.serverTime;
      }
      const cutoff = clearCutoff.current!;
      const response = await fetch(`/api/video/history?${new URLSearchParams({ surface, clearAll: "true", cutoff })}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: context.controller.signal });
      if (!response.ok) await panelHttpDenial(response.status, userId, token, undefined, () => context.active);
      const data = await response.json();
      const ids = Array.isArray(data.clearedTaskIds) ? data.clearedTaskIds.filter((id: unknown): id is string => typeof id === "string") : [];
      // Confirmed server IDs belong to the captured account even if the panel
      // closes while the DELETE response arrives. Never resurrect them locally.
      if (ids.length) await publishVideoHistoryRemoval({ userId, token, surface, taskIds: ids });
      if (!context.active) return;
      clearPendingIds.current = [...new Set([...clearPendingIds.current, ...ids])];
      removeHidden(context, clearPendingIds.current);
      const localResult = clearPendingIds.current.length ? await publishVideoHistoryRemoval({ userId, token, surface, taskIds: clearPendingIds.current }) : "synced";
      if (!context.active) return;
      if (localResult === "local_failed" || localResult === "invalid") throw new Error("服务器已确认移除，但本机清理未完成");
      clearedRef.current?.(clearPendingIds.current); await loadLocal(context, true);
      if (!context.active) return;
      refreshRef.current();
      if (!response.ok || data.success !== true) throw new Error(data.error || "部分历史清理失败，请重试");
      setNotice(`已清空 ${data.clearedCount ?? ids.length} 条历史，保留 ${data.protectedCount ?? 0} 条进行中或待确认任务。${data.skippedCount ? `另有 ${data.skippedCount} 条任务状态已变化，本次保留。` : ""}`);
      clearCutoff.current = null; clearPendingIds.current = []; setConfirmClear(false);
    } catch (failure) { if (context.active) setNotice(`清理尚未完成：${messageOf(failure, "本机缓存清理失败")}。请重试，继续使用本次清理时间。`); }
    finally { if (context.active) setBusy(""); }
  };

  const visible = useMemo(() => (storyboardInline ? mergeStoryboardInlineHistory(items, local) : mergeStoryboardHistory(items, local)).filter(item => !item.hidden && !item.tombstone && !hiddenIds.has(item.taskId) && !isVideoHistoryExpired(item)).map(item => ({ ...item, id: item.taskId })), [items, local, hiddenIds, storyboardInline]);
  const filtered = useMemo(() => visible.filter(item => filter === "all" || (filter === "completed" ? item.status === "completed" : filter === "active" ? isVideoHistoryProtected(item) : ["failed", "cancelled", "expired"].includes(item.status))), [visible, filter]);
  const groups = useMemo(() => groupVideoHistory(filtered), [filtered]);
  const counts = useMemo(() => ({
    all: visible.length,
    completed: visible.filter(item => item.status === "completed").length,
    active: visible.filter(item => isVideoHistoryProtected(item)).length,
    failed: visible.filter(item => ["failed", "cancelled", "expired"].includes(item.status)).length,
  }), [visible]);
  const localTaskIds = useMemo(() => new Set(local.filter(row => row.available).map(row => row.record.taskId)), [local]);
  const canUseMedia = (item: VideoHistoryItem) => storyboardInline
    ? storyboardRecordState(item, localTaskIds.has(item.taskId)) === "playable"
    : item.mediaAvailable !== false || localTaskIds.has(item.taskId);
  const localAvailable = selected && local.some(row => row.record.taskId === selected.taskId && row.available);

  // Internal provenance keys (surface ids) must never be shown as a batch title.
  const batchLabel = (topic?: string) => {
    const value = (topic || "").trim();
    if (value && !/^(?:storyboard-workbench|video-page|digital-human)$/u.test(value)) return value;
    return surface === "video-page" ? "视频制作" : "分镜制作";
  };
  const isSelected = (id: string) => Array.isArray(selectedTaskIds) ? selectedTaskIds.includes(id) : (selectedTaskIds as ReadonlySet<string> | undefined)?.has(id);
  if (!open) return null;
  const panel = storyboardInline ? <StoryboardHistoryBrowser
    items={visible} localTaskIds={localTaskIds}
    renderCover={item => <VideoHistoryCover key={`${item.taskId}:${coverRevision}:${posters[item.taskId] || ""}`} item={item} token={token} userId={userId} localPoster={posters[item.taskId]} />}
    loading={loading} error={error} notice={notice}
    onBack={onClose} onRefresh={() => { setCoverRevision(value => value + 1); refreshRef.current(); }}
    onRequestClear={() => setConfirmClear(true)} clearBusy={Boolean(busy)}
    confirmation={confirmClear && <div className="sbh-confirm" role="alert"><div>清除当前账号已结束的历史及本浏览器缓存？进行中和费用待确认的任务会保留，已下载文件不受影响。</div><div className="sbh-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void clear()}>{busy === "clear" ? "清理中…" : "确认 / 重试清空"}</button><button type="button" disabled={Boolean(busy)} onClick={() => { clearCutoff.current = null; setConfirmClear(false); }}>取消</button></div></div>}
    batchBusy={batchBusy} downloadBusy={Boolean(busy)}
    onDownloadBatch={batch => void downloadBatch(batch)}
    onDownloadVideo={item => void download(item)}
    onPreview={item => { retryPlayback.current = false; setSelected(item); setReload(value => value + 1); }}
    hasMore={hasMore} onLoadMore={onLoadMore}
    hasRecovery={Boolean(recoveryContent)}
  /> : <section className="sbh-panel" aria-label="视频历史" data-surface={surface}>
    <header className="sbh-header"><div><h2>{surface === "video-page" ? "视频制作历史" : "分镜历史"}</h2><p>{surface === "storyboard-workbench" ? "视频可用时可播放或下载；云端保存结果与到期时间以每段状态为准。请及时下载到电脑长期保存。" : "按制作批次与卡片顺序排列 · 视频可用性以当前状态为准，请及时下载到电脑保存"}</p></div><div className="sbh-actions">{picked.size > 0 && <><button type="button" onClick={() => void downloadSelected()} disabled={Boolean(batchBusy)}><Download size={15} />{batchBusy === "selected" ? "保存中…" : `下载所选 (${picked.size})`}</button><button type="button" onClick={() => setPicked(new Set())} disabled={Boolean(batchBusy)}>清空选择</button></>}<button type="button" onClick={() => { setCoverRevision(value => value + 1); refreshRef.current(); }} disabled={loading}><RefreshCw size={15} />刷新</button><button type="button" onClick={() => setConfirmClear(true)} disabled={Boolean(busy)}><Trash2 size={15} />清空历史</button><button type="button" aria-label="关闭历史" onClick={onClose}><X size={18} /></button></div></header>
    {confirmClear && <div className="sbh-confirm" role="alert"><div>清空本页当前账号已结束的历史及对应本机副本？进行中和费用待确认的任务会保留，已下载文件不受影响。</div><div className="sbh-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void clear()}>{busy === "clear" ? "清理中…" : "确认 / 重试清空"}</button><button type="button" disabled={Boolean(busy)} onClick={() => { clearCutoff.current = null; setConfirmClear(false); }}>取消</button></div></div>}
    {notice && <p className="sbh-notice" role="status">{notice}</p>}
    {error && <p className="sbh-error" role="alert">{error}<button type="button" onClick={() => refreshRef.current()}>重新加载</button></p>}
    {cacheWarning && <p className="sbh-notice">{cacheWarning}；仍可使用上游播放和下载。</p>}
    <div className="sbh-filters" aria-label="筛选视频历史">{[["all", "全部"], ["completed", "已完成"], ["active", "进行中 / 待确认"], ["failed", "失败 / 已结束"]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span className="sbh-filter-count">{counts[value as keyof typeof counts]}</span></button>)}</div>
    <div className="sbh-content" aria-busy={loading}>
      {loading && !visible.length ? <div className="sbh-empty"><Loader2 size={24} />正在加载历史…</div> : error && !visible.length ? <div className="sbh-empty"><Film size={32} /><strong>历史暂时无法读取</strong><span>请重新加载，现有记录不会因此清除。</span></div> : !visible.length ? <div className="sbh-empty"><Film size={32} /><strong>暂无视频历史</strong><span>提交生成后会自动记录，完成的视频点击卡牌即可播放。</span></div> : !filtered.length ? <div className="sbh-empty"><Film size={32} /><strong>当前筛选下暂无记录</strong><button type="button" onClick={() => setFilter("all")}>查看全部历史</button></div> : groups.map(day => <section className="sbh-day" key={day.dateKey}><h3>{day.label}</h3>{day.batches.map(batch => <section className="sbh-batch" data-batch-id={batch.batchId} key={batch.batchId}><div className="sbh-batch-head"><h4>{batchLabel(batch.batchTopic)}<span>{batchTimeLabel(batch.items)} · {batch.items.length} 段</span></h4><div className="sbh-batch-actions"><button type="button" disabled={Boolean(batchBusy) || !batch.items.some(item => item.status === "completed" && canUseMedia(item))} onClick={() => void downloadBatch(batch)}><Download size={14} />{batchBusy === batch.batchId ? "下载中…" : "下载本批次"}</button></div></div><div className="sbh-grid">{batch.items.map(item => <article className={`sbh-card${picked.has(item.taskId) ? " is-picked" : ""}`} data-task-id={item.taskId} data-card-index={item.cardIndex} key={item.taskId}><label className="sbh-pick" onClick={event => event.stopPropagation()}><input type="checkbox" checked={picked.has(item.taskId)} onChange={() => togglePick(item.taskId)} aria-label={`选择${segmentTitle(item)}`} /></label>
        <button type="button" className="sbh-card-play" disabled={item.status !== "completed" || !canUseMedia(item)} aria-label={`播放${item.cardIndex == null ? "视频" : `第${item.cardIndex + 1}段`}`} onClick={() => { retryPlayback.current = false; setSelected(item); setReload(value => value + 1); }}>
          <Film size={28} /><VideoHistoryCover key={`${item.taskId}:${coverRevision}:${posters[item.taskId] || ""}`} item={item} token={token} userId={userId} localPoster={posters[item.taskId]} />
          <span className={`sbh-card-status is-${item.billingState === "usage_pending" || item.billingState === "quote_exceeded" ? "pending" : item.status}`}>{item.billingState === "usage_pending" || item.billingState === "quote_exceeded" ? "费用待确认" : statusLabel(item.status)}</span>{item.status === "completed" && canUseMedia(item) && <span className="sbh-play-symbol"><Play size={22} fill="currentColor" /></span>}{isActiveStatus(item.status) && <><span className="sbh-progress" aria-hidden="true"><span style={{ width: `${Math.max(6, Math.min(100, Number(item.progress) || 0))}%` }} /></span><span className="sbh-progress-text">{Number(item.progress) > 0 ? `${Math.round(Number(item.progress))}%` : "生成中"} · 已用 {elapsedLabel(item.createdAt) || "—"}</span></>}
        </button>
        <div className="sbh-card-body"><div className="sbh-card-title"><strong>{item.cardIndex == null ? item.taskLabel || "视频" : `第 ${item.cardIndex + 1} 段`}</strong><span>{item.durationSeconds || item.duration ? `${item.durationSeconds || item.duration}秒` : ""}</span></div><p className="sbh-model" title={item.modelName}>{compactPublicVideoModelName(item.modelName || "视频模型")}</p>{item.errorMessage && !isActiveStatus(item.status) && <p className="sbh-card-error" title={item.errorMessage}>{item.errorMessage}</p>}
        {surface === "storyboard-workbench" && deliveryLabel(item) && <p className={`sbh-delivery is-${item.deliveryState}`} role="status">{deliveryLabel(item)}</p>}
        {onToggleSelect && item.status === "completed" && <label className="sbh-select"><input type="checkbox" checked={Boolean(isSelected(item.taskId))} onChange={() => onToggleSelect(item.taskId)} />选择视频</label>}
        <details className="sbh-details"><summary>参数与详情</summary><p>{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "时间未记录"}</p>{item.prompt && <p>{item.prompt}</p>}<p>{[item.resolution, item.aspectRatio].filter(Boolean).join(" · ")}</p><p>{item.priceCharged != null ? `费用 ¥${Number(item.priceCharged).toFixed(2)}` : "费用以任务记录为准"}</p>{item.errorMessage && <p>{item.errorMessage}</p>}{onRetry && item.canRetry && <button type="button" onClick={() => onRetry(item.taskId)}>载入参数</button>}</details></div>
      </article>)}</div></section>)}</section>)}
      {hasMore && <button className="sbh-load-more" type="button" onClick={onLoadMore} disabled={loading}>{loading ? "加载中…" : "加载更多历史"}</button>}
      {recoveryContent && <details className="sbh-recovery"><summary>未完成项目与参数恢复</summary>{recoveryContent}</details>}
    </div>
  </section>;
  return <>{presentation === "inline" ? <div className="sbh-inline">{panel}</div> : createPortal(<dialog ref={historyDialog} aria-label="视频历史" className="sbh-dialog" onCancel={event => { event.preventDefault(); closeRef.current(); }}>{panel}</dialog>, document.body)}
    {selected && createPortal(<dialog ref={playerDialog} aria-label="视频预览" className="sbh-dialog sbh-player-dialog" onCancel={event => { event.preventDefault(); setSelected(null); setSource(""); }}>
      <section className="sbh-panel">
        <header className="sbh-header"><div><h2>{selected.cardIndex == null ? "视频预览" : `第 ${selected.cardIndex + 1} 段 · 视频预览`}</h2>{!storyboardInline && <p>{localSource ? "正在播放本浏览器副本" : "正在读取视频 · 无需等待后台保存"}</p>}</div><button type="button" aria-label="关闭视频预览" onClick={() => { setSelected(null); setSource(""); }}><X size={20} /></button></header>
        <div className="sbh-player"><video key={source || "empty"} ref={video} src={source || undefined} controls playsInline preload="metadata" onLoadedData={() => { setPlayerLoading(false); setPlayerError(""); void play(); }} onError={() => { setPlayerLoading(false); if (source) void playbackFailure(); }} />{playerLoading && !playerError && <span className="sbh-player-loading"><Loader2 size={26} />加载视频…</span>}</div>
        {playerError && <p className="sbh-error" role="alert">{playerError}</p>}
        <div className="sbh-player-footer"><p>{storyboardInline ? "视频可能到期，请及时下载到电脑保存。" : surface === "storyboard-workbench" ? "播放与下载取决于当前媒体状态；云端到期时间以每段显示为准，请及时下载。下载文件可长期自行保管。" : "本机副本保存在当前浏览器，清理浏览器数据后需重新读取上游。下载文件可长期自行保管。"}</p>
          <div className="sbh-actions">
            {needsPlay && <button type="button" onClick={() => void play()}><Play size={16} />点击播放</button>}
            {(!storyboardInline || playerError) && <button type="button" onClick={() => { retryPlayback.current = false; setReload(value => value + 1); }}>重新加载</button>}
            {!storyboardInline && <button type="button" disabled={Boolean(busy) || Boolean(localAvailable) || !cacheSupported || (selected.mediaAvailable === false && !localAvailable)} onClick={() => void saveLocal()}>{busy === "save" ? "保存中…" : localAvailable ? "本机副本可用" : "保存本机副本"}</button>}
            <button type="button" disabled={Boolean(busy) || !canUseMedia(selected)} onClick={() => void download()}><Download size={16} />{busy === "download" ? "准备下载…" : "下载视频"}</button>
          </div>
          {!storyboardInline && cacheWarning && <p className="sbh-notice">{cacheWarning}</p>}{notice && <p className="sbh-notice" role="status">{notice}</p>}
        </div>
      </section>
    </dialog>, document.body)}
  </>;
}
