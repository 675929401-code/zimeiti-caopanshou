"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  AlertCircle,
  Bot,
  CircleCheck,
  Download,
  ExternalLink,
  File as FileIcon,
  FileAudio,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  type ChangeEvent,
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp } from "@/contexts/app-context";
import { safeGetItem } from "@/lib/safe-storage";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import styles from "./official-assets-route.module.css";

type AssetCategory = "image" | "video" | "audio" | "document" | "archive" | "other";
type AssetSource = "generated" | "stored";
type SemanticAssetCategory =
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "storyboard"
  | "final"
  | "music"
  | "voice"
  | "audio"
  | "sound-effect"
  | "image"
  | "video"
  | "other";
type SemanticAssetOrigin = "metadata" | "inferred";

interface SemanticAssetMetadata {
  semanticCategory?: string;
  semantic_category?: string;
  assetSemanticCategory?: string;
  asset_semantic_category?: string;
  tags?: string[] | string;
  metadata?: Record<string, unknown>;
}

interface MediaHistoryItem extends SemanticAssetMetadata {
  id: string;
  kind: "image" | "video";
  title: string;
  project: string;
  segment: string;
  source: string;
  sourcePath: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  createdAt: string;
  publicModelName: string;
  cost: number | null;
  costNote: string;
  previewPath: string;
  downloadPath: string;
  errorMessage: string;
  aspectRatio: string;
  durationSeconds: number | null;
}

interface StoredFileItem extends SemanticAssetMetadata {
  id: string;
  file_name: string;
  file_category: AssetCategory;
  file_size: number;
  content_type: string;
  source: string | null;
  is_public: boolean;
  created_at: string;
}

interface StorageQuota {
  usedBytes: number;
  fileCount: number;
  byCategory?: Partial<Record<AssetCategory, { usedBytes: number; fileCount: number }>>;
}

interface AssetPagination {
  offset: number;
  limit: number;
  returned: number;
  total?: number | null;
  hasMore: boolean;
  nextOffset: number | null;
  totalKnown?: boolean;
}

const EMPTY_PAGINATION: AssetPagination = {
  offset: 0,
  limit: 100,
  returned: 0,
  total: 0,
  hasMore: false,
  nextOffset: null,
};

interface UnifiedAssetItem {
  id: string;
  sourceType: AssetSource;
  category: AssetCategory;
  title: string;
  source: string;
  createdAt: string;
  subtitle: string;
  status: string;
  size: number | null;
  previewPath?: string;
  downloadPath?: string;
  sourcePath?: string;
  errorMessage?: string;
  semantic: {
    category: SemanticAssetCategory;
    origin: SemanticAssetOrigin;
  };
}

const CATEGORY_OPTIONS: readonly { value: "all" | AssetCategory; label: string; icon?: ComponentType<{ size?: number }> }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片", icon: FileImage },
  { value: "video", label: "视频", icon: Film },
  { value: "audio", label: "音频", icon: FileAudio },
  { value: "document", label: "文档", icon: FileText },
] as const;

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  stored: "已归档",
};

const SEMANTIC_CATEGORY_OPTIONS: readonly { value: "all" | SemanticAssetCategory; label: string; marker?: string }[] = [
  { value: "all", label: "全部分类" },
  { value: "character", label: "角色", marker: "♟" },
  { value: "scene", label: "场景", marker: "🏞" },
  { value: "prop", label: "道具", marker: "💍" },
  { value: "style", label: "风格", marker: "🎨" },
  { value: "storyboard", label: "分镜", marker: "🎬" },
  { value: "final", label: "成片", marker: "🎞" },
  { value: "music", label: "音乐", marker: "🎵" },
  { value: "voice", label: "语音", marker: "🎙" },
  { value: "audio", label: "音频", marker: "🎧" },
  { value: "sound-effect", label: "音效", marker: "🔊" },
  { value: "image", label: "图片", marker: "🖼" },
  { value: "video", label: "视频", marker: "🎥" },
  { value: "other", label: "其他", marker: "📁" },
] as const;

const SEMANTIC_CATEGORY_LABEL: Record<SemanticAssetCategory, string> = Object.fromEntries(
  SEMANTIC_CATEGORY_OPTIONS
    .filter((option): option is { value: SemanticAssetCategory; label: string } => option.value !== "all")
    .map((option) => [option.value, option.label]),
) as Record<SemanticAssetCategory, string>;

