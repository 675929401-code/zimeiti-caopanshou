"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import {
  AlertCircle,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileImage,
  Film,
  Images,
  RefreshCw,
  Search,
} from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import { MediaHistoryVideoPreview } from "@/components/media-history-video-preview";
import { useApp } from "@/contexts/app-context";
import { requestMediaHistoryVideoUrl } from "@/lib/media-history-video-preview";
import {
  MEDIA_HISTORY_CATEGORY_KEYS,
  type MediaHistoryCategoryKey,
  type MediaHistoryRetentionSource,
} from "@/lib/media-history-contract";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeGetItem } from "@/lib/safe-storage";
import styles from "./media-history.module.css";

type MediaKind = "image" | "video";
type MediaStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
type MediaKindFilter = "all" | MediaKind;
type CategoryKey = MediaHistoryCategoryKey;
type CategoryFilter = "all" | CategoryKey;

const CATEGORY_OPTIONS: ReadonlyArray<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "全部来源" },
  { key: "image-workbench", label: "生图工作台" },
  { key: "video-production", label: "视频制作" },
  { key: "storyboard-workbench", label: "分镜工作台" },
  { key: "cover-studio", label: "封面制作" },
  { key: "digital-human", label: "AI 数字人" },
  { key: "short-drama", label: "影视工坊" },
  { key: "free-canvas", label: "自由画布" },
  { key: "agent-output", label: "智能体图片" },
  { key: "commerce-agent", label: "带货 Agent" },
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

function safeDownloadName(item: MediaHistoryItem): string {
  const base = (item.title || item.segment || "媒体文件").replace(/[\\/:*?"<>|]/g, "-");
  return `${base}.${item.kind === "video" ? "mp4" : "png"}`;
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
    CATEGORY_OPTIONS.map((option) => option.key),
  );
  const kindCounts = facetRecord(
    facets.kinds ?? facets.kind ?? payload.kinds,
    KIND_OPTIONS.map((option) => option.key),
  );
  const categoryKeys = CATEGORY_OPTIONS
    .map((option) => option.key)
    .filter((key): key is CategoryKey => key !== "all");
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

function LazyMediaPreview({ item, token }: { item: MediaHistoryItem; token: string | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inViewport, setInViewport] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageState, setImageState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || inViewport) return;
    if (!("IntersectionObserver" in window)) {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setInViewport(true);
      observer.disconnect();
    }, { rootMargin: "220px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inViewport]);

  useEffect(() => {
    const imagePath = item.kind === "video" ? item.thumbnailPath : item.previewPath;
    if (!inViewport || !imagePath || item.status !== "completed" || !token) return;
    const controller = new AbortController();
    let nextObjectUrl = "";
    setImageState("loading");
    void (async () => {
      let release: () => void = () => undefined;
      try {
        if (item.kind === "video") release = await acquireThumbnailFetchSlot(controller.signal);
        const response = await fetch(imagePath, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("IMAGE_PREVIEW_UNAVAILABLE");
        const blob = await response.blob();
        if (blob.type && !blob.type.startsWith("image/")) throw new Error("IMAGE_PREVIEW_INVALID_TYPE");
        nextObjectUrl = URL.createObjectURL(blob);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(nextObjectUrl);
          return;
        }
        setImageUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return nextObjectUrl;
        });
        setImageState("ready");
      } catch {
        if (!controller.signal.aborted) setImageState("error");
      } finally {
        release();
      }
    })();
    return () => controller.abort();
  }, [attempt, inViewport, item.kind, item.previewPath, item.status, item.thumbnailPath, token]);

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
          imageState === "ready" && imageUrl
            ? <>
                {/* eslint-disable-next-line @next/next/no-img-element -- protected blob URL */}
                <img src={imageUrl} alt={`${item.title} 视频首帧`} />
              </>
            : <div className={styles.previewState} role="status"><RefreshCw className={styles.spin} aria-hidden="true" /><span>正在读取视频首帧…</span></div>
        ) : (
          <MediaHistoryVideoPreview previewPath={item.previewPath} title={item.title} token={token} />
        )
      ) : imageState === "ready" && imageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- protected blob URL */}
          <img src={imageUrl} alt={`${item.title} 图片预览`} loading="lazy" />
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
    </div>
  );
}

