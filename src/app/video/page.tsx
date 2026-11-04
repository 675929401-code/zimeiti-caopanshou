"use client";
import { resolveAiVideoInputAspectRatio } from "@/lib/ai-video-page-capabilities";
import { readVideoDurationBehavior, type VideoDurationBehavior } from "@/lib/video-duration-behavior";
import { VideoDurationBehaviorNotice } from "@/components/video-duration-behavior-notice";
import { videoProgressLabel, videoProgressStatus, videoSubmissionConfirmationSignal } from '@/lib/video-task-progress';
import { getVideoMediaUnavailable, videoCompletedDeliveryPatch } from "@/lib/video-media-availability";

import { requiresVideoTaskTracking } from "@/lib/video-task-checkpoint";
import { clearRetiredPageDrafts } from "@/lib/retired-page-drafts";
import { VideoHistoryPanel, type VideoHistoryItem } from "@/components/video-history-panel";
import { MediaHistoryWorkspace } from "@/components/media-history-workspace";
import { VideoLocalAutoCache, type AutoCacheResult } from "@/lib/video-local-auto-cache";
import { SseEventStreamDecoder } from "@/lib/sse-stream-decoder";
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useId, Fragment } from "react";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { boundVideoTaskModel, reconcileVideoModelSelection, videoModelInputHint, videoModelInputLabel } from "@/lib/video-model-selection-state";
import { publicVideoModelCompatibilityCode } from "@/lib/video-model-public-status";
import { reportVideoSubmitFailed, reportVideoPollTimeout } from "@/lib/diagnostic-sentry";
import { validateVideoInputContract } from "@/lib/video-input-contract";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";
import {
  isAmbiguousAutodlH3SubmissionStatus,
} from "@/lib/autodl-h3-client-idempotency";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  resolveBrowserClientAttempt,
} from "@/lib/browser-client-attempt";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import {
  VideoModel,
  VideoTask,
} from "@/types/coze";
import {
  coerceVideoTargetDuration,
  getVideoDurationCapabilities,
  getVideoBillingUnit,
  readVideoTokenPublicPricing,
  resolveVideoTokenBillingConsent,
  videoTokenRateLabel,
  getVideoResolutionCapabilities,
  getVideoTargetDurationOptions,
  resolveVideoCharge,
  resolveVideoDuration,
  resolveVideoResolution,
} from "@/lib/video-model-capabilities";
import { extractPromptDurationSeconds } from "@/lib/video-prompt-timing";
import {
  restoreVideoGenerateAudio,
  videoGenerateAudioForSubmission,
} from "@/lib/video-generate-audio-state";
import { formatActualVideoDuration, videoDurationDisplay } from "@/lib/video-duration-display";
import {
  AI_VIDEO_PAGE_ASPECT_RATIOS,
  getAiVideoPageDefaultResolution,
  getAiVideoPageInputCapabilities,
} from "@/lib/ai-video-page-capabilities";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Plus,
  Trash2,
  Upload,
  Video,
  Download,
  Clock,
  RefreshCw,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  History,
  ImageIcon,
  Zap,
  Settings2,
  ChevronUp,
  ChevronDown,
  Palette,
  Type,
  MoveVertical,
  Save,
  CheckSquare,
  Square,
  FolderOpen,
  Check,
  Wallet,
  Wand2,
  Eraser,
} from "lucide-react";
import { SubPageHeader, NavButton } from "@/components/sub-page-header";
import { BrandFooter } from "@/components/brand-footer";
import { ModelBadge } from "@/components/model-badge";
import { useApp } from "@/contexts/app-context";
import { RechargeDialog } from "@/components/recharge-dialog";
import { resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import {
  clearLegacyVideoTaskTransfer,
  clearPendingVideoTaskTransfer,
  readPendingVideoTaskTransfer,
  VIDEO_TASK_TRANSFER_EVENT,
  type VideoTaskTransferPayload,
} from "@/lib/video-task-transfer";
import {
  clearLegacyVideoWorkflowDraft,
  clearVideoWorkflowDraft,
  readVideoWorkflowDraft,
  videoWorkflowImageRequestFields,
  generatedVideoPreviewBlob,
  VIDEO_WORKFLOW_DRAFT_EVENT,
  type VideoWorkflowImageMode,
  type VideoWorkflowDraft,
} from "@/lib/video-workflow-draft";

import { generatedImageReferenceUri, parseGeneratedImageReferenceUri, generatedImagePreviewUrl } from "@/lib/generated-image-reference";

const DEFAULT_TASK_COUNT = 3;

function sortImageFiles(files: File[]) {
  return [...files].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
}

/**
 * 上传图片文件到服务器，返回公网可访问的 http/https URL
 *
 * 为什么不用 URL.createObjectURL(blob)？
 * blob: URL 仅在浏览器内有效，提交到后端后传给上游视频API会被拒绝：
 * {"code":"image_must_be_url","message":"图片/参考图仅支持http/https URL"}
 */
interface UploadedVideoReferenceAsset {
  url: string;
  assetRef: string;
  category: "image" | "audio";
}

function createVideoReferenceUploadSession() {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `video_ref_${random.replace(/[^a-zA-Z0-9_-]/gu, "")}`;
}

async function uploadReferenceFile(
  file: File,
  token: string | null,
  category: "image" | "audio",
  uploadSession: string,
): Promise<UploadedVideoReferenceAsset> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);
  formData.append("upload_session", uploadSession);

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch("/api/video/reference-upload", {
    method: "POST",
    headers,
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `上传失败(${resp.status})`);
  }

  const data = await resp.json();
  const url = data.file?.url;
  const assetRef = data.file?.asset_ref;
  if (!url || !assetRef) throw new Error("上传成功但未返回完整素材引用");
  return { url: String(url), assetRef: String(assetRef), category };
}

async function uploadImageFile(file: File, token: string | null, uploadSession: string) {
  return uploadReferenceFile(file, token, "image", uploadSession);
}

async function uploadAudioFile(file: File, token: string | null, uploadSession: string) {
  return uploadReferenceFile(file, token, "audio", uploadSession);
}

async function deleteUploadedReferenceAsset(
  asset: UploadedVideoReferenceAsset,
  token: string | null,
  uploadSession: string,
) {
  if (!token) return false;
  const response = await fetch("/api/video/reference-upload", {
    method: "DELETE",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      asset_ref: asset.assetRef,
      url: asset.url,
      category: asset.category,
      upload_session: uploadSession,
    }),
  });
  return response.ok;
}

/**
 * 将 videoUrl 转换为浏览器可直接播放的 URL
 *
 * 核心策略：统一走 /api/video/proxy?id=xxx 代理路由
 * 原因：上游 CDN（media.veo9.uk / vidgen.x.ai）返回的 MP4 有两个致命问题：
 * 1. moov atom 在文件末尾 → 浏览器必须下载完整文件才能获取时长/seek → 时长0+无法播放
 * 2. 无 CORS 头 → 浏览器 fetch() 跨域失败
 * 代理路由内部智能决策：本地存储/对象存储 → 302重定向，CDN → 流式代理
 */