const SEMANTIC_CATEGORY_ALIASES: Record<string, SemanticAssetCategory> = {
  "角色": "character",
  "人物": "character",
  character: "character",
  role: "character",
  avatar: "character",
  "场景": "scene",
  scene: "scene",
  setting: "scene",
  "道具": "prop",
  prop: "prop",
  object: "prop",
  "风格": "style",
  style: "style",
  "分镜": "storyboard",
  storyboard: "storyboard",
  "成片": "final",
  "成品": "final",
  final: "final",
  finished: "final",
  "音乐": "music",
  music: "music",
  bgm: "music",
  "语音": "voice",
  "配音": "voice",
  voice: "voice",
  narration: "voice",
  "音频": "audio",
  audio: "audio",
  "音效": "sound-effect",
  sfx: "sound-effect",
  "sound-effect": "sound-effect",
  "图片": "image",
  image: "image",
  "视频": "video",
  video: "video",
  "其他": "other",
  other: "other",
};

function normalizeSemanticCategory(value: unknown): SemanticAssetCategory | undefined {
  if (typeof value !== "string") return undefined;
  return SEMANTIC_CATEGORY_ALIASES[value.trim().toLowerCase()];
}

function semanticCategoryFromMetadata(item: SemanticAssetMetadata): SemanticAssetCategory | undefined {
  const metadata = item.metadata || {};
  const tagValues = Array.isArray(item.tags) ? item.tags : typeof item.tags === "string" ? item.tags.split(/[,，|/]/) : [];
  const candidates = [
    item.semanticCategory,
    item.semantic_category,
    item.assetSemanticCategory,
    item.asset_semantic_category,
    metadata.semanticCategory,
    metadata.semantic_category,
    metadata.assetSemanticCategory,
    metadata.asset_semantic_category,
    ...tagValues,
  ];
  return candidates.map(normalizeSemanticCategory).find((category): category is SemanticAssetCategory => Boolean(category));
}