export default function MediaHistoryPage() {
  const router = useAppScopedRouter();
  const { state } = useApp();
  const [items, setItems] = useState<MediaHistoryItem[]>([]);
  const [kind, setKind] = useState<MediaKindFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [historyScope, setHistoryScope] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const historyRequest = useRef(0);
  const currentScope = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [expiredCount, setExpiredCount] = useState(0);
  const [facets, setFacets] = useState<FacetCounts>(EMPTY_FACETS);
  const [pagination, setPagination] = useState<PaginationSummary>({ total: null, currentCount: 0 });

  const token = state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN);
  const currentUserId = state.auth.user?.id || readStoredUserId();
  const isAuthenticated = Boolean(token && currentUserId);

  useEffect(() => {
    currentScope.current = token;
  }, [currentUserId, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => setServerQuery(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  const loadHistory = useCallback(async (offset = 0, background = false) => {
    const sequence = ++historyRequest.current;
    const current = () => sequence === historyRequest.current && currentScope.current === token;
    if (!background) {
      if (offset === 0) {
        setLoading(true);
        setHistoryScope(null);
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
      return;
    }
    try {
      const parameters = new URLSearchParams({
        limit: "60",
        offset: String(offset),
        category,
        kind,
        q: serverQuery,
        includeTotal: "true",
      });
      const response = await fetch(`/api/media-history?${parameters.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!current()) return;
      if (!response.ok) {
        if (response.status === 401) throw new Error("登录状态已失效，请返回首页重新登录");
        throw new Error(String(data.error || "媒体历史加载失败，请稍后重试"));
      }
      const incoming = Array.isArray(data.items)
        ? data.items.map(normalizeItem).filter((item): item is MediaHistoryItem => Boolean(item))
        : [];
      setItems((previous) => {
        if (offset === 0 && !background) return incoming;
        return mergeHistoryItems(previous, incoming, offset === 0);
      });
      setFacets(readFacets(data));
      setHistoryScope(token);
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
      if (current()) setError(reason instanceof Error ? reason.message : "媒体历史加载失败，请稍后重试");
    } finally {
      if (current() && !background) { setLoading(false); setLoadingMore(false); }
    }
  }, [category, isAuthenticated, kind, serverQuery, token]);

  useEffect(() => {
    void loadHistory();
    return () => { historyRequest.current += 1; };
  }, [loadHistory]);

  const scopedItems = useMemo(() => {
    // 服务端接口已按 token → user_id 隔离；前端再绑定当前用户上下文，避免登出/切号时复用旧历史。
    if (!currentUserId || historyScope !== token) return [];
    return items.filter((item) => item.id);
  }, [currentUserId, items, historyScope, token]);

  const hasActiveItems = useMemo(() => scopedItems.some((item) => (
    item.status === "queued" || item.status === "processing"
  )), [scopedItems]);

  useEffect(() => {
    if (!isAuthenticated || !hasActiveItems) return;
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
  }, [hasActiveItems, isAuthenticated, loadHistory]);

  const openMedia = useCallback(async (item: MediaHistoryItem, download: boolean) => {
    const targetWindow = download ? null : window.open("about:blank", "_blank");
    setOpeningId(item.id);
    setError("");
    try {
      if (item.kind === "video") {
        const mediaUrl = await requestMediaHistoryVideoUrl(item.previewPath, token, {
          download,
          filename: safeDownloadName(item),
        });
        if (download) {
          const anchor = document.createElement("a");
          anchor.href = mediaUrl;
          anchor.download = safeDownloadName(item);
          anchor.rel = "noopener";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } else if (targetWindow) {
          targetWindow.location.href = mediaUrl;
        }
        return;
      }
      const response = await fetch(download ? item.downloadPath : item.previewPath, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || (response.status === 401 ? "登录已过期，请重新登录" : "媒体文件暂时不可用"));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = blobUrl;
        anchor.download = safeDownloadName(item);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else if (targetWindow) {
        targetWindow.location.href = blobUrl;
      }
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (reason) {
      targetWindow?.close();
      setError(reason instanceof Error ? reason.message : "媒体文件暂时不可用");
    } finally {
      setOpeningId(null);
    }
  }, [token]);

  const deleteServerRecord = useCallback(async (item: MediaHistoryItem) => {
    if (!token) return;
    const ok = window.confirm("将这条记录从历史列表移除？原始对话、生成文件和账单会保留。");
    if (!ok) return;
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
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "历史记录移除失败");
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "历史记录移除失败");
    } finally {
      setOpeningId(null);
    }
  }, [loadHistory, token]);

  return (
    <div className={styles.page}>
      <SubPageHeader
        title="作品历史"
        subtitle="集中查看图片与视频作品，筛选来源、预览首帧并下载长期保存"
      />

      <main className={styles.main}>
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
                        onClick={() => setCategory(option.key)}
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
                        onClick={() => setKind(option.key)}
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
                  onChange={(event) => setQuery(event.target.value)}
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
              {pagination.total === null
                ? "总数待服务器返回"
                : <><strong>{pagination.total}</strong> 条匹配记录</>}
            </span>
            <span>本次返回 <strong>{pagination.currentCount}</strong> 条 · 当前已显示 <strong>{scopedItems.length}</strong> 条</span>
          </div>
        </section>

        <section className={styles.retentionNotice} aria-label="媒体保留说明">
          <Database aria-hidden="true" />
          <div>
            <strong>历史仅保存任务索引、受控预览地址与到期信息</strong>
            <p>图片没有明确到期信息时保留两天；普通视频不设平台固定天数，源有效即可播放或下载，确认失效后自动移出历史。</p>
          </div>
          <span><Download aria-hidden="true" />下载到电脑长期保存{expiredCount > 0 ? ` · 已清理 ${expiredCount} 条过期索引` : ""}</span>
        </section>

        {error && (
          <div className={styles.alert} role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className={styles.loading} role="status">
            <RefreshCw className={styles.spin} aria-hidden="true" />
            <span>正在加载作品历史…</span>
          </div>
        ) : scopedItems.length === 0 ? (
          <div className={styles.empty}>
            <Images aria-hidden="true" />
            <h2>{!isAuthenticated ? "登录后查看作品历史" : "没有匹配的作品"}</h2>
            <p>
              {isAuthenticated
                ? "换一个生产来源、媒体类型或关键词试试。未到期的图片与视频会按来源集中显示。"
                : "请先登录，系统会按当前账号隔离并加载图片、视频及其到期信息。"}
            </p>
            {isAuthenticated && (
              <button type="button" onClick={() => { setCategory("all"); setKind("all"); setQuery(""); }}>
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
                  <LazyMediaPreview item={item} token={token} />
                  <div className={styles.cardBody}>
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
                      <div><dt>来源</dt><dd title={item.source}>{item.source}</dd></div>
                      <div><dt>模型</dt><dd title={item.publicModelName}>{item.publicModelName}</dd></div>
                      <div><dt>规格</dt><dd>{specification}</dd></div>
                      <div><dt>费用</dt><dd>{item.cost == null ? item.costNote : `¥${item.cost.toFixed(2)}`}</dd></div>
                      <div><dt>有效期</dt><dd>{item.expiresAt ? `${formatTime(item.expiresAt)} 到期` : "随任务状态更新"}</dd></div>
                    </dl>
                    {item.errorMessage && <p className={styles.errorMessage}>{item.errorMessage}</p>}

                    <div className={styles.actions}>
                      <button type="button" onClick={() => router.push(item.sourcePath)}>
                        <ExternalLink aria-hidden="true" /><span>查看来源</span>
                      </button>
                      {item.status === "failed" && item.retryPath && (
                        <button type="button" onClick={() => router.push(item.retryPath)} title="载入原任务输入后重试">
                          <RefreshCw aria-hidden="true" /><span>载入后重试</span>
                        </button>
                      )}
                      {item.status === "completed" && item.previewPath && (
                        <button type="button" disabled={openingId === item.id} onClick={() => void openMedia(item, false)}>
                          <Images aria-hidden="true" /><span>打开预览</span>
                        </button>
                      )}
                      {item.status === "completed" && item.downloadPath && (
                        <button type="button" disabled={openingId === item.id} onClick={() => void openMedia(item, true)}>
                          <Download aria-hidden="true" /><span>下载到电脑</span>
                        </button>
                      )}
                      {item.removable && ["completed", "failed", "cancelled"].includes(item.status) && (
                        <button type="button" className={styles.dangerAction} disabled={openingId === item.id} onClick={() => void deleteServerRecord(item)}>
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

        {!loading && historyScope === token && nextOffset !== null && (
          <div className={styles.loadMore}>
            <button type="button" disabled={loadingMore} onClick={() => void loadHistory(nextOffset)}>
              {loadingMore ? <RefreshCw className={styles.spin} aria-hidden="true" /> : null}
              <span>{loadingMore ? "正在加载…" : "加载更多历史"}</span>
            </button>
          </div>
        )}

      </main>
    </div>
  );
}
