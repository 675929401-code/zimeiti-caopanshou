"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import {
  AlertCircle,
  ArrowLeft,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileImage,
  Film,
  Images,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import { MediaHistoryVideoPreview } from "@/components/media-history-video-preview";
import { MediaHistoryImageResource } from "@/lib/media-history-image-resource";
import { useApp } from "@/contexts/app-context";
import { requestMediaHistoryVideoUrl } from "@/lib/media-history-video-preview";
import { stripVideoModelOperationalAnnotation } from "@/lib/video-model-display-name";
import { publishVideoHistoryRemoval, subscribeVideoHistoryRemovals } from "@/lib/video-history-removal-sync";
import { StoryboardLocalVideoSession } from "@/lib/storyboard-local-video-cache";
import { captureOfflineAuthVersions, offlineAccessAllowed, recordOfflineSession, recordOfflineTask, subscribeOfflineAuthRevocation } from "@/lib/media-history-offline-auth";
import { VIDEO_HISTORY_RETENTION_MS, videoHistoryTerminalTime, type VideoHistorySurface } from "@/lib/video-history-policy";
import { getPrimaryNavigationLabel } from "@/lib/marketplace-navigation";
import {
  MEDIA_HISTORY_CATEGORY_KEYS,
  type MediaHistoryCategoryKey,
  type MediaHistoryRetentionSource,
} from "@/lib/media-history-contract";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeGetItem } from "@/lib/safe-storage";
import styles from "@/app/media-history/media-history.module.css";

type MediaKind = "image" | "video";
type MediaStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
type MediaKindFilter = "all" | MediaKind;
type CategoryKey = MediaHistoryCategoryKey;
type CategoryFilter = "all" | CategoryKey;

const CATEGORY_OPTIONS: ReadonlyArray<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "全部来源" },
  { key: "image-workbench", label: getPrimaryNavigationLabel("image_workbench", "图像生成") },
  { key: "video-production", label: getPrimaryNavigationLabel("create", "视频创作") },
  { key: "storyboard-workbench", label: getPrimaryNavigationLabel("storyboard_workbench", "分镜编排") },
  { key: "cover-studio", label: getPrimaryNavigationLabel("cover", "封面设计") },
  { key: "agent-output", label: "智能体图片" },
  { key: "commerce-agent", label: getPrimaryNavigationLabel("commerce_agent", "带货创作") },
  { key: "other-tools", label: "其他工具" },
];

const KIND_OPTIONS: ReadonlyArray<{ key: MediaKindFilter; label: string }> = [
  { key: "all", label: "全部媒体" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
];

const CATEGORY_KEYS = new Set<CategoryKey>(MEDIA_HISTORY_CATEGORY_KEYS);
const THUMBNAIL_FETCH_LIMIT = 3;

interface ThumbnailWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: Error) => void;
  onAbort: () => void;
}

let activeThumbnailFetches = 0;
const thumbnailWaiters: ThumbnailWaiter[] = [];

function pumpThumbnailQueue() {
  while (activeThumbnailFetches < THUMBNAIL_FETCH_LIMIT && thumbnailWaiters.length) {
    const waiter = thumbnailWaiters.shift();
    if (!waiter) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(new Error("THUMBNAIL_FETCH_ABORTED"));
      continue;
    }
    activeThumbnailFetches += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      activeThumbnailFetches = Math.max(0, activeThumbnailFetches - 1);
      pumpThumbnailQueue();
    });
  }
}

function acquireThumbnailFetchSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("THUMBNAIL_FETCH_ABORTED"));
      return;
    }
    const waiter = {} as ThumbnailWaiter;
    waiter.signal = signal;
    waiter.resolve = resolve;
    waiter.reject = reject;
    waiter.onAbort = () => {
      const index = thumbnailWaiters.indexOf(waiter);
      if (index >= 0) thumbnailWaiters.splice(index, 1);
      reject(new Error("THUMBNAIL_FETCH_ABORTED"));
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    thumbnailWaiters.push(waiter);
    pumpThumbnailQueue();
  });
}

interface MediaHistoryItem {
  id: string;
  kind: MediaKind;
  title: string;
  project: string;
  segment: string;
  source: string;
  sourcePath: string;
  retryPath: string;
  categoryKey: CategoryKey;
  removable: boolean;
  status: MediaStatus;
  createdAt: string;
  completedAt: string | null;
  publicModelName: string;
  cost: number | null;
  costNote: string;
  previewPath: string;
  thumbnailPath: string;
  downloadPath: string;
  errorMessage: string;
  aspectRatio: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  retentionSource: MediaHistoryRetentionSource;
  /** Local-only records are created exclusively from this account's cache. */
  localOnly?: boolean;
}

interface FacetCounts {
  categories: Record<CategoryFilter, number | null>;
  kinds: Record<MediaKindFilter, number | null>;
}

interface PaginationSummary {
  total: number | null;
  currentCount: number;
}

const STATUS_LABEL: Record<MediaStatus, string> = {
  queued: "排队中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const EMPTY_FACETS: FacetCounts = {
  categories: {
    all: null,
    "image-workbench": null,
    "video-production": null,
    "storyboard-workbench": null,
    "cover-studio": null,
    "digital-human": null,
    "short-drama": null,
    "free-canvas": null,
    "agent-output": null,
    "commerce-agent": null,
    "other-tools": null,
  },
  kinds: { all: null, image: null, video: null },
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function safeDownloadName(item: MediaHistoryItem, mime = ""): string {
  const base = (item.title || item.segment || "媒体文件").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)$/iu, "").slice(0, 120) || "媒体文件";
  const extension: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  };
  const suffix = extension[mime.split(";")[0].trim().toLowerCase()];
  return suffix ? `${base}.${suffix}` : base;
}

function readStoredUserId(): string {
  const raw = safeGetItem(STORAGE_KEYS.AUTH_USER);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : "";
  } catch {
    return "";
  }
}

function finiteCount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function categoryKey(value: unknown): CategoryKey {
  if (value === "other-production") return "other-tools";
  if (value === "workspace") return "agent-output";
  return typeof value === "string" && CATEGORY_KEYS.has(value as CategoryKey)
    ? value as CategoryKey
    : "other-tools";
}

function normalizeItem(value: unknown): MediaHistoryItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const item = record as unknown as Partial<MediaHistoryItem>;
  const preview = record.preview && typeof record.preview === "object"
    ? record.preview as Record<string, unknown>
    : {};
  if (!item.id || (item.kind !== "image" && item.kind !== "video")) return null;
  const normalizedCategory = categoryKey(item.categoryKey || record.category);
  return {
    ...item,
    id: String(item.id),
    kind: item.kind,
    title: String(item.title || "未命名作品"),
    project: String(item.project || "未标注项目"),
    segment: String(item.segment || "未标注内容"),
    source: String(item.source || "其他生产工具"),
    sourcePath: String(item.sourcePath || "/"),
    retryPath: String(item.retryPath || ""),
    categoryKey: normalizedCategory,
    removable: typeof item.removable === "boolean" ? item.removable : normalizedCategory !== "commerce-agent",
    status: (["queued", "processing", "completed", "failed", "cancelled"] as MediaStatus[]).includes(item.status as MediaStatus)
      ? item.status as MediaStatus
      : "failed",
    createdAt: String(item.createdAt || ""),
    completedAt: item.completedAt ? String(item.completedAt) : null,
    publicModelName: String(item.publicModelName || "原记录未标注"),
    cost: typeof item.cost === "number" && Number.isFinite(item.cost) ? item.cost : null,
    costNote: String(item.costNote || "账单未关联"),
    previewPath: String(item.previewPath || preview.path || ""),
    thumbnailPath: String(item.thumbnailPath || preview.thumbnailPath || ""),
    downloadPath: String(item.downloadPath || ""),
    errorMessage: String(item.errorMessage || ""),
    aspectRatio: String(item.aspectRatio || ""),
    durationSeconds: typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds)
      ? item.durationSeconds
      : null,
    expiresAt: item.expiresAt ? String(item.expiresAt) : null,
    retentionSource: item.retentionSource === "upstream" || item.retentionSource === "policy"
      ? item.retentionSource
      : "none",
    localOnly: false,
  };
}

