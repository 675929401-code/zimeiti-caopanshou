"use client";
import { resolveGeneratedImageClientDelivery, projectGeneratedImageClientReceipt, type GeneratedImageClientReceipt } from "@/lib/generated-image-client-delivery";
import { ImageDownloadOperations, readImageDownloadBlob, imageDownloadFilename, type ImageDownloadSource } from "@/lib/generated-image-download";


import {
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  FileArchive,
  History,
  ImageIcon,
  Loader2,
  PanelTop,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Video,
  Wallet,
  X,
  ZoomIn,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RechargeDialog } from "@/components/recharge-dialog";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { useImageAccountHistory } from "@/hooks/use-image-account-history";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useApp } from "@/contexts/app-context";
import { copyToClipboard } from "@/lib/utils";
import {
  mergeVideoWorkflowDraft,
  type VideoWorkflowImageMode,
} from "@/lib/video-workflow-draft";
import {
  clearPendingImageWorkbenchPromptTransfer,
  IMAGE_WORKBENCH_TRANSFER_CHANNEL,
  IMAGE_WORKBENCH_TRANSFER_EVENT,
  IMAGE_WORKBENCH_TRANSFER_KEY,
  parseImageWorkbenchPromptTransfer,
  readPendingImageWorkbenchPromptTransfer,
  type ImageWorkbenchPromptTransferItem,
} from "@/lib/image-workbench-transfer";
import {
  createBrowserImageAttemptReferences,
  hasUnresolvedImageAttempt,
  isConfirmedUnsubmittedImageFailure,
  parseBrowserImageAttemptReferences,
  retainUnresolvedImageAttempts,
} from "@/lib/image-workbench-attempt-guard";
import { parseImageWorkbenchRecoveryPayload, type ImageWorkbenchRecoveryPayload } from "@/lib/image-workbench-recovery";
import {
  parseImageUnresolvedRequestReferences,
  type ImageUnresolvedRecoveryState,
} from "@/lib/image-unresolved-requests";
import { fetchWorkbenchImagePng, type ImageDownloadReference } from "@/lib/image-workbench-download";
import { resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import {
  IMAGE_WORKBENCH_PROMPT_DRAFT_KEY,
  parseImageWorkbenchPromptDraft,
  serializeImageWorkbenchPromptDraft,
} from "@/lib/image-workbench-prompt-draft";

type WorkMode = "text-to-image" | "image-to-image";
type JobStatus = "idle" | "queued" | "generating" | "storing" | "recoverable" | "unknown" | "done" | "failed";
type Ratio = "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
type ImageResolution = "1K" | "2K" | "4K";

type CoverModel = {
  id: string;
  name: string;
  model_name: string;
  provider?: string;
  selling_price?: number;
  supports_image_input?: boolean;
  aspect_ratios?: Ratio[];
  resolution_options?: ImageResolution[];
  default_resolution?: ImageResolution;
  resolution_prices?: Record<string, number>;
  max_reference_images: number;
  available: boolean;
  price_ready: boolean;
  availability_message: string;
};

type PublicCoverModelDto = {
  id: string;
  displayName: string;
  variantLabel: string;
  avatarUrl: string;
  capabilities: Record<string, string | number | boolean | string[] | number[] | null>;
  publicPrice: number;
};

type PromptJob = {
  id: string;
  prompt: string;
  status: JobStatus;
  imageUrl?: string;
  deliveryReceipt?: GeneratedImageClientReceipt;
  storageKey?: string;
  assetId?: string;
  historyRecordId?: string;
  generationKey?: string;
  generationTraceId?: string;
  generationModelId?: string;
  generationFingerprint?: string;
  historyBatchId?: string;
  generationRejected?: boolean;
  rejectedAttempts?: Array<{ key: string; traceId: string; modelId: string; message: string }>;
  error?: string;
  taskId?: string;
  operationId?: string;
  billingReferenceId?: string;
  resolution?: ImageResolution;
  cashCharged?: number;
};

type ReferenceAsset = {
  id: string;
  file: File;
  previewUrl: string;
  uploadedUrl?: string;
  status: "local" | "uploading" | "ready" | "failed";
  error?: string;
};

type ImageHistoryItem = {
  id: string;
  prompt: string;
  imageUrl: string;
  storageKey: string;
  assetId: string;
  historyRecordId: string;
  taskId?: string;
  operationId?: string;
  billingReferenceId?: string;
  resolution?: ImageResolution;
  cashCharged?: number;
};

type ImageHistoryRecord = {
  id: string;
  createdAt: number;
  mode: WorkMode;
  aspectRatio: Ratio;
  modelName: string;
  items: ImageHistoryItem[];
  resolution?: ImageResolution;
  totalCharged?: number;
};

type ImageFailureHistoryRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  publicModelId: string;
  modelName: string;
  mode: WorkMode;
  aspectRatio: string;
  resolution: ImageResolution;
  referenceAssetRefs: string[];
  referenceCount: number;
  quotedPriceYuan: number;
  traceId: string;
  error: { code: string; source: "input" | "provider"; upstreamStatus?: number; message: string };
  billing: { state: "charged" | "not_charged" | "exempt" | "unknown"; referenceId: string; chargedAmount?: number };
  canLoadForRetry: boolean;
  retryBlockReason?: string;
};

type ZipEntry = {
  name: string;
  bytes: Uint8Array;
};

type ImagePreviewTarget = {
  url: string;
  title: string;
  prompt?: string;
  assetId?: string;
  historyRecordId?: string;
  deliveryReceipt?:GeneratedImageClientReceipt;
};

const STORAGE_KEY = "image_workbench_prompt_cards_v1";
const MODE_KEY = "image_workbench_mode_v1";
const RATIO_KEY = "image_workbench_ratio_v1";
const MODEL_KEY = "image_workbench_model_v1";
const RESOLUTION_KEY = "image_workbench_resolution_v1";
const HISTORY_KEY = "image_workbench_history_v1";
const VIDEO_PUSH_MODE_KEY = "image_workbench_video_push_mode_v1";
const IMAGE_WORKBENCH_DRAFT_EXPIRY_KEY = "image_workbench_draft_expiry_v1";
const RATIOS: Ratio[] = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const IMAGE_RESOLUTIONS: ImageResolution[] = ["1K", "2K", "4K"];
const REFERENCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function statusLabel(status: JobStatus) {
  switch (status) {
    case "queued":
      return "排队中";
    case "generating":
      return "生成中";
    case "storing":
      return "入库中";
    case "recoverable":
      return "自动保存中";
    case "unknown":
      return "结果待确认";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "待生成";
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function normalizeImageUrl(value?: string) {
  const raw = (value || "").trim();
  if (!raw) return "";
  if (/^(?:data:image\/|blob:|https?:\/\/)/i.test(raw)) return raw;

  const withoutPublic = raw
    .replace(/\\/g, "/")
    .replace(/^\.?\/?public\//i, "")
    .replace(/^\.?\/+/, "");

  return `/${withoutPublic}`;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function writeUint16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function buildZip(entries: ZipEntry[]) {
  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local: number[] = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0x0800);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint32(local, checksum);
    writeUint32(local, entry.bytes.length);
    writeUint32(local, entry.bytes.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);
    const localHeader = new Uint8Array([...local, ...nameBytes]);
    chunks.push(localHeader, entry.bytes);

    const central: number[] = [];
    writeUint32(central, 0x02014b50);
    writeUint16(central, 20);
    writeUint16(central, 20);
    writeUint16(central, 0x0800);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, checksum);
    writeUint32(central, entry.bytes.length);
    writeUint32(central, entry.bytes.length);
    writeUint16(central, nameBytes.length);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, 0);
    writeUint32(central, offset);
    centralDirectory.push(new Uint8Array([...central, ...nameBytes]));
    offset += localHeader.length + entry.bytes.length;
  }

  const centralStart = offset;
  for (const chunk of centralDirectory) {
    chunks.push(chunk);
    offset += chunk.length;
  }

  const end: number[] = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, entries.length);
  writeUint16(end, entries.length);
  writeUint32(end, offset - centralStart);
  writeUint32(end, centralStart);
  writeUint16(end, 0);
  chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: "application/zip" });
}

function isMode(value: unknown): value is WorkMode {
  return value === "text-to-image" || value === "image-to-image";
}

function isRatio(value: unknown): value is Ratio {
  return typeof value === "string" && RATIOS.includes(value as Ratio);
}

function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTIONS.includes(value as ImageResolution);
}

function isVideoWorkflowImageMode(value: unknown): value is VideoWorkflowImageMode {
  return value === "reference" || value === "first-last";
}