function resolveSemanticCategory(
  item: SemanticAssetMetadata & Pick<UnifiedAssetItem, "category" | "title" | "source" | "subtitle">,
): UnifiedAssetItem["semantic"] {
  const metadataCategory = semanticCategoryFromMetadata(item);
  if (metadataCategory) return { category: metadataCategory, origin: "metadata" };

  const text = [item.title, item.subtitle, item.source].join(" ").toLowerCase();
  const titleRules: readonly [RegExp, SemanticAssetCategory][] = [
    [/(角色|人物|主角|肖像|形象设定|character|avatar|portrait)/i, "character"],
    [/(场景|环境|地点|背景图|scene|setting|environment)/i, "scene"],
    [/(道具|物件|产品图|prop|object)/i, "prop"],
    [/(风格|画风|视觉设定|style|lookdev)/i, "style"],
    [/(分镜|镜头表|storyboard|shot ?list)/i, "storyboard"],
    [/(成片|成品|终版|final|finished|export|render)/i, "final"],
    [/(音乐|配乐|bgm|music|song)/i, "music"],
    [/(语音|配音|旁白|人声|voice|narration|tts)/i, "voice"],
    [/(音效|环境声|拟音|sfx|sound effect)/i, "sound-effect"],
  ];
  const titleCategory = titleRules.find(([pattern]) => pattern.test(text))?.[1];
  if (titleCategory) return { category: titleCategory, origin: "inferred" };

  if (item.category === "image") return { category: "image", origin: "metadata" };
  if (item.category === "video") return { category: "video", origin: "metadata" };
  if (item.category === "audio") return { category: "audio", origin: "metadata" };
  return { category: "other", origin: "metadata" };
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "生成记录";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function inferUploadCategory(file: File): AssetCategory {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (/\.(?:txt|md|pdf|doc|docx|ppt|pptx|xls|xlsx|csv)$/i.test(file.name)) return "document";
  if (/\.(?:zip|rar|7z|tar|gz)$/i.test(file.name)) return "archive";
  return "other";
}

function categoryIcon(category: AssetCategory) {
  if (category === "image") return FileImage;
  if (category === "video") return Film;
  if (category === "audio") return FileAudio;
  if (category === "document") return FileText;
  return FileIcon;
}

function appendUniqueById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

async function fetchAssetJson<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as T;
    return { response, payload };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function OfficialAssetsRoute() {
  const { state } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedAssetsRef = useRef(false);
  const activeTokenRef = useRef<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaHistoryItem[]>([]);
  const [storedFiles, setStoredFiles] = useState<StoredFileItem[]>([]);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  const [mediaPagination, setMediaPagination] = useState<AssetPagination>(EMPTY_PAGINATION);
  const [storagePagination, setStoragePagination] = useState<AssetPagination>(EMPTY_PAGINATION);
  const [sourceFailures, setSourceFailures] = useState<string[]>([]);
  const [category, setCategory] = useState<"all" | AssetCategory>("all");
  const [semanticCategory, setSemanticCategory] = useState<"all" | SemanticAssetCategory>("all");
  const [source, setSource] = useState<"all" | AssetSource>("all");
  const [sort, setSort] = useState<"latest" | "earliest">("latest");
  const [query, setQuery] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"media" | "storage" | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const token = state.auth.token || (hydrated ? safeGetItem(STORAGE_KEYS.AUTH_TOKEN) : null);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const loadAssets = useCallback(async () => {
    if (!token) {
      hasLoadedAssetsRef.current = false;
      activeTokenRef.current = null;
      setMediaItems([]);
      setStoredFiles([]);
      setQuota(null);
      setMediaPagination(EMPTY_PAGINATION);
      setStoragePagination(EMPTY_PAGINATION);
      setSourceFailures([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const tokenChanged = activeTokenRef.current !== null && activeTokenRef.current !== token;
    activeTokenRef.current = token;
    if (tokenChanged) {
      hasLoadedAssetsRef.current = false;
      setMediaItems([]);
      setStoredFiles([]);
      setQuota(null);
      setMediaPagination(EMPTY_PAGINATION);
      setStoragePagination(EMPTY_PAGINATION);
      setSourceFailures([]);
    }
    const preservingSnapshot = hasLoadedAssetsRef.current;
    if (preservingSnapshot) setRefreshing(true);
    else setLoading(true);
    setError("");
    setNotice("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [mediaResult, storageResult] = await Promise.allSettled([
        fetchAssetJson<{
          items?: MediaHistoryItem[];
          pagination?: AssetPagination;
          sourceFailures?: string[];
        }>("/api/media-history?limit=100&offset=0", { headers, cache: "no-store" }),
        fetchAssetJson<{
          files?: StoredFileItem[];
          quota?: StorageQuota;
          pagination?: AssetPagination;
        }>("/api/storage/files?limit=100&offset=0&quota=true", { headers, cache: "no-store" }),
      ]);

      let successCount = 0;
      const partialFailures: string[] = [];

      if (mediaResult.status === "fulfilled" && mediaResult.value.response.ok) {
        const payload = mediaResult.value.payload;
        const items = Array.isArray(payload.items) ? payload.items : [];
        setMediaItems(items);
        setMediaPagination(payload.pagination || { ...EMPTY_PAGINATION, returned: items.length });
        if (payload.sourceFailures?.length) {
          partialFailures.push(`生成记录（${payload.sourceFailures.join("、")}）`);
        }
        successCount += 1;
      } else {
        if (!preservingSnapshot) {
          setMediaItems([]);
          setMediaPagination(EMPTY_PAGINATION);
        }
        partialFailures.push("生成记录");
      }

      if (storageResult.status === "fulfilled" && storageResult.value.response.ok) {
        const payload = storageResult.value.payload;
        const files = Array.isArray(payload.files) ? payload.files : [];
        setStoredFiles(files);
        setQuota(payload.quota || null);
        setStoragePagination(payload.pagination || { ...EMPTY_PAGINATION, returned: files.length });
        successCount += 1;
      } else {
        if (!preservingSnapshot) {
          setStoredFiles([]);
          setQuota(null);
          setStoragePagination(EMPTY_PAGINATION);
        }
        partialFailures.push("个人文件");
      }

      if (successCount === 0) {
        if (preservingSnapshot) {
          setSourceFailures(partialFailures);
          setError("本次刷新失败，已保留上次成功加载的资产");
          return;
        }
        throw new Error("个人资产暂时无法加载，请稍后重试");
      }
      hasLoadedAssetsRef.current = true;
      setSourceFailures(partialFailures);
      setNotice(partialFailures.length ? `${partialFailures.join("、")}暂时不可用，已展示其余资产。` : "");
    } catch (reason) {
      setSourceFailures(["生成记录", "个人文件"]);
      const message = reason instanceof Error ? reason.message : "个人资产暂时无法加载，请稍后重试";
      setError(preservingSnapshot ? `${message}；已保留上次成功加载的资产` : message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    if (!hydrated) return;
    void loadAssets();
  }, [hydrated, loadAssets]);

  const loadMoreMedia = useCallback(async () => {
    if (!token || loadingMore || !mediaPagination.hasMore || mediaPagination.nextOffset === null) return;
    setLoadingMore("media");
    setError("");
    try {
      const response = await fetch(
        `/api/media-history?limit=100&offset=${mediaPagination.nextOffset}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        items?: MediaHistoryItem[];
        pagination?: AssetPagination;
        sourceFailures?: string[];
      };
      if (!response.ok) throw new Error(payload.error || "更多生成记录暂时无法加载");
      const items = Array.isArray(payload.items) ? payload.items : [];
      setMediaItems((current) => appendUniqueById(current, items));
      setMediaPagination(payload.pagination || {
        ...mediaPagination,
        returned: items.length,
        hasMore: items.length === 100,
        nextOffset: items.length ? mediaPagination.nextOffset! + items.length : null,
      });
      if (payload.sourceFailures?.length) {
        const failure = `生成记录（${payload.sourceFailures.join("、")}）`;
        setSourceFailures((current) => Array.from(new Set([...current, failure])));
        setNotice(`${failure}暂时不可用，已保留成功加载的数据。`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多生成记录暂时无法加载");
    } finally {
      setLoadingMore(null);
    }
  }, [loadingMore, mediaPagination, token]);

  const loadMoreStorage = useCallback(async () => {
    if (!token || loadingMore || !storagePagination.hasMore || storagePagination.nextOffset === null) return;
    setLoadingMore("storage");
    setError("");
    try {
      const response = await fetch(
        `/api/storage/files?limit=100&offset=${storagePagination.nextOffset}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        files?: StoredFileItem[];
        pagination?: AssetPagination;
      };
      if (!response.ok) throw new Error(payload.error || "更多存储文件暂时无法加载");
      const files = Array.isArray(payload.files) ? payload.files : [];
      setStoredFiles((current) => appendUniqueById(current, files));
      setStoragePagination(payload.pagination || {
        ...storagePagination,
        returned: files.length,
        hasMore: files.length === 100,
        nextOffset: files.length ? storagePagination.nextOffset! + files.length : null,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多存储文件暂时无法加载");
    } finally {
      setLoadingMore(null);
    }
  }, [loadingMore, storagePagination, token]);

  const unifiedItems = useMemo<UnifiedAssetItem[]>(() => {
    const generated: UnifiedAssetItem[] = mediaItems.map((item) => {
      const asset = {
        id: item.id,
        sourceType: "generated" as const,
        category: item.kind,
        title: item.title,
        source: item.source,
        createdAt: item.createdAt,
        subtitle: [item.project, item.segment, item.publicModelName].filter(Boolean).join(" · "),
        status: item.status,
        size: null,
        previewPath: item.status === "completed" ? item.previewPath : undefined,
        downloadPath: item.status === "completed" ? item.downloadPath : undefined,
        sourcePath: item.sourcePath,
        errorMessage: item.errorMessage,
      };
      return { ...asset, semantic: resolveSemanticCategory({ ...item, ...asset }) };
    });
    const stored: UnifiedAssetItem[] = storedFiles.map((item) => {
      const contentPath = `/api/storage/files/${encodeURIComponent(item.id)}/content`;
      const previewable = ["image", "video", "audio"].includes(item.file_category)
        || item.content_type === "application/pdf"
        || item.content_type === "text/plain";
      const asset = {
        id: `stored:${item.id}`,
        sourceType: "stored" as const,
        category: item.file_category || "other",
        title: item.file_name || "未命名文件",
        source: item.source || "个人上传",
        createdAt: item.created_at,
        subtitle: `${item.file_category || "文件"} · ${item.content_type || "未知格式"}`,
        status: "stored",
        size: Number(item.file_size) || 0,
        previewPath: previewable ? contentPath : undefined,
        downloadPath: `${contentPath}?download=1`,
      };
      return { ...asset, semantic: resolveSemanticCategory({ ...item, ...asset }) };
    });
    const keyword = query.trim().toLowerCase();
    return [...generated, ...stored]
      .filter((item) => category === "all" || item.category === category)
      .filter((item) => semanticCategory === "all" || item.semantic.category === semanticCategory)
      .filter((item) => source === "all" || item.sourceType === source)
      .filter((item) => !keyword || [item.title, item.subtitle, item.source].some((value) => value.toLowerCase().includes(keyword)))
      .sort((left, right) => {
        const delta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        return sort === "latest" ? delta : -delta;
      });
  }, [category, mediaItems, query, semanticCategory, sort, source, storedFiles]);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => !current);
  }, []);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !token || uploading) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", inferUploadCategory(file));
      formData.append("source", "个人资产");
      const response = await fetch("/api/storage/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "上传失败");
      await loadAssets();
      setNotice(`“${file.name}”已上传到个人资产。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  const openMedia = useCallback((item: UnifiedAssetItem, download: boolean) => {
    const path = download ? item.downloadPath : item.previewPath;
    if (!path || !token) return;
    setOpeningId(item.id);
    setError("");
    try {
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = path;
        anchor.download = item.title.replace(/[\\/:*?"<>|]/g, "-");
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else {
        const targetWindow = window.open("about:blank", "_blank");
        if (!targetWindow) throw new Error("浏览器阻止了媒体预览窗口");
        targetWindow.opener = null;
        targetWindow.location.replace(path);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "媒体文件暂时不可用");
    } finally {
      setOpeningId(null);
    }
  }, [token]);

  return (
    <div className={styles.assetsRoute}>
      <h1 className={styles.srOnly}>个人资产</h1>
      <header className={styles.assetsToolbar}>
        <div className={styles.assetsP0HeaderRow}>
          <div className={styles.assetsPrimaryTabs}>
            <span className={styles.assetsFolderMark}><FolderOpen size={19} /></span>
            <strong>素材</strong>
            <small>提示词暂未作为独立素材保存</small>
          </div>
          <div className={styles.assetsActions}>
            <button
              type="button"
              aria-pressed={selectionMode}
              disabled={!token}
              onClick={toggleSelectionMode}
            >
              <CircleCheck size={14} />
              {selectionMode ? "完成选择" : "选择"}
            </button>
          </div>
        </div>

        <div className={`${styles.assetsP0Layer} ${styles.assetsP0PrimaryLayer}`}>
          <div className={styles.assetsFilterGroup} aria-label="素材类型">
            {CATEGORY_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button key={value} type="button" data-active={category === value ? "true" : undefined} onClick={() => setCategory(value)}>
                {Icon ? <Icon size={14} /> : null}{label}
              </button>
            ))}
          </div>
          <div className={`${styles.assetsFilterGroup} ${styles.assetsSourceGroup}`} aria-label="素材来源">
            {([
              ["all", "全部来源", null],
              ["stored", "上传", Upload],
              ["generated", "AI 生成", Bot],
            ] as const).map(([value, label, SourceIcon]) => (
              <button key={value} type="button" data-active={source === value ? "true" : undefined} onClick={() => setSource(value)}>
                {SourceIcon ? <SourceIcon size={14} /> : null}{label}
              </button>
            ))}
          </div>
          {token ? (
            <div className={styles.assetsP0CreationActions} aria-label="资产创建操作">
              <button className={styles.assetsP0ActionButton} type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                {uploading ? <LoaderCircle className={styles.spin} size={16} /> : <Upload size={16} />}
                {uploading ? "上传中" : "上传素材"}
              </button>
              <Link href="/youcai/image-workbench" className={styles.assetsP0GenerateLink}>
                <Sparkles size={16} />开始创作
              </Link>
              <button
                className={styles.assetsP0RefreshAction}
                type="button"
                disabled={loading || refreshing}
                onClick={() => void loadAssets()}
                title={refreshing ? "正在刷新资产" : "刷新资产"}
                aria-label={refreshing ? "正在刷新资产" : "刷新资产"}
              >
                <RefreshCw className={loading || refreshing ? styles.spin : undefined} size={15} />
              </button>
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            className={styles.hiddenInput}
            onChange={handleUpload}
            aria-label="上传素材文件"
          />
        </div>

        <div className={`${styles.assetsP0Layer} ${styles.assetsP0SemanticLayer}`}>
          <div className={`${styles.assetsFilterGroup} ${styles.assetsP0SemanticGroup}`} aria-label="素材语义分类">
            {SEMANTIC_CATEGORY_OPTIONS.map(({ value, label, marker }) => (
              <button
                key={value}
                type="button"
                data-active={semanticCategory === value ? "true" : undefined}
                onClick={() => setSemanticCategory(value)}
              >
                {marker ? <span aria-hidden="true">{marker}</span> : null}{label}
              </button>
            ))}
          </div>
          <div className={styles.assetsSortGroup}>
            <SlidersHorizontal size={13} aria-hidden="true" />
            <button type="button" data-active={sort === "latest" ? "true" : undefined} onClick={() => setSort("latest")}>最新</button>
            <button type="button" data-active={sort === "earliest" ? "true" : undefined} onClick={() => setSort("earliest")}>最早</button>
          </div>
        </div>

        <div className={styles.assetsP0SearchRow}>
          <label className={styles.assetsSearch}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材..." />
          </label>
        </div>
      </header>

      {quota && (
        <section className={styles.assetsQuota} aria-label="存储配额">
          <span><strong>{quota.fileCount}</strong> 个存储文件总数</span>
          <span><strong>{storedFiles.length}</strong> 个存储文件已加载</span>
          <span><strong>{mediaItems.length}</strong> 条生成记录已加载</span>
          <span><strong>{formatBytes(quota.usedBytes)}</strong> 已使用</span>
        </section>
      )}

      {refreshing && <div className={styles.assetsNotice} role="status"><RefreshCw className={styles.spin} size={16} />正在刷新，当前继续显示上次成功加载的资产。</div>}
      {notice && <div className={styles.assetsNotice} role="status"><AlertCircle size={16} />{notice}</div>}
      {error && mediaItems.length + storedFiles.length > 0 && <div className={styles.assetsError} role="alert"><AlertCircle size={16} />{error}</div>}

      {selectionMode && (
        <div className={styles.assetsP0SelectionCount} role="status">
          已选择 {selectedIds.size} 项；勾选只在当前页面会话中保留，不会移动或删除资产。
        </div>
      )}

      {!hydrated ? (
        <section className={styles.assetsLoading} role="status">
          <LoaderCircle className={styles.spin} size={24} />正在恢复账户状态…
        </section>
      ) : !token ? (
        <section className={styles.assetsLoginState}>
          <LogIn size={40} />
          <p>登录后查看你的资产</p>
          <p>
            个人资产包含当前账号已完成的图片、视频、音频，以及你主动上传的素材。
            处理中或失败的任务会保留在相应历史页，不会混入已完成资产。
          </p>
          <p>
            登录后可以按类型、来源和标签筛选素材，并继续预览、下载或创作。公开示例与个人资产会分别展示。
          </p>
          <Link href="/login?redirect=/youcai/assets"><LogIn size={17} />去登录</Link>
        </section>
      ) : loading ? (
        <section className={styles.assetsLoading} role="status">
          <LoaderCircle className={styles.spin} size={24} />正在加载资产…
        </section>
      ) : error && mediaItems.length + storedFiles.length === 0 ? (
        <section className={styles.assetsEmptyState} role="alert">
          <AlertCircle size={40} />
          <p>个人资产暂时无法读取</p>
          <span>{error}。请重新加载，已有资产不会因此被清除。</span>
          <button className={styles.assetsP0ActionButton} type="button" onClick={() => void loadAssets()}>
            <RefreshCw size={16} />重新加载
          </button>
        </section>
      ) : sourceFailures.length > 0 && mediaItems.length + storedFiles.length === 0 ? (
        <section className={styles.assetsEmptyState} role="alert">
          <AlertCircle size={40} />
          <p>部分资产来源暂时无法读取</p>
          <span>{sourceFailures.join("、")}读取失败；其余可读取来源当前没有记录，不能据此判断账户资产为空。</span>
          <button className={styles.assetsP0ActionButton} type="button" onClick={() => void loadAssets()}>
            <RefreshCw size={16} />重新加载
          </button>
        </section>
      ) : unifiedItems.length === 0 ? (
        <section className={styles.assetsEmptyState}>
          <FolderOpen size={40} />
          <p>{mediaItems.length || storedFiles.length ? "没有匹配的资产" : "暂无个人资产"}</p>
          <span>
            {mediaItems.length || storedFiles.length
              ? "请调整搜索、类型或语义分类。"
              : "成功完成的图片、视频任务和你上传的个人文件会出现在这里。"}
          </span>
          {!mediaItems.length && !storedFiles.length ? (
            <span>内容来自当前账号的生成记录和个人文件；失败或仍在处理中的任务不会显示为已完成资产。</span>
          ) : null}
        </section>
      ) : (
        <section className={styles.assetGrid} aria-live="polite">
          {unifiedItems.map((item) => {
            const Icon = categoryIcon(item.category);
            const busy = openingId === item.id;
            const selected = selectedIds.has(item.id);
            return (
              <article className={`${styles.assetCard}${selected ? ` ${styles.assetsP0SelectedCard}` : ""}`} key={item.id}>
                <div className={styles.assetCardHeader}>
                  <span className={styles.assetCardIcon} data-category={item.category}><Icon size={22} /></span>
                  <div>
                    <h2>{item.title}</h2>
                    <p>{item.subtitle}</p>
                  </div>
                  <div className={styles.assetsP0CardState}>
                    <span className={styles.assetStatus} data-status={item.status}>{STATUS_LABEL[item.status] || item.status}</span>
                    {selectionMode && (
                      <label className={styles.assetsP0SelectionControl}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelection(item.id)}
                          aria-label={`选择素材：${item.title}`}
                        />
                        <span>选择</span>
                      </label>
                    )}
                  </div>
                </div>
                <dl className={styles.assetMeta}>
                  <div><dt>来源</dt><dd>{item.source}</dd></div>
                  <div><dt>类型</dt><dd>{item.category}</dd></div>
                  <div>
                    <dt>语义</dt>
                    <dd>{SEMANTIC_CATEGORY_LABEL[item.semantic.category]}</dd>
                  </div>
                  <div><dt>大小</dt><dd>{formatBytes(item.size)}</dd></div>
                  <div><dt>时间</dt><dd>{formatTime(item.createdAt)}</dd></div>
                </dl>
                {item.errorMessage && <p className={styles.assetFailure}>{item.errorMessage}</p>}
                <div className={styles.assetCardActions}>
                  {item.sourcePath && <Link href={item.sourcePath}><ExternalLink size={15} />来源</Link>}
                  {item.previewPath && (
                    <button type="button" disabled={busy} onClick={() => void openMedia(item, false)}>预览</button>
                  )}
                  {item.downloadPath && (
                    <button type="button" disabled={busy} onClick={() => void openMedia(item, true)}><Download size={15} />下载</button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {token && !loading && (mediaPagination.hasMore || storagePagination.hasMore) ? (
        <section className={styles.assetsLoadMore} aria-label="继续加载个人资产">
          {storagePagination.hasMore && source !== "generated" ? (
            <button type="button" disabled={loadingMore !== null} onClick={() => void loadMoreStorage()}>
              {loadingMore === "storage" ? <LoaderCircle className={styles.spin} size={16} /> : <FolderOpen size={16} />}
              {loadingMore === "storage" ? "正在加载" : "加载更多存储文件"}
              <small>已加载 {storedFiles.length} / {storagePagination.total ?? quota?.fileCount ?? "未知"}</small>
            </button>
          ) : null}
          {mediaPagination.hasMore && source !== "stored" ? (
            <button type="button" disabled={loadingMore !== null} onClick={() => void loadMoreMedia()}>
              {loadingMore === "media" ? <LoaderCircle className={styles.spin} size={16} /> : <Sparkles size={16} />}
              {loadingMore === "media" ? "正在加载" : "加载更多生成记录"}
              <small>已加载 {mediaItems.length}{mediaPagination.total != null ? ` / ${mediaPagination.total}` : "+"}</small>
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