async function requestVideoAccessUrl(
  taskId: string,
  authToken?: string | null,
  options?: { scope?: "playback" | "download"; filename?: string; forCapture?: boolean; source?: "origin" },
): Promise<string> {
  if (!taskId || !authToken) throw new Error("缺少视频访问凭据");
  const params = new URLSearchParams({
    taskId,
    scope: options?.scope || "playback",
  });
  if (options?.filename) params.set("name", options.filename);
  if (options?.forCapture) params.set("forCapture", "1");
  if (options?.source) params.set("source", options.source);
  const response = await fetch(`/api/video/access-ticket?${params.toString()}`, {
    headers: { Authorization: `Bearer ${authToken}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
  if (!response.ok || !data.url) throw new Error(data.error || "视频访问凭据生成失败");
  return data.url;
}

function PlayableVideo({
  videoUrl,
  taskId,
  token,
  poster,
  className,
  autoPlay = false,
}: {
  videoUrl: string;
  taskId: string;
  storageUrl?: string;
  needsProxy?: boolean;
  token?: string | null;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
}) {
  const [src, setSrc] = useState(videoUrl.includes("media_ticket=") ? videoUrl : "");
  const [usingOrigin, setUsingOrigin] = useState(false);
  const [failed, setFailed] = useState(false);
  const [actualMetadata, setActualMetadata] = useState<{ source: string; taskId: string; duration: string | null } | null>(null);
  const actualDuration = actualMetadata?.source === src && actualMetadata.taskId === taskId ? actualMetadata.duration : null;

  useEffect(() => {
    let active = true;
    setUsingOrigin(false);
    setFailed(false);
    if (!taskId || !token) {
      setSrc(videoUrl.includes("media_ticket=") ? videoUrl : "");
      return () => { active = false; };
    }
    void requestVideoAccessUrl(taskId, token)
      .then((url) => active && setSrc(url))
      .catch(() => active && setFailed(true));
    return () => { active = false; };
  }, [taskId, token, videoUrl]);

  if (!src && !failed) return null;

  return (
    <div className="relative w-full h-full">
      <video
        key={src}
        src={src}
        poster={poster || undefined}
        controls
        autoPlay={autoPlay}
        preload={autoPlay ? "auto" : "metadata"}
        playsInline
        className={className}
        onCanPlay={() => setFailed(false)}
        onLoadedMetadata={(event) => setActualMetadata({ source: src, taskId, duration: formatActualVideoDuration(event.currentTarget.duration) })}
        onError={() => {
          if (usingOrigin || !taskId || !token) {
            setFailed(true);
            return;
          }
          setUsingOrigin(true);
          setFailed(false);
          void requestVideoAccessUrl(taskId, token, { source: "origin" })
            .then(setSrc)
            .catch(() => setFailed(true));
        }}
      />
      {usingOrigin && !failed ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-xs text-white/80 backdrop-blur-sm">
          已切换稳定播放源
        </div>
      ) : null}
      {actualDuration && !failed ? (
        <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-xs text-white/80 backdrop-blur-sm" data-video-actual-duration>
          实际 {actualDuration}
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-center text-sm text-white/85 backdrop-blur-[1px]">
          <AlertCircle className="h-8 w-8 text-amber-300" />
          <span>当前播放源暂不可用，请先下载或稍后重试</span>
        </div>
      ) : null}
    </div>
  );
}

/* ── Video page config ── */
interface VideoPageConfig {
  title: string;
  description: string;
  titleColor: string;
  titleSize: number;
  descColor: string;
  descSize: number;
  titleOffsetY: number;
  descOffsetY: number;
}

const DEFAULT_CONFIG: VideoPageConfig = {
  title: "AI 视频创作台",
  description: "支持多种视频模型 · 智能生成 · 高清输出",
  titleColor: "",
  titleSize: 24,
  descColor: "",
  descSize: 13,
  titleOffsetY: 0,
  descOffsetY: 0,
};

/* ── Task card type ── */
interface VideoHistoryRequestSnapshot {
  schema: "video_generation_request_snapshot.v1";
  userPrompt: string;
  effectivePrompt: string;
  promptNormalizations: Array<{ name: string; applied: boolean; detail?: string }>;
  negativePrompt: string;
  referenceAssets: Array<{
    role: "first_frame" | "last_frame" | "reference_image" | "reference_image_list"
      | "reference_audio" | "reference_audio_list" | "source_video" | "person_asset" | "audio_asset";
    index: number;
    ref: string;
  }>;
  targetDurationSeconds: number;
  effectiveDurationSeconds: number;
  aspectRatio: string;
  resolution: string;
  fps: number | null;
  seed: string | null;
  generateAudio: boolean | null;
  publicModelId: string;
  routingConfigHash: string;
  adapterVersion: string;
  providerPayloadHash: string;
}

interface VideoHistoryRetryInputs {
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  referenceImageUrls: string[];
  audioUrl: string;
  referenceAudioUrls: string[];
  sourceVideoUrl: string;
}

type SnapshotVideoTask = VideoTask & {
  requestSnapshot?: VideoHistoryRequestSnapshot;
  retryInputs?: VideoHistoryRetryInputs;
};

interface TaskCard {
  localId: number;
  prompt: string;
  negativePrompt: string; // 副向提醒/反向提示词
  durationSeconds: number | null; // null 表示跟随顶部默认镜头时长
  aspectRatio?: string;
  resolution?: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  referenceImageUrls: string[];
  referenceAudioUrls: string[];
  sourceVideoUrl: string; // 视频编辑模型的源视频URL
  audioUrl?: string;
  fps?: number;
  seed?: string;
  generateAudio?: boolean;
  uploadedReferenceAssets: UploadedVideoReferenceAsset[];
  requestSnapshot?: VideoHistoryRequestSnapshot;
  followsSourceDuration?: boolean;
  status: "idle" | "pending" | "queued" | "processing" | "generating" | "finalizing" | "completed" | "failed" | "cancelled";
  processingStage?: string;
  clientRequestId?: string; // 所有付费视频通道的幂等键；网络/5xx 重试必须复用
  clientRequestFingerprint?: string;
  taskId: string;
  /** Only set from the server's business_task_id for this exact submission. */
  businessTaskId?: string;
  modelId: string;
  modelName?: string;
  modelSnapshot?: VideoModel;
  supportsRemoteCancel?: boolean;
  contentUrl: string;
  videoUrl: string;
  storageUrl: string;
  thumbnailUrl: string;
  needsProxy: boolean; // /content URL需要服务端代理播放
  errorMessage: string;
  submittedAt?: number; // timestamp when submitted
  pollStuckCount?: number; // 连续轮询无进展计数
  lastProgress?: number; // 上次轮询的progress值
  progress?: number; // 上游真实进度(0-100)
  statusDetail?: string; // 上游公开状态或本地追踪说明
  mediaAvailable?: boolean;
  mediaUnavailableReason?: string;
  priceCharged?: number;
  billingState?: string;
  lastSyncedAt?: number; // 后台 worker 最近一次真实查询上游的时间
  providerPollFailures?: number;
  cardIndex: number; // 卡片序号（任务1、任务2...）
  batchId: string;   // 批次ID
  taskLabel?: string; // 卡片标签（如"段落1"）
  theme?: string;   // 段落主题（从【】提取）
  batchTopic: string; // 批次主题/文案名称
}

function submittedBusinessTaskId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/u.test(value) ? value : undefined;
}

function videoCacheSubmissionBinding(task: Pick<TaskCard, "clientRequestId">, requestId: string, value: unknown): string | undefined {
  return requestId && task.clientRequestId === requestId ? submittedBusinessTaskId(value) : undefined;
}

/** The active-tasks endpoint returns its database id in both fields. */
function recoveredVideoBusinessTaskId(row: Record<string, unknown>): string | undefined {
  return typeof row.id === "string" && row.id === row.taskId ? submittedBusinessTaskId(row.id) : undefined;
}

type AutoCachePageScope = { cache: VideoLocalAutoCache; attempted: Set<string>; active: boolean };

/** Local copies are best-effort and independent of the server's delivery. */
function useVideoAutomaticLocalCache(userId: string, token: string | null | undefined, tasks: TaskCard[]) {
  const scopeRef = useRef<AutoCachePageScope | null>(null);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [removalWarning, setRemovalWarning] = useState("");
  useLayoutEffect(() => {
    setFailedIds([]);
    setRemovalWarning("");
    if (!userId || !token) return;
    let scope: AutoCachePageScope;
    try {
      const cache = new VideoLocalAutoCache({ userId, token, surface: "video-page", onRemovalSyncFailure: () => {
        if (scopeRef.current === scope && scope.active) setRemovalWarning("历史已移除，但本机副本清理未完成，请在作品历史中重试。");
      } });
      scope = { cache, attempted: new Set(), active: true };
      scopeRef.current = scope;
    } catch {
      // The browser may not support private cache storage. Report only if a
      // completed task actually needs a local copy, below.
      scopeRef.current = null;
      return;
    }
    return () => { scope.active = false; scope.cache.dispose(); if (scopeRef.current === scope) scopeRef.current = null; };
  }, [userId, token]);

  const enqueue = useCallback((id: string, retry = false) => {
    const scope = scopeRef.current;
    if (!scope || !scope.active) { setFailedIds(previous => previous.includes(id) ? previous : [...previous, id]); return; }
    if (scope.attempted.has(id) && !retry) return;
    scope.attempted.add(id);
    setFailedIds(previous => previous.filter(value => value !== id));
    void scope.cache.enqueue(id).then((result: AutoCacheResult) => {
      if (!scope.active || scopeRef.current !== scope) return;
      if (result.state === "saved" || result.state === "removed" || result.state === "cancelled") return;
      setFailedIds(previous => previous.includes(id) ? previous : [...previous, id]);
    }).catch(() => {
      if (scope.active && scopeRef.current === scope) setFailedIds(previous => previous.includes(id) ? previous : [...previous, id]);
    });
  }, []);

  useEffect(() => {
    if (!token) return;
    for (const task of tasks) {
      if (task.status === "completed" && task.businessTaskId) enqueue(task.businessTaskId);
    }
  }, [tasks, token, enqueue]);

  const retry = useCallback(() => { for (const id of failedIds) enqueue(id, true); }, [enqueue, failedIds]);
  const onHistoryCleared = useCallback((ids: string[]) => {
    const scope = scopeRef.current;
    setFailedIds(previous => previous.filter(id => !ids.includes(id)));
    if (!scope?.active) return;
    void scope.cache.applyTombstones(ids).then(ok => {
      if (!ok && scope.active && scopeRef.current === scope) setRemovalWarning("历史已移除，但本机副本清理未完成，请在作品历史中重试。");
    }).catch(() => { if (scope.active && scopeRef.current === scope) setRemovalWarning("历史已移除，但本机副本清理未完成，请在作品历史中重试。"); });
  }, []);
  return { failedCount: failedIds.length, removalWarning, retry, onHistoryCleared };
}

const emptyCard = (localId: number, cardIndex: number, batchId: string, batchTopic: string): TaskCard => ({
  localId,
  prompt: "",
  negativePrompt: "",
  durationSeconds: null,
  firstFrameUrl: "",
  lastFrameUrl: "",
  referenceImageUrl: "",
  referenceImageUrls: [],
  referenceAudioUrls: [],
  sourceVideoUrl: "",
  uploadedReferenceAssets: [],
  status: "idle",
  clientRequestId: "",
  clientRequestFingerprint: "",
  taskId: "",
  modelId: "",
  contentUrl: "",
  videoUrl: "",
  storageUrl: "",
  thumbnailUrl: "",
  needsProxy: false,
  errorMessage: "",
  cardIndex,
  batchId,
  batchTopic,
});

function hasExistingVideoWork(task: TaskCard): boolean {
  return task.status !== "idle" || Boolean(
    task.prompt?.trim() || task.negativePrompt?.trim() || task.firstFrameUrl || task.lastFrameUrl
    || task.referenceImageUrl || task.referenceImageUrls?.length || task.referenceAudioUrls?.length
    || task.sourceVideoUrl || task.audioUrl || task.uploadedReferenceAssets?.length
    || task.taskId || task.clientRequestId || task.requestSnapshot || task.modelId
    || task.aspectRatio || task.resolution || task.fps !== undefined || task.seed !== undefined
    || task.durationSeconds != null || task.generateAudio !== undefined || task.followsSourceDuration
    || task.batchTopic?.trim() || task.taskLabel?.trim() || task.theme?.trim(),
  );
}

function taskImageInputs(
  task: TaskCard,
  capabilities: ReturnType<typeof getAiVideoPageInputCapabilities>,
) {
  return [
    ...(capabilities.showFirstFrame ? [task.firstFrameUrl] : []),
    ...(capabilities.showLastFrame ? [task.lastFrameUrl] : []),
    ...(capabilities.showReferenceImages
      ? [task.referenceImageUrl, ...(task.referenceImageUrls || [])]
      : []),
  ];
}

const ACTIVE_VIDEO_TASK_STATUSES: TaskCard["status"][] = ["pending", "queued", "processing", "generating", "finalizing"];

function videoClientAttemptScope(userId: string, task: TaskCard) {
  return `video-page:${userId}:${task.batchId}:${task.localId}`;
}

function isActiveVideoTaskStatus(status: TaskCard["status"]) {
  return ACTIVE_VIDEO_TASK_STATUSES.includes(status);
}

type VideoPageModel = VideoModel & {
  durationBehavior?: VideoDurationBehavior;
  available: boolean;
  priceReady: boolean;
  generationReady: boolean;
  readinessMessage: string;
  availabilityMessage: string;
  compatibilityCode: string;
  capabilitiesVerified: boolean;
  firstFrameRatioPolicy?: "adaptive";
};

function normalizePublicVideoModel(value: unknown): VideoPageModel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const capabilities = record.capabilities && typeof record.capabilities === "object"
    ? record.capabilities as Record<string, unknown>
    : {};
  const id = String(record.id || "").trim();
  if (!id) return null;
  const name = String(record.displayName || record.name || "视频模型").trim();
  const durationSource = { ...record, ...capabilities };
  const durationCapabilities = getVideoDurationCapabilities(durationSource);
  const resolutionCapabilities = getVideoResolutionCapabilities(record);
  const defaultResolution = getAiVideoPageDefaultResolution(record);
  return {
    id,
    name,
    displayName: name,
    variantLabel: String(record.variantLabel || ""),
    avatarUrl: String(record.avatarUrl || ""),
    provider: String(record.provider || ""),
    protocolType: String(record.protocolType || ""),
    pricePerUse: Number(record.publicPrice ?? record.pricePerUse ?? 0) || 0,
    currency: "CNY",
    durationSeconds: durationCapabilities.defaultDuration,
    minDuration: durationCapabilities.minDuration,
    maxDuration: durationCapabilities.maxDuration,
    durationMode: durationCapabilities.mode,
    nativeDurations: durationCapabilities.nativeDurations,
    durationBehavior: readVideoDurationBehavior(capabilities.durationBehavior),
    durationStep: Number(capabilities.durationStep) || 0.5,
    supportsImageInput: Boolean(capabilities.supportsImageInput ?? record.supportsImageInput),
    requiresImage: Boolean(capabilities.requiresImage ?? record.requiresImage),
    supportsSourceVideoInput: Boolean(capabilities.supportsSourceVideoInput ?? record.supportsSourceVideoInput),
    requiresSourceVideo: Boolean(capabilities.requiresSourceVideo ?? record.requiresSourceVideo),
    resolutionTier: defaultResolution,
    resolutionOptions: resolutionCapabilities.options,
    defaultResolution,
    resolutionLabels: Object.entries(resolutionCapabilities.labels).map(([value, label]) => `${value}=${label}`),
    directVerifiedCombinations: Array.isArray(capabilities.directVerifiedCombinations)
      ? capabilities.directVerifiedCombinations.map(String)
      : [],
    verificationNotice: String(capabilities.verificationNotice || ""),
    resolutionPrices: resolutionCapabilities.publicPrices,
    maxReferenceImages: Number.isFinite(Number(capabilities.maxReferenceImages))
      ? Math.max(0, Number(capabilities.maxReferenceImages))
      : (Boolean(capabilities.supportsImageInput ?? record.supportsImageInput) ? 1 : 0),
    minReferenceImages: Math.max(0, Number(capabilities.minReferenceImages) || 0),
    workflowInputMode: String(capabilities.workflowInputMode || "") as VideoModel["workflowInputMode"],
    supportsPrompt: capabilities.supportsPrompt !== false,
    requiresFirstFrame: capabilities.requiresFirstFrame === true,
    requiresLastFrame: capabilities.requiresLastFrame === true,
    showFirstFrame: capabilities.showFirstFrame === true,
    showLastFrame: capabilities.showLastFrame === true,
    showReferenceImages: capabilities.showReferenceImages === true,
    showAudioInputs: capabilities.showAudioInputs === true,
    supportsAudioInput: capabilities.supportsAudioInput === true,
    maxReferenceAudios: Math.max(0, Number(capabilities.maxReferenceAudios) || 0),
    minReferenceAudios: Math.max(0, Number(capabilities.minReferenceAudios) || 0),
    billingUnit: getVideoBillingUnit(record),
    tokenPricing: readVideoTokenPublicPricing(record.tokenPricing),
    workspaceSurfaces: Array.isArray(capabilities.workspaceSurfaces)
      ? capabilities.workspaceSurfaces.map(String)
      : ["ai-video"],
    supportsRemoteCancel: capabilities.supportsRemoteCancel === true,
    supportsGenerateAudioToggle: capabilities.supportsGenerateAudioToggle === true,
    aspectRatios: Array.isArray(capabilities.aspectRatios)
      ? capabilities.aspectRatios.map(String)
      : [],
    capabilitiesVerified: capabilities.capabilitiesVerified !== false,
    firstFrameRatioPolicy: capabilities.firstFrameRatioPolicy === "adaptive" ? "adaptive" : undefined,
    compatibilityCode: publicVideoModelCompatibilityCode(capabilities.compatibilityCode),
    available: capabilities.available !== false,
    priceReady: capabilities.priceReady !== false,
    generationReady: capabilities.generationReady !== false,
    readinessMessage: String(capabilities.readinessMessage || ""),
    availabilityMessage: String(capabilities.availabilityMessage || ""),
    isActive: true,
    sortOrder: 0,
    createdAt: "",
  };
}

/* ── Smart import parsed segment type ── */
interface ParsedSegment {
  prompt: string;          // 主提示词
  negativePrompt: string;  // 副向提醒/反向提示词
  camera: string;          // 镜头说明
  duration: number | null; // 总时长（秒）
  theme: string;           // 段落主题（从【】提取）
}

const VIDEO_SELECTED_MODEL_PREFERENCE_KEY = "ai-video:selected-model:v1";

export default function VideoPage() {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <main className="min-h-screen bg-[var(--background)] p-8 text-center"><h1 className="text-xl font-semibold">AI 视频创作台</h1><p className="mt-6">请登录后使用视频创作台</p><a href="/" className="mt-4 inline-block text-[var(--primary)] underline">返回主页登录</a></main>;
  return <UserVideoPage key={identity.userId} identity={identity} />;
}

function UserVideoPage({ identity }: { identity: WorkbenchIdentity }) {
  const router = useAppScopedRouter();
  const { state, dispatch } = useApp();
  const auth = state.auth;
  const isAdmin = auth?.user?.role === "admin";
  const currentMode = state.mode;
  const currentTheme = state.theme;

  const [models, setModels] = useState<VideoPageModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsLoadError, setModelsLoadError] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(() => {
    try {
      return localStorage.getItem(workbenchUserStorageKey(VIDEO_SELECTED_MODEL_PREFERENCE_KEY, identity.userId))?.trim() || "";
    } catch {
      return "";
    }
  });
  const [historyRetryNotice, setHistoryRetryNotice] = useState("");
  const [cashBalance, setCashBalance] = useState(0);
  const [tokenChargeConsent, setTokenChargeConsent] = useState<{ modelId: string; priceVersion: string; amount: string } | null>(null);
  const [cashRechargeOpen, setCashRechargeOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<(typeof AI_VIDEO_PAGE_ASPECT_RATIOS)[number]>(AI_VIDEO_PAGE_ASPECT_RATIOS[0]);
  const [duration, setDuration] = useState(8);
  const [resolution, setResolution] = useState("");
  const [referenceUploadSession] = useState(createVideoReferenceUploadSession);
  const initialBatchSeed = useId().replace(/[^a-zA-Z0-9_-]/g, "") || "initial";
  const [currentBatchId, setCurrentBatchId] = useState(`batch_ui_${initialBatchSeed}`);
  // 初始化：默认 3 张空白卡片，刷新即清空
  const [tasks, setTasks] = useState<TaskCard[]>(() => [
    emptyCard(1, 1, currentBatchId, ""),
    emptyCard(2, 2, currentBatchId, ""),
    emptyCard(3, 3, currentBatchId, ""),
  ]);
  const localVideoCache = useVideoAutomaticLocalCache(identity.userId, auth?.token, tasks);
  const submissionLocksRef = useRef(new Set<number>());
  useEffect(() => {
    try {
      clearRetiredPageDrafts('video', identity.userId, localStorage, sessionStorage);
      clearLegacyVideoTaskTransfer();
      clearLegacyVideoWorkflowDraft();
    } catch {}
  }, [identity.userId]);
  useEffect(() => {
    if (!selectedModelId) return;
    try {
      localStorage.setItem(workbenchUserStorageKey(VIDEO_SELECTED_MODEL_PREFERENCE_KEY, identity.userId), selectedModelId);
    } catch {}
  }, [identity.userId, selectedModelId]);
  const completedTaskBalanceKey = tasks.filter(task => task.status === 'completed').map(task => task.taskId).sort().join('|');
  useEffect(() => {
    if (!completedTaskBalanceKey || !auth?.token) return;
    const controller = new AbortController();
    fetch('/api/cash/balance', { headers: { Authorization: 'Bearer ' + auth.token }, signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(balance => { if (!controller.signal.aborted && typeof balance?.balance === 'number') setCashBalance(balance.balance); })
      .catch(() => {});
    return () => controller.abort();
  }, [completedTaskBalanceKey, auth?.token]);
  const tasksRef = useRef(tasks);
  const authTokenRef = useRef(auth?.token || null);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    authTokenRef.current = auth?.token || null;
  }, [auth?.token]);

  const releaseReferenceAssets = useCallback((assets: UploadedVideoReferenceAsset[]) => {
    const token = authTokenRef.current;
    for (const asset of assets) {
      void deleteUploadedReferenceAsset(asset, token, referenceUploadSession).catch(() => false);
    }
  }, [referenceUploadSession]);
  const orderedImageInputRef = useRef<HTMLInputElement | null>(null);
  const [orderedImageMode, setOrderedImageMode] = useState<VideoWorkflowImageMode>("reference");
  const [isImportingOrderedImages, setIsImportingOrderedImages] = useState(false);
  const [inputImagePreview, setInputImagePreview] = useState<{ src: string; alt: string } | null>(null);
  const generatedPreviewCache = useRef(new Map<string, string>());
  const generatedPreviewOwner = useRef("");
  const [generatedPreviews, setGeneratedPreviews] = useState<Record<string, string>>({});
  const generatedPreviewKey = JSON.stringify([...new Set(tasks.flatMap(task => [task.firstFrameUrl, task.lastFrameUrl, task.referenceImageUrl, ...(task.referenceImageUrls || [])]).filter(url => Boolean(parseGeneratedImageReferenceUri(url))))].sort());
  useEffect(() => {
    const controller = new AbortController();
    const owner = `${identity.userId}:${auth?.token || ""}`;
    if (generatedPreviewOwner.current !== owner) {
      for (const url of generatedPreviewCache.current.values()) URL.revokeObjectURL(url);
      generatedPreviewCache.current.clear();
      generatedPreviewOwner.current = owner;
      setInputImagePreview(null);
    }
    const inputs: string[] = JSON.parse(generatedPreviewKey);
    for (const [uri, blobUrl] of generatedPreviewCache.current) {
      if (!inputs.includes(uri)) { URL.revokeObjectURL(blobUrl); generatedPreviewCache.current.delete(uri); }
    }
    setGeneratedPreviews(Object.fromEntries(generatedPreviewCache.current));
    if (auth?.token) for (const uri of inputs) {
      if (generatedPreviewCache.current.has(uri)) continue;
      const reference = parseGeneratedImageReferenceUri(uri)!;
      void fetch(generatedImagePreviewUrl(reference), { headers: { Authorization: `Bearer ${auth.token}` }, signal: controller.signal, cache: "no-store", redirect: "error" })
        .then(async response => {
          if (!response.ok) throw new Error("生成图片预览暂不可用");
          const blob = await generatedVideoPreviewBlob(await response.blob(), reference);
          if (controller.signal.aborted) return;
          const blobUrl = URL.createObjectURL(blob);
          generatedPreviewCache.current.set(uri, blobUrl);
          setGeneratedPreviews(Object.fromEntries(generatedPreviewCache.current));
        }).catch(() => { /* Owner/expiry is checked again before a paid submission. */ });
    }
    return () => controller.abort();
  }, [generatedPreviewKey, auth?.token, identity.userId]);
  useEffect(() => {
    const cache = generatedPreviewCache.current;
    return () => { for (const url of cache.values()) URL.revokeObjectURL(url); cache.clear(); };
  }, []);
  const videoInputPreview = (url: string | undefined) => parseGeneratedImageReferenceUri(url) ? generatedPreviews[url!] || undefined : url;
  const [showHistory, setShowHistory] = useState(false);
  const [historyRecoveryOpen, setHistoryRecoveryOpen] = useState(false);
  const historyRecoveryActiveRef = useRef(false);
  const [history, setHistory] = useState<VideoTask[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [taskRecoveryError, setTaskRecoveryError] = useState("");
  const [taskRecoveryNotice, setTaskRecoveryNotice] = useState("");
  const [taskRecoveryAttempt, setTaskRecoveryAttempt] = useState(0);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null);
  const historyOffsetRef = useRef(0);
  const historyWindowRef = useRef(100);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyRequestPurposeRef = useRef<"panel" | "reconcile" | null>(null);
  const cancelPanelHistoryRequest = useCallback(() => {
    if (historyRequestPurposeRef.current !== "panel") return;
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    historyRequestPurposeRef.current = null;
    setHistoryLoading(false);
  }, []);
  const handleHistoryRecoveryToggle = useCallback((open: boolean) => {
    historyRecoveryActiveRef.current = open;
    setHistoryRecoveryOpen(open);
    if (!open) cancelPanelHistoryRequest();
  }, [cancelPanelHistoryRequest]);
  const closeUnifiedHistory = useCallback(() => {
    handleHistoryRecoveryToggle(false);
    setShowHistory(false);
  }, [handleHistoryRecoveryToggle]);
  const nextLocalId = useRef(Math.max(4, ...tasks.map(task => task.localId + 1)));
  const sseRefs = useRef<Map<string, { abortController: AbortController }>>(new Map());
  const reconnectRef = useRef(0); // SSE 重连计数器
  /* ── Track cancelled task IDs to stop polling immediately ── */
  const cancelledRef = useRef<Set<number>>(new Set());
  // 上游明确要求重试时，每张卡片最多自动补偿一次；避免瞬时故障让用户手动逐个重提。
  const summaryToastKeyRef = useRef("");

  useEffect(() => {
    if (!inputImagePreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInputImagePreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [inputImagePreview]);

  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map()); // taskId → reconnect timer
  /* ── Auto-extract video thumbnail when completed ── */
  const thumbCacheRef = useRef<Map<string, string>>(new Map()); // taskId → blob URL
  const thumbnailRequestsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    tasks.forEach((task) => {
      if (task.status !== "completed" || (!task.videoUrl && !task.storageUrl) || task.thumbnailUrl) return;
      if (thumbCacheRef.current.has(task.taskId)) return;
      if (thumbnailRequestsRef.current.has(task.taskId)) return;
      if (!auth?.token) return;
      thumbnailRequestsRef.current.add(task.taskId);
      void requestVideoAccessUrl(task.taskId, auth.token, { forCapture: true })
        .then((playableUrl) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous"; // 走代理（同源），canvas 可正常 toBlob
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      const cleanup = () => {
        thumbnailRequestsRef.current.delete(task.taskId);
        video.src = "";
        video.load();
      };
      const onLoaded = () => {
        // Seek to 0.5s for a better frame
        video.currentTime = 0.5;
      };
      const onSeeked = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => {
              if (blob) {
                const blobUrl = URL.createObjectURL(blob);
                thumbCacheRef.current.set(task.taskId, blobUrl);
                setTasks((prev) =>
                  prev.map((t) =>
                    t.taskId === task.taskId ? { ...t, thumbnailUrl: blobUrl } : t
                  )
                );
              }
              cleanup();
            }, "image/jpeg", 0.8);
          } else { cleanup(); }
        } catch {
          // canvas tainted（跨域视频）或浏览器限制 — 静默跳过
          cleanup();
        }
      };
      const onError = () => { cleanup(); };
      video.addEventListener("loadeddata", onLoaded);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      video.src = playableUrl;
        })
        .catch(() => thumbnailRequestsRef.current.delete(task.taskId));
    });
  }, [auth?.token, tasks]);

  /* ── Real-time elapsed timer — 每秒刷新等待时间显示 ── */
  const [nowTick, setNowTick] = useState(0);
  const hasActiveTask = tasks.some((task) => isActiveVideoTaskStatus(task.status));
  useEffect(() => {
    if (!hasActiveTask) return;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveTask]);

  /* ── Batch state ── */
  const [batchTopic, setBatchTopic] = useState("");
  const currentCardCounter = useRef(DEFAULT_TASK_COUNT + 1);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  /* ── Smart import state ── */
  const [showSmartImport, setShowSmartImport] = useState(false);
  const [cardAction, setCardAction] = useState<{ kind: "clear" | "remove-all" | "remove-one"; localId?: number; targetIds?: number[] } | null>(null);
  const [smartImportText, setSmartImportText] = useState("");

  const applyIncomingVideoTaskTransfer = useCallback((payload: VideoTaskTransferPayload | null | undefined) => {
    if (payload?.ownerUserId !== identity.userId || tasksRef.current.some(requiresVideoTaskTracking)) return false;
    const items = (payload?.items || [])
      .filter((item) => (item.prompt && item.prompt.trim()) || item.imageUrl)
      .sort((a, b) => a.order - b.order);
    if (items.length === 0) return false;

    const maxOrder = Math.max(DEFAULT_TASK_COUNT, ...items.map((item) => Math.max(1, item.order || 1)));
    setTasks((prev) => {
      const base = [...prev];

      while (base.length < maxOrder) {
        base.push(emptyCard(nextLocalId.current++, base.length + 1, currentBatchId, batchTopic));
      }

      for (const item of items) {
        const index = Math.max(0, Math.min(base.length - 1, (item.order || 1) - 1));
        const current = base[index] || emptyCard(nextLocalId.current++, index + 1, currentBatchId, batchTopic);
        base[index] = {
          ...current,
          prompt: item.prompt?.trim() || current.prompt,
          referenceImageUrl: item.imageUrl || current.referenceImageUrl,
          taskLabel: item.label || current.taskLabel || `任务${index + 1}`,
          theme: item.title || current.theme,
        };
      }

      return base.map((task, index) => ({
        ...task,
        cardIndex: index + 1,
        taskLabel: task.taskLabel || `任务${index + 1}`,
      }));
    });

    setSmartImportText("");
    setShowSmartImport(false);
    toast.success(`已填入 ${items.length} 条提示词到视频任务卡片`);
    return true;
  }, [batchTopic, currentBatchId, identity.userId]);

  // 同标签页临时交接：读取成功后立即删除，刷新页面不会恢复未提交内容。
  const applyVideoWorkflowDraft = useCallback((draft: VideoWorkflowDraft | null) => {
    if (draft?.ownerUserId !== identity.userId || !draft.slots.length || tasksRef.current.some(requiresVideoTaskTracking)) return false;
    const maxOrder = Math.max(DEFAULT_TASK_COUNT, ...draft.slots.map((slot) => slot.order));
    setTasks((prev) => {
      const base = [...prev];
      while (base.length < maxOrder) {
        base.push(emptyCard(nextLocalId.current++, base.length + 1, currentBatchId, batchTopic));
      }
      for (const slot of draft.slots) {
        const index = slot.order - 1;
        const current = base[index];
        base[index] = {
          ...current,
          prompt: slot.prompt || current.prompt,
          referenceImageUrl: slot.referenceImageRef ? generatedImageReferenceUri(slot.referenceImageRef) : slot.referenceImageUrl || current.referenceImageUrl,
          firstFrameUrl: slot.firstFrameImageRef ? generatedImageReferenceUri(slot.firstFrameImageRef) : slot.firstFrameUrl || current.firstFrameUrl,
          lastFrameUrl: slot.lastFrameImageRef ? generatedImageReferenceUri(slot.lastFrameImageRef) : slot.lastFrameUrl || current.lastFrameUrl,
          taskLabel: slot.label || current.taskLabel || `任务${slot.order}`,
          theme: slot.title || current.theme,
        };
      }
      return base.map((task, index) => ({ ...task, cardIndex: index + 1 }));
    });
    return true;
  }, [batchTopic, currentBatchId, identity.userId]);

  useEffect(() => {
    const consumeWorkflowDraft = () => {
      const draft = readVideoWorkflowDraft();
      if (!applyVideoWorkflowDraft(draft)) return false;
      clearVideoWorkflowDraft();
      return true;
    };
    const consumePendingTransfer = () => {
      const pending = readPendingVideoTaskTransfer();
      if (applyIncomingVideoTaskTransfer(pending)) {
        clearPendingVideoTaskTransfer();
        return true;
      }
      return false;
    };

    // 普通进入视频页不恢复旧工作流；只有带 workflow 参数的明确推送才在首屏恢复。
    if (new URLSearchParams(window.location.search).has("workflow")) {
      consumeWorkflowDraft();
      const consumedUrl = new URL(window.location.href);
      consumedUrl.searchParams.delete("workflow");
      window.history.replaceState(null, "", consumedUrl.pathname + consumedUrl.search + consumedUrl.hash);
    }
    consumePendingTransfer();

    const handleTransferEvent = (event: Event) => {
      const payload = (event as CustomEvent<VideoTaskTransferPayload>).detail;
      if (applyIncomingVideoTaskTransfer(payload)) {
        clearPendingVideoTaskTransfer();
      }
    };

    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        consumePendingTransfer();
      }
    };

    const handleWorkflowEvent = () => {
      consumeWorkflowDraft();
    };

    window.addEventListener(VIDEO_TASK_TRANSFER_EVENT, handleTransferEvent);
    window.addEventListener(VIDEO_WORKFLOW_DRAFT_EVENT, handleWorkflowEvent);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener(VIDEO_TASK_TRANSFER_EVENT, handleTransferEvent);
      window.removeEventListener(VIDEO_WORKFLOW_DRAFT_EVENT, handleWorkflowEvent);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [applyIncomingVideoTaskTransfer, applyVideoWorkflowDraft]);

  /* ── 刷新即清空：不做任何缓存持久化 ── */

  /* ── Page config ── */
  const [pageConfig, setPageConfig] = useState<VideoPageConfig>(DEFAULT_CONFIG);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [editingField, setEditingField] = useState<"title" | "description" | null>(null);
  const [editText, setEditText] = useState("");

  /* ── Batch selection ── */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);

  /* ── Inline video playback (history) ── */
  const [playingTaskId, setPlayingTaskId] = useState<string | null>(null);

  /* ── Chat assistant state (NOT persisted — fresh each visit) ── */
  /* ── Load page config ── */
  useEffect(() => {
    fetch("/api/settings/video-page")
      .then((r) => r.json())
      .then((data) => {
        if (data.config) {
          setPageConfig({ ...DEFAULT_CONFIG, ...data.config });
        }
      })
      .catch(() => {});
  }, []);

  /* ── Video history loaded on-demand from DB (history tab) ── */

  /* ── Save page config ── */
  const saveConfig = useCallback(async (config: VideoPageConfig) => {
    if (!auth?.token) return;
    try {
      await fetch("/api/settings/video-page", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ config }),
      });
    } catch {
      // silent
    }
  }, [auth?.token]);

  /* ── Update config field with auto-save ── */
  const updateConfig = useCallback((partial: Partial<VideoPageConfig>) => {
    setPageConfig((prev) => {
      const next = { ...prev, ...partial };
      if (isAdmin) saveConfig(next);
      return next;
    });
  }, [isAdmin, saveConfig]);

  /* ── Start editing title/description ── */
  const startEdit = (field: "title" | "description") => {
    if (!isAdmin) return;
    setEditingField(field);
    setEditText(field === "title" ? pageConfig.title : pageConfig.description);
  };

  const finishEdit = () => {
    if (editingField === "title") {
      updateConfig({ title: editText });
    } else if (editingField === "description") {
      updateConfig({ description: editText });
    }
    setEditingField(null);
    setEditText("");
  };

  /* ── Load models, notifications & cash balance ── */
  useEffect(() => {
    setModelsLoading(true);
    setModelsLoadError("");
    fetch("/api/video/models?surface=video-page")
      .then((r) => {
        if (!r.ok) throw new Error("视频模型目录暂时无法读取");
        return r.json();
      })
      .then((data) => {
        const rawModels: unknown[] = Array.isArray(data.models) ? data.models : [];
        const list = rawModels
          .map(normalizePublicVideoModel)
          .filter((model): model is VideoPageModel => Boolean(model));
        setModels(list);
        setSelectedModelId((currentId) => reconcileVideoModelSelection(currentId, list));
      })
      .catch(() => setModelsLoadError("视频模型目录加载失败，请刷新页面重试"))
      .finally(() => setModelsLoading(false));
    if (auth?.token) {
      fetch("/api/cash/balance", {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
        .then((r) => r.json())
        .then((data) => {
          setCashBalance(data.balance ?? 0);
        })
        .catch(() => {});
    }
  }, [auth?.token]);

  /* ── Recover only server-owned active jobs after refresh ── */
  useEffect(() => {
    if (!auth?.token || modelsLoading) return;
    const controller = new AbortController();
    setTaskRecoveryError("");
    setTaskRecoveryNotice("");
    void fetch("/api/video/active-tasks", {
      headers: { Authorization: `Bearer ${auth.token}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(response.status === 401
            ? "登录已过期，请重新登录"
            : String(payload.error || "活动任务暂时无法同步"));
        }
        return payload;
      })
      .then((payload: unknown) => {
        if (controller.signal.aborted) return;
        const rows = payload && typeof payload === "object" && Array.isArray((payload as { activeTasks?: unknown[] }).activeTasks)
          ? (payload as { activeTasks: unknown[] }).activeTasks
          : [];
        const recovered = rows.flatMap((value, index): TaskCard[] => {
          if (!value || typeof value !== "object") return [];
          const row = value as Record<string, unknown>;
          const status = String(row.status || "") as TaskCard["status"];
          const taskId = String(row.taskId || row.id || "").trim();
          const modelId = String(row.modelId || "").trim();
          if (!taskId || !modelId || !isActiveVideoTaskStatus(status)) return [];
          const model = models.find((item) => item.id === modelId);
          const createdAt = Date.parse(String(row.createdAt || ""));
          const providerLastPolledAt = Date.parse(String(row.providerLastPolledAt || ""));
          const durationSeconds = Number(row.durationSeconds);
          const providerProgress = Number(row.progress);
          return [{
            ...emptyCard(
              nextLocalId.current++,
              Math.max(1, Number(row.cardIndex) || index + 1),
              String(row.batchId || `recovered_${taskId}`),
              String(row.batchTopic || ""),
            ),
            prompt: String(row.prompt || ""),
            durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
            aspectRatio: String(row.aspectRatio || "") || undefined,
            resolution: String(row.resolution || "") || undefined,
            firstFrameUrl: String(row.firstFrameUrl || ""),
            lastFrameUrl: String(row.lastFrameUrl || ""),
            referenceImageUrl: String(row.referenceImageUrl || ""),
            status,
            taskId,
            businessTaskId: recoveredVideoBusinessTaskId(row),
            modelId,
            modelName: model?.name || "提交时所选模型",
            modelSnapshot: model,
            supportsRemoteCancel: model?.supportsRemoteCancel === true,
            taskLabel: String(row.taskLabel || ""),
            submittedAt: Number.isFinite(createdAt) ? createdAt : undefined,
            progress: Number.isFinite(providerProgress) ? providerProgress : undefined,
            statusDetail: String(row.providerStatusMessage || "") || undefined,
            lastSyncedAt: Number.isFinite(providerLastPolledAt) ? providerLastPolledAt : undefined,
            providerPollFailures: Math.max(0, Number(row.providerPollFailures) || 0),
          }];
        });
        if (recovered.length === 0) return;
        setTasks((current) => {
          const knownTaskIds = new Set(current.map((task) => task.taskId).filter(Boolean));
          const missing = recovered.filter((task) => !knownTaskIds.has(task.taskId));
          if (missing.length === 0) return current;
          const tracked = current.filter((task) => Boolean(task.taskId));
          const editors = current.filter((task) => !task.taskId);
          const hasEditedInput = editors.some((task) => Boolean(
            task.prompt.trim()
            || task.firstFrameUrl
            || task.lastFrameUrl
            || task.referenceImageUrl
            || task.referenceImageUrls.length
            || task.referenceAudioUrls.length
            || task.sourceVideoUrl,
          ));
          const retainedEditors = hasEditedInput
            ? editors
            : [emptyCard(nextLocalId.current++, 1, `batch_${Date.now()}`, "")];
          return [...missing, ...tracked, ...retainedEditors];
        });
        setTaskRecoveryNotice(`已同步 ${recovered.length} 个进行中的任务；页面只继续查询原任务，不会重新提交或重复计费。`);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTaskRecoveryError(error instanceof Error ? error.message : "活动任务暂时无法同步");
      });
    return () => controller.abort();
  }, [auth?.token, models, modelsLoading, taskRecoveryAttempt]);

  /* ── Load history ── */
  const loadHistory = useCallback((
    offset = historyOffsetRef.current,
    options: { supersedeInFlight?: boolean; purpose?: "panel" | "reconcile" } = {},
  ) => {
    // This callback is also used by SSE/task transitions to reconcile the
    // editor's model and remote-cancel metadata. Only panel-driven polling is
    // gated below; event-driven reconciliation must remain available.
    if (!auth?.token) return;
    const purpose = options.purpose || "reconcile";
    if (purpose === "panel" && !historyRecoveryActiveRef.current) return;
    if (historyRequestRef.current) {
      // A manual refresh or poll in the recovery view must not cancel a task
      // status reconciliation that is already updating the editor.
      if (purpose === "panel" && historyRequestPurposeRef.current === "reconcile") return;
      if (!options.supersedeInFlight) return;
      historyRequestRef.current.abort();
      historyRequestRef.current = null;
      historyRequestPurposeRef.current = null;
    }
    const controller = new AbortController();
    historyRequestRef.current = controller;
    historyRequestPurposeRef.current = purpose;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    setHistoryLoading(true);
    setHistoryError("");
    const targetWindow = offset === 0 ? Math.max(100, historyWindowRef.current) : 100;
    void (async () => {
      const collected: VideoTask[] = [];
      let cursor: number | null = offset;
      do {
        const response: Response = await fetch(`/api/video/history?surface=video-page&limit=100&offset=${cursor}`, {
          headers: { Authorization: `Bearer ${auth.token}` }, signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : "暂时无法读取历史，请稍后重试");
        const data: { tasks: VideoTask[]; nextOffset?: number | null } = await response.json();
        if (!Array.isArray(data.tasks)) throw new Error("历史记录返回异常，请稍后重试");
        collected.push(...(data.tasks as VideoTask[]).filter((item) => !collected.some((existing) => existing.id === item.id)));
        cursor = typeof data.nextOffset === "number" && data.nextOffset > (cursor ?? -1) ? data.nextOffset : null;
      } while (offset === 0 && cursor !== null && collected.length < targetWindow);
      if (historyRequestRef.current !== controller) return;
      historyOffsetRef.current = offset;
      historyWindowRef.current = Math.max(100, offset + collected.length);
      setHistoryNextOffset(cursor);
      setHistory(previous => offset ? Array.from(new Map([...previous, ...collected].map(item => [item.id, item])).values()) : collected);
      setTasks((current) => current.map((task) => {
        const saved = collected.find((entry) => entry.taskIdExternal === task.taskId || entry.id === task.taskId);
        if (!task.taskId || !saved) return task;
        const modelId = saved.publicModelId || task.modelId;
        if (task.modelId === modelId && task.modelName === saved.modelName && task.supportsRemoteCancel === saved.supportsRemoteCancel) return task;
        return { ...task, modelId, modelName: saved.modelName, supportsRemoteCancel: saved.supportsRemoteCancel };
      }));
    })()
      .catch((error: unknown) => {
        if (historyRequestRef.current !== controller) return;
        setHistoryError(timedOut ? "历史记录读取超时，请重试" : error instanceof Error && !/fetch|network/i.test(error.message) ? error.message : "暂时无法读取历史，请稍后重试");
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (historyRequestRef.current !== controller) return;
        historyRequestRef.current = null;
        historyRequestPurposeRef.current = null;
        setHistoryLoading(false);
      });
  }, [auth?.token]);

  const refreshHistoryFirstPage = useCallback(() => {
    // Terminal records are inserted at the head of the durable history. Always
    // supersede a stale pagination request and rebase both list and nextOffset
    // from page 0; otherwise a user who loaded more can miss the new record.
    loadHistory(0, { supersedeInFlight: true });
  }, [loadHistory]);

  const refreshRecoveryHistory = useCallback(() => {
    loadHistory(0, { supersedeInFlight: true, purpose: "panel" });
  }, [loadHistory]);

  const prepareHistoryRetry = useCallback((saved: VideoTask) => {
    if (saved.canRetry !== true) { toast.error("原任务结果或费用尚未确认，请先刷新状态"); return; }
    const preserveCurrent = tasksRef.current.some(hasExistingVideoWork);
    if (preserveCurrent && !window.confirm("载入原任务会调整当前模型和参数，已有任务卡片会保留。确认继续？")) return;
    const snapshotTask = saved as SnapshotVideoTask;
    const snapshot = snapshotTask.requestSnapshot;
    const retryInputs = snapshotTask.retryInputs;
    const model = models.find(item => item.id === (snapshot?.publicModelId || saved.publicModelId || saved.modelId));
    const localId = nextLocalId.current++;
    const card: TaskCard = { ...emptyCard(localId, 1, 'retry_' + Date.now(), saved.batchTopic || ''),
      prompt: snapshot?.userPrompt ?? saved.prompt ?? '', negativePrompt: snapshot?.negativePrompt || '',
      modelId: model?.id || '', modelName: model?.name || saved.modelName || '',
      firstFrameUrl: retryInputs?.firstFrameUrl || saved.firstFrameUrl || '',
      lastFrameUrl: retryInputs?.lastFrameUrl || saved.lastFrameUrl || '',
      referenceImageUrl: retryInputs?.referenceImageUrl || saved.referenceImageUrl || '',
      referenceImageUrls: retryInputs?.referenceImageUrls || [],
      audioUrl: retryInputs?.audioUrl || '',
      referenceAudioUrls: retryInputs?.referenceAudioUrls || [],
      sourceVideoUrl: retryInputs?.sourceVideoUrl || '',
      durationSeconds: snapshot?.targetDurationSeconds ?? saved.durationSeconds ?? null,
      aspectRatio: snapshot?.aspectRatio || saved.aspectRatio,
      resolution: snapshot?.resolution || saved.resolution,
      fps: snapshot?.fps ?? undefined,
      seed: snapshot?.seed ?? undefined,
      generateAudio: restoreVideoGenerateAudio(snapshot?.generateAudio),
      ...(snapshot ? { requestSnapshot: snapshot } : {}) };
    setSelectedModelId(model?.id || '');
    setTasks(previous => previous.some(hasExistingVideoWork) ? [...previous, card] : [card]);
    if (card.durationSeconds) setDuration(card.durationSeconds);
    if (card.resolution) setResolution(card.resolution);
    const ratio = AI_VIDEO_PAGE_ASPECT_RATIOS.find(item => item.value === card.aspectRatio);
    if (ratio) setAspectRatio(ratio);
    closeUnifiedHistory();
    if (!model) {
      const unavailableName = saved.modelName?.trim() || "原视频模型";
      const notice = `${unavailableName}已不在当前可用模型目录。已载入原提示词和已保存素材，请重新选择兼容模型并确认最新价格；选择模型前不会提交。`;
      setHistoryRetryNotice(notice);
      toast.info(notice);
      return;
    }
    setHistoryRetryNotice("");
    toast.info("已载入原提示词和已保存素材。请核对模型价格、参考图/音频后点击生成；本次会创建新任务。");
  }, [closeUnifiedHistory, models]);

  const unifiedRetryRequest = useRef<AbortController | null>(null);
  useEffect(() => () => {
    unifiedRetryRequest.current?.abort();
    unifiedRetryRequest.current = null;
  }, [auth?.token, showHistory]);

  const prepareUnifiedHistoryRetry = useCallback(async (taskId: string) => {
    if (!auth?.token || !showHistory || !taskId) return;
    unifiedRetryRequest.current?.abort();
    const controller = new AbortController();
    unifiedRetryRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetch('/api/video/history?' + new URLSearchParams({ surface: 'video-page', taskId }), {
        headers: { Authorization: 'Bearer ' + auth.token }, cache: 'no-store', signal: controller.signal,
      });
      const data = await response.json() as { tasks?: VideoTask[] };
      if (controller.signal.aborted || unifiedRetryRequest.current !== controller) return;
      const saved = Array.isArray(data.tasks) ? data.tasks.find(task => task.id === taskId) : undefined;
      if (!response.ok || !saved) throw new Error('原任务无法读取');
      // The authoritative task owns canRetry, original request snapshot and billing state.
      // Loading it never submits another generation request.
      prepareHistoryRetry(saved);
    } catch {
      if (timedOut) toast.error('原任务读取超时，请刷新历史后重试');
      else if (!controller.signal.aborted) toast.error('原任务无法读取，请刷新历史后重试');
    } finally {
      window.clearTimeout(timeout);
      if (unifiedRetryRequest.current === controller) unifiedRetryRequest.current = null;
    }
  }, [auth?.token, prepareHistoryRetry, showHistory]);
  useEffect(() => {
    if (!auth?.token || !models.length) return;
    const url = new URL(window.location.href), id = url.searchParams.get('retryTask');
    if (!id) return;
    let active = true;
    void fetch('/api/video/history?' + new URLSearchParams({ surface: 'video-page', taskId: id }), { headers: { Authorization: 'Bearer ' + auth.token }, cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (!response.ok || !data.tasks?.[0]) throw new Error('原任务无法读取'); if (active) { prepareHistoryRetry(data.tasks[0]); url.searchParams.delete('retryTask'); window.history.replaceState(null, '', url.pathname + url.search + url.hash); } })
      .catch(() => { if (active) toast.error('原任务无法读取，请从历史记录重试'); });
    return () => { active = false; };
  }, [auth?.token, models.length, prepareHistoryRetry]);

  useEffect(() => () => {
    historyRequestRef.current?.abort();
    historyRequestRef.current = null;
    historyRequestPurposeRef.current = null;
  }, [auth?.token]);

  useEffect(() => {
    historyOffsetRef.current = 0;
    historyWindowRef.current = 100;
  }, [auth?.token]);

  useEffect(() => {
    if (!showHistory || !historyRecoveryOpen) return;
    historyRecoveryActiveRef.current = true;
    loadHistory(0, { purpose: "panel" });
    return () => {
      historyRecoveryActiveRef.current = false;
      cancelPanelHistoryRequest();
    };
  }, [showHistory, historyRecoveryOpen, loadHistory, cancelPanelHistoryRequest]);

  useEffect(() => {

    if (!showHistory || !historyRecoveryOpen || !auth?.token) return;

    const syncHistory = () => {
      if (document.visibilityState === "visible") {
        loadHistory(0, { purpose: "panel" });
      }
    };

    const timer = window.setInterval(syncHistory, 15000);
    const handleFocus = () => syncHistory();
    const handleVisibilityChange = () => syncHistory();

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };

  }, [showHistory, historyRecoveryOpen, auth?.token, loadHistory]);

  // Submitted jobs remain in history; entering this editor always starts blank.

  /* ── SSE 实时状态推送 ── */
  // 独立媒体 worker 轮询上游并写入账号任务；SSE 只推送持久化快照。
  // 浏览器断线、刷新或多标签页都不会重复提交，也不会放大供应商请求。

  useEffect(() => {
    const currentTasks = tasksRef.current;
    const activeTasks = currentTasks.filter(
      (t) => isActiveVideoTaskStatus(t.status) && t.taskId
    );

    // 为新增的活跃任务建立 SSE 连接
    for (const task of activeTasks) {
      if (cancelledRef.current.has(task.localId)) continue;
      if (sseRefs.current.has(task.taskId!)) continue; // 已有连接

      // 用 fetch + ReadableStream 替代 EventSource，token 走 Header（安全）
      const ac = new AbortController();
      let sseRetryCount = 0;
      const SSE_MAX_RETRY = 10;
      const fetchSSE = async () => {
        if (sseRetryCount >= SSE_MAX_RETRY) {
          setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? {
            ...t,
            statusDetail: "实时连接暂时中断，后台仍在跟踪原任务；不会重复提交或重复计费",
          } : t));
          sseRetryCount = 0;
          reconnectTimersRef.current.set(task.taskId!, setTimeout(() => {
            reconnectTimersRef.current.delete(task.taskId!);
            if (sseRefs.current.has(task.taskId!)) void fetchSSE();
          }, 15_000));
          return;
        }
        sseRetryCount++;
        const sseParams = new URLSearchParams({
          taskId: task.taskId!,
          modelId: task.modelId || "",
          contentUrl: task.contentUrl || "",
          prompt: task.prompt || "",
          imageUrl: task.referenceImageUrl || task.firstFrameUrl || "",
          batchId: task.batchId || "",
          batchTopic: task.batchTopic || "",
          cardIndex: String(task.cardIndex || ""),
          targetDuration: String(task.durationSeconds ?? duration),
        });

        try {
          const resp = await fetch(`/api/video/stream?${sseParams.toString()}`, {
            headers: { Authorization: `Bearer ${auth?.token || ""}` },
            signal: ac.signal,
          });
          if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`);

          const reader = resp.body.getReader();
          const decoder = new SseEventStreamDecoder();
          let receivedTerminal = false; // 是否收到终态事件（completed/failed/cancelled）
          sseRetryCount = 0; // 连接成功后重置重试计数

          while (true) {
            const { done, value } = await reader.read();
            const events = done ? decoder.finish() : decoder.push(value);
            for (const event of events) {
              const data = JSON.parse(event.data);
              if (data.taskId && data.taskId !== task.taskId) continue;

              switch (event.event) {
                case "heartbeat": break; // 心跳，无需处理
                case "progress":
                  setTasks((prev) => prev.map((t) =>
                    t.taskId === data.taskId ? {
                      ...t,
                      status: videoProgressStatus(data),
                      processingStage: typeof data.processingStage === 'string' ? data.processingStage : undefined,
                      progress: typeof data.progress === "number" ? data.progress : undefined,
                      statusDetail: String(data.message || data.errorMessage || "") || t.statusDetail,
                      lastSyncedAt: Number.isFinite(Date.parse(String(data.lastSyncedAt || "")))
                        ? Date.parse(String(data.lastSyncedAt)) : t.lastSyncedAt,
                      providerPollFailures: Math.max(0, Number(data.providerPollFailures) || 0),
                    } : t
                  ));
                  break;
                case "completed":
                  receivedTerminal = true;
                  setTasks((prev) => prev.map((t) =>
                    t.taskId === data.taskId ? { ...t, ...videoCompletedDeliveryPatch(data) } : t
                  ));
                  refreshHistoryFirstPage();
                  if (data.cashBalance !== undefined) setCashBalance(data.cashBalance);
                  syncTaskToConversation(undefined, data.taskId, "", videoCompletedDeliveryPatch(data));
                  sseRefs.current.delete(task.taskId!);
                  break;
                case "failed":
                  receivedTerminal = true;
                  {
                    const errorMessage = data.errorMessage || data.message || "生成失败";
                    setTasks((prev) => prev.map((t) =>
                      t.taskId === data.taskId ? { ...t, status: "failed", errorMessage, clientRequestId: "", clientRequestFingerprint: "" } : t
                    ));
                    refreshHistoryFirstPage();
                    syncTaskToConversation(undefined, data.taskId, "", { status: "failed", errorMessage });
                  }
                  sseRefs.current.delete(task.taskId!);
                  break;
                case "cancelled":
                  receivedTerminal = true;
                  setTasks((prev) => prev.map((t) =>
                    t.taskId === data.taskId
                      ? { ...t, status: "cancelled", errorMessage: "已取消", clientRequestId: "", clientRequestFingerprint: "" }
                      : t
                  ));
                  refreshHistoryFirstPage();
                  syncTaskToConversation(undefined, data.taskId, "", { status: "failed", errorMessage: "已取消" });
                  sseRefs.current.delete(task.taskId!);
                  break;
                case "error":
                  console.warn("[SSE] 轮询异常，后端自动重试:", data.message);
                  setTasks((prev) => prev.map((t) => t.taskId === task.taskId
                    ? { ...t, statusDetail: String(data.message || "状态连接暂时异常，后台仍在跟踪原任务") }
                    : t));
                  break;
              }
            }
            if (done) break;
          }

          // ── while 正常退出（done:true）但未收到终态 → 代理/CDN 静默断连 ──
          // 这是"上游已生成，本地卡进度"的根因：SSE 被 Nginx/CDN 超时关闭，
          // 流走 done:true 而非 catch，之前无重连逻辑导致任务永远卡住
          if (!receivedTerminal && sseRefs.current.has(task.taskId!)) {
            console.warn(`[SSE] 流结束未收到终态，降级查询+重连: taskId=${task.taskId}`);
            try {
              const sr = await fetch(`/api/video/status?taskId=${task.taskId}&modelId=${task.modelId || ""}`, {
                headers: { Authorization: `Bearer ${auth?.token || ""}` },
              });
              const sd = await sr.json();
              if (sd.status === "completed") {
                setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, ...videoCompletedDeliveryPatch(sd) } : t));
                refreshHistoryFirstPage();
                if (sd.cashBalance !== undefined) setCashBalance(sd.cashBalance);
                syncTaskToConversation(undefined, task.taskId!, "", videoCompletedDeliveryPatch(sd));
                sseRefs.current.delete(task.taskId!);
                return;
              }
              if (sd.status === "failed") {
                setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: "failed", errorMessage: sd.errorMessage || "生成失败", clientRequestId: "", clientRequestFingerprint: "" } : t));
                refreshHistoryFirstPage();
                syncTaskToConversation(undefined, task.taskId!, "", { status: "failed", errorMessage: sd.errorMessage || "生成失败" });
                sseRefs.current.delete(task.taskId!);
                return;
              }
              if (sd.status === "cancelled") {
                setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: "cancelled", errorMessage: "已取消", clientRequestId: "", clientRequestFingerprint: "" } : t));
                refreshHistoryFirstPage();
                syncTaskToConversation(undefined, task.taskId!, "", { status: "failed", errorMessage: "已取消" });
                sseRefs.current.delete(task.taskId!);
                return;
              }
            } catch { /* fallback 查询失败，走重连 */ }
            // 3秒后重连 SSE，继续监听
            reconnectTimersRef.current.set(task.taskId!, setTimeout(() => { reconnectTimersRef.current.delete(task.taskId!); if (sseRefs.current.has(task.taskId!)) fetchSSE(); }, 3000));
          }
        } catch (err) {
          // SSE 断开：降级查一次 status API，3秒后重连
          if (sseRefs.current.has(task.taskId!)) {
            try {
              const sr = await fetch(`/api/video/status?taskId=${task.taskId}&modelId=${task.modelId || ""}`, {
                headers: { Authorization: `Bearer ${auth?.token || ""}` },
              });
              const sd = await sr.json();
                if (sd.status === "completed") { setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, ...videoCompletedDeliveryPatch(sd) } : t)); refreshHistoryFirstPage(); if (sd.cashBalance !== undefined) setCashBalance(sd.cashBalance); sseRefs.current.delete(task.taskId!); return; }
              if (sd.status === "failed") { setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: "failed", errorMessage: sd.errorMessage || "生成失败", clientRequestId: "", clientRequestFingerprint: "" } : t)); refreshHistoryFirstPage(); sseRefs.current.delete(task.taskId!); return; }
              if (sd.status === "cancelled") { setTasks((prev) => prev.map((t) => t.taskId === task.taskId ? { ...t, status: "cancelled", errorMessage: "已取消", clientRequestId: "", clientRequestFingerprint: "" } : t)); refreshHistoryFirstPage(); sseRefs.current.delete(task.taskId!); return; }
            } catch { /* ignore */ }
            reconnectTimersRef.current.set(task.taskId!, setTimeout(() => { reconnectTimersRef.current.delete(task.taskId!); if (sseRefs.current.has(task.taskId!)) fetchSSE(); }, 3000));
          }
        }
      };

      sseRefs.current.set(task.taskId!, { abortController: ac });
      fetchSSE();
    }

    // 清理已结束任务的 SSE 连接
    for (const [taskId, ref] of sseRefs.current.entries()) {
      const stillActive = currentTasks.find(
        (t) => t.taskId === taskId && isActiveVideoTaskStatus(t.status)
      );
      if (!stillActive) {
        try { ref.abortController.abort(); } catch {}
        sseRefs.current.delete(taskId);
      }
    }

    // 汇总通知：所有任务都已终态
    const activeTasksAll = currentTasks.filter(t => t.status !== "idle");
    const hasPending = activeTasksAll.some((t) => isActiveVideoTaskStatus(t.status));
    if (hasPending) summaryToastKeyRef.current = "";
    if (!hasPending && activeTasksAll.length > 1) {
      const toastKey = activeTasksAll.map(t => `${t.localId}:${t.taskId || ""}:${t.status}`).join("|");
      if (summaryToastKeyRef.current === toastKey) return;
      summaryToastKeyRef.current = toastKey;
      const completed = activeTasksAll.filter(t => t.status === "completed").length;
      const failed = activeTasksAll.filter(t => t.status === "failed" || t.status === "cancelled").length;
      if (failed === 0) {
        toast.success(`全部完成！共${completed}个视频已生成`);
      } else if (completed === 0) {
        toast.error(`全部失败，共${failed}个任务未成功`);
      } else {
        toast(`批次结束：${completed}个成功，${failed}个失败`, { description: "可点击失败任务查看原因并重新生成" });
      }
    }

    // ⚠️ 不在 re-render 时 abort SSE 连接！
    // SSE 连接是长连接，progress 事件更新 tasks → 触发 re-render → 
    // 如果 cleanup abort 所有 SSE，sseRefs 条目残留 → 新 effect 跳过重建 → 任务卡死
    // 组件卸载时的清理由下方独立 useEffect 处理
  }, [tasks, auth?.token, refreshHistoryFirstPage]);

  /* ── SSE 连接卸载清理（仅在组件卸载时执行，不影响 re-render） ── */
  useEffect(() => {
    return () => {
      for (const ref of sseRefs.current.values()) {
        try { ref.abortController.abort(); } catch {}
      }
      sseRefs.current.clear();
      // 清理 thumbCacheRef 中的 blobUrl 防止内存泄漏
      for (const blobUrl of thumbCacheRef.current.values()) {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }
      thumbCacheRef.current.clear();
      // 清理 SSE 重连 setTimeout 防止卸载后 setState
      for (const tid of reconnectTimersRef.current.values()) {
        try { clearTimeout(tid); } catch {}
      }
      reconnectTimersRef.current.clear();
      // 清理上传图片的 ObjectURL 防止内存泄漏
      for (const t of tasksRef.current) {
        try {
          if (t.firstFrameUrl?.startsWith("blob:")) URL.revokeObjectURL(t.firstFrameUrl);
          if (t.lastFrameUrl?.startsWith("blob:")) URL.revokeObjectURL(t.lastFrameUrl);
          if (t.referenceImageUrl?.startsWith("blob:")) URL.revokeObjectURL(t.referenceImageUrl);
          for (const url of t.referenceImageUrls || []) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          }
          for (const url of t.referenceAudioUrls || []) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          }
        } catch {}
      }
      const uploadedAssets = tasksRef.current
        .filter((task) => !requiresVideoTaskTracking(task))
        .flatMap((task) => task.uploadedReferenceAssets || []);
      const uniqueAssets = [...new Map(uploadedAssets.map((asset) => [asset.assetRef, asset])).values()];
      releaseReferenceAssets(uniqueAssets);
    };
  }, [releaseReferenceAssets]);

  /* ── Get selected model ── */
  const selectedModel = models.find((m) => m.id === selectedModelId);
  const selectedModelSubmissionUnavailable = selectedModel?.generationReady === false;
  const selectedDurationDisplay = videoDurationDisplay(selectedModel);
  const supportedAspectRatios = selectedModel?.aspectRatios?.length
    ? AI_VIDEO_PAGE_ASPECT_RATIOS.filter((ratio) => selectedModel.aspectRatios?.includes(ratio.value))
    : AI_VIDEO_PAGE_ASPECT_RATIOS;
  const selectedInputCapabilities = getAiVideoPageInputCapabilities(selectedModel);
  const durationOptions = getVideoTargetDurationOptions(selectedModel);
  const resolutionCapabilities = getVideoResolutionCapabilities(selectedModel);
  const selectedResolution = resolveVideoResolution(selectedModel, resolution).resolution;
  const selectedPrice = resolveVideoCharge(selectedModel, selectedResolution, duration).publicPrice;

  /* ── 切换模型时自动同步时长 ── */
  const prevModelIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedModel || selectedModel.generationReady === false) return;
    if (selectedModel.id === prevModelIdRef.current) return;
    prevModelIdRef.current = selectedModel.id;
    setDuration(getVideoDurationCapabilities(selectedModel).defaultDuration);
    setResolution(getAiVideoPageDefaultResolution(selectedModel));
    if (!supportedAspectRatios.some((ratio) => ratio.value === aspectRatio.value)) {
      setAspectRatio(supportedAspectRatios[0] || AI_VIDEO_PAGE_ASPECT_RATIOS[0]);
    }
    setTasks((current) => current.map((task) => requiresVideoTaskTracking(task) || task.taskId ? task : { ...task, durationSeconds: null }));
  }, [selectedModel, setDuration, setResolution, supportedAspectRatios, aspectRatio.value, setAspectRatio]);

    /* ── Add task ── */
  const addTask = () => {
    if (tasks.length >= 40) return;
    const idx = tasks.length + 1;
    setTasks((prev) => [...prev, emptyCard(nextLocalId.current++, idx, currentBatchId, batchTopic)]);
  };

  /* ── Smart import: paste full text → auto-extract prompts → fill/create cards ── */

  /**
   * 智能提示词解析器 — 支持结构化提取（提示词/副向提醒/镜头说明/总时长）
   * 
   * 核心逻辑：
   * 1. 先按"段落N"/"第N段"等标记切分大段
   * 2. 在每个大段内，按标记（text/提示词/副向提醒/镜头说明/总时长）提取结构化内容
   * 3. 无标记时，用启发式规则自动分类（英文→副向提醒，中文镜头词→镜头说明，数字+秒→时长）
   * 
   * 段落一 → 任务一，段落二 → 任务二，以此类推
   */
  const handleSmartImport = () => {
    if (tasksRef.current.some(requiresVideoTaskTracking)) { toast.info("仍有视频任务待确认，请先保留原任务，待完成后再替换内容"); return; }
    if (!smartImportText.trim()) return;
    const rawText = smartImportText;

    // ── Step 1: 预处理 — 清除噪声 ──
    let text = rawText
      .replace(/一键复制/g, "")
      .replace(/复制代码/g, "")
      .replace(/复制提示词/g, "")
      .replace(/复制$/gm, "")
      .replace(/\[复制\]/g, "")
      .replace(/点击复制/g, "")
      .replace(/^:::(?:prompt|text|copy|视频提示词|文生视频)[^\n]*$/gm, "")  // 去文档容器标记
      .replace(/^:::\s*$/gm, "")  // 去闭合文档容器标记
      .replace(/^~~~\w*\s*$/gm, "")  // 去波浪线围栏标记
      .replace(/^={3,}\s*$/gm, "")  // 去大分区标题线
      .replace(/^━{3,}\s*$/gm, "")  // 去流程段分隔线
      .trim();

    let segments: ParsedSegment[] = [];

    // ═══════════════════════════════════════════════════════
    // Strategy -2: 代码块优先 + 镜头分割（万能文生视频策略）
    //
    // 核心洞察：所有文生视频智能体的共同点是——
    //   1. 最终提示词包裹在代码块（```）中
    //   2. 代码块内按"镜头一/镜头二/分镜头1/Shot 1"等标记分割
    //   3. 代码块外的内容（分析/说明/标题）是噪声，不应导入
    //
    // 此策略优先级最高：先提取代码块内容，再按镜头分割
    // 适用于：3D多模态动画提示词导演、3D文生适配专家、3D文生视频专家B
    //   以及未来任何遵循"代码块+镜头"格式的文生视频智能体
    //
    // 两种来源：
    //   A) 从聊天推送来的纯代码块内容（已被extractAllStructuredPrompts提取，无```围栏）
    //   B) 用户手动粘贴的完整内容（含```围栏）
    // ═══════════════════════════════════════════════════════
    const codeBlockRegex = /```[\w]*\n?([\s\S]*?)```/g;
    const codeBlockMatches = [...text.matchAll(codeBlockRegex)];

    // 判断是否含有代码块围栏
    let codeContent = "";
    if (codeBlockMatches.length >= 1) {
      // 来源B：有代码块围栏 → 提取代码块内容
      codeContent = codeBlockMatches
        .map(m => m[1].trim())
        .filter(c => c.length > 10)
        .join("\n\n");
    }

    // 检测纯文本中是否含有镜头/段落标记（来源A：从聊天推送来的无围栏内容）
    const hasShotMarkers = /(?:镜头\s*[一二三四五六七八九十\d]+|分镜头\s*[一二三四五六七八九十\d]+|Shot\s*\d+|Scene\s*\d+)/i.test(codeContent || text);
    const hasSegMarkers = /(?:【?\s*段落\s*[\[【]?\s*\d+|段落\s*[\[【]?\s*\d+|第\s*\d+\s*段|Segment\s*\d+|Part\s*\d+)/i.test(codeContent || text);

    // 如果有代码块内容，或者纯文本中有镜头/段落标记（来源A），走此策略
    if ((codeContent.length > 10) || (!codeBlockMatches.length && (hasShotMarkers || hasSegMarkers))) {
      // 使用代码块内容（如果有），否则使用原始文本（来源A）
      const workingContent = codeContent.length > 10 ? codeContent : text;

      // ⚠️ 核心规则：段落 > 镜头
      // 当内容同时包含"段落[N]"和"分镜头N"时，必须按段落拆分
      // 因为"分镜头"是段落内的子结构（一段视频包含多个分镜头），不能拆成独立卡片
      if (hasSegMarkers) {
        // 按段落拆分，每个段落 = 一个任务卡片（段落内的分镜头属于同一段）
        const segSplitRegex = /(?:^|\n)(?=(?:【?\s*段落\s*[\[【]?\s*\d+|段落\s*[\[【]?\s*\d+|第\s*\d+\s*段|Segment\s*\d+|Part\s*\d+))/gi;
        const segParts = workingContent.split(segSplitRegex).filter(p => p.trim().length > 10);

        if (segParts.length >= 1) {
          for (let i = 0; i < segParts.length; i++) {
            const part = segParts[i].trim();
            const numMatch = part.match(/(?:【?\s*)?(?:段落|第|Segment|Part)\s*[\[【]?\s*(\d+)/i);
            
            // 提取段落主题
            let theme = "";
            const themeMatch = part.match(/(?:【?\s*)?(?:段落|第|Segment|Part)\s*[\[【]?\s*\d+\s*[\]】]?\s*[：:]\s*(.{2,40})/i);
            if (themeMatch) {
              theme = themeMatch[1].replace(/[，。；\n]/g, "").trim().slice(0, 25);
            }
            if (!theme) {
              const themeMatch2 = part.match(/(?:【?\s*)?(?:段落|第|Segment|Part)\s*[\[【]?\s*\d+\s*[\]】]?\s*最终文生视频Prompt\s*\n?\s*(.{2,40})/i);
              if (themeMatch2) {
                theme = themeMatch2[1].replace(/[，。；\n]/g, "").trim().slice(0, 25);
              }
            }

            // 提取时长
            let duration: number | null = null;
            const durMatch = part.match(/(?:总时长|视频时长|时长)\s*[：:]*\s*(\d+)\s*秒/i);
            if (durMatch) duration = parseInt(durMatch[1], 10);

            // 提取镜头说明
            let camera = "";
            const cameraMatch = part.match(/(?:固定镜头|静态镜头|推镜头|拉镜头|Medium shot|Wide shot)/i);
            if (cameraMatch) camera = cameraMatch[0];

            // 清理"段落[N]最终文生视频Prompt" / "【段落N】"标记行（保留内容）
            const cleanPart = part
              .replace(/^(?:【?\s*)?段落\s*[\[【]?\s*\d+\s*[\]】]?\s*(?:最终文生视频Prompt)?\s*\n?/i, "")
              .replace(/^【段落\s*\d+\s*】\s*\n?/i, "")
              .trim();

            if (cleanPart.length > 10) {
              segments.push({
                prompt: cleanPrompt(cleanPart),
                negativePrompt: "",
                camera,
                duration,
                theme: theme || (numMatch ? `段落${numMatch[1]}` : `段落${i + 1}`),
              });
            }
          }
        }
      }

      // 只有在没有段落标记时，才按镜头拆分
      if (segments.length === 0 && hasShotMarkers) {
        // 在内容中查找镜头分割标记
        // 支持：镜头一/镜头二/镜头1/分镜头1/Shot 1/Scene 1/镜头一（0s-2s）
        const shotSplitRegex = /(?:^|\n)(?=(?:镜头\s*[一二三四五六七八九十\d]+|分镜头\s*\d+|Shot\s*\d+|Scene\s*\d+|分镜头\s*[一二三四五六七八九十]+))/gi;
        const shotParts = workingContent.split(shotSplitRegex).filter(p => p.trim().length > 5);

        if (shotParts.length >= 2) {
          // 按镜头拆分，每个镜头 = 一个任务卡片
          for (let i = 0; i < shotParts.length; i++) {
            const part = shotParts[i].trim();
            // 提取主题：镜头一（0s-2s）：全景固定镜头... → 取描述部分
            let theme = "";
            const themeMatch = part.match(/^(?:镜头\s*[一二三四五六七八九十\d]+|分镜头\s*[一二三四五六七八九十\d]+|Shot\s*\d+|Scene\s*\d+)\s*[（(]?\s*[\d.\s]*s?\s*[-–—]*\s*[\d.\s]*s?\s*[）)]?\s*[：:]*\s*(.{2,30})/i);
            if (themeMatch) {
              theme = themeMatch[1].replace(/[，。；\n]/g, "").trim().slice(0, 25);
            }
            // 提取镜头编号作为默认主题
            if (!theme) {
              const numMatch = part.match(/^(?:镜头|分镜头|Shot|Scene)\s*([一二三四五六七八九十\d]+)/i);
              if (numMatch) theme = `镜头${numMatch[1]}`;
            }

            // 提取时长
            let duration: number | null = null;
            let camera = "";
            const durMatch = part.match(/(?:时长|duration)\s*[：:]*\s*(\d+)\s*秒/i);
            if (durMatch) duration = parseInt(durMatch[1], 10);
            // 从时间范围推算：镜头一（0s-2s）
            const timeRangeMatch = part.match(/[（(]\s*([\d.]+)\s*s?\s*[-–—]\s*([\d.]+)\s*s?\s*[）)]/);
            if (!duration && timeRangeMatch) {
              const s = parseFloat(timeRangeMatch[1]);
              const e = parseFloat(timeRangeMatch[2]);
              if (!isNaN(s) && !isNaN(e)) duration = Math.round((e - s) * 10) / 10;
            }

            if (part.length > 10) {
              segments.push({
                prompt: cleanPrompt(part),
                negativePrompt: "",
                camera,
                duration,
                theme: theme || `镜头${i + 1}`,
              });
            }
          }
        }
      }

      // 如果以上都没匹配到，但确实有代码块内容 → 整块作为一个任务
      if (segments.length === 0 && codeContent.length > 10) {
        segments.push({
          prompt: cleanPrompt(codeContent),
          negativePrompt: "",
          camera: "",
          duration: null,
          theme: "",
        });
      }

      if (segments.length > 0 && segments[0].theme && !batchTopic.trim()) {
        setBatchTopic(segments[0].theme);
      }
    }

    // ═══════════════════════════════════════════════════════
    // Strategy -1: "段落[N]最终文生视频Prompt" / "【段落N】" 格式
    // 3D文生视频智能体（专家A/B/适配专家）的标准输出格式
    // 每个「段落」= 一个任务卡片，段落内的镜头/分镜头都属于同一段
    // 绝不能按「分镜头N」拆分（分镜头是段落内的子结构，不是独立卡片）
    //
    // 输出结构（3D适配专家）：
    //   段落[1]：{原文案}           ← 标题行（轻量分析前）
    //   轻量分析：...               ← 分析内容（非prompt）
    //   段落[1]最终文生视频Prompt   ← prompt块标记
    //   :::prompt / 代码块          ← 实际prompt内容
    //
    // 解析策略：按段落号分组，同一段落号的多个标记合并为一个卡片
    // ═══════════════════════════════════════════════════════
    const duanluoRegex = /(?:段落\s*[\[【]\s*(\d+)\s*[\]】]\s*(最终文生视频Prompt)?|【段落\s*(\d+)\s*】)/gi;
    const duanluoMatches = [...text.matchAll(duanluoRegex)];

    if (segments.length === 0 && duanluoMatches.length >= 1) {
      // 按段落号分组，合并同一段落号的"标题+分析"和"最终Prompt"
      const segGroups: Map<number, { titleIdx: number; promptIdx: number; theme: string }> = new Map();

      for (let i = 0; i < duanluoMatches.length; i++) {
        const match = duanluoMatches[i];
        const segNum = parseInt(match[1] || match[3], 10);
        const isPromptMarker = !!match[2]; // "最终文生视频Prompt"

        if (!segGroups.has(segNum)) {
          segGroups.set(segNum, { titleIdx: -1, promptIdx: -1, theme: "" });
        }
        const group = segGroups.get(segNum)!;

        if (isPromptMarker) {
          group.promptIdx = i;
        } else {
          group.titleIdx = i;
          // 从标题行提取主题
          const start = match.index! + match[0].length;
          const end = i + 1 < duanluoMatches.length ? duanluoMatches[i + 1].index! : text.length;
          const block = text.slice(start, end);
          const themeLineMatch = block.match(/^\s*[：:]\s*(.{2,40})/);
          if (themeLineMatch) {
            group.theme = themeLineMatch[1].replace(/[，。；\n]/g, "").trim().slice(0, 25);
          }
          if (!group.theme) {
            // 【段落N】格式的主题在标记后面（去掉前导空白/换行后取首行）
            const trimmedBlock = block.trimStart();
            const afterMarker = trimmedBlock.match(/^(.{2,40}?)(?:\n|$)/);
            if (afterMarker) {
              group.theme = afterMarker[1].replace(/[，。；]/g, "").trim().slice(0, 25);
            }
          }
        }
      }

      // 按段落号顺序处理每个分组
      const sortedSegNums = [...segGroups.keys()].sort((a, b) => a - b);

      for (const segNum of sortedSegNums) {
        const group = segGroups.get(segNum)!;

        // 确定内容范围：从prompt标记开始，到下一个段落标记结束
        // 如果有prompt标记，用prompt标记的内容；否则用标题标记的内容
        const contentMatchIdx = group.promptIdx >= 0 ? group.promptIdx : group.titleIdx;
        const match = duanluoMatches[contentMatchIdx];
        const start = match.index! + match[0].length;
        const end = contentMatchIdx + 1 < duanluoMatches.length
          ? duanluoMatches[contentMatchIdx + 1].index!
          : text.length;
        let block = text.slice(start, end);

        let theme = group.theme;

        // 提取主题（备用方案）
        if (!theme) {
          const themeLineMatch = block.match(/^\s*[：:]\s*(.{2,40})/);
          if (themeLineMatch) {
            theme = themeLineMatch[1].replace(/[，。；\n]/g, "").trim().slice(0, 25);
          }
        }

        // 清除分析/轻量分析等非prompt内容
        // 段落块中可能包含"轻量分析："区域，只保留最终prompt
        let promptBlock = block;

        // 如果块内有"最终文生视频Prompt"后的内容，只取prompt部分
        const promptStartPatterns = [
          /(?:段落\s*[\[【]\s*\d+\s*[\]】]\s*最终文生视频Prompt)\s*\n/i,
          /ANIMATED VIDEO/i,
          /^(?:16:9|9:16|1:1|横屏|竖屏)/im,
        ];

        // 找到prompt正文起始位置（跳过"轻量分析"等非prompt内容）
        let promptStartIdx = -1;
        for (const pattern of promptStartPatterns) {
          pattern.lastIndex = 0;
          const m = pattern.exec(promptBlock);
          if (m) {
            promptStartIdx = m.index + m[0].length;
            if (pattern === promptStartPatterns[0]) {
              promptStartIdx = m.index + m[0].length;
            }
            break;
          }
        }

        if (promptStartIdx > 0) {
          const animMatch = /ANIMATED VIDEO/i.exec(promptBlock);
          if (animMatch) {
            const lineStart = promptBlock.lastIndexOf("\n", animMatch.index) + 1;
            promptBlock = promptBlock.slice(lineStart);
          } else {
            promptBlock = promptBlock.slice(promptStartIdx);
          }
        }

        // 清理代码块标记和文档容器标记
        promptBlock = promptBlock
          .replace(/^```\w*\n?/, "")
          .replace(/\n?```$/, "")
          .replace(/^:::(?:prompt|text|copy|视频提示词|文生视频)[^\n]*\n?/gm, "")
          .replace(/^:::\s*$/gm, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // 不再拆分负向提示词，整个 promptBlock 作为主提示词
        const mainPrompt = promptBlock;

        // 提取时长
        let duration: number | null = null;
        const durMatch = promptBlock.match(/(?:总时长|视频时长|时长)\s*[：:]*\s*(\d+)\s*秒/i);
        if (durMatch) {
          duration = parseInt(durMatch[1], 10);
        }

        // 提取镜头说明
        let camera = "";
        const cameraMatch = promptBlock.match(/(?:固定镜头|静态镜头|推镜头|拉镜头|Medium shot|Wide shot)/i);
        if (cameraMatch) {
          camera = cameraMatch[0];
        }

        if (mainPrompt.length > 10) {
          segments.push({
            prompt: cleanPrompt(mainPrompt),
            negativePrompt: "",
            camera,
            duration,
            theme: theme || `段落${segNum}`,
          });
        }
      }

      if (segments.length > 0) {
        // 设置批次主题
        if (segments[0].theme && !batchTopic.trim()) {
          setBatchTopic(segments[0].theme);
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // Strategy 0: "分镜头N" 格式 — 文生视频提示词的标准结构
    // 结构：一、基础风格  二、时长规则  三、分镜头详细设定  四、负向提示词
    // 每个分镜头 = 一个任务，基础风格 + 负向提示词共享到所有任务
    // 注意：此策略仅在没有段落级标记时生效，3D智能体的输出由Strategy -1处理
    // ═══════════════════════════════════════════════════════
    const shotRegex = /分镜头\s*(\d+)/gi;
    const shotMatches = [...text.matchAll(shotRegex)];
    if (segments.length === 0 && shotMatches.length >= 1) {
      // 提取共享内容
      let baseStyle = "";   // 基础风格（一、的内容）
      let sharedRules = ""; // 时长与镜头规则（二、的内容）
      let sharedNegative = ""; // 负向提示词（四、的内容）
      let globalDuration: number | null = null;

      // 提取"一、基础风格"区域
      const styleRegex = /[一二三四五六七八九十]+[、.]\s*(?:基础风格|风格与规格|风格|基础设定|基础要求)/g;
      const styleMatch = styleRegex.exec(text);
      if (styleMatch) {
        const styleStart = styleMatch.index + styleMatch[0].length;
        // 截取到下一个"二、"标题之前
        const nextSectionRegex = /[一二三四五六七八九十]+[、.]\s*/g;
        nextSectionRegex.lastIndex = styleStart;
        const nextSection = nextSectionRegex.exec(text);
        const styleEnd = nextSection ? nextSection.index : text.length;
        baseStyle = text.slice(styleStart, styleEnd).trim();
      }

      // 提取"二、时长规则"区域
      const ruleRegex = /[一二三四五六七八九十]+[、.]\s*(?:整体时长|时长|镜头规则|时长与镜头|运镜规则)/g;
      const ruleMatch = ruleRegex.exec(text);
      if (ruleMatch) {
        const ruleStart = ruleMatch.index + ruleMatch[0].length;
        const nextSectionRegex2 = /[一二三四五六七八九十]+[、.]\s*/g;
        nextSectionRegex2.lastIndex = ruleStart;
        const nextSection2 = nextSectionRegex2.exec(text);
        const ruleEnd = nextSection2 ? nextSection2.index : text.length;
        sharedRules = text.slice(ruleStart, ruleEnd).trim();
        // 提取总时长
        const durMatch = sharedRules.match(/总时长\s*(\d+)\s*秒/);
        if (durMatch) globalDuration = parseInt(durMatch[1], 10);
      }

      // 提取"四、负向提示词"区域（可能在分镜头之后）
      const negRegex = /[一二三四五六七八九十]+[、.]\s*(?:负向提示词|反向提示词|Negative\s*Prompt|禁止出现的内容|副向提醒)/gi;
      // 找最后一个匹配（因为可能和分镜头区域的标记交叉）
      const negMatches = [...text.matchAll(negRegex)];
      if (negMatches.length > 0) {
        const lastNeg = negMatches[negMatches.length - 1];
        const negStart = lastNeg.index + lastNeg[0].length;
        // 截取到下一个"一~十、"标题之前，或到文本末尾
        const afterNegRegex = /[一二三四五六七八九十]+[、.]\s*/g;
        afterNegRegex.lastIndex = negStart;
        const afterNeg = afterNegRegex.exec(text);
        const negEnd = afterNeg ? afterNeg.index : text.length;
        sharedNegative = text.slice(negStart, negEnd).trim();
      }

      // 也检测代码块格式的负向提示词
      if (!sharedNegative) {
        const negBlockRegex = /(?:负向提示词|反向提示词|Negative\s*Prompt|禁止出现的内容)[\s\S]*?```([\s\S]*?)```/gi;
        const negBlockMatch = negBlockRegex.exec(text);
        if (negBlockMatch) {
          sharedNegative = negBlockMatch[1].trim();
        }
      }

      // 清理baseStyle中的代码块标记
      baseStyle = baseStyle.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      sharedNegative = sharedNegative.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();

      // 提取每个分镜头的内容
      for (let i = 0; i < shotMatches.length; i++) {
        const shotNum = parseInt(shotMatches[i][1], 10);
        const contentStart = shotMatches[i].index + shotMatches[i][0].length;
        // 截取到下一个分镜头标记之前，或到下一个"一~十、"章节标题之前
        let contentEnd = text.length;
        if (i + 1 < shotMatches.length) {
          contentEnd = shotMatches[i + 1].index;
        } else {
          // 最后一个分镜头：找下一个"一~十、"章节标题
          const nextChapRegex = /\n[一二三四五六七八九十]+[、.]\s*/g;
          nextChapRegex.lastIndex = contentStart;
          const nextChap = nextChapRegex.exec(text);
          if (nextChap && nextChap.index > contentStart) {
            contentEnd = nextChap.index;
          }
        }

        let shotContent = text.slice(contentStart, contentEnd).trim();
        // 提取主题：分镜头1（0s-2.5s）：全景，固定镜头... → 取时间范围后面的描述
        let theme = "";
        const themeMatch = shotContent.match(/^[（(]\s*[\d.]+\s*s?\s*[-–—]\s*[\d.]+\s*s?\s*[）)]\s*[：:]\s*(.{2,30})/);
        if (themeMatch) {
          theme = themeMatch[1].replace(/[，。；]/g, "").trim().slice(0, 20);
        }

        // 提取镜头说明
        let camera = "";
        const cameraMatch = shotContent.match(/(?:固定镜头|静态镜头|Static\s*camera|推镜头|拉镜头|摇镜头|移镜头|跟镜头|航拍|环绕|平移|变焦|手持|晃动)/i);
        if (cameraMatch) {
          camera = cameraMatch[0];
        }

        // 提取单镜头时长
        let shotDuration: number | null = null;
        const shotDurMatch = shotContent.match(/[（(]\s*([\d.]+)\s*s?\s*[-–—]\s*([\d.]+)\s*s?\s*[）)]/);
        if (shotDurMatch) {
          const start = parseFloat(shotDurMatch[1]);
          const end = parseFloat(shotDurMatch[2]);
          if (!isNaN(start) && !isNaN(end)) {
            shotDuration = Math.round((end - start) * 10) / 10;
          }
        }

        // 组装完整prompt：基础风格 + 镜头规则 + 本镜头描述 + 负向提示词
        let fullPrompt = "";
        if (baseStyle) fullPrompt += baseStyle;
        if (sharedRules) fullPrompt += (fullPrompt ? "\n" : "") + sharedRules;
        if (shotContent) fullPrompt += (fullPrompt ? "\n" : "") + shotContent;
        if (sharedNegative) fullPrompt += (fullPrompt ? "\n\n" : "") + "负向提示词：" + sharedNegative;

        segments.push({
          prompt: cleanPrompt(fullPrompt),
          negativePrompt: "",
          camera: camera,
          duration: shotDuration || globalDuration,
          theme: theme || `分镜头${shotNum}`,
        });
      }

      if (segments.length > 0) {
        // 设置批次主题
        if (segments[0].theme && !batchTopic.trim()) {
          setBatchTopic(segments[0].theme);
        }
      }
    }

    // ── Strategy 1: "第N段:【主题】" 格式（最结构化）──
    const segWithThemeRegex = /第\s*(\d+)\s*段\s*[：:]\s*【([^】]+)】/g;
    const segWithThemeMatches = [...text.matchAll(segWithThemeRegex)];
    if (segWithThemeMatches.length >= 1) {
      for (let i = 0; i < segWithThemeMatches.length; i++) {
        const match = segWithThemeMatches[i];
        const rawTheme = match[2].trim();
        const themeM = rawTheme.match(/^([^，。？！,.\?!]+)/);
        const theme = themeM ? themeM[1].trim() : rawTheme.slice(0, 20);

        const start = match.index! + match[0].length;
        const end = i + 1 < segWithThemeMatches.length ? segWithThemeMatches[i + 1].index! : text.length;
        const block = text.slice(start, end);
        const parsed = parseStructuredBlock(block);
        parsed.theme = theme;
        segments.push(parsed);
      }
      if (segments.length > 0 && segments[0].theme && !batchTopic.trim()) {
        setBatchTopic(segments[0].theme);
      }
    }

    // ── Strategy 2: "段落N"/"第N段" without 【】 ──
    if (segments.length === 0) {
      const segRegex = /(?:第\s*(\d+)\s*段|段落\s*(\d+)|Segment\s*(\d+)|Part\s*(\d+)|Section\s*(\d+))/gi;
      const segMatches = [...text.matchAll(segRegex)];
      if (segMatches.length >= 1) {
        for (let i = 0; i < segMatches.length; i++) {
          const segNumber = Number(segMatches[i][1] || segMatches[i][2] || segMatches[i][3] || segMatches[i][4] || segMatches[i][5]);
          const start = segMatches[i].index! + segMatches[i][0].length;
          const end = i + 1 < segMatches.length ? segMatches[i + 1].index! : text.length;
          const block = text.slice(start, end);
          const parsed = parseStructuredBlock(block);
          segments.push(parsed);
        }
      }
    }

    // ── Strategy 3: Numbered list (1. 2. 3. / 1、2、3、/ 一、二、三、)
    // 但排除文生视频的章节标题（一、基础风格 / 二、时长规则 / 四、负向提示词 等）
    if (segments.length === 0) {
      const sectionTitleKeywords = /(?:基础风格|风格与规格|风格|基础设定|基础要求|整体时长|时长|镜头规则|时长与镜头|运镜规则|负向提示词|反向提示词|Negative\s*Prompt|禁止出现的内容|副向提醒)/i;
      const numRegex = /(?:(\d+)\s*[.、)）]\s*|(?:[一二三四五六七八九十]+)[、)）]\s*)/g;
      const numMatches = [...text.matchAll(numRegex)];
      // 过滤掉章节标题匹配
      const filteredMatches = numMatches.filter(m => {
        const afterText = text.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
        return !sectionTitleKeywords.test(afterText);
      });
      if (filteredMatches.length >= 2) {
        for (let i = 0; i < filteredMatches.length; i++) {
          const start = filteredMatches[i].index! + filteredMatches[i][0].length;
          const end = i + 1 < filteredMatches.length ? filteredMatches[i + 1].index! : text.length;
          const block = text.slice(start, end);
          const parsed = parseStructuredBlock(block);
          if (parsed.prompt.length > 5) segments.push(parsed);
        }
      }
    }

    // ── Strategy 4: Markdown table ──
    if (segments.length === 0) {
      const tableRows = text.match(/\|[^|]+\|[^|]+\|/g);
      if (tableRows && tableRows.length >= 2) {
        for (const row of tableRows.slice(1)) {
          const cells = row.split("|").map(c => c.trim()).filter(Boolean);
          const content = cells[cells.length - 1];
          if (content && content.length > 5) {
            segments.push({ prompt: content, negativePrompt: "", camera: "", duration: null, theme: "" });
          }
        }
      }
    }

    // ── Strategy 5: Code blocks ──
    if (segments.length === 0) {
      const codeBlocks = text.match(/```[\s\S]*?```/g);
      if (codeBlocks && codeBlocks.length >= 2) {
        for (const b of codeBlocks) {
          const content = b.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
          if (content.length > 5) {
            segments.push({ prompt: content, negativePrompt: "", camera: "", duration: null, theme: "" });
          }
        }
      }
    }

    // ── Strategy 6: "提示词：" repeated markers (无序号) ──
    if (segments.length === 0) {
      const promptMarkerRegex = /(?:提示词|Prompt)[\s：:]*\n/gi;
      const markerMatches = [...text.matchAll(promptMarkerRegex)];
      if (markerMatches.length >= 2) {
        for (let i = 0; i < markerMatches.length; i++) {
          const start = markerMatches[i].index! + markerMatches[i][0].length;
          const end = i + 1 < markerMatches.length ? markerMatches[i + 1].index! : text.length;
          const block = text.slice(start, end);
          const parsed = parseStructuredBlock(block);
          if (parsed.prompt.length > 5) segments.push(parsed);
        }
      }
    }

    // ── Strategy 7: Blank-line separated paragraphs (最通用的兜底) ──
    if (segments.length === 0) {
      const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 5);
      if (paragraphs.length >= 2) {
        for (const para of paragraphs) {
          const parsed = parseStructuredBlock(para);
          if (parsed.prompt.length > 5) segments.push(parsed);
        }
      } else {
        // 每行一段
        const lines = text.split(/\n/).map(p => p.trim()).filter(p => p.length > 5);
        for (const line of lines) {
          segments.push({ prompt: line, negativePrompt: "", camera: "", duration: null, theme: "" });
        }
        if (segments.length === 0) {
          segments.push({ prompt: text.trim(), negativePrompt: "", camera: "", duration: null, theme: "" });
        }
      }
    }

    if (segments.length === 0) return;

    // ── Step 2: 推送提示词覆盖所有卡片 — 不保留之前的信息
    // 核心原则：
    //   1. 推送即覆盖：清空所有旧卡片，用新段落重新创建
    //   2. 不保留之前的内容、状态、结果
    setTasks(() => {
      const fresh: TaskCard[] = segments.map((seg, idx) => {
        const cardTheme = seg.theme || "";
        const taskNum = idx + 1;
        return {
          ...emptyCard(nextLocalId.current++, taskNum, currentBatchId, batchTopic),
          prompt: seg.prompt,
          negativePrompt: seg.negativePrompt,
          durationSeconds: seg.duration,
          taskLabel: `任务${taskNum}` + (cardTheme ? ` · ${cardTheme}` : ""),
          theme: cardTheme,
        };
      });
      return fresh;
    });

    setSmartImportText("");
    setShowSmartImport(false);
  };

  /* ── autoImportRef 已废弃：推送时只打开智能导入面板，不再自动导入 ── */

  /**
   * 从一个段落块中结构化提取内容
   * 
   * 识别标记（按优先级）：
   * - "text" / "提示词" / "Prompt" → 主提示词
   * - "副向提醒" / "负向提示词" / "Negative Prompt" / "反向提示词" → 副向提醒
   * - "镜头说明" / "运镜" / "Camera" / "镜头" → 镜头说明
   * - "总时长" / "时长" / "Duration" → 总时长
   * 
   * 无标记时用启发式规则：
   * - 纯英文行 → 归入副向提醒
   * - 含镜头/运镜/推拉/摇移等关键词的中文行 → 归入镜头说明
   * - 数字+秒 → 归入时长
   * - 剩余中文/中英混合内容 → 归入主提示词
   */
  const parseStructuredBlock = (block: string): ParsedSegment => {
    const result: ParsedSegment = { prompt: "", negativePrompt: "", camera: "", duration: null, theme: "" };

    // 清除代码块标记
    let cleanBlock = block
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .replace(/\s*一键复制\s*/g, "")
      .replace(/\s*复制\s*/g, "")
      .replace(/\[复制\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // ── 方案A：按标记分段（结构化提取） ──
    // 标记定义：正则匹配 + 对应字段
    const markers: { regex: RegExp; field: "prompt" | "camera" | "duration" }[] = [
      // 负向提示词 → 合并到主提示词（卡片只有一个输入框）
      { regex: /(?:副向提醒|负向提示词|反向提示词|Negative\s*Prompt|Negative)[\s：:]*\n?/gi, field: "prompt" },
      // 镜头说明
      { regex: /(?:镜头说明|运镜说明|镜头运动|运镜|Camera\s*(?:Movement|Motion)?|镜头)[\s：:]*\n?/gi, field: "camera" },
      // 总时长
      { regex: /(?:总时长|视频时长|时长|Duration)[\s：:]*\n?/gi, field: "duration" },
      // 主提示词（放在最后，因为"提示词"最宽泛）
      { regex: /(?:^|\n)\s*(?:text|提示词|Prompt)[\s：:]*\n?/gi, field: "prompt" },
    ];

    // 找到所有标记在文本中的位置
    interface MarkerHit { index: number; end: number; field: "prompt" | "camera" | "duration"; matched: string; }
    const hits: MarkerHit[] = [];

    for (const marker of markers) {
      let m: RegExpExecArray | null;
      const regex = new RegExp(marker.regex.source, marker.regex.flags);
      while ((m = regex.exec(cleanBlock)) !== null) {
        hits.push({
          index: m.index,
          end: m.index + m[0].length,
          field: marker.field,
          matched: m[0],
        });
      }
    }

    // 按位置排序
    hits.sort((a, b) => a.index - b.index);

    // 如果找到标记，按标记分段提取
    if (hits.length > 0) {
      // 标记前的内容（可能属于prompt，如果prompt标记在后面）
      const firstHit = hits[0];
      const preContent = cleanBlock.slice(0, firstHit.index).trim();

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const nextStart = i + 1 < hits.length ? hits[i + 1].index : cleanBlock.length;
        let content = cleanBlock.slice(hit.end, nextStart).trim();

        // 去除标记行本身可能残留的前缀（如 "：" 后的换行）
        content = content.replace(/^[\s：:]+/, "").trim();

        if (hit.field === "duration") {
          // 尝试解析时长数字
          const durMatch = content.match(/(\d+)\s*秒?/);
          if (durMatch) {
            result.duration = parseInt(durMatch[1], 10);
          }
        } else {
          content = cleanPrompt(content);
          if (content.length > 0) {
            result[hit.field] = content;
          }
        }
      }

      // 如果标记前有内容且prompt仍为空，归入prompt
      if (preContent.length > 5 && !result.prompt) {
        result.prompt = cleanPrompt(preContent);
      }

      // 如果标记前有内容且prompt已有值，可能标记前的内容也是prompt的一部分
      if (preContent.length > 5 && result.prompt) {
        result.prompt = cleanPrompt(preContent) + "\n" + result.prompt;
      }

      return result;
    }

    // ── 方案B：无标记，用启发式规则分类 ──
    const lines = cleanBlock.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    const promptLines: string[] = [];
    const cameraLines: string[] = [];

    for (const line of lines) {
      // 时长检测：包含 "N秒" 或纯数字行
      const durMatch = line.match(/^(?:总时长|时长|Duration)[\s：:]*(\d+)\s*秒?$/i);
      if (durMatch) {
        result.duration = parseInt(durMatch[1], 10);
        continue;
      }
      const pureDurMatch = line.match(/^(\d+)\s*秒$/);
      if (pureDurMatch && !result.duration) {
        result.duration = parseInt(pureDurMatch[1], 10);
        continue;
      }

      // 镜头说明检测：含镜头/运镜/推拉/摇移等关键词
      if (/^(?:镜头说明|运镜|镜头|Camera)[\s：:]/i.test(line) || /^(?:推|拉|摇|移|跟|升|降|变焦|平移|环绕|航拍|特写|全景|近景|远景|慢动作|快进)/.test(line)) {
        const cleaned = line.replace(/^(?:镜头说明|运镜说明|镜头运动|运镜|镜头|Camera\s*(?:Movement|Motion)?)\s*[：:]?\s*/i, "").trim();
        if (cleaned) cameraLines.push(cleaned);
        continue;
      }

      // 其余全部归入主提示词（卡片只有一个输入框）
      promptLines.push(line);
    }

    result.prompt = promptLines.join("\n").trim();
    result.negativePrompt = "";
    result.camera = cameraLines.join("\n").trim();

    // 如果camera内容有值，附加到prompt中（视频模型通常将镜头指令放在prompt内）
    if (result.camera && result.prompt) {
      result.prompt = result.prompt + "\n" + result.camera;
      result.camera = ""; // 已合并，清空
    }

    return result;
  };

  /** 清理提示词中的噪声 */
  const cleanPrompt = (p: string): string => {
    return p
      .replace(/^```\w*\n?/, "")      // 去开头的代码块标记
      .replace(/\n?```$/, "")           // 去结尾的代码块标记
      .replace(/^:::(?:prompt|text|copy|视频提示词|文生视频)[^\n]*\n?/gm, "")  // 去开头文档容器标记（不跨行）
      .replace(/^:::\s*$/gm, "")        // 去闭合文档容器标记
      .replace(/\s*一键复制\s*/g, "")    // 去按钮文字
      .replace(/\s*复制\s*/g, "")        // 去复制文字
      .replace(/\[复制\]/g, "")          // 去复制标记
      .replace(/\n{3,}/g, "\n\n")       // 多余空行合并
      .trim();
  };

  /** 预估提示词段落数（用于智能导入预览） */
  const estimatePromptCount = (text: string): number => {
    const cleaned = text.replace(/一键复制|复制代码|复制提示词|\[复制\]|点击复制/g, "").trim();

    // 优先检测段落标记（段落 > 镜头，与handleSmartImport一致）
    const cleanedNoFence = cleaned.replace(/```[\w]*|:::(?:prompt|text|copy|视频提示词|文生视频)|:::/g, "").trim();
    const segMatches = cleanedNoFence.match(/(?:【?\s*段落\s*[\[【]?\s*\d+|段落\s*[\[【]?\s*\d+|第\s*\d+\s*段|Segment\s*\d+|Part\s*\d+|Section\s*\d+)/gi);
    if (segMatches && segMatches.length >= 1) return segMatches.length;

    // 代码块内的镜头分割
    const codeBlockRegex = /```[\w]*\n?([\s\S]*?)```/g;
    const codeBlockMatches = [...cleaned.matchAll(codeBlockRegex)];
    if (codeBlockMatches.length >= 1) {
      const codeContent = codeBlockMatches.map(m => m[1].trim()).filter(c => c.length > 10).join("\n\n");
      const shotSplitRegex = /(?:^|\n)(?=(?:镜头\s*[一二三四五六七八九十\d]+|分镜头\s*\d+|Shot\s*\d+|Scene\s*\d+))/gi;
      const shotParts = codeContent.split(shotSplitRegex).filter(p => p.trim().length > 5);
      if (shotParts.length >= 2) return shotParts.length;
    }

    // 尝试其他分段方式
    const numMatches = cleanedNoFence.match(/(?:(\d+)\s*[.、)）]\s*|(?:[一二三四五六七八九十]+)[、)）])/g);
    if (numMatches && numMatches.length >= 2) return numMatches.length;
    const codeBlocks = cleanedNoFence.match(/```[\s\S]*?```/g);
    if (codeBlocks && codeBlocks.length >= 2) return codeBlocks.length;
    const promptMarkers = cleanedNoFence.match(/(?:提示词|Prompt)[\s：:]*\n/gi);
    if (promptMarkers && promptMarkers.length >= 2) return promptMarkers.length;
    const paragraphs = cleanedNoFence.split(/\n\s*\n/).filter(p => p.trim().length > 5);
    if (paragraphs.length >= 2) return paragraphs.length;
    return cleanedNoFence.split(/\n/).filter(p => p.trim().length > 5).length || 1;
  };

  /* ── Remove task ── */
  const removeTask = (localId: number) => {
    const removed = tasksRef.current.find((task) => task.localId === localId);
    if (!removed || requiresVideoTaskTracking(removed)) return;
    releaseReferenceAssets(removed.uploadedReferenceAssets || []);
    setTasks((prev) => {
      const remaining = prev.filter((t) => t.localId !== localId);
      // 重新编号：始终从任务1开始依次排列
      return remaining.map((t, i) => {
        const label = t.taskLabel || "";
        const themePart = label.includes('·') ? ` · ${label.split('·').slice(1).join('·').trim()}` : "";
        return { ...t, cardIndex: i + 1, taskLabel: `任务${i + 1}${themePart}` };
      });
    });
  };

  const confirmCardAction = () => {
    if (!cardAction) return;
    if (cardAction.kind === "remove-one") {
      if (cardAction.localId !== undefined) removeTask(cardAction.localId);
    } else {
      const targetIds = new Set(cardAction.targetIds || []);
      const editable = tasksRef.current.filter(task => targetIds.has(task.localId) && !requiresVideoTaskTracking(task));
      if (editable.length) {
        releaseReferenceAssets(editable.flatMap(task => task.uploadedReferenceAssets || []));
        if (cardAction.kind === "clear") {
          setTasks(previous => previous.map(task => !targetIds.has(task.localId) || requiresVideoTaskTracking(task) ? task : emptyCard(task.localId, task.cardIndex, task.batchId, task.batchTopic)));
        } else {
          setCurrentBatchId(`batch_${Date.now()}`);
          currentCardCounter.current = 1;
          setTasks(previous => previous.filter(task => !targetIds.has(task.localId) || requiresVideoTaskTracking(task)));
        }
      }
    }
    setCardAction(null);
  };

  const classifyVideoError = (message: string) => {
    const detail = String(message || "").trim();
    if (/余额不足|积分不足|额度不足/u.test(detail)) return "当前余额不足，请充值后重试。";
    if (/参考图|首帧|尾帧|素材/u.test(detail) && /无效|缺少|失败|不支持|拒绝/u.test(detail)) {
      return "参考素材未通过检查，请重新选择后提交。";
    }
    if (/401|403|unauthori[sz]ed|forbidden|鉴权|授权/iu.test(detail)) return "视频服务授权暂不可用，请稍后重试。";
    if (/429|rate[_\s-]*limit|限流|繁忙|timeout|超时/iu.test(detail)) return "视频服务繁忙，请稍后重试。";
    if (/API|HTTP|HTTPS|endpoint|provider|供应商|上游|渠道|密钥|成本|数据库|验收/iu.test(detail)) {
      return "视频服务暂时无法完成本次请求，请稍后重试。";
    }
    return detail || "视频服务暂时无法完成本次请求，请稍后重试。";
  };

  /* ── Cancel task (with upstream status check — avoid wasting money) ── */
  const cancelTask = async (localId: number) => {
    const task = tasksRef.current.find(t => t.localId === localId);
    if (!task) return;
    if (!task.taskId && !task.clientRequestId) {
      toast.info("原任务缺少可核验的请求编号，暂不能安全终止；系统会继续追踪。");
      return;
    }
    if (!auth?.token) {
      toast.info("请先登录后查询任务；现有任务追踪已保留。");
      return;
    }

    // 如果任务有taskId（已提交到上游），先做一次最终状态检查
    // 防止用户终止了一个已经生成成功的视频，白花钱却看不到结果
    if (task.taskId && auth?.token) {
      try {
        const params = new URLSearchParams({
          taskId: task.taskId,
          modelId: task.modelId || "",
          contentUrl: task.contentUrl || "",
          prompt: task.prompt || "",
          imageUrl: task.referenceImageUrl || task.firstFrameUrl || "",
          batchId: task.batchId || "",
          batchTopic: task.batchTopic || "",
          cardIndex: String(task.cardIndex || ""),
          targetDuration: String(task.durationSeconds ?? duration),
        });
        const res = await fetch(
          `/api/video/status?${params.toString()}`,
          { headers: { Authorization: `Bearer ${auth.token}` } }
        );
        const data = await res.json();

        // 上游已经成功 → 不终止，保留结果！
        if (data.status === "completed") {
          setTasks((prev) =>
            prev.map((t) =>
              t.localId === localId
                ? { ...t, ...videoCompletedDeliveryPatch(data), pollStuckCount: 0 }
                : t
            )
          );
          const unavailable = getVideoMediaUnavailable(data);
          if (unavailable) toast.info(unavailable.message);
          else toast.success(`任务${task.cardIndex}视频已生成完成！终止前检测到任务成功，结果已保留`);
          // 刷新余额和历史
          fetch("/api/cash/balance", { headers: { Authorization: `Bearer ${auth.token}` } })
            .then((r) => r.json()).then((bal) => setCashBalance(bal.balance ?? 0)).catch(() => {});
          refreshHistoryFirstPage();
          return; // 不终止！
        }

        // 上游已经失败 → 直接标记失败
        if (data.status === "failed") {
          cancelledRef.current.add(localId);
          setTasks((prev) =>
            prev.map((t) =>
              t.localId === localId
                ? { ...t, status: "failed" as const, errorMessage: classifyVideoError(data.errorMessage || data.error || "生成失败"), pollStuckCount: 0 }
                : t
            )
          );
          toast.info(`任务${task.cardIndex}生成失败，状态已同步`);
          refreshHistoryFirstPage();
          return;
        }
      } catch {
        // 网络错误 → 不阻塞终止操作，继续走正常终止流程
      }
    }

    // Only a confirmed provider cancellation may terminate local tracking.
    try {
      const response = await fetch("/api/video/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          taskId: task.taskId,
          clientRequestId: task.clientRequestId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true || data.status !== "cancelled") {
        // The cancellation route already returns a user-safe, action-specific
        // explanation. Do not collapse it into a generic provider error: the
        // operator must know that the original task is still being tracked.
        toast.info(String(data.message || data.error || "服务尚未确认取消，任务仍在追踪中，请勿重复生成。"));
        if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") refreshHistoryFirstPage();
        return;
      }
    } catch {
      toast.info("取消结果暂时无法确认，已保留任务追踪和原请求编号。");
      return;
    }
    const latest = tasksRef.current.find((item) => item.localId === localId);
    if (!latest
      || (task.clientRequestId && latest.clientRequestId !== task.clientRequestId)
      || (!task.clientRequestId && latest.taskId !== task.taskId)
      || !isActiveVideoTaskStatus(latest.status)) return;
    cancelledRef.current.add(localId);

    // 关闭 SSE 连接
    const trackedTaskId = latest.taskId || task.taskId;
    if (trackedTaskId && sseRefs.current.has(trackedTaskId)) {
      try { sseRefs.current.get(trackedTaskId)!.abortController.abort(); } catch {}
      sseRefs.current.delete(trackedTaskId);
    }

    if (task.clientRequestId) {
      clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), task.clientRequestId);
    }

    setTasks((prev) =>
      prev.map((t) =>
        t.localId === localId && isActiveVideoTaskStatus(t.status)
          ? {
              ...t,
              status: "cancelled" as const,
              errorMessage: "已手动终止",
              statusDetail: "任务已终止；已投递任务仅在上游确认后进入此状态",
              clientRequestId: "",
              clientRequestFingerprint: "",
              pollStuckCount: 0,
              progress: undefined,
            }
          : t
      )
    );
    refreshHistoryFirstPage();
    if (task.status !== "idle" && task.status !== "failed" && task.status !== "cancelled") {
      toast.info(`任务${task.cardIndex}已终止`);
    }
  };

  /* ── Update task field ── */
  const updateTask = <K extends keyof TaskCard>(localId: number, field: K, value: TaskCard[K]) => {
    if (tasksRef.current.some(task => task.localId === localId && requiresVideoTaskTracking(task))) return;
    setTasks((prev) =>
      prev.map((t) => (t.localId === localId ? { ...t, [field]: value } : t))
    );
  };

  const taskReferenceUrls = (task: TaskCard) => new Set([
    task.firstFrameUrl,
    task.lastFrameUrl,
    task.referenceImageUrl,
    ...(task.referenceImageUrls || []),
    task.audioUrl || "",
    ...(task.referenceAudioUrls || []),
  ].filter(Boolean));

  const replaceTaskReferenceUrl = (
    localId: number,
    field: "firstFrameUrl" | "lastFrameUrl" | "referenceImageUrl" | "audioUrl",
    value: string,
    uploadedAsset?: UploadedVideoReferenceAsset,
  ) => {
    const task = tasksRef.current.find((item) => item.localId === localId);
    if (!task || requiresVideoTaskTracking(task)) return;
    const previousUrl = String(task[field] || "");
    const nextTask = { ...task, [field]: value };
    const retainedUrls = taskReferenceUrls(nextTask);
    const removedAssets = (task.uploadedReferenceAssets || []).filter((asset) => !retainedUrls.has(asset.url));
    if (previousUrl.startsWith("blob:") && previousUrl !== value) URL.revokeObjectURL(previousUrl);
    releaseReferenceAssets(removedAssets);
    setTasks((current) => current.map((item) => item.localId === localId
      ? {
          ...item,
          [field]: value,
          uploadedReferenceAssets: [
            ...(item.uploadedReferenceAssets || []).filter((asset) => retainedUrls.has(asset.url)),
            ...(uploadedAsset && !(item.uploadedReferenceAssets || []).some((asset) => asset.assetRef === uploadedAsset.assetRef)
              ? [uploadedAsset]
              : []),
          ],
        }
      : item));
  };

  const updateReferenceList = (
    localId: number,
    field: "referenceImageUrls" | "referenceAudioUrls",
    updater: (current: string[]) => string[],
  ) => {
    const task = tasksRef.current.find((item) => item.localId === localId);
    if (!task || requiresVideoTaskTracking(task)) return;
    const nextValues = updater(task[field] || []);
    const nextTask = { ...task, [field]: nextValues };
    const retainedUrls = taskReferenceUrls(nextTask);
    const removedAssets = (task.uploadedReferenceAssets || []).filter((asset) => !retainedUrls.has(asset.url));
    releaseReferenceAssets(removedAssets);
    setTasks((current) => current.map((item) => item.localId === localId
      ? {
          ...item,
          [field]: nextValues,
          uploadedReferenceAssets: (item.uploadedReferenceAssets || []).filter((asset) => retainedUrls.has(asset.url)),
        }
      : item));
  };

  const uploadReferenceFiles = async (
    localId: number,
    files: File[],
    category: "image" | "audio",
    maxItems: number,
  ) => {
    if (tasksRef.current.some(task => task.localId === localId && requiresVideoTaskTracking(task))) return;
    if (!auth?.token) {
      toast.error("请先登录后再上传参考素材");
      return;
    }
    const field = category === "image" ? "referenceImageUrls" : "referenceAudioUrls";
    const task = tasksRef.current.find((item) => item.localId === localId);
    const current = task?.[field] || [];
    const available = Math.max(0, maxItems - current.length);
    const selected = files.slice(0, available);
    if (selected.length === 0) {
      toast.info(`最多添加 ${maxItems} 个${category === "image" ? "参考图" : "参考音频"}`);
      return;
    }
    const uploaded: UploadedVideoReferenceAsset[] = [];
    for (const file of selected) {
      try {
        const asset = category === "image"
          ? await uploadImageFile(file, auth.token, referenceUploadSession)
          : await uploadAudioFile(file, auth.token, referenceUploadSession);
        uploaded.push(asset);
      } catch (error) {
        toast.error(`${file.name} 上传失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
    if (uploaded.length > 0) {
      const uploadedUrls = uploaded.map((asset) => asset.url);
      setTasks((current) => current.map((item) => item.localId === localId
        ? {
            ...item,
            [field]: [...(item[field] || []), ...uploadedUrls].slice(0, maxItems),
            uploadedReferenceAssets: [...(item.uploadedReferenceAssets || []), ...uploaded],
          }
        : item));
      toast.success(`已添加 ${uploaded.length} 个${category === "image" ? "参考图" : "参考音频"}`);
    }
  };

  // 将生图工作台的顺序文件批量导入。上传后替换预览为服务端 URL，避免 blob URL 无法提交给视频模型。
  const importOrderedImages = async (fileList: FileList | null) => {
    const files = sortImageFiles(Array.from(fileList || []).filter((file) => file.type.startsWith("image/")));
    if (!files.length) {
      toast.error("请选择 JPG、PNG 或 WebP 图片。");
      return;
    }
    if (!auth?.token) {
      toast.error("请先登录后再导入图片。");
      return;
    }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) {
      toast.error("单张图片不能超过 10MB。");
      return;
    }
    if (orderedImageMode === "first-last" && files.length % 2 !== 0) {
      toast.error("首尾帧模式必须选择偶数张图片：1、2 为任务1，3、4 为任务2。");
      return;
    }

    if (tasksRef.current.some(requiresVideoTaskTracking)) { toast.info("仍有视频任务待确认，请在原任务完成后再按序导入图片"); return; }
    const perTask = orderedImageMode === "reference" ? 1 : 2;
    const requiredTaskCount = Math.ceil(files.length / perTask);
    if (requiredTaskCount > 40) {
      toast.error("最多导入 40 个视频任务，请减少图片数量后重试。");
      return;
    }

    const slots = files.map((file, index) => ({
      file,
      taskIndex: Math.floor(index / perTask),
      field: orderedImageMode === "reference"
        ? "referenceImageUrl" as const
        : index % 2 === 0 ? "firstFrameUrl" as const : "lastFrameUrl" as const,
      previewUrl: URL.createObjectURL(file),
    }));

    for (const slot of slots) {
      const current = tasksRef.current[slot.taskIndex];
      const oldUrl = current ? String(current[slot.field] || "") : "";
      const replacedAssets = (current?.uploadedReferenceAssets || []).filter((asset) => asset.url === oldUrl);
      releaseReferenceAssets(replacedAssets);
    }

    setIsImportingOrderedImages(true);
    setTasks((prev) => {
      const next = [...prev];
      while (next.length < Math.max(DEFAULT_TASK_COUNT, requiredTaskCount)) {
        next.push(emptyCard(nextLocalId.current++, next.length + 1, currentBatchId, batchTopic));
      }
      for (const slot of slots) {
        const current = next[slot.taskIndex];
        const oldUrl = String(current[slot.field] || "");
        next[slot.taskIndex] = {
          ...current,
          [slot.field]: slot.previewUrl,
          uploadedReferenceAssets: (current.uploadedReferenceAssets || []).filter((asset) => asset.url !== oldUrl),
          status: "idle",
          errorMessage: "",
        };
      }
      return next;
    });

    let failedCount = 0;
    try {
      for (const slot of slots) {
        try {
          const uploaded = await uploadImageFile(slot.file, auth.token, referenceUploadSession);
          URL.revokeObjectURL(slot.previewUrl);
          setTasks((prev) => prev.map((task, index) =>
            index === slot.taskIndex
              ? { ...task, [slot.field]: uploaded.url, uploadedReferenceAssets: [...(task.uploadedReferenceAssets || []), uploaded] }
              : task
          ));
        } catch (error) {
          failedCount += 1;
          URL.revokeObjectURL(slot.previewUrl);
          setTasks((prev) => prev.map((task, index) =>
            index === slot.taskIndex ? { ...task, [slot.field]: "" } : task
          ));
          toast.error(`${slot.file.name} 上传失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      const taskLabel = orderedImageMode === "reference" ? `${files.length} 个参考图任务` : `${requiredTaskCount} 个首尾帧任务`;
      toast.success(failedCount ? `已导入 ${taskLabel}，${failedCount} 张上传失败。` : `已按文件名顺序导入 ${taskLabel}。`);
    } finally {
      setIsImportingOrderedImages(false);
    }
  };

  /* ── 同步视频任务到历史对话 ── */
  const syncTaskToConversation = (
    task: TaskCard | undefined,
    taskId: string,
    modelName: string,
    result?: { status: string; videoUrl?: string; errorMessage?: string },
    promptOverride?: string,
    modelIdOverride?: string
  ) => {
    const now = Date.now();
    const convId = `video_${taskId}_${now}`;
    const prompt = task?.prompt || promptOverride || "";

    // 构建对话消息内容
    let content = `🎬 **${modelName}**\n📝 ${prompt}`;
    if (result?.status === "completed" && result.videoUrl) {
      content += `\n✅ 生成完成`;
    } else if (result?.status === "completed") {
      content += `\n⚠️ 视频已生成，当前不可播放：${result.errorMessage || "视频源不可用，请使用此前下载的文件"}`;
    } else if (result?.status === "failed") {
      content += `\n❌ 生成失败：${result.errorMessage || "未知错误"}`;
    } else {
      content += `\n⏳ 排队生成中...`;
    }

    dispatch({
      type: "ADD_CONVERSATION",
      payload: {
        id: convId,
        title: modelName,
        agentId: "video-platform",
        agentName: modelName,
        agentIconUrl: "",
        botId: "",
        source: "video" as const,
        lastMessage: content,
        lastMessageTime: now,
        messages: [
          {
            id: `msg_${now}`,
            role: "user" as const,
            content: prompt,
            timestamp: now,
          },
          {
            id: `msg_${now + 1}`,
            role: "assistant" as const,
            content,
            timestamp: now + 1,
            videoTaskId: taskId,
            videoModelId: task?.modelId || modelIdOverride || selectedModelId || "",
            videoStatus: result?.status || "processing",
            videoUrl: result?.videoUrl,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    });
  };

  /* ── Generate video ── */
  const generate = async (localId: number) => {
    if (submissionLocksRef.current.has(localId)) return;
    submissionLocksRef.current.add(localId);
    try { await submitVideoTask(localId); }
    finally { submissionLocksRef.current.delete(localId); }
  };
  const submitVideoTask = async (localId: number) => {
    const original = tasksRef.current.find(item => item.localId === localId);
    const unavailable = original && getVideoMediaUnavailable(original);
    if (unavailable) { toast.info(unavailable.message); return; }
    if (original && requiresVideoTaskTracking(original)) {
      if (isActiveVideoTaskStatus(original.status)) return;
      try {
        let taskId = original.taskId;
        let businessTaskId = original.businessTaskId;
        if (!taskId && original.clientRequestId) {
          const response = await fetch('/api/video/request-status?' + new URLSearchParams({ clientRequestId: original.clientRequestId }),
            { headers: { Authorization: 'Bearer ' + auth?.token }, cache: 'no-store' });
          const data = await response.json();
          if (!response.ok || !data.found) { toast.info(data.message || data.error || '原请求仍待确认，请稍后查询'); return; }
          taskId = data.taskId;
          businessTaskId = submittedBusinessTaskId(data.businessTaskId);
        }
        if (taskId) setTasks(previous => previous.map(item => item.localId === localId ? { ...item, taskId, businessTaskId: item.clientRequestId === original.clientRequestId ? businessTaskId : undefined, status: 'queued', errorMessage: '', pollStuckCount: 0 } : item));
      } catch { toast.info('暂时无法查询原任务，请稍后重试；不会重新生成'); }
      return;
    }
    const task = tasksRef.current.find((t) => t.localId === localId);
    if (!task || !selectedModelId) return;
    const currentModel = models.find((m) => m.id === selectedModelId);
    if (!auth?.token) { toast.error("请先登录后再生成视频"); return; }
    if (!currentModel) { toast.error("视频模型尚未加载，请刷新模型列表后重试"); return; }
    if (currentModel.generationReady === false) { toast.info("请选择其他视频模型"); return; }
    const tokenBilling = resolveVideoTokenBillingConsent(currentModel, tokenChargeConsent);
    if (getVideoBillingUnit(currentModel) === "token" && !tokenBilling) { toast.info("请明确填写本次每条视频最多自动扣款金额（正数，最多两位小数）"); return; }
    if (tokenBilling && tokenBilling.maxChargeYuan > cashBalance) { toast.info("现金余额不足以预留本次额度；预留不是扣费，请调整额度或充值"); return; }
    const inputCapabilities = getAiVideoPageInputCapabilities(currentModel);
    const submittedImageUrls = taskImageInputs(task, inputCapabilities);
    const submittedAudioUrls = inputCapabilities.showAudioInputs ? (task.referenceAudioUrls || []) : [];
    const showPreflightGuidance = (message: string) => {
      toast.info(message);
    };

    const pendingUploadFields = [
      ...submittedImageUrls,
      ...submittedAudioUrls,
    ].filter((url) => typeof url === "string" && url.startsWith("blob:"));
    if (pendingUploadFields.length > 0) {
      const message = "图片仍在上传中，请等待上传完成后再生成";
      showPreflightGuidance(message);
      return;
    }

    // 校验 prompt
    const trimmedPrompt = task.prompt.trim();
    if (inputCapabilities.supportsPrompt && !trimmedPrompt) {
      showPreflightGuidance("请输入视频提示词");
      return;
    }

    // 校验 prompt 长度
    if (inputCapabilities.supportsPrompt && trimmedPrompt.length > 4000) {
      showPreflightGuidance(`提示词过长（${trimmedPrompt.length}字），请控制在4000字以内`);
      return;
    }

    // 检查该模型是否必须提供参考图片
    if (currentModel && (!currentModel.available || !currentModel.generationReady)) {
      showPreflightGuidance("暂时无法生成，请选择其他模型或稍后重试");
      return;
    }
    if (inputCapabilities.requiresFirstFrame && !task.firstFrameUrl) {
      showPreflightGuidance("该模型必须提供首帧图片");
      return;
    }
    if (inputCapabilities.requiresLastFrame && !task.lastFrameUrl) {
      showPreflightGuidance("该模型必须提供尾帧图片");
      return;
    }
    const suppliedImages = submittedImageUrls.filter((url) => Boolean(url?.trim())).length;
    if (suppliedImages < inputCapabilities.minReferenceImages) {
      const message = `该模型至少需要 ${inputCapabilities.minReferenceImages} 张参考图片，当前 ${suppliedImages} 张`;
      showPreflightGuidance(message);
      return;
    }
    const suppliedAudios = [task.audioUrl || "", ...submittedAudioUrls].filter((url) => Boolean(url?.trim())).length;
    if (suppliedAudios < inputCapabilities.minReferenceAudios) {
      const message = `该模型至少需要 ${inputCapabilities.minReferenceAudios} 段参考音频，当前 ${suppliedAudios} 段`;
      showPreflightGuidance(message);
      return;
    }
    if (inputCapabilities.requiresSourceVideo && !task.sourceVideoUrl.trim()) {
      showPreflightGuidance("请先添加当前模型需要的源视频链接");
      return;
    }

    const submittedInputs = {
      prompt: inputCapabilities.supportsPrompt ? trimmedPrompt : "",
      imageUrl: inputCapabilities.showFirstFrame ? task.firstFrameUrl : "",
      lastFrameUrl: inputCapabilities.showLastFrame ? (task.lastFrameUrl || "") : "",
      referenceImageUrl: inputCapabilities.showReferenceImages ? (task.referenceImageUrl || "") : "",
      referenceImageUrls: inputCapabilities.showReferenceImages ? (task.referenceImageUrls || []) : [],
      audioUrl: task.audioUrl || "",
      referenceAudioUrls: submittedAudioUrls,
      sourceVideoUrl: inputCapabilities.supportsSourceVideoInput ? (task.sourceVideoUrl || "") : "",
    };
    const submittedAspectRatio = resolveAiVideoInputAspectRatio(currentModel, aspectRatio.value, submittedInputs);
    const inputViolation = validateVideoInputContract(inputCapabilities, submittedInputs);
    const nonPublicInput = [...submittedImageUrls, submittedInputs.audioUrl, ...submittedAudioUrls, submittedInputs.sourceVideoUrl]
      .some((url) => Boolean(url?.trim()) && !parseGeneratedImageReferenceUri(url) && !isPublicVideoAssetUrl(url));
    if (inputViolation || nonPublicInput) {
      const message = inputViolation?.message || "参考素材暂时无法读取，请等待上传完成，或通过上传按钮重新上传素材";
      showPreflightGuidance(message);
      return;
    }

    // 所有付费视频通道从“业务任务持久化”开始就以这个键去重。只有收到明确终态后才会清空；
    // 模糊的断网、500/502/503 不会自动换键，因而不会制造第二个供应商任务或重复扣费。
    const targetDuration = coerceVideoTargetDuration(currentModel, task.durationSeconds ?? duration);
    const videoTiming = resolveVideoDuration(currentModel, targetDuration);
    const submittedGenerateAudio = videoGenerateAudioForSubmission(
      currentModel.supportsGenerateAudioToggle === true,
      task.generateAudio,
    );
    if (!videoTiming.supported) {
      const message = `当前模型最长支持 ${videoTiming.maxDuration} 秒，请缩短镜头或切换模型`;
      showPreflightGuidance(message);
      return;
    }

    const clientRequestFingerprint = await buildClientRequestFingerprint({
      modelId: selectedModelId,
      prompt: trimmedPrompt,
      negativePrompt: task.negativePrompt || "",
      firstFrameUrl: task.firstFrameUrl || "",
      lastFrameUrl: task.lastFrameUrl || "",
      referenceImageUrl: task.referenceImageUrl || "",
      referenceImageUrls: task.referenceImageUrls || [],
      referenceAudioUrls: task.referenceAudioUrls || [],
      audioUrl: task.audioUrl || "",
      sourceVideoUrl: task.sourceVideoUrl || "",
      duration: videoTiming.target,
      aspectRatio: submittedAspectRatio,
      resolution: selectedResolution,
      fps: task.fps ?? null,
      seed: task.seed ?? null,
      generateAudio: submittedGenerateAudio ?? null,
      tokenBilling,
    });
    const clientAttempt = resolveBrowserClientAttempt({
      storageKey: videoClientAttemptScope(identity.userId, task),
      fingerprint: clientRequestFingerprint,
      previousRequestId: task.clientRequestId,
      previousFingerprint: task.clientRequestFingerprint,
      previousTerminal: task.status === "completed" || task.status === "cancelled" || (task.status === "failed" && !requiresVideoTaskTracking(task)),
      prefix: "video",
    });
    const clientRequestId = clientAttempt.clientRequestId;

    const checkpoint: TaskCard = { ...task, businessTaskId: undefined, clientRequestId, clientRequestFingerprint, modelId: currentModel.id, modelName: currentModel.name,
      modelSnapshot: currentModel, aspectRatio: submittedAspectRatio, resolution: selectedResolution, followsSourceDuration: inputCapabilities.requiresSourceVideo, supportsRemoteCancel: currentModel.supportsRemoteCancel === true,
      generateAudio: submittedGenerateAudio, status: 'pending', durationSeconds: targetDuration, errorMessage: '', submittedAt: Date.now(), videoUrl: '', taskId: '', progress: undefined, thumbnailUrl: '', contentUrl: '' };

    // 关闭旧任务的 SSE 连接（防止旧回调覆盖新状态）
    if (task.taskId && sseRefs.current.has(task.taskId)) {
      try { sseRefs.current.get(task.taskId)!.abortController.abort(); } catch {}
      sseRefs.current.delete(task.taskId);
    }

    setTasks((prev) =>
      prev.map((t) =>
        t.localId === localId
          ? { ...t, ...checkpoint }
          : t
      )
    );

    try {
      const submittedReferenceUrls = new Set([
        submittedInputs.imageUrl,
        submittedInputs.lastFrameUrl,
        submittedInputs.referenceImageUrl,
        ...submittedInputs.referenceImageUrls,
        submittedInputs.audioUrl,
        ...submittedInputs.referenceAudioUrls,
      ].filter(Boolean));
      const submittedReferenceAssetRefs = (task.uploadedReferenceAssets || [])
        .filter((asset) => submittedReferenceUrls.has(asset.url))
        .map((asset) => ({ url: asset.url, asset_ref: asset.assetRef, category: asset.category }));
      const res = await fetch("/api/video/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": clientRequestId,
          ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        body: JSON.stringify({
          model_id: selectedModelId,
          ...(tokenBilling ? { tokenBilling } : {}),
          prompt: submittedInputs.prompt,
          ...videoWorkflowImageRequestFields(submittedInputs),
          reference_audio_urls: submittedInputs.referenceAudioUrls,
          audio_url: submittedInputs.audioUrl,
          negative_prompt: task.negativePrompt || "",
          duration: targetDuration,
          aspect_ratio: submittedAspectRatio,
          resolution: selectedResolution,
          resolution_tier: selectedResolution,
          ...(task.fps !== undefined ? { fps: task.fps } : {}),
          ...(task.seed !== undefined ? { seed: task.seed } : {}),
          ...(submittedGenerateAudio !== undefined ? { generate_audio: submittedGenerateAudio } : {}),
          ...(submittedReferenceAssetRefs.length > 0 ? { reference_asset_refs: submittedReferenceAssetRefs } : {}),
          source_video_url: submittedInputs.sourceVideoUrl,
          task_label: `任务${task.cardIndex}`,
          batch_id: task.batchId,
          batch_topic: task.batchTopic,
          card_index: task.cardIndex,
          surface: "video-page",
          ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
        }),
      });
      const data = await res.json();

      // A concurrent termination request owns this card once the server has
      // confirmed it. Do not let the older submit response paint it active.
      if (cancelledRef.current.has(localId)) return;

      if (res.status === 402 && (data.error_code === "INSUFFICIENT_CASH_BALANCE" || data.code === "INSUFFICIENT_CASH_BALANCE")) {
        // Only the site wallet precheck can request a user recharge.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("insufficient-balance", { detail: { mode: "cash" } }));
        }
        setTasks((prev) =>
          prev.map((t) =>
            t.localId === localId
              ? { ...t, status: "failed", errorMessage: data.error || "余额不足，请充值后重试", clientRequestId: "", clientRequestFingerprint: "" }
              : t
          )
        );
        clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
        toast.error("余额不足，请充值后重试");
        return;
      }

      // A business task id proves only that our durable reservation exists. It
      // does not prove that a provider request was dispatched. Admission and
      // pre-dispatch failures must never be painted as an upstream queue.
      if (data.task_submitted === false) {
        const releasePending = data.error_code === "VIDEO_ADMISSION_RELEASE_UNCONFIRMED"
          || data.status === "billing_pending";
        const failureMessage = data.error || data.message || "任务未提交供应商";
        if (!releasePending) {
          clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
        }
        setTasks((previous) => previous.map((item) => item.localId === localId
          ? {
              ...item,
              taskId: data.task_id || data.taskId || data.business_task_id || item.taskId,
              status: "failed",
              errorMessage: failureMessage,
              statusDetail: releasePending ? "预算释放状态核对中，请保留原请求号" : failureMessage,
              ...(releasePending ? {} : { clientRequestId: "", clientRequestFingerprint: "" }),
            }
          : item));
        if (releasePending) toast.info(failureMessage);
        else toast.error(failureMessage);
        refreshHistoryFirstPage();
        return;
      }

      if (data.task_id || data.taskId || (data.status === "failed" && data.business_task_id)) {
        const taskId = data.task_id || data.taskId || data.business_task_id;
        // 同步模式：直接返回视频URL
        if (data.status === "failed") {
          clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
          const failureMessage = data.error || "所选模型生成失败";
          setTasks(previous => previous.map(item => item.localId === localId ? { ...item, taskId, status: "failed", errorMessage: failureMessage, clientRequestId: "", clientRequestFingerprint: "" } : item));
          toast.error(failureMessage);
          refreshHistoryFirstPage();
        } else if (data.status === "completed" && data.video_url) {
          clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
          setTasks((prev) =>
            prev.map((t) =>
              t.localId === localId
                ? { ...t, taskId, businessTaskId: videoCacheSubmissionBinding(t, clientRequestId, data.business_task_id), status: "completed", videoUrl: data.video_url }
                : t
            )
          );
          toast.success(`任务${task.cardIndex}生成完成！`);
          // 同步到历史对话记录（刷新不丢失）
          syncTaskToConversation(task, taskId, selectedModel?.modelName || selectedModelId, { status: "completed", videoUrl: data.video_url });
          // 刷新余额
          if (auth?.token) {
            fetch("/api/cash/balance", {
              headers: { Authorization: `Bearer ${auth.token}` },
            })
              .then((r) => r.json())
              .then((bal) => {
                setCashBalance(bal.balance ?? 0);
              })
              .catch(() => {});
          }
          // 刷新历史
          refreshHistoryFirstPage();
        } else if (data.status === "cancelled") {
          clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
          cancelledRef.current.add(localId);
          setTasks((prev) => prev.map((item) => item.localId === localId
            ? {
                ...item,
                taskId,
                status: "cancelled",
                errorMessage: "已手动终止",
                statusDetail: data.message || "任务已终止",
                clientRequestId: "",
                clientRequestFingerprint: "",
                pollStuckCount: 0,
                progress: undefined,
              }
            : item));
          toast.info(`任务${task.cardIndex}已终止`);
          refreshHistoryFirstPage();
        } else {
          // 异步模式：已提交成功，等待上游排队/渲染
          const confirmationPending = videoSubmissionConfirmationSignal(data) === true;
          setTasks((prev) =>
            prev.map((t) =>
              t.localId === localId
                ? { ...t, taskId, businessTaskId: videoCacheSubmissionBinding(t, clientRequestId, data.business_task_id), modelId: currentModel.id, modelName: currentModel.name, contentUrl: data.content_url || "", status: "queued", processingStage: confirmationPending ? "confirming_submission" : undefined }
                : t
            )
          );
          toast.info(confirmationPending ? "正在确认结果" : `任务${task.cardIndex}已提交，正在排队生成...`);
          // 同步到历史对话记录（刷新不丢失）
          syncTaskToConversation(task, taskId, selectedModel?.modelName || selectedModelId, { status: "processing" });
          refreshHistoryFirstPage();
        }
      } else {
        const rawErr = data.error || "提交失败";
        const rawMessage = typeof rawErr === "string" ? rawErr : (rawErr?.message || rawErr?.msg || JSON.stringify(rawErr));
        const errMsg = classifyVideoError(rawMessage);
        const preserveAmbiguousAttempt = isAmbiguousAutodlH3SubmissionStatus(res.status);
        if (!preserveAmbiguousAttempt) {
          clearBrowserClientAttempt(videoClientAttemptScope(identity.userId, task), clientRequestId);
        }
        // 上游明确失败 → 直接反馈，不静默重试（用户可见、可控）
        setTasks((prev) =>
          prev.map((t) =>
            t.localId === localId
              ? {
                  ...t,
                  status: "failed",
                  errorMessage: errMsg,
                  ...(preserveAmbiguousAttempt ? {} : { clientRequestId: "", clientRequestFingerprint: "" }),
                }
              : t
          )
        );
        if (preserveAmbiguousAttempt) toast.info(`任务${task.cardIndex}结果待确认，请查询原任务`);
        else toast.error(`任务${task.cardIndex}提交失败：${classifyVideoError(errMsg)}`);
        reportVideoSubmitFailed(selectedModelId || "unknown", errMsg);
      }
    } catch (err) {
      if (cancelledRef.current.has(localId)) return;
      const msg = err instanceof DOMException && err.name === "AbortError"
        ? "暂未收到提交结果，请查询原任务"
        : err instanceof TypeError
          ? "网络连接中断，原请求已保留，请查询原任务"
          : "暂时无法确认提交结果，请查询原任务";
      setTasks((prev) =>
        prev.map((t) =>
          t.localId === localId
            ? { ...t, status: "failed", errorMessage: msg }
            : t
        )
      );
      toast.info(`任务${task.cardIndex}结果待确认：${msg}`);
      reportVideoSubmitFailed(selectedModelId || "unknown", msg);
    }
  };

  // SSE 回调创建得早于 generate 函数声明，使用 ref 保持它始终调用最新的提交逻辑。

  /* ── Status badge ── */
  const statusBadge = (status: TaskCard["status"], uncertain = false) => {
    if (uncertain) return <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center whitespace-nowrap text-[11px] font-medium leading-none text-[var(--text-secondary)]">结果待确认</span>;
    switch (status) {
      case "idle":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-[var(--text-secondary)]">
            <Clock className="h-3 w-3 shrink-0" /> 待配置
          </span>
        );
      case "pending":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> 提交中
          </span>
        );
      case "queued":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-amber-600 dark:text-amber-400">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> 排队中
          </span>
        );
      case "processing":
      case "generating":
      case "finalizing":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-[var(--primary)]">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> 渲染中
          </span>
        );
      case "completed":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3 shrink-0" /> 已完成
          </span>
        );
      case "failed":
        return (
          <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium leading-none text-red-600 dark:text-red-400">
            <AlertCircle className="h-3 w-3 shrink-0" /> 失败
          </span>
        );
    }
  };

  /* ── Resolve title/desc color (fallback to theme primary) ── */
  const resolveTitleColor = pageConfig.titleColor || "var(--primary)";
  const resolveDescColor = pageConfig.descColor || "var(--text-secondary)";

  /* ── Batch download ── */
  const downloadableHistory = history.filter((t) => t.status === "completed" && (t.videoUrl || t.storageUrl));
  const videoHistoryItems: VideoHistoryItem[] = history.map((task) => ({
    taskId: task.id,
    batchId: task.batchId,
    batchTopic: task.batchTopic,
    // The AI video page persists cardIndex as one-based; the shared history
    // policy sorts zero-based card positions for both workbenches.
    cardIndex: Number.isInteger(task.cardIndex) && Number(task.cardIndex) > 0 ? Number(task.cardIndex) - 1 : undefined,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt || undefined,
    posterUrl: task.thumbnailUrl || task.firstFrameUrl || undefined,
    modelName: task.modelName,
    duration: task.durationSeconds,
    videoUrl: task.videoUrl,
    storageUrl: task.storageUrl,
    taskLabel: task.taskLabel,
    prompt: task.prompt,
    resolution: task.resolution,
    aspectRatio: task.aspectRatio,
    durationSeconds: task.durationSeconds,
    billingState: task.billingState,
    priceCharged: task.priceCharged,
    errorMessage: task.errorMessage,
    canRetry: task.canRetry === true,
  }));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === downloadableHistory.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(downloadableHistory.map((t) => t.id)));
    }
  };

  const batchDownload = async () => {
    // 优先从当前任务卡片下载（支持按卡片序号命名）
    const completedTasks: { videoUrl: string; cardIndex?: number; batchTopic?: string; taskLabel?: string; storageUrl?: string; taskId?: string }[] = tasks.filter((t) => t.status === "completed" && (t.videoUrl || t.storageUrl));
    const selectedHistTasks: { videoUrl: string; cardIndex?: number; batchTopic?: string; taskLabel?: string; storageUrl?: string; id?: string }[] = downloadableHistory.filter((t) => selectedIds.has(t.id));
    const selected = showHistory ? selectedHistTasks : completedTasks;
    if (selected.length === 0) return;

    setIsBatchDownloading(true);

    try {
      await sequentialDownload(selected);
    } finally {
      setIsBatchDownloading(false);
    }
  };

  /* ── Download single video ── */
  const downloadVideo = async (videoUrl: string, fileName: string, taskId?: string, _storageUrl?: string) => {
    try {
      const token = auth?.token || "";
      if (!taskId) throw new Error("缺少视频任务编号");
      const proxyUrl = await requestVideoAccessUrl(taskId, token, {
        scope: "download",
        filename: fileName,
      });

      const a = document.createElement("a");
      a.href = proxyUrl;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error("下载视频失败:", err);
      toast.error(err instanceof Error ? err.message : "下载失败，请重试");
    }
  };

  /* ── Generate download file name ── */
  const generateFileName = (task: { cardIndex?: number; batchTopic?: string; taskLabel?: string }, fallbackIdx: number): string => {
    if (task.cardIndex) {
      const topic = task.batchTopic || "";
      const safeTopic = topic.replace(/[/\\?%*:|"<>]/g, "_").substring(0, 20);
      return safeTopic ? `${task.cardIndex}_${safeTopic}` : `任务${task.cardIndex}`;
    }
    return (task.taskLabel || `任务${fallbackIdx + 1}`).replace(/[/\\?%*:|"<>]/g, "_");
  };

  const sequentialDownload = async (items: { videoUrl: string; cardIndex?: number; batchTopic?: string; taskLabel?: string; taskId?: string; id?: string; storageUrl?: string }[]) => {
    for (let i = 0; i < items.length; i++) {
      const task = items[i];
      try {
        await downloadVideo(task.videoUrl, generateFileName(task, i) + ".mp4", task.taskId || task.id, task.storageUrl);
        // Small delay between downloads to avoid browser blocking
        if (i < items.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        // Skip failed downloads
      }
    }
  };

  /* ── Render ── */
  return (
    <div className="secondary-workbench voice-studio-root vs-workbench h-screen overflow-hidden flex flex-col">
      {/* ── Top bar ── */}
      {!showHistory && <SubPageHeader
        title="AI 视频创作台"
        subtitle="单图 / 首尾帧视频生成 · 批量任务 · 高清输出"
        backHref="/"
        rightSlot={
          <div className="flex items-center gap-1.5">
            {isAdmin && (
              <NavButton icon={Settings2} label="设置" variant="ghost" active={showConfigPanel} onClick={() => setShowConfigPanel(!showConfigPanel)} />
            )}
            <NavButton icon={RefreshCw} label="新批次" variant="ghost" onClick={() => {
              if (tasksRef.current.some(requiresVideoTaskTracking)) { toast.info("仍有视频任务待确认，请在完成后新建批次"); return; }
              const bid = `batch_${Date.now()}`;
              setCurrentBatchId(bid);
              currentCardCounter.current = 1;
              setBatchTopic("");
              setTasks([
                emptyCard(nextLocalId.current++, 1, bid, ""),
                emptyCard(nextLocalId.current++, 2, bid, ""),
                emptyCard(nextLocalId.current++, 3, bid, ""),
              ]);
            }} />
            <NavButton icon={History} label="历史" variant="ghost" active={showHistory} onClick={() => setShowHistory(!showHistory)} />
          </div>
        }
      />}

      {/* ── Admin config panel ── */}
      {isAdmin && showConfigPanel && !showHistory && (
        <div className="border-b border-[var(--border)] bg-[var(--card)]/60 backdrop-blur-md">
          <div className="mx-auto w-full max-w-[1760px] px-3 py-4 sm:px-6">
            <div className="flex items-center gap-2 mb-3">
              <Palette className="w-4 h-4 text-[var(--primary)]" />
              <span className="text-sm font-medium">页面配置</span>
              <span className="text-xs text-[var(--text-secondary)]">仅管理员可见</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Title color */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <Palette className="w-3 h-3" /> 标题颜色
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={pageConfig.titleColor || "#8B5CF6"}
                    onChange={(e) => updateConfig({ titleColor: e.target.value })}
                    className="w-8 h-8 rounded cursor-pointer border border-[var(--border)] bg-transparent"
                  />
                  <Input
                    value={pageConfig.titleColor}
                    onChange={(e) => updateConfig({ titleColor: e.target.value })}
                    placeholder="留空跟随主题"
                    className="h-8 text-xs bg-[var(--background)] border-[var(--border)]"
                  />
                </div>
              </div>
              {/* Title size */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <Type className="w-3 h-3" /> 标题大小: {pageConfig.titleSize}px
                </label>
                <input
                  type="range"
                  min={20}
                  max={56}
                  value={pageConfig.titleSize}
                  onChange={(e) => updateConfig({ titleSize: Number(e.target.value) })}
                  className="w-full accent-[var(--primary)]"
                />
              </div>
              {/* Description color */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <Palette className="w-3 h-3" /> 描述颜色
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={pageConfig.descColor || "#94A3B8"}
                    onChange={(e) => updateConfig({ descColor: e.target.value })}
                    className="w-8 h-8 rounded cursor-pointer border border-[var(--border)] bg-transparent"
                  />
                  <Input
                    value={pageConfig.descColor}
                    onChange={(e) => updateConfig({ descColor: e.target.value })}
                    placeholder="留空跟随主题"
                    className="h-8 text-xs bg-[var(--background)] border-[var(--border)]"
                  />
                </div>
              </div>
              {/* Description size */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <Type className="w-3 h-3" /> 描述大小: {pageConfig.descSize}px
                </label>
                <input
                  type="range"
                  min={12}
                  max={22}
                  value={pageConfig.descSize}
                  onChange={(e) => updateConfig({ descSize: Number(e.target.value) })}
                  className="w-full accent-[var(--primary)]"
                />
              </div>
              {/* Title Y position */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <MoveVertical className="w-3 h-3" /> 标题上下: {pageConfig.titleOffsetY}px
                </label>
                <input
                  type="range"
                  min={-40}
                  max={40}
                  value={pageConfig.titleOffsetY}
                  onChange={(e) => updateConfig({ titleOffsetY: Number(e.target.value) })}
                  className="w-full accent-[var(--primary)]"
                />
              </div>
              {/* Desc Y position */}
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-secondary)] flex items-center gap-1">
                  <MoveVertical className="w-3 h-3" /> 描述上下: {pageConfig.descOffsetY}px
                </label>
                <input
                  type="range"
                  min={-40}
                  max={40}
                  value={pageConfig.descOffsetY}
                  onChange={(e) => updateConfig({ descOffsetY: Number(e.target.value) })}
                  className="w-full accent-[var(--primary)]"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPageConfig(DEFAULT_CONFIG);
                  saveConfig(DEFAULT_CONFIG);
                }}
                className="text-xs gap-1"
              >
                <RefreshCw className="w-3 h-3" /> 重置默认
              </Button>
              <span className="text-xs text-[var(--text-secondary)]">点击标题/描述可直接编辑文本</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1760px] px-3 pb-2 pt-1 sm:px-6 sm:pb-3 sm:pt-2" data-video-creator-layout>
          {(localVideoCache.failedCount > 0 || localVideoCache.removalWarning) && (
            <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)]">
              <span>{localVideoCache.removalWarning || `有 ${localVideoCache.failedCount} 个视频暂未保存到本机，可重试或下载到电脑。`}</span>
              {localVideoCache.failedCount > 0 && <button type="button" className="underline" onClick={localVideoCache.retry}>重试本机保存</button>}
            </div>
          )}
          {showHistory ? (
            <MediaHistoryWorkspace
              initialCategory="video-production"
              onBack={closeUnifiedHistory}
              onRecoveryToggle={handleHistoryRecoveryToggle}
              onRetryVideo={(taskId) => void prepareUnifiedHistoryRetry(taskId)}
              recoveryContent={(
            <div>
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">生成历史</h2>
                  <span className="text-xs text-[var(--text-secondary)]">
                    视频走原始链路实时预览 · 源有效即可播放或下载 · 长期保存请下载到电脑
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {downloadableHistory.length > 0 && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={selectAll}
                        className="gap-1.5 text-xs text-[var(--text-secondary)]"
                      >
                        <CheckSquare className="w-3.5 h-3.5" />
                        {selectedIds.size === downloadableHistory.length ? "取消全选" : "全选"}
                      </Button>
                      {selectedIds.size > 0 && (
                        <Button
                          size="sm"
                          onClick={batchDownload}
                          disabled={isBatchDownloading}
                          className="brand-action gap-1.5 text-xs"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {isBatchDownloading ? "下载中..." : `下载到电脑 (${selectedIds.size})`}
                        </Button>
                      )}
                    </>
                  )}
                  <Button variant="ghost" size="sm" onClick={refreshRecoveryHistory} disabled={historyLoading} className="gap-1.5 text-[var(--text-secondary)]">
                    <RefreshCw className={`w-3.5 h-3.5${historyLoading ? " animate-spin" : ""}`} /> {historyLoading ? "读取中…" : "刷新"}
                  </Button>
                </div>
              </div>
              <VideoHistoryPanel
                  open
                  presentation="inline"
                  surface="video-page"
                  userId={identity.userId}
                  token={auth?.token || ""}
                  items={videoHistoryItems}
                  loading={historyLoading}
                  error={historyError}
                  onClose={closeUnifiedHistory}
                  onRefresh={() => refreshRecoveryHistory()}
                  hasMore={historyNextOffset !== null}
                  onLoadMore={() => { if (historyNextOffset !== null) loadHistory(historyNextOffset, { purpose: "panel" }); }}
                  onRetry={(taskId) => { const saved = history.find((task) => task.id === taskId); if (saved) prepareHistoryRetry(saved); }}
                  selectedTaskIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onCleared={(ids) => {
                    localVideoCache.onHistoryCleared(ids);
                    setHistory((previous) => previous.filter((task) => !ids.includes(task.id)));
                    setSelectedIds((previous) => new Set([...previous].filter((id) => !ids.includes(id))));
                  }}
                />
          </div>
              )}
            />
        ) : (
            /* ── Creator View ── */
            <>
              {modelsLoading && <p role="status" aria-live="polite" className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text-secondary)]">视频模型目录加载中，可先填写提示词和准备素材…</p>}
              {modelsLoadError && <p role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{modelsLoadError}</p>}
              {historyRetryNotice && <p role="status" aria-live="polite" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">{historyRetryNotice}</p>}
              {taskRecoveryNotice && <p role="status" aria-live="polite" className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">{taskRecoveryNotice}</p>}
              {taskRecoveryError && (
                <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                  <span>{taskRecoveryError}。可继续填写新任务；原任务同步完成前请勿重复提交。</span>
                  <Button variant="outline" size="sm" onClick={() => setTaskRecoveryAttempt((current) => current + 1)} className="h-7 gap-1 text-xs">
                    <RefreshCw className="h-3.5 w-3.5" />重新同步
                  </Button>
                </div>
              )}
              <div className="flex flex-col items-stretch gap-4 xl:flex-row xl:items-start">
                <aside className="w-full shrink-0 self-start overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-sm xl:sticky xl:top-2 xl:w-[312px]" aria-label="视频模型列表" data-video-model-list>
                  <div className="border-b border-[var(--border)] bg-[var(--muted)]/35 px-4 py-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold">视频模型</h2>
                      <span className="text-xs text-[var(--text-secondary)]">{models.length} 个</span>
                    </div>
                  </div>
                  <div className="max-h-72 space-y-1.5 overflow-y-auto p-2.5 xl:max-h-[calc(100vh-190px)]">
                    {modelsLoading ? (
                      <p role="status" className="px-2 py-4 text-center text-xs text-[var(--text-secondary)]">模型目录加载中…</p>
                    ) : models.length === 0 ? (
                      <p className="px-2 py-4 text-center text-xs text-[var(--text-secondary)]">当前暂无可用视频模型，请稍后刷新重试</p>
                    ) : models.map((model) => {
                      const modelPrice = model.generationReady === false ? model.pricePerUse : resolveVideoResolution(model, model.defaultResolution).publicPrice;
                      const selected = model.id === selectedModelId;
                      const selectable = model.available && model.generationReady;
                      const inputLabel = videoModelInputLabel(model);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          data-video-model-id={model.id}
                          disabled={!selectable}
                          aria-pressed={selected}
                          onClick={() => { if (selectable) setSelectedModelId(model.id); }}
                          className={`group min-h-[76px] w-full min-w-0 max-w-full rounded-md border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] ${selected ? "brand-action" : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--primary)]/35 hover:bg-[var(--muted)]/45"} ${selectable ? "" : "cursor-not-allowed opacity-70"}`}
                          title={model.name}
                        >
                          <span className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
                            <ModelBadge
                              name={model.name}
                              avatarUrl={model.avatarUrl}
                              identity={[model.displayName, model.provider, model.id]}
                              selected={selected}
                              availability={selectable ? "ready" : "unavailable"}
                              data-video-model-avatar="true"
                            />
                            <span className="min-w-0 max-w-full">
                              <span className="line-clamp-2 block text-[14px] font-semibold leading-5 text-[var(--foreground)] group-aria-pressed:text-[var(--brand-action-fg)]">{model.name}</span>
                              {inputLabel && <span className="mt-0.5 block whitespace-normal break-words text-[12px] leading-4 text-[var(--text-secondary)] group-aria-pressed:text-[var(--brand-action-fg)]" title={videoModelInputHint(model)}>{inputLabel}</span>}
                            </span>
                            <span data-video-model-price className="col-start-2 min-w-0 max-w-full justify-self-start whitespace-normal break-words rounded border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 text-[12px] font-semibold leading-4 text-[var(--foreground)] [overflow-wrap:anywhere]">
                              {getVideoBillingUnit(model) === "token" ? model.generationReady === false ? "Token 计价" : videoTokenRateLabel(model, model.defaultResolution) : !model.priceReady ? "—" : modelPrice === 0 ? "免费" : `¥${modelPrice.toFixed(2)}${getVideoBillingUnit(model) === "output_second" ? "/秒" : "/次"}`}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </aside>
                <div className="w-full min-w-0 flex-1">
              {/* Global Config Bar */}
              <div className="relative z-20 mb-4 overflow-visible rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm lg:p-5">
                {/* Cash balance bar */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Wallet className="w-4 h-4 text-[var(--primary)]" />
                    <span className="text-[var(--text-secondary)]">现金余额</span>
                    <span className="font-bold text-[var(--primary)]">¥{cashBalance.toFixed(2)}</span>
                    <button
                      onClick={() => setCashRechargeOpen(true)}
                      className="ml-1 px-2 py-0.5 text-xs rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
                    >
                      + 充值
                    </button>
                  </div>
                  {selectedModel && !selectedModelSubmissionUnavailable && (
                    <div className="text-xs text-[var(--text-secondary)]">
                      {getVideoBillingUnit(selectedModel) === "token" ? videoTokenRateLabel(selectedModel, selectedResolution) : <>单条预计：<span className="text-yellow-500 font-bold">¥{selectedPrice.toFixed(2)}</span></>}
                      {getVideoBillingUnit(selectedModel) !== "token" && cashBalance < selectedPrice && (
                        <span className="ml-2 text-red-500 font-medium">余额不足</span>
                      )}
                    </div>
                  )}
                </div>
                {selectedModel && !selectedModelSubmissionUnavailable && getVideoBillingUnit(selectedModel) === "token" && <div className="mb-3 text-xs text-[var(--foreground)]">
                  <label htmlFor="video-token-max-charge">每条任务本次最多自动扣款 ¥</label>
                  <Input id="video-token-max-charge" aria-label="每条视频本次最多自动扣款金额" type="text" inputMode="decimal" autoComplete="off" placeholder="请填写金额（最多两位小数）" className="mt-1 max-w-xs"
                    value={tokenChargeConsent?.modelId === selectedModel.id && tokenChargeConsent.priceVersion === selectedModel.tokenPricing?.priceVersion ? tokenChargeConsent.amount : ""}
                    onChange={event => setTokenChargeConsent({ modelId: selectedModel.id, priceVersion: selectedModel.tokenPricing?.priceVersion || "", amount: event.target.value })} />
                  <p className="mt-1 text-[var(--muted-foreground)]">按实际 Token 用量结算；预留不是扣费，超额待确认。每次点击生成均使用当前额度。</p>
                  {selectedInputCapabilities.supportsSourceVideoInput && <p className="mt-1 text-[var(--muted-foreground)]">使用源视频：{videoTokenRateLabel(selectedModel, selectedResolution, true)}；未使用源视频：{videoTokenRateLabel(selectedModel, selectedResolution, false)}</p>}
                </div>}
                {selectedModelSubmissionUnavailable ? null : <div className="flex flex-wrap items-start gap-4">
                  {/* Aspect ratio */}
                  <div className="flex min-w-[190px] flex-1 flex-col">
                    <label className="mb-2 block h-4 text-xs font-medium leading-4 text-[var(--text-secondary)]">
                      视频比例{selectedModel?.firstFrameRatioPolicy === "adaptive" && "（有首帧时跟随首帧比例）"}
                    </label>
                    <Select
                      value={aspectRatio.label}
                      onValueChange={(v) => {
                        const found = AI_VIDEO_PAGE_ASPECT_RATIOS.find((r) => r.label === v);
                        if (found) setAspectRatio(found);
                      }}
                    >
                    <SelectTrigger aria-label="视频比例" className="h-10 w-full border-[var(--input)] bg-[var(--card)] text-[var(--foreground)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent
                        position="popper"
                        align="start"
                        sideOffset={6}
                        className="z-[80] w-[var(--radix-select-trigger-width)] min-w-[190px] max-w-[min(620px,calc(100vw-2rem))] border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl"
                        style={{
                          backgroundColor: "var(--popover)",
                          borderColor: "var(--border)",
                          width: "min(320px, calc(100vw - 2rem))",
                          maxWidth: "calc(100vw - 2rem)",
                        }}
                      >
                        {supportedAspectRatios.map((r) => (
                          <SelectItem key={r.label} value={r.label}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Resolution */}
                  {resolutionCapabilities.options.length > 0 ? (
                    <div className="flex min-w-[180px] flex-1 flex-col">
                      <label className="mb-2 block h-4 text-xs font-medium leading-4 text-[var(--text-secondary)]">
                        视频分辨率
                      </label>
                      {resolutionCapabilities.options.length > 1 ? (
                        <Select value={selectedResolution} onValueChange={setResolution}>
                          <SelectTrigger aria-label="视频分辨率" className="h-10 w-full border-[var(--input)] bg-[var(--card)] text-[var(--foreground)]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent
                            position="popper"
                            align="start"
                            sideOffset={6}
                            className="z-[80] w-[var(--radix-select-trigger-width)] min-w-[180px] max-w-[min(620px,calc(100vw-2rem))] border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl"
                            style={{
                              backgroundColor: "var(--popover)",
                              borderColor: "var(--border)",
                              width: "min(320px, calc(100vw - 2rem))",
                              maxWidth: "calc(100vw - 2rem)",
                            }}
                          >
                            {resolutionCapabilities.options.map((value) => (
                              <SelectItem key={value} value={value}>
                                {resolutionCapabilities.labels[value] || value} · {getVideoBillingUnit(selectedModel) === "token" ? videoTokenRateLabel(selectedModel, value) : `¥${resolveVideoResolution(selectedModel, value).publicPrice.toFixed(2)}${getVideoBillingUnit(selectedModel) === "output_second" ? "/秒" : ""}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <div className="flex h-10 items-center rounded-md border border-[var(--input)] bg-[var(--muted)]/45 px-3 text-sm">
                          {resolutionCapabilities.labels[selectedResolution] || selectedResolution}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex min-w-[180px] flex-1 flex-col">
                      <label className="mb-2 block h-4 text-xs font-medium leading-4 text-[var(--text-secondary)]">
                        视频分辨率
                      </label>
                      <div className="flex h-10 items-center rounded-md border border-[var(--input)] bg-[var(--muted)]/45 px-3 text-sm text-[var(--text-secondary)]/70">
                        {selectedModel ? "模型自动决定" : "请先选择模型"}
                      </div>
                    </div>
                  )}

                  {/* Default shot duration */}
                  <div className="flex min-w-[180px] flex-1 flex-col">
                    <label className="mb-2 block h-4 text-xs font-medium leading-4 text-[var(--text-secondary)]">
                      {selectedModel?.requiresSourceVideo ? selectedDurationDisplay.label : `默认${selectedDurationDisplay.label}`}
                    </label>
                    {selectedModel?.requiresSourceVideo ? (
                      <div className="flex h-10 items-center rounded-md border border-[var(--input)] bg-[var(--muted)]/45 px-3 text-sm">随源视频时长</div>
                    ) : durationOptions.length > 1 ? (
                      <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                        <SelectTrigger aria-label="默认视频时长" className="h-10 w-full border-[var(--input)] bg-[var(--card)] text-[var(--foreground)]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          align="start"
                          sideOffset={6}
                          className="z-[80] w-[var(--radix-select-trigger-width)] min-w-[180px] max-w-[min(620px,calc(100vw-2rem))] border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl"
                          style={{
                            backgroundColor: "var(--popover)",
                            borderColor: "var(--border)",
                            width: "min(320px, calc(100vw - 2rem))",
                            maxWidth: "calc(100vw - 2rem)",
                          }}
                        >
                          {durationOptions.map((d) => {
                            return (
                              <SelectItem key={d} value={String(d)}>
                                {d}秒
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="flex h-10 items-center rounded-md border border-[var(--input)] bg-[var(--muted)]/45 px-3 text-sm">
                        固定 {durationOptions[0] || duration} 秒
                      </div>
                    )}
                    {selectedDurationDisplay.description && <p className="mt-1.5 text-[11px] leading-4 text-[var(--text-secondary)]">{selectedDurationDisplay.description}</p>}
                    <VideoDurationBehaviorNotice durationBehavior={selectedModel?.durationBehavior} />
                  </div>

                </div>

                }
                {/* Batch topic & add task bar */}
                <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3">
                  <div className="flex w-full min-w-0 items-center gap-2 lg:w-auto lg:min-w-[280px] lg:flex-1">
                    <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">文案主题:</span>
                    <Input
                      aria-label="批次文案主题"
                      value={batchTopic}
                      onChange={(e) => {
                        setBatchTopic(e.target.value);
                        // 同步更新已有卡片的batchTopic
                        setTasks((prev) => prev.map((t) => requiresVideoTaskTracking(t) ? t : ({ ...t, batchTopic: e.target.value })));
                      }}
                      placeholder="例如：产品介绍、旅行Vlog..."
                      className="h-8 text-sm border-[var(--border)] bg-[var(--background)]"
                    />
                  </div>
                  <Button
                    onClick={addTask}
                    disabled={tasks.length >= 40}
                    className="gap-1.5 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 h-8"
                  >
	                    <Plus className="w-4 h-4" /> 添加任务{tasks.length > 0 ? `(${tasks.length}/40)` : ""}
	                  </Button>
	                  <Button onClick={() => setShowSmartImport(!showSmartImport)} variant="outline" className="gap-1.5 h-8 border-[var(--primary)]/40 text-[var(--primary)] hover:bg-[var(--primary)]/10">
	                    <Wand2 className="w-4 h-4" /> 智能导入
	                  </Button>
                    <input
                      ref={orderedImageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      className="hidden"
                      onChange={async (event) => {
                        await importOrderedImages(event.target.files);
                        event.currentTarget.value = "";
                      }}
                    />
                    <div className="flex h-8 overflow-hidden rounded-md border border-[var(--border)]">
                      <button
                        type="button"
                        onClick={() => setOrderedImageMode("reference")}
                        className={`px-2 text-[11px] font-semibold transition-colors ${orderedImageMode === "reference" ? "brand-action" : "text-[var(--text-secondary)] hover:bg-[var(--background)]"}`}
                      >
                        参考图
                      </button>
                      <button
                        type="button"
                        onClick={() => setOrderedImageMode("first-last")}
                        className={`border-l border-[var(--border)] px-2 text-[11px] font-semibold transition-colors ${orderedImageMode === "first-last" ? "brand-action" : "text-[var(--text-secondary)] hover:bg-[var(--background)]"}`}
                      >
                        首尾帧
                      </button>
                    </div>
                    <Button
                      type="button"
                      onClick={() => orderedImageInputRef.current?.click()}
                      disabled={isImportingOrderedImages || tasks.some(requiresVideoTaskTracking)}
                      variant="outline"
                      className="gap-1.5 h-8 border-[var(--primary)]/40 text-[var(--primary)] hover:bg-[var(--primary)]/10"
                      title={orderedImageMode === "reference" ? "按文件名顺序：1.png 到任务1参考图、2.png 到任务2参考图" : "按文件名顺序：1.png、2.png 到任务1首尾帧"}
                    >
                      {isImportingOrderedImages ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                      按序导入图片
                    </Button>
                  {tasks.length > 0 && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => setCardAction({ kind: "clear", targetIds: tasksRef.current.filter(task => !requiresVideoTaskTracking(task)).map(task => task.localId) })}
                        disabled={!tasks.some(task => !requiresVideoTaskTracking(task))}
                        title="清空可编辑卡片的提示词、参考素材和当前结果，保留卡片；生成中及待确认任务保留"
                        className="gap-1.5 h-8 border-yellow-500 text-yellow-600 hover:bg-yellow-50 hover:text-yellow-700 dark:hover:bg-yellow-950/30"
                      >
                        <Eraser className="w-4 h-4" /> 清空卡片内容
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setCardAction({ kind: "remove-all", targetIds: tasksRef.current.filter(task => !requiresVideoTaskTracking(task)).map(task => task.localId) })}
                        disabled={!tasks.some(task => !requiresVideoTaskTracking(task))}
                        title="移除当前可编辑卡片，生成中及待确认任务保留"
                        className="gap-1.5 h-8 border-red-300 text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="w-4 h-4" /> 移除可编辑卡片
                      </Button>
                    </>
                  )}
                  {tasks.length > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => { const last = tasksRef.current.at(-1); if (last) setCardAction({ kind: "remove-one", localId: last.localId }); }}
                      disabled={Boolean(tasks.at(-1) && requiresVideoTaskTracking(tasks.at(-1)!))}
                      title={tasks.at(-1) && requiresVideoTaskTracking(tasks.at(-1)!) ? "末张任务仍在生成或待确认，暂不能移除" : "移除末张卡片及其输入内容，其他卡片保留"}
                      aria-label="移除末张卡片"
                      className="gap-1.5 h-8 border-[var(--border)] text-[var(--text-secondary)] hover:text-red-400 hover:border-red-400/50"
                    >
                      <Trash2 className="w-4 h-4" /> 移除末张卡片
                    </Button>
                  )}
                  {tasks.filter(t => t.status === "completed").length > 1 && (
                    <Button
                      onClick={batchDownload}
                      disabled={isBatchDownloading}
                      className="gap-1.5 h-8"
                    >
                      {isBatchDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      批量下载
                    </Button>
                  )}
                </div>
                {/* Smart import area */}
                {showSmartImport && (
                  <div className="mt-3 p-3 rounded-xl bg-[var(--background)] border border-[var(--border)] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[var(--primary)]">智能导入提示词</span>
                      <span className="text-[10px] text-[var(--text-secondary)]">自动识别代码块+镜头分割，镜头一→任务一，镜头二→任务二</span>
                      <button onClick={() => { setShowSmartImport(false); setSmartImportText(""); }} className="text-[var(--text-secondary)] hover:text-[var(--foreground)]">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <textarea
                      value={smartImportText}
                      onChange={(e) => setSmartImportText(e.target.value)}
                      placeholder={"粘贴提示词文案，系统自动识别代码块并按镜头拆分。\n\n智能识别规则：\n· 优先提取代码块（```）中的内容，忽略外部分析文字\n· 镜头一/镜头二/分镜头N → 自动对应任务一/任务二/任务N\n· 段落一/段落二/第N段 → 自动对应任务卡片\n· 带标记：提示词：xxx / Prompt: xxx\n· 负向提示词 → 合并到主提示词"}
                      className="w-full h-40 max-h-60 text-sm p-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--text-secondary)]">
                        {smartImportText.trim() ? `识别到 ${estimatePromptCount(smartImportText)} 段提示词` : "请粘贴提示词文案"}
                      </span>
                      <Button
                        onClick={handleSmartImport}
                        disabled={!smartImportText.trim() || tasks.some(requiresVideoTaskTracking)}
                        className="gap-1.5 h-8 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                      >
                        <Wand2 className="w-4 h-4" /> 一键导入
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Task Cards + Chat Panel */}
              <div className="flex min-w-0 items-start gap-4">
                {/* Task Cards */}
                <div
                  className="grid min-w-0 flex-1 gap-4"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
                >
                {tasks.map((task) => {
                  const confirmingVideoSubmission = isActiveVideoTaskStatus(task.status) && videoSubmissionConfirmationSignal(task) === true;
                  const cardModel = requiresVideoTaskTracking(task) || task.taskId ? task.modelSnapshot || models.find((model) => model.id === task.modelId) : selectedModel;
                  const cardCapabilitiesUnverified = !requiresVideoTaskTracking(task) && !task.taskId && selectedModelSubmissionUnavailable;
                  const cardInputCapabilities = getAiVideoPageInputCapabilities(cardModel);
                  const cardDurationDisplay = videoDurationDisplay(cardModel);
                  return (
                  <div
                    key={task.localId}
                    className={`min-w-0 overflow-hidden rounded-lg border bg-[var(--card)] shadow-sm transition-[border-color,box-shadow] duration-200 ${
                      task.status === "completed"
                        ? "border-emerald-500/40 shadow-emerald-500/10 shadow-lg"
                        : task.status === "failed" && !requiresVideoTaskTracking(task)
                          ? "border-red-500/30"
                          : "border-[var(--border)] hover:border-[var(--primary)]/30"
                    }`}
                    data-video-task-card
                  >
                    {/* Card header */}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-[var(--border)] bg-[var(--background)]/50 px-3 py-2.5">
                      <div className="min-w-[72px] flex-1">
                        <span className="text-sm font-semibold text-[var(--primary)]">任务{task.cardIndex}</span>
                        {(task.taskId || requiresVideoTaskTracking(task)) && <span className="mt-0.5 block truncate text-[11px] text-[var(--text-secondary)]" title={boundVideoTaskModel(task, models).name}>{boundVideoTaskModel(task, models).name}{task.resolution ? ` · ${task.resolution}` : ""}</span>}
                      </div>
                      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                        {cardCapabilitiesUnverified ? null : ((requiresVideoTaskTracking(task) || task.taskId) ? task.followsSourceDuration : cardInputCapabilities.requiresSourceVideo) ? (
                          <span className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border)] px-1.5 text-[11px]"><Clock className="h-3 w-3 shrink-0" />随源视频时长</span>
                        ) : (isActiveVideoTaskStatus(task.status) || task.status === "completed") && task.durationSeconds ? (
                          <span className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border)] px-1.5 text-[11px]"><Clock className="h-3 w-3 shrink-0" />{cardDurationDisplay.label} {task.durationSeconds} 秒</span>
                        ) : durationOptions.length > 1 ? (
                          <Select
                            value={task.durationSeconds === null ? "default" : String(task.durationSeconds)}
                            onValueChange={(value) => updateTask(
                              task.localId,
                              "durationSeconds",
                              value === "default" ? null : Number(value),
                            )}
                            disabled={requiresVideoTaskTracking(task)}
                          >
                            <SelectTrigger className="h-6 w-[124px] shrink-0 whitespace-nowrap border-[var(--border)] bg-[var(--card)] px-1.5 text-[11px]" aria-label={`任务${task.cardIndex}${cardDurationDisplay.label}`}>
                              <Clock className="h-3 w-3 shrink-0" />
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--background)] text-[var(--foreground)] border-[var(--border)] shadow-xl">
                              <SelectItem value="default">默认 {duration}秒</SelectItem>
                              {durationOptions.map((seconds) => {
                                return <SelectItem key={seconds} value={String(seconds)}>{seconds}秒</SelectItem>;
                              })}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--card)] px-1.5 text-[11px]">
                            <Clock className="h-3 w-3 shrink-0" />{cardDurationDisplay.label} {durationOptions[0] || duration} 秒
                          </span>
                        )}
                        {confirmingVideoSubmission
                          ? <span role="status" className="video-task-status-label inline-flex h-5 shrink-0 items-center whitespace-nowrap text-[11px] font-medium leading-none text-amber-600 dark:text-amber-400">正在确认结果</span>
                          : statusBadge(task.status, task.status === "failed" && requiresVideoTaskTracking(task))}
                        {tasks.length > 1 && task.status === "idle" && (
                          <button
                            type="button"
                            aria-label={`移除卡片 ${task.cardIndex}`}
                            title={`移除卡片 ${task.cardIndex} 及其输入内容`}
                            onClick={() => setCardAction({ kind: "remove-one", localId: task.localId })}
                            className="text-[var(--text-secondary)] hover:text-red-400 transition-colors p-0.5"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="p-4 space-y-3.5">
                      {cardCapabilitiesUnverified ? null : <fieldset disabled={requiresVideoTaskTracking(task)} className="min-w-0 space-y-3.5">
                      {cardModel && getVideoBillingUnit(cardModel) === "token" && <p className="text-xs text-[var(--muted-foreground)]">本条费率：{videoTokenRateLabel(cardModel, selectedResolution, Boolean(cardInputCapabilities.supportsSourceVideoInput && task.sourceVideoUrl))}</p>}
                      {/* Prompt */}
                      <div>
                        <label className="text-xs text-[var(--text-secondary)] mb-1.5 block font-medium">
                          提示词{cardInputCapabilities.supportsPrompt ? "" : "（此模型不使用）"}
                        </label>
                        <Textarea
                          aria-label={`任务${task.cardIndex}提示词`}
                          value={task.prompt}
                          onChange={(e) =>
                            updateTask(task.localId, "prompt", e.target.value)
                          }
                          placeholder={cardInputCapabilities.supportsPrompt ? "描述你想要的视频内容..." : "当前工作流由图片/音频驱动，无需提示词"}
                          className="bg-[var(--background)] border-[var(--border)] h-[80px] max-h-[160px] min-h-[60px] resize-none overflow-y-auto text-sm placeholder:text-[var(--text-secondary)]/50 focus:border-[var(--primary)]/50"
                          style={{ fieldSizing: "fixed" } as React.CSSProperties}
                          disabled={!cardInputCapabilities.supportsPrompt || requiresVideoTaskTracking(task)}
                        />
                        {cardInputCapabilities.supportsPrompt && !cardInputCapabilities.requiresSourceVideo && !task.followsSourceDuration && (() => {
                          const targetSeconds = task.durationSeconds ?? duration;
                          const promptSeconds = extractPromptDurationSeconds(task.prompt);
                          const hasConflict = promptSeconds !== null && promptSeconds !== targetSeconds;
                          if (!hasConflict) return null;
                          return (
                            <div className="mt-1.5 space-y-1 text-[11px] leading-4">
                              {hasConflict && (
                                <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <span>提示词写了 {promptSeconds} 秒，本次按任务卡的目标 {targetSeconds} 秒提交。</span>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>

                      {cardModel?.supportsGenerateAudioToggle === true && (
                        <div>
                          <span className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">声音</span>
                          <div
                            role="radiogroup"
                            aria-label={`任务${task.cardIndex}声音设置`}
                            className="inline-flex h-8 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]"
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-checked={task.generateAudio !== false}
                              onClick={() => updateTask(task.localId, "generateAudio", true)}
                              className={`px-3 text-[11px] font-medium transition-colors ${task.generateAudio !== false ? "brand-action" : "text-[var(--text-secondary)]"}`}
                            >
                              生成声音
                            </button>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={task.generateAudio === false}
                              onClick={() => updateTask(task.localId, "generateAudio", false)}
                              className={`border-l border-[var(--border)] px-3 text-[11px] font-medium transition-colors ${task.generateAudio === false ? "brand-action" : "text-[var(--text-secondary)]"}`}
                            >
                              静音
                            </button>
                          </div>
                        </div>
                      )}

                      {/* 图片输入区 — 首帧/尾帧折叠式 + 参考图整合模块 */}
                      <div className="space-y-1.5">
                        {/* 首帧 + 尾帧：半折叠交互，无图时窄条，有图自动展开 */}
                        {(cardInputCapabilities.showFirstFrame || cardInputCapabilities.showLastFrame) && (
                        <div className="flex items-start gap-2">
                          {/* 首帧 */}
                          {cardInputCapabilities.showFirstFrame && (
                          <div className="flex-1 min-w-0 space-y-1">
                            <span className="text-[12px] text-[var(--primary)] font-semibold block">首帧{cardInputCapabilities.requiresFirstFrame ? " *" : "（可选）"}</span>
                            {task.firstFrameUrl ? (
                              /* 有图 → 展开状态：aspect-video 预览 + URL输入 */
                              <>
                                <div className="video-frame-expanded relative rounded-lg overflow-hidden bg-[var(--background)] group/img aspect-video">
                                  <button
                                    type="button"
                                    className="block h-full w-full cursor-zoom-in border-0 bg-transparent p-0"
                                    aria-label={`放大查看任务${task.cardIndex}首帧`}
                                    disabled={!videoInputPreview(task.firstFrameUrl)}
                                    onClick={() => setInputImagePreview({ src: videoInputPreview(task.firstFrameUrl) || "", alt: `任务${task.cardIndex}首帧` })}
                                  >
                                    <img src={videoInputPreview(task.firstFrameUrl)} alt="首帧" className="h-full w-full object-contain" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`移除任务${task.cardIndex}首帧`}
                                    onClick={() => replaceTaskReferenceUrl(task.localId, "firstFrameUrl", "")}
                                    className="absolute top-1.5 right-1.5 z-10 w-5 h-5 bg-black/50 hover:bg-black/70 rounded-full flex items-center justify-center text-white opacity-0 group-hover/img:opacity-100 focus:opacity-100 transition-opacity"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                                <Input
                                  value={parseGeneratedImageReferenceUri(task.firstFrameUrl) ? "" : task.firstFrameUrl || ""}
                                  onChange={(e) => replaceTaskReferenceUrl(task.localId, "firstFrameUrl", e.target.value)}
                                  placeholder="生成图片引用，或粘贴图片URL替换"
                                  className="bg-[var(--background)] border-[var(--border)] text-[11px] h-7 mt-1.5 focus:border-[var(--primary)]/50"
                                />
                              </>
                            ) : (
                              /* 无图 → 半折叠：带边框上传按钮 */
                              <button
                                onClick={() => {
                                  const input = document.createElement("input");
                                  input.type = "file";
                                  input.accept = "image/*";
                                  input.onchange = async (e) => {
                                    const file = (e.target as HTMLInputElement).files?.[0];
                                    if (!file) return;
                                    if (file.size > 10 * 1024 * 1024) {
                                      alert("图片大小不能超过10MB");
                                      return;
                                    }
                                    // 先用 blob URL 做本地预览
                                    const previewUrl = URL.createObjectURL(file);
                                    replaceTaskReferenceUrl(task.localId, "firstFrameUrl", previewUrl);
                                    // 上传到服务器获取公网URL
                                    try {
                                      const uploaded = await uploadImageFile(file, auth?.token || null, referenceUploadSession);
                                      replaceTaskReferenceUrl(task.localId, "firstFrameUrl", uploaded.url, uploaded);
                                    } catch (err) {
                                      toast.error(`首帧上传失败: ${err instanceof Error ? err.message : err}`);
                                      replaceTaskReferenceUrl(task.localId, "firstFrameUrl", "");
                                    }
                                  };
                                  input.click();
                                }}
                                className="video-frame-collapsed w-full h-9 rounded-lg text-[var(--primary)] transition-all flex items-center justify-center gap-1.5 text-[13px] border-2 border-dashed border-[var(--primary)]/40 hover:border-[var(--primary)] hover:bg-[var(--primary)]/5 font-medium"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                上传首帧
                              </button>
                            )}
                          </div>
                          )}
                          {/* 尾帧 */}
                          {cardInputCapabilities.showLastFrame && (
                          <div className="flex-1 min-w-0 space-y-1">
                            <span className="text-[12px] text-[var(--primary)] font-semibold block">尾帧{cardInputCapabilities.requiresLastFrame ? " *" : "（可选）"}</span>
                            {task.lastFrameUrl ? (
                              /* 有图 → 展开状态 */
                              <>
                                <div className="video-frame-expanded relative rounded-lg overflow-hidden bg-[var(--background)] group/img aspect-video">
                                  <button
                                    type="button"
                                    className="block h-full w-full cursor-zoom-in border-0 bg-transparent p-0"
                                    aria-label={`放大查看任务${task.cardIndex}尾帧`}
                                    disabled={!videoInputPreview(task.lastFrameUrl)}
                                    onClick={() => setInputImagePreview({ src: videoInputPreview(task.lastFrameUrl) || "", alt: `任务${task.cardIndex}尾帧` })}
                                  >
                                    <img src={videoInputPreview(task.lastFrameUrl)} alt="尾帧" className="h-full w-full object-contain" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`移除任务${task.cardIndex}尾帧`}
                                    onClick={() => replaceTaskReferenceUrl(task.localId, "lastFrameUrl", "")}
                                    className="absolute top-1.5 right-1.5 z-10 w-5 h-5 bg-black/50 hover:bg-black/70 rounded-full flex items-center justify-center text-white opacity-0 group-hover/img:opacity-100 focus:opacity-100 transition-opacity"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                                <Input
                                  value={parseGeneratedImageReferenceUri(task.lastFrameUrl) ? "" : task.lastFrameUrl || ""}
                                  onChange={(e) => replaceTaskReferenceUrl(task.localId, "lastFrameUrl", e.target.value)}
                                  placeholder="生成图片引用，或粘贴图片URL替换"
                                  className="bg-[var(--background)] border-[var(--border)] text-[11px] h-7 mt-1.5 focus:border-[var(--primary)]/50"
                                />
                              </>
                            ) : (
                              /* 无图 → 半折叠：带边框上传按钮 */
                              <button
                                onClick={() => {
                                  const input = document.createElement("input");
                                  input.type = "file";
                                  input.accept = "image/*";
                                  input.onchange = async (e) => {
                                    const file = (e.target as HTMLInputElement).files?.[0];
                                    if (!file) return;
                                    if (file.size > 10 * 1024 * 1024) {
                                      alert("图片大小不能超过10MB");
                                      return;
                                    }
                                    const previewUrl = URL.createObjectURL(file);
                                    replaceTaskReferenceUrl(task.localId, "lastFrameUrl", previewUrl);
                                    try {
                                      const uploaded = await uploadImageFile(file, auth?.token || null, referenceUploadSession);
                                      replaceTaskReferenceUrl(task.localId, "lastFrameUrl", uploaded.url, uploaded);
                                    } catch (err) {
                                      toast.error(`尾帧上传失败: ${err instanceof Error ? err.message : err}`);
                                      replaceTaskReferenceUrl(task.localId, "lastFrameUrl", "");
                                    }
                                  };
                                  input.click();
                                }}
                                className="video-frame-collapsed w-full h-9 rounded-lg text-[var(--primary)] transition-all flex items-center justify-center gap-1.5 text-[13px] border-2 border-dashed border-[var(--primary)]/40 hover:border-[var(--primary)] hover:bg-[var(--primary)]/5 font-medium"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                上传尾帧
                              </button>
                            )}
                          </div>
                          )}
                        </div>
                        )}

                        {/* 参考图 — 整合模块：上传按钮 + URL输入，仅支持图片输入的模型显示 */}
                        {cardInputCapabilities.showReferenceImages && (
                        <div>
                          <span className="text-[12px] text-[var(--primary)] font-semibold mb-1 block">参考图{cardInputCapabilities.minReferenceImages > 0 ? " *" : "（可选）"}</span>
                          <div className="video-ref-module rounded-lg p-1.5 space-y-1.5">
                            {task.referenceImageUrl ? (
                              <div className="flex items-center gap-2">
                                <div className="relative shrink-0 group/ref">
                                  <button
                                    type="button"
                                    className="block h-10 w-10 cursor-zoom-in overflow-hidden rounded-md border border-[var(--border)] bg-transparent p-0 shadow-sm"
                                    aria-label={`放大查看任务${task.cardIndex}参考图`}
                                    disabled={!videoInputPreview(task.referenceImageUrl)}
                                    onClick={() => setInputImagePreview({ src: videoInputPreview(task.referenceImageUrl) || "", alt: `任务${task.cardIndex}参考图` })}
                                  >
                                    <img
                                      src={videoInputPreview(task.referenceImageUrl)}
                                      alt="参考"
                                      className="h-full w-full object-contain"
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`移除任务${task.cardIndex}参考图`}
                                    onClick={() => replaceTaskReferenceUrl(task.localId, "referenceImageUrl", "")}
                                    className="absolute -top-1 -right-1 z-10 w-4 h-4 bg-black/50 hover:bg-black/70 rounded-full flex items-center justify-center text-white opacity-0 group-hover/ref:opacity-100 focus:opacity-100 transition-opacity"
                                  >
                                    <X className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                                <Input
                                  value={parseGeneratedImageReferenceUri(task.referenceImageUrl) ? "" : task.referenceImageUrl}
                                  onChange={(e) => replaceTaskReferenceUrl(task.localId, "referenceImageUrl", e.target.value)}
                                  placeholder="生成图片引用，或粘贴图片URL替换"
                                  className="bg-[var(--background)] border-[var(--border)] text-[11px] h-8 flex-1 focus:border-[var(--primary)]/50"
                                />
                              </div>
                            ) : (
                              <>
                                <button
                                  onClick={() => {
                                    const input = document.createElement("input");
                                    input.type = "file";
                                    input.accept = "image/*";
                                    input.onchange = async (e) => {
                                      const file = (e.target as HTMLInputElement).files?.[0];
                                      if (!file) return;
                                      if (file.size > 10 * 1024 * 1024) {
                                        alert("图片大小不能超过10MB");
                                        return;
                                      }
                                      const previewUrl = URL.createObjectURL(file);
                                      replaceTaskReferenceUrl(task.localId, "referenceImageUrl", previewUrl);
                                      try {
                                        const uploaded = await uploadImageFile(file, auth?.token || null, referenceUploadSession);
                                        replaceTaskReferenceUrl(task.localId, "referenceImageUrl", uploaded.url, uploaded);
                                      } catch (err) {
                                        toast.error(`参考图上传失败: ${err instanceof Error ? err.message : err}`);
                                        replaceTaskReferenceUrl(task.localId, "referenceImageUrl", "");
                                      }
                                    };
                                    input.click();
                                  }}
                                  className="video-ref-upload w-full h-9 rounded-md text-[var(--text-secondary)] hover:text-[var(--primary)] transition-all flex items-center justify-center gap-1.5 text-[11px]"
                                >
                                  <Upload className="w-3.5 h-3.5 video-tech-pulse" />
                                  点击上传
                                </button>
                                <Input
                                  aria-label={`任务${task.cardIndex}参考图 URL`}
                                  value={parseGeneratedImageReferenceUri(task.referenceImageUrl) ? "" : task.referenceImageUrl || ""}
                                  onChange={(e) => replaceTaskReferenceUrl(task.localId, "referenceImageUrl", e.target.value)}
                                  placeholder="或粘贴图片URL后按回车添加"
                                  className="bg-[var(--background)] border-[var(--border)] text-[11px] h-8 focus:border-[var(--primary)]/50"
                                />
                              </>
                            )}
                          </div>
                        </div>
                        )}
                        {/* AutoDL H3 等多图工作流：补充参考图，首帧/尾帧/主参考图仍保留原语义。 */}
                        {cardInputCapabilities.showReferenceImages && cardInputCapabilities.maxReferenceImages > 1 && (() => {
                          const occupiedPrimary = [task.firstFrameUrl, task.lastFrameUrl, task.referenceImageUrl].filter(Boolean).length;
                          const supplementalMax = Math.max(0, cardInputCapabilities.maxReferenceImages - occupiedPrimary);
                          const images = task.referenceImageUrls || [];
                          return (
                            <div className="video-ref-module rounded-lg p-2 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[12px] text-[var(--primary)] font-semibold">补充参考图（总计最多 {cardInputCapabilities.maxReferenceImages} 张）</span>
                                <span className="text-[10px] text-[var(--text-secondary)]">当前 {occupiedPrimary + images.filter(Boolean).length} 张</span>
                              </div>
                              {images.map((url, imageIndex) => (
                                <div key={`ref-image-${imageIndex}`} className="flex items-center gap-2">
                                  {url && <button
                                    type="button"
                                    className="h-8 w-8 shrink-0 cursor-zoom-in overflow-hidden rounded border border-[var(--border)] bg-transparent p-0"
                                    aria-label={`放大查看任务${task.cardIndex}参考图${imageIndex + 1}`}
                                    disabled={!videoInputPreview(url)}
                                    onClick={() => setInputImagePreview({ src: videoInputPreview(url) || "", alt: `任务${task.cardIndex}参考图${imageIndex + 1}` })}
                                  ><img src={videoInputPreview(url)} alt={`参考图${imageIndex + 1}`} className="h-full w-full object-contain" /></button>}
                                  <Input
                                    value={parseGeneratedImageReferenceUri(url) ? "" : url}
                                    onChange={(event) => updateReferenceList(task.localId, "referenceImageUrls", (items) => items.map((item, index) => index === imageIndex ? event.target.value : item))}
                                    placeholder={`参考图 URL ${imageIndex + 1}`}
                                    className="h-8 flex-1 bg-[var(--background)] text-[11px]"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => updateReferenceList(task.localId, "referenceImageUrls", (items) => items.filter((_, index) => index !== imageIndex))}
                                    className="rounded p-1 text-[var(--text-secondary)] hover:text-red-500"
                                    aria-label={`删除参考图${imageIndex + 1}`}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ))}
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={images.length >= supplementalMax}
                                  onClick={() => {
                                    const input = document.createElement("input");
                                    input.type = "file";
                                    input.accept = "image/jpeg,image/png,image/webp";
                                    input.multiple = true;
                                    input.onchange = (event) => uploadReferenceFiles(task.localId, Array.from((event.target as HTMLInputElement).files || []), "image", supplementalMax);
                                    input.click();
                                  }}
                                  className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-dashed border-[var(--primary)]/40 text-[11px] text-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <Upload className="h-3.5 w-3.5" /> 批量上传
                                </button>
                                <button
                                  type="button"
                                  disabled={images.length >= supplementalMax}
                                  onClick={() => updateReferenceList(task.localId, "referenceImageUrls", (items) => [...items, ""].slice(0, supplementalMax))}
                                  className="h-8 rounded border border-[var(--border)] px-3 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  添加 URL
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                        {/* 多音频参考：AutoDL H3 最多 3 段，支持本地上传或公网 URL。 */}
                        {cardInputCapabilities.showAudioInputs && cardInputCapabilities.maxReferenceAudios > 0 && (
                          <div className="video-ref-module rounded-lg p-2 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] text-[var(--primary)] font-semibold">参考音频（最多 {cardInputCapabilities.maxReferenceAudios} 段{cardInputCapabilities.minReferenceAudios > 0 ? `，至少 ${cardInputCapabilities.minReferenceAudios} 段` : ""}）</span>
                              <span className="text-[10px] text-[var(--text-secondary)]">MP3 / WAV / MP4 / FLAC</span>
                            </div>
                            {(task.referenceAudioUrls || []).map((url, audioIndex) => (
                              <div key={`ref-audio-${audioIndex}`} className="flex items-center gap-2">
                                <Input
                                  value={url}
                                  onChange={(event) => updateReferenceList(task.localId, "referenceAudioUrls", (items) => items.map((item, index) => index === audioIndex ? event.target.value : item))}
                                  placeholder={`参考音频 URL ${audioIndex + 1}`}
                                  className="h-8 flex-1 bg-[var(--background)] text-[11px]"
                                />
                                <button
                                  type="button"
                                  onClick={() => updateReferenceList(task.localId, "referenceAudioUrls", (items) => items.filter((_, index) => index !== audioIndex))}
                                  className="rounded p-1 text-[var(--text-secondary)] hover:text-red-500"
                                  aria-label={`删除参考音频${audioIndex + 1}`}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={(task.referenceAudioUrls || []).length >= cardInputCapabilities.maxReferenceAudios}
                                onClick={() => {
                                  const input = document.createElement("input");
                                  input.type = "file";
                                  input.accept = "audio/mpeg,audio/wav,audio/flac,audio/x-flac,video/mp4";
                                  input.multiple = true;
                                  input.onchange = (event) => uploadReferenceFiles(task.localId, Array.from((event.target as HTMLInputElement).files || []), "audio", cardInputCapabilities.maxReferenceAudios || 3);
                                  input.click();
                                }}
                                className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-dashed border-[var(--primary)]/40 text-[11px] text-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <Upload className="h-3.5 w-3.5" /> 批量上传音频
                              </button>
                              <button
                                type="button"
                                disabled={(task.referenceAudioUrls || []).length >= cardInputCapabilities.maxReferenceAudios}
                                onClick={() => updateReferenceList(task.localId, "referenceAudioUrls", (items) => [...items, ""].slice(0, cardInputCapabilities.maxReferenceAudios || 3))}
                                className="h-8 rounded border border-[var(--border)] px-3 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                添加 URL
                              </button>
                            </div>
                          </div>
                        )}
                        {/* 源视频URL：编辑模型可必填，Wan 等参考工作流可选。 */}
                        {cardInputCapabilities.supportsSourceVideoInput && (
                          <div>
                            <span className="text-[12px] text-[var(--primary)] font-semibold mb-1 block">源视频{cardInputCapabilities.requiresSourceVideo ? " *" : "（可选）"} · 可直接访问的链接</span>
                            <div className="video-ref-module rounded-lg p-1.5 space-y-1.5">
                              <Input
                                value={task.sourceVideoUrl || ""}
                                onChange={(e) => updateTask(task.localId, "sourceVideoUrl", e.target.value)}
                                aria-label={`任务${task.cardIndex}源视频链接`}
                                placeholder="粘贴可直接播放的视频链接"
                                disabled={requiresVideoTaskTracking(task)}
                                className="bg-[var(--background)] border-[var(--border)] text-[11px] h-8 focus:border-[var(--primary)]/50"
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      </fieldset>}
                      {/* Generate / Result */}
                      {getVideoMediaUnavailable(task) ? (
                        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 p-4 space-y-2" role="status">
                          <p className="text-sm font-medium text-[var(--foreground)]">视频已生成，当前不可播放</p>
                          <p className="text-xs text-[var(--muted-foreground)]">{task.errorMessage || "视频源已失效或记录已移除，请使用此前下载的文件。"}</p>
                          <p className="text-xs text-[var(--muted-foreground)]">原任务及费用记录已保留，不会自动重新提交。</p>
                        </div>
                      ) : task.status === "completed" && (task.videoUrl || task.storageUrl) ? (
                        <div className="space-y-3">
                          {/* Video preview */}
                          <div className="aspect-video bg-[var(--background)] rounded-xl overflow-hidden relative border border-[var(--border)]">
                            <PlayableVideo
                              videoUrl={task.videoUrl}
                              taskId={task.taskId}
                              storageUrl={task.storageUrl}
                              needsProxy={task.needsProxy}
                              token={auth?.token}
                              poster={task.thumbnailUrl || task.firstFrameUrl || undefined}
                              className="w-full h-full object-contain"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => generate(task.localId)}
                              variant="outline"
                              className="flex-1 gap-1.5 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> 再次生成
                            </Button>
                            <Button
                              onClick={async () => {
                                const fileName = task.cardIndex
                                  ? `任务${task.cardIndex}.mp4`
                                  : `video-${task.taskId}.mp4`;
                                await downloadVideo(task.videoUrl, fileName, task.taskId, task.storageUrl);
                              }}
                              className="flex-1 gap-1.5 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                            >
                              <Download className="w-3.5 h-3.5" /> 下载视频
                            </Button>
                          </div>
                        </div>
                      ) : task.status === "failed" || task.status === "cancelled" ? (
                        <div className="space-y-2.5">
                          <div className={"text-xs rounded-lg px-3 py-2.5 leading-relaxed space-y-1.5 " + (requiresVideoTaskTracking(task) ? "text-[var(--text-secondary)] bg-[var(--muted)]/40" : "text-red-400 bg-red-500/10")}>
                            <p className="font-medium">
                              {requiresVideoTaskTracking(task) ? "结果待确认" : task.status === "cancelled" ? "已终止生成" : "生成失败"}
                            </p>
                            {task.status === "failed" && task.errorMessage && (
                              <>
                                <p className="text-red-300/80">{classifyVideoError(task.errorMessage)}</p>
                              </>
                            )}
                          </div>
                          <Button
                            onClick={() => generate(task.localId)}
                            className="w-full gap-1.5 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                          >
                            <RefreshCw className="w-3.5 h-3.5" /> {requiresVideoTaskTracking(task) ? "查询原任务" : "重新生成"}
                          </Button>
                        </div>
                      ) : isActiveVideoTaskStatus(task.status) ? (
                        <div className="space-y-2.5">
                          {(task.taskId || task.clientRequestId) && (
                            <button
                              onClick={() => cancelTask(task.localId)}
                              title={boundVideoTaskModel(task, models).supportsRemoteCancel === true
                                ? "终止本次任务并同步上游"
                                : "先核对是否已投递；已投递任务须获上游终止确认"}
                              className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600 active:bg-red-700 transition-colors"
                            >
                              <Square className="w-3.5 h-3.5 fill-white" />
                              终止生成
                            </button>
                          )}
                          {/* 状态文本 — 按上游真实状态显示 */}
                          <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                            <Loader2 className="w-3 h-3 animate-spin text-[var(--primary)]" />
                            {videoProgressLabel(task)}
                          </span>
                          {!confirmingVideoSubmission && <>
                          <div className="flex items-center gap-2.5" role="progressbar" aria-label="视频生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={typeof task.progress === "number" ? Math.min(100, Math.max(0, task.progress)) : undefined}>
                            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--muted)]/60">
                              <div className={"h-full rounded-full bg-[var(--primary)] transition-all " + (task.progress == null ? "animate-pulse" : "")} style={{ width: task.progress == null ? "35%" : Math.min(100, Math.max(0, task.progress)) + "%" }} />
                            </div>
                            {typeof task.progress === "number" && <span className="text-xs text-[var(--text-secondary)] tabular-nums">{Math.round(task.progress)}%</span>}
                          </div>
                          {/* 等待时间提示 — 实时刷新 + 阶梯式反馈 */}
                          {task.submittedAt && (task.status === "queued" || task.status === "processing" || task.status === "generating") && (() => {
                            const elapsed = Math.floor((nowTick - task.submittedAt) / 1000);
                            const mins = Math.floor(elapsed / 60);
                            const secs = elapsed % 60;
                            const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
                            if (elapsed < 30) return <p className="text-[11px] text-[var(--text-secondary)]">已等待{timeStr}</p>;
                            if (elapsed < 120) return <p className="text-[11px] text-[var(--text-secondary)]">已等待{timeStr}，{task.status === "queued" ? "等待生成资源" : "视频渲染生成中"}...</p>;
                            return <p className="text-[11px] text-[var(--text-secondary)]">已等待{timeStr}，仍在生成，可稍后在历史中查看。</p>;
                          })()}
                          {task.statusDetail && <p className="text-[11px] leading-4 text-[var(--text-secondary)]">{task.statusDetail}</p>}
                          {task.lastSyncedAt && (
                            <p className={"text-[11px] " + ((task.providerPollFailures || 0) > 0 ? "text-amber-600 dark:text-amber-400" : "text-[var(--text-secondary)]")}>
                              上次查询：{Math.max(0, Math.floor((nowTick - task.lastSyncedAt) / 1000))} 秒前
                              {(task.providerPollFailures || 0) > 0 ? ` · 连续 ${task.providerPollFailures} 次未收到上游状态` : ""}
                            </p>
                          )}
                          </>}
                        </div>
                      ) : (
                        <Button
                          onClick={() => generate(task.localId)}
                          disabled={!selectedModel?.available || !selectedModel.generationReady || (cardInputCapabilities.supportsPrompt && !task.prompt.trim())}
                          className="w-full gap-1.5 bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
                        >
                            <>
                              <Zap className="w-4 h-4" /> {selectedModel ? "生成视频" : "请先选择可用模型"}
                            </>
                        </Button>
                      )}
                    </div>
                  </div>
                ); })}
                </div>


              </div>

              {/* Bottom tip */}
              <div className="text-center mt-10 mb-6 text-xs text-[var(--text-secondary)]">
                生成完成后通过原始链路播放或下载；平台保留任务与账务记录，不复制普通视频文件。
              </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {inputImagePreview && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`${inputImagePreview.alt}放大预览`}
          onMouseDown={(event) => event.target === event.currentTarget && setInputImagePreview(null)}
        >
          <div className="relative flex max-h-[92dvh] w-full max-w-5xl items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 shadow-2xl sm:p-5">
            <button
              type="button"
              className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow"
              aria-label="关闭图片预览"
              onClick={() => setInputImagePreview(null)}
            >
              <X className="h-4 w-4" />
            </button>
            <img src={inputImagePreview.src} alt={inputImagePreview.alt} className="max-h-[84dvh] max-w-full object-contain" />
          </div>
        </div>
      )}
      <BrandFooter privacyNote="视频由所选模型处理；普通视频不复制到平台存储，长期保存请下载到电脑" />

      <AlertDialog open={cardAction !== null} onOpenChange={open => { if (!open) setCardAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{cardAction?.kind === "clear" ? "清空卡片内容？" : cardAction?.kind === "remove-all" ? "移除可编辑卡片？" : "移除这张卡片？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {cardAction?.kind === "clear"
                ? "将清空可编辑卡片的提示词、参考素材和当前结果，卡片数量与编号保留。"
                : cardAction?.kind === "remove-all"
                  ? "将移除当前可编辑卡片及其输入内容，并开始一个新批次。"
                  : "将移除这张卡片及其输入内容，其他卡片保留并重新编号。"}
              {"生成中及待确认任务会保留；本次上传的关联参考素材将释放，已保存的生成历史不受影响。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmCardAction}>{cardAction?.kind === "clear" ? "确认清空" : "确认移除"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 现金充值弹窗 */}
      <RechargeDialog
        open={cashRechargeOpen}
        onOpenChange={setCashRechargeOpen}
        credits={state.credits.remaining}
        cashBalance={cashBalance}
        mode="both"
        onCreditsUpdated={(newCredits) => {
          dispatch({ type: "SET_CREDITS", payload: { total: newCredits, used: 0, remaining: newCredits, costPerMessage: 0 } });
        }}
        onCashUpdated={(newCash) => {
          setCashBalance(newCash);
          dispatch({ type: "SET_CASH_BALANCE", payload: newCash });
        }}
      />
    </div>
  );
}