function cleanHistory(records: ImageHistoryRecord[]) {
  return records
    .filter((record) => Number.isFinite(record.createdAt) && record.items.length > 0)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function formatHistoryTime(value: number) {
  const date = new Date(value);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return isToday ? `今天 ${time}` : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function modeLabel(mode: WorkMode) {
  return mode === "image-to-image" ? "图生图" : "文生图";
}

function createPromptCards(count = 4): PromptJob[] {
  return Array.from({ length: count }, () => ({ id: createId("job"), prompt: "", status: "idle" as const }));
}

function WorkbenchImageThumb({
  imageUrl,
  label,
  status,
  onOpen,
}: {
  imageUrl?: string;
  label: string;
  status: JobStatus;
  onOpen: () => void;
}) {
  const src = useMemo(() => normalizeImageUrl(imageUrl), [imageUrl]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="group relative aspect-[4/3] w-full overflow-hidden rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] outline-none ring-0 transition focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        aria-label={`放大预览 ${label}`}
      >
        <img
          src={src}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
        <span className="pointer-events-none absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <ZoomIn className="h-4 w-4" />
        </span>
      </button>
    );
  }

  return (
    <div className="aspect-[4/3] rounded-md bg-[var(--muted)] overflow-hidden flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
      {status === "generating" || status === "storing" ? (
        <Loader2 className="w-6 h-6 animate-spin" />
      ) : src ? (
        <>
          <ImageIcon className="w-7 h-7" />
          <span className="px-3 text-center text-[11px]">预览加载失败</span>
        </>
      ) : status === "done" ? (
        <Check className="w-6 h-6" />
      ) : (
        <ImageIcon className="w-7 h-7" />
      )}
    </div>
  );
}

function HistoryImageThumb({
  imageUrl,
  label,
  onOpen,
  onDownload,
}: {
  imageUrl: string;
  label: string;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const src = useMemo(() => normalizeImageUrl(imageUrl), [imageUrl]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className="relative aspect-square overflow-hidden rounded-md bg-[var(--muted)]">
      {src && !failed ? (
        <button type="button" onClick={onOpen} className="h-full w-full" aria-label={`放大预览 ${label}`}>
          <img
            src={src}
            alt={label}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full object-contain"
          />
        </button>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--muted-foreground)]">
          <ImageIcon className="h-5 w-5" />
          <span className="text-[10px]">加载失败</span>
        </div>
      )}
      <button type="button" onClick={onDownload} className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded bg-black/55 text-white hover:bg-black/75" aria-label={`下载 ${label}`}>
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ImagePreviewLightbox({
  target,
  onClose,
  onDownload,
}: {
  target: ImagePreviewTarget | null;
  onClose: () => void;
  onDownload: (target: ImagePreviewTarget) => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const src = normalizeImageUrl(target?.url);

  useEffect(() => {
    if (!target) return;
    setFailed(false);
    setDownloadError("");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, target]);

  if (!target) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-black/85 text-white backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="图片放大预览"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold">{target.title}</h2>
          {target.prompt && <p className="mt-0.5 line-clamp-1 max-w-[min(760px,70vw)] text-xs text-white/65">{target.prompt}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void onDownload(target).catch(error => setDownloadError(error instanceof Error ? error.message : "图片下载失败"))}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/18"
            aria-label="下载图片"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/18"
            aria-label="关闭预览"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>
      {downloadError && <p role="alert" className="px-4 py-2 text-sm text-red-200">{downloadError}</p>}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-5">
        {src && !failed ? (
          <img
            src={src}
            alt={target.title}
            decoding="async"
            onError={() => setFailed(true)}
            className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          />
        ) : (
          <div className="flex min-h-60 w-full max-w-md flex-col items-center justify-center gap-3 rounded-lg border border-white/15 bg-white/8 text-white/75">
            <ImageIcon className="h-10 w-10" />
            <span className="text-sm">图片预览加载失败</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ImageWorkbench() {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return (
    <div className="min-h-screen bg-[var(--background)]">
      <SubPageHeader title="AI生图工作台" subtitle="文生图 / 图生图" icon={<Sparkles className="h-5 w-5" />} />
      <div className="p-8 text-center"><p>请登录后使用生图工作台</p><a href="/" className="mt-4 inline-block text-[var(--primary)] underline">返回主页登录</a></div>
    </div>
  );
  return <UserImageWorkbench key={identity.userId} identity={identity} />;
}

function UserImageWorkbench({ identity }: { identity: WorkbenchIdentity }) {
  const { state } = useApp();
  const historyKey = workbenchUserStorageKey(HISTORY_KEY, identity.userId);
  const jobsStorageKey = `app_state_${workbenchUserStorageKey(STORAGE_KEY, identity.userId)}`;
  const promptDraftStorageKey = workbenchUserStorageKey(IMAGE_WORKBENCH_PROMPT_DRAFT_KEY, identity.userId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const receivedPromptIdsRef = useRef(new Set<string>());
  const receivePromptCardsRef = useRef<(items: ImageWorkbenchPromptTransferItem[]) => void>(() => {});
  const jobsStorageInitializedRef = useRef(false);
  const generationInFlightRef = useRef(false);
  const autoUnknownPollAttemptRef = useRef(0);
  const autoDeliveryAttemptRef = useRef(0);
  const [mode, setMode] = usePersistedState<WorkMode>(workbenchUserStorageKey(MODE_KEY, identity.userId), "text-to-image", isMode);
  const [videoPushMode, setVideoPushMode] = usePersistedState<VideoWorkflowImageMode>(workbenchUserStorageKey(VIDEO_PUSH_MODE_KEY, identity.userId), "reference", isVideoWorkflowImageMode);
  const [aspectRatio, setAspectRatio] = usePersistedState<Ratio>(workbenchUserStorageKey(RATIO_KEY, identity.userId), "4:3", isRatio);
  const [modelId, setModelId] = usePersistedState(workbenchUserStorageKey(MODEL_KEY, identity.userId), "");
  const [resolution, setResolution] = usePersistedState<ImageResolution>(workbenchUserStorageKey(RESOLUTION_KEY, identity.userId), "2K", isImageResolution);
  const [jobs, setJobs] = useState<PromptJob[]>(createPromptCards);
  const [references, setReferences] = useState<ReferenceAsset[]>([]);
  const referenceUrlsRef = useRef<string[]>([]);
  const transientImageReleases = useRef(new Map<string,()=>void>());
  const transientImageBlobs = useRef(new Map<string,{jobId:string;recordId:string;blob:Blob}>());
  const deliveryMounted=useRef(true);
  const downloadOwner = useRef(identity.userId + "\0" + identity.token);
  downloadOwner.current = identity.userId + "\0" + identity.token;
  const downloadOperations = useRef(new ImageDownloadOperations(() => deliveryMounted.current ? downloadOwner.current : null));
  useEffect(()=>()=>downloadOperations.current.cancelAll(),[identity.token]);
  useEffect(()=>{deliveryMounted.current=true;return ()=>{deliveryMounted.current=false;downloadOperations.current.cancelAll();for(const release of transientImageReleases.current.values())release();transientImageReleases.current.clear();transientImageBlobs.current.clear();};},[]);
  useEffect(()=>{for(const [id,release] of transientImageReleases.current){if(!jobs.some(job=>job.id===id && job.imageUrl)){release();transientImageReleases.current.delete(id);}}},[jobs]);
  const [models, setModels] = useState<CoverModel[]>([]);
  const [modelCatalogState, setModelCatalogState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelCatalogReload, setModelCatalogReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [cashBalance, setCashBalance] = useState(0);
  const [cashRechargeOpen, setCashRechargeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(() => new Set());
  const [failureHistory, setFailureHistory] = useState<ImageFailureHistoryRecord[]>([]);
  const [failureHistoryLoading, setFailureHistoryLoading] = useState(false);
  const [failureHistoryError, setFailureHistoryError] = useState("");
  const [failureHistoryNextPage, setFailureHistoryNextPage] = useState<number | null>(null);
  const accountHistory = useImageAccountHistory<ImageHistoryRecord>(identity.token, historyKey);
  const { history, setHistory } = accountHistory;
  const [previewTarget, setPreviewTarget] = useState<ImagePreviewTarget | null>(null);

  const token = identity.token;
  const completedJobs = jobs.filter((job) => (
    job.status === "done" && job.imageUrl && (job.deliveryReceipt || (job.assetId && job.storageKey))
  ));
  const activeModel = useMemo(() => models.find((model) => model.id === modelId), [modelId, models]);
  const modelSupportsMode = Boolean(modelCatalogState === "ready" && activeModel?.available && activeModel.price_ready
    && (mode === "text-to-image" || activeModel.supports_image_input !== false));
  const supportedRatios = useMemo(() => {
    const configured = activeModel?.aspect_ratios?.filter(isRatio) || [];
    return configured.length ? RATIOS.filter((ratio) => configured.includes(ratio)) : RATIOS;
  }, [activeModel]);
  const supportedResolutions = useMemo(() => {
    const configured = activeModel?.resolution_options?.filter(isImageResolution) || [];
    return configured.length
      ? IMAGE_RESOLUTIONS.filter((item) => configured.includes(item))
      : IMAGE_RESOLUTIONS;
  }, [activeModel]);
  const selectedResolution = supportedResolutions.includes(resolution)
    ? resolution
    : (activeModel?.default_resolution || supportedResolutions[0] || "2K");
  const selectedResolutionPrice = activeModel?.price_ready
    ? activeModel.resolution_prices?.[selectedResolution] ?? Number(activeModel.selling_price || 0)
    : null;
  const activeReferenceLimit = activeModel?.supports_image_input === false
    ? 0
    : Math.max(0, Math.floor(Number(activeModel?.max_reference_images || 0)));
  const referenceLimitExceeded = mode === "image-to-image" && references.length > activeReferenceLimit;
  const imageToImageModels = models.filter((model) => model.supports_image_input !== false);
  const visibleModels = mode === "image-to-image" ? imageToImageModels : models;
  const selectedModelRemoved = (modelCatalogState === "ready" || modelCatalogState === "empty")
    && Boolean(modelId) && !models.some(model => model.id === modelId);
  const modelCatalogMessage = modelCatalogState === "loading" ? "正在读取生图模型目录，请稍候…"
    : modelCatalogState === "error" ? modelCatalogError
      : selectedModelRemoved ? "原模型已从当前目录移除，请重新选择；已填写的提示词保留。"
        : modelCatalogState === "empty" ? "当前生图模型目录为空，请联系管理员配置或重新读取。"
          : activeModel && !activeModel.available ? activeModel.availability_message || "当前所选模型未开放，请选择其他模型。" : "";
  const recoverableJobCount = jobs.filter((job) => job.status === "recoverable").length;
  const newGenerationJobCount = jobs.filter((job) => (
    job.prompt.trim() && ["idle", "failed"].includes(job.status)
  )).length;
  const actionableJobCount = recoverableJobCount + newGenerationJobCount;
  const unknownJobCount = jobs.filter((job) => job.status === "unknown").length;
  const estimatedCharge = Math.max(0, selectedResolutionPrice ?? 0) * newGenerationJobCount;
  const canGenerate = newGenerationJobCount > 0 && !busy
    && modelSupportsMode
    && (mode === "text-to-image" || (references.length > 0 && !referenceLimitExceeded));

  useEffect(() => {
    let active = true;
    const abortController = new AbortController();
    const retiredKeys = [
      STORAGE_KEY,
      workbenchUserStorageKey(STORAGE_KEY, identity.userId),
      `app_state_${STORAGE_KEY}`,
      jobsStorageKey,
      HISTORY_KEY,
      historyKey,
      workbenchUserStorageKey(IMAGE_WORKBENCH_DRAFT_EXPIRY_KEY, identity.userId),
      IMAGE_WORKBENCH_DRAFT_EXPIRY_KEY,
    ];
    let restored: PromptJob[] = [];
    let promptDraft = null as ReturnType<typeof parseImageWorkbenchPromptDraft>;
    try {
      promptDraft = parseImageWorkbenchPromptDraft(localStorage.getItem(promptDraftStorageKey));
    } catch { /* Browser storage may be unavailable. */ }
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(jobsStorageKey) || "[]");
      restored = parseBrowserImageAttemptReferences(parsed).map((attempt) => {
        const recoveryPayload = parseImageWorkbenchRecoveryPayload(attempt);
        return {
          id: attempt.id,
          prompt: recoveryPayload?.prompt || "",
          status: "unknown" as const,
          generationKey: attempt.generationKey,
          generationTraceId: attempt.generationTraceId,
          generationModelId: attempt.generationModelId,
          generationFingerprint: attempt.generationFingerprint,
          historyBatchId: attempt.historyBatchId,
          error: recoveryPayload
            ? "上次提交的任务已重新挂接，系统正在自动核验并完成展示。"
            : "上次已提交任务仅保留安全追踪编号；请刷新状态，终态结果从账号历史读取。",
        };
      });
    } catch { /* Invalid retired attempt pointers are discarded. */ }
    for (const key of retiredKeys) {
      try { sessionStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
      try { localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
    }
    const occupiedIds = new Set(restored.map((job) => job.id));
    const restoredDraftJobs = (promptDraft?.jobs || [])
      .filter((job) => !occupiedIds.has(job.id))
      .map((job) => ({ id: job.id, prompt: job.prompt, status: "idle" as const }));
    let completedReceipts: PromptJob[] = [];
    try {const saved=JSON.parse(sessionStorage.getItem(jobsStorageKey+":receipts")||"[]");
      if(Array.isArray(saved))completedReceipts=saved.flatMap((item)=>{const receipt=projectGeneratedImageClientReceipt(item.receipt);return receipt && typeof item.id==="string" ? [{id:item.id,prompt:"",status:"done" as const,imageUrl:receipt.deliveryMode==="provider_url"?`/api/media-history/content?recordId=${receipt.recordId}`:undefined,deliveryReceipt:receipt,cashCharged:receipt.cashCharged,billingReferenceId:receipt.billingReferenceId,error:receipt.deliveryMode==="inline_ephemeral"?"任务与费用收据已保留；临时图片刷新后无法恢复":undefined}] : [];});
    } catch { /* Ignore invalid receipt projections. */ }
    const initialJobs = [...restored.filter(j=>!completedReceipts.some(r=>r.id===j.id)), ...restoredDraftJobs.filter(j=>!completedReceipts.some(r=>r.id===j.id)), ...completedReceipts];
    if (initialJobs.length < 4) initialJobs.push(...createPromptCards(4 - initialJobs.length));
    setJobs(initialJobs);
    jobsStorageInitializedRef.current = true;
    if (restored.length) setNotice("已重新挂接本浏览器保留的生图请求编号；系统不会自动重复提交。");
    else if (restoredDraftJobs.length) {
      setNotice(promptDraft?.referenceCount
        ? `已载入 ${restoredDraftJobs.length} 条未提交提示词；原草稿有 ${promptDraft.referenceCount} 张参考图，请重新上传后再提交。`
        : `已载入 ${restoredDraftJobs.length} 条未提交提示词。`);
    }

    const unresolvedMessage = (state: ImageUnresolvedRecoveryState) => state === "processing"
      ? "账号中这次生图仍在处理或等待确认；请刷新状态，系统不会重复提交。"
      : state === "provider_completed_pending_delivery"
        ? "账号中这次生图已有结果但交付未完成；请刷新状态，系统不会重新生图。"
        : "账号中这次生图结果待确认；原请求号已保留，请勿重复提交。";

    async function loadAccountUnresolvedImageAttempts() {
      try {
        const response = await fetch("/api/image-workbench/unresolved", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: abortController.signal,
        });
        const data = await response.json().catch(() => ({})) as {
          records?: unknown;
          truncated?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || "未决生图任务暂时无法同步");
        const accountReferences = parseImageUnresolvedRequestReferences(data.records);
        if (!active) return;
        setJobs((current) => {
          const next = [...current];
          const attached = new Set(next.flatMap((job) => job.generationKey && job.generationTraceId
            ? [`${job.generationKey}\u0000${job.generationTraceId}`]
            : []));
          for (const reference of accountReferences) {
            const referenceIdentity = `${reference.generationKey}\u0000${reference.generationTraceId}`;
            if (attached.has(referenceIdentity)) continue;
            attached.add(referenceIdentity);
            next.push({
              id: reference.generationKey,
              prompt: "",
              status: "unknown",
              generationKey: reference.generationKey,
              generationTraceId: reference.generationTraceId,
              error: unresolvedMessage(reference.state),
            });
          }
          const meaningful = next.filter((job) => job.prompt.trim() || hasUnresolvedImageAttempt(job));
          return meaningful.length ? meaningful : createPromptCards();
        });
        if (accountReferences.length) {
          setNotice(`已从当前账号重新挂接 ${accountReferences.length} 个未决生图请求；仅保留追踪编号，不加载旧提示词，也不会自动提交${data.truncated ? "；较早记录仍需稍后查询" : ""}。`);
        }
      } catch (error) {
        if (!active || abortController.signal.aborted) return;
        setNotice(`${error instanceof Error ? error.message : "未决生图任务暂时无法同步"}；请勿重复提交。`);
      }
    }
    void loadAccountUnresolvedImageAttempts();
    return () => {
      active = false;
      abortController.abort();
    };
  }, [historyKey, identity.userId, jobsStorageKey, promptDraftStorageKey, token]);

  useEffect(() => {
    if (!jobsStorageInitializedRef.current) return;
    const unresolvedReferences = createBrowserImageAttemptReferences(jobs);
    try {sessionStorage.setItem(jobsStorageKey+":receipts",JSON.stringify(jobs.filter(j=>j.deliveryReceipt).map(j=>({id:j.id,receipt:projectGeneratedImageClientReceipt(j.deliveryReceipt)}))));} catch { /* Current receipt remains in RAM. */ }
    try {
      if (unresolvedReferences.length) sessionStorage.setItem(jobsStorageKey, JSON.stringify(unresolvedReferences));
      else sessionStorage.removeItem(jobsStorageKey);
    } catch { /* Current page remains usable when browser storage is unavailable. */ }
  }, [jobs, jobsStorageKey]);

  useEffect(() => {
    if (!jobsStorageInitializedRef.current) return;
    const timer = window.setTimeout(() => {
      const serialized = serializeImageWorkbenchPromptDraft(
        jobs
          .filter((job) => job.status === "idle" && !hasUnresolvedImageAttempt(job))
          .map(({ id, prompt }) => ({ id, prompt })),
        references.length,
      );
      try {
        if (serialized) localStorage.setItem(promptDraftStorageKey, serialized);
        else localStorage.removeItem(promptDraftStorageKey);
      } catch { /* Current page remains usable when browser storage is unavailable. */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [jobs, promptDraftStorageKey, references.length]);

  useEffect(() => {
    if (!supportedRatios.includes(aspectRatio)) setAspectRatio(supportedRatios[0] || "16:9");
  }, [aspectRatio, setAspectRatio, supportedRatios]);

  useEffect(() => {
    if (resolution !== selectedResolution) setResolution(selectedResolution);
  }, [resolution, selectedResolution, setResolution]);

  const receivePromptCards = useCallback((items: ImageWorkbenchPromptTransferItem[]) => {
    const incoming = items.filter((item) => item.prompt.trim() && !receivedPromptIdsRef.current.has(item.id));
    if (incoming.length === 0) return;
    incoming.forEach((item) => receivedPromptIdsRef.current.add(item.id));

    setJobs((current) => {
      const next = [...current];
      let emptyIndex = next.findIndex((job) => !job.prompt.trim());
      for (const item of incoming) {
        const nextJob: PromptJob = { id: createId("job"), prompt: item.prompt, status: "idle" };
        if (emptyIndex >= 0) {
          next[emptyIndex] = nextJob;
          emptyIndex = next.findIndex((job, index) => index > emptyIndex && !job.prompt.trim());
        } else {
          next.push(nextJob);
        }
      }
      return next;
    });
    setNotice(`已接收 ${incoming.length} 条图片提示词，按点击顺序填入生图卡片。`);
  }, [setJobs]);

  useEffect(() => {
    receivePromptCardsRef.current = receivePromptCards;
  }, [receivePromptCards]);

  useEffect(() => {
    const receiveAndConsume = (items: ImageWorkbenchPromptTransferItem[]) => {
      receivePromptCardsRef.current(items);
      clearPendingImageWorkbenchPromptTransfer();
    };
    const receivePayload = (payload: { ownerUserId?: string; items?: ImageWorkbenchPromptTransferItem[] } | null) => {
      if (payload?.ownerUserId === identity.userId && payload.items?.length) receiveAndConsume(payload.items);
    };
    const pending = readPendingImageWorkbenchPromptTransfer();
    receivePayload(pending);

    const handleTransfer = (event: Event) => {
      const payload = (event as CustomEvent<{ ownerUserId?: string; items?: ImageWorkbenchPromptTransferItem[] }>).detail;
      receivePayload(payload);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_KEY, identity.userId) || !event.newValue) return;
      receivePayload(parseImageWorkbenchPromptTransfer(event.newValue));
    };
    window.addEventListener(IMAGE_WORKBENCH_TRANSFER_EVENT, handleTransfer);
    window.addEventListener("storage", handleStorage);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(IMAGE_WORKBENCH_TRANSFER_CHANNEL);
      channel.onmessage = (event) => {
        receivePayload(parseImageWorkbenchPromptTransfer(JSON.stringify(event.data)));
      };
    } catch {
      channel = null;
    }
    return () => {
      window.removeEventListener(IMAGE_WORKBENCH_TRANSFER_EVENT, handleTransfer);
      window.removeEventListener("storage", handleStorage);
      channel?.close();
    };
  }, [identity.userId]);

  const resetDraftJobs = useCallback(() => {
    setJobs((current) => {
      const pending = retainUnresolvedImageAttempts(current);
      return pending.length ? pending : createPromptCards();
    });
    setNotice("草稿已清理，结果待确认的任务已保留。");
  }, [setJobs]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setModelCatalogState("loading");
    setModelCatalogError("");
    async function loadModels() {
      try {
        const response = await fetch("/api/cover-models?surface=image-workbench", {
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("MODEL_CATALOG_UNAVAILABLE");
        const data = await response.json() as { models?: PublicCoverModelDto[] };
        if (!active) return;
        const nextModels = (data.models || []).map((model) => ({
          id: model.id,
          name: `${model.displayName}${model.variantLabel ? ` ${model.variantLabel}` : ""}`,
          model_name: model.id,
          selling_price: model.publicPrice,
          supports_image_input: model.capabilities.supportsImageInput !== false,
          aspect_ratios: Array.isArray(model.capabilities.aspectRatios)
            ? model.capabilities.aspectRatios.filter(isRatio)
            : undefined,
          resolution_options: Array.isArray(model.capabilities.resolutionOptions)
            ? model.capabilities.resolutionOptions.filter(isImageResolution)
            : undefined,
          default_resolution: isImageResolution(model.capabilities.defaultResolution)
            ? model.capabilities.defaultResolution : undefined,
          resolution_prices: parsePublicImageResolutionPrices(model.capabilities.resolutionPrices),
          available: model.capabilities.available !== false && model.capabilities.priceReady !== false,
          price_ready: model.capabilities.priceReady !== false,
          availability_message: typeof model.capabilities.availabilityMessage === "string"
            ? model.capabilities.availabilityMessage
            : "",
          max_reference_images: typeof model.capabilities.maxReferenceImages === "number" && Number.isFinite(model.capabilities.maxReferenceImages)
            ? Math.min(9, Math.max(0, Math.floor(model.capabilities.maxReferenceImages)))
            : model.capabilities.supportsImageInput === false ? 0 : 1,
        }));
        setModels(nextModels);
        setModelId((currentModelId) => {
          // A directory reread never silently changes a user's selected ID.
          // Missing selections stay explicit until the user picks a replacement.
          if (currentModelId) return currentModelId;
          return nextModels.find((model) => model.available)?.id || nextModels[0]?.id || "";
        });
        setModelCatalogState(nextModels.length ? "ready" : "empty");
      } catch {
        if (!active) return;
        setModelCatalogState("error");
        setModelCatalogError(controller.signal.aborted
          ? "模型目录读取超时，尚未提交生图；请重新读取。"
          : "模型目录暂时无法读取，尚未提交生图；请重新读取。");
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void loadModels();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [setModelId, token, modelCatalogReload]);

  useEffect(() => {
    async function loadBalance() {
      if (!token) return;
      try {
        const response = await fetch("/api/cash/balance", { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) return;
        const data = await response.json() as { balance?: number };
        setCashBalance(Number(data.balance || 0));
      } catch {}
    }
    void loadBalance();
  }, [token]);

  useEffect(() => {
    referenceUrlsRef.current = references.map(asset => asset.previewUrl);
  }, [references]);
  useEffect(() => () => referenceUrlsRef.current.forEach(url => URL.revokeObjectURL(url)), []);

  const addPromptCard = useCallback(() => {
    setJobs((current) => [...current, ...createPromptCards(1)]);
  }, [setJobs]);

  const updateJobPrompt = useCallback((id: string, prompt: string) => {
    setJobs((current) => current.map((job) => (job.id === id && !hasUnresolvedImageAttempt(job) ? {
      ...job,
      prompt,
      status: "idle",
      imageUrl: undefined,
      storageKey: undefined,
      assetId: undefined,
      historyRecordId: undefined,
      generationKey: undefined,
      generationTraceId: undefined,
      generationModelId: undefined,
      generationFingerprint: undefined,
      error: undefined,
      taskId: undefined,
      operationId: undefined,
      billingReferenceId: undefined,
      cashCharged: undefined,
    } : job)));
  }, [setJobs]);

  const removeJob = useCallback((id: string) => {
    transientImageReleases.current.get(id)?.();transientImageReleases.current.delete(id);
    setJobs((current) => current.filter((job) => job.id !== id || hasUnresolvedImageAttempt(job)));
  }, [setJobs]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    const unsupported = selectedFiles.filter((file) => !REFERENCE_IMAGE_TYPES.has(file.type));
    const oversized = selectedFiles.filter((file) => REFERENCE_IMAGE_TYPES.has(file.type) && file.size > MAX_REFERENCE_IMAGE_BYTES);
    const accepted = selectedFiles.filter((file) => REFERENCE_IMAGE_TYPES.has(file.type) && file.size > 0 && file.size <= MAX_REFERENCE_IMAGE_BYTES);
    const nextAssets = accepted
      .map((file) => ({
        id: createId("ref"),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "local" as const,
      }));
    if (!nextAssets.length) {
      setNotice([
        unsupported.length ? `${unsupported.length} 个文件不是 PNG、JPEG 或 WebP` : "",
        oversized.length ? `${oversized.length} 张图片超过单张 5MB` : "",
        selectedFiles.some((file) => file.size <= 0) ? "存在空文件" : "",
      ].filter(Boolean).join("；") || "没有可用的参考图。");
      return;
    }
    setReferences((current) => [...current, ...nextAssets]);
    const total = references.length + nextAssets.length;
    setNotice([
      `已添加 ${nextAssets.length} 张参考图`,
      unsupported.length ? `${unsupported.length} 个不支持的格式未添加` : "",
      oversized.length ? `${oversized.length} 张超过 5MB 的图片未添加` : "",
      activeReferenceLimit > 0 && total > activeReferenceLimit
        ? `当前模型最多支持 ${activeReferenceLimit} 张，现有 ${total} 张；请手动移除多余图片后再生成`
        : "",
    ].filter(Boolean).join("；") + "。");
  }, [activeReferenceLimit, references.length]);

  const removeReference = useCallback((id: string) => {
    setReferences((current) => {
      const removed = current.find((asset) => asset.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((asset) => asset.id !== id);
    });
  }, []);

  const uploadReference = useCallback(async (asset: ReferenceAsset) => {
    if (asset.uploadedUrl) return asset.uploadedUrl;
    if (!token) throw new Error("请先登录后再上传参考图");
    if (!REFERENCE_IMAGE_TYPES.has(asset.file.type) || asset.file.size <= 0 || asset.file.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error("参考图只支持 PNG、JPEG、WebP，且单张不能超过 5MB");
    }
    setReferences((current) => current.map((item) => item.id === asset.id ? { ...item, status: "uploading", error: undefined } : item));
    const formData = new FormData();
    formData.set("file", asset.file);
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !data.url) {
      const error = data.error || "参考图上传失败";
      setReferences((current) => current.map((item) => item.id === asset.id ? { ...item, status: "failed", error } : item));
      throw new Error(error);
    }
    setReferences((current) => current.map((item) => item.id === asset.id ? { ...item, uploadedUrl: data.url, status: "ready" } : item));
    return data.url;
  }, [token]);

  const persistGeneratedImage = useCallback(async (
    url: string,
    index: number,
    clientTraceId: string,
    storageKey?: string,
    assetId?: string,
  ) => {
    if (!token) throw new Error("请先登录后再入库图片");
    const response = await fetch("/api/image-workbench/persist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url,
        index,
        clientTraceId,
        ...(storageKey ? { storageKey } : {}),
        ...(assetId ? { assetId } : {}),
      }),
    });
    const data = await response.json().catch(() => ({})) as {
      url?: string;
      key?: string;
      assetId?: string;
      historyRecordId?: string;
      status?: string;
      persisted?: boolean;
      historyRecorded?: boolean;
      error?: string;
    };
    if (!response.ok || !data.url || !data.key || !data.assetId
      || !data.historyRecordId || data.historyRecorded !== true
      || data.status !== "completed" || data.persisted !== true) {
      throw new Error(data.error || "图片未完成资产入库，暂不可交付");
    }
    return {
      url: data.url,
      key: data.key,
      assetId: data.assetId,
      historyRecordId: data.historyRecordId,
    };
  }, [token]);

  const persistAccountHistoryRecord = useCallback(async (record: ImageHistoryRecord) => {
    if (!token) throw new Error("请先登录后再保存图片历史");
    const response = await fetch("/api/image-workbench/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ records: [{
        id: record.id,
        mode: record.mode,
        aspectRatio: record.aspectRatio,
        modelName: record.modelName,
        resolution: record.resolution,
        items: record.items.map((item) => ({
          assetId: item.assetId,
          historyRecordId: item.historyRecordId,
          prompt: item.prompt,
        })),
      }] }),
    });
    const data = await response.json().catch(() => ({})) as {
      saved?: Array<{ id?: string; deleted?: boolean }>;
      error?: string;
    };
    const receipt = data.saved?.find((item) => item.id === record.id);
    if (!response.ok || !receipt || receipt.deleted === true) {
      throw new Error(data.error || "图片已保存，账号历史正在自动同步");
    }
  }, [token]);

  const inspectImageAttempt = useCallback(async (job: PromptJob) => {
    if (!token || !job.generationKey || !job.generationTraceId) return null;
    const query = new URLSearchParams({
      clientIdempotencyKey: job.generationKey,
      clientTraceId: job.generationTraceId,
    });
    const response = await fetch(`/api/image/status?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as {
      state?: "not_found" | "processing" | "completed" | "expired" | "provider_completed_pending_delivery" | "unknown" | "rejected";
      canRecover?: boolean;
      canResubmit?: boolean;
      sameKeyCanResubmit?: boolean;
      message?: string;
      error?: string;
      recordId?: string; deliveryMode?: "provider_url"|"inline_ephemeral"; cashCharged?:number; billingReferenceId?:string;
      resumeInput?: ImageWorkbenchRecoveryPayload;
    };
    if (!response.ok) throw new Error(data.error || "生图状态暂时无法确认");
    return data;
  }, [token]);

  const refreshUnknownImageJobs = useCallback(async () => {
    const candidates = jobs.filter((job) => (
      job.status === "unknown"
      && job.generationKey
      && job.generationTraceId
    ));
    if (!candidates.length) {
      setNotice("当前没有需要查询的生成任务。");
      return;
    }
    setStatusRefreshing(true);
    try {
      const checked = await Promise.all(candidates.map(async (job) => {
        try {
          return { id: job.id, result: await inspectImageAttempt(job), error: undefined as string | undefined };
        } catch (error) {
          return {
            id: job.id,
            result: null,
            error: error instanceof Error ? error.message : "状态查询失败",
          };
        }
      }));
      const byId = new Map(checked.map((item) => [item.id, item]));
      setJobs((current) => current.map((job) => {
        const checkedJob = byId.get(job.id);
        if (!checkedJob) return job;
        if (["completed","expired"].includes(checkedJob.result?.state||"") && ["inline_ephemeral","provider_url"].includes(checkedJob.result?.deliveryMode||"")) {
          const receipt=projectGeneratedImageClientReceipt(checkedJob.result);
          if(!receipt)return {...job,status:"unknown",error:"原完成收据缺少身份或费用信息，请保留原请求号核查"};
          const available=receipt.deliveryMode==="provider_url" && checkedJob.result?.state==="completed";
          return {...job,status:"done",imageUrl:available?`/api/media-history/content?recordId=${receipt.recordId}`:undefined,deliveryReceipt:receipt,cashCharged:receipt.cashCharged,billingReferenceId:receipt.billingReferenceId,error:available?undefined:"任务与费用收据已保留；当前图片已不可恢复"};
        }
        if (checkedJob.result?.state === "rejected" && checkedJob.result.canResubmit === true && checkedJob.result.sameKeyCanResubmit === false) {
          const message = checkedJob.result.message || "本次请求未被受理，请调整后重新生成。";
          return {
            ...job, status: "failed", generationRejected: true, error: message,
            rejectedAttempts: job.rejectedAttempts?.some((attempt) => attempt.key === job.generationKey)
              ? job.rejectedAttempts
              : [...(job.rejectedAttempts || []), { key: job.generationKey!, traceId: job.generationTraceId!, modelId: job.generationModelId || "", message }],
          };
        }
        if (checkedJob.result?.canRecover === true) {
          const rawResume = checkedJob.result.resumeInput;
          const resumeFingerprint = rawResume ? JSON.stringify({
            prompt: rawResume.prompt.trim(),
            modelId: rawResume.modelId,
            aspectRatio: rawResume.aspectRatio,
            resolution: rawResume.resolution,
            referenceImageUrls: rawResume.referenceImageUrls,
            ...(rawResume.resumeDeliveryOnly ? { resumeDeliveryOnly: true } : {}),
          }) : undefined;
          const resumePayload = resumeFingerprint ? parseImageWorkbenchRecoveryPayload({
            generationKey: job.generationKey,
            generationTraceId: job.generationTraceId,
            generationModelId: rawResume?.modelId,
            generationFingerprint: resumeFingerprint,
          }) : null;
          return {
            ...job,
            ...(resumePayload ? {
              prompt: resumePayload.prompt,
              generationModelId: resumePayload.modelId,
              generationFingerprint: resumeFingerprint,
              historyBatchId: job.historyBatchId || `history-${job.generationTraceId}`,
            } : {}),
            status: "recoverable",
            error: checkedJob.result.message || "图片已生成，系统正在自动保存。",
          };
        }
        return {
          ...job,
          status: "unknown",
          error: checkedJob.result?.message || checkedJob.error || "结果待确认。",
        };
      }));
      const recoverableCount = checked.filter((item) => item.result?.canRecover === true).length;
      const rejectedCount = checked.filter((item) => item.result?.state === "rejected" && item.result.canResubmit === true && item.result.sameKeyCanResubmit === false).length;
      const confirmedReceipts=new Map(checked.flatMap(item=>{const receipt=projectGeneratedImageClientReceipt(item.result);return receipt && ["completed","expired"].includes(item.result?.state||"")?[[receipt.recordId,receipt.cashCharged] as const]:[];}));
      setNotice(confirmedReceipts.size || recoverableCount || rejectedCount
        ? [confirmedReceipts.size ? `${confirmedReceipts.size} 个生成任务已完成，已确认费用 ¥${[...confirmedReceipts.values()].reduce((sum,value)=>sum+value,0).toFixed(2)}；当前不可用图片仅保留收据` : "",recoverableCount ? `${recoverableCount} 个结果正在自动保存` : "", rejectedCount ? `${rejectedCount} 个请求已确认未被受理，可调整后重新生成` : ""].filter(Boolean).join("；") + "。"
        : "暂未取得生成结果，请稍后刷新状态。");
    } finally {
      setStatusRefreshing(false);
    }
  }, [inspectImageAttempt, jobs, setJobs]);

  const generateAll = useCallback(async (options: { recoverableOnly?: boolean } = {}) => {
    const recoverableOnly = options.recoverableOnly === true;
    const targetJobCount = recoverableOnly ? recoverableJobCount : actionableJobCount;
    if (generationInFlightRef.current) return;
    if (!token) {
      if (!recoverableOnly) setNotice("请先登录后再生成。");
      return;
    }
    if (!targetJobCount) {
      if (recoverableOnly) return;
      if (unknownJobCount) {
        setNotice("结果正在后台核验，请稍后查看。");
        return;
      }
      setNotice("请先填写至少一张生图卡片。");
      return;
    }
    const recoveringJobs = jobs.some((job) => job.status === "recoverable");
    if (!recoveringJobs && mode === "image-to-image" && !references.length) {
      setNotice("图生图模式需要先上传参考图。");
      return;
    }
    if (!recoveringJobs && referenceLimitExceeded) {
      setNotice(`当前模型最多支持 ${activeReferenceLimit} 张参考图，现有 ${references.length} 张；请手动移除多余图片后再生成。`);
      return;
    }
    if (!recoveringJobs && (!activeModel?.available || !activeModel.price_ready)) {
      setNotice(activeModel?.availability_message || "当前模型价格或发布配置尚未完成，请选择其他模型。");
      return;
    }
    if (!recoveringJobs && !modelSupportsMode) {
      setNotice(mode === "image-to-image" ? "请选择支持参考图的模型。" : "请选择可用模型。");
      return;
    }

    generationInFlightRef.current = true;
    setBusy(true);
    const generationJobs = jobs
      .map((job, originalIndex) => ({ job, originalIndex }))
      .filter(({ job }) => job.status === "recoverable" || (!recoverableOnly && (
        activeModel && modelSupportsMode && (mode !== "image-to-image" || (references.length > 0 && !referenceLimitExceeded))
        && job.prompt.trim() && ["idle", "failed"].includes(job.status)
      )));
    const generationJobIds = new Set(generationJobs.map(({ job }) => job.id));
    setNotice(recoverableOnly
      ? "图片已生成，正在自动完成保存。"
      : "开始处理生图卡片；状态未确认的请求不会被重复提交。");
    setJobs((current) => current.map((job) => generationJobIds.has(job.id)
      ? { ...job, status: "queued", error: undefined }
      : job));
    const committedHistory: ImageHistoryRecord[] = [];
    const completedReceipts = new Map<string,number>();
    let unknownCount = 0;
    let recoverableCount = 0;
    try {
      let referenceImageUrls: string[];
      try {
        referenceImageUrls = mode === "image-to-image" && generationJobs.some(({ job }) => job.status !== "recoverable")
          ? await Promise.all(references.map((asset) => uploadReference(asset)))
          : [];
      } catch (uploadError) {
        // This phase precedes the generation loop: no new image request has
        // been submitted. Restore each card, including an existing recovery key.
        const originals = new Map(generationJobs.map(({ job }) => [job.id, job]));
        const message = uploadError instanceof Error ? uploadError.message : "参考图上传失败";
        setJobs((current) => current.map((item) => {
          const original = originals.get(item.id);
          return original && item.status === "queued" ? { ...original, error: message } : item;
        }));
        setNotice(`参考图上传失败，本批尚未提交生图任务：${message}`);
        return;
      }

      for (let index = 0; index < generationJobs.length; index += 1) {
        const { job, originalIndex } = generationJobs[index];
        const recoveryPayload = job.status === "recoverable" ? parseImageWorkbenchRecoveryPayload(job) : null;
        if (job.status === "recoverable") {
          let confirmed = false;
          if (recoveryPayload) {
            try { confirmed = (await inspectImageAttempt(job))?.canRecover === true; } catch { /* Preserve the original attempt. */ }
          }
          if (!confirmed) {
            unknownCount += 1;
            setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: "unknown", error: "原请求参数或继续处理状态未能确认，已保留原任务，勿重复提交" } : item));
            continue;
          }
        }
        const requestPayload = recoveryPayload || {
          prompt: job.prompt, modelId: activeModel!.id, aspectRatio,
          resolution: selectedResolution, referenceImageUrls,
        };
        const generationFingerprint = recoveryPayload ? job.generationFingerprint! : JSON.stringify({
          ...requestPayload, prompt: requestPayload.prompt.trim(),
        });
        const canReuseAttempt = Boolean(
          job.generationKey
          && !job.generationRejected
          && job.generationTraceId
          && job.generationModelId === requestPayload.modelId
          && job.generationFingerprint === generationFingerprint,
        );
        if (job.status === "recoverable" && !canReuseAttempt) {
          unknownCount += 1;
          setJobs((current) => current.map((item) => item.id === job.id ? {
            ...item,
            status: "unknown",
            error: "原请求参数已变化，系统已保留原任务并停止重复处理。",
          } : item));
          continue;
        }
        const generationKey = canReuseAttempt
          ? job.generationKey!
          : createId("h3img");
        const generationTraceId = canReuseAttempt
          ? job.generationTraceId!
          : createId("imgtrace");
        // The history RPC is immutable by (owner, id). Giving every card in a
        // multi-image request the same batch id makes later cards acknowledge
        // the first row without ever becoming discoverable. Derive one stable
        // row id per exact generation request instead; a delivery retry keeps
        // the same trace id and therefore remains idempotent.
        const historyBatchId = `history-${generationTraceId}`;
        setJobs((current) => current.map((item) => item.id === job.id ? {
          ...item,
          status: "generating",
          generationRejected: false,
          imageUrl: undefined,
          storageKey: undefined,
          assetId: undefined,
          historyRecordId: undefined,
          generationKey,
          generationTraceId,
          generationModelId: requestPayload.modelId,
          generationFingerprint,
          historyBatchId,
          taskId: undefined,
          operationId: undefined,
          billingReferenceId: undefined,
        } : item));
        try {
          const response = await fetch("/api/image/generate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              prompt: requestPayload.prompt,
              mode: "local",
              modelId: requestPayload.modelId,
              style: "",
              aspectRatio: requestPayload.aspectRatio,
              resolution: requestPayload.resolution,
              coverText: "",
              historySurface: "image-workbench",
              ...(requestPayload.resumeDeliveryOnly ? { resumeDeliveryOnly: true } : {}),
              clientIdempotencyKey: generationKey,
              clientTraceId: generationTraceId,
              ...(requestPayload.referenceImageUrls.length ? { referenceImageUrls: requestPayload.referenceImageUrls } : {}),
            }),
          });
          const data = await response.json().catch(() => ({})) as {
            recordId?:string; deliveryMode?:"provider_url"|"inline_ephemeral";
            images?: Array<{ url?: string; storageKey?: string; assetId?: string; recordId?:string; deliveryMode?:"provider_url"|"inline_ephemeral" }>;
            cashRemaining?: number | null;
            cashCharged?: number;
            resolution?: string;
            taskId?: string;
            traceId?: string;
            operationId?: string;
            billingReferenceId?: string;
            code?: string;
            error?: string;
            upstreamCalled?: boolean;
            billed?: boolean;
            state?: string;
            canResubmit?: boolean;
            sameKeyCanResubmit?: boolean;
          };
          const clientReceipt=projectGeneratedImageClientReceipt(data);
          if(response.ok && clientReceipt) {
            completedReceipts.set(clientReceipt.recordId,clientReceipt.cashCharged);
            let delivery;
            try {delivery=await resolveGeneratedImageClientDelivery(data);} catch {delivery={url:"",revoke:()=>{},receipt:clientReceipt};}
            if(!deliveryMounted.current){delivery.revoke();continue;}
            transientImageReleases.current.get(job.id)?.();
            if("blob" in delivery && delivery.blob)transientImageBlobs.current.set(delivery.url,{jobId:job.id,recordId:clientReceipt.recordId,blob:delivery.blob});
            transientImageReleases.current.set(job.id,()=>{transientImageBlobs.current.delete(delivery.url);delivery.revoke();});
            setJobs(current=>current.map(item=>item.id===job.id?{...item,status:"done",imageUrl:delivery.url||undefined,deliveryReceipt:delivery.receipt||clientReceipt,storageKey:undefined,assetId:undefined,cashCharged:clientReceipt.cashCharged,billingReferenceId:clientReceipt.billingReferenceId,taskId:data.taskId||data.traceId,resolution:isImageResolution(data.resolution)?data.resolution:requestPayload.resolution,error:!delivery.url?"图片生成已完成；任务与费用收据已保留，当前图片无法恢复":clientReceipt.deliveryMode==="inline_ephemeral"?"图片仅当前页面可预览下载，请及时保存":undefined}:item));
            if(typeof data.cashRemaining==="number")setCashBalance(data.cashRemaining);
            continue;
          }
          const generatedUrl = data.images?.[0]?.url;
          const generatedStorageKey = data.images?.[0]?.storageKey;
          const generatedAssetId = data.images?.[0]?.assetId;
          const generatedOperationId = data.operationId?.trim() || undefined;
          const generatedBillingReferenceId = data.billingReferenceId?.trim()
            || (generatedOperationId ? `image:${generatedOperationId}` : undefined);
          if (!response.ok || !generatedUrl || !generatedStorageKey || !generatedAssetId || !generatedOperationId) {
            const requestError = new Error(
              data.error || "生图结果缺少永久资产或计费操作标识，已停止二次转存",
            ) as Error & { code?: string; status?: number; upstreamCalled?: boolean; billed?: boolean; confirmedRejected?: boolean };
            requestError.code = data.code || "IMAGE_DELIVERY_IDENTITY_MISSING";
            requestError.status = response.ok ? 502 : response.status;
            requestError.upstreamCalled = data.upstreamCalled;
            requestError.billed = data.billed;
            requestError.confirmedRejected = data.state === "rejected" && data.canResubmit === true && data.sameKeyCanResubmit === false;
            throw requestError;
          }
          if (typeof data.cashRemaining === "number") setCashBalance(data.cashRemaining);
          setJobs((current) => current.map((item) => item.id === job.id ? {
            ...item,
            status: "storing",
            storageKey: generatedStorageKey,
            assetId: generatedAssetId,
            operationId: generatedOperationId,
            billingReferenceId: generatedBillingReferenceId,
          } : item));
          // 只有同时拿到终态、永久资产和历史记录后，才向页面发放可预览/可下载图片。
          const stored = await persistGeneratedImage(
            generatedUrl,
            originalIndex + 1,
            generationTraceId,
            generatedStorageKey,
            generatedAssetId,
          );
          const storedUrl = normalizeImageUrl(stored.url);
          const generatedTaskId = data.taskId;
          const actualResolution = isImageResolution(data.resolution) ? data.resolution : requestPayload.resolution;
          const actualCashCharged = Math.max(0, Number(data.cashCharged || 0));
          const historyItem: ImageHistoryItem = {
            id: job.id,
            prompt: requestPayload.prompt,
            imageUrl: storedUrl,
            storageKey: stored.key,
            assetId: stored.assetId,
            historyRecordId: stored.historyRecordId!,
            taskId: generatedTaskId,
            operationId: generatedOperationId,
            billingReferenceId: generatedBillingReferenceId,
            resolution: actualResolution,
            cashCharged: actualCashCharged,
          };
          const historyRecord: ImageHistoryRecord = {
            id: historyBatchId,
            createdAt: Date.now(),
            mode: requestPayload.referenceImageUrls.length ? "image-to-image" : "text-to-image",
            aspectRatio: requestPayload.aspectRatio,
            modelName: models.find((model) => model.id === requestPayload.modelId)?.name || "原生图模型",
            items: [historyItem],
            resolution: actualResolution,
            totalCharged: actualCashCharged,
          };
          // Do not clear the exact request identity until the account history
          // row is durably acknowledged. A page close can then never create an
          // owned-but-invisible image that the workbench cannot discover.
          await persistAccountHistoryRecord(historyRecord);
          committedHistory.push(historyRecord);
          setJobs((current) => current.map((item) => item.id === job.id ? {
            ...item,
            prompt: requestPayload.prompt,
            imageUrl: storedUrl,
            storageKey: stored.key,
            assetId: stored.assetId,
            historyRecordId: stored.historyRecordId,
            status: "done",
            generationKey: undefined,
            generationTraceId: undefined,
            generationModelId: undefined,
            generationFingerprint: undefined,
            historyBatchId: undefined,
            taskId: generatedTaskId,
            operationId: generatedOperationId,
            billingReferenceId: generatedBillingReferenceId,
            resolution: actualResolution,
            cashCharged: actualCashCharged,
          } : item));
        } catch (error) {
          const message = error instanceof Error ? error.message : "生成失败";
          const requestError = error as Error & { code?: string; status?: number; upstreamCalled?: boolean; billed?: boolean; confirmedRejected?: boolean };
          let nextStatus: JobStatus = "failed";
          let nextMessage = message;
          let confirmedRejected = requestError.confirmedRejected === true;
          const ambiguousTransport = !confirmedRejected && !isConfirmedUnsubmittedImageFailure(requestError) && (
            !requestError.status || requestError.status >= 500
            || requestError.code === "IMAGE_IDEMPOTENCY_FAIL_CLOSED"
          );
          if (ambiguousTransport) {
            try {
              const inspected = await inspectImageAttempt({
                ...job,
                generationKey,
                generationTraceId,
                generationModelId: requestPayload.modelId,
                generationFingerprint,
              });
              if (inspected?.canRecover === true) {
                nextStatus = "recoverable";
                nextMessage = inspected.message || "图片已生成，系统正在自动保存。";
                recoverableCount += 1;
              } else if (inspected?.state === "rejected" && inspected.canResubmit === true && inspected.sameKeyCanResubmit === false) {
                confirmedRejected = true;
                nextMessage = inspected.message || "本次请求未被受理，请调整后重新生成。";
              } else {
                nextStatus = "unknown";
                nextMessage = inspected?.message || "图片结果待确认，原请求已保留。请稍后刷新状态。";
                unknownCount += 1;
              }
            } catch (statusError) {
              nextStatus = "unknown";
              nextMessage = `${message}；${statusError instanceof Error ? statusError.message : "状态不明"}，勿重复提交。`;
              unknownCount += 1;
            }
          }
          setJobs((current) => current.map((item) => item.id === job.id ? {
            ...item,
            status: nextStatus,
            error: nextMessage,
            generationKey,
            generationTraceId,
            generationModelId: requestPayload.modelId,
            generationFingerprint,
            historyBatchId,
            generationRejected: confirmedRejected,
            rejectedAttempts: confirmedRejected && !item.rejectedAttempts?.some((attempt) => attempt.key === generationKey)
              ? [...(item.rejectedAttempts || []), { key: generationKey, traceId: generationTraceId, modelId: requestPayload.modelId, message: nextMessage }]
              : item.rejectedAttempts,
            taskId: undefined,
          } : item));
          if (/余额不足|INSUFFICIENT_BALANCE/i.test(message)) {
            window.dispatchEvent(new CustomEvent("insufficient-balance", { detail: { mode: "cash", message } }));
          }
        }
      }
      if (committedHistory.length) {
        setHistory((current) => cleanHistory([
          ...committedHistory,
          ...current,
        ]));
      }
      const totalCharged = [...completedReceipts.values()].reduce((a,b)=>a+b,0)+committedHistory.reduce((sum, item) => sum + Number(item.totalCharged || 0), 0);
      const completedCount = committedHistory.length+completedReceipts.size;
      setNotice([
        completedCount ? `已完成 ${completedCount} 张图片；临时图片请在当前页面下载` : "本次暂无已保存的图片，请查看卡片上的提示",
        unknownCount || recoverableCount ? `已确认费用 ¥${totalCharged.toFixed(2)}，其余任务待确认` : `实际费用 ¥${totalCharged.toFixed(2)}`,
        ...(recoverableCount ? [`${recoverableCount} 张图片正在自动保存，无需重新生成`] : []),
        ...(unknownCount ? [`${unknownCount} 张图片状态待确认，请刷新任务状态，暂勿重复生成`] : []),
      ].join("；") + "。");
    } finally {
      generationInFlightRef.current = false;
      setBusy(false);
    }
  }, [actionableJobCount, activeModel, activeReferenceLimit, aspectRatio, inspectImageAttempt, jobs, mode, models, modelSupportsMode, persistAccountHistoryRecord, persistGeneratedImage, recoverableJobCount, referenceLimitExceeded, references, selectedResolution, setHistory, token, unknownJobCount, uploadReference]);

  useEffect(() => {
    if (!unknownJobCount) {
      if (!statusRefreshing) autoUnknownPollAttemptRef.current = 0;
      return;
    }
    if (busy || statusRefreshing) return;
    const waitMs = Math.min(60_000, 3_000 * (2 ** Math.min(autoUnknownPollAttemptRef.current, 5)));
    const timer = window.setTimeout(() => {
      autoUnknownPollAttemptRef.current += 1;
      void refreshUnknownImageJobs();
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [busy, refreshUnknownImageJobs, statusRefreshing, unknownJobCount]);

  useEffect(() => {
    if (!recoverableJobCount) {
      if (!busy) autoDeliveryAttemptRef.current = 0;
      return;
    }
    if (busy || statusRefreshing) return;
    const waitMs = Math.min(60_000, 1_500 * (2 ** Math.min(autoDeliveryAttemptRef.current, 5)));
    const timer = window.setTimeout(() => {
      autoDeliveryAttemptRef.current += 1;
      void generateAll({ recoverableOnly: true });
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [busy, generateAll, recoverableJobCount, statusRefreshing]);

  const captureImageDownload = useCallback((reference: ImageDownloadReference & {id?:string;imageUrl?:string;url?:string;deliveryReceipt?:GeneratedImageClientReceipt}):ImageDownloadSource => {
    const mediaUrl=reference.imageUrl||reference.url||"";
    if(reference.deliveryReceipt?.deliveryMode==="inline_ephemeral") {
      const held=transientImageBlobs.current.get(mediaUrl);
      if(!held || held.recordId!==reference.deliveryReceipt.recordId || (reference.id && held.jobId!==reference.id))throw new Error("临时图片当前已不可下载；任务与费用收据仍保留");
      return {kind:"inline_ephemeral",blob:held.blob};
    }
    if(reference.deliveryReceipt?.deliveryMode==="provider_url") {
      if(mediaUrl!=="/api/media-history/content?recordId="+reference.deliveryReceipt.recordId)throw new Error("图片归属凭证无效；任务与费用收据仍保留");
      return {kind:"provider_url",recordId:reference.deliveryReceipt.recordId};
    }
    return {kind:"legacy_owned",read:()=>fetchWorkbenchImagePng(reference,token)};
  }, [token]);
  const downloadImage = useCallback(async (reference: Parameters<typeof captureImageDownload>[0], filename: string) => {
    const source=captureImageDownload(reference),operation=downloadOperations.current.begin(identity.userId+"\0"+token);
    try {operation.assertCurrent();const blob=await readImageDownloadBlob(source,token,operation.signal);operation.assertCurrent();downloadBlob(blob,imageDownloadFilename(filename,blob));}
    finally {operation.finish();}
  }, [captureImageDownload,identity.userId,token]);
  const downloadImageWithNotice = useCallback((reference: ImageDownloadReference, filename: string) => {
    void downloadImage(reference, filename).catch(error => setNotice(error instanceof Error ? error.message : "图片下载失败，请稍后重试"));
  }, [downloadImage]);

  const downloadAll = useCallback(async () => {
    if (!completedJobs.length) {
      setNotice("还没有可下载图片。");
      return;
    }
    setDownloadBusy(true);
    const operation=downloadOperations.current.begin(identity.userId+"\0"+token);
    try {
      operation.assertCurrent();
      // Synchronous strong references keep an explicitly started ZIP valid if a card is deleted.
      const sources=jobs.flatMap((job,index)=>job.status==="done" && job.imageUrl && (job.deliveryReceipt || (job.assetId && job.storageKey))?[{name:`${index+1}`,source:captureImageDownload(job)}]:[]);
      const entries: ZipEntry[] = [];
      for (const item of sources) {
        operation.assertCurrent();const image=await readImageDownloadBlob(item.source,token,operation.signal);
        entries.push({ name:imageDownloadFilename(item.name,image),bytes:new Uint8Array(await image.arrayBuffer()) });
      }
      operation.assertCurrent();
      downloadBlob(buildZip(entries), "AI生图工作台.zip");
      setNotice(`已打包 ${entries.length} 张图片，文件名按提示词顺序升序排列。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "一键下载失败");
    } finally {
      operation.finish();
      setDownloadBusy(false);
    }
  }, [completedJobs.length, jobs, token,captureImageDownload,identity.userId]);

  const pushGeneratedImagesToVideo = useCallback(() => {
    if(jobs.some(job=>job.status==="done" && job.deliveryReceipt?.deliveryMode==="inline_ephemeral")){
      setNotice("临时图片仅当前页面可预览下载，当前视频通道不支持这类输入；本次没有提交视频或扣费。");return;
    }
    const generated = jobs.filter((job) => (
      job.imageUrl && job.status === "done" && ((job.assetId && job.storageKey) || job.deliveryReceipt?.deliveryMode==="provider_url")
    ));
    if (!generated.length) {
      setNotice("请先完成至少一张图片生成后再推送到视频任务。");
      return;
    }
    if (videoPushMode === "first-last" && generated.length % 2 !== 0) {
      setNotice("首尾帧模式必须是偶数张已生成图片：每两张对应一个视频任务。");
      return;
    }

    const updates = generated.map((job, index) => ({
      order: videoPushMode === "reference" ? index + 1 : Math.floor(index / 2) + 1,
      prompt: videoPushMode === "reference" || index % 2 === 0 ? job.prompt : undefined,
      promptKind: "image" as const,
      ...(job.deliveryReceipt?.deliveryMode==="provider_url" ? {imageRef:{schema:"generated_image_ref.v1" as const,recordId:job.deliveryReceipt.recordId}} : {imageUrl:normalizeImageUrl(job.imageUrl)}),
      imageTarget: videoPushMode === "reference"
        ? "reference" as const
        : index % 2 === 0 ? "first-frame" as const : "last-frame" as const,
      label: `任务${videoPushMode === "reference" ? index + 1 : Math.floor(index / 2) + 1}`,
    }));
    const draft = mergeVideoWorkflowDraft(updates, videoPushMode);
    if (!draft) {
      setNotice("视频任务草稿暂时无法保存，请稍后重试。");
      return;
    }
    const taskCount = videoPushMode === "reference" ? generated.length : generated.length / 2;
    setNotice(`已推送 ${generated.length} 张图片到 ${taskCount} 个视频任务；临时交接保留 2 分钟，视频页读取后立即清除。`);
    window.location.assign(`/video?workflow=${draft.updatedAt}`);
  }, [jobs, videoPushMode]);

  const loadFailureHistory = useCallback(async (page = 1) => {
    setFailureHistoryLoading(true);
    setFailureHistoryError("");
    try {
      const response = await fetch(`/api/image-workbench/failure-history?page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => ({})) as {
        records?: ImageFailureHistoryRecord[];
        nextPage?: number | null;
        error?: string;
        code?: string;
      };
      if (!response.ok || !Array.isArray(data.records)) {
        throw new Error(data.code === "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY"
          ? "失败记录服务正在准备中，请稍后重试"
          : "失败记录暂时无法读取，请稍后重试");
      }
      setFailureHistory((current) => {
        const records = page === 1 ? data.records! : [...current, ...data.records!];
        return [...new Map(records.map(record => [record.id, record])).values()]
          .sort((left, right) => right.createdAt - left.createdAt);
      });
      setFailureHistoryNextPage(Number.isSafeInteger(data.nextPage) ? data.nextPage! : null);
    } catch (error) {
      setFailureHistoryError(error instanceof Error ? error.message : "生图失败历史同步失败");
    } finally {
      setFailureHistoryLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (historyOpen) void loadFailureHistory(1);
  }, [historyOpen, loadFailureHistory]);

  const hideFailureHistory = useCallback(async (id: string) => {
    setFailureHistoryLoading(true);
    setFailureHistoryError("");
    try {
      const response = await fetch(`/api/image-workbench/failure-history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "隐藏失败记录失败");
      setFailureHistory(current => current.filter(record => record.id !== id));
    } catch (error) {
      setFailureHistoryError(error instanceof Error ? error.message : "隐藏失败记录失败");
    } finally {
      setFailureHistoryLoading(false);
    }
  }, [token]);

  const loadFailureForRetry = useCallback((record: ImageFailureHistoryRecord) => {
    if (!record.canLoadForRetry) {
      setNotice(record.retryBlockReason || "该失败请求尚未完成账务对账，暂不可再次提交。");
      return;
    }
    const modelAvailable = models.some(model => model.id === record.publicModelId);
    setMode(record.mode);
    if (isRatio(record.aspectRatio)) setAspectRatio(record.aspectRatio);
    if (isImageResolution(record.resolution)) setResolution(record.resolution);
    setModelId(modelAvailable ? record.publicModelId : "");
    setReferences(current => {
      current.forEach(asset => URL.revokeObjectURL(asset.previewUrl));
      return [];
    });
    // Loading a failed request deliberately creates a clean editor card. The
    // old idempotency key, trace, task and billing identity never enter state.
    setJobs([{ id: createId("job"), prompt: record.prompt, status: "idle" }]);
    setHistoryOpen(false);
    const referenceNotice = record.referenceCount
      ? `原请求使用 ${record.referenceCount} 张参考图；为保护素材链接，请重新上传后再提交。`
      : "";
    const modelNotice = modelAvailable ? "" : "原模型已下架，请重新选择当前可用模型。";
    setNotice(`失败请求参数已载入，尚未调用模型。${referenceNotice}${modelNotice}请核对当前价格后点击生成，系统会新建请求号。`);
  }, [models, setAspectRatio, setMode, setModelId, setResolution]);

  const addHistoryPrompts = useCallback((record: ImageHistoryRecord) => {
    setJobs((current) => [
      ...current,
      ...record.items.map((item) => ({ id: createId("job"), prompt: item.prompt, status: "idle" as const })),
    ]);
    setHistoryOpen(false);
    setNotice(`已将历史批次的 ${record.items.length} 条提示词加入当前队列。`);
  }, [setJobs]);

  return (
    <div className="voice-studio-root vs-workbench image-workbench-root h-full min-h-screen flex flex-col bg-[var(--background)]">
      <SubPageHeader
        title="AI生图工作台"
        subtitle="文生图 / 图生图 / 生图卡片 / 顺序命名下载"
        icon={<Sparkles className="w-5 h-5 text-[var(--primary)]" />}
        rightSlot={
          <div className="sub-page-inline-actions">
            <NavButton icon={History} label="历史" onClick={() => setHistoryOpen(true)} variant="ghost" />
            <div className="sub-page-wallet-pill">
              <Wallet className="sub-page-wallet-icon text-[var(--primary)]" />
              <span>¥{cashBalance.toFixed(2)}</span>
              <button
                type="button"
                onClick={() => setCashRechargeOpen(true)}
                className="sub-page-mini-action bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
              >
                充值
              </button>
            </div>
          </div>
        }
      />

      <main className="flex-1 min-h-0 grid grid-cols-[320px_minmax(0,1fr)] max-[980px]:grid-cols-1 overflow-hidden">
        <aside className="min-h-0 overflow-y-auto border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_88%,transparent)] p-5 space-y-5">
          <div className="flex items-center gap-2 text-[var(--foreground)] font-bold">
            <PanelTop className="w-4 h-4 text-[var(--primary)]" />
            生成配置
          </div>

          <section className="space-y-2">
            <label className="text-xs font-semibold text-[var(--muted-foreground)]">生成模式</label>
            <div className="grid grid-cols-2 rounded-lg border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setMode("text-to-image")}
                className={`h-10 text-sm font-bold transition-colors ${mode === "text-to-image" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--muted)]"}`}
              >
                文生图
              </button>
              <button
                type="button"
                onClick={() => setMode("image-to-image")}
                className={`h-10 text-sm font-bold transition-colors ${mode === "image-to-image" ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--muted)]"}`}
              >
                图生图
              </button>
            </div>
          </section>

          <section className="space-y-2">
            <label htmlFor="image-workbench-model" className="text-xs font-semibold text-[var(--muted-foreground)]">模型选择</label>
            <div className="relative">
              <select
                id="image-workbench-model"
                aria-describedby="image-workbench-model-status"
                aria-busy={modelCatalogState === "loading"}
                value={modelId}
                disabled={modelCatalogState !== "ready" || visibleModels.length === 0}
                onChange={(event) => setModelId(event.target.value)}
                className="w-full h-11 appearance-none rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 pr-9 text-sm text-[var(--foreground)] outline-none"
              >
                {!visibleModels.some(model => model.id === modelId) && <option value={modelId} disabled>{
                  modelCatalogState === "loading" ? "正在读取模型…"
                    : modelCatalogState === "error" ? "模型目录读取失败"
                      : selectedModelRemoved ? "原模型已移除，请重新选择"
                        : modelCatalogState === "empty" ? "当前模型目录为空"
                          : activeModel ? `${activeModel.name}（不支持图生图）` : "请选择生图模型"
                }</option>}
                  {visibleModels.map((model) => (
                    <option key={model.id} value={model.id} disabled={!model.available}>
                      {model.name}{model.available ? "" : `（${model.availability_message || "暂不可用"}）`}
                    </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] pointer-events-none" />
            </div>
            <p id="image-workbench-model-status" role={modelCatalogState === "error" || selectedModelRemoved ? "alert" : "status"} aria-live="polite" className="text-xs text-[var(--muted-foreground)]">
              {modelCatalogMessage}
            </p>
            <button type="button" disabled={modelCatalogState === "loading"} onClick={() => setModelCatalogReload(value => value + 1)}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--foreground)] hover:border-[var(--primary)] disabled:opacity-45">
              {modelCatalogState === "loading" ? "正在读取模型…" : "重新读取模型"}
            </button>
            <p className="text-xs text-[var(--muted-foreground)]">
              {!activeModel ? "模型能力待目录确认" : activeModel.supports_image_input ? "当前模型支持参考图输入" : "当前模型仅用于文生图"}
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">
                  {selectedResolution} 公开价：<span className="font-semibold text-[var(--foreground)]">{selectedResolutionPrice == null ? "价格待确认" : `¥${selectedResolutionPrice.toFixed(2)}/张`}</span>
                  {newGenerationJobCount > 0 && selectedResolutionPrice != null ? <> · 本次预计 <span className="font-semibold text-amber-500">¥{estimatedCharge.toFixed(2)}</span></> : null}
            </p>
          </section>

          <section className="space-y-2">
            <label className="text-xs font-semibold text-[var(--muted-foreground)]">输出分辨率</label>
            <div className="grid grid-cols-3 gap-2">
              {supportedResolutions.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setResolution(item)}
                  className={`h-10 rounded-lg border text-xs font-bold transition-colors ${selectedResolution === item ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]" : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
                >
                  {item}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <label className="text-xs font-semibold text-[var(--muted-foreground)]">画面比例</label>
            <div className="grid grid-cols-5 gap-2">
              {supportedRatios.map((ratio) => (
                <button
                  type="button"
                  key={ratio}
                  onClick={() => setAspectRatio(ratio)}
                  className={`h-12 rounded-lg border text-xs font-bold transition-colors ${aspectRatio === ratio ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]" : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--muted-foreground)]">参考图</label>
              <span className="text-[11px] text-[var(--muted-foreground)]">{mode === "image-to-image" ? `图生图必填 · 最多 ${activeReferenceLimit} 张` : "文生图不需要"}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(event: ChangeEvent<HTMLInputElement>) => { handleFiles(event.target.files); event.target.value = ""; }}
            />
            <button
              type="button"
              disabled={mode !== "image-to-image" || !modelSupportsMode || activeReferenceLimit === 0 || references.length >= activeReferenceLimit}
              onClick={() => fileInputRef.current?.click()}
              className="w-full min-h-32 rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)] disabled:opacity-45 flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)] hover:border-[var(--primary)] transition-colors"
            >
              <Upload className="w-6 h-6" />
              <span className="text-sm font-semibold">点击上传参考图</span>
              <small>PNG / JPEG / WebP · 单张不超过 5MB · {references.length}/{activeReferenceLimit} 张</small>
            </button>
            {referenceLimitExceeded && (
              <p role="alert" className="text-xs font-semibold text-amber-500">
                当前模型最多支持 {activeReferenceLimit} 张参考图，现有 {references.length} 张。系统不会自动删除，请手动移除多余图片后再生成。
              </p>
            )}
            {references.length > 0 && (
              <div className="space-y-2">
                {references.map((asset) => (
                  <div key={asset.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2">
                    <img src={asset.previewUrl} alt={asset.file.name} className="w-10 h-10 rounded-md object-cover bg-[var(--muted)]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-[var(--foreground)]">{asset.file.name}</p>
                      <span className="text-[11px] text-[var(--muted-foreground)]">{asset.status === "ready" ? "已入库" : asset.status === "uploading" ? "上传中" : "待上传"}</span>
                    </div>
                    <button type="button" onClick={() => removeReference(asset.id)} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--muted)]" aria-label="移除参考图">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-3">
            <div>
              <strong className="block text-sm text-[var(--foreground)]">按提示词顺序命名</strong>
              <span className="text-xs text-[var(--muted-foreground)]">下载包内固定为升序文件名</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <span className="rounded-md bg-[var(--muted)] px-2 py-2 text-center">1.png</span>
              <span className="rounded-md bg-[var(--muted)] px-2 py-2 text-center">2.png</span>
              <span className="rounded-md bg-[var(--muted)] px-2 py-2 text-center">3.png</span>
              <span className="rounded-md bg-[var(--muted)] px-2 py-2 text-center">4.png</span>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-3">
            <div>
              <strong className="block text-sm text-[var(--foreground)]">推送到视频任务</strong>
              <span className="text-xs text-[var(--muted-foreground)]">按生图卡片顺序写入同序视频任务；临时交接 2 分钟内有效，读取一次即清除。</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setVideoPushMode("reference")}
                className={`min-h-12 rounded-md border px-2 text-xs font-bold transition-colors ${videoPushMode === "reference" ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
              >
                <span className="leading-4">参考图<br />{activeReferenceLimit > 0 ? `当前模型上限 ${activeReferenceLimit} 张` : "当前模型不支持"}</span>
              </button>
              <button
                type="button"
                onClick={() => setVideoPushMode("first-last")}
                className={`min-h-12 rounded-md border px-2 text-xs font-bold transition-colors ${videoPushMode === "first-last" ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
              >
                <span className="leading-4">首尾帧<br />2 张 / 任务</span>
              </button>
            </div>
            <button
              type="button"
              disabled={!completedJobs.length}
              onClick={pushGeneratedImagesToVideo}
              className="w-full h-10 rounded-md border border-[var(--primary)]/45 text-[var(--primary)] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[var(--primary)]/10 disabled:opacity-45 transition-colors"
            >
              <Video className="w-4 h-4" /> 推送已生成图片
            </button>
          </section>

          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => void generateAll()}
            className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold flex items-center justify-center gap-2 disabled:opacity-50 hover:opacity-95 transition-opacity"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            生成图片（{newGenerationJobCount}）
          </button>
          <p className="text-center text-xs text-[var(--muted-foreground)]">一张卡片对应一张图片</p>
        </aside>

        <section className="min-h-0 overflow-y-auto p-5 space-y-4 bg-[var(--background)]">
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-[var(--foreground)]">生图</h2>
                    <p className="text-xs text-[var(--muted-foreground)]">每张卡片上方显示图片，下方直接填写该图片的完整提示词。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={addPromptCard} className="h-9 w-9 rounded-lg border border-[var(--border)] hover:bg-[var(--muted)] flex items-center justify-center" aria-label="添加生图卡片" title="添加生图卡片">
                      <Plus className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={downloadAll} disabled={!completedJobs.length || downloadBusy} className="h-9 px-3 rounded-lg border border-[var(--border)] text-sm font-bold hover:bg-[var(--muted)] disabled:opacity-45 flex items-center gap-1.5">
                      {downloadBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
                      一键下载
                    </button>
                    <button type="button" onClick={resetDraftJobs} className="h-9 w-9 rounded-lg border border-[var(--border)] hover:bg-[var(--muted)] flex items-center justify-center" aria-label="重置普通生图草稿" title="重置普通草稿，保留尚未确认结果的任务">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3 max-[1500px]:grid-cols-3 max-[1080px]:grid-cols-2 max-[680px]:grid-cols-1">
                  {jobs.length ? jobs.map((job, index) => (
                    <article key={job.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 space-y-2">
                      <header className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-md bg-[var(--muted)] flex items-center justify-center text-xs font-bold">{index + 1}</span>
                        <strong className="text-xs flex-1">{index + 1}.png</strong>
                        <button type="button" onClick={async () => { const copied = await copyToClipboard(job.prompt); setNotice(copied ? "提示词已复制" : "复制失败，请选中提示词后手动复制"); }} disabled={!job.prompt.trim()} className="w-7 h-7 rounded-md hover:bg-[var(--muted)] disabled:opacity-35 flex items-center justify-center" aria-label="复制提示词">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {job.status === "done" && job.imageUrl && (job.deliveryReceipt || (job.assetId && job.storageKey)) && <button type="button" onClick={() => downloadImageWithNotice(job, `${index + 1}.png`)} className="w-7 h-7 rounded-md hover:bg-[var(--muted)] flex items-center justify-center" aria-label="下载图片">
                          <Download className="w-3.5 h-3.5" />
                        </button>}
                        <button type="button" onClick={() => removeJob(job.id)} disabled={hasUnresolvedImageAttempt(job)} className="w-7 h-7 rounded-md hover:bg-[var(--muted)] disabled:opacity-35 flex items-center justify-center" aria-label="删除生图卡片" title={hasUnresolvedImageAttempt(job) ? "请先确认本次生成结果，再删除卡片" : "删除生图卡片"}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </header>
                      <WorkbenchImageThumb
                        imageUrl={job.imageUrl}
                        label={`${index + 1}.png`}
                        status={job.status}
                        onOpen={() => {
                          if (job.imageUrl) setPreviewTarget({ url: job.imageUrl, title: `${index + 1}.png`, prompt: job.prompt, assetId: job.assetId, historyRecordId: job.historyRecordId,deliveryReceipt:job.deliveryReceipt });
                        }}
                      />
                      <textarea
                        value={job.prompt}
                        onChange={(event) => updateJobPrompt(job.id, event.target.value)}
                        readOnly={hasUnresolvedImageAttempt(job)}
                        aria-label={`第 ${index + 1} 张图片提示词`}
                        title={hasUnresolvedImageAttempt(job) ? "结果待确认，原提示词已保留" : undefined}
                        placeholder="在这里填写这一张图片的完整提示词"
                        className="min-h-28 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] p-2.5 text-xs leading-5 outline-none focus:border-[var(--primary)]"
                      />
                      <p className={`text-[11px] ${job.status === "failed" ? "text-red-500" : job.status === "unknown" ? "text-amber-600" : job.status === "recoverable" ? "text-sky-600" : "text-[var(--muted-foreground)]"}`}>{job.status === "unknown" && /人工对账|终态|attempt_id/.test(job.error || "") ? "图片结果待确认，原请求已保留。请刷新状态。" : job.error || statusLabel(job.status)}</p>
                      {job.status === "unknown" && job.generationTraceId ? (
                        <p className="truncate text-[10px] text-amber-600" title={job.generationTraceId}>处理编号：{job.generationTraceId}</p>
                      ) : null}
                      {(job.taskId || job.deliveryReceipt?.recordId) ? (
                        <p className="truncate text-[10px] text-[var(--muted-foreground)]" title={job.taskId || job.deliveryReceipt?.recordId}>
                          任务 ID：{job.taskId || job.deliveryReceipt?.recordId} · {job.resolution || selectedResolution} · 实扣 ¥{Number(job.cashCharged || 0).toFixed(2)}
                        </p>
                      ) : null}
                    </article>
                  )) : (
                    <div className="col-span-full h-40 rounded-lg border border-dashed border-[var(--border)] flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
                      <ImageIcon className="w-8 h-8" />
                      <span className="text-sm">添加卡片后，在图片框下方填写提示词。</span>
                    </div>
                  )}
                </div>
              </section>
        </section>

      </main>

      {historyOpen && (
        <div className="fixed inset-0 z-[60] flex justify-end bg-black/35" role="dialog" aria-modal="true" aria-labelledby="image-history-title">
          <button type="button" className="absolute inset-0 cursor-default" onClick={() => setHistoryOpen(false)} aria-label="关闭历史记录" />
          <aside style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }} className="relative flex h-full w-full max-w-[560px] flex-col border-l border-[var(--border)] bg-[var(--background)] shadow-2xl">
            <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <History className="h-5 w-5 text-[var(--primary)]" />
                  <h2 id="image-history-title" className="text-lg font-bold text-[var(--foreground)]">生成历史</h2>
                  <span className="rounded-md bg-[var(--muted)] px-2 py-1 text-[11px] text-[var(--muted-foreground)]">账户历史</span>
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">已保存到当前账户。删除历史会保留已生成的图片。</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => void accountHistory.remove()} disabled={!history.length || !accountHistory.ready || accountHistory.syncing} className="h-8 rounded-md px-2 text-xs font-semibold text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40">清空</button>
                <button type="button" onClick={() => setHistoryOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--muted)]" aria-label="关闭历史记录">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-2 text-xs">
              <span role="status" className="text-[var(--muted-foreground)]">{accountHistory.syncing || failureHistoryLoading ? "正在同步历史…" : accountHistory.error || failureHistoryError || "已同步到账户"}</span>
              <button type="button" onClick={() => { accountHistory.refresh(); void loadFailureHistory(1); }} disabled={accountHistory.syncing || failureHistoryLoading} className="shrink-0 rounded px-2 py-1 font-semibold hover:bg-[var(--muted)] disabled:opacity-40">{accountHistory.error || failureHistoryError ? "重试" : "刷新"}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {(failureHistory.length > 0 || failureHistoryLoading || failureHistoryError) && (
                <section className="mb-5 space-y-3" aria-labelledby="image-failure-history-title">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 id="image-failure-history-title" className="text-sm font-bold text-[var(--foreground)]">失败记录</h3>
                      <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">仅显示明确终态失败，按提交时间从新到旧；载入不会自动生成。</p>
                    </div>
                    <span className="rounded bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-600">{failureHistory.length} 条</span>
                  </div>
                  {failureHistoryError && <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600">{failureHistoryError}</div>}
                  {failureHistory.map(record => (
                    <article key={record.id} className="rounded-lg border border-red-500/25 bg-[var(--card)] p-3.5">
                      <header className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <strong className="text-sm text-[var(--foreground)]">{formatHistoryTime(record.createdAt)}</strong>
                          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{modeLabel(record.mode)} · {record.aspectRatio} · {record.resolution} · {record.modelName}</p>
                        </div>
                        <button type="button" onClick={() => void hideFailureHistory(record.id)} disabled={failureHistoryLoading} className="h-7 shrink-0 rounded-md px-2 text-[11px] font-semibold text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40">隐藏</button>
                      </header>
                      <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--foreground)]">{record.prompt}</p>
                      <div className="mt-3 rounded-md bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-600">
                        <p>{record.error.message}</p>
                        <p className="mt-1 text-[10px] opacity-80">本次生成未完成，输入和报价已保留。</p>
                      </div>
                      <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
                        原报价 ¥{record.quotedPriceYuan.toFixed(2)} · {record.billing.state === "charged"
                          ? `账单已扣 ¥${Number(record.billing.chargedAmount || 0).toFixed(2)}`
                          : record.billing.state === "exempt"
                            ? "未扣费"
                            : record.billing.state === "not_charged"
                              ? "未扣费"
                              : "计费状态待核对"}
                        {record.referenceCount ? ` · 原参考图 ${record.referenceCount} 张（重新提交前需重传）` : ""}
                      </p>
                      <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]" title={record.traceId}>任务追踪：{record.traceId}</p>
                      {record.retryBlockReason && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">{record.retryBlockReason}</p>}
                      <div className="mt-3 flex justify-end">
                        <button type="button" onClick={() => loadFailureForRetry(record)} disabled={!record.canLoadForRetry} className="h-8 rounded-md border border-[var(--primary)]/50 px-3 text-xs font-bold text-[var(--primary)] hover:bg-[var(--primary)]/10 disabled:opacity-40">{record.canLoadForRetry ? "载入参数后重试" : "请先完成账务对账"}</button>
                      </div>
                    </article>
                  ))}
                  {failureHistoryLoading && !failureHistory.length && <p className="py-4 text-center text-xs text-[var(--muted-foreground)]">正在加载失败记录…</p>}
                  {failureHistoryNextPage && <button type="button" onClick={() => void loadFailureHistory(failureHistoryNextPage)} disabled={failureHistoryLoading} className="w-full rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)] disabled:opacity-40">加载更多失败记录</button>}
                  <div className="border-t border-[var(--border)] pt-1" />
                </section>
              )}
              {history.length ? (
                <div className="space-y-4">
                  {history.map((record) => (
                    <article key={record.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3.5">
                      <header className="flex items-start gap-3">
                        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <strong className="text-sm text-[var(--foreground)]">{formatHistoryTime(record.createdAt)}</strong>
                            <button type="button" onClick={() => void accountHistory.remove(record.id)} disabled={!accountHistory.ready || accountHistory.syncing} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]" aria-label="删除此历史记录">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{modeLabel(record.mode)} · {record.aspectRatio} · {record.resolution || "历史未记录"} · {record.modelName} · {record.items.length} 张 · {typeof record.totalCharged === "number" ? `实扣 ¥${record.totalCharged.toFixed(2)}` : "费用未记录"}</p>
                        </div>
                      </header>

                      <div className="mt-3 grid grid-cols-4 gap-2">
                        {record.items.slice(0, expandedHistoryIds.has(record.id) ? undefined : 4).map((item, index) => (
                          <HistoryImageThumb
                            key={item.id}
                            imageUrl={item.imageUrl}
                            label={`历史图片 ${index + 1}`}
                            onOpen={() => setPreviewTarget({ url: item.imageUrl, title: `${index + 1}.png`, prompt: item.prompt, assetId: item.assetId, historyRecordId: item.historyRecordId })}
                            onDownload={() => downloadImageWithNotice(item, `${index + 1}.png`)}
                          />
                        ))}
                      </div>
                      {record.items.length > 4 && <button type="button" aria-expanded={expandedHistoryIds.has(record.id)} onClick={() => setExpandedHistoryIds(current => { const next = new Set(current); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })} className="mt-2 rounded px-2 py-1 text-xs font-semibold text-[var(--primary)] hover:bg-[var(--muted)]">{expandedHistoryIds.has(record.id) ? "收起图片" : `查看其余 ${record.items.length - 4} 张图片`}</button>}
                      <p className="mt-3 line-clamp-2 text-xs leading-5 text-[var(--muted-foreground)]">{record.items[0]?.prompt}</p>
                      {record.items[0]?.taskId ? (
                        <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]" title={record.items[0].taskId}>任务 ID：{record.items[0].taskId}</p>
                      ) : null}
                      <div className="mt-3 flex justify-end">
                        <button type="button" onClick={() => addHistoryPrompts(record)} className="h-8 rounded-md border border-[var(--border)] px-3 text-xs font-bold text-[var(--foreground)] hover:bg-[var(--muted)]">提示词加入队列</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center text-[var(--muted-foreground)]">
                  <History className="h-9 w-9" />
                  <strong className="text-sm text-[var(--foreground)]">{accountHistory.syncing ? "正在加载历史" : accountHistory.error ? "暂时无法读取账户历史" : failureHistory.length ? "暂无已完成图片" : "暂无生成历史"}</strong>
                  <span className="text-xs">完成生图后，结果会自动保存在当前账户。</span>
                </div>
              )}
              {accountHistory.hasMore && <button type="button" onClick={() => void accountHistory.loadMore()} disabled={accountHistory.syncing} className="mt-4 w-full rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--muted)] disabled:opacity-40">加载更多历史</button>}
            </div>
          </aside>
        </div>
      )}

      <ImagePreviewLightbox target={previewTarget} onClose={() => setPreviewTarget(null)} onDownload={target => downloadImage(target, target.title)} />

      {notice && <div role="status" className="fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 max-w-[min(720px,calc(100vw-32px))] rounded-full border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-xs text-[var(--muted-foreground)] shadow-lg">
        {notice}
      </div>}

      <RechargeDialog
        open={cashRechargeOpen}
        onOpenChange={setCashRechargeOpen}
        credits={Number(state.auth.user?.credits || 0)}
        cashBalance={cashBalance}
        mode="cash"
        onCashUpdated={setCashBalance}
      />
    </div>
  );
}