function mergeHistoryItems(
  previous: MediaHistoryItem[],
  incoming: MediaHistoryItem[],
  incomingFirst: boolean,
): MediaHistoryItem[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const incomingUnique = Array.from(incomingById.values());
  if (incomingFirst) {
    return [...incomingUnique, ...previous.filter((item) => !incomingById.has(item.id))];
  }
  const previousIds = new Set(previous.map((item) => item.id));
  return [
    ...previous.map((item) => incomingById.get(item.id) ?? item),
    ...incomingUnique.filter((item) => !previousIds.has(item.id)),
  ];
}

function facetRecord(value: unknown, keys: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  const normalizeFacetKey = (value: unknown) => value === "other-production"
    ? "other-tools"
    : String(value || "");
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const key = normalizeFacetKey(row.key || row.value || row.categoryKey || row.kind);
      const count = finiteCount(row.count ?? row.total);
      if (keys.includes(key) && count !== null) result[key] = count;
    }
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [rawKey, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeFacetKey(rawKey);
    if (!keys.includes(key)) continue;
    const count = finiteCount(
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).count ?? (entry as Record<string, unknown>).total : entry,
    );
    if (count !== null) result[key] = count;
  }
  return result;
}

function readFacets(payload: Record<string, unknown>): FacetCounts {
  const facets = payload.facets && typeof payload.facets === "object"
    ? payload.facets as Record<string, unknown>
    : {};
  const categoryCounts = facetRecord(
    facets.categories ?? facets.category ?? payload.categories,
    ["all", ...MEDIA_HISTORY_CATEGORY_KEYS],
  );
  const kindCounts = facetRecord(
    facets.kinds ?? facets.kind ?? payload.kinds,
    KIND_OPTIONS.map((option) => option.key),
  );
  const categoryKeys = MEDIA_HISTORY_CATEGORY_KEYS;
  if (categoryCounts.all === undefined && categoryKeys.every((key) => categoryCounts[key] !== undefined)) {
    categoryCounts.all = categoryKeys.reduce((total, key) => total + categoryCounts[key], 0);
  }
  return {
    categories: { ...EMPTY_FACETS.categories, ...categoryCounts },
    kinds: { ...EMPTY_FACETS.kinds, ...kindCounts },
  } as FacetCounts;
}

function categoryLabel(key: CategoryKey): string {
  return CATEGORY_OPTIONS.find((option) => option.key === key)?.label || "其他生产工具";
}

async function readOfflineVideos(userId: string, token: string, signal: AbortSignal): Promise<MediaHistoryItem[]> {
  const sessions: StoryboardLocalVideoSession[] = [];
  const abort = () => sessions.forEach(session => session.dispose());
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const entries: MediaHistoryItem[] = [];
    for (const surface of ["storyboard-workbench", "video-page"] as const) {
      const session = new StoryboardLocalVideoSession(userId, token, fetch, surface);
      sessions.push(session);
      const local = await session.list();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      for (const { record, available } of local) {
        const timestamp = videoHistoryTerminalTime(record);
        if (!available || !Number.isFinite(timestamp) || timestamp > Date.now() || timestamp + VIDEO_HISTORY_RETENTION_MS <= Date.now()) continue;
        const category: CategoryKey = surface === "storyboard-workbench" ? "storyboard-workbench" : "video-production";
        const taskId = record.taskId;
        if (!await offlineAccessAllowed(userId, token, taskId) || signal.aborted) continue;
        const path = `/api/video/storage/${taskId}`;
        entries.push({
          id: `video:${taskId}`, kind: "video", title: record.batchTopic || "本机视频副本",
          project: record.batchTopic || "本机作品", segment: record.cardIndex ? `任务 ${record.cardIndex}` : "本机副本",
          source: categoryLabel(category), sourcePath: surface === "storyboard-workbench" ? "/storyboard-workbench" : "/video",
          retryPath: "", categoryKey: category, removable: false, status: "completed",
          createdAt: record.createdAt, completedAt: record.completedAt || null,
          publicModelName: stripVideoModelOperationalAnnotation(record.modelName) || "原记录未标注", cost: null, costNote: "离线时无法核对账单",
          previewPath: path, thumbnailPath: "", downloadPath: path, errorMessage: "",
          aspectRatio: "", durationSeconds: record.duration || null,
          expiresAt: new Date(timestamp + VIDEO_HISTORY_RETENTION_MS).toISOString(), retentionSource: "policy", localOnly: true,
        });
      }
    }
    const byId = new Map<string, MediaHistoryItem>();
    for (const item of entries) if (!byId.has(item.id)) byId.set(item.id, item);
    return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } finally {
    signal.removeEventListener("abort", abort);
    sessions.forEach(session => session.dispose());
  }
}

async function loadOfflineVideo(item: MediaHistoryItem, userId: string, token: string, signal: AbortSignal): Promise<Blob> {
  const match = /^video:([A-Za-z0-9_-]{8,128})$/u.exec(item.id);
  if (!item.localOnly || !match) throw new Error("本机视频编号无效");
  const surface: VideoHistorySurface = item.categoryKey === "storyboard-workbench" ? "storyboard-workbench" : "video-page";
  const session = new StoryboardLocalVideoSession(userId, token, fetch, surface);
  const abort = () => session.dispose();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!await offlineAccessAllowed(userId, token, match[1])) throw new Error("当前账号或作品尚未重新验证，无法读取本机副本");
    const blob = await session.load(match[1]);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!await offlineAccessAllowed(userId, token, match[1])) throw new Error("当前账号或作品尚未重新验证，无法读取本机副本");
    if (!blob || !blob.type.startsWith("video/")) throw new Error("本机副本已到期、被删除或暂不可读取");
    return blob;
  } finally {
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}

const RETIRED_CATEGORIES = new Set<CategoryKey>(["digital-human", "short-drama", "free-canvas"]);

function MediaPreviewDialog({ item, token, userId, imageResource, onClose, onDownload, downloading, downloadMessage }: { item: MediaHistoryItem; token: string | null; userId: string | null; imageResource: MediaHistoryImageResource | null; onClose: () => void; onDownload: () => void; downloading: boolean; downloadMessage: { text: string; error: boolean } | null }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const [imageDecodeSlow, setImageDecodeSlow] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (item.kind !== "image" || !token || !imageResource) return;
    const controller = new AbortController();
    let objectUrl = "";
    let release = () => {};
    setImageUrl("");
    setFailure("");
    setImageReady(false);
    setImageDecodeSlow(false);
    void (async () => {
      try {
        const handle = imageResource.acquire(item.previewPath);
        release = handle.release;
        const blob = await handle.promise;
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted) { URL.revokeObjectURL(objectUrl); objectUrl = ""; return; }
        setImageUrl(objectUrl);
      } catch (reason) {
        if (!controller.signal.aborted) setFailure(reason instanceof Error ? reason.message : "图片预览失败");
      }
    })();
    return () => { controller.abort(); release(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attempt, imageResource, item.kind, item.previewPath, token]);

  useEffect(() => {
    if (!imageUrl || imageReady || failure) return;
    const timer = window.setTimeout(() => setImageDecodeSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [imageUrl, imageReady, failure]);

  return (
    <dialog ref={dialogRef} className={styles.previewDialog} aria-labelledby="media-preview-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.dialogHeader}>
        <div className={styles.dialogHeading}>
          <span>{item.kind === "video" ? "视频作品" : "图片作品"}</span>
          <h2 id="media-preview-title">{item.title}</h2>
        </div>
        <button type="button" className={styles.dialogClose} onClick={onClose} aria-label="关闭预览"><X aria-hidden="true" /></button>
      </div>
      <div className={styles.dialogLayout}>
       <div className={styles.dialogMedia}>
        {item.kind === "video" ? <MediaHistoryVideoPreview previewPath={item.previewPath} title={item.title} token={token}
          localVideo={userId && item.id.startsWith("video:") ? { userId, taskId: item.id.slice("video:".length), surface: item.categoryKey === "storyboard-workbench" ? "storyboard-workbench" : "video-page" } : undefined} />
          : failure ? <div className={styles.dialogMessage}><FileImage aria-hidden="true" /><strong>图片暂时无法预览</strong><span>{failure}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>
            : <>
              {imageUrl && <>
              {/* eslint-disable-next-line @next/next/no-img-element -- protected blob URL */}
              <img src={imageUrl} alt={`${item.title} 图片预览`} onLoad={() => setImageReady(true)} onError={() => { imageResource?.invalidate(item.previewPath); setFailure("图片文件无法解码，请重新加载。"); }}/>
              </>}
              {!imageReady && <div className={styles.dialogLoading} role="status"><RefreshCw className={styles.spin} aria-hidden="true" /><span>{imageDecodeSlow ? "图片解码较慢，仍在加载中" : "正在加载图片…"}</span>{imageDecodeSlow && <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>}</div>}
            </>}
       </div>
       <aside className={styles.dialogDetails} aria-label="作品信息">
        <div><span className={styles.dialogEyebrow}>作品信息</span><h3>{item.title}</h3><p>{item.project} · {item.segment}</p></div>
        <dl>
          <div><dt>来源</dt><dd>{["agent-output", "other-tools"].includes(item.categoryKey) || RETIRED_CATEGORIES.has(item.categoryKey) ? item.source : categoryLabel(item.categoryKey)}</dd></div>
          <div><dt>创建时间</dt><dd>{formatTime(item.createdAt)}</dd></div>
          <div><dt>模型</dt><dd>{item.publicModelName}</dd></div>
          <div><dt>规格</dt><dd>{[item.aspectRatio, item.durationSeconds ? `${item.durationSeconds} 秒` : ""].filter(Boolean).join(" · ") || "原记录未标注"}</dd></div>
          <div><dt>费用</dt><dd>{item.cost == null ? item.costNote : `¥${item.cost.toFixed(2)}`}</dd></div>
          <div><dt>有效期</dt><dd>{item.expiresAt ? `${formatTime(item.expiresAt)} 到期` : "以作品状态为准"}</dd></div>
        </dl>
        {item.downloadPath && <button type="button" className={styles.dialogDownload} disabled={downloading} onClick={onDownload}><Download aria-hidden="true" />{downloading ? "正在准备…" : "下载到电脑"}</button>}
        {downloadMessage && <p className={styles.dialogDownloadStatus} role={downloadMessage.error ? "alert" : "status"}>{downloadMessage.text}</p>}
        <p className={styles.dialogHint}>需要长期保存的作品，请及时下载到电脑。</p>
       </aside>
      </div>
    </dialog>
  );
}

function LazyMediaPreview({ item, token, imageResource, onOpen }: { item: MediaHistoryItem; token: string | null; imageResource: MediaHistoryImageResource | null; onOpen: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inViewport, setInViewport] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageState, setImageState] = useState<"idle" | "loading" | "decoding" | "ready" | "error">("idle");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setInViewport(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: "220px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const imagePath = item.kind === "video" ? item.thumbnailPath : item.previewPath;
    if (!inViewport) { setImageUrl(""); setImageState("idle"); return; }
    if (!imagePath || item.status !== "completed" || !token || (item.kind === "image" && !imageResource)) return;
    const controller = new AbortController();
    let nextObjectUrl = "";
    let releaseImage = () => {};
    setImageState("loading");
    void (async () => {
      let release: () => void = () => undefined;
      try {
        release = await acquireThumbnailFetchSlot(controller.signal);
        if (controller.signal.aborted) return;
        let blob: Blob;
        if (item.kind === "image" && imageResource) {
          const handle = imageResource.acquire(imagePath);
          releaseImage = handle.release;
          blob = await handle.promise;
        } else {
          const response = await fetch(imagePath, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
          if (!response.ok) throw new Error("IMAGE_PREVIEW_UNAVAILABLE");
          blob = await response.blob();
          if (blob.type && !blob.type.startsWith("image/")) throw new Error("IMAGE_PREVIEW_INVALID_TYPE");
        }
        nextObjectUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(nextObjectUrl);
          return;
        }
        setImageUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return nextObjectUrl;
        });
        setImageState("decoding");
      } catch {
        if (!controller.signal.aborted) setImageState("error");
      } finally {
        release();
      }
    })();
    return () => { controller.abort(); releaseImage(); };
  }, [attempt, imageResource, inViewport, item.kind, item.previewPath, item.status, item.thumbnailPath, token]);

  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  const waitingLabel = item.status === "queued" || item.status === "processing"
    ? "生成完成后显示作品预览"
    : item.status === "failed"
      ? "任务未交付，暂无可用预览"
      : item.status === "cancelled"
        ? "任务已取消，暂无可用预览"
        : "作品预览暂不可用";
  const PlaceholderIcon = item.kind === "video" ? Film : FileImage;

  return (
    <div ref={containerRef} className={styles.preview} data-media-preview={item.kind}>
      <span className={styles.previewType}>{item.kind === "video" ? "视频首帧" : "图片预览"}</span>
      {item.status !== "completed" ? (
        <div className={styles.previewState}><PlaceholderIcon aria-hidden="true" /><span>{waitingLabel}</span></div>
      ) : !item.previewPath ? (
        <div className={styles.previewState}><PlaceholderIcon aria-hidden="true" /><span>{waitingLabel}</span></div>
      ) : item.kind === "video" ? (
        !inViewport ? (
          <div className={styles.previewState}><Film aria-hidden="true" /><span>接近视区后读取视频首帧</span></div>
        ) : item.thumbnailPath && imageState !== "error" ? (
          (imageState === "ready" || imageState === "decoding") && imageUrl
            ? <>
                {/* eslint-disable-next-line @next/next/no-img-element -- protected blob URL */}
                <img src={imageUrl} alt={`${item.title} 视频首帧`} onLoad={() => setImageState("ready")} onError={() => setImageState("error")} />
              </>
            : <div className={styles.previewState} role="status"><RefreshCw className={styles.spin} aria-hidden="true" /><span>正在读取视频首帧…</span></div>
        ) : (
          <div className={styles.previewState}><Film aria-hidden="true" /><span>点击播放视频</span></div>
        )
      ) : (imageState === "ready" || imageState === "decoding") && imageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- protected blob URL */}
          <img src={imageUrl} alt={`${item.title} 图片预览`} loading="lazy" onLoad={() => setImageState("ready")} onError={() => { imageResource?.invalidate(item.previewPath); setImageState("error"); }} />
          {imageState === "decoding" && <div className={styles.previewDecoding} role="status">正在加载图片…</div>}
        </>
      ) : imageState === "error" ? (
        <button type="button" className={styles.previewButton} onClick={() => setAttempt((value) => value + 1)}>
          <RefreshCw aria-hidden="true" /><span>图片预览暂不可用，点击重试</span>
        </button>
      ) : (
        <div className={styles.previewState} role="status">
          <RefreshCw className={imageState === "loading" ? styles.spin : ""} aria-hidden="true" />
          <span>{inViewport ? "正在读取图片预览…" : "接近视区后读取图片预览"}</span>
        </div>
      )}
      {item.status === "completed" && item.previewPath && (item.kind === "video" || imageState !== "error") && (
        <button type="button" className={styles.previewOpen} onClick={onOpen} aria-label={`预览${item.title}`}>
          <span>{item.kind === "video" ? "播放视频" : "查看图片"}</span>
        </button>
      )}
    </div>
  );
}

export interface MediaHistoryWorkspaceProps {
  onBack?: () => void;
  initialCategory?: "storyboard-workbench" | "video-production";
  recoveryContent?: ReactNode;
  onRecoveryToggle?: (open: boolean) => void;
  onRetryVideo?: (taskId: string) => void;
}

export function MediaHistoryWorkspace({ onBack, initialCategory, recoveryContent, onRecoveryToggle, onRetryVideo }: MediaHistoryWorkspaceProps = {}) {
  const router = useAppScopedRouter();
  const { state } = useApp();
  const compactStoryboardHeader = Boolean(onBack && initialCategory === "storyboard-workbench");
  const [items, setItems] = useState<MediaHistoryItem[]>([]);
  const [offlineHistory, setOfflineHistory] = useState<{ scope: string; items: MediaHistoryItem[] } | null>(null);
  const [kind, setKind] = useState<MediaKindFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>(initialCategory || "all");
  const [historyScope, setHistoryScope] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const historyRequest = useRef(0);
  const historyAbort = useRef<AbortController | null>(null);
  const currentScope = useRef<string | null>(null);
  const offlineDeniedScope = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<MediaHistoryItem | null>(null);
  const [previewDownloadMessage, setPreviewDownloadMessage] = useState<{ id: string; text: string; error: boolean } | null>(null);
  const [imageResourceState, setImageResourceState] = useState<{ scope: string; resource: MediaHistoryImageResource } | null>(null);
  const [selected, setSelected] = useState<Map<string, MediaHistoryItem>>(() => new Map());
  const [downloadStatus, setDownloadStatus] = useState("");
  const [downloadingBatch, setDownloadingBatch] = useState(false);
  const batchSequence = useRef(0);
  const downloadAbort = useRef<AbortController | null>(null);
  const deleteAbort = useRef<AbortController | null>(null);
  const downloadUrls = useRef(new Set<string>());
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const recoveryOpenRef = useRef(false);
  const recoveryDetails = useRef<HTMLDetailsElement | null>(null);
  const recoveryToggleRef = useRef(onRecoveryToggle);
  const [expiredCount, setExpiredCount] = useState(0);
  const [facets, setFacets] = useState<FacetCounts>(EMPTY_FACETS);
  const [pagination, setPagination] = useState<PaginationSummary>({ total: null, currentCount: 0 });

  const token = state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN);
  const currentUserId = state.auth.user?.id || readStoredUserId();
  const isAuthenticated = Boolean(token && currentUserId);
  const accountScope = isAuthenticated ? `${currentUserId}:${token}` : null;
  const imageResource = imageResourceState?.scope === accountScope ? imageResourceState.resource : null;

  useLayoutEffect(() => {
    if (!accountScope || !currentUserId || !token) { setImageResourceState(null); return; }
    const resource = new MediaHistoryImageResource(currentUserId, token);
    setImageResourceState({ scope: accountScope, resource });
    return () => resource.dispose();
  }, [accountScope, currentUserId, token]);

  useLayoutEffect(() => { recoveryToggleRef.current = onRecoveryToggle; }, [onRecoveryToggle]);
  const updateRecoveryOpen = useCallback((open: boolean) => {
    if (recoveryOpenRef.current === open) return;
    recoveryOpenRef.current = open;
    setRecoveryOpen(open);
    recoveryToggleRef.current?.(open);
  }, []);

  useLayoutEffect(() => {
    if (currentScope.current !== accountScope) offlineDeniedScope.current = null;
    if (currentScope.current !== accountScope && recoveryOpenRef.current) {
      if (recoveryDetails.current) recoveryDetails.current.open = false;
      updateRecoveryOpen(false);
    }
    currentScope.current = accountScope;
    setOfflineHistory(null);
    setSelected(new Map());
    setPreviewItem(null);
    setPreviewDownloadMessage(null);
    setDownloadStatus("");
    batchSequence.current += 1;
    downloadAbort.current?.abort();
    downloadAbort.current = null;
    deleteAbort.current?.abort();
    deleteAbort.current = null;
    setDownloadingBatch(false);
    setOpeningId(null);
    for (const url of downloadUrls.current) URL.revokeObjectURL(url);
    downloadUrls.current.clear();
  }, [accountScope, updateRecoveryOpen]);

  useLayoutEffect(() => () => {
    currentScope.current = null;
    batchSequence.current += 1;
    downloadAbort.current?.abort();
    deleteAbort.current?.abort();
    if (recoveryOpenRef.current) {
      recoveryOpenRef.current = false;
      recoveryToggleRef.current?.(false);
    }
    for (const url of downloadUrls.current) URL.revokeObjectURL(url);
    downloadUrls.current.clear();
  }, []);

  useLayoutEffect(() => {
    if (!recoveryContent && recoveryOpenRef.current) updateRecoveryOpen(false);
  }, [recoveryContent, updateRecoveryOpen]);

  useEffect(() => {
    if (!accountScope || !currentUserId || !token) return;
    return subscribeOfflineAuthRevocation(currentUserId, token, null, () => {
      if (currentScope.current !== accountScope) return;
      offlineDeniedScope.current = accountScope;
      historyRequest.current += 1;
      historyAbort.current?.abort();
      setOfflineHistory(null);
      setPreviewItem(null);
      setSelected(new Map());
      setLoading(false);
      setLoadingMore(false);
      setError("当前登录状态尚未重新验证，请联网后重试。");
    });
  }, [accountScope, currentUserId, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => setServerQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadHistory = useCallback(async (offset = 0, background = false) => {
    if (currentScope.current !== accountScope) return;
    if (background && historyAbort.current && !historyAbort.current.signal.aborted) return;
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    const sequence = ++historyRequest.current;
    const current = () => sequence === historyRequest.current && currentScope.current === accountScope;
    if (!background) {
      if (offset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError("");
    }
    if (!isAuthenticated) {
      setItems([]);
      setFacets(EMPTY_FACETS);
      setPagination({ total: null, currentCount: 0 });
      setExpiredCount(0);
      setNextOffset(null);
      setHistoryScope(null);
      setLoading(false);
      setLoadingMore(false);
      window.clearTimeout(timeout);
      if (historyAbort.current === controller) historyAbort.current = null;
      return;
    }
    let networkFailure = false;
    const authVersion = currentUserId && token ? captureOfflineAuthVersions(currentUserId, token).session : 0;
    try {
      const parameters = new URLSearchParams({
        limit: "60",
        offset: String(offset),
        category,
        kind,
        q: serverQuery,
        includeTotal: "true",
      });
      let response: Response;
      try {
        response = await fetch(`/api/media-history?${parameters.toString()}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
      } catch (reason) {
        networkFailure = reason instanceof TypeError && !controller.signal.aborted;
        throw reason;
      }
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (controller.signal.aborted) throw new Error("历史请求已中止");
      if (!current()) return;
      if (!response.ok) {
        setOfflineHistory(null);
        setPreviewItem(null);
        setSelected(new Map());
        if ([401, 403, 404, 410].includes(response.status)) {
          offlineDeniedScope.current = accountScope;
          if (currentUserId && token) await recordOfflineSession(currentUserId, token, "denied", current);
        }
        if (!current()) return;
        if (response.status === 401) throw new Error("登录状态已失效，请返回首页重新登录");
        throw new Error(String(data.error || "媒体历史加载失败，请稍后重试"));
      }
      if (!Array.isArray(data.items)) throw new Error("历史记录返回异常，请刷新重试");
      const incoming = data.items.map(normalizeItem).filter((item): item is MediaHistoryItem => Boolean(item));
      if (currentUserId && token) await recordOfflineSession(currentUserId, token, "verified", current, authVersion);
      if (!current() || controller.signal.aborted) return;
      if (currentUserId && token && captureOfflineAuthVersions(currentUserId, token).session !== authVersion) {
        setOfflineHistory(null); setPreviewItem(null); setSelected(new Map());
        setError("当前登录状态尚未重新验证，请联网后重试。");
        return;
      }
      setItems((previous) => {
        if (offset === 0 && !background) return incoming;
        return mergeHistoryItems(previous, incoming, offset === 0);
      });
      setSelected((previous) => {
        if (!previous.size) return previous;
        const updated = new Map(incoming.map(item => [item.id, item]));
        const next = new Map<string, MediaHistoryItem>();
        for (const [id, selectedItem] of previous) {
          const latest = updated.get(id);
          if (latest?.status === "completed" && latest.downloadPath) next.set(id, latest);
          else if (!latest && (offset !== 0 || background)) next.set(id, selectedItem);
        }
        return next;
      });
      setOfflineHistory(null);
      offlineDeniedScope.current = null;
      if (!background) setError("");
      setFacets(readFacets(data));
      setHistoryScope(accountScope);
      const page = data.pagination && typeof data.pagination === "object"
        ? data.pagination as Record<string, unknown>
        : {};
      const total = finiteCount(page.total ?? data.totalCount ?? data.total);
      const currentCount = finiteCount(page.currentCount) ?? (offset + incoming.length);
      const next = finiteCount(page.nextOffset);
      setPagination({ total, currentCount });
      setExpiredCount(finiteCount(data.expiredCount) ?? 0);
      if (!background) setNextOffset(page.hasMore === true && next !== null ? next : null);
      if (Array.isArray(data.sourceFailures) && data.sourceFailures.length) {
        setError("部分历史暂时无法加载，请刷新重试。");
      }
    } catch (reason) {
      if (networkFailure && current() && !controller.signal.aborted && offset === 0 && !background && currentUserId && token && accountScope && offlineDeniedScope.current !== accountScope) {
        try {
          if (!await offlineAccessAllowed(currentUserId, token)) {
            if (current()) {
              setOfflineHistory(null);
              setPreviewItem(null);
              setSelected(new Map());
              setError("当前登录状态尚未重新验证，请联网后重试。");
            }
            return;
          }
          if (!current() || controller.signal.aborted) return;
          const localItems = await readOfflineVideos(currentUserId, token, controller.signal);
          if (!await offlineAccessAllowed(currentUserId, token)) {
            if (current()) { setOfflineHistory(null); setPreviewItem(null); setSelected(new Map()); setError("当前登录状态尚未重新验证，请联网后重试。"); }
            return;
          }
          if (!current() || controller.signal.aborted) return;
          setOfflineHistory({ scope: accountScope, items: localItems });
          setHistoryScope(accountScope);
          setSelected(new Map());
          setFacets(EMPTY_FACETS);
          setPagination({ total: null, currentCount: localItems.length });
          setExpiredCount(0);
          setNextOffset(null);
          setError("");
        } catch {
          if (current() && !controller.signal.aborted) {
            setOfflineHistory(null);
            setError("无法连接服务器，本机视频副本也暂时不可读取。");
          }
        }
      }
      else if (current() && networkFailure && offlineDeniedScope.current === accountScope) setError("无法连接服务器，当前登录状态尚未重新验证，请联网后重试。");
      else if (current() && timedOut) setError("加载超时，请检查网络后刷新重试。");
      else if (current() && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "媒体历史加载失败，请稍后重试");
    } finally {
      window.clearTimeout(timeout);
      if (historyAbort.current === controller) historyAbort.current = null;
      if (current() && !background) { setLoading(false); setLoadingMore(false); }
    }
  }, [accountScope, category, currentUserId, isAuthenticated, kind, serverQuery, token]);

  const latestLoadHistory = useRef(loadHistory);
  useLayoutEffect(() => { latestLoadHistory.current = loadHistory; }, [loadHistory]);

  useEffect(() => {
    void loadHistory();
    return () => { historyRequest.current += 1; historyAbort.current?.abort(); };
  }, [loadHistory]);

  const offlineMode = Boolean(accountScope && offlineHistory?.scope === accountScope);
  const scopedItems = useMemo(() => {
    // 服务端接口已按 token → user_id 隔离；前端再绑定当前用户上下文，避免登出/切号时复用旧历史。
    if (!currentUserId || historyScope !== accountScope) return [];
    if (offlineMode && offlineHistory) {
      const term = serverQuery.toLocaleLowerCase("zh-CN");
      return offlineHistory.items.filter(item => (category === "all" || item.categoryKey === category)
        && (kind === "all" || item.kind === kind)
        && (!term || [item.id, item.title, item.project, item.segment, item.source, item.publicModelName, item.categoryKey].join("\n").toLocaleLowerCase("zh-CN").includes(term)));
    }
    return items.filter((item) => item.id);
  }, [accountScope, category, currentUserId, items, historyScope, kind, offlineHistory, offlineMode, serverQuery]);

  const hasActiveItems = useMemo(() => scopedItems.some((item) => (
    item.status === "queued" || item.status === "processing"
  )), [scopedItems]);

  useEffect(() => {
    if (!offlineMode || !currentUserId || !accountScope) return;
    const remove = (surface: VideoHistorySurface, ids: string[]) => {
      if (currentScope.current !== accountScope) return;
      const category = surface === "storyboard-workbench" ? "storyboard-workbench" : "video-production";
      const removed = new Set(ids.map(id => `video:${id}`));
      setOfflineHistory(previous => previous?.scope === accountScope
        ? { ...previous, items: previous.items.filter(item => !(item.categoryKey === category && removed.has(item.id))) }
        : previous);
      setSelected(previous => {
        const next = new Map(previous);
        for (const id of removed) next.delete(id);
        return next;
      });
      setPreviewItem(previous => previous && previous.categoryKey === category && removed.has(previous.id) ? null : previous);
    };
    const stopStoryboard = subscribeVideoHistoryRemovals(currentUserId, "storyboard-workbench", ids => remove("storyboard-workbench", ids), ids => remove("storyboard-workbench", ids));
    const stopVideo = subscribeVideoHistoryRemovals(currentUserId, "video-page", ids => remove("video-page", ids), ids => remove("video-page", ids));
    return () => { stopStoryboard(); stopVideo(); };
  }, [accountScope, currentUserId, offlineMode]);

  useEffect(() => {
    if (!isAuthenticated || !hasActiveItems || loading || loadingMore) return;
    const syncActiveHistory = () => {
      if (document.visibilityState === "visible") void loadHistory(0, true);
    };
    const timer = window.setInterval(syncActiveHistory, 15_000);
    window.addEventListener("focus", syncActiveHistory);
    document.addEventListener("visibilitychange", syncActiveHistory);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncActiveHistory);
      document.removeEventListener("visibilitychange", syncActiveHistory);
    };
  }, [hasActiveItems, isAuthenticated, loadHistory, loading, loadingMore]);

  const downloadItem = useCallback(async (item: MediaHistoryItem, signal: AbortSignal) => {
    if (!token || !accountScope || !item.downloadPath) throw new Error("该作品暂无可用下载");
    if (currentScope.current !== accountScope) throw new Error("账号已切换，下载已停止");
    signal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    if (item.localOnly) {
      if (!offlineMode || !currentUserId) throw new Error("本机副本状态已变化，请刷新历史");
      const blob = await loadOfflineVideo(item, currentUserId, token, signal);
      if (currentScope.current !== accountScope || signal.aborted) throw new Error("账号已切换，下载已停止");
      const blobUrl = URL.createObjectURL(blob);
      downloadUrls.current.add(blobUrl);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = safeDownloadName(item, blob.type);
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => { URL.revokeObjectURL(blobUrl); downloadUrls.current.delete(blobUrl); }, 1_000);
      return;
    }
    if (item.kind === "video") {
      const playbackUrl = await requestMediaHistoryVideoUrl(item.previewPath, token, { signal, userId: currentUserId || undefined });
      const preflight = await fetch(playbackUrl, { headers: { Range: "bytes=0-0" }, cache: "no-store", signal });
      const type = preflight.headers.get("content-type")?.toLowerCase() || "";
      if (!preflight.ok || !type.startsWith("video/")) {
        await preflight.body?.cancel().catch(() => undefined);
        if (currentUserId && !signal.aborted && currentScope.current === accountScope) {
          const current = () => !signal.aborted && currentScope.current === accountScope;
          if (preflight.status === 401 || preflight.status === 403) await recordOfflineSession(currentUserId, token, "denied", current);
          else if ((preflight.status === 404 || preflight.status === 410) && item.id.startsWith("video:")) {
            await recordOfflineTask(currentUserId, token, item.id.slice("video:".length), true, current);
          }
        }
        throw new Error(preflight.status === 410 ? "视频已到期，无法下载" : "视频暂时无法读取，请稍后重试");
      }
      await preflight.body?.cancel().catch(() => undefined);
      if (currentScope.current !== accountScope || signal.aborted) throw new Error("账号已切换，下载已停止");
      const mediaUrl = await requestMediaHistoryVideoUrl(item.previewPath, token, { download: true, filename: safeDownloadName(item), signal, userId: currentUserId || undefined });
      if (currentScope.current !== accountScope || signal.aborted) throw new Error("账号已切换，下载已停止");
      const anchor = document.createElement("a");
      anchor.href = mediaUrl;
      anchor.download = safeDownloadName(item);
      anchor.target = "_blank";
      anchor.rel = "noopener";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return;
    }
    const response = await fetch(item.downloadPath, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || (response.status === 401 ? "登录已过期，请重新登录" : "图片文件暂时不可用"));
    }
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("返回的图片格式无效");
    if (currentScope.current !== accountScope || signal.aborted) throw new Error("账号已切换，下载已停止");
    const blobUrl = URL.createObjectURL(blob);
    downloadUrls.current.add(blobUrl);
    const anchor = document.createElement("a");
    anchor.href = blobUrl; anchor.download = safeDownloadName(item, blob.type);
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => { URL.revokeObjectURL(blobUrl); downloadUrls.current.delete(blobUrl); }, 1_000);
  }, [accountScope, currentUserId, offlineMode, token]);

  const downloadOne = useCallback(async (item: MediaHistoryItem) => {
    if (!accountScope || currentScope.current !== accountScope) return;
    const controller = new AbortController();
    downloadAbort.current?.abort(); downloadAbort.current = controller;
    setOpeningId(item.id); setError(""); setDownloadStatus(""); setPreviewDownloadMessage(null);
    try { await downloadItem(item, controller.signal); if (!controller.signal.aborted) { const message = `已向浏览器发起“${item.title}”下载，请查看下载列表。`; setDownloadStatus(message); setPreviewDownloadMessage({ id: item.id, text: message, error: false }); } }
    catch (reason) { if (!controller.signal.aborted) { const message = reason instanceof DOMException && reason.name === "TimeoutError" ? "下载准备超时，请重试" : reason instanceof Error ? reason.message : "媒体文件暂时不可用"; setError(message); setPreviewDownloadMessage({ id: item.id, text: message, error: true }); } }
    finally { if (downloadAbort.current === controller) { downloadAbort.current = null; setOpeningId(null); } }
  }, [accountScope, downloadItem]);

  const downloadSelected = useCallback(async () => {
    const requested = Array.from(selected.values());
    if (!requested.length || !accountScope) return;
    const sequence = ++batchSequence.current;
    const controller = new AbortController();
    downloadAbort.current?.abort(); downloadAbort.current = controller;
    setDownloadingBatch(true); setError("");
    let initiated = 0;
    const failures: string[] = [];
    for (const item of requested) {
      if (currentScope.current !== accountScope || batchSequence.current !== sequence || controller.signal.aborted) break;
      setDownloadStatus(`正在准备 ${initiated + failures.length + 1}/${requested.length}：${item.title}`);
      try { await downloadItem(item, controller.signal); initiated += 1; await new Promise((resolve) => window.setTimeout(resolve, 350)); }
      catch (reason) { failures.push(`${item.title}：${reason instanceof DOMException && reason.name === "TimeoutError" ? "下载准备超时，请重试" : reason instanceof Error ? reason.message : "下载失败"}`); }
    }
    if (currentScope.current === accountScope && batchSequence.current === sequence && !controller.signal.aborted) {
      setDownloadStatus(`已向浏览器发起 ${initiated} 项下载${failures.length ? `，${failures.length} 项准备失败` : ""}。请查看浏览器下载列表；如被拦截，请允许多个文件下载。`);
      if (failures.length) setError(failures.join("；"));
      setDownloadingBatch(false);
    }
    if (downloadAbort.current === controller) downloadAbort.current = null;
  }, [accountScope, downloadItem, selected]);

  const cancelBatchDownload = useCallback(() => {
    batchSequence.current += 1;
    downloadAbort.current?.abort();
    downloadAbort.current = null;
    setDownloadingBatch(false);
    setDownloadStatus("已停止准备后续下载；已发起的下载请在浏览器下载列表中查看。");
  }, []);

  const clearSelectionForFilterChange = useCallback(() => {
    if (!selected.size) return;
    setSelected(new Map());
    setDownloadStatus("筛选已更改，之前选择的作品已取消。");
  }, [selected.size]);

  const deleteServerRecord = useCallback(async (item: MediaHistoryItem) => {
    if (!token || !accountScope || currentScope.current !== accountScope || deleteAbort.current) return;
    if (item.categoryKey === "storyboard-workbench" && item.kind === "video") {
      setError("分镜视频可能仍被项目使用，暂不支持从此处移除。");
      return;
    }
    const ok = window.confirm("将这条记录从历史列表移除？原始对话、生成文件和账单会保留。");
    if (!ok || currentScope.current !== accountScope) return;
    const controller = new AbortController();
    deleteAbort.current = controller;
    const current = () => !controller.signal.aborted && currentScope.current === accountScope && deleteAbort.current === controller;
    setOpeningId(item.id);
    setError("");
    try {
      const response = await fetch("/api/media-history", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: item.id, confirmation: "REMOVE_HISTORY" }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (current()) throw new Error(data.error || "历史记录移除失败");
        return;
      }
      if (item.kind === "image" && item.previewPath) {
        imageResource?.invalidate(item.previewPath);
      }
      if (current()) {
        historyRequest.current += 1;
        historyAbort.current?.abort();
        setItems((previous) => previous.filter((entry) => entry.id !== item.id));
        setOfflineHistory((previous) => previous?.scope === accountScope ? { ...previous, items: previous.items.filter((entry) => entry.id !== item.id) } : previous);
        setPreviewItem((previous) => previous?.id === item.id ? null : previous);
        setSelected((previous) => { const next = new Map(previous); next.delete(item.id); return next; });
      }
      // A successful server removal belongs to the captured account even if
      // the user switches accounts while the request is resolving. Persist a
      // local tombstone before notifying other tabs, so an in-flight automatic
      // download cannot recreate a removed video.
      const taskId = item.kind === "video" && item.id.startsWith("video:") ? item.id.slice("video:".length) : "";
      const localResult = taskId && currentUserId
        ? await publishVideoHistoryRemoval({ userId: currentUserId, token, surface: item.categoryKey === "storyboard-workbench" ? "storyboard-workbench" : "video-page", taskIds: [taskId] })
        : null;
      if (!current()) return;
      await latestLoadHistory.current();
      if (current() && (localResult === "local_failed" || localResult === "invalid")) {
        setError("历史记录已移除，但本机视频副本未能清理，请检查浏览器存储后重试。");
      } else if (current() && localResult === "local_only") {
        setError("历史记录和本机副本已移除，其他打开的页面未收到通知，请刷新那些页面。");
      } else if (current()) {
        setDownloadStatus(`已从历史移除“${item.title}”。`);
      }
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : "历史记录移除失败");
    } finally {
      if (current()) setOpeningId(null);
      if (deleteAbort.current === controller) deleteAbort.current = null;
    }
  }, [accountScope, currentUserId, imageResource, token]);

  return (
    <div className={`${styles.page} ${compactStoryboardHeader ? styles.storyboardHistory : ""} media-history-page`} style={onBack ? { minHeight: 0 } : undefined}>
      {onBack ? (
        <div className={`${styles.main} ${compactStoryboardHeader ? styles.compactHeader : ""}`} style={{ paddingBottom: 0 }}>
          <div className={compactStoryboardHeader ? styles.compactHeading : undefined}>
            <button type="button" className={styles.headerButton} onClick={onBack}>
              <ArrowLeft aria-hidden="true" />
              返回{initialCategory === "storyboard-workbench" ? getPrimaryNavigationLabel("storyboard_workbench", "分镜编排") : initialCategory === "video-production" ? getPrimaryNavigationLabel("create", "视频创作") : "工作台"}
            </button>
            <div className={compactStoryboardHeader ? styles.compactTitle : undefined}>
              <h1 style={compactStoryboardHeader ? undefined : { marginTop: 16, fontSize: 20, fontWeight: 700 }}>作品历史</h1>
              {compactStoryboardHeader && <p>查看与管理已生成的图片和视频</p>}
            </div>
          </div>
          {compactStoryboardHeader && recoveryContent ? (
            <details ref={recoveryDetails} className={styles.compactRecovery} onToggle={(event) => updateRecoveryOpen(event.currentTarget.open)}>
              <summary className={styles.headerButton}>继续创作与任务恢复</summary>
              {recoveryOpen ? <div className={styles.recoveryContent}>{recoveryContent}</div> : null}
            </details>
          ) : null}
        </div>
      ) : (
        <SubPageHeader title="作品历史" subtitle="集中查看图片与视频作品，筛选来源、预览并下载保存" />
      )}

      <main className={styles.main}>
        {recoveryContent && !compactStoryboardHeader ? (
          <details ref={recoveryDetails} style={{ marginBottom: 16 }} onToggle={(event) => updateRecoveryOpen(event.currentTarget.open)}>
            <summary className={styles.headerButton} style={{ cursor: "pointer", padding: "0 12px" }}>继续创作与任务恢复</summary>
            {recoveryOpen ? recoveryContent : null}
          </details>
        ) : null}
        <section className={styles.filterPanel} aria-label="作品历史筛选">
          <div className={styles.filterTop}>
            <div className={styles.filterGroups}>
              <div className={styles.filterGroup}>
                <span className={styles.filterLabel}>生产来源</span>
                <div className={styles.filterButtons} aria-label="生产来源筛选">
                  {CATEGORY_OPTIONS.map((option) => {
                    const count = facets.categories[option.key];
                    return (
                      <button
                        key={option.key}
                        type="button"
                        className={styles.filterButton}
                        data-active={category === option.key}
                        onClick={() => { if (option.key !== category) { clearSelectionForFilterChange(); setCategory(option.key); } }}
                        disabled={downloadingBatch}
                        aria-pressed={category === option.key}
                      >
                        <span>{option.label}</span>
                        <span className={styles.filterCount} aria-label={count === null ? "数量待服务器返回" : `${count} 条`}>
                          {count === null ? "—" : count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={styles.filterGroup}>
                <span className={styles.filterLabel}>媒体类型</span>
                <div className={styles.filterButtons} aria-label="媒体类型筛选">
                  {KIND_OPTIONS.map((option) => {
                    const count = facets.kinds[option.key];
                    return (
                      <button
                        key={option.key}
                        type="button"
                        className={styles.filterButton}
                        data-active={kind === option.key}
                        onClick={() => { if (option.key !== kind) { clearSelectionForFilterChange(); setKind(option.key); } }}
                        disabled={downloadingBatch}
                        aria-pressed={kind === option.key}
                      >
                        <span>{option.label}</span>
                        <span className={styles.filterCount} aria-label={count === null ? "数量待服务器返回" : `${count} 条`}>
                          {count === null ? "—" : count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className={styles.searchArea}>
              <label className={styles.search}>
                <Search aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => { clearSelectionForFilterChange(); setQuery(event.target.value); }}
                  disabled={downloadingBatch}
                  placeholder="搜索项目、分镜、来源或模型"
                  aria-label="搜索作品历史"
                />
              </label>
              <button
                type="button"
                className={styles.refreshButton}
                onClick={() => void loadHistory()}
                disabled={loading || !isAuthenticated}
              >
                <RefreshCw className={loading ? styles.spin : ""} aria-hidden="true" />
                <span>刷新</span>
              </button>
            </div>
          </div>
          <div className={styles.resultSummary} aria-live="polite">
            <span>
              {offlineMode ? "本机缓存列表，云端总数暂不可知" : pagination.total === null
                ? "总数待服务器返回"
                : <><strong>{pagination.total}</strong> 条匹配记录</>}
            </span>
            <span>{offlineMode ? <>当前筛选显示 <strong>{scopedItems.length}</strong> 条本机副本</> : <>本次返回 <strong>{pagination.currentCount}</strong> 条 · 当前已显示 <strong>{scopedItems.length}</strong> 条</>}</span>
          </div>
        </section>

        {offlineMode ? (
          <section className={styles.retentionNotice} aria-label="本机离线说明">
            <Database aria-hidden="true" />
            <div><strong>无法连接服务器，正在查看本机视频副本</strong><p>这里仅显示当前账号此浏览器中可用的本机视频，不能代表云端全部作品；离线时无法核对账单，播放和下载时会再次核验副本完整性。</p></div>
          </section>
        ) : <section className={styles.retentionNotice} aria-label="媒体保留说明">
          <Database aria-hidden="true" />
          <div>
            <strong>作品有访问期限，建议及时下载保存</strong>
            <details className={styles.retentionDetails}>
              <summary>查看保存说明</summary>
              <p>历史记录保存任务索引与预览地址。图片和普通视频的可用时间取决于原始来源；仅返回图片数据的结果刷新后不保留。请以每件作品的实际状态为准。</p>
            </details>
          </div>
          <span><Download aria-hidden="true" />下载到电脑长期保存{expiredCount > 0 ? ` · 已清理 ${expiredCount} 条过期索引` : ""}</span>
        </section>}

        {error && (
          <div className={styles.alert} role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{error}</span>
            <button type="button" onClick={() => void loadHistory()} disabled={loading}>刷新历史</button>
          </div>
        )}

        {downloadStatus && <p className={styles.downloadStatus} role="status">{downloadStatus}</p>}

        {loading && scopedItems.length > 0 && <p className={styles.downloadStatus} role="status">正在更新筛选结果…</p>}
        {(scopedItems.length > 0 || selected.size > 0) && (
          <div className={styles.selectionBar} aria-label="作品选择与下载">
            <button type="button" disabled={loading || downloadingBatch} onClick={() => {
              setSelected((previous) => {
                const next = new Map(previous);
                for (const item of scopedItems) if (item.status === "completed" && item.downloadPath) next.set(item.id, item);
                return next;
              });
            }}>选择已加载作品</button>
            <button type="button" disabled={!selected.size || downloadingBatch} onClick={() => setSelected(new Map())}>取消选择</button>
            <span>已选择 {selected.size} 项（仅已加载作品）</span>
            <button type="button" disabled={!selected.size || downloadingBatch || Boolean(openingId)} onClick={() => void downloadSelected()}>
              <Download aria-hidden="true" />{downloadingBatch ? "正在准备下载…" : "下载所选"}
            </button>
            {downloadingBatch && <button type="button" onClick={cancelBatchDownload}>停止后续下载</button>}
          </div>
        )}

        {loading && scopedItems.length === 0 ? (
          <div className={styles.loading} role="status">
            <RefreshCw className={styles.spin} aria-hidden="true" />
            <span>正在加载作品历史…</span>
          </div>
        ) : scopedItems.length === 0 ? (
          <div className={styles.empty}>
            <Images aria-hidden="true" />
            <h2>{!isAuthenticated ? "登录后查看作品历史" : error ? "作品历史暂时无法加载" : "没有匹配的作品"}</h2>
            <p>
              {isAuthenticated && error ? "请检查连接后重试。"
                : isAuthenticated
                ? "换一个生产来源、媒体类型或关键词试试。未到期的图片与视频会按来源集中显示。"
                : "请先登录，系统会按当前账号隔离并加载图片、视频及其到期信息。"}
            </p>
              {isAuthenticated && error && <button type="button" onClick={() => void loadHistory()}>重试加载</button>}
              {isAuthenticated && !error && (
              <button type="button" onClick={() => { clearSelectionForFilterChange(); setCategory("all"); setKind("all"); setQuery(""); }}>
                清除筛选
              </button>
            )}
          </div>
        ) : (
          <section className={styles.grid} aria-live="polite" aria-label="作品历史列表">
            {scopedItems.map((item) => {
              const Icon = item.kind === "video" ? Film : FileImage;
              const specification = [
                item.aspectRatio,
                item.durationSeconds ? `${item.durationSeconds} 秒` : "",
              ].filter(Boolean).join(" · ") || "原记录未标注";
              return (
                <article key={item.id} className={styles.card} data-category={item.categoryKey}>
                  <LazyMediaPreview item={item} token={token} imageResource={imageResource} onOpen={() => setPreviewItem(item)} />
                  <div className={styles.cardBody}>
                    {item.status === "completed" && item.downloadPath && (
                      <label className={styles.selectItem}>
                        <input type="checkbox" checked={selected.has(item.id)} disabled={downloadingBatch} onChange={(event) => {
                          setSelected((previous) => { const next = new Map(previous); if (event.target.checked) next.set(item.id, item); else next.delete(item.id); return next; });
                        }} />选择下载<span className="sr-only"> {item.title}</span>
                      </label>
                    )}
                    <div className={styles.titleRow}>
                      <span className={styles.kindIcon}><Icon aria-hidden="true" /></span>
                      <div>
                        <h2 title={item.title}>{item.title}</h2>
                        <p title={`${item.project} · ${item.segment}`}>{item.project} · {item.segment}</p>
                      </div>
                      <span className={`${styles.status} ${styles[item.status]}`}>
                        {STATUS_LABEL[item.status]}
                      </span>
                    </div>

                    <div className={styles.categoryLine}>
                      <span>{categoryLabel(item.categoryKey)}</span>
                      <time dateTime={item.createdAt}><Clock3 aria-hidden="true" />{formatTime(item.createdAt)}</time>
                    </div>

                    <dl className={styles.meta}>
                      <div><dt>模型</dt><dd title={item.publicModelName}>{item.publicModelName}</dd></div>
                      <div><dt>规格</dt><dd>{specification}</dd></div>
                      <div><dt>有效期</dt><dd>{item.expiresAt ? `${formatTime(item.expiresAt)} 到期` : "随任务状态更新"}</dd></div>
                    </dl>
                    {item.errorMessage && <p className={styles.errorMessage}>{item.errorMessage}</p>}

                    <div className={styles.actions}>
                      <button type="button" className={styles.secondaryAction} disabled={RETIRED_CATEGORIES.has(item.categoryKey) || Boolean(onBack && item.categoryKey !== initialCategory)} title={RETIRED_CATEGORIES.has(item.categoryKey) ? "该来源入口已停用，历史作品仍可查看" : onBack && item.categoryKey !== initialCategory ? "请先返回当前工作台，再前往其他来源" : undefined} onClick={() => onBack ? onBack() : router.push(item.sourcePath)}>
                        <ExternalLink aria-hidden="true" /><span>查看来源</span>
                      </button>
                      {item.status === "failed" && item.retryPath && !RETIRED_CATEGORIES.has(item.categoryKey) && (!onBack || (onRetryVideo && item.categoryKey === "video-production" && /^video:[A-Za-z0-9_.-]+$/u.test(item.id))) && (
                        <button type="button" onClick={() => {
                          const videoId = /^video:([A-Za-z0-9_.-]+)$/u.exec(item.id)?.[1];
                          if (onRetryVideo && item.categoryKey === "video-production" && videoId) onRetryVideo(videoId);
                          else router.push(item.retryPath);
                        }} title="载入原任务输入后重试">
                          <RefreshCw aria-hidden="true" /><span>载入后重试</span>
                        </button>
                      )}
                      {item.status === "completed" && item.previewPath && (
                        <button type="button" className={styles.primaryAction} disabled={openingId === item.id} onClick={() => setPreviewItem(item)}>
                          <Images aria-hidden="true" /><span>打开预览</span>
                        </button>
                      )}
                      {item.status === "completed" && item.downloadPath && (
                        <button type="button" disabled={Boolean(openingId) || downloadingBatch} onClick={() => void downloadOne(item)}>
                          <Download aria-hidden="true" /><span>下载到电脑</span>
                        </button>
                      )}
                      {item.removable && !(item.categoryKey === "storyboard-workbench" && item.kind === "video") && ["completed", "failed", "cancelled"].includes(item.status) && (
                        <button type="button" className={styles.dangerAction} disabled={Boolean(openingId)} onClick={() => void deleteServerRecord(item)}>
                          <span>从历史移除</span>
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {!loading && historyScope === accountScope && nextOffset !== null && (
          <div className={styles.loadMore}>
            <button type="button" disabled={loadingMore} onClick={() => void loadHistory(nextOffset)}>
              {loadingMore ? <RefreshCw className={styles.spin} aria-hidden="true" /> : null}
              <span>{loadingMore ? "正在加载…" : "加载更多历史"}</span>
            </button>
          </div>
        )}

      </main>
      {previewItem && historyScope === accountScope && accountScope && <MediaPreviewDialog key={`${accountScope}:${previewItem.id}`} item={previewItem} token={token} userId={currentUserId || null} imageResource={imageResource} onClose={() => { setPreviewItem(null); setPreviewDownloadMessage(null); }} onDownload={() => void downloadOne(previewItem)} downloading={openingId === previewItem.id || downloadingBatch} downloadMessage={previewDownloadMessage?.id === previewItem.id ? previewDownloadMessage : null} />}
    </div>
  );
}
