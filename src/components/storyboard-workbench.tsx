"use client";

import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Download,
  Eye,
  Film,
  History,
  ImageIcon,
  Loader2,
  LockKeyhole,
  Maximize2,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GeneratedImageReferenceSchema, generatedImageReferenceUri, generatedImagePreviewUrl, type GeneratedImageReference } from "@/lib/generated-image-reference";
import { useApp } from "@/contexts/app-context";
import { createUserScopedWorkbenchStorage, resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { ModelBadge } from "@/components/model-badge";
import { resolveModelBrand } from "@/lib/model-brand";
import { getImageModelCapabilities, type ImageModelIdentity } from "@/lib/image-model-capabilities";
import { imageDimensionsMatchAspectRatio } from "@/lib/image-output-contract";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import { getAiVideoPageInputCapabilities } from "@/lib/ai-video-page-capabilities";
import { validateVideoInputContract } from "@/lib/video-input-contract";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  resolveBrowserClientAttempt,
} from "@/lib/browser-client-attempt";
import type { AutodlH3LifecycleView } from "@/lib/autodl-h3-lifecycle-view";
import { SseEventStreamDecoder } from "@/lib/sse-stream-decoder";
import { createStoryboardPersistenceSnapshot } from "@/lib/storyboard-local-persistence";
import { projectGeneratedImageClientReceipt, resolveGeneratedImageClientDelivery } from "@/lib/generated-image-client-delivery";
import { ImageDownloadOperations, readImageDownloadBlob, imageDownloadFilename } from "@/lib/generated-image-download";
import { MEDIA_CANCEL_DEADLINE_MS, providerMediaUrl, readMediaStreamWithDeadline } from "@/lib/generated-media-delivery";
import { STORYBOARD_IDLE_DRAFT_KEY } from "@/lib/storyboard-idle-draft";
import { useStoryboardProjects } from "@/hooks/use-storyboard-projects";
import type { StoryboardAgentOutputSegment } from "@/lib/storyboard-agent-output";
import {
  GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY,
  GENERAL_SCRIPT_HANDOFF_STORAGE_KEY,
  parseGeneralScriptStoryboardHandoff,
  type GeneralScriptHandoffErrorCode,
  type ParsedGeneralScriptStoryboardHandoff,
} from "@/lib/short-drama/general-script-storyboard-bridge";
import {
  readAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffEnvelope,
} from "@/lib/agent-workbench-handoff";
import {
  parseStoryboardCanvasImport,
  type StoryboardCanvasImportPlan,
} from "@/lib/storyboard-canvas-bridge";
import {
  resolveStoryboardVideoResolution,
  resolveStoryboardVideoSelection,
  storyboardVideoModelSelectionIssue,
  resolveStoryboardInitialVideoModelId,
  storyboardVideoErrorMessage,
  storyboardTaskCanCancel,
  storyboardTaskCanRequestTermination,
} from "@/lib/storyboard-video-model-selection";
import {
  coerceVideoTargetDuration,
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
  getVideoTargetDurationOptions,
  resolveVideoResolution,
} from "@/lib/video-model-capabilities";
import { compactPublicVideoModelName } from "@/lib/video-history-presentation";
import {
  buildStoryboardVideoPrompt,
  inferStoryboardNarration,
  narrationCharacterCount,
  storyboardVideoRuntimeGuard,
} from "@/lib/storyboard-single-frame-video-prompt";

type TaskStatus = "idle" | "queued" | "running" | "done" | "failed" | "cancelled";
type BatchMode = "" | "images" | "videos" | "full";
const WORKBENCH_RATIOS = ["16:9", "9:16", "1:1"] as const;
type WorkbenchRatio = (typeof WORKBENCH_RATIOS)[number];

type StoryboardImageRequestSnapshot = {
  runId: string;
  cardId: string;
  cardOrder: number;
  prompt: string;
  modelId: string;
  aspectRatio: WorkbenchRatio;
  resolution: string;
  exactText?: string;
  referenceImageUrls: string[];
  strictSingleSubmit: boolean;
  /** A new explicit user generation gets a new ordinal; recovery keeps the original ordinal. */
  attemptOrdinal?: number;
};

type StoryboardImageAttemptState =
  | "not_found"
  | "processing"
  | "completed"
  | "provider_completed_pending_delivery"
  | "unknown"
  | "rejected";

type StoryboardImageAttemptStatus = {
  state?: StoryboardImageAttemptState;
  canRecover?: boolean;
  canResubmit?: boolean;
  sameKeyCanResubmit?: boolean;
  deliveryReady?: boolean;
  assetId?: string;
  recordId?: string;
  deliveryMode?: "provider_url" | "inline_ephemeral";
  cashCharged?: number;
  idempotencyReplayed?: boolean;
  retryAfterMs?: number;
  message?: string;
  error?: string;
};

/** Completed inline receipt fields are independent of preview availability. */
function storyboardGeneratedReceiptFields(value: unknown): Partial<WorkbenchCard> | null {
  const receipt = projectGeneratedImageClientReceipt(value);
  if (!receipt) return null;
  return { imageRecordId: receipt.recordId, imageDeliveryMode: receipt.deliveryMode,
    imagePriceCharged: receipt.cashCharged, imageBillingState: value && typeof value === "object" && "idempotencyReplayed" in value && value.idempotencyReplayed === true ? "restored" : "settled" };
}
function storyboardInlineReceiptFields(value: unknown): Partial<WorkbenchCard> | null {
  const receipt = storyboardGeneratedReceiptFields(value);
  return receipt?.imageDeliveryMode === "inline_ephemeral" ? receipt : null;
}

function isWorkbenchRatio(value: unknown): value is WorkbenchRatio {
  return WORKBENCH_RATIOS.includes(value as WorkbenchRatio);
}

type WorkbenchCard = {
  id: string;
  order: number;
  sourceNumber?: number;
  label?: string;
  narration?: string;
  imagePrompt: string;
  imageExactText?: string;
  imageTextLayoutEnabled?: boolean;
  videoPrompt: string;
  referenceImageUrls: string[];
  imageStatus: TaskStatus;
  imageUrl?: string;
  imageRef?: GeneratedImageReference;
  imageRecordId?: string;
  imageDeliveryMode?: "provider_url" | "inline_ephemeral";
  imageAssetId?: string;
  imageStorageKey?: string;
  imageWidth?: number;
  imageHeight?: number;
  videoSourceImageUrl?: string;
  imageError?: string;
  imageSubmittedAt?: number;
  imageValidatedAt?: number;
  imageModelIdUsed?: string;
  imageModelNameUsed?: string;
  imageClientRequestId?: string;
  imageClientTraceId?: string;
  imageClientRequestFingerprint?: string;
  imageRequestSnapshot?: StoryboardImageRequestSnapshot;
  imageAttemptOrdinal?: number;
  imageQuotedPrice?: number;
  imagePriceCharged?: number;
  imageBillingState?: "pending" | "settled" | "restored" | "not_charged";
  imageRecoveryReady?: boolean;
  imageRetryBlocked?: boolean;
  videoStatus: TaskStatus;
  videoUrl?: string;
  videoError?: string;
  videoTaskId?: string;
  videoClientRequestId?: string;
  videoClientRequestFingerprint?: string;
  videoTaskModelId?: string;
  videoTaskModelName?: string;
  videoTaskDuration?: number;
  videoSupportsRemoteCancel?: boolean;
  videoContentUrl?: string;
  videoProgress?: number;
  videoStartedAt?: number;
  videoLastCheckedAt?: number;
  videoStatusDetail?: string;
  videoPollFailures?: number;
  videoMonitoringPaused?: boolean;
  videoLifecycle?: AutodlH3LifecycleView;
  videoLifecycleError?: string;
  videoRetryable?: boolean;
  videoBillingState?: string;
  videoPriceCharged?: number;
};

type WorkbenchVideoContract = {
  modelId: string;
  resolution: string;
  duration: number;
  ratio: WorkbenchRatio;
};

type WorkbenchRun = {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastSubmittedAt?: number;
  ratio: WorkbenchRatio;
  imageResolution: string;
  videoResolution: string;
  videoDuration: number;
  imageModelId: string;
  videoModelId: string;
  videoContract?: WorkbenchVideoContract;
  cards: WorkbenchCard[];
  title: string;
};

type StoryboardImageFailureRecord = {
  id: string;
  createdAt: number;
  prompt: string;
  publicModelId: string;
  modelName: string;
  aspectRatio: string;
  resolution: string;
  referenceCount: number;
  quotedPriceYuan: number;
  error: { message: string };
  billing: { state: "charged" | "not_charged" | "exempt" | "unknown"; chargedAmount?: number };
  canLoadForRetry: boolean;
  retryBlockReason?: string;
};

function resetFailedVideoCardsForModelSwitch(cards: WorkbenchCard[]): WorkbenchCard[] {
  return cards.map((card) => card.videoStatus === "failed" && card.videoRetryable === true
    ? {
        ...card,
        videoStatus: "idle" as const,
        videoError: undefined,
        videoTaskId: undefined,
        videoClientRequestId: undefined,
        videoClientRequestFingerprint: undefined,
        videoTaskModelId: undefined,
        videoTaskModelName: undefined,
        videoTaskDuration: undefined,
        videoSupportsRemoteCancel: undefined,
        videoContentUrl: undefined,
        videoProgress: undefined,
        videoStartedAt: undefined,
        videoLastCheckedAt: undefined,
        videoStatusDetail: undefined,
        videoPollFailures: 0,
        videoMonitoringPaused: undefined,
        videoLifecycle: undefined,
        videoLifecycleError: undefined,
        videoRetryable: undefined,
        videoBillingState: undefined,
        videoPriceCharged: undefined,
      }
    : card);
}

type GeneralScriptHandoffPanelState =
  | { status: "hidden" }
  | { status: "ready"; handoff: ParsedGeneralScriptStoryboardHandoff }
  | { status: "error"; code: GeneralScriptHandoffErrorCode; error: string }
  | { status: "imported"; handoff: ParsedGeneralScriptStoryboardHandoff };

type AgentHandoffPanelState =
  | { status: "hidden" }
  | { status: "ready"; handoff: AgentWorkbenchHandoffEnvelope; plan: StoryboardCanvasImportPlan }
  | { status: "error"; error: string }
  | { status: "imported"; handoff: AgentWorkbenchHandoffEnvelope; plan: StoryboardCanvasImportPlan };

type LegacyReview = {
  reviewId?: string;
  run?: Record<string, unknown> & {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
    lastSubmittedAt?: number;
    ratio?: WorkbenchRatio;
    imageResolution?: string;
    videoResolution?: string;
    videoDuration?: number;
    imageModelId?: string;
    videoModelId?: string;
    videoContract?: Partial<WorkbenchVideoContract>;
    project?: {
      title?: string;
      segments?: Array<Record<string, unknown> & {
        order?: number;
        narration?: string;
        storyboardImagePrompt?: string;
        videoPrompt?: string;
        imageStatus?: TaskStatus;
        imageUrl?: string;
        videoSourceImageUrl?: string;
        imageError?: string;
        imageSubmittedAt?: number;
        videoStatus?: TaskStatus;
        videoUrl?: string;
        videoError?: string;
        videoTaskId?: string;
        videoTaskModelId?: string;
        videoContentUrl?: string;
        videoProgress?: number;
        videoStartedAt?: number;
        videoLastCheckedAt?: number;
        videoStatusDetail?: string;
        videoPollFailures?: number;
        videoMonitoringPaused?: boolean;
        videoLifecycle?: AutodlH3LifecycleView;
        videoLifecycleError?: string;
      }>;
    };
    cards?: WorkbenchCard[];
    title?: string;
  };
};

type ImageModel = ImageModelIdentity & {
  id: string;
  name: string;
  displayName?: string;
  display_name?: string;
  variantLabel?: string;
  avatarUrl?: string;
  model_name: string;
  provider?: string;
  selling_price?: number;
  supports_image_input?: boolean;
  resolution_options?: string[];
  default_resolution?: string;
  resolution_prices?: Record<string, number>;
  aspectRatios?: WorkbenchRatio[];
  family?: "gpt" | "gemini" | "qwen" | "other";
  available: boolean;
  priceReady: boolean;
  availabilityMessage?: string;
};

type VideoModel = {
  id: string;
  name: string;
  displayName?: string;
  display_name?: string;
  variantLabel?: string;
  avatarUrl?: string;
  pricePerUse?: number;
  durationSeconds: number;
  minDuration: number;
  maxDuration: number;
  durationMode: "fixed" | "discrete" | "range";
  nativeDurations?: number[];
  supportsImageInput: boolean;
  requiresImage: boolean;
  requiresSourceVideo: boolean;
  supportsAudioInput: boolean;
  supportsPrompt: boolean;
  workflowInputMode: string;
  minReferenceImages: number;
  maxReferenceImages: number;
  minReferenceAudios?: number;
  maxReferenceAudios: number;
  requiresFirstFrame?: boolean;
  requiresLastFrame?: boolean;
  referenceInputMode?: string;
  resolutionTier?: string;
  resolutionOptions: string[];
  defaultResolution: string;
  resolutionPrices: Record<string, number>;
  aspectRatios: WorkbenchRatio[];
  billingUnit: "per_use" | "output_second";
  workspaceSurfaces: string[];
  supportsRemoteCancel: boolean;
  available: boolean;
  priceReady: boolean;
  generationReady: boolean;
  readinessMessage: string;
  availabilityMessage: string;
  durationStep?: number;
};

type ModelApiRecord = Record<string, unknown> & {
  capabilities?: Record<string, unknown>;
};

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(fallback: number, ...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function firstBoolean(fallback: boolean, ...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function firstOptionalBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function firstOptionalNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function stringList(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }
  }
  return [];
}

function numberList(...values: unknown[]) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.map(Number).filter((item) => Number.isFinite(item) && item > 0);
    }
  }
  return [];
}

function normalizeImageModel(record: ModelApiRecord): ImageModel {
  const capabilities = record.capabilities || {};
  const maxReferences = firstNumber(Number.NaN, capabilities.maxReferenceImages, record.max_reference_images);
  const maxCharacters = firstNumber(Number.NaN, capabilities.maxCharacterReferences, record.max_character_references);
  const displayName = firstText(record.displayName, record.display_name, record.name, "通用生图模型");
  const resolutionOptions = stringList(capabilities.resolutionOptions, record.resolutionOptions, record.resolution_options);
  const resolutionPrices = parsePublicImageResolutionPrices(capabilities.resolutionPrices);
  const sellingPrice = firstOptionalNumber(record.publicPrice, record.selling_price, record.price_per_use);
  const hasCompletePrice = Number.isFinite(sellingPrice)
    || (resolutionOptions.length > 0 && resolutionOptions.every((resolution) => Number.isFinite(resolutionPrices[resolution.toUpperCase()])));
  const declaredPriceReady = firstBoolean(hasCompletePrice, capabilities.priceReady, record.priceReady);
  return {
    id: firstText(record.id),
    name: displayName,
    displayName,
    display_name: displayName,
    variantLabel: firstText(record.variantLabel, record.variant_label),
    avatarUrl: firstText(record.avatarUrl, record.avatar_url),
    model_name: firstText(record.model_name, displayName),
    provider: typeof record.provider === "string" ? record.provider : undefined,
    selling_price: sellingPrice,
    supports_image_input: firstBoolean(false, capabilities.supportsImageInput, record.supportsImageInput, record.supports_image_input),
    supports_reference_input: firstBoolean(false, capabilities.supportsReferenceInput, record.supportsReferenceInput, record.supports_reference_input, capabilities.supportsImageInput, record.supportsImageInput, record.supports_image_input),
    ...(Number.isFinite(maxReferences) ? { max_reference_images: maxReferences } : {}),
    ...(Number.isFinite(maxCharacters) ? { max_character_references: maxCharacters } : {}),
    reference_input_mode: ["none", "single", "multi"].includes(String(capabilities.referenceInputMode)) ? capabilities.referenceInputMode as ImageModelIdentity["reference_input_mode"] : undefined,
    identity_reference_level: ["none", "single-subject", "multi-subject"].includes(String(capabilities.identityReferenceLevel)) ? capabilities.identityReferenceLevel as ImageModelIdentity["identity_reference_level"] : undefined,
    reference_capability_label: firstText(capabilities.referenceCapabilityLabel, record.reference_capability_label),
    resolution_options: resolutionOptions,
    default_resolution: firstText(capabilities.defaultResolution, record.defaultResolution, record.default_resolution),
    resolution_prices: resolutionPrices,
    aspectRatios: stringList(capabilities.aspectRatios, record.aspectRatios).filter(isWorkbenchRatio),
    family: normalizeImageFamily(firstText(capabilities.family), displayName, firstText(record.model_name), firstText(record.provider)),
    available: firstBoolean(true, capabilities.available, record.available),
    priceReady: declaredPriceReady && hasCompletePrice,
    availabilityMessage: firstText(capabilities.availabilityMessage, record.availabilityMessage, record.availability_message),
  };
}

function normalizeImageFamily(...values: string[]): ImageModel["family"] {
  const identity = values.filter(Boolean).join(" ").toLowerCase();
  if (/gpt[\s_-]*image|openai[\s_-]*gpt[\s_-]*image/u.test(identity)) return "gpt";
  if (/gemini|google[\s_-]*image|nano[\s_-]*banana|imagen/u.test(identity)) return "gemini";
  if (/qwen[\s_-]*image/u.test(identity)) return "qwen";
  return "other";
}

export function selectStoryboardImageModels(models: ImageModel[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function storyboardImageModelSelectionIssue(model: ImageModel) {
  if (!model.available || !model.priceReady) return model.availabilityMessage || "当前未开放";
  return "";
}

function publicModelSelectionLabel(selectionIssue: string) {
  if (!selectionIssue) return "";
  if (/账户|余额|欠费|额度|兼容账户/u.test(selectionIssue)) return "上游账户异常";
  if (/渠道|恢复|维护|故障|模型不存在/u.test(selectionIssue)) return "上游通道异常";
  return "暂不可用";
}

function normalizeVideoModel(record: ModelApiRecord): VideoModel {
  const capabilities = record.capabilities || {};
  const displayName = firstText(record.displayName, record.display_name, record.name, "通用视频模型");
  const durationSeconds = firstNumber(10, capabilities.defaultDuration, record.durationSeconds, record.duration_seconds, capabilities.minDuration);
  const nativeDurations = numberList(capabilities.nativeDurations, record.nativeDurations);
  const maxDuration = firstNumber(durationSeconds, capabilities.maxDuration, record.maxDuration, record.max_duration, nativeDurations.at(-1));
  const minDuration = firstNumber(Math.min(durationSeconds, maxDuration), capabilities.minDuration, record.minDuration, nativeDurations[0]);
  const ratios = stringList(capabilities.aspectRatios, record.aspectRatios)
    .filter(isWorkbenchRatio);
  const resolutionCapabilities = getVideoResolutionCapabilities(record);
  const resolutionOptions = resolutionCapabilities.options;
  const defaultResolution = resolutionCapabilities.defaultResolution;
  const pricePerUse = firstOptionalNumber(record.publicPrice, record.pricePerUse, record.price_per_use);
  const hasCompletePrice = Number.isFinite(pricePerUse)
    || (resolutionOptions.length > 0 && resolutionOptions.every((resolution) => Number.isFinite(resolutionCapabilities.publicPrices[resolution])));
  const declaredPriceReady = firstBoolean(hasCompletePrice, capabilities.priceReady, record.priceReady, record.price_ready);
  return {
    id: firstText(record.id),
    name: displayName,
    displayName,
    display_name: displayName,
    variantLabel: firstText(record.variantLabel, record.variant_label),
    avatarUrl: firstText(record.avatarUrl, record.avatar_url),
    pricePerUse,
    durationSeconds,
    minDuration,
    maxDuration,
    durationMode: ["fixed", "discrete", "range"].includes(String(capabilities.durationMode || record.durationMode))
      ? String(capabilities.durationMode || record.durationMode) as VideoModel["durationMode"]
      : maxDuration > durationSeconds ? "range" : "fixed",
    nativeDurations,
    supportsImageInput: firstBoolean(false, capabilities.supportsImageInput, record.supportsImageInput, record.supports_image_input),
    requiresImage: firstBoolean(false, capabilities.requiresImage, record.requiresImage, record.requires_image),
    requiresSourceVideo: firstBoolean(false, capabilities.requiresSourceVideo, record.requiresSourceVideo, record.requires_source_video),
    supportsAudioInput: firstBoolean(false, capabilities.supportsAudioInput, record.supportsAudioInput, record.supports_audio_input),
    referenceInputMode: firstText(capabilities.workflowInputMode, capabilities.referenceInputMode, record.workflowInputMode, record.referenceInputMode, record.reference_input_mode),
    workflowInputMode: firstText(capabilities.workflowInputMode, capabilities.referenceInputMode, record.workflowInputMode, record.referenceInputMode),
    supportsPrompt: firstBoolean(true, capabilities.supportsPrompt, record.supportsPrompt),
    minReferenceImages: firstNumber(0, capabilities.minReferenceImages, record.minReferenceImages),
    maxReferenceImages: firstNumber(1, capabilities.maxReferenceImages, record.maxReferenceImages),
    minReferenceAudios: firstOptionalNumber(capabilities.minReferenceAudios, record.minReferenceAudios),
    maxReferenceAudios: firstNumber(0, capabilities.maxReferenceAudios, record.maxReferenceAudios),
    requiresFirstFrame: firstOptionalBoolean(capabilities.requiresFirstFrame, record.requiresFirstFrame),
    requiresLastFrame: firstOptionalBoolean(capabilities.requiresLastFrame, record.requiresLastFrame),
    resolutionTier: firstText(capabilities.resolutionTier, record.resolutionTier, defaultResolution),
    resolutionOptions,
    defaultResolution: resolutionOptions.includes(defaultResolution) ? defaultResolution : resolutionOptions[0] || defaultResolution,
    resolutionPrices: resolutionCapabilities.publicPrices,
    aspectRatios: ratios.length > 0 ? ratios : ["16:9", "9:16"],
    billingUnit: capabilities.billingUnit === "output_second" ? "output_second" : "per_use",
    workspaceSurfaces: stringList(capabilities.workspaceSurfaces, record.workspaceSurfaces),
    supportsRemoteCancel: firstBoolean(false, capabilities.supportsRemoteCancel, record.supportsRemoteCancel, record.supports_remote_cancel),
    available: firstBoolean(true, capabilities.available, record.available),
    priceReady: declaredPriceReady && hasCompletePrice,
    generationReady: firstBoolean(true, capabilities.generationReady, record.generationReady, record.generation_ready),
    readinessMessage: firstText(capabilities.readinessMessage, record.readinessMessage, record.readiness_message),
    availabilityMessage: firstText(capabilities.availabilityMessage, record.availabilityMessage, record.availability_message),
    durationStep: firstNumber(0, capabilities.durationStep, record.durationStep, record.duration_step) || undefined,
  };
}

function supportedWorkbenchRatios(imageModel?: ImageModel, videoModel?: VideoModel): WorkbenchRatio[] {
  const imageRatios = imageModel?.aspectRatios?.length
    ? imageModel.aspectRatios
    : [...WORKBENCH_RATIOS];
  const videoRatios = videoModel?.aspectRatios?.length
    ? videoModel.aspectRatios
    : [...WORKBENCH_RATIOS];
  return WORKBENCH_RATIOS.filter((ratio) => imageRatios.includes(ratio) && videoRatios.includes(ratio));
}

const CURRENT_KEY = "storyboard_prompt_workbench_current_v2";
const HISTORY_KEY = "storyboard_prompt_workbench_history_v2";
const MAX_HISTORY = 20;
const MAX_CARDS = 20;
const MAX_REFERENCES = 9;
const IMAGE_SUBMIT_INTERVAL_MS = 5_000;
const VIDEO_SUBMIT_INTERVAL_MS = 8_000;
const VIDEO_POLL_INTERVAL_MS = 8_000;
const H3_LIFECYCLE_POLL_INTERVAL_MS = 2_000;
const IMAGE_GENERATION_ATTEMPTS = 2;
const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 12_000;
const MODEL_CATALOG_RETRY_DELAYS_MS = [0, 1_000, 3_000, 7_000] as const;
const STRICT_GPT_IMAGE_PUBLIC_ID = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const STRICT_AUTODL_H3_SELFHOST_PUBLIC_ID = "pm_tabUjazl2a7DJ2POEriC-Ogo";
function isAutodlH3LifecycleTaskId(value: unknown): boolean {
  return /^h3q_[a-f0-9]+$/u.test(String(value || ""));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("任务已终止", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("任务已终止", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function isActiveVideoStatus(status: TaskStatus) {
  return status === "queued" || status === "running";
}

function videoNeedsRequestReconciliation(card: WorkbenchCard) {
  return isActiveVideoStatus(card.videoStatus)
    && !card.videoTaskId
    && Boolean(card.videoClientRequestId);
}

function normalizeRemoteVideoStatus(status?: string): TaskStatus | "unknown" {
  const normalized = String(status || "").trim().toLowerCase();
  if (["completed", "success", "succeeded", "ready"].includes(normalized)) return "done";
  if (["failed", "error", "failure", "terminated", "expired"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["queued", "pending", "waiting", "submitted", "created", "initializing"].includes(normalized)) return "queued";
  if (["processing", "running", "generating", "in_progress", "trimming", "finalizing", "asset_persisting"].includes(normalized)) return "running";
  return "unknown";
}

function friendlyVideoError(message: string, status?: number) {
  return storyboardVideoErrorMessage(message, status);
}

function formatElapsed(startedAt?: number, now = Date.now()) {
  if (!startedAt) return "刚刚提交";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `已等待 ${seconds} 秒`;
  return `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatLastChecked(checkedAt?: number, now = Date.now()) {
  if (!checkedAt) return "等待首次回报";
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  return seconds < 2 ? "刚刚收到进度更新" : `${seconds} 秒前收到进度更新`;
}

const VIDEO_DELIVERY_STAGES = ["已提交", "上游生成", "接收结果", "完成"] as const;

function cardVideoStageIndex(card: WorkbenchCard) {
  if (card.videoStatus === "done") return 3;
  if (card.videoStatus === "queued") return 0;
  const detail = `${card.videoLifecycle?.headline || ""} ${card.videoLifecycle?.detail || ""} ${card.videoStatusDetail || ""}`;
  if (/回传|接收|同步|裁剪|扣费|交付|播放地址|已就绪|finaliz|billing|trimming|asset/iu.test(detail)) return 2;
  return 1;
}

class RetryableImageFileError extends Error {}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function stableImageRequestDigest(payload: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storyboardImageFingerprintPayload(snapshot: StoryboardImageRequestSnapshot) {
  return {
    runId: snapshot.runId,
    cardId: snapshot.cardId,
    prompt: snapshot.prompt,
    modelId: snapshot.modelId,
    aspectRatio: snapshot.aspectRatio,
    resolution: snapshot.resolution,
    exactText: snapshot.exactText || "",
    referenceImageUrls: snapshot.referenceImageUrls,
    ...(Number.isInteger(snapshot.attemptOrdinal) ? { attemptOrdinal: snapshot.attemptOrdinal } : {}),
  };
}

function isStoryboardImageRequestSnapshot(value: unknown): value is StoryboardImageRequestSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as StoryboardImageRequestSnapshot;
  return typeof snapshot.runId === "string" && Boolean(snapshot.runId)
    && typeof snapshot.cardId === "string" && Boolean(snapshot.cardId)
    && Number.isInteger(snapshot.cardOrder) && snapshot.cardOrder > 0
    && typeof snapshot.prompt === "string" && Boolean(snapshot.prompt.trim())
    && typeof snapshot.modelId === "string" && Boolean(snapshot.modelId)
    && isWorkbenchRatio(snapshot.aspectRatio)
    && typeof snapshot.resolution === "string" && Boolean(snapshot.resolution)
    && (snapshot.exactText === undefined || typeof snapshot.exactText === "string" && snapshot.exactText.length <= 200)
    && Array.isArray(snapshot.referenceImageUrls)
    && snapshot.referenceImageUrls.every((url) => typeof url === "string" && Boolean(url.trim()))
    && typeof snapshot.strictSingleSubmit === "boolean"
    && (snapshot.attemptOrdinal === undefined || Number.isInteger(snapshot.attemptOrdinal) && snapshot.attemptOrdinal > 0);
}

function deriveStoryboardImageTraceId(card: WorkbenchCard) {
  const saved = String(card.imageClientTraceId || "").trim();
  if (saved) return saved;
  const key = String(card.imageClientRequestId || "").trim();
  if (key.startsWith("imgkey_")) return `imgtrace_${key.slice("imgkey_".length)}`;
  return key;
}

function createCard(order: number): WorkbenchCard {
  return {
    id: createId("shot"),
    order,
    narration: "",
    imagePrompt: "",
    imageExactText: "",
    imageTextLayoutEnabled: false,
    videoPrompt: "",
    referenceImageUrls: [],
    imageStatus: "idle",
    videoStatus: "idle",
  };
}

function browserImageReady(url: string, timeoutMs = 30_000) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const timer = window.setTimeout(() => finish(() => reject(new Error("图片加载超时"))), timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };
    const fail = () => finish(() => reject(new Error("图片无法在浏览器中解码")));
    image.decoding = "async";
    image.onload = async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) return fail();
        finish(() => resolve({ width: image.naturalWidth, height: image.naturalHeight }));
      } catch {
        fail();
      }
    };
    image.onerror = fail;
    image.src = url;
  });
}

function hasValidatedImage(card: WorkbenchCard) {
  return card.imageStatus === "done" && Boolean(card.imageUrl) && Boolean(card.imageValidatedAt);
}

function isCompletedInlineImageReceipt(card: WorkbenchCard) {
  return card.imageStatus === "done"
    && card.imageDeliveryMode === "inline_ephemeral"
    && typeof card.imageRecordId === "string" && /^[a-f0-9]{64}$/u.test(card.imageRecordId)
    && typeof card.imagePriceCharged === "number" && Number.isFinite(card.imagePriceCharged) && card.imagePriceCharged >= 0
    && (card.imageBillingState === "settled" || card.imageBillingState === "restored");
}

function isUnavailableCompletedInlineImage(card: WorkbenchCard) {
  return isCompletedInlineImageReceipt(card) && !hasValidatedImage(card);
}

function imageAttemptNeedsResolution(card: WorkbenchCard) {
  if (isCompletedInlineImageReceipt(card)) return false;
  return card.imageStatus === "running"
    || card.imageStatus === "queued"
    || card.imageRecoveryReady === true
    || card.imageRetryBlocked === true;
}

function isPublicHttpMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")) return false;
    if (/^(127\.|10\.|0\.)/u.test(hostname) || /^192\.168\./u.test(hostname)) return false;
    const private172 = hostname.match(/^172\.(\d{1,2})\./u);
    return !private172 || Number(private172[1]) < 16 || Number(private172[1]) > 31;
  } catch {
    return false;
  }
}

async function mediaUrlToDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`旧故事板读取失败（${response.status}）`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("旧故事板不是有效图片");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("故事板转换失败"));
    reader.onerror = () => reject(new Error("故事板转换失败"));
    reader.readAsDataURL(blob);
  });
}

function isMultiPanelStoryboardPrompt(prompt: string) {
  return /(?:严格\s*)?2\s*[×xX*]\s*2|(?:四|五|4|5)格(?:故事板|分镜)|Frame\s*1[\s\S]*Frame\s*2/iu.test(prompt);
}

function createRun(cardCount = 3): WorkbenchRun {
  const now = Date.now();
  return {
    id: createId("storyboard-run"),
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    imageResolution: "",
    videoResolution: "",
    videoDuration: 10,
    imageModelId: "",
    videoModelId: "",
    cards: Array.from({ length: cardCount }, (_, index) => createCard(index + 1)),
    title: "未命名分镜项目",
  };
}

function normalizeVideoContract(value: unknown): WorkbenchVideoContract | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<WorkbenchVideoContract>;
  const modelId = String(record.modelId || "").trim();
  const resolution = String(record.resolution || "").trim();
  const duration = Number(record.duration);
  if (!modelId || !resolution || !Number.isFinite(duration) || duration <= 0 || !isWorkbenchRatio(record.ratio)) {
    return undefined;
  }
  return { modelId, resolution, duration, ratio: record.ratio };
}

function normalizeLegacyImageError(value: unknown, recoveryPending: boolean) {
  const message = String(value || "").trim();
  if (!message) return undefined;
  if (/点击(?:立即)?恢复|恢复原图片|恢复图片/u.test(message)) {
    return recoveryPending
      ? "图片已生成，系统正在自动完成保存和展示。"
      : "本次图片任务已结束，请按当前状态重新提交。";
  }
  return message;
}

function normalizeRun(value: unknown): WorkbenchRun | null {
  if (!value || typeof value !== "object") return null;
  const record = value as LegacyReview["run"];
  if (!record?.id) return null;
  const cards = Array.isArray(record.cards)
    ? record.cards
    : record.project?.segments?.map((segment, index) => ({
        id: createId("archive-shot"),
        order: Number(segment.order || index + 1),
        label: String(segment.label || ""),
        narration: String(segment.narration || ""),
        imagePrompt: String(segment.storyboardImagePrompt || ""),
        videoPrompt: String(segment.videoPrompt || ""),
        referenceImageUrls: [],
        imageStatus: segment.imageStatus || "idle",
        imageUrl: segment.imageUrl,
        videoSourceImageUrl: typeof segment.videoSourceImageUrl === "string" ? segment.videoSourceImageUrl : undefined,
        imageError: segment.imageError,
        imageSubmittedAt: segment.imageSubmittedAt,
        videoStatus: segment.videoStatus || "idle",
        videoUrl: segment.videoUrl,
        videoError: segment.videoError,
        videoTaskId: segment.videoTaskId,
        videoTaskModelId: segment.videoTaskModelId,
        videoContentUrl: segment.videoContentUrl,
        videoProgress: segment.videoProgress,
        videoStartedAt: segment.videoStartedAt,
        videoLastCheckedAt: segment.videoLastCheckedAt,
        videoStatusDetail: segment.videoStatusDetail,
        videoPollFailures: segment.videoPollFailures,
        videoMonitoringPaused: segment.videoMonitoringPaused,
        videoLifecycle: segment.videoLifecycle,
        videoLifecycleError: segment.videoLifecycleError,
      })) || [];
  if (!cards.length) return null;
  const videoContract = normalizeVideoContract(record.videoContract);
  const videoModelId = String(record.videoModelId || videoContract?.modelId || "");
  const selectedContract = videoModelId === videoContract?.modelId ? videoContract : undefined;
  const submissionTimes = [
    Number(record.lastSubmittedAt),
    ...cards.flatMap((card) => [Number(card.imageSubmittedAt), Number(card.videoStartedAt)]),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return {
    id: record.id,
    createdAt: Number(record.createdAt || Date.now()),
    updatedAt: Number(record.updatedAt || Date.now()),
    lastSubmittedAt: submissionTimes.length ? Math.max(...submissionTimes) : undefined,
    ratio: selectedContract?.ratio || (isWorkbenchRatio(record.ratio) ? record.ratio : "16:9"),
    imageResolution: String(record.imageResolution || ""),
    videoResolution: selectedContract?.resolution || String(record.videoResolution || ""),
    videoDuration: selectedContract?.duration || Number(record.videoDuration) || 10,
    imageModelId: String(record.imageModelId || ""),
    videoModelId,
    videoContract,
    cards: cards.map((card, index) => ({
      ...card,
      order: index + 1,
      narration: String(card.narration || inferStoryboardNarration(card.label)),
      imageTextLayoutEnabled: (card as Partial<WorkbenchCard>).imageTextLayoutEnabled === true
        || Boolean(String((card as Partial<WorkbenchCard>).imageExactText || "").trim()),
      imageError: normalizeLegacyImageError(card.imageError, (card as Partial<WorkbenchCard>).imageRecoveryReady === true),
      referenceImageUrls: Array.isArray(card.referenceImageUrls) ? card.referenceImageUrls.slice(0, MAX_REFERENCES) : [],
    })),
    title: String(record.title || record.project?.title || "历史分镜项目"),
  };
}

function hasSubmittedWork(run: WorkbenchRun) {
  return run.cards.some((card) => (
    card.imageStatus !== "idle"
    || card.videoStatus !== "idle"
    || Boolean(card.imageUrl || card.videoUrl || card.videoTaskId || card.videoContentUrl)
  ));
}

type HistoryVideoTask = {
  id?: string;
  taskIdExternal?: string;
  taskLabel?: string;
  modelId?: string;
  publicModelId?: string;
  modelName?: string;
  prompt?: string;
  firstFrameUrl?: string;
  thumbnailUrl?: string;
  createdAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  supportsRemoteCancel?: boolean;
  status?: string;
  videoUrl?: string;
  batchId?: string;
  cardIndex?: number;
  canRetry?: boolean;
  billingState?: string;
  priceCharged?: number;
};

function hydrateRunVideoTasks(run: WorkbenchRun, tasks: HistoryVideoTask[]): WorkbenchRun {
  let changed = false;
  const cards = run.cards.map((card) => {
    const task = card.videoTaskId
      ? tasks.find((item) => item.id === card.videoTaskId || item.taskIdExternal === card.videoTaskId)
      : tasks.find((item) => item.batchId === run.id && Number(item.cardIndex) === card.order);
    if (!task) return card;
    const nextStatus = normalizeRemoteVideoStatus(task.status);
    const next: WorkbenchCard = {
      ...card,
      videoTaskId: card.videoTaskId || task.taskIdExternal || task.id,
      videoTaskModelId: task.publicModelId || card.videoTaskModelId || task.modelId,
      videoTaskModelName: task.modelName || card.videoTaskModelName,
      videoTaskDuration: Number(task.durationSeconds) > 0 ? Number(task.durationSeconds) : card.videoTaskDuration,
      videoSupportsRemoteCancel: typeof task.supportsRemoteCancel === "boolean" ? task.supportsRemoteCancel : card.videoSupportsRemoteCancel,
      videoUrl: task.videoUrl || card.videoUrl,
      videoStatus: nextStatus === "unknown" ? card.videoStatus : nextStatus,
      videoMonitoringPaused: ["done", "failed", "cancelled"].includes(nextStatus)
        ? undefined
        : card.videoMonitoringPaused,
      videoRetryable: typeof task.canRetry === "boolean" ? task.canRetry : card.videoRetryable,
      videoBillingState: task.billingState || card.videoBillingState,
      videoPriceCharged: Number.isFinite(Number(task.priceCharged)) ? Math.max(0, Number(task.priceCharged)) : card.videoPriceCharged,
    };
    if (next.videoTaskId !== card.videoTaskId || next.videoUrl !== card.videoUrl || next.videoStatus !== card.videoStatus
      || next.videoTaskModelId !== card.videoTaskModelId || next.videoTaskModelName !== card.videoTaskModelName
      || next.videoTaskDuration !== card.videoTaskDuration || next.videoSupportsRemoteCancel !== card.videoSupportsRemoteCancel
      || next.videoMonitoringPaused !== card.videoMonitoringPaused
      || next.videoRetryable !== card.videoRetryable || next.videoBillingState !== card.videoBillingState
      || next.videoPriceCharged !== card.videoPriceCharged) changed = true;
    return next;
  });
  return changed ? { ...run, cards, updatedAt: Date.now() } : run;
}

function statusText(status: TaskStatus) {
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  if (status === "done") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已终止";
  return "待配置";
}

function beijingHistoryDayLabel(value: string | number | Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayNumber = (input: string | number | Date) => {
    const parts = formatter.formatToParts(new Date(input));
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  };
  const age = dayNumber(Date.now()) - dayNumber(value);
  if (age === 0) return "今天";
  if (age === 1) return "昨天";
  if (age === 2) return "前天";
  return "进行中";
}

function cardStatus(card: WorkbenchCard): { label: string; status: TaskStatus } {
  if (card.videoStatus === "running" || card.videoStatus === "queued") return { label: card.videoStatus === "queued" ? "视频排队中" : "视频生成中", status: card.videoStatus };
  if (card.videoStatus === "done") return { label: "视频完成", status: "done" };
  if (card.videoStatus === "failed") return { label: "视频失败", status: "failed" };
  if (card.videoStatus === "cancelled") return { label: "视频已终止", status: "cancelled" };
  if (card.imageStatus === "running" || card.imageStatus === "queued") return { label: card.imageStatus === "queued" ? "生图排队中" : "生图中", status: card.imageStatus };
  if (isUnavailableCompletedInlineImage(card)) return { label: "已完成·临时图片不可恢复", status: "done" };
  if (card.imageRecoveryReady) return { label: "正在保存图片", status: "running" };
  if (card.imageRetryBlocked) return { label: "图片结果待确认", status: "failed" };
  if (card.imageStatus === "done") return { label: "图片完成", status: "done" };
  if (card.imageStatus === "failed") return { label: "生图失败", status: "failed" };
  return { label: "待配置", status: "idle" };
}

function publicModelName(model: { name?: string; display_name?: string }) {
  return String(model.display_name || model.name || "通用模型").trim() || "通用模型";
}

function isStoryboardVideoModel(model: VideoModel) {
  const surfaces = new Set(model.workspaceSurfaces.map((value) => value.trim().toLowerCase()));
  const identity = `${model.displayName || ""} ${model.name || ""}`.toLowerCase();
  const isDigitalHuman = surfaces.has("digital-human")
    || /数字人|口播|口型|对口型|lip[\s_-]*sync|talking[\s_-]*head/u.test(identity);
  return !isDigitalHuman
    && (surfaces.has("storyboard") || surfaces.has("ai-video"))
    && model.supportsImageInput
    && model.maxDuration > 0;
}

function modelChannelCode(model: { displayName?: string; name?: string; variantLabel?: string }) {
  const label = String(model.variantLabel || "").trim().toUpperCase();
  // The public catalog owns variant identity. Provider names cannot override it.
  if (label === "L") return "";
  if (/^[A-Z]$/u.test(label)) return label;
  return "";
}

function compactVideoModelName(model: VideoModel) {
  return compactPublicVideoModelName(publicModelName(model));
}

function videoModelNeedsReference(model: VideoModel) {
  return model.requiresImage;
}

function storyboardImageModelName(model: ImageModel) {
  const publicName = publicModelName(model).replace(/\s+/gu, " ").trim();
  const compactName = publicName.split("·", 1)[0]?.trim()
    .replace(/\s*[（(][^）)]*[）)]\s*$/u, "")
    .trim() || "通用生图模型";
  const channelCode = modelChannelCode(model);
  return channelCode ? `${compactName} · ${channelCode}` : compactName;
}

function storyboardImageRatioIssue(card: WorkbenchCard, ratio: WorkbenchRatio) {
  if (hasValidatedImage(card) && card.imageWidth && card.imageHeight
    && !imageDimensionsMatchAspectRatio(card.imageWidth, card.imageHeight, ratio)) {
    return `实际图片 ${card.imageWidth}×${card.imageHeight} 与 ${ratio} 不一致；请重新生图后再提交视频`;
  }
  const generatedRatio = card.imageRequestSnapshot?.aspectRatio;
  if (!hasValidatedImage(card) || !generatedRatio || generatedRatio === ratio) return "";
  return `当前故事板按 ${generatedRatio} 生成，工作台已切换为 ${ratio}；请重新生图后再提交视频`;
}

async function requestVideoAccessUrl(
  taskId: string,
  token: string,
  options?: { scope?: "playback" | "download"; filename?: string; source?: "origin" },
) {
  if (!taskId || !token) throw new Error("缺少视频访问凭据");
  const params = new URLSearchParams({ taskId, scope: options?.scope || "playback" });
  if (options?.filename) params.set("name", options.filename);
  if (options?.source) params.set("source", options.source);
  const response = await fetch(`/api/video/access-ticket?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
  if (!response.ok || !data.url) throw new Error(data.error || "视频访问凭据生成失败");
  return data.url;
}

function TicketedVideo({ url, taskId, token, poster, onExpand }: { url: string; taskId?: string; token: string; poster?: string; onExpand: (url: string) => void }) {
  const [src, setSrc] = useState(url);
  const [retried, setRetried] = useState(false);
  const [ticketError, setTicketError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const automaticRefreshesRef = useRef(0);

  useEffect(() => {
    automaticRefreshesRef.current = 0;
  }, [taskId, url]);

  useEffect(() => {
    let active = true;
    setRetried(false);
    setTicketError(false);
    if (!taskId || !token) {
      setSrc(url);
      setTicketError(!url);
      return () => { active = false; };
    }
    setSrc(url);
    void requestVideoAccessUrl(taskId, token)
      .then((nextUrl) => {
        if (!active) return;
        setSrc(nextUrl);
        setTicketError(false);
      })
      .catch(() => {
        if (!active) return;
        setSrc(url);
        setTicketError(!url);
      });
    return () => { active = false; };
  }, [refreshKey, taskId, token, url]);

  useEffect(() => {
    if (!ticketError || automaticRefreshesRef.current >= 3) return;
    const attempt = automaticRefreshesRef.current++;
    const timer = window.setTimeout(() => setRefreshKey((value) => value + 1), [2_000, 5_000, 10_000][attempt]);
    return () => window.clearTimeout(timer);
  }, [ticketError, refreshKey]);

  if (!src) return (
    <div className="sbw-empty-state sbw-playback-unavailable">
      {poster ? <img src={poster} alt="视频首帧封面" /> : <Film />}
      <strong>播放地址暂不可用</strong>
      <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>刷新播放地址</button>
    </div>
  );
  return (
    <div className="sbw-ticketed-video">
      <video
        key={src}
        src={src}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        onError={() => {
          if (retried || !taskId || !token) {
            setSrc("");
            setTicketError(true);
            return;
          }
          setRetried(true);
          void requestVideoAccessUrl(taskId, token, { source: "origin" })
            .then((nextUrl) => { setSrc(nextUrl); setTicketError(false); })
            .catch(() => { setSrc(""); setTicketError(true); });
        }}
      />
      <button type="button" className="sbw-video-expand" title="放大播放" aria-label="放大播放视频" onClick={() => onExpand(src)}><Eye /></button>
      {ticketError && <span className="sr-only">播放地址暂不可用</span>}
    </div>
  );
}

function triggerDownload(targetUrl: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = targetUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function openVideoDownload(taskId: string | undefined, filename: string, token: string) {
  if (!taskId) throw new Error("缺少视频任务编号，无法获取安全下载票据");
  if (!token) throw new Error("登录状态已失效，请重新登录后下载");
  const ticketUrl = await requestVideoAccessUrl(taskId, token, { scope: "download", filename });
  triggerDownload(ticketUrl, filename);
}

type PreviewMedia = { url: string; type: "image" | "video"; poster?: string };

const PREVIEW_ZOOM_MIN = 0.7;
const PREVIEW_ZOOM_MAX = 1.4;
const PREVIEW_ZOOM_STEP = 0.1;

function MediaLightbox({ media, onClose }: { media: PreviewMedia; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    const fullscreenElement = document.fullscreenElement;
    if (fullscreenElement && dialogRef.current?.contains(fullscreenElement)) {
      void document.exitFullscreen().catch(() => undefined).finally(onClose);
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    setZoom(1);
  }, [media.url]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === dialogRef.current);
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape, true);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape, true);
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      previouslyFocused?.focus();
    };
  }, [close]);

  const updateZoom = (delta: number) => {
    setZoom((current) => Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, Number((current + delta).toFixed(1)))));
  };
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await dialogRef.current?.requestFullscreen();
  };
  const zoomPercent = Math.round(zoom * 100);

  return createPortal(
    <div
      ref={dialogRef}
      className="sbw-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={media.type === "video" ? "视频放大预览" : "故事板图片放大预览"}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div className="sbw-lightbox-toolbar" role="toolbar" aria-label="媒体预览工具栏">
        <button type="button" aria-label="缩小预览" title="缩小 10%" disabled={zoom <= PREVIEW_ZOOM_MIN} onClick={() => updateZoom(-PREVIEW_ZOOM_STEP)}><ZoomOut /></button>
        <output aria-live="polite" aria-label="当前缩放比例">{zoomPercent}%</output>
        <button type="button" aria-label="放大预览" title="放大 10%" disabled={zoom >= PREVIEW_ZOOM_MAX} onClick={() => updateZoom(PREVIEW_ZOOM_STEP)}><ZoomIn /></button>
        <button type="button" aria-label={isFullscreen ? "退出全屏" : "进入全屏"} title={isFullscreen ? "退出全屏" : "进入全屏"} onClick={() => void toggleFullscreen().catch(() => undefined)}><Maximize2 /></button>
        <button ref={closeButtonRef} type="button" aria-label="关闭预览" title="关闭预览（Esc）" onClick={close}><X /></button>
      </div>
      <div className="sbw-lightbox-stage" onMouseDown={(event) => event.target === event.currentTarget && close()}>
        {media.type === "video"
          ? <video key={media.url} src={media.url} poster={media.poster} controls autoPlay playsInline style={{ transform: `scale(${zoom})` }} />
          : <img src={media.url} alt="故事板原图预览" style={{ transform: `scale(${zoom})` }} />}
      </div>
    </div>,
    document.body,
  );
}

function effectiveVideoDuration(model?: VideoModel, requested?: number) {
  const capabilities = getVideoDurationCapabilities(model);
  return coerceVideoTargetDuration(model, Number(requested) || capabilities.defaultDuration);
}

function videoDurationOptions(model?: VideoModel) {
  return getVideoTargetDurationOptions(model);
}

function effectiveVideoResolution(model?: VideoModel, requested = "") {
  return resolveStoryboardVideoResolution(model, requested);
}

function preferredStoryboardImageResolution(model?: ImageModel) {
  const capabilities = getImageModelCapabilities(model);
  return capabilities.defaultResolution;
}

function storyboardImagePrice(model: ImageModel | null | undefined, resolution: string) {
  const resolutionPrice = model?.resolution_prices?.[resolution.toUpperCase()];
  if (Number.isFinite(resolutionPrice)) return Number(resolutionPrice);
  const basePrice = Number(model?.selling_price);
  return Number.isFinite(basePrice) ? basePrice : Number.NaN;
}

function effectiveImageResolution(model?: ImageModel, requested = "") {
  const capabilities = getImageModelCapabilities(model);
  return capabilities.resolutionOptions.find((value) => value === requested) || preferredStoryboardImageResolution(model);
}

function effectiveVideoPrice(model?: VideoModel, requested = "") {
  if (!model) return 0;
  return resolveVideoResolution(model, requested).publicPrice;
}

function effectiveVideoCharge(model?: VideoModel, requested = "", duration?: number) {
  if (!model) return 0;
  const unitPrice = effectiveVideoPrice(model, requested);
  return model.billingUnit === "output_second"
    ? unitPrice * effectiveVideoDuration(model, duration)
    : unitPrice;
}

function videoResolutionPriceLabel(model: VideoModel, resolution: string, duration: number) {
  const charge = effectiveVideoCharge(model, resolution, duration);
  if (!model.priceReady || !Number.isFinite(charge)) return "价格待配置";
  return `¥${charge.toFixed(2)}${model.billingUnit === "output_second" ? `/${duration}秒` : "/次"}`;
}

function submittedVideoPrompt(prompt: string, model?: VideoModel, requestedDuration?: number) {
  const duration = effectiveVideoDuration(model, requestedDuration);
  return buildStoryboardVideoPrompt({ prompt, duration });
}

export function StoryboardWorkbench() {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div><SubPageHeader title="分镜工作台" subtitle="请先登录后查看自己的草稿和历史" /><p role="status" className="p-6 text-sm text-[var(--muted-foreground)]">正在确认登录状态；如未登录，请先登录。</p></div>;
  return <UserStoryboardWorkbench
    key={identity.userId}
    identity={identity}
    showAdminModelIds={state.auth.user?.role === "admin"}
  />;
}

function UserStoryboardWorkbench({
  identity,
  showAdminModelIds,
}: {
  identity: WorkbenchIdentity;
  showAdminModelIds: boolean;
}) {
  const { token, userId } = identity;
  const currentStorageKey = workbenchUserStorageKey(CURRENT_KEY, userId);
  const historyStorageKey = workbenchUserStorageKey(HISTORY_KEY, userId);
  const idleDraftStorageKey = workbenchUserStorageKey(STORYBOARD_IDLE_DRAFT_KEY, userId);
  const cloud = useStoryboardProjects<WorkbenchRun>(userId, token);
  const saveStoryboardProject = cloud.save;
  const cloudReady = cloud.ready;
  const [run, setRun] = useState<WorkbenchRun>(() => createRun());
  const [history, setHistory] = useState<WorkbenchRun[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [imageModelCatalogState, setImageModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [videoModelCatalogState, setVideoModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [modelCatalogReloadKey, setModelCatalogReloadKey] = useState(0);
  const [batchMode, setBatchMode] = useState<BatchMode>("");
  const [notice, setNotice] = useState("从创作智能体发送分镜后会自动建卡，也可直接填写每个任务的提示词");
  const [storageReady, setStorageReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [videoHistoryTasks, setVideoHistoryTasks] = useState<HistoryVideoTask[]>([]);
  const [videoHistoryLoading, setVideoHistoryLoading] = useState(false);
  const [videoHistoryError, setVideoHistoryError] = useState("");
  const [expandedHistoryVideoTaskId, setExpandedHistoryVideoTaskId] = useState("");
  const [openingProjectVideoKey, setOpeningProjectVideoKey] = useState("");
  const [imageFailureHistory, setImageFailureHistory] = useState<StoryboardImageFailureRecord[]>([]);
  const [imageFailureHistoryLoading, setImageFailureHistoryLoading] = useState(false);
  const [imageFailureHistoryError, setImageFailureHistoryError] = useState("");
  const [imageFailureHistoryNextPage, setImageFailureHistoryNextPage] = useState<number | null>(null);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [uploadingCardId, setUploadingCardId] = useState("");
  const [expandedVideoCards, setExpandedVideoCards] = useState<Set<string>>(() => new Set());
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [generalScriptHandoff, setGeneralScriptHandoff] = useState<GeneralScriptHandoffPanelState>({ status: "hidden" });
  const [generalScriptImportedRunId, setGeneralScriptImportedRunId] = useState("");
  const [agentHandoff, setAgentHandoff] = useState<AgentHandoffPanelState>({ status: "hidden" });
  const agentHandoffConsumedRef = useRef(false);
  const runRef = useRef(run);
  const historyRef = useRef(history);
  const imageModelsRef = useRef<ImageModel[]>([]);
  const videoModelsRef = useRef<VideoModel[]>([]);
  const pollingTasksRef = useRef(new Set<string>());
  const videoPollControllersRef = useRef(new Map<string, AbortController>());
  const h3LifecyclePollControllersRef = useRef(new Map<string, AbortController>());
  const videoSubmissionControllersRef = useRef(new Map<string, AbortController>());
  const videoRequestReconciliationsRef = useRef(new Set<string>());
  const videoRequestAutoCheckedRef = useRef(new Set<string>());

  const copyAdminModelId = useCallback(async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setNotice(`模型 ID 已复制：${modelId}`);
    } catch {
      setNotice(`复制失败，请手动复制模型 ID：${modelId}`);
    }
  }, []);
  const validatingImagesRef = useRef(new Set<string>());
  const hydratingStoredImagesRef = useRef(new Set<string>());
  const hydratedStoredImageKeysRef = useRef(new Set<string>());
  const imageStatusChecksRef = useRef(new Set<string>());
  const imageSubmissionsRef = useRef(new Set<string>());
  const imageAutoResumeAttemptsRef = useRef(new Map<string, number>());
  const imageAutoResumeTimersRef = useRef(new Map<string, number>());
  const videoSubmissionsRef = useRef(new Set<string>());
  // Submitted runs stay in history; reopening the editor does not restore a draft.
  const submittedRunIdsRef = useRef(new Set<string>());
  const videoHistoryHydratedRef = useRef(false);
  const uploadInputsRef = useRef<Record<string, HTMLInputElement | null>>({});
  const videoSectionsRef = useRef<Record<string, HTMLElement | null>>({});
  const scopeMountedRef = useRef(true);
  const ephemeralImageUrlsRef = useRef(new Set<string>());
  const imageDownloadOwnerRef = useRef(userId + "\0" + token);
  imageDownloadOwnerRef.current = userId + "\0" + token;
  const imageDownloadOperationsRef = useRef(new ImageDownloadOperations(() => scopeMountedRef.current ? imageDownloadOwnerRef.current : null));
  useEffect(() => () => imageDownloadOperationsRef.current.cancelAll(), [userId, token]);

  const downloadStoryboardImage = useCallback(async (card: WorkbenchCard) => {
    if (!scopeMountedRef.current || !card.imageUrl) return;
    const filename = `${String(card.order).padStart(2, "0")}-故事板.png`;
    if (card.imageDeliveryMode !== "provider_url") {
      triggerDownload(card.imageUrl, filename);
      return;
    }
    const owner = userId + "\0" + token;
    const operation = imageDownloadOperationsRef.current.begin(owner);
    let blobUrl: string | undefined;
    try {
      operation.assertCurrent();
      const reference = GeneratedImageReferenceSchema.safeParse(card.imageRef || { schema: "generated_image_ref.v1", recordId: card.imageRecordId });
      if (!reference.success || reference.data.recordId !== card.imageRecordId) throw new Error("图片归属凭证无效");
      const blob = await readImageDownloadBlob({ kind: "provider_url", recordId: reference.data.recordId }, token, operation.signal);
      operation.assertCurrent();
      blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, imageDownloadFilename(filename, blob));
    } catch {
      if (!operation.signal.aborted && scopeMountedRef.current && imageDownloadOwnerRef.current === owner) {
        setNotice("图片当前不可下载；任务与费用收据仍保留，请稍后重试");
      }
    } finally {
      operation.finish();
      if (blobUrl) window.setTimeout(() => URL.revokeObjectURL(blobUrl!), 500);
    }
  }, [userId, token]);

  useEffect(() => {
    // Submitted work is recovered from the owned project/history APIs. Older
    // browser snapshots contained prompts and stable reference URLs, so remove
    // every legacy copy instead of restoring editable content after refresh.
    try {
      for (const key of [
        CURRENT_KEY,
        HISTORY_KEY,
        STORYBOARD_IDLE_DRAFT_KEY,
        currentStorageKey,
        historyStorageKey,
        idleDraftStorageKey,
      ]) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }
    } catch {}
    historyRef.current = [];
    setHistory([]);
    setStorageReady(true);

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("entry") === "agent" && searchParams.get("handoff") === "storyboard" && !agentHandoffConsumedRef.current) {
      agentHandoffConsumedRef.current = true;
      const parsedAgentHandoff = readAgentWorkbenchHandoff("storyboard-workbench", createUserScopedWorkbenchStorage(sessionStorage, userId));
      if (parsedAgentHandoff.ok) {
        const plan = parseStoryboardCanvasImport(parsedAgentHandoff.handoff.payload);
        if (plan) {
          setAgentHandoff({ status: "ready", handoff: parsedAgentHandoff.handoff, plan });
          setNotice("已读取创作 Agent 分镜交接预览；确认前不会覆盖工作台，也不会调用模型或扣费");
        } else {
          setAgentHandoff({ status: "error", error: "Agent 分镜机器包未通过工作台校验，未执行导入。" });
        }
      } else {
        setAgentHandoff({ status: "error", error: parsedAgentHandoff.error });
        setNotice(parsedAgentHandoff.error);
      }
    }
    if (
      searchParams.get("entry") === "short-drama"
      && searchParams.get("handoff") === "general-script"
    ) {
      const handoffStorageKey = workbenchUserStorageKey(GENERAL_SCRIPT_HANDOFF_STORAGE_KEY, userId);
      const receiptStorageKey = workbenchUserStorageKey(GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY, userId);
      let handoffRaw: string | null = null;
      let receiptRaw: string | null = null;
      try {
        handoffRaw = sessionStorage.getItem(handoffStorageKey);
        receiptRaw = sessionStorage.getItem(receiptStorageKey);
        // Same-tab handoffs are single use. Remove before parsing so malformed
        // or abandoned content cannot reappear on refresh.
        sessionStorage.removeItem(handoffStorageKey);
        sessionStorage.removeItem(receiptStorageKey);
        for (const legacyKey of [GENERAL_SCRIPT_HANDOFF_STORAGE_KEY, GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY]) {
          localStorage.removeItem(legacyKey);
          sessionStorage.removeItem(legacyKey);
          localStorage.removeItem(workbenchUserStorageKey(legacyKey, userId));
        }
      } catch {}
      const parsedHandoff = parseGeneralScriptStoryboardHandoff(
        handoffRaw,
        {
          nowMs: Date.now(),
          consumedReceiptRaw: receiptRaw,
        },
      );
      if (parsedHandoff.ok) {
        setGeneralScriptHandoff({ status: "ready", handoff: parsedHandoff.value });
        setNotice("已读取通用短剧交接预览；确认前不会覆盖工作台，也不会调用模型或扣费");
      } else {
        setGeneralScriptHandoff({ status: "error", code: parsedHandoff.code, error: parsedHandoff.error });
        setNotice(parsedHandoff.error);
      }
    }

    const reviewId = searchParams.get("review")?.trim();
    if (!reviewId || !/^[a-zA-Z0-9_-]+$/.test(reviewId)) return;
    setNotice(`分享记录 ${reviewId} 已失效或不可访问`);
  }, [currentStorageKey, historyStorageKey, idleDraftStorageKey, userId]);

  useEffect(() => {
    if (!storageReady) return;
    runRef.current = run;
    if (submittedRunIdsRef.current.has(run.id)) {
      setHistory((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, MAX_HISTORY));
    }
  }, [run, storageReady]);

  useEffect(() => {
    if (!storageReady || !cloudReady) return;
    // Typing, importing prompts or selecting references is session-only until
    // the user explicitly saves or starts a generation attempt. Previously any
    // input created an account project after 1.2s and brought stale drafts back
    // on the next visit.
    const shouldPersist = submittedRunIdsRef.current.has(run.id) || hasSubmittedWork(run);
    if (!shouldPersist) return;
    const timer = window.setTimeout(() => { void saveStoryboardProject(createStoryboardPersistenceSnapshot(run)); }, 1200);
    return () => window.clearTimeout(timer);
  }, [cloudReady, run, saveStoryboardProject, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    historyRef.current = history;
  }, [history, storageReady]);

  const loadVideoHistory = useCallback(async () => {
    if (!storageReady || !token) return;
    setVideoHistoryLoading(true);
    setVideoHistoryError("");
    try {
      const response = await fetch("/api/video/history?surface=storyboard-workbench&limit=200", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as { tasks?: HistoryVideoTask[]; error?: string };
      if (!response.ok) throw new Error(data.error || "视频记录暂时无法读取");
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      setVideoHistoryTasks(tasks);
      setHistory((current) => current.map((record) => hydrateRunVideoTasks(record, tasks)));
      setRun((current) => {
        const next = hydrateRunVideoTasks(current, tasks);
        runRef.current = next;
        return next;
      });
    } catch (error) {
      setVideoHistoryError(error instanceof Error ? error.message : "视频记录暂时无法读取");
    } finally {
      setVideoHistoryLoading(false);
    }
  }, [storageReady, token]);

  // 旧历史可能只保存了已过期的 videoUrl。用服务端任务记录补回稳定 task id
  // 和最新播放凭据；同时保留独立任务列表，避免后端完成但工程卡片尚未映射时结果消失。
  useEffect(() => {
    if (!storageReady || !token || videoHistoryHydratedRef.current) return;
    videoHistoryHydratedRef.current = true;
    void loadVideoHistory();
  }, [loadVideoHistory, run.id, storageReady, token]);

  useEffect(() => {
    setExpandedVideoCards(new Set(runRef.current.cards
      .filter((card) => Boolean(card.videoUrl) || isActiveVideoStatus(card.videoStatus) || card.videoStatus === "failed" || card.videoStatus === "cancelled")
      .map((card) => card.id)));
  }, [run.id]);

  useEffect(() => {
    if (!run.cards.some((card) => isActiveVideoStatus(card.videoStatus))) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.cards]);

  useEffect(() => {
    scopeMountedRef.current = true;
    const polls = videoPollControllersRef.current;
    const lifecycles = h3LifecyclePollControllersRef.current;
    const submissions = videoSubmissionControllersRef.current;
    return () => {
      scopeMountedRef.current = false;
      imageDownloadOperationsRef.current.cancelAll();
      for (const url of ephemeralImageUrlsRef.current) URL.revokeObjectURL(url);
      ephemeralImageUrlsRef.current.clear();
      for (const controller of polls.values()) controller.abort();
      for (const controller of lifecycles.values()) controller.abort();
      for (const controller of submissions.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    const visible = new Set(run.cards.map(card => card.imageUrl).filter(Boolean));
    if (previewMedia?.url) visible.add(previewMedia.url);
    for (const url of ephemeralImageUrlsRef.current) if (!visible.has(url)) {
      URL.revokeObjectURL(url);
      ephemeralImageUrlsRef.current.delete(url);
    }
  }, [run.cards, previewMedia]);

  useEffect(() => {
    let active = true;
    setImageModelCatalogState("loading");
    setVideoModelCatalogState("loading");

    const readCatalog = (url: string, fallbackMessage: string) => (
      fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(MODEL_CATALOG_REQUEST_TIMEOUT_MS),
      }).then(async (response) => {
        const data = await response.json().catch(() => ({})) as { models?: ModelApiRecord[]; error?: string };
        if (!response.ok) throw new Error(data.error || fallbackMessage);
        return data;
      })
    );

    const reconcileCatalogSelection = (nextImages: ImageModel[], nextVideos: VideoModel[]) => {
      setRun((current) => {
        const imageModelId = current.imageModelId
          || nextImages.find((model) => !storyboardImageModelSelectionIssue(model))?.id
          || "";
        const selectedImageModel = nextImages.find((model) => model.id === imageModelId);
        const imageResolution = effectiveImageResolution(selectedImageModel, current.imageResolution);
        const requestedVideoModelId = current.videoModelId || current.videoContract?.modelId;
        const videoModelId = resolveStoryboardInitialVideoModelId(requestedVideoModelId, nextVideos);
        const selectedVideoModel = nextVideos.find((model) => model.id === videoModelId);
        const selectedContract = videoModelId === current.videoContract?.modelId ? current.videoContract : undefined;
        const requestedVideoResolution = selectedContract?.resolution || current.videoResolution;
        const requestedVideoDuration = selectedContract?.duration || current.videoDuration;
        const resolvedVideoSelection = selectedVideoModel
          ? resolveStoryboardVideoSelection(selectedVideoModel, {
              ratio: selectedContract?.ratio || current.ratio,
              duration: requestedVideoDuration,
              resolution: requestedVideoResolution,
            })
          : null;
        const videoResolution = resolvedVideoSelection?.resolution || requestedVideoResolution;
        const videoDuration = resolvedVideoSelection?.duration || requestedVideoDuration;
        const supportedRatios = supportedWorkbenchRatios(selectedImageModel, selectedVideoModel);
        const requestedRatio = (resolvedVideoSelection?.ratio || selectedContract?.ratio || current.ratio) as WorkbenchRatio;
        const ratio = supportedRatios.length > 0 && !supportedRatios.includes(requestedRatio)
          ? supportedRatios[0]
          : requestedRatio;
        const next = {
          ...current,
          ratio,
          imageModelId,
          imageResolution,
          videoModelId,
          videoResolution,
          videoDuration,
        };
        runRef.current = next;
        return next;
      });
    };

    const loadImageCatalog = async () => {
      for (const retryDelayMs of MODEL_CATALOG_RETRY_DELAYS_MS) {
        if (retryDelayMs > 0) await delay(retryDelayMs);
        if (!active) return;
        try {
          const data = await readCatalog("/api/cover-models?surface=storyboard-workbench", "生图模型加载失败");
          if (!active) return;
          const nextImages = selectStoryboardImageModels(
            (data.models || []).map(normalizeImageModel).filter((model) => Boolean(model.id)),
          );
          imageModelsRef.current = nextImages;
          setImageModels(nextImages);
          setImageModelCatalogState("ready");
          reconcileCatalogSelection(nextImages, videoModelsRef.current);
          return;
        } catch {
          // Bounded retries keep this catalog independent from the video catalog.
        }
      }
      if (active) setImageModelCatalogState("error");
    };

    const loadVideoCatalog = async () => {
      for (const retryDelayMs of MODEL_CATALOG_RETRY_DELAYS_MS) {
        if (retryDelayMs > 0) await delay(retryDelayMs);
        if (!active) return;
        try {
          const data = await readCatalog("/api/video/models?surface=storyboard-workbench", "视频模型加载失败");
          if (!active) return;
          const nextVideos = (data.models || []).map(normalizeVideoModel)
            // Keep the complete configured catalog visible. Capability and
            // channel restrictions are rendered as disabled-card reasons;
            // they must not make a configured model disappear from the rail.
            .filter((model) => Boolean(model.id))
            .sort((left, right) => Number(!storyboardVideoModelSelectionIssue(right, { ratio: "16:9", duration: right.durationSeconds }))
              - Number(!storyboardVideoModelSelectionIssue(left, { ratio: "16:9", duration: left.durationSeconds })));
          videoModelsRef.current = nextVideos;
          setVideoModels(nextVideos);
          setVideoModelCatalogState("ready");
          reconcileCatalogSelection(imageModelsRef.current, nextVideos);
          return;
        } catch {
          // Bounded retries keep this catalog independent from the image catalog.
        }
      }
      if (active) setVideoModelCatalogState("error");
    };

    void loadImageCatalog();
    void loadVideoCatalog();
    return () => { active = false; };
  }, [modelCatalogReloadKey]);

  const activeImageModel = useMemo(() => imageModels.find((model) => model.id === run.imageModelId), [imageModels, run.imageModelId]);
  const activeVideoModel = useMemo(() => videoModels.find((model) => model.id === run.videoModelId), [run.videoModelId, videoModels]);
  const videoPromptRequired = activeVideoModel?.supportsPrompt !== false;
  const imageCapabilities = useMemo(() => getImageModelCapabilities(activeImageModel), [activeImageModel]);
  const activeImageResolution = effectiveImageResolution(activeImageModel, run.imageResolution);
  const activeVideoResolution = effectiveVideoResolution(activeVideoModel, run.videoResolution);
  const activeVideoDuration = effectiveVideoDuration(activeVideoModel, run.videoDuration);
  const activeVideoPrice = effectiveVideoCharge(activeVideoModel, activeVideoResolution, activeVideoDuration);
  const activeVideoDurationOptions = useMemo(() => videoDurationOptions(activeVideoModel), [activeVideoModel]);
  const activeRatioOptions = useMemo(
    () => supportedWorkbenchRatios(activeImageModel, activeVideoModel),
    [activeImageModel, activeVideoModel],
  );
  const activeImageSelectionIssue = activeImageModel
    ? storyboardImageModelSelectionIssue(activeImageModel)
    : "图片模型尚未加载";
  const activeVideoSelectionIssue = activeVideoModel
    ? storyboardVideoModelSelectionIssue(activeVideoModel, {
        ratio: run.ratio,
        duration: run.videoDuration,
        resolution: run.videoResolution,
      })
    : "视频模型尚未加载";
  const canRemotelyCancelVideoTask = useCallback((card: WorkbenchCard) => {
    return storyboardTaskCanCancel(card, videoModels);
  }, [videoModels]);
  const canRequestVideoTermination = useCallback((card: WorkbenchCard) => {
    return storyboardTaskCanRequestTermination(card);
  }, []);
  const submittedVideoTaskLabel = (card: WorkbenchCard) => {
    const model = videoModels.find(item => item.id === card.videoTaskModelId);
    const name = compactPublicVideoModelName(card.videoTaskModelName || (model ? publicModelName(model) : "已提交的视频模型"));
    return `${name}${card.videoTaskDuration ? ` · ${card.videoTaskDuration}秒` : ""}`;
  };
  const referenceLimit = imageCapabilities.supportsReferenceInput
    ? Math.min(MAX_REFERENCES, imageCapabilities.maxReferenceImages)
    : 0;
  const activeVideoGuardrail = storyboardVideoRuntimeGuard(activeVideoDuration);

  const patchRun = useCallback((patch: Partial<WorkbenchRun>) => {
    setRun((current) => {
      const next = { ...current, ...patch, updatedAt: Date.now() };
      runRef.current = next;
      return next;
    });
  }, []);

  const patchCard = useCallback((cardId: string, patch: Partial<WorkbenchCard>, runPatch?: Pick<WorkbenchRun, "lastSubmittedAt">) => {
    setRun((current) => {
      const next = {
        ...current,
        ...runPatch,
        updatedAt: Date.now(),
        cards: current.cards.map((card) => card.id === cardId ? { ...card, ...patch } : card),
      };
      runRef.current = next;
      return next;
    });
  }, []);

  const inspectStoryboardImageAttempt = useCallback(async (card: WorkbenchCard) => {
    const clientIdempotencyKey = String(card.imageClientRequestId || "").trim();
    const clientTraceId = deriveStoryboardImageTraceId(card);
    if (!token || !clientIdempotencyKey || !clientTraceId) return null;
    const query = new URLSearchParams({ clientIdempotencyKey, clientTraceId });
    const response = await fetch(`/api/image/status?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as StoryboardImageAttemptStatus;
    if (!response.ok) throw new Error(data.error || "生图状态暂时无法确认");
    return data;
  }, [token]);

  const readOwnedStoryboardImage = useCallback(async (
    reference: { assetId?: string; storageKey?: string },
    expectedAspectRatio?: WorkbenchRatio,
  ) => {
    if (!token || (!reference.assetId && !reference.storageKey)) throw new Error("图片资产标识缺失");
    const query = new URLSearchParams();
    if (reference.assetId) query.set("assetId", reference.assetId);
    if (reference.storageKey) query.set("storageKey", reference.storageKey);
    const response = await fetch(`/api/storyboard/image?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as {
      url?: string;
      assetId?: string;
      storageKey?: string;
      error?: string;
    };
    if (!response.ok || !data.url || !data.assetId || !data.storageKey) {
      throw new Error(data.error || "故事板图片读取失败");
    }
    const dimensions = await browserImageReady(data.url);
    if (expectedAspectRatio && !imageDimensionsMatchAspectRatio(dimensions.width, dimensions.height, expectedAspectRatio)) {
      throw new RetryableImageFileError(`实际图片 ${dimensions.width}×${dimensions.height} 与 ${expectedAspectRatio} 不一致`);
    }
    return { url: data.url, assetId: data.assetId, storageKey: data.storageKey, ...dimensions };
  }, [token]);

  useEffect(() => {
    if (!storageReady || !token) return;
    let active = true;

    const inspectActiveImages = async () => {
      const candidates = runRef.current.cards.filter((card) => (
        !imageSubmissionsRef.current.has(card.id)
        && !isCompletedInlineImageReceipt(card)
        && (card.imageStatus === "running"
          || card.imageStatus === "queued"
          || card.imageRetryBlocked === true)
      ));
      await Promise.all(candidates.map(async (card) => {
        if (!active || imageStatusChecksRef.current.has(card.id)) return;
        const requestId = String(card.imageClientRequestId || "").trim();
        const traceId = deriveStoryboardImageTraceId(card);
        if (!requestId || !traceId) {
          patchCard(card.id, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图任务缺少可核验的请求号，已锁定重试；不会自动重新生成。",
          });
          return;
        }
        imageStatusChecksRef.current.add(card.id);
        try {
          const status = await inspectStoryboardImageAttempt(card);
          if (!active || !status) return;
          if (status.state === "rejected" && status.canResubmit === true && status.sameKeyCanResubmit === false) {
            const snapshot = card.imageRequestSnapshot;
            if (isStoryboardImageRequestSnapshot(snapshot)) {
              clearBrowserClientAttempt(`storyboard-image:${snapshot.runId}:${snapshot.cardId}`, requestId);
            }
            patchCard(card.id, {
              imageStatus: "failed",
              imageClientRequestId: undefined,
              imageClientTraceId: undefined,
              imageClientRequestFingerprint: undefined,
              imageRequestSnapshot: undefined,
              imageRecoveryReady: false,
              imageRetryBlocked: false,
              imageError: status.message || "本次请求已确认未被受理，可以由用户重新提交。",
            });
            return;
          }
          if (status.state === "completed" && status.deliveryMode === "inline_ephemeral") {
            const latest = runRef.current.cards.find(item => item.id === card.id);
            const keepMedia = Boolean(latest && latest.imageRecordId === status.recordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
            patchCard(card.id, { ...storyboardInlineReceiptFields(status), imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRef: undefined, imageRecordId: status.recordId, imageDeliveryMode: "inline_ephemeral", imageRecoveryReady: false, imageRetryBlocked: !keepMedia, imageError: keepMedia ? undefined : "图片已生成且费用收据已保留；临时图片仅原页面可用，刷新后无法恢复" });
            return;
          }
          if (status.state === "completed" && status.deliveryMode === "provider_url" && status.recordId) {
            const parsed = GeneratedImageReferenceSchema.safeParse({ schema: "generated_image_ref.v1", recordId: status.recordId });
            if (parsed.success) {
              patchCard(card.id, { ...storyboardGeneratedReceiptFields(status), imageStatus: "done", imageRef: parsed.data, imageRecordId: parsed.data.recordId, imageDeliveryMode: "provider_url", imageUrl: generatedImagePreviewUrl(parsed.data), imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined });
              return;
            }
          }
          if (status.canRecover === true) {
            if (status.state === "completed" && status.assetId) {
              try {
                const restored = await readOwnedStoryboardImage(
                  { assetId: status.assetId },
                  card.imageRequestSnapshot?.aspectRatio || runRef.current.ratio,
                );
                if (!active) return;
                patchCard(card.id, {
                  imageStatus: "done",
                  imageUrl: restored.url,
                  imageAssetId: restored.assetId,
                  imageStorageKey: restored.storageKey,
                  imageWidth: restored.width,
                  imageHeight: restored.height,
                  imageValidatedAt: Date.now(),
                  imageClientTraceId: traceId,
                  imageRecoveryReady: false,
                  imageRetryBlocked: false,
                  imageError: undefined,
                });
              } catch (error) {
                patchCard(card.id, {
                  imageStatus: "running",
                  imageValidatedAt: undefined,
                  imageRecoveryReady: true,
                  imageRetryBlocked: false,
                  imageError: `${error instanceof Error ? error.message : "已完成图片暂时无法读取"}；系统正在重新获取展示地址。`,
                });
              }
              return;
            }
            if (!isStoryboardImageRequestSnapshot(card.imageRequestSnapshot)) {
              patchCard(card.id, {
                imageStatus: "failed",
                imageRecoveryReady: false,
                imageRetryBlocked: true,
                imageError: "原请求已有结果，但旧任务缺少完整记录；请求号已保留，请在最近任务中查看。",
              });
              return;
            }
            patchCard(card.id, {
              imageStatus: "running",
              imageClientTraceId: traceId,
              imageRecoveryReady: true,
              imageRetryBlocked: false,
              imageError: status.message || "图片已生成，系统正在自动完成保存和展示。",
            });
            return;
          }
          if (status.state === "processing") {
            patchCard(card.id, {
              imageStatus: "running",
              imageClientTraceId: traceId,
              imageRecoveryReady: false,
              imageRetryBlocked: true,
              imageError: status.message || "原生图任务仍在处理中；不会重复提交。",
            });
            return;
          }
          patchCard(card.id, {
            imageStatus: "failed",
            imageClientTraceId: traceId,
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: status.message || "图片结果待确认，原请求已保留；不会重复提交。",
          });
        } catch (error) {
          if (!active) return;
          patchCard(card.id, {
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: `${error instanceof Error ? error.message : "生图状态暂时无法确认"}；原请求已保留，勿重复提交。`,
          });
        } finally {
          imageStatusChecksRef.current.delete(card.id);
        }
      }));
    };

    void inspectActiveImages();
    const timer = window.setInterval(() => { void inspectActiveImages(); }, VIDEO_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [inspectStoryboardImageAttempt, patchCard, readOwnedStoryboardImage, run.id, storageReady, token]);

  const monitorAutodlH3Lifecycle = useCallback(async (
    cardId: string,
    taskId: string,
    signal: AbortSignal,
  ) => {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const response = await fetch(`/api/video/h3-lifecycle?taskId=${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({})) as {
          lifecycle?: AutodlH3LifecycleView;
          error?: string;
          code?: string;
        };
        if (!response.ok || !data.lifecycle) {
          throw new Error(data.error || `H3 生命周期查询失败（${response.status}）`);
        }
        consecutiveFailures = 0;
        patchCard(cardId, {
          videoLifecycle: data.lifecycle,
          videoLifecycleError: undefined,
          videoLastCheckedAt: Date.now(),
        });
        if (data.lifecycle.monitorComplete) return;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        consecutiveFailures += 1;
        patchCard(cardId, {
          videoLifecycleError: error instanceof Error ? error.message : "H3 实时状态暂时不可用",
        });
      }
      try {
        await abortableDelay(
          consecutiveFailures > 0 ? Math.max(5_000, H3_LIFECYCLE_POLL_INTERVAL_MS) : H3_LIFECYCLE_POLL_INTERVAL_MS,
          signal,
        );
      } catch {
        return;
      }
    }
  }, [patchCard, token]);

  useEffect(() => {
    if (!storageReady || !token) return;
    const eligibleTaskIds = new Set<string>();
    for (const card of run.cards) {
      const taskId = String(card.videoTaskId || "");
      if (!isAutodlH3LifecycleTaskId(taskId) || card.videoLifecycle?.monitorComplete) continue;
      eligibleTaskIds.add(taskId);
      if (h3LifecyclePollControllersRef.current.has(taskId)) continue;
      const controller = new AbortController();
      h3LifecyclePollControllersRef.current.set(taskId, controller);
      void monitorAutodlH3Lifecycle(card.id, taskId, controller.signal).finally(() => {
        if (h3LifecyclePollControllersRef.current.get(taskId) === controller) {
          h3LifecyclePollControllersRef.current.delete(taskId);
        }
      });
    }
    for (const [taskId, controller] of h3LifecyclePollControllersRef.current.entries()) {
      if (eligibleTaskIds.has(taskId)) continue;
      controller.abort();
      h3LifecyclePollControllersRef.current.delete(taskId);
    }
  }, [monitorAutodlH3Lifecycle, run.cards, storageReady, token]);

  // Review archives persist only an owned COS storage key, never a temporary
  // signed URL. Re-sign it for the current user after login so a refresh keeps
  // already-generated storyboard images without exposing capabilities in the
  // public review JSON or paying for another image generation.
  useEffect(() => {
    if (!storageReady || !token) return;
    for (const card of run.cards) {
      const storageKey = String(card.imageStorageKey || "").trim();
      const hydrationKey = `${card.id}\0${String(card.imageAssetId || "")}\0${storageKey}`;
      if (!storageKey
        || hydratedStoredImageKeysRef.current.has(hydrationKey)
        || hydratingStoredImagesRef.current.has(card.id)) continue;
      hydratingStoredImagesRef.current.add(card.id);
      const query = new URLSearchParams({ storageKey });
      if (card.imageAssetId) query.set("assetId", card.imageAssetId);
      void fetch(`/api/storyboard/image?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
        .then(async (response) => {
          const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
          if (!response.ok || !data.url) throw new Error(data.error || "故事板图片读取失败");
          const dimensions = await browserImageReady(data.url);
          const expectedAspectRatio = card.imageRequestSnapshot?.aspectRatio || runRef.current.ratio;
          if (!imageDimensionsMatchAspectRatio(dimensions.width, dimensions.height, expectedAspectRatio)) {
            throw new Error(`实际图片 ${dimensions.width}×${dimensions.height} 与 ${expectedAspectRatio} 不一致`);
          }
          patchCard(card.id, {
            imageStatus: "done",
            imageUrl: data.url,
            imageWidth: dimensions.width,
            imageHeight: dimensions.height,
            imageValidatedAt: Date.now(),
            imageError: undefined,
          });
          hydratedStoredImageKeysRef.current.add(hydrationKey);
        })
        .catch((error) => patchCard(card.id, {
          imageStatus: "running",
          imageUrl: undefined,
          imageValidatedAt: undefined,
          imageRecoveryReady: true,
          imageRetryBlocked: false,
          imageError: `${error instanceof Error ? error.message : "故事板图片暂时无法读取"}；系统正在重新获取展示地址。`,
        }))
        .finally(() => hydratingStoredImagesRef.current.delete(card.id));
    }
  }, [patchCard, run.cards, storageReady, token]);

  // 切换生图模型时，失败只代表上一次模型/渠道的尝试结束，不应把卡片永久锁死。
  // 保留 Prompt、参考图和视频 Prompt，只清理本次失败产生的临时结果，让用户可以立即重试。
  const selectImageModel = useCallback((model: ImageModel) => {
    const selectionIssue = storyboardImageModelSelectionIssue(model);
    if (selectionIssue) {
      setNotice(`${storyboardImageModelName(model)} ${publicModelSelectionLabel(selectionIssue)}：${selectionIssue}`);
      return;
    }
    const nextRatios = supportedWorkbenchRatios(model, activeVideoModel);
    const nextReferenceLimit = getImageModelCapabilities(model).maxReferenceImages;
    const incompatibleReferenceCards = runRef.current.cards.filter((card) => card.referenceImageUrls.length > nextReferenceLimit).length;
    setRun((current) => {
      const next = {
        ...current,
        updatedAt: Date.now(),
        imageModelId: model.id,
        imageResolution: preferredStoryboardImageResolution(model),
        ratio: nextRatios.includes(current.ratio) ? current.ratio : nextRatios[0] || current.ratio,
        cards: current.cards.map((card) => card.imageStatus === "failed" && !card.imageRetryBlocked && !card.imageRecoveryReady
          ? {
              ...card,
              imageStatus: "idle" as const,
              imageUrl: undefined,
              imageWidth: undefined,
              imageHeight: undefined,
              imageValidatedAt: undefined,
              imageError: undefined,
              imageModelIdUsed: undefined,
              imageModelNameUsed: undefined,
              imageClientRequestId: undefined,
              imageClientTraceId: undefined,
              imageClientRequestFingerprint: undefined,
              imageRequestSnapshot: undefined,
              imageRecoveryReady: false,
              imageRetryBlocked: false,
            }
          : card),
      };
      runRef.current = next;
      return next;
    });
    setNotice(incompatibleReferenceCards > 0
      ? `已选择 ${storyboardImageModelName(model)}；${incompatibleReferenceCards} 张卡片的参考图超过当前上限，请替换或清除后再生图`
      : `已选择 ${storyboardImageModelName(model)}；失败卡片可重新提交，待保存任务将由系统自动完成`);
  }, [activeVideoModel]);

  const loadStoryboardImageFailureHistory = useCallback(async (page = 1) => {
    setImageFailureHistoryLoading(true);
    setImageFailureHistoryError("");
    try {
      const query = new URLSearchParams({ page: String(page), surface: "storyboard-workbench" });
      const response = await fetch(`/api/image-workbench/failure-history?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => ({})) as {
        records?: StoryboardImageFailureRecord[];
        nextPage?: number | null;
        code?: string;
      };
      if (!response.ok || !Array.isArray(data.records)) {
        throw new Error(data.code === "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY"
          ? "分镜生图失败记录服务正在准备中"
          : "分镜生图失败记录暂时无法读取");
      }
      setImageFailureHistory((current) => {
        const rows = page === 1 ? data.records! : [...current, ...data.records!];
        return [...new Map(rows.map((record) => [record.id, record])).values()]
          .sort((left, right) => right.createdAt - left.createdAt);
      });
      setImageFailureHistoryNextPage(Number.isSafeInteger(data.nextPage) ? data.nextPage! : null);
    } catch (error) {
      setImageFailureHistoryError(error instanceof Error ? error.message : "分镜生图失败记录同步失败");
    } finally {
      setImageFailureHistoryLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (historyOpen) void loadStoryboardImageFailureHistory(1);
  }, [historyOpen, loadStoryboardImageFailureHistory]);

  const prepareStoryboardImageFailureRetry = useCallback((record: StoryboardImageFailureRecord) => {
    if (!record.canLoadForRetry) {
      setNotice(record.retryBlockReason || "原任务费用尚未确认，当前不会重新提交");
      return;
    }
    const now = Date.now();
    const base = createRun(1);
    const selectedModel = imageModels.find((model) => model.id === record.publicModelId);
    const next: WorkbenchRun = {
      ...base,
      id: createId("storyboard-image-retry"),
      createdAt: now,
      updatedAt: now,
      title: `失败生图参数 · ${new Date(record.createdAt).toLocaleString("zh-CN")}`,
      ratio: isWorkbenchRatio(record.aspectRatio) ? record.aspectRatio : base.ratio,
      imageResolution: record.resolution || base.imageResolution,
      imageModelId: selectedModel?.id || base.imageModelId,
      cards: [{ ...base.cards[0], imagePrompt: record.prompt }],
    };
    runRef.current = next;
    setRun(next);
    setHistoryOpen(false);
    setNotice(`已载入失败请求的 Prompt、规格和报价；${record.referenceCount ? `原请求含${record.referenceCount}张参考图，请重新上传后` : "核对后"}再点击生成，不会自动提交。`);
  }, [imageModels]);

  const archiveRunSnapshot = useCallback((reason: string) => {
    const current = runRef.current;
    if (!hasSubmittedWork(current)) return;
    const now = Date.now();
    const snapshot: WorkbenchRun = {
      ...current,
      id: createId("storyboard-snapshot"),
      updatedAt: now,
      title: `${current.title} · ${reason}`,
      cards: current.cards.map((card) => ({
        ...card,
        referenceImageUrls: [...card.referenceImageUrls],
      })),
    };
    submittedRunIdsRef.current.add(snapshot.id);
    setHistory((existing) => [snapshot, ...existing].slice(0, MAX_HISTORY));
    void saveStoryboardProject(createStoryboardPersistenceSnapshot(snapshot));
  }, [saveStoryboardProject]);

  useEffect(() => {
    if (!storageReady) return;
    for (const card of run.cards) {
      if (card.imageStatus !== "done" || !card.imageUrl || card.imageValidatedAt || validatingImagesRef.current.has(card.id)) continue;
      validatingImagesRef.current.add(card.id);
      void browserImageReady(card.imageUrl)
        .then(({ width, height }) => {
          const expectedRatio = card.imageRequestSnapshot?.aspectRatio || run.ratio;
          if (!imageDimensionsMatchAspectRatio(width, height, expectedRatio)) {
            patchCard(card.id, {
              imageStatus: "failed",
              imageWidth: width,
              imageHeight: height,
              imageValidatedAt: undefined,
              imageError: `实际图片 ${width}×${height} 与 ${expectedRatio} 不一致，请重新生图`,
            });
            return;
          }
          patchCard(card.id, { imageWidth: width, imageHeight: height, imageValidatedAt: Date.now(), imageError: undefined });
        })
        .catch((error) => patchCard(card.id, {
          imageStatus: "failed",
          imageValidatedAt: undefined,
          imageError: error instanceof Error ? error.message : "图片加载失败",
        }))
        .finally(() => validatingImagesRef.current.delete(card.id));
    }
  }, [patchCard, run.cards, run.ratio, storageReady]);

  const addCard = useCallback(() => {
    setRun((current) => {
      if (current.cards.length >= MAX_CARDS) return current;
      const next = {
        ...current,
        updatedAt: Date.now(),
        cards: [...current.cards, createCard(current.cards.length + 1)],
      };
      runRef.current = next;
      return next;
    });
  }, []);

  const removeCard = useCallback((cardId: string) => {
    setRun((current) => {
      const target = current.cards.find((card) => card.id === cardId);
      if (!target || imageAttemptNeedsResolution(target) || isActiveVideoStatus(target.videoStatus) || current.cards.length === 1) return current;
      const next = {
        ...current,
        updatedAt: Date.now(),
        cards: current.cards.filter((card) => card.id !== cardId).map((card, index) => ({ ...card, order: index + 1 })),
      };
      runRef.current = next;
      return next;
    });
  }, []);

  const clearIdleCards = useCallback(() => {
    setRun((current) => {
      const keep = current.cards.filter((card) => card.imagePrompt.trim() || card.videoPrompt.trim() || card.imageUrl || card.videoUrl || imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus));
      const cards = (keep.length ? keep : [createCard(1)]).map((card, index) => ({ ...card, order: index + 1 }));
      const next = { ...current, updatedAt: Date.now(), cards };
      runRef.current = next;
      return next;
    });
    setNotice("已清理没有 Prompt、结果和运行任务的空卡片");
  }, []);

  const copyText = useCallback(async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label}已复制`);
  }, []);

  const pastePrompt = useCallback(async (cardId: string, field: "imagePrompt" | "videoPrompt", label: string) => {
    if (!navigator.clipboard?.readText) {
      setNotice("当前浏览器不支持直接读取剪贴板，请在输入框中使用 Ctrl+V");
      return;
    }
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setNotice("剪贴板中没有可粘贴的文字");
        return;
      }
      patchCard(cardId, { [field]: value } as Pick<WorkbenchCard, typeof field>);
      setNotice(`${label}已从剪贴板粘贴`);
    } catch {
      setNotice("浏览器未允许读取剪贴板，请在输入框中使用 Ctrl+V");
    }
  }, [patchCard]);

  const applyImportedSegments = useCallback((input: {
    segments: StoryboardAgentOutputSegment[];
    title: string;
    ratio?: WorkbenchRatio | null;
    successNotice: string;
  }): string | null => {
    if (runRef.current.cards.some((card) => imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus))) {
      setNotice("当前有任务正在生成、自动保存或待核验，请等待系统处理完成");
      return null;
    }
    if (!input.segments.length || input.segments.length > MAX_CARDS) {
      setNotice(`一次只能导入 1 至 ${MAX_CARDS} 段分镜`);
      return null;
    }

    archiveRunSnapshot("批量建卡前");
    const current = runRef.current;
    const now = Date.now();
    const next: WorkbenchRun = {
      ...current,
      id: createId("storyboard-run"),
      createdAt: now,
      updatedAt: now,
      ratio: input.ratio && isWorkbenchRatio(input.ratio) ? input.ratio : current.ratio,
      title: input.title,
      cards: input.segments.map((segment, index) => ({
        ...createCard(index + 1),
        label: `镜头 ${index + 1}`,
        sourceNumber: segment.sourceNumber,
        narration: segment.narration,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
      })),
    };
    runRef.current = next;
    setRun(next);
    setExpandedVideoCards(new Set());
    setNotice(input.successNotice);
    return next.id;
  }, [archiveRunSnapshot]);

  const confirmGeneralScriptHandoff = useCallback(() => {
    if (generalScriptHandoff.status !== "ready") return;
    const { handoff } = generalScriptHandoff;
    const plan = handoff.bridge.workbenchImport;
    const importedRunId = applyImportedSegments({
      segments: plan.segments,
      title: plan.title,
      ratio: plan.workbenchRatio,
      successNotice: `已导入 ${plan.segments.length} 个生产段：生图 Prompt 和视频 Prompt 已建卡；没有调用模型或扣费`,
    });
    if (!importedRunId) return;

    setGeneralScriptImportedRunId(importedRunId);
    setGeneralScriptHandoff({ status: "imported", handoff });
  }, [applyImportedSegments, generalScriptHandoff]);

  const confirmAgentHandoff = useCallback(() => {
    if (agentHandoff.status !== "ready") return;
    const { handoff, plan } = agentHandoff;
    const importedRunId = applyImportedSegments({
      segments: plan.segments.map((segment) => ({
        sourceNumber: segment.sourceIndex,
        narration: segment.narration,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
      })),
      title: `Agent 分镜 · ${plan.segments.length} 个生产段`,
      ratio: plan.settings.aspectRatio,
      successNotice: `已导入 ${plan.segments.length} 个 Agent 分镜段；生图和视频 Prompt 已建卡，未调用模型、未扣费`,
    });
    if (!importedRunId) return;
    setAgentHandoff({ status: "imported", handoff, plan });
  }, [agentHandoff, applyImportedSegments]);

  const uploadReferences = useCallback(async (card: WorkbenchCard, files: FileList | null) => {
    if (!files?.length || !token) return;
    if (!referenceLimit) return setNotice("当前图片模型不支持参考图，请切换模型后再上传");
    const replaceExisting = card.referenceImageUrls.length >= referenceLimit;
    const slots = replaceExisting ? referenceLimit : Math.max(0, referenceLimit - card.referenceImageUrls.length);
    setUploadingCardId(card.id);
    try {
      const urls: string[] = [];
      for (const file of Array.from(files).slice(0, slots)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("category", "image");
        formData.append("source", "storyboard-workbench");
        const response = await fetch("/api/storage/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: formData });
        const data = await response.json().catch(() => ({})) as { file?: { url?: string }; error?: string };
        if (!response.ok || !data.file?.url) throw new Error(data.error || `${file.name}上传失败`);
        urls.push(data.file.url);
      }
      patchCard(card.id, { referenceImageUrls: (replaceExisting ? urls : [...card.referenceImageUrls, ...urls]).slice(0, referenceLimit) });
      setNotice(`镜头${card.order}已${replaceExisting ? "替换" : "加入"}${urls.length}张参考图`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "参考图上传失败");
    } finally {
      setUploadingCardId("");
    }
  }, [patchCard, referenceLimit, token]);

  const generateImage = useCallback(async (cardId: string) => {
    if (!scopeMountedRef.current) return null;
    const current = runRef.current;
    const card = current.cards.find((item) => item.id === cardId);
    if (imageSubmissionsRef.current.has(cardId)) {
      setNotice(`镜头${card?.order || ""}的生图请求已经提交，请勿重复点击`);
      return null;
    }
    if (!token) { setNotice("请先登录后再生成"); return null; }
    if (!card) { setNotice("分镜卡片不存在，请刷新后重试"); return null; }
    if (card.imageRetryBlocked) {
      setNotice(isCompletedInlineImageReceipt(card)
        ? `镜头${card.order}的图片已完成，临时图片不可恢复，已禁止重复提交`
        : `镜头${card.order}的原生图结果仍待确认，已禁止重复提交`);
      return null;
    }
    if (isActiveVideoStatus(card.videoStatus)) {
      setNotice(`镜头${card.order}的视频仍在生成，请先终止视频任务再重新生图`);
      return null;
    }
    imageSubmissionsRef.current.add(cardId);
    let clientIdempotencyKey = "";
    let clientTraceId = "";
    let requestSnapshot: StoryboardImageRequestSnapshot | null = null;
    let completedInlineReceipt: Partial<WorkbenchCard> | null = null;
    try {
      const recovering = card.imageRecoveryReady === true;
      let modelName = "";
      let imageClientRequestFingerprint = "";
      if (recovering) {
        if (!card.imageClientRequestId) {
          patchCard(cardId, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图请求号缺失，已保留任务并禁止重放。",
          });
          setNotice(`镜头${card.order}缺少原请求号，无法安全续接`);
          return null;
        }
        clientIdempotencyKey = card.imageClientRequestId;
        clientTraceId = deriveStoryboardImageTraceId(card);
        const confirmed = await inspectStoryboardImageAttempt(card).catch(() => null);
        if (confirmed?.state === "completed" && confirmed.deliveryMode === "inline_ephemeral") {
          const latest = runRef.current.cards.find(item => item.id === cardId);
          const keepMedia = Boolean(latest && latest.imageRecordId === confirmed.recordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
          patchCard(cardId, { ...storyboardInlineReceiptFields(confirmed), imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRef: undefined, imageRecordId: confirmed.recordId, imageDeliveryMode: "inline_ephemeral", imageRecoveryReady: false, imageRetryBlocked: !keepMedia, imageError: keepMedia ? undefined : "临时图片仅原页面可用，费用收据已保留；本次未重新生成" });
          return null;
        }
        if (confirmed?.state === "completed" && confirmed.deliveryMode === "provider_url" && confirmed.recordId) {
          const ref = GeneratedImageReferenceSchema.parse({ schema: "generated_image_ref.v1", recordId: confirmed.recordId });
          const preview = generatedImagePreviewUrl(ref);
          const decoded = await browserImageReady(preview);
          patchCard(cardId, { ...storyboardGeneratedReceiptFields(confirmed), imageStatus: "done", imageRef: ref, imageRecordId: ref.recordId, imageDeliveryMode: "provider_url", imageUrl: preview, imageWidth: decoded.width, imageHeight: decoded.height, imageValidatedAt: Date.now(), imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined });
          return { cardId, imageUrl: preview };
        }
        if (confirmed?.state === "completed" && confirmed.assetId) {
          try {
            const restored = await readOwnedStoryboardImage(
              { assetId: confirmed.assetId },
              card.imageRequestSnapshot?.aspectRatio || current.ratio,
            );
            patchCard(cardId, {
              imageStatus: "done",
              imageUrl: restored.url,
              imageAssetId: restored.assetId,
              imageStorageKey: restored.storageKey,
              imageWidth: restored.width,
              imageHeight: restored.height,
              imageValidatedAt: Date.now(),
              imageRecoveryReady: false,
              imageRetryBlocked: false,
              imageError: undefined,
            });
            setNotice(`镜头${card.order}图片已自动显示，没有再次调用生成模型`);
            return { cardId, imageUrl: restored.url };
          } catch (error) {
            patchCard(cardId, {
              imageStatus: "running",
              imageValidatedAt: undefined,
              imageRecoveryReady: true,
              imageRetryBlocked: false,
              imageError: `${error instanceof Error ? error.message : "已完成图片暂时无法读取"}；系统正在重新获取展示地址。`,
            });
            setNotice(`镜头${card.order}图片已生成，系统正在重新获取展示地址，不会再次调用模型`);
            return null;
          }
        }
        if (confirmed?.canRecover !== true) {
          patchCard(cardId, {
            imageStatus: confirmed?.state === "processing" ? "running" : "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: confirmed?.message || "原结果状态暂未确认，系统已保留任务并禁止重复生成。",
          });
          setNotice(`镜头${card.order}的原结果尚未确认，未提交任何生成`);
          return null;
        }
        if (!isStoryboardImageRequestSnapshot(card.imageRequestSnapshot) || !card.imageClientRequestFingerprint) {
          patchCard(cardId, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图请求参数不完整，已保留任务并禁止重放。",
          });
          setNotice(`镜头${card.order}缺少原请求参数，无法安全续接`);
          return null;
        }
        requestSnapshot = card.imageRequestSnapshot;
        imageClientRequestFingerprint = await buildClientRequestFingerprint(storyboardImageFingerprintPayload(requestSnapshot));
        if (imageClientRequestFingerprint !== card.imageClientRequestFingerprint) {
          patchCard(cardId, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图请求快照校验失败，已禁止重放。",
          });
          setNotice(`镜头${card.order}的原请求快照校验失败，未提交任何生成`);
          return null;
        }
        modelName = card.imageModelNameUsed || "原生图模型";
      } else {
        if (!card.imagePrompt.trim()) { setNotice("请先粘贴分镜生图 Prompt"); return null; }
        if (card.imageTextLayoutEnabled && !String(card.imageExactText || "").trim()) {
          setNotice(`镜头${card.order}已开启高级文字排版，请先填写需要精确呈现的文字`);
          return null;
        }
        const model = imageModels.find((item) => item.id === current.imageModelId);
        if (!model) { setNotice("图片模型尚未加载"); return null; }
        const selectionIssue = storyboardImageModelSelectionIssue(model);
        if (selectionIssue) { setNotice(selectionIssue); return null; }
        const capabilities = getImageModelCapabilities(model);
        if (card.referenceImageUrls.length > capabilities.maxReferenceImages) {
          setNotice(capabilities.supportsReferenceInput
            ? `当前图片模型最多接收${capabilities.maxReferenceImages}张参考图，请移除多余图片或切换模型`
            : "当前图片模型不支持参考图，请移除参考图或切换模型");
          return null;
        }
        modelName = storyboardImageModelName(model);
        requestSnapshot = {
          runId: current.id,
          cardId: card.id,
          cardOrder: card.order,
          prompt: card.imagePrompt,
          exactText: card.imageTextLayoutEnabled ? String(card.imageExactText || "").trim() : undefined,
          modelId: model.id,
          aspectRatio: current.ratio,
          resolution: effectiveImageResolution(model, current.imageResolution),
          referenceImageUrls: [...card.referenceImageUrls],
          strictSingleSubmit: model.id === STRICT_GPT_IMAGE_PUBLIC_ID,
          ...(model.id === STRICT_GPT_IMAGE_PUBLIC_ID
            ? { attemptOrdinal: Math.max(1, Number(card.imageAttemptOrdinal || 0) + 1) }
            : {}),
        };
        imageClientRequestFingerprint = await buildClientRequestFingerprint(storyboardImageFingerprintPayload(requestSnapshot));
        const imageClientAttemptScope = `storyboard-image:${requestSnapshot.runId}:${requestSnapshot.cardId}`;
        const exactDigest = requestSnapshot.strictSingleSubmit
          ? await stableImageRequestDigest({
              ...storyboardImageFingerprintPayload(requestSnapshot),
              cardOrder: requestSnapshot.cardOrder,
            })
          : "";
        const imageClientAttempt = requestSnapshot.strictSingleSubmit ? null : resolveBrowserClientAttempt({
          storageKey: imageClientAttemptScope,
          fingerprint: imageClientRequestFingerprint,
          prefix: "sbw-image",
          previousRequestId: card.imageClientRequestId,
          previousFingerprint: card.imageClientRequestFingerprint,
          previousTerminal: card.imageStatus === "done",
        });
        clientTraceId = requestSnapshot.strictSingleSubmit ? `imgtrace_${exactDigest}` : imageClientAttempt!.clientRequestId;
        clientIdempotencyKey = requestSnapshot.strictSingleSubmit ? `imgkey_${exactDigest}` : imageClientAttempt!.clientRequestId;
        if (card.imageUrl || card.videoUrl) archiveRunSnapshot(`镜头${card.order}重新生图前`);
      }

      const submittedAt = Date.now();
      const imageSubmissionPatch: Partial<WorkbenchCard> = {
        imageStatus: "running",
        imageUrl: undefined,
        imageAssetId: undefined,
        imageStorageKey: undefined,
        imageRef: undefined,
        imageRecordId: undefined,
        imageDeliveryMode: undefined,
        imageWidth: undefined,
        imageHeight: undefined,
        videoSourceImageUrl: undefined,
        imageValidatedAt: undefined,
        imageError: undefined,
        imageSubmittedAt: submittedAt,
        imageModelIdUsed: requestSnapshot.modelId,
        imageModelNameUsed: modelName,
        imageClientRequestId: clientIdempotencyKey,
        imageClientTraceId: clientTraceId,
        imageClientRequestFingerprint,
        imageRequestSnapshot: requestSnapshot,
        imageAttemptOrdinal: requestSnapshot.attemptOrdinal ?? card.imageAttemptOrdinal,
        imageQuotedPrice: storyboardImagePrice(
          imageModels.find((item) => item.id === requestSnapshot!.modelId),
          requestSnapshot.resolution,
        ),
        imagePriceCharged: undefined,
        imageBillingState: "pending",
        imageRecoveryReady: false,
        imageRetryBlocked: false,
        videoStatus: "idle",
        videoUrl: undefined,
        videoError: undefined,
        videoTaskId: undefined,
        videoTaskModelId: undefined,
        videoContentUrl: undefined,
        videoProgress: undefined,
        videoStartedAt: undefined,
        videoLastCheckedAt: undefined,
        videoStatusDetail: recovering ? "正在自动完成原故事板结果，不会重新生成" : "故事板已重新生成，原视频结果已失效",
          videoPollFailures: 0,
          videoMonitoringPaused: undefined,
          videoLifecycle: undefined,
        videoLifecycleError: undefined,
        videoRetryable: undefined,
        videoBillingState: undefined,
        videoPriceCharged: undefined,
      };
      const beforeSave = runRef.current;
      const submissionRun: WorkbenchRun = {
        ...beforeSave,
        lastSubmittedAt: submittedAt,
        updatedAt: submittedAt,
        cards: beforeSave.cards.map((item) => item.id === cardId ? { ...item, ...imageSubmissionPatch } : item),
      };
      runRef.current = submissionRun;
      setRun(submissionRun);
      const projectSaved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(submissionRun), true);
      if (!projectSaved) {
        // The project is the durable carrier for the prompt, model binding and
        // exact request keys. Never dispatch a paid provider call when that
        // carrier was not saved: closing this page would otherwise leave an
        // orphaned attempt that no storyboard can safely reconcile.
        runRef.current = beforeSave;
        setRun(beforeSave);
        if (!recovering && !requestSnapshot.strictSingleSubmit) {
          clearBrowserClientAttempt(
            `storyboard-image:${requestSnapshot.runId}:${requestSnapshot.cardId}`,
            clientIdempotencyKey,
          );
        }
        setNotice(`任务${card.order}保存失败，本次未提交生图，请稍后重试`);
        return null;
      }
      submittedRunIdsRef.current.add(submissionRun.id);
      setNotice(recovering
        ? `任务${card.order}已保存，正在自动完成原故事板结果，不会创建新任务`
        : `任务${card.order}已保存，正在使用 ${modelName} ${card.imageUrl ? "重新生成" : "生成"}故事板`);

      const generationAttempts = requestSnapshot.strictSingleSubmit ? 1 : IMAGE_GENERATION_ATTEMPTS;
      for (let attempt = 1; attempt <= generationAttempts; attempt += 1) {
        if (!scopeMountedRef.current) return null;
        let pendingInlineBlobUrl: string | undefined;
        let pendingInlineRevoke: (() => void) | undefined;
        try {
          const response = await fetch("/api/image/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(320_000),
            body: JSON.stringify({
              prompt: requestSnapshot.prompt,
              mode: "local",
              modelId: requestSnapshot.modelId,
              style: "",
              aspectRatio: requestSnapshot.aspectRatio,
              resolution: requestSnapshot.resolution,
              ...(requestSnapshot.exactText ? { coverText: requestSnapshot.exactText } : {}),
              referenceImageUrls: requestSnapshot.referenceImageUrls,
              referenceUsage: "general",
              clientTraceId,
              clientIdempotencyKey,
              noRetry: requestSnapshot.strictSingleSubmit,
              strictSingleSubmit: requestSnapshot.strictSingleSubmit,
              clientNodeId: `${requestSnapshot.runId}-shot-${requestSnapshot.cardOrder}`,
              clientNodeTitle: `分镜工作台镜头${requestSnapshot.cardOrder}`,
              historySurface: "storyboard-workbench",
            }),
          });
          const data = await response.json().catch(() => ({})) as {
            images?: Array<{ url?: string; recordId?: string; storageKey?: string; assetId?: string; width?: number; height?: number; deliveryMode?: string }>;
            recordId?: string;
            deliveryMode?: "provider_url" | "inline_ephemeral";
            error?: string;
            code?: string;
            state?: string;
            canResubmit?: boolean;
            sameKeyCanResubmit?: boolean;
            upstreamCalled?: boolean;
            billed?: boolean;
            requestAccepted?: boolean;
            cashCharged?: number;
            idempotencyReplayed?: boolean;
          };
          if (!scopeMountedRef.current || runRef.current.id !== current.id || !runRef.current.cards.some(item => item.id === cardId)) return null;
          if (response.ok) completedInlineReceipt = storyboardInlineReceiptFields(data);
          if (completedInlineReceipt) patchCard(cardId, completedInlineReceipt);
          let generatedUrl = data.images?.[0]?.url;
          if (response.ok && data.deliveryMode === "inline_ephemeral" && !generatedUrl) {
            patchCard(cardId, { ...completedInlineReceipt, imageStatus: "done", imageUrl: undefined, imageRecordId: data.recordId, imageDeliveryMode: "inline_ephemeral", imageRef: undefined, imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: true, imageError: "图片已成功生成且费用收据已保留；临时图片仅原页面可用，无法恢复" });
            return null;
          }
          if (data.images?.[0]?.deliveryMode === "inline_ephemeral" && generatedUrl) {
            const delivery = await resolveGeneratedImageClientDelivery(data);
            generatedUrl = delivery.url;
            pendingInlineRevoke = delivery.revoke;
            pendingInlineBlobUrl = generatedUrl;
          }
          if (!response.ok || !generatedUrl) {
            const requestError = new Error(data.error || "图片模型没有返回故事板") as Error & {
              confirmedRejected?: boolean;
              upstreamCalled?: boolean;
              billed?: boolean;
              code?: string;
              requestAccepted?: boolean;
            };
            requestError.confirmedRejected = data.state === "rejected"
              && data.canResubmit === true
              && data.sameKeyCanResubmit === false;
            requestError.upstreamCalled = data.upstreamCalled;
            requestError.billed = data.billed;
            requestError.code = data.code;
            requestError.requestAccepted = data.requestAccepted;
            throw requestError;
          }
          const generatedImage = data.images?.[0];
          const isOwnedGeneratedAsset = Boolean(generatedImage?.assetId && generatedImage?.storageKey);
          // A generated result is a provider reference, never an implicit upload.
          const providerReference = providerMediaUrl(generatedUrl)
            || (generatedImage?.deliveryMode === "provider_url" && generatedUrl.startsWith("/api/media-history/content?recordId=") ? generatedUrl : null);
          if (!isOwnedGeneratedAsset && !providerReference && generatedImage?.deliveryMode !== "inline_ephemeral") throw new RetryableImageFileError("上游未提供可交付的图片链接");
          const stored = {
            url: generatedUrl,
            key: generatedImage?.storageKey,
            width: Number(generatedImage?.width || 0),
            height: Number(generatedImage?.height || 0),
          };
          try {
            const decoded = await browserImageReady(stored.url);
            if (!imageDimensionsMatchAspectRatio(decoded.width, decoded.height, requestSnapshot.aspectRatio)) {
              throw new RetryableImageFileError(`实际图片 ${decoded.width}×${decoded.height} 与 ${requestSnapshot.aspectRatio} 不一致`);
            }
            stored.width = decoded.width;
            stored.height = decoded.height;
          } catch (error) {
            if (error instanceof RetryableImageFileError) throw error;
            if (!isOwnedGeneratedAsset) {
              throw new RetryableImageFileError("上游图片暂时无法预览，原请求仍保留");
            }
            // The server-owned asset is authoritative. A transient signed-URL
            // or browser decode failure is a preview problem, not a failed paid
            // generation; the stored asset can be re-signed without a model call.
            const restored = await readOwnedStoryboardImage({
              assetId: generatedImage?.assetId,
              storageKey: generatedImage?.storageKey,
            }, requestSnapshot.aspectRatio).catch(() => null);
            if (restored) {
              stored.url = restored.url;
              stored.key = restored.storageKey;
              stored.width = restored.width;
              stored.height = restored.height;
            } else {
              throw new RetryableImageFileError("图片已入库，但展示地址暂时无法读取");
            }
          }
          if (!scopeMountedRef.current || runRef.current.id !== current.id || !runRef.current.cards.some((item) => item.id === cardId)) return null;
          if (generatedImage?.deliveryMode === "inline_ephemeral" && stored.url.startsWith("blob:")) ephemeralImageUrlsRef.current.add(stored.url);
          patchCard(cardId, {
            imageStatus: "done",
            imageUrl: stored.url,
            imageRecordId: generatedImage?.recordId || data.recordId,
            imageDeliveryMode: generatedImage?.deliveryMode === "inline_ephemeral" ? "inline_ephemeral" : generatedImage?.deliveryMode === "provider_url" ? "provider_url" : undefined,
            imageRef: generatedImage?.deliveryMode === "provider_url" && GeneratedImageReferenceSchema.safeParse({ schema: "generated_image_ref.v1", recordId: generatedImage.recordId || data.recordId }).success ? { schema: "generated_image_ref.v1", recordId: String(generatedImage.recordId || data.recordId) } : undefined,
            imageAssetId: generatedImage?.assetId,
            imageStorageKey: stored.key,
            imageWidth: stored.width,
            imageHeight: stored.height,
            videoSourceImageUrl: undefined,
            imageValidatedAt: Date.now(),
            imageError: undefined,
            imageModelIdUsed: requestSnapshot.modelId,
            imageModelNameUsed: modelName,
            imageRecoveryReady: false,
            imageRetryBlocked: false,
            imagePriceCharged: Number.isFinite(Number(data.cashCharged)) ? Math.max(0, Number(data.cashCharged)) : undefined,
            imageBillingState: data.idempotencyReplayed ? "restored" : "settled",
          });
          pendingInlineBlobUrl = undefined;
          if (!requestSnapshot.strictSingleSubmit) {
            clearBrowserClientAttempt(`storyboard-image:${requestSnapshot.runId}:${requestSnapshot.cardId}`, clientIdempotencyKey);
          }
          setNotice(`任务${card.order}故事板已展示 · ${modelName}`);
          return { cardId, imageUrl: stored.url };
        } catch (error) {
          if (completedInlineReceipt) {
            if (scopeMountedRef.current && runRef.current.id === current.id && runRef.current.cards.some(item => item.id === cardId)) {
              patchCard(cardId, { ...completedInlineReceipt, imageStatus: "done", imageUrl: undefined, imageRef: undefined,
                imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: true,
                imageError: "图片已成功生成且费用收据已保留；当前预览不可用，临时图片无法恢复。不会再次生成或扣费" });
              setNotice(`镜头${card.order}已生成；当前预览不可用，费用收据已保留`);
            }
            return null;
          }
          if (error instanceof RetryableImageFileError && attempt < generationAttempts) {
            setNotice(`镜头${card.order}图片读取失败，正在用原请求继续读取和保存结果`);
            await delay(1_000);
            continue;
          }
          throw error;
        } finally {
          if (pendingInlineBlobUrl) { if (pendingInlineRevoke) pendingInlineRevoke(); else URL.revokeObjectURL(pendingInlineBlobUrl); }
        }
      }
      return null;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message: string }).message)
          : "故事板生成失败";
      const typed = error as Error & {
        confirmedRejected?: boolean;
        upstreamCalled?: boolean;
        billed?: boolean;
        code?: string;
        requestAccepted?: boolean;
      };
      const latestCard = runRef.current.cards.find((item) => item.id === cardId) || card;
      // A pre-claim platform rejection cannot have a status row. Preserve the
      // authoritative POST error instead of replacing it with a not-found retry loop.
      const rejectedBeforeAcceptance = typed.requestAccepted === false
        || typed.code === "IMAGE_REQUEST_SNAPSHOT_INVALID";
      const status = !rejectedBeforeAcceptance && clientIdempotencyKey && clientTraceId
        ? await inspectStoryboardImageAttempt({
            ...latestCard,
            imageClientRequestId: clientIdempotencyKey,
            imageClientTraceId: clientTraceId,
          }).catch(() => null)
        : null;
      const recoveredInlineReceipt = status?.state === "completed" ? storyboardInlineReceiptFields(status) : null;
      if (recoveredInlineReceipt) {
        const latest = runRef.current.cards.find(item => item.id === cardId);
        const keepMedia = Boolean(latest && latest.imageRecordId === recoveredInlineReceipt.imageRecordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
        patchCard(cardId, { ...recoveredInlineReceipt, imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageRef: undefined,
          imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRecoveryReady: false, imageRetryBlocked: !keepMedia,
          imageError: keepMedia ? undefined : "图片已成功生成且费用收据已保留；临时图片仅原页面可用，当前无法恢复。不会重新生成或扣费" });
        setNotice(`镜头${card.order}已生成，费用收据已保留；本次未重新提交`);
        return null;
      }
      const confirmedRejected = typed.confirmedRejected === true
        || (status?.state === "rejected" && status.canResubmit === true && status.sameKeyCanResubmit === false)
        || (typed.upstreamCalled === false && typed.billed === false);
      if (status?.canRecover === true && requestSnapshot) {
        patchCard(cardId, {
          imageStatus: "running",
          imageValidatedAt: undefined,
          imageRecoveryReady: true,
          imageRetryBlocked: false,
          imageError: status.message || `${message}；系统正在自动完成保存和展示。`,
        });
        setNotice(`镜头${card.order}图片已生成，系统正在自动完成保存和展示，不会再次调用模型`);
      } else if (confirmedRejected) {
        if (requestSnapshot && clientIdempotencyKey) {
          clearBrowserClientAttempt(`storyboard-image:${requestSnapshot.runId}:${requestSnapshot.cardId}`, clientIdempotencyKey);
        }
        patchCard(cardId, {
          imageStatus: "failed",
          imageValidatedAt: undefined,
          imageClientRequestId: undefined,
          imageClientTraceId: undefined,
          imageClientRequestFingerprint: undefined,
          imageRequestSnapshot: undefined,
          imageRecoveryReady: false,
          imageRetryBlocked: false,
          imageBillingState: typed.billed === false ? "not_charged" : undefined,
          imageError: status?.message || message,
        });
        setNotice(`镜头${card.order}生图失败：${status?.message || message}`);
      } else {
        patchCard(cardId, {
          imageStatus: status?.state === "processing" ? "running" : "failed",
          imageValidatedAt: undefined,
          imageRecoveryReady: false,
          imageRetryBlocked: true,
          imageError: `${status?.message || message}；原请求已保留，确认前禁止重放。`,
        });
        setNotice(`镜头${card.order}结果待确认，已保留原请求并禁止重复提交`);
      }
      return null;
    } finally {
      imageSubmissionsRef.current.delete(cardId);
    }
  }, [archiveRunSnapshot, imageModels, inspectStoryboardImageAttempt, patchCard, readOwnedStoryboardImage, saveStoryboardProject, token]);

  // Provider output recovery is infrastructure work, not a user command.
  // Reuse the same immutable request key with bounded exponential backoff; the
  // exactly-once store guarantees these attempts never submit the model twice.
  useEffect(() => {
    const pendingIds = new Set(run.cards.filter((card) => (
      card.imageRecoveryReady === true
      && isStoryboardImageRequestSnapshot(card.imageRequestSnapshot)
    )).map((card) => card.id));
    for (const [cardId, timer] of imageAutoResumeTimersRef.current.entries()) {
      if (pendingIds.has(cardId)) continue;
      window.clearTimeout(timer);
      imageAutoResumeTimersRef.current.delete(cardId);
      imageAutoResumeAttemptsRef.current.delete(cardId);
    }
    for (const card of run.cards) {
      if (!pendingIds.has(card.id) || imageSubmissionsRef.current.has(card.id)
        || imageAutoResumeTimersRef.current.has(card.id)) continue;
      const attempt = imageAutoResumeAttemptsRef.current.get(card.id) || 0;
      // Fast-path retries are bounded. The slower authoritative status poll
      // above remains active afterwards, so a long storage outage cannot spin
      // the browser while the result still completes automatically later.
      if (attempt >= 8) continue;
      const waitMs = Math.min(60_000, 2_000 * (2 ** Math.min(attempt, 5)));
      const timer = window.setTimeout(() => {
        imageAutoResumeTimersRef.current.delete(card.id);
        imageAutoResumeAttemptsRef.current.set(card.id, attempt + 1);
        void generateImage(card.id);
      }, waitMs);
      imageAutoResumeTimersRef.current.set(card.id, timer);
    }
  }, [generateImage, run.cards]);

  useEffect(() => () => {
    for (const timer of imageAutoResumeTimersRef.current.values()) window.clearTimeout(timer);
    imageAutoResumeTimersRef.current.clear();
  }, []);

  const pollVideo = useCallback(async (cardId: string, taskId: string, modelId: string, contentUrl: string, signal: AbortSignal) => {
    type StatusPayload = {
      status?: string;
      videoUrl?: string;
      video_url?: string;
      storageUrl?: string;
      progress?: number;
      elapsed?: number;
      message?: string;
      error?: string;
      errorMessage?: string;
      processingStage?: string;
      retryable?: boolean;
      billingState?: string;
      priceCharged?: number;
      startedAt?: string;
      lastSyncedAt?: string;
      lastSyncAgeSeconds?: number | null;
      providerPollFailures?: number;
      mediaAvailable?: boolean;
      mediaUnavailableReason?: string;
    };

    const applyStatus = (data: StatusPayload, source: "stream" | "poll") => {
      const now = Date.now();
      const status = normalizeRemoteVideoStatus(data.status);
      const videoUrl = data.videoUrl || data.video_url || data.storageUrl || "";
      if (status === "done" && data.mediaAvailable === false) {
        const message = data.mediaUnavailableReason === "source_expired"
          ? "生成已成功，上游视频已确认失效；原任务和账务凭据保留"
          : "生成已成功，当前素材不可播放；原任务和账务凭据保留";
        patchCard(cardId, {
          videoStatus: "done", videoUrl: undefined, videoContentUrl: undefined,
          videoError: message, videoStatusDetail: message, videoProgress: 100,
          videoRetryable: false, videoPollFailures: 0, videoLastCheckedAt: now,
          videoBillingState: data.billingState || "settled",
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : undefined,
        });
        setNotice(message);
        return { terminal: true, videoUrl: "" };
      }
      if (status === "done" && videoUrl) {
        const target = runRef.current.cards.find((card) => card.id === cardId);
        if (target?.videoClientRequestId) {
          clearBrowserClientAttempt(`storyboard-video:${runRef.current.id}:${cardId}`, target.videoClientRequestId);
        }
        patchCard(cardId, {
          videoStatus: "done",
          videoUrl,
          videoError: undefined,
          videoProgress: 100,
          videoLastCheckedAt: now,
          videoStatusDetail: "生成成功，播放地址已同步",
          videoPollFailures: 0,
          videoRetryable: false,
          videoBillingState: data.billingState || "settled",
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : undefined,
        });
        setNotice(`镜头${target?.order || ""}视频生成完成，结果已同步`);
        return { terminal: true, videoUrl };
      }
      if (status === "failed") {
        const message = friendlyVideoError(data.errorMessage || data.error || data.message || "视频模型生成失败");
        const target = runRef.current.cards.find((card) => card.id === cardId);
        const retryable = data.retryable === true;
        if (retryable && target?.videoClientRequestId) {
          clearBrowserClientAttempt(`storyboard-video:${runRef.current.id}:${cardId}`, target.videoClientRequestId);
        }
        patchCard(cardId, {
          videoStatus: "failed",
          videoError: message,
          videoLastCheckedAt: now,
          videoStatusDetail: message,
          videoPollFailures: 0,
          videoRetryable: retryable,
          videoBillingState: data.billingState,
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : 0,
          ...(retryable ? { videoClientRequestId: undefined, videoClientRequestFingerprint: undefined } : {}),
        });
        setNotice(`镜头${target?.order || ""}视频失败：${message}`);
        return { terminal: true, videoUrl: "" };
      }
      if (status === "cancelled") {
        const target = runRef.current.cards.find((card) => card.id === cardId);
        if (target?.videoClientRequestId) {
          clearBrowserClientAttempt(`storyboard-video:${runRef.current.id}:${cardId}`, target.videoClientRequestId);
        }
        patchCard(cardId, {
          videoStatus: "cancelled",
          videoError: undefined,
          videoLastCheckedAt: now,
          videoStatusDetail: data.errorMessage || data.message || "任务已终止",
          videoPollFailures: 0,
          videoRetryable: true,
          videoBillingState: data.billingState || "not_required",
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : 0,
        });
        setNotice(`镜头${target?.order || ""}视频任务已终止`);
        return { terminal: true, videoUrl: "" };
      }

      const nextStatus = status === "queued" ? "queued" : "running";
      const currentCard = runRef.current.cards.find((card) => card.id === cardId);
      const providerStartedAt = Date.parse(String(data.startedAt || ""));
      const providerLastSyncedAt = Date.parse(String(data.lastSyncedAt || ""));
      const detail = data.message
        || data.errorMessage
        || (data.processingStage === "trimming"
          ? "视频已生成，正在裁剪并同步播放地址"
          : nextStatus === "queued"
            ? "生成服务已接收任务，正在分配资源"
            : source === "stream"
              ? "生成服务正在渲染，实时连接正常"
              : "实时连接暂不可用，正在查询任务状态");
      patchCard(cardId, {
        videoStatus: nextStatus,
        // Most upstreams expose milestones (commonly 0 -> 50 -> complete), not
        // measured render percentages. Keep the raw value out of the UI and
        // present the honest delivery stage instead.
        videoProgress: undefined,
        videoStartedAt: currentCard?.videoStartedAt || (Number.isFinite(providerStartedAt) ? providerStartedAt : undefined),
        videoLastCheckedAt: Number.isFinite(providerLastSyncedAt)
          ? providerLastSyncedAt
          : now,
        videoStatusDetail: detail,
        videoPollFailures: Math.max(0, Number(data.providerPollFailures) || 0),
      });
      return { terminal: false, videoUrl: "" };
    };

    const streamParams = new URLSearchParams({
      taskId,
      modelId,
      contentUrl,
      targetDuration: String(runRef.current.videoDuration),
    });
    try {
      patchCard(cardId, { videoStatusDetail: "正在建立实时状态连接" });
      const response = await fetch(`/api/video/stream?${streamParams.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as StatusPayload;
        throw new Error(friendlyVideoError(data.error || data.errorMessage || `实时状态连接失败（${response.status}）`, response.status));
      }

      const reader = response.body.getReader();
      const decoder = new SseEventStreamDecoder();
      let terminalVideoUrl: string | null = null;
      let terminalReached = false;
      while (!signal.aborted) {
        const { done, value } = await readMediaStreamWithDeadline(reader);
        const events = done ? decoder.finish() : decoder.push(value);
        for (const event of events) {
          const data = JSON.parse(event.data || "{}") as StatusPayload;
          if (event.event === "heartbeat") {
            continue;
          }
          if (event.event === "error") {
            const currentCard = runRef.current.cards.find((card) => card.id === cardId);
            const failures = Number(currentCard?.videoPollFailures || 0) + 1;
            patchCard(cardId, {
              videoPollFailures: failures,
              videoStatusDetail: `任务状态查询暂时异常：${friendlyVideoError(data.message || data.error || "未知错误")}，系统会继续重试`,
            });
            continue;
          }
          if (event.event === "warning") {
            patchCard(cardId, { videoStatusDetail: data.message || "任务耗时较长，仍在等待最终结果" });
            continue;
          }
          const applied = applyStatus(data, "stream");
          if (applied.terminal) {
            terminalReached = true;
            terminalVideoUrl = applied.videoUrl || null;
            break;
          }
        }
        if (terminalReached || done) break;
      }
      if (terminalReached) return terminalVideoUrl;
      if (signal.aborted) throw new DOMException("任务已终止", "AbortError");
      throw new Error("实时状态连接提前结束");
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      patchCard(cardId, {
        videoStatusDetail: `${friendlyVideoError(error instanceof Error ? error.message : "实时连接中断")}，已切换主动查询`,
        videoPollFailures: 1,
      });
    }

    let consecutiveFailures = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (attempt > 0) await abortableDelay(VIDEO_POLL_INTERVAL_MS, signal);
      try {
        const params = new URLSearchParams({ taskId, modelId, contentUrl, targetDuration: String(runRef.current.videoDuration) });
        const response = await fetch(`/api/video/status?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({})) as StatusPayload;
        if (!response.ok) throw new Error(friendlyVideoError(data.error || data.errorMessage || `视频状态查询失败（${response.status}）`, response.status));
        consecutiveFailures = 0;
        const applied = applyStatus(data, "poll");
        if (applied.terminal) return applied.videoUrl || null;
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw error;
        consecutiveFailures += 1;
        const message = friendlyVideoError(error instanceof Error ? error.message : "视频状态查询失败");
        patchCard(cardId, {
          videoLastCheckedAt: Date.now(),
          videoPollFailures: consecutiveFailures,
          videoStatusDetail: `查询异常 ${consecutiveFailures}/5：${message}`,
        });
        if (consecutiveFailures >= 5) throw new Error(`${message}；连续5次未能取得任务状态`);
      }
    }
    throw new Error("已停止自动查询：长时间未取得任务最终状态，可继续查询或终止任务");
  }, [patchCard, token]);

  const startPolling = useCallback(async (cardId: string, taskId: string, modelId: string, contentUrl = "") => {
    if (pollingTasksRef.current.has(taskId)) return null;
    pollingTasksRef.current.add(taskId);
    patchCard(cardId, { videoMonitoringPaused: undefined });
    const controller = new AbortController();
    videoPollControllersRef.current.set(taskId, controller);
    try {
      return await pollVideo(cardId, taskId, modelId, contentUrl, controller.signal);
    } finally {
      pollingTasksRef.current.delete(taskId);
      if (videoPollControllersRef.current.get(taskId) === controller) videoPollControllersRef.current.delete(taskId);
    }
  }, [patchCard, pollVideo]);

  const pauseVideoMonitoring = useCallback((cardId: string) => {
    const card = runRef.current.cards.find((item) => item.id === cardId);
    if (!card || !isActiveVideoStatus(card.videoStatus) || !card.videoTaskId) return;
    if (canRemotelyCancelVideoTask(card)) {
      setNotice("该模型支持真实终止，请使用终止生成以同步上游状态");
      return;
    }
    const controller = videoPollControllersRef.current.get(card.videoTaskId);
    controller?.abort();
    videoPollControllersRef.current.delete(card.videoTaskId);
    pollingTasksRef.current.delete(card.videoTaskId);
    const message = "已停止本页等待；上游任务未取消，平台后台仍会查询原任务。点击继续查询可恢复本页状态更新。";
    patchCard(cardId, {
      videoMonitoringPaused: true,
      videoStatusDetail: message,
      videoLastCheckedAt: Date.now(),
    });
    setNotice(`镜头${card.order}${message}`);
  }, [canRemotelyCancelVideoTask, patchCard]);

  const cancelVideo = useCallback(async (cardId: string) => {
    const card = runRef.current.cards.find((item) => item.id === cardId);
    if (!card || !isActiveVideoStatus(card.videoStatus)) return;
    if (!canRequestVideoTermination(card)) {
      const message = "原任务缺少可核验的请求编号，暂不能安全终止；系统会继续追踪";
      patchCard(cardId, { videoStatusDetail: message });
      setNotice(message);
      return;
    }
    patchCard(cardId, { videoStatusDetail: "正在核对投递状态并终止任务" });

    try {
      const response = await fetch("/api/video/cancel", {
        method: "POST",
        signal: AbortSignal.timeout(MEDIA_CANCEL_DEADLINE_MS),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          taskId: card.videoTaskId,
          clientRequestId: card.videoClientRequestId,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        status?: string;
        message?: string;
        error?: string;
        upstreamDispatchDetected?: boolean;
      };
      const latest = runRef.current.cards.find((item) => item.id === cardId);
      if (!latest
        || latest.videoClientRequestId !== card.videoClientRequestId
        || latest.videoTaskId !== card.videoTaskId
        || !isActiveVideoStatus(latest.videoStatus)) return;
      const terminalStatus = normalizeRemoteVideoStatus(data.status);
      if (data.success !== true && terminalStatus === "done") {
        patchCard(cardId, { videoStatusDetail: "任务已在终止前完成，正在同步结果" });
        return;
      }
      if (response.status === 409 && terminalStatus === "failed") {
        patchCard(cardId, { videoStatus: "failed", videoError: data.message || "任务已经失败", videoStatusDetail: data.message || "任务已经失败" });
        if (card.videoTaskId) videoPollControllersRef.current.get(card.videoTaskId)?.abort();
        return;
      }
      if (!response.ok || data.success !== true || data.status !== "cancelled") {
        const message = data.error || data.message || "服务尚未确认取消，任务仍在追踪中，请勿重新提交";
        patchCard(cardId, { videoStatusDetail: message });
        setNotice(message);
        return;
      }
      patchCard(cardId, {
        videoStatus: "cancelled",
        videoError: undefined,
        videoStatusDetail: data.message || "已终止本次视频任务",
        videoLastCheckedAt: Date.now(),
        videoPollFailures: 0,
        videoRetryable: true,
        videoBillingState: data.upstreamDispatchDetected ? "failed" : "not_required",
        videoPriceCharged: 0,
      });
      if (card.videoClientRequestId) {
        clearBrowserClientAttempt(`storyboard-video:${runRef.current.id}:${cardId}`, card.videoClientRequestId);
      }
      if (card.videoTaskId) videoPollControllersRef.current.get(card.videoTaskId)?.abort();
      videoSubmissionControllersRef.current.get(cardId)?.abort();
      setNotice(`镜头${card.order}的视频任务已终止`);
    } catch (error) {
      const message = `取消结果暂未确认，已保留任务追踪：${friendlyVideoError(error instanceof Error ? error.message : "网络暂不可用")}`;
      patchCard(cardId, { videoStatusDetail: message });
      setNotice(message);
      return;
    }
  }, [canRequestVideoTermination, patchCard, token]);

  const generateVideo = useCallback(async (cardId: string) => {
    const current = runRef.current;
    const card = current.cards.find((item) => item.id === cardId);
    const model = videoModels.find((item) => item.id === current.videoModelId);
    const imageUrl = card?.imageUrl;
    if (videoSubmissionsRef.current.has(cardId)) {
      setNotice(`镜头${card?.order || ""}的视频请求已经提交，请勿重复点击`);
      return null;
    }
    if (card && isActiveVideoStatus(card.videoStatus)) { setNotice(`镜头${card.order}的视频仍在生成，请等待结果`); return null; }
    if (card?.videoStatus === "failed" && card.videoRetryable !== true) {
      setNotice(`镜头${card.order}的原任务或费用尚未确认，请先刷新历史状态，当前不会重复提交`);
      return null;
    }
    if (!token) { setNotice("请先登录后再生成"); return null; }
    // 批量、全部生成和单卡重试统一走同一张“已真实加载”门禁。
    // 以前批量传入 imageOverride 会绕过这里，失败卡片可能拿着失效地址继续提交。
    if (!card || !hasValidatedImage(card)) { setNotice("故事板图片尚未真实加载，视频仍处于锁定状态"); return null; }
    if (!model) { setNotice("原视频模型当前不可选，请手动选择视频模型"); return null; }
    const imageRatioIssue = storyboardImageRatioIssue(card, current.ratio);
    if (imageRatioIssue) { setNotice(imageRatioIssue); return null; }
    if (model.supportsPrompt && !card.videoPrompt.trim()) { setNotice("请先粘贴图生视频 Prompt"); return null; }
    const selectionIssue = storyboardVideoModelSelectionIssue(model, { ratio: current.ratio, duration: current.videoDuration, resolution: current.videoResolution });
    if (selectionIssue) { setNotice(selectionIssue); return null; }
    if (model.requiresSourceVideo) { setNotice("该模型必须上传源视频，不能用于仅提供故事板图片的分镜工作台；请切换图生视频模型"); return null; }
    if (!imageUrl) { setNotice("故事板图片地址缺失，请重新生成图片"); return null; }
    if (card.imageDeliveryMode === "inline_ephemeral") { setNotice("临时图片仅当前页面可预览下载，当前视频通道不支持这类输入；本次未提交或扣费"); return null; }
    const duration = effectiveVideoDuration(model, current.videoDuration);
    const narration = String(card.narration || inferStoryboardNarration(card.label)).trim();
    const narrationChars = narrationCharacterCount(narration);
    if (narrationChars > duration * 6) {
      setNotice(`镜头${card.order}口播${narrationChars}个有效字/${duration}秒，超过每秒6字要求；请重新分段后再生成视频`);
      return null;
    }
    const executionPrompt = model.supportsPrompt ? submittedVideoPrompt(card.videoPrompt, model, duration) : "";
    const resolution = effectiveVideoResolution(model, current.videoResolution);
    const contract = current.videoContract;
    if (contract && model.id === contract.modelId && (
      current.ratio !== contract.ratio
      || resolution !== contract.resolution
      || duration !== contract.duration
    )) {
      setNotice(`当前预设需要 ${contract.ratio} / ${contract.duration}秒 / ${contract.resolution}，请检查视频设置`);
      return null;
    }
    if (executionPrompt.length > 4_000) {
      setNotice(`视频 Prompt 加模型护栏后为${executionPrompt.length}字，超过4000字上限，请精简创作 Prompt`);
      return null;
    }
    const inputViolation = validateVideoInputContract(getAiVideoPageInputCapabilities(model), { prompt: executionPrompt, imageUrl });
    if (inputViolation) { setNotice(inputViolation.message); return null; }
    const modelName = compactVideoModelName(model);
    if (card.videoUrl) archiveRunSnapshot(`镜头${card.order}重新生成视频前`);
    const submittedAt = Date.now();
    videoSubmissionsRef.current.add(cardId);
    setExpandedVideoCards((currentSet) => new Set(currentSet).add(cardId));
    window.setTimeout(() => videoSectionsRef.current[cardId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
    patchCard(cardId, {
      videoStatus: "queued",
      videoUrl: undefined,
      videoError: undefined,
      videoProgress: undefined,
      videoStartedAt: submittedAt,
      videoLastCheckedAt: undefined,
      videoStatusDetail: `正在使用 ${modelName} 提交到视频通道`,
      videoPollFailures: 0,
      videoMonitoringPaused: undefined,
      videoTaskId: undefined,
      videoTaskModelId: model.id,
      videoTaskModelName: modelName,
      videoTaskDuration: duration,
      videoSupportsRemoteCancel: model.supportsRemoteCancel === true,
      videoContentUrl: undefined,
      videoLifecycle: undefined,
      videoLifecycleError: undefined,
      videoRetryable: undefined,
      videoBillingState: "pending",
      videoPriceCharged: undefined,
    }, { lastSubmittedAt: submittedAt });
    setNotice(`镜头${card.order}已使用 ${modelName} ${card.videoUrl ? "重新提交" : "提交"}视频任务`);
    let providerSubmissionDispatched = false;
    let confirmedUnsubmitted = false;
    try {
      let submissionImageUrl = imageUrl;
      const submissionImageStorageKey = card.imageStorageKey;
      let submissionImageRef = card.imageRef;
      if (isMultiPanelStoryboardPrompt(card.imagePrompt)) {
        if (!submissionImageRef || !/(?:2\s*[×xX*]\s*2|(?:四|4)格)/u.test(card.imagePrompt) || !card.imageWidth || !card.imageHeight) throw new Error("该多格排布尚无可验证的首格裁切范围；本次未提交或扣费");
        submissionImageRef = { ...submissionImageRef, transform: { kind: "crop", x: 0, y: 0, width: Math.floor(card.imageWidth / 2), height: Math.floor(card.imageHeight / 2) } };
      }
      if (!submissionImageRef && !isPublicHttpMediaUrl(submissionImageUrl)) {
        throw new Error("上游参考图链接无法被视频模型访问；请主动上传可访问的参考图后继续");
      }
      const submissionController = new AbortController();
      videoSubmissionControllersRef.current.set(cardId, submissionController);
      const videoClientRequestFingerprint = await buildClientRequestFingerprint({
        runId: current.id,
        cardId: card.id,
        cardOrder: card.order,
        modelId: model.id,
        prompt: executionPrompt,
        duration,
        aspectRatio: current.ratio,
        resolution,
        sourceImage: submissionImageRef ? generatedImageReferenceUri(submissionImageRef) : submissionImageStorageKey || submissionImageUrl.split("?", 1)[0],
      });
      const videoClientAttemptScope = `storyboard-video:${current.id}:${card.id}`;
      const videoClientAttempt = resolveBrowserClientAttempt({
        storageKey: videoClientAttemptScope,
        fingerprint: videoClientRequestFingerprint,
        prefix: "sbw-video",
        previousRequestId: card.videoClientRequestId,
        previousFingerprint: card.videoClientRequestFingerprint,
        previousTerminal: card.videoStatus === "done" || card.videoStatus === "cancelled"
          || card.videoStatus === "failed" && card.videoRetryable === true,
      });
      const stableVideoClientRequestId = videoClientAttempt.clientRequestId;
      const videoSubmissionPatch: Partial<WorkbenchCard> = {
        videoClientRequestId: stableVideoClientRequestId,
        videoClientRequestFingerprint,
      };
      const beforeSave = runRef.current;
      const submissionRun: WorkbenchRun = {
        ...beforeSave,
        lastSubmittedAt: submittedAt,
        updatedAt: Date.now(),
        cards: beforeSave.cards.map((item) => item.id === cardId ? { ...item, ...videoSubmissionPatch } : item),
      };
      runRef.current = submissionRun;
      setRun(submissionRun);
      const projectSaved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(submissionRun), true);
      if (!projectSaved) {
        // Video submission has its own stable client request id. Keep the
        // deterministic task ledger live even when the optional project index
        // is temporarily unavailable, then let autosave repair the draft.
        setNotice(`任务${card.order}暂未保存，视频仍会按原请求号安全提交`);
      }
      submittedRunIdsRef.current.add(submissionRun.id);
      providerSubmissionDispatched = true;
      const response = await fetch("/api/video/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": stableVideoClientRequestId,
        },
        signal: submissionController.signal,
        body: JSON.stringify({
          model_id: model.id,
          prompt: executionPrompt,
          ...(submissionImageRef ? { image_ref: submissionImageRef } : { image_url: submissionImageUrl, image_storage_key: submissionImageStorageKey }),
          duration,
          aspect_ratio: current.ratio,
          resolution_tier: resolution,
          task_label: `分镜工作台镜头${card.order}`,
          batch_id: current.id,
          batch_topic: "storyboard-workbench",
          card_index: card.order,
          surface: "storyboard-workbench",
          client_request_id: stableVideoClientRequestId,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        task_id?: string;
        business_task_id?: string;
        model_id?: string;
        content_url?: string;
        status?: string;
        video_url?: string;
        error?: string;
        message?: string;
        task_submitted?: boolean | null;
        retryable?: boolean;
        billing_state?: string;
        price?: number;
      };
      videoSubmissionControllersRef.current.delete(cardId);
      if (data.status === "failed" && (data.business_task_id || data.task_id)) {
        const message = friendlyVideoError(data.error || data.message || "所选模型生成失败", response.status);
        const retryable = data.retryable === true;
        if (retryable) clearBrowserClientAttempt(videoClientAttemptScope, stableVideoClientRequestId);
        patchCard(cardId, {
          videoStatus: "failed", videoError: message, videoStatusDetail: message,
          videoTaskId: data.business_task_id || data.task_id, videoTaskModelId: model.id,
          ...(retryable ? { videoClientRequestId: undefined, videoClientRequestFingerprint: undefined } : {}),
          videoRetryable: retryable,
          videoBillingState: data.billing_state,
          videoPriceCharged: Number.isFinite(Number(data.price)) ? Math.max(0, Number(data.price)) : 0,
          videoLastCheckedAt: Date.now(),
        });
        setNotice(`镜头${card.order}视频失败：${message}`);
        return null;
      }
      const trackingTaskId = data.business_task_id || data.task_id || "";
      if (!response.ok && data.task_submitted === true && trackingTaskId) {
        patchCard(cardId, {
          videoStatus: "running",
          videoTaskId: trackingTaskId,
          videoTaskModelId: model.id,
          videoContentUrl: data.content_url || undefined,
          videoLastCheckedAt: Date.now(),
          videoStatusDetail: data.message || "上游已受理，正在继续追踪原任务",
          videoRetryable: false,
          videoBillingState: data.billing_state || "pending",
        });
        setNotice(`镜头${card.order}上游已受理，正在继续追踪原任务，不会重复提交`);
        return await startPolling(cardId, trackingTaskId, model.id, data.content_url || "");
      }
      if (!response.ok) {
        confirmedUnsubmitted = data.task_submitted === false;
        throw new Error(friendlyVideoError(data.error || data.message || `视频任务提交失败（${response.status}）`, response.status));
      }
      if (data.status === "completed" && data.video_url) {
        clearBrowserClientAttempt(videoClientAttemptScope, stableVideoClientRequestId);
        patchCard(cardId, {
          videoStatus: "done",
          videoUrl: data.video_url,
          videoProgress: 100,
          videoLastCheckedAt: Date.now(),
          videoStatusDetail: "已同步完成结果",
          videoTaskId: data.task_id,
          videoTaskModelId: model.id,
          videoContentUrl: data.content_url || undefined,
          videoRetryable: false,
          videoBillingState: data.billing_state || "settled",
          videoPriceCharged: Number.isFinite(Number(data.price)) ? Math.max(0, Number(data.price)) : undefined,
        });
        setNotice(`镜头${card.order}视频生成完成 · ${modelName}`);
        return data.video_url;
      }
      if (data.status === "cancelled") {
        clearBrowserClientAttempt(videoClientAttemptScope, stableVideoClientRequestId);
        patchCard(cardId, {
          videoStatus: "cancelled",
          videoError: undefined,
          videoStatusDetail: data.message || "任务已终止",
          videoTaskId: data.business_task_id || data.task_id,
          videoTaskModelId: model.id,
          videoLastCheckedAt: Date.now(),
          videoPollFailures: 0,
          videoRetryable: true,
          videoBillingState: data.billing_state || "failed",
          videoPriceCharged: 0,
        });
        setNotice(`镜头${card.order}的视频任务已终止`);
        return null;
      }
      if (!trackingTaskId) throw new Error("视频通道没有返回任务编号");
      const submittedModelId = model.id;
      const contentUrl = data.content_url || "";
      const submittedStatus = normalizeRemoteVideoStatus(data.status);
      patchCard(cardId, {
        videoStatus: submittedStatus === "queued" || submittedStatus === "unknown" ? "queued" : "running",
        videoTaskId: trackingTaskId,
        videoTaskModelId: submittedModelId,
        videoContentUrl: contentUrl,
        videoLastCheckedAt: Date.now(),
        videoStatusDetail: data.message || "任务已提交，等待实时状态",
        videoRetryable: false,
        videoBillingState: data.billing_state || "pending",
      });
      return await startPolling(cardId, trackingTaskId, submittedModelId, contentUrl);
    } catch (error) {
      if (isAbortError(error) || runRef.current.cards.find((item) => item.id === cardId)?.videoStatus === "cancelled") return null;
      const message = friendlyVideoError(error instanceof Error ? error.message : "视频生成失败");
      const latest = runRef.current.cards.find(item => item.id === cardId);
      if (providerSubmissionDispatched && !confirmedUnsubmitted && latest?.videoStatus !== "failed" && latest?.videoStatus !== "done") {
        patchCard(cardId, { videoStatus: latest?.videoTaskId ? "running" : "queued", videoError: undefined,
          videoStatusDetail: `结果暂未确认，已保留原任务：${message}`, videoLastCheckedAt: Date.now() });
        setNotice(`镜头${card.order}结果暂未确认，正在保留原任务追踪`);
        return null;
      }
      if (confirmedUnsubmitted) {
        const scope = `storyboard-video:${current.id}:${card.id}`;
        clearBrowserClientAttempt(scope, latest?.videoClientRequestId);
        patchCard(cardId, {
          videoStatus: "failed",
          videoError: message,
          videoStatusDetail: message,
          videoLastCheckedAt: Date.now(),
          videoClientRequestId: undefined,
          videoClientRequestFingerprint: undefined,
          videoRetryable: true,
          videoBillingState: "not_required",
          videoPriceCharged: 0,
        });
      } else {
        patchCard(cardId, { videoStatus: "failed", videoError: message, videoStatusDetail: message, videoLastCheckedAt: Date.now(), videoRetryable: false });
      }
      setNotice(`镜头${card.order}视频失败：${message}`);
      return null;
    } finally {
      videoSubmissionControllersRef.current.delete(cardId);
      videoSubmissionsRef.current.delete(cardId);
    }
  }, [archiveRunSnapshot, patchCard, saveStoryboardProject, startPolling, token, videoModels]);

  const reconcileVideoRequest = useCallback(async (cardId: string, source: "auto" | "manual" = "manual") => {
    const card = runRef.current.cards.find((item) => item.id === cardId);
    const clientRequestId = String(card?.videoClientRequestId || "");
    if (!card || !clientRequestId || card.videoTaskId || videoSubmissionsRef.current.has(cardId)) return null;
    const reconciliationKey = `${cardId}:${clientRequestId}`;
    if (videoRequestReconciliationsRef.current.has(reconciliationKey)) return null;
    videoRequestReconciliationsRef.current.add(reconciliationKey);
    patchCard(cardId, {
      videoStatusDetail: source === "auto" ? "正在自动核对原视频请求是否已建立任务" : "正在查询原视频请求状态",
      videoLastCheckedAt: Date.now(),
    });
    try {
      const params = new URLSearchParams({ clientRequestId });
      const response = await fetch(`/api/video/request-status?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as {
        found?: boolean;
        taskId?: string;
        businessTaskId?: string;
        modelId?: string;
        status?: string;
        canResubmit?: boolean;
        sameRequestKeyRequired?: boolean;
        message?: string;
        error?: string;
        billingState?: string;
        priceCharged?: number;
      };
      if (!response.ok) throw new Error(data.error || data.message || `原视频请求查询失败（${response.status}）`);
      const latest = runRef.current.cards.find((item) => item.id === cardId);
      if (!latest || latest.videoClientRequestId !== clientRequestId || latest.videoTaskId) return null;
      if (data.found) {
        const taskId = String(data.businessTaskId || data.taskId || "");
        const modelId = String(data.modelId || latest.videoTaskModelId || "");
        if (!taskId || !modelId) throw new Error("原视频任务存在，但任务编号或模型编号不完整");
        const remoteStatus = normalizeRemoteVideoStatus(data.status);
        patchCard(cardId, {
          videoStatus: remoteStatus === "running" ? "running" : "queued",
          videoTaskId: taskId,
          videoTaskModelId: modelId,
          videoError: undefined,
          videoRetryable: false,
          videoBillingState: data.billingState || latest.videoBillingState || "pending",
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : latest.videoPriceCharged,
          videoStatusDetail: "已找回原视频任务，正在继续查询结果",
          videoLastCheckedAt: Date.now(),
        });
        setNotice(`镜头${latest.order}已找回原视频任务，不会重复提交`);
        return await startPolling(cardId, taskId, modelId, latest.videoContentUrl || "");
      }
      if (data.canResubmit && data.sameRequestKeyRequired) {
        patchCard(cardId, {
          videoStatus: "failed",
          videoError: "服务器未建立该视频任务，本次未扣费；可点击重试，系统会沿用原请求号防止重复投递",
          videoStatusDetail: data.message || "未发现持久任务，可沿用原请求号人工重试",
          videoLastCheckedAt: Date.now(),
          videoRetryable: true,
          videoBillingState: "not_required",
          videoPriceCharged: 0,
        });
        setNotice(`镜头${latest.order}未建立视频任务、未扣费；可点击重试，仍使用原请求号`);
        return null;
      }
      patchCard(cardId, {
        videoStatus: "queued",
        videoError: undefined,
        videoRetryable: false,
        videoStatusDetail: data.message || "原视频请求仍待确认，请稍后再次刷新状态",
        videoLastCheckedAt: Date.now(),
      });
      setNotice(`镜头${latest.order}的原视频请求仍待确认，不会重复提交`);
      return null;
    } catch (error) {
      const latest = runRef.current.cards.find((item) => item.id === cardId);
      const message = friendlyVideoError(error instanceof Error ? error.message : "原视频请求查询失败");
      patchCard(cardId, {
        videoStatus: "queued",
        videoError: undefined,
        videoRetryable: false,
        videoStatusDetail: `状态查询暂不可用，原请求仍被保护：${message}`,
        videoLastCheckedAt: Date.now(),
      });
      setNotice(`镜头${latest?.order || ""}状态查询暂不可用，未重新提交`);
      return null;
    } finally {
      videoRequestReconciliationsRef.current.delete(reconciliationKey);
    }
  }, [patchCard, startPolling, token]);

  const resumeVideoMonitoring = useCallback(async (cardId: string) => {
    const card = runRef.current.cards.find((item) => item.id === cardId);
    if (!card || !isActiveVideoStatus(card.videoStatus)) return null;
    patchCard(cardId, {
      videoMonitoringPaused: undefined,
      videoStatusDetail: "正在恢复原任务状态查询，不会重新提交",
      videoLastCheckedAt: Date.now(),
    });
    if (card.videoTaskId && card.videoTaskModelId) {
      setNotice(`镜头${card.order}正在继续查询原视频任务`);
      try {
        return await startPolling(cardId, card.videoTaskId, card.videoTaskModelId, card.videoContentUrl || "");
      } catch (error) {
        if (isAbortError(error)) return null;
        const message = friendlyVideoError(error instanceof Error ? error.message : "视频状态读取失败");
        patchCard(cardId, {
          videoStatusDetail: `结果暂未确认，保留原任务：${message}`,
          videoLastCheckedAt: Date.now(),
        });
        setNotice(`镜头${card.order}状态查询暂不可用，未重新提交`);
        return null;
      }
    }
    if (card.videoClientRequestId) return await reconcileVideoRequest(cardId, "manual");
    return null;
  }, [patchCard, reconcileVideoRequest, startPolling]);

  useEffect(() => {
    if (!token) return;
    for (const card of run.cards) {
      if (card.videoMonitoringPaused === true) continue;
      if (isActiveVideoStatus(card.videoStatus) && !card.videoTaskId && !videoSubmissionsRef.current.has(card.id)) {
        if (card.videoClientRequestId) {
          const reconciliationKey = `${card.id}:${card.videoClientRequestId}`;
          if (!videoRequestAutoCheckedRef.current.has(reconciliationKey)) {
            videoRequestAutoCheckedRef.current.add(reconciliationKey);
            void reconcileVideoRequest(card.id, "auto");
          }
          continue;
        }
        const message = "提交结果暂未确认，已保留原请求编号；请从历史记录核对，勿重复生成";
        if (card.videoStatusDetail === message) continue;
        patchCard(card.id, {
          videoStatus: "queued",
          videoError: undefined,
          videoStatusDetail: message,
          videoLastCheckedAt: Date.now(),
        });
        continue;
      }
      if ((card.videoStatus === "queued" || card.videoStatus === "running") && card.videoTaskId) {
        const modelId = card.videoTaskModelId;
        if (!modelId) continue;
        void startPolling(card.id, card.videoTaskId, modelId, card.videoContentUrl || "")
          .catch((error) => {
            if (isAbortError(error) || runRef.current.cards.find((item) => item.id === card.id)?.videoStatus === "cancelled") return;
            const message = friendlyVideoError(error instanceof Error ? error.message : "视频状态读取失败");
            patchCard(card.id, { videoStatusDetail: `结果暂未确认，保留原任务：${message}`, videoLastCheckedAt: Date.now() });
          });
      }
    }
  }, [patchCard, reconcileVideoRequest, run.cards, run.videoModelId, startPolling, token]);

  const runImageBatch = useCallback(async (cardIds: string[]) => {
    const requests: Array<Promise<{ cardId: string; imageUrl: string } | null>> = [];
    for (let index = 0; index < cardIds.length; index += 1) {
      if (!scopeMountedRef.current) break;
      // 单卡生成必须兜底为 settled promise，不能因为一个意外异常让批量流程永远停在 batchMode。
      requests.push(generateImage(cardIds[index]).catch((error) => {
        const message = error instanceof Error ? error.message : "故事板生成失败";
        const card = runRef.current.cards.find((item) => item.id === cardIds[index]);
        if (card && (card.imageStatus === "queued" || card.imageStatus === "running")) {
          patchCard(card.id, { imageStatus: "failed", imageValidatedAt: undefined, imageError: message });
        }
        setNotice(`镜头${card?.order || ""}生图失败：${message}`);
        return null;
      }));
      if (index < cardIds.length - 1) await delay(IMAGE_SUBMIT_INTERVAL_MS);
    }
    return Promise.all(requests);
  }, [generateImage, patchCard]);

  const runVideoBatch = useCallback(async (cardIds: string[]) => {
    const requests: Array<Promise<string | null>> = [];
    for (let index = 0; index < cardIds.length; index += 1) {
      if (!scopeMountedRef.current) break;
      requests.push(generateVideo(cardIds[index]));
      if (index < cardIds.length - 1) await delay(VIDEO_SUBMIT_INTERVAL_MS);
    }
    return Promise.all(requests);
  }, [generateVideo]);

  const batchImages = useCallback(async () => {
    if (batchMode) return;
    const cardsNeedingGeneration = run.cards.filter((card) => !isCompletedInlineImageReceipt(card) && !card.imageRecoveryReady && (card.imageStatus === "idle" || card.imageStatus === "failed"));
    const invalid = cardsNeedingGeneration.filter((card) => !card.imagePrompt.trim());
    if (invalid.length) return setNotice(`还有${invalid.length}张镜头卡没有粘贴生图 Prompt`);
    if (cardsNeedingGeneration.length > 0 && activeImageSelectionIssue) return setNotice(activeImageSelectionIssue);
    const incompatibleReferences = cardsNeedingGeneration.filter((card) => card.referenceImageUrls.length > imageCapabilities.maxReferenceImages);
    if (incompatibleReferences.length) return setNotice(`还有${incompatibleReferences.length}张卡片的参考图超过当前模型上限，请替换或清除后再批量生成`);
    const blockedCount = run.cards.filter((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card)).length;
    if (blockedCount) return setNotice(`还有${blockedCount}张故事板结果待确认，已禁止批量重放`);
    const cardIds = run.cards.filter((card) => card.imageStatus === "idle"
      || (card.imageStatus === "failed" && !card.imageRetryBlocked)).map((card) => card.id);
    const activeCount = run.cards.filter((card) => card.imageStatus === "queued" || card.imageStatus === "running").length;
    if (!cardIds.length && activeCount) return setNotice(`还有${activeCount}张故事板正在生成，请等待当前任务完成`);
    if (!cardIds.length) return setNotice("所有故事板图片已经完成");
    setBatchMode("images");
    setNotice(`批量生图已开始，每5秒提交1个，共${cardIds.length}个`);
    try {
      const results = await runImageBatch(cardIds);
      setNotice(`批量生图结束：成功${results.filter(Boolean).length}个，失败${results.filter((item) => !item).length}个`);
    } catch (error) {
      setNotice(error instanceof Error ? `批量生图异常：${error.message}` : "批量生图异常中断");
    } finally {
      setBatchMode("");
    }
  }, [activeImageSelectionIssue, batchMode, imageCapabilities.maxReferenceImages, run.cards, runImageBatch]);

  const batchVideos = useCallback(async () => {
    if (batchMode) return;
    if (activeVideoSelectionIssue) return setNotice(activeVideoSelectionIssue);
    const missing = run.cards.filter((card) => !hasValidatedImage(card) || (videoPromptRequired && !card.videoPrompt.trim()));
    if (missing.length) return setNotice(`还有${missing.length}张卡片没有当前可用的图片或未粘贴视频 Prompt`);
    const ratioMismatches = run.cards.filter((card) => storyboardImageRatioIssue(card, run.ratio));
    if (ratioMismatches.length) return setNotice(`还有${ratioMismatches.length}张故事板的生成画幅与当前设置不一致，请重新生图后再批量生成视频`);
    const blockedFailures = run.cards.filter((card) => card.videoStatus === "failed" && card.videoRetryable !== true).length;
    if (blockedFailures) return setNotice(`还有${blockedFailures}条失败视频的原任务或费用尚未确认，请先刷新历史状态`);
    const items = run.cards.filter((card) => card.videoStatus === "idle" || card.videoStatus === "failed" && card.videoRetryable === true).map((card) => card.id);
    const activeCount = run.cards.filter((card) => card.videoStatus === "queued" || card.videoStatus === "running").length;
    if (!items.length && activeCount) return setNotice(`还有${activeCount}条视频正在生成，请等待当前任务完成`);
    if (!items.length) return setNotice("所有视频已经完成");
    setBatchMode("videos");
    setNotice(`批量视频已开始，每8秒提交1个，共${items.length}个`);
    try {
      const results = await runVideoBatch(items);
      setNotice(`批量视频结束：成功${results.filter(Boolean).length}个，失败${results.filter((item) => !item).length}个`);
    } catch (error) {
      setNotice(error instanceof Error ? `批量视频异常：${error.message}` : "批量视频异常中断");
    } finally {
      setBatchMode("");
    }
  }, [activeVideoSelectionIssue, batchMode, run.cards, run.ratio, runVideoBatch, videoPromptRequired]);

  const fullFlow = useCallback(async () => {
    if (batchMode) return;
    if (activeImageSelectionIssue) return setNotice(activeImageSelectionIssue);
    if (activeVideoSelectionIssue) return setNotice(activeVideoSelectionIssue);
    if (run.cards.some(isUnavailableCompletedInlineImage)) return setNotice("临时图片已完成但当前媒体不可恢复，全部生成未启动；请使用当前可用的图片素材");
    const invalid = run.cards.filter((card) => !card.imagePrompt.trim() || (videoPromptRequired && !card.videoPrompt.trim()));
    if (invalid.length) return setNotice(`还有${invalid.length}张卡片缺少当前模型所需的 Prompt，全部生成未启动`);
    const blockedCount = run.cards.filter((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card)).length;
    if (blockedCount) return setNotice(`还有${blockedCount}张故事板结果待确认，全部生成未启动，避免重复扣费或重复调用`);
    const blockedVideoFailures = run.cards.filter((card) => card.videoStatus === "failed" && card.videoRetryable !== true).length;
    if (blockedVideoFailures) return setNotice(`还有${blockedVideoFailures}条失败视频的原任务或费用尚未确认，全部生成未启动`);
    setBatchMode("full");
    setNotice("全部生成已开始：先完成所有故事板，再生成视频");
    try {
      const imageTasksRunning = run.cards.some((card) => card.imageStatus === "queued" || card.imageStatus === "running");
      if (imageTasksRunning) return setNotice("仍有故事板任务正在生成，请等待完成后再继续全部生成");
      const missingIds = run.cards.filter((card) => card.imageStatus === "idle"
        || (card.imageStatus === "failed" && !card.imageRetryBlocked)
        || (!card.imageUrl && !card.imageRetryBlocked)).map((card) => card.id);
      if (missingIds.length) await runImageBatch(missingIds);
      const allImages = runRef.current.cards.filter(hasValidatedImage).map((card) => card.id);
      if (allImages.length !== runRef.current.cards.length) return setNotice("部分故事板失败，流程已停在图片阶段，没有提交视频生成");
      const ratioMismatches = runRef.current.cards.filter((card) => storyboardImageRatioIssue(card, runRef.current.ratio));
      if (ratioMismatches.length) return setNotice(`还有${ratioMismatches.length}张故事板的生成画幅与当前设置不一致，全部生成已停在视频提交前`);
      const videoTasksRunning = run.cards.some((card) => card.videoStatus === "queued" || card.videoStatus === "running");
      if (videoTasksRunning) return setNotice("仍有视频任务正在生成，请等待完成后再继续全部生成");
      const retryable = new Set(runRef.current.cards.filter((card) => card.videoStatus === "idle" || card.videoStatus === "failed" && card.videoRetryable === true).map((card) => card.id));
      const results = await runVideoBatch(allImages.filter((cardId) => retryable.has(cardId)));
      setNotice(`全部生成结束：${results.filter(Boolean).length}个新视频成功`);
    } catch (error) {
      setNotice(error instanceof Error ? `全部生成异常：${error.message}` : "全部生成异常中断");
    } finally {
      // 不论上游失败、浏览器异常还是批量队列异常，下一次换模型/重试都必须解锁。
      setBatchMode("");
    }
  }, [activeImageSelectionIssue, activeVideoSelectionIssue, batchMode, run.cards, runImageBatch, runVideoBatch, videoPromptRequired]);

  const imageDone = run.cards.filter(hasValidatedImage).length;
  const videoDone = run.cards.filter((card) => card.videoStatus === "done").length;
  const preferredVideoPresetActive = Boolean(run.videoContract && run.videoModelId === run.videoContract.modelId);
  const selectableImageModelCount = imageModels.filter((model) => !storyboardImageModelSelectionIssue(model)).length;
  const selectableVideoModelCount = videoModels.filter((model) => !storyboardVideoModelSelectionIssue(model, {
    ratio: run.videoContract?.modelId === model.id ? run.videoContract.ratio : run.ratio,
    duration: run.videoContract?.modelId === model.id ? run.videoContract.duration : run.videoDuration,
  })).length;
  const activeImagePrice = storyboardImagePrice(activeImageModel, activeImageResolution);
  const plannedImageSummary = activeImageModel && !activeImageSelectionIssue && Number.isFinite(activeImagePrice)
    ? `图 ${activeImageResolution} ¥${activeImagePrice.toFixed(2)}`
    : activeImageModel ? "图 暂不可提交" : "图 待选择模型";
  const plannedVideoSummary = activeVideoModel && !activeVideoSelectionIssue && Number.isFinite(activeVideoPrice)
    ? `视频 ¥${activeVideoPrice.toFixed(2)}${activeVideoModel.billingUnit === "output_second" ? `/${activeVideoDuration}秒` : ""}`
    : activeVideoModel ? "视频 暂不可提交" : "视频 待选择模型";
  const activeGeneralScriptHandoff = generalScriptHandoff.status === "ready" || generalScriptHandoff.status === "imported"
    ? generalScriptHandoff.handoff
    : null;
  const activeGeneralScriptPreview = activeGeneralScriptHandoff?.bridge.preview;
  const handoffImportBlocked = run.cards.some((card) => (
    imageAttemptNeedsResolution(card)
    || isActiveVideoStatus(card.videoStatus)
  ));

  return (
    <div className="voice-studio-root vs-workbench sbw-root" data-ratio={run.ratio}>
      <SubPageHeader
        title="分镜工作台"
        subtitle="整段导入 · 双 Prompt 原样执行 · 先图后视频"
        icon={<Sparkles className="h-5 w-5" />}
        showThemeSwitcher={false}
        rightSlot={(
          <NavButton icon={History} label="最近任务" variant="ghost" onClick={() => { setHistoryOpen(true); void cloud.refresh(); void loadVideoHistory(); }} />
        )}
      />

      <main className="sbw-shell">
        <aside className="sbw-model-rail" aria-label="生成模型">
          <div className="sbw-rail-summary">
            <span>分镜工作台</span>
            <strong>{run.cards.length} 个镜头</strong>
            <small>图片 {imageDone}/{run.cards.length} · 视频 {videoDone}/{run.cards.length}</small>
          </div>

          <section className="sbw-model-section">
            <header><span>生图模型</span><small>{imageModelCatalogState === "loading" && imageModels.length === 0 ? "读取中" : `${selectableImageModelCount} 可选 / ${imageModels.length} 已配置`}</small></header>
            {imageModelCatalogState === "loading" && imageModels.length === 0 && (
              <p className="sbw-model-catalog-state" role="status"><Loader2 className="animate-spin" />正在读取可用生图模型…</p>
            )}
            {imageModelCatalogState === "error" && imageModels.length === 0 && (
              <div className="sbw-model-catalog-state is-error" role="alert"><span>生图模型暂时无法读取</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {imageModelCatalogState === "ready" && imageModels.length === 0 && (
              <div className="sbw-model-catalog-state"><span>当前暂无已配置生图模型</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {run.imageModelId && !activeImageModel && <p role="status">原生图模型当前不可选，请手动选择。</p>}
            {activeImageModel && activeImageSelectionIssue && (
              <p role="status">{publicModelSelectionLabel(activeImageSelectionIssue)}：{activeImageSelectionIssue}</p>
            )}
            <div className="sbw-model-list sbw-image-model-list">
              {imageModels.map((model) => {
                const capabilities = getImageModelCapabilities(model);
                const displayName = storyboardImageModelName(model);
                const brand = resolveModelBrand(displayName, model.display_name, model.name, model.model_name, model.provider) || "generic";
                const preferredResolution = preferredStoryboardImageResolution(model);
                const selectionIssue = storyboardImageModelSelectionIssue(model);
                const publicSelectionLabel = publicModelSelectionLabel(selectionIssue);
                const preferredPrice = storyboardImagePrice(model, preferredResolution);
                const imagePriceLabel = model.priceReady && Number.isFinite(preferredPrice)
                  ? `${preferredResolution} ¥${preferredPrice.toFixed(2)}/张`
                  : `${preferredResolution} · 价格待配置`;
                return (
                  <button
                    key={model.id}
                    type="button"
                    data-model-brand={brand}
                    data-model-id={model.id}
                    data-model-selectable={selectionIssue ? "false" : "true"}
                    data-reference-limit={capabilities.maxReferenceImages}
                    className={run.imageModelId === model.id ? "is-active" : ""}
                    aria-label={selectionIssue ? `${displayName} 当前未开放` : `选择生图模型：${displayName}`}
                    aria-disabled={Boolean(selectionIssue)}
                    title={selectionIssue ? `${publicSelectionLabel}：${selectionIssue}` : displayName}
                    onClick={() => selectImageModel(model)}
                  >
                    <ModelBadge
                      className="sbw-model-icon"
                      name={displayName}
                      avatarUrl={model.avatarUrl}
                      identity={[model.display_name, model.name, model.model_name, model.provider]}
                      selected={run.imageModelId === model.id}
                      availability={selectionIssue ? "unavailable" : "ready"}
                    />
                    <span className="sbw-model-copy">
                      <strong title={displayName}><span className="sbw-model-name">{displayName}</span><em className="sbw-model-inline-meta">· {imagePriceLabel}</em></strong>
                      <small>{capabilities.defaultResolution} · {capabilities.referenceCapabilityLabel}</small>
                      {showAdminModelIds && (
                        <span
                          className="sbw-model-id-copy"
                          role="button"
                          tabIndex={0}
                          title={`点击复制模型 ID：${model.id}`}
                          aria-label={`复制生图模型 ID：${model.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void copyAdminModelId(model.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            void copyAdminModelId(model.id);
                          }}
                        >
                          <code>ID: {model.id}</code><ClipboardCopy aria-hidden="true" />
                        </span>
                      )}
                      {selectionIssue && <small className="sbw-model-unavailable">{publicSelectionLabel}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="sbw-model-section sbw-video-model-section">
            <header><span>图生视频模型</span><small>{videoModelCatalogState === "loading" && videoModels.length === 0 ? "读取中" : `${selectableVideoModelCount} 可选 / ${videoModels.length} 已配置`}</small></header>
            {videoModelCatalogState === "loading" && videoModels.length === 0 && (
              <p className="sbw-model-catalog-state" role="status"><Loader2 className="animate-spin" />正在读取可用视频模型…</p>
            )}
            {videoModelCatalogState === "error" && videoModels.length === 0 && (
              <div className="sbw-model-catalog-state is-error" role="alert"><span>视频模型暂时无法读取</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {videoModelCatalogState === "ready" && videoModels.length === 0 && (
              <div className="sbw-model-catalog-state"><span>当前暂无已配置图生视频模型</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {run.videoModelId && !activeVideoModel && <p role="status">原视频模型当前不可选，请手动选择。</p>}
            {activeVideoModel && activeVideoSelectionIssue && <p role="status">当前视频模型未开放，请选择列表中的可用模型。</p>}
            <div className="sbw-model-list sbw-video-model-list">
              {videoModels.map((model) => {
                const displayName = compactVideoModelName(model);
                const fullDisplayName = displayName;
                const brand = resolveModelBrand(displayName, model.display_name, model.name, model.id) || "generic";
                const channelCode = modelChannelCode(model);
                const defaultDuration = effectiveVideoDuration(model);
                const preferredResolution = effectiveVideoResolution(model);
                const defaultCharge = effectiveVideoCharge(model, preferredResolution, defaultDuration);
                const outputSecondPrice = model.billingUnit === "output_second" && defaultDuration > 0
                  ? defaultCharge / defaultDuration
                  : 0;
                const priceLabel = model.priceReady && Number.isFinite(defaultCharge) && Number.isFinite(outputSecondPrice)
                  ? `¥${model.billingUnit === "output_second" ? outputSecondPrice.toFixed(2) : defaultCharge.toFixed(2)}/${model.billingUnit === "output_second" ? "秒" : "次"}`
                  : "价格待配置";
                const isPreferredContractModel = run.videoContract?.modelId === model.id;
                const selectionTarget = {
                  ratio: isPreferredContractModel ? run.videoContract!.ratio : run.ratio,
                  duration: isPreferredContractModel ? run.videoContract!.duration : run.videoDuration,
                };
                const selectionIssue = storyboardVideoModelSelectionIssue(model, selectionTarget);
                const publicSelectionLabel = publicModelSelectionLabel(selectionIssue);
                return (
                  <button
                    key={model.id}
                    type="button"
                    data-model-brand={brand}
                    data-model-id={model.id}
                    data-model-selectable={selectionIssue ? "false" : "true"}
                    className={run.videoModelId === model.id ? "is-active" : ""}
                    aria-label={selectionIssue ? `${fullDisplayName} 当前未开放` : `选择视频模型：${fullDisplayName}`}
                    aria-disabled={Boolean(selectionIssue)}
                    title={publicSelectionLabel || `选择 ${fullDisplayName}`}
                    onClick={() => {
                      if (selectionIssue) {
                        setNotice(`${fullDisplayName} ${publicSelectionLabel}，请先选择可用模型`);
                        return;
                      }
                      const preferredContract = isPreferredContractModel ? run.videoContract : undefined;
                      const requestedRatio = preferredContract?.ratio || run.ratio;
                      const requestedDuration = preferredContract?.duration || run.videoDuration;
                      const requestedResolution = preferredContract?.resolution || run.videoResolution;
                      const resolvedSelection = resolveStoryboardVideoSelection(model, {
                        ratio: requestedRatio,
                        duration: requestedDuration,
                        resolution: requestedResolution,
                      });
                      const supportedRatios = supportedWorkbenchRatios(activeImageModel, model);
                      const nextRatio = supportedRatios.includes(resolvedSelection.ratio as WorkbenchRatio)
                        ? resolvedSelection.ratio as WorkbenchRatio
                        : supportedRatios[0] || run.ratio;
                      const failedVideoCards = run.cards.filter((card) => card.videoStatus === "failed").length;
                      patchRun({
                        videoModelId: model.id,
                        videoResolution: resolvedSelection.resolution,
                        videoDuration: resolvedSelection.duration,
                        ratio: nextRatio,
                        cards: resetFailedVideoCardsForModelSwitch(run.cards),
                      });
                      setNotice(failedVideoCards > 0
                        ? `已选择 ${fullDisplayName}，${failedVideoCards} 个旧模型失败任务现在可以重新提交`
                        : `已选择 ${fullDisplayName}`);
                    }}
                  >
                    <ModelBadge
                      className="sbw-model-icon"
                      name={displayName}
                      avatarUrl={model.avatarUrl}
                      identity={[model.display_name, model.name, model.id]}
                      selected={run.videoModelId === model.id}
                      availability={selectionIssue ? "unavailable" : "ready"}
                    />
                    <span className="sbw-model-copy">
                      <strong title={fullDisplayName}><span className="sbw-model-name">{displayName}</span><em className="sbw-model-inline-meta">{channelCode ? ` · ${channelCode}` : ""} · {priceLabel}</em></strong>
                      <small>{model.durationMode === "fixed" ? `${model.durationSeconds}秒` : `${model.minDuration}-${model.maxDuration}秒`} · {preferredResolution || "清晰度自动"}{videoModelNeedsReference(model) ? " · 需参考图" : ""}</small>
                      {showAdminModelIds && (
                        <span
                          className="sbw-model-id-copy"
                          role="button"
                          tabIndex={0}
                          title={`点击复制模型 ID：${model.id}`}
                          aria-label={`复制视频模型 ID：${model.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void copyAdminModelId(model.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            void copyAdminModelId(model.id);
                          }}
                        >
                          <code>ID: {model.id}</code><ClipboardCopy aria-hidden="true" />
                        </span>
                      )}
                      {selectionIssue && <small className="sbw-model-unavailable">{publicSelectionLabel}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <div className="sbw-workspace">
          {agentHandoff.status !== "hidden" && (
            <section
              className="sbw-toolbar"
              data-testid="agent-storyboard-handoff-preview"
              aria-label="创作 Agent 分镜交接预览"
              aria-live="polite"
            >
              <div className="sbw-toolbar-settings">
                {agentHandoff.status === "ready" || agentHandoff.status === "imported" ? (
                  <>
                    <div className="sbw-control-group is-image">
                      <span className="sbw-control-tag">创作 Agent 交接</span>
                      <strong>{agentHandoff.plan.segments.length} 个生产段</strong>
                      <span>{agentHandoff.plan.settings.aspectRatio} · {agentHandoff.plan.settings.animationStyle}</span>
                    </div>
                    <div className="sbw-control-group is-video">
                      <span className="sbw-control-tag">稳定机器包</span>
                      <strong>{agentHandoff.plan.schemaVersion}</strong>
                      <span>文案、生图 Prompt、视频 Prompt、时长与连续性已校验</span>
                    </div>
                  </>
                ) : (
                  <div className="sbw-control-group is-video">
                    <span className="sbw-control-tag">交接不可用</span>
                    <strong>{agentHandoff.error}</strong>
                    <span>现有工作台未被覆盖，也没有调用模型</span>
                  </div>
                )}
              </div>
              <div className="sbw-toolbar-actions">
                {agentHandoff.status === "ready" && (
                  <button
                    type="button"
                    className="is-primary"
                    data-testid="agent-storyboard-handoff-confirm"
                    disabled={handoffImportBlocked}
                    onClick={confirmAgentHandoff}
                    title="只把结构化双 Prompt 建成镜头卡，不调用模型、不扣费"
                  >
                    <ClipboardPaste />确认导入（不生成）
                  </button>
                )}
                {agentHandoff.status === "imported" && (
                  <span data-testid="agent-storyboard-handoff-complete">已导入；本次交接已消费，未调用模型、未扣费</span>
                )}
                <button type="button" onClick={() => setAgentHandoff({ status: "hidden" })}>关闭提示</button>
              </div>
            </section>
          )}

          {generalScriptHandoff.status !== "hidden" && (
            <section
              className="sbw-toolbar"
              data-testid="general-script-handoff-preview"
              aria-label="通用短剧导入预览"
              aria-live="polite"
            >
              <div className="sbw-toolbar-settings">
                {activeGeneralScriptPreview ? (
                  <>
                    <div className="sbw-control-group is-image">
                      <span className="sbw-control-tag">通用短剧交接</span>
                      <strong>{activeGeneralScriptPreview.title}</strong>
                      <span>{activeGeneralScriptPreview.episodeCount} 集 · {activeGeneralScriptPreview.segmentCount} 个生产段 · {activeGeneralScriptPreview.aspectRatio}</span>
                    </div>
                    <div className="sbw-control-group is-video">
                      <span className="sbw-control-tag">仅预览</span>
                      <strong>生图 Prompt + 视频 Prompt</strong>
                      <span>{activeGeneralScriptPreview.animationStyle}</span>
                    </div>
                    <div className="sbw-control-group is-video">
                      <span className="sbw-control-tag">表演约束</span>
                      <strong>{activeGeneralScriptPreview.silentNarration ? "无对白口型（嘴部自然闭合）" : "按剧本表演模式"}</strong>
                      <span>{activeGeneralScriptPreview.silentNarration ? "后期旁白；表情、动作、视线和语义道具推进" : "确认后仍需人工检查镜头表演"}</span>
                    </div>
                    <div className="sbw-control-group is-image">
                      <span className="sbw-control-tag">追溯包</span>
                      <strong>animation_reverse_package.v1</strong>
                      <span>{activeGeneralScriptHandoff?.bridge.handoffMetadata.animationReversePackage.project_id}</span>
                    </div>
                    {!activeGeneralScriptHandoff?.bridge.workbenchImport.workbenchRatio && (
                      <div className="sbw-control-group is-video">
                        <span className="sbw-control-tag">画幅提醒</span>
                        <strong>原始 {activeGeneralScriptPreview.aspectRatio} 已写入双 Prompt 与机器包</strong>
                        <span>当前工作台不自动改动现有比例，请确认模型支持后手动选择</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="sbw-control-group is-video">
                    <span className="sbw-control-tag">交接不可用</span>
                    <strong>{generalScriptHandoff.status === "error" ? generalScriptHandoff.error : "未找到可导入内容"}</strong>
                    <span>{generalScriptHandoff.status === "error" ? `错误代码：${generalScriptHandoff.code}` : ""}</span>
                  </div>
                )}
              </div>
              <div className="sbw-toolbar-actions">
                {generalScriptHandoff.status === "ready" && (
                  <button
                    type="button"
                    className="is-primary"
                    data-testid="general-script-handoff-confirm"
                    disabled={handoffImportBlocked}
                    onClick={confirmGeneralScriptHandoff}
                    title="只把双 Prompt 建成镜头卡，不调用模型、不扣费"
                  >
                    <ClipboardPaste />确认导入（不生成）
                  </button>
                )}
                {generalScriptHandoff.status === "imported" && (
                  <span data-testid="general-script-handoff-complete">已导入；未调用模型、未扣费</span>
                )}
                <button type="button" onClick={() => setGeneralScriptHandoff({ status: "hidden" })}>关闭提示</button>
              </div>
            </section>
          )}

          <section className="sbw-toolbar" aria-label="分镜工作台全局设置">
            <div className="sbw-toolbar-settings">
              <div className="sbw-control-group is-image">
                <span className="sbw-control-tag">图片</span>
                <div className="sbw-ratio-control" aria-label="画面比例">
                  {WORKBENCH_RATIOS.map((value) => {
                    const disabled = preferredVideoPresetActive || !activeRatioOptions.includes(value);
                    const title = preferredVideoPresetActive
                      ? `当前预设比例 ${run.videoContract!.ratio}`
                      : disabled
                        ? "当前图片与视频模型没有共同支持此比例"
                        : `切换为 ${value}`;
                    return <button key={value} type="button" disabled={disabled} title={title} className={run.ratio === value ? "is-active" : ""} onClick={() => patchRun({ ratio: value })}>{value}</button>;
                  })}
                </div>
                {imageCapabilities.resolutionOptions.length > 1 ? (
                  <select className="sbw-resolution-select" aria-label="图片分辨率" value={activeImageResolution} onChange={(event) => patchRun({ imageResolution: event.target.value })}>
                    {imageCapabilities.resolutionOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                ) : <span className="sbw-fixed-param">{activeImageResolution}</span>}
              </div>
              <div className="sbw-control-group is-video">
                <span className="sbw-control-tag">视频</span>
                {activeVideoModel?.resolutionOptions.length ? (
                  activeVideoModel.resolutionOptions.length > 1 ? (
                    <select className="sbw-resolution-select" aria-label="视频分辨率" value={activeVideoResolution} disabled={preferredVideoPresetActive} onChange={(event) => patchRun({ videoResolution: event.target.value })}>
                      {activeVideoModel.resolutionOptions.map((value) => (
                        <option key={value} value={value}>{value} · {videoResolutionPriceLabel(activeVideoModel, value, activeVideoDuration)}</option>
                      ))}
                    </select>
                  ) : <span className="sbw-fixed-param">{activeVideoResolution}</span>
                ) : <span className="sbw-fixed-param">清晰度自动</span>}
                {activeVideoDurationOptions.length > 1 ? (
                  <select className="sbw-resolution-select" aria-label="视频时长" value={activeVideoDuration} disabled={preferredVideoPresetActive} onChange={(event) => patchRun({ videoDuration: Number(event.target.value) })}>
                    {activeVideoDurationOptions.map((value) => <option key={value} value={value}>{value} 秒</option>)}
                  </select>
                ) : <span className="sbw-fixed-param">固定 {activeVideoDuration} 秒</span>}
              </div>
            </div>
            <div className="sbw-toolbar-actions">
              <button type="button" className="sbw-batch-action is-image-batch" onClick={batchImages} disabled={Boolean(activeImageSelectionIssue && !run.cards.some((card) => card.imageRecoveryReady)) || Boolean(batchMode) || run.cards.some((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card))}><ImageIcon />批量生图</button>
              <button type="button" className="sbw-batch-action is-video-batch" onClick={batchVideos} disabled={Boolean(activeVideoSelectionIssue) || Boolean(batchMode) || run.cards.some((card) => !hasValidatedImage(card) || Boolean(storyboardImageRatioIssue(card, run.ratio)))}><Film />批量视频</button>
              <button type="button" className="sbw-batch-action is-full-batch is-primary" onClick={fullFlow} disabled={Boolean(activeImageSelectionIssue || activeVideoSelectionIssue) || Boolean(batchMode) || run.cards.some((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card))}>{batchMode === "full" ? <Loader2 className="animate-spin" /> : <Sparkles />}全部生成</button>
            </div>
          </section>

          <div className="sbw-workspace-meta">
            <div><strong>{run.title}</strong><span>{run.cards.length}/{MAX_CARDS} 张镜头卡</span></div>
            <span className="sbw-guardrail-chip" title={activeVideoGuardrail}><LockKeyhole /><strong>当前模型护栏</strong></span>
          </div>

          <section className="sbw-shot-grid" aria-label="镜头任务卡片">
            {run.cards.map((card) => (
              <article
                key={card.id}
                className="sbw-shot-card"
                data-testid={generalScriptImportedRunId === run.id && card.order === 1 ? "general-script-imported-card" : undefined}
                data-card-state={cardStatus(card).status}
                data-narration-chars={narrationCharacterCount(card.narration || inferStoryboardNarration(card.label))}
              >
                <header className="sbw-card-header">
                  <div className="sbw-card-index"><Film /></div>
                <div className="sbw-card-title"><strong>任务 {card.order}{card.sourceNumber && card.sourceNumber !== card.order ? ` · 原文段 ${card.sourceNumber}` : ""}</strong><span>当前报价：{plannedImageSummary} · {plannedVideoSummary}</span></div>
                  <div className="sbw-status-pair"><span data-status={cardStatus(card).status}>{cardStatus(card).label}</span></div>
                  <button type="button" className="sbw-icon-button" title={imageAttemptNeedsResolution(card) ? "请先完成原生图任务的状态处理" : "删除镜头"} disabled={run.cards.length === 1 || imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus)} onClick={() => removeCard(card.id)}><X /></button>
                </header>

                <div className="sbw-generation-stack">
                  <section className="sbw-flow-section sbw-image-flow">
                    <div className="sbw-flow-prompt">
                      <div className="sbw-prompt-heading"><span>生图提示词</span><button type="button" title="粘贴生图提示词" aria-label={`粘贴镜头${card.order}生图提示词`} onClick={() => void pastePrompt(card.id, "imagePrompt", `镜头${card.order}生图提示词`)}><ClipboardPaste /></button></div>
                      <textarea aria-label={`镜头${card.order}生图提示词`} rows={4} disabled={imageAttemptNeedsResolution(card)} value={card.imagePrompt} onChange={(event) => patchCard(card.id, { imagePrompt: event.target.value })} placeholder="粘贴故事版智能体输出的生图 Prompt" />
                      <label className="sbw-text-layout-toggle">
                        <input
                          type="checkbox"
                          checked={card.imageTextLayoutEnabled === true}
                          disabled={imageAttemptNeedsResolution(card)}
                          onChange={(event) => patchCard(card.id, event.target.checked
                            ? { imageTextLayoutEnabled: true }
                            : { imageTextLayoutEnabled: false, imageExactText: "" })}
                        />
                        <span>高级文字排版</span>
                        <small>{card.imageTextLayoutEnabled ? "已开启；文字将由平台精确排版" : "默认关闭；普通生图只生成视觉画面"}</small>
                      </label>
                      {card.imageTextLayoutEnabled && (
                        <label className="sbw-exact-text-field">
                          <span>需要精确呈现的文字</span>
                          <textarea aria-label={`镜头${card.order}画面精确文字`} rows={2} maxLength={200} disabled={imageAttemptNeedsResolution(card)} value={card.imageExactText || ""} onChange={(event) => patchCard(card.id, { imageExactText: event.target.value })} placeholder="第一行标题，第二行副标题" />
                        </label>
                      )}
                    </div>

                    <section className="sbw-reference-section">
                      <button
                        type="button"
                        className="sbw-reference-toggle"
                        disabled={(!referenceLimit && card.referenceImageUrls.length === 0) || uploadingCardId === card.id || imageAttemptNeedsResolution(card)}
                        title={!referenceLimit && card.referenceImageUrls.length > 0 ? "当前模型不接收参考图，清除已保存的参考图" : referenceLimit ? `当前模型最多接收 ${referenceLimit} 张参考图` : "当前模型不支持参考图"}
                        onClick={() => {
                          if (!referenceLimit && card.referenceImageUrls.length > 0) {
                            patchCard(card.id, { referenceImageUrls: [] });
                            setNotice(`镜头${card.order}的外部参考图已清除`);
                            return;
                          }
                          uploadInputsRef.current[card.id]?.click();
                        }}
                      >
                        {uploadingCardId === card.id ? <Loader2 className="animate-spin" /> : !referenceLimit && card.referenceImageUrls.length > 0 ? <Trash2 /> : <Upload />}
                        <strong>{!referenceLimit && card.referenceImageUrls.length > 0 ? "清除外部参考图" : card.referenceImageUrls.length ? "替换外部参考图" : "外部参考图（可选）"}</strong>
                        <span>{card.referenceImageUrls.length ? `已上传 ${card.referenceImageUrls.length}${referenceLimit ? `/${referenceLimit}` : ""} 张` : referenceLimit ? `最多 ${referenceLimit} 张` : "当前不支持"}</span>
                      </button>
                      <input ref={(element) => { uploadInputsRef.current[card.id] = element; }} type="file" accept="image/*" multiple hidden onChange={(event) => { void uploadReferences(card, event.target.files); event.currentTarget.value = ""; }} />
                    </section>

                    <div className="sbw-zone-title"><ImageIcon /><strong>故事板图片（视频必需）</strong><span>{storyboardImageRatioIssue(card, run.ratio) || (hasValidatedImage(card) ? `已验证 ${card.imageWidth && card.imageHeight ? `${card.imageWidth}×${card.imageHeight}` : ""} 并自动绑定${card.imageModelNameUsed ? ` · ${card.imageModelNameUsed}` : ""}` : "生成后自动绑定")}</span></div>
                    <div
                      className={`sbw-image-frame sbw-ratio-frame ${card.imageUrl ? "has-result" : "is-placeholder"} ${(card.imageRequestSnapshot?.aspectRatio || run.ratio) === "9:16" ? "is-portrait" : ""}`}
                      style={card.imageUrl && card.imageRequestSnapshot?.aspectRatio ? { aspectRatio: card.imageRequestSnapshot.aspectRatio.replace(":", " / ") } : undefined}
                    >
                      {card.imageUrl ? (
                        <button type="button" onClick={() => setPreviewMedia({ url: card.imageUrl || "", type: "image" })} title="查看原图"><img src={card.imageUrl} alt={`任务${card.order}故事板`} /><span><Eye />查看原图</span></button>
                      ) : card.imageStatus === "running" || card.imageStatus === "queued" ? (
                        <div className="sbw-loading-state"><Loader2 className="animate-spin" /><strong>{statusText(card.imageStatus)}</strong><span>故事板图片正在生成</span></div>
                      ) : (
                        <div className="sbw-empty-state"><ImageIcon /><span>{isUnavailableCompletedInlineImage(card) ? "已完成·临时图片不可恢复" : "尚未生成"}</span></div>
                      )}
                    </div>
                    {card.imageError && <p className="sbw-error-line">{card.imageError}</p>}
                    {card.imageBillingState && <p className="sbw-billing-line">图片费用：{card.imageBillingState === "pending"
                      ? `原报价 ¥${Number(card.imageQuotedPrice || 0).toFixed(2)}，成功交付后扣费`
                      : card.imageBillingState === "restored"
                        ? `实际扣费 ¥${Number(card.imagePriceCharged || 0).toFixed(2)}`
                        : card.imageBillingState === "not_charged"
                          ? "未调用模型，未扣费"
                          : `实际扣费 ¥${Number(card.imagePriceCharged || 0).toFixed(2)}`}</p>}
                    <div className="sbw-media-actions">
                      <button type="button" title="复制生图 Prompt" onClick={() => copyText(card.imagePrompt, `镜头${card.order}生图 Prompt`)}><ClipboardCopy /></button>
                      {card.imageUrl && <button type="button" title="下载故事板" onClick={() => void downloadStoryboardImage(card)}><Download /></button>}
                      <button
                        type="button"
                        className="is-command is-image-command"
                        title={isActiveVideoStatus(card.videoStatus)
                          ? "请先终止本镜头的视频任务"
                          : isUnavailableCompletedInlineImage(card)
                            ? "图片已完成，临时图片不可恢复，已禁止重复提交"
                          : card.imageRetryBlocked
                            ? "原结果待确认，已禁止重复提交"
                            : card.imageRecoveryReady
                              ? "图片已生成，系统正在自动保存和展示"
                              : activeImageSelectionIssue
                                ? activeImageSelectionIssue
                              : batchMode && (batchMode === "full" || card.imageStatus !== "done")
                                ? "当前卡片正在批量流程中"
                                : card.imageStatus === "done" ? "使用当前所选生图模型重新生成" : "生成故事板图片"}
                        disabled={card.imageRetryBlocked
                          || card.imageRecoveryReady
                          || (!card.imageRecoveryReady && (Boolean(activeImageSelectionIssue) || !card.imagePrompt.trim()))
                          || card.imageStatus === "running"
                          || card.imageStatus === "queued"
                          || Boolean(batchMode && (batchMode === "full" || card.imageStatus !== "done"))}
                        onClick={() => void generateImage(card.id)}
                      >
                        {card.imageStatus === "running" || card.imageStatus === "queued" ? <Loader2 className="animate-spin" /> : card.imageStatus === "done" || card.imageStatus === "failed" ? <RotateCcw /> : <Sparkles />}
                        {card.imageStatus === "running" || card.imageStatus === "queued"
                          ? statusText(card.imageStatus)
                          : isUnavailableCompletedInlineImage(card)
                            ? "图片不可恢复"
                          : card.imageRetryBlocked
                            ? "结果待确认"
                            : card.imageRecoveryReady
                              ? "正在保存结果"
                              : card.imageStatus === "done" ? "重新生图" : card.imageStatus === "failed" ? "重试生图" : "生成图片"}
                      </button>
                    </div>
                  </section>

                  <section ref={(element) => { videoSectionsRef.current[card.id] = element; }} className={`sbw-flow-section sbw-video-flow ${!hasValidatedImage(card) || storyboardImageRatioIssue(card, run.ratio) ? "is-locked" : ""} ${card.videoUrl ? "has-result" : ""} ${expandedVideoCards.has(card.id) ? "is-expanded" : "is-collapsed"}`}>
                    <div className="sbw-flow-prompt">
                      <div className="sbw-prompt-heading"><span>视频提示词</span><button type="button" title="粘贴视频提示词" aria-label={`粘贴镜头${card.order}视频提示词`} onClick={() => void pastePrompt(card.id, "videoPrompt", `镜头${card.order}视频提示词`)}><ClipboardPaste /></button></div>
                      <textarea aria-label={`镜头${card.order}视频提示词`} rows={4} disabled={card.videoStatus === "running" || card.videoStatus === "queued"} value={card.videoPrompt} onChange={(event) => patchCard(card.id, { videoPrompt: event.target.value })} placeholder="粘贴故事版智能体输出的视频 Prompt" />
                    </div>
                    {expandedVideoCards.has(card.id) ? (
                      <>
                        <div className="sbw-zone-title"><Film /><strong>视频生成</strong><span>{card.videoStatus === "done" ? `已完成 · ${submittedVideoTaskLabel(card)}` : storyboardImageRatioIssue(card, run.ratio) || (hasValidatedImage(card) ? "故事板图片已绑定" : "等待故事板图片")}</span></div>
                        <div className="sbw-video-frame sbw-ratio-frame">
                          {card.videoUrl ? (
                            <TicketedVideo url={card.videoUrl} taskId={card.videoTaskId} token={token} poster={card.imageUrl} onExpand={(url) => setPreviewMedia({ url, type: "video", poster: card.imageUrl })} />
                          ) : isActiveVideoStatus(card.videoStatus) ? (
                            <div className="sbw-loading-state sbw-realtime-state">
                              <Loader2 className="animate-spin" />
                              <strong>{card.videoLifecycle?.headline || statusText(card.videoStatus)}</strong>
                              <small>{submittedVideoTaskLabel(card)}</small>
                              <span className="sbw-stage-detail">{card.videoLifecycle?.detail || card.videoStatusDetail || "正在等待上游首次状态回报"}</span>
                              <ol className="sbw-video-stage-steps" aria-label={`${submittedVideoTaskLabel(card)}处理阶段`}>
                                {VIDEO_DELIVERY_STAGES.map((label, index) => {
                                  const activeStage = cardVideoStageIndex(card);
                                  return <li
                                    key={label}
                                    className={index < activeStage ? "is-done" : index === activeStage ? "is-current" : ""}
                                    aria-current={index === activeStage ? "step" : undefined}
                                  ><span>{index + 1}</span><small>{label}</small></li>;
                                })}
                              </ol>
                              <small>{formatElapsed(card.videoStartedAt, clockNow)} · {formatLastChecked(card.videoLastCheckedAt, clockNow)}</small>
                            </div>
                          ) : (
                            <div className="sbw-empty-state">{hasValidatedImage(card) ? <Film /> : <LockKeyhole />}<span>{hasValidatedImage(card) ? "故事板已绑定，点击生成视频" : "故事板图片验证后自动解锁"}</span></div>
                          )}
                        </div>
                        {card.videoError && <p className="sbw-error-line">{card.videoError}</p>}
                        {card.videoBillingState && <p className="sbw-billing-line">视频费用：{isActiveVideoStatus(card.videoStatus)
                          ? "任务处理中，成功交付后扣费"
                          : card.videoStatus === "done"
                            ? `实际扣费 ¥${Number(card.videoPriceCharged || 0).toFixed(2)}`
                            : card.videoPriceCharged === 0 ? "未扣费" : "费用待确认"}</p>}
                        <div className="sbw-media-actions">
                          <button type="button" title="复制视频 Prompt" onClick={() => copyText(card.videoPrompt, `镜头${card.order}视频 Prompt`)}><ClipboardCopy /></button>
                          {card.videoUrl && (
                            <button
                              type="button"
                              title={card.videoTaskId ? "下载视频" : "缺少视频任务编号，无法安全下载"}
                              aria-label={card.videoTaskId ? `下载镜头${card.order}视频` : `镜头${card.order}视频缺少任务编号，无法下载`}
                              disabled={!card.videoTaskId}
                              onClick={() => {
                                void openVideoDownload(card.videoTaskId, `${String(card.order).padStart(2, "0")}-视频.mp4`, token)
                                  .catch((error) => setNotice(error instanceof Error ? error.message : "下载地址获取失败，请重试"));
                              }}
                            >
                              <Download />
                            </button>
                          )}
                          <button type="button" title="收起视频区域" aria-label={`收起镜头${card.order}视频区域`} disabled={card.videoStatus === "running" || card.videoStatus === "queued"} onClick={() => setExpandedVideoCards((current) => { const next = new Set(current); next.delete(card.id); return next; })}><ChevronUp /></button>
                          <button
                            type="button"
                            className={`is-command is-video-command ${isActiveVideoStatus(card.videoStatus) && canRequestVideoTermination(card) ? "is-stop-command" : ""}`}
                            title={videoNeedsRequestReconciliation(card) ? "查询原请求号；只恢复既有任务状态，不会自动重复提交" : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? `${submittedVideoTaskLabel(card)} · 已停止本页等待；上游任务未取消，点击继续查询` : isActiveVideoStatus(card.videoStatus) ? `${submittedVideoTaskLabel(card)} · ${canRequestVideoTermination(card) ? (canRemotelyCancelVideoTask(card) ? "终止本次任务并同步上游" : card.videoTaskId ? "停止本页等待；上游任务与后台查询不受影响" : "核对投递状态后终止；已投递任务须获上游确认") : "缺少可核验请求编号"}` : card.videoStatus === "failed" && card.videoRetryable !== true ? "原任务或费用尚未确认，请先刷新历史状态" : storyboardImageRatioIssue(card, run.ratio) || activeVideoSelectionIssue || (batchMode && (batchMode === "full" || card.videoStatus !== "done") ? "当前卡片正在批量流程中" : card.videoStatus === "done" ? "使用当前所选视频模型重新生成" : "生成视频")}
                            disabled={isActiveVideoStatus(card.videoStatus) ? (videoNeedsRequestReconciliation(card) ? false : !canRequestVideoTermination(card)) : (Boolean(activeVideoSelectionIssue) || (videoPromptRequired && !card.videoPrompt.trim()) || !hasValidatedImage(card) || Boolean(storyboardImageRatioIssue(card, run.ratio)) || Boolean(batchMode && (batchMode === "full" || card.videoStatus !== "done")))}
                            onClick={() => void (videoNeedsRequestReconciliation(card) ? reconcileVideoRequest(card.id, "manual") : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? resumeVideoMonitoring(card.id) : isActiveVideoStatus(card.videoStatus) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? pauseVideoMonitoring(card.id) : cancelVideo(card.id)) : generateVideo(card.id))}
                          >
                            {videoNeedsRequestReconciliation(card) || isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? <RefreshCw /> : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? <Square /> : <Loader2 className="animate-spin" />) : card.videoStatus === "done" || card.videoStatus === "failed" || card.videoStatus === "cancelled" ? <RotateCcw /> : <Film />}
                            {videoNeedsRequestReconciliation(card) ? "刷新状态" : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? "继续查询" : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? "停止等待" : "终止生成") : "生成中") : card.videoStatus === "done" || card.videoStatus === "cancelled" ? "重新生成" : card.videoStatus === "failed" ? card.videoRetryable === true ? "重试生成" : "状态待确认" : "生成视频"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="sbw-video-compact">
                        <span>{hasValidatedImage(card) && !storyboardImageRatioIssue(card, run.ratio) ? <Film /> : <LockKeyhole />}<strong>{card.videoStatus === "done" ? "视频已完成" : storyboardImageRatioIssue(card, run.ratio) ? "画幅已变化，请重新生图" : hasValidatedImage(card) ? "视频已解锁" : "等待故事板图片"}</strong></span>
                        <div>
                          <button type="button" title="复制视频 Prompt" onClick={() => copyText(card.videoPrompt, `镜头${card.order}视频 Prompt`)}><ClipboardCopy /></button>
                          <button type="button" title="展开视频区域" aria-label={`展开镜头${card.order}视频区域`} onClick={() => setExpandedVideoCards((current) => new Set(current).add(card.id))}><ChevronDown /></button>
                          <button
                            type="button"
                            className={`is-command is-video-command ${isActiveVideoStatus(card.videoStatus) && canRequestVideoTermination(card) ? "is-stop-command" : ""}`}
                            title={videoNeedsRequestReconciliation(card) ? "查询原请求号；只恢复既有任务状态，不会自动重复提交" : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? `${submittedVideoTaskLabel(card)} · 已停止本页等待；上游任务未取消，点击继续查询` : isActiveVideoStatus(card.videoStatus) ? `${submittedVideoTaskLabel(card)} · ${canRequestVideoTermination(card) ? (canRemotelyCancelVideoTask(card) ? "终止本次任务并同步上游" : card.videoTaskId ? "停止本页等待；上游任务与后台查询不受影响" : "核对投递状态后终止；已投递任务须获上游确认") : "缺少可核验请求编号"}` : card.videoStatus === "failed" && card.videoRetryable !== true ? "原任务或费用尚未确认，请先刷新历史状态" : storyboardImageRatioIssue(card, run.ratio) || activeVideoSelectionIssue || (batchMode && (batchMode === "full" || card.videoStatus !== "done") ? "当前卡片正在批量流程中" : card.videoStatus === "done" ? "使用当前所选视频模型重新生成" : "生成视频")}
                            disabled={isActiveVideoStatus(card.videoStatus) ? (videoNeedsRequestReconciliation(card) ? false : !canRequestVideoTermination(card)) : (Boolean(activeVideoSelectionIssue) || (videoPromptRequired && !card.videoPrompt.trim()) || !hasValidatedImage(card) || Boolean(storyboardImageRatioIssue(card, run.ratio)) || Boolean(batchMode && (batchMode === "full" || card.videoStatus !== "done")))}
                            onClick={() => void (videoNeedsRequestReconciliation(card) ? reconcileVideoRequest(card.id, "manual") : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? resumeVideoMonitoring(card.id) : isActiveVideoStatus(card.videoStatus) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? pauseVideoMonitoring(card.id) : cancelVideo(card.id)) : generateVideo(card.id))}
                          >
                            {videoNeedsRequestReconciliation(card) || isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? <RefreshCw /> : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? <Square /> : <Loader2 className="animate-spin" />) : card.videoStatus === "done" || card.videoStatus === "failed" || card.videoStatus === "cancelled" ? <RotateCcw /> : <Film />}
                            {videoNeedsRequestReconciliation(card) ? "刷新状态" : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? "继续查询" : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? "停止等待" : "终止生成") : "生成中") : card.videoStatus === "done" || card.videoStatus === "cancelled" ? "重新生成" : card.videoStatus === "failed" ? card.videoRetryable === true ? "重试生成" : "状态待确认" : "生成视频"}
                          </button>
                        </div>
                      </div>
                    )}
                    {isAutodlH3LifecycleTaskId(card.videoTaskId) && (
                      <div
                        className={`sbw-h3-lifecycle is-${card.videoLifecycle?.tone || "warning"}`}
                        role="status"
                        aria-live="polite"
                        data-task-state={card.videoLifecycle?.taskState || "unavailable"}
                        data-instance-state={card.videoLifecycle?.instanceState || "unavailable"}
                      >
                        <div><strong>自租 H3 全链路</strong><span>{card.videoLifecycle?.headline || (card.videoLifecycleError ? "实时状态暂时不可用" : "正在读取全链路状态")}</span></div>
                        {card.videoLifecycle ? (
                          <small>任务：{card.videoLifecycle.taskLabel} · 主机：{card.videoLifecycle.instanceLabel}</small>
                        ) : (
                          <small>{card.videoLifecycleError || "正在核对任务、实例、网关与关机状态"}</small>
                        )}
                      </div>
                    )}
                  </section>
                </div>
              </article>
            ))}
          </section>

          <div className="sbw-card-footer-actions" aria-label="镜头卡片管理">
            <button type="button" className="sbw-add-card" disabled={run.cards.length >= MAX_CARDS} onClick={addCard} title="添加一个镜头卡"><Plus />添加镜头</button>
            <button type="button" className="sbw-clear-empty-cards" disabled={Boolean(batchMode)} onClick={clearIdleCards} title="清理没有 Prompt、结果和运行任务的空卡片"><Trash2 />清理空卡</button>
          </div>
        </div>
      </main>

      <div className="sbw-notice" role="status">{batchMode && <Loader2 className="animate-spin" />}{notice}{cloud.message && <span className="ml-3" data-storyboard-save-status>{cloud.message}</span>}</div>

      {historyOpen && (
        <div className="sbw-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setHistoryOpen(false)}>
          <aside className="sbw-drawer" aria-label="分镜工作台历史" style={{ width: 'min(1120px, 96vw)' }}>
            <header><div><span>按今天、昨天、前天保留已结束任务；进行中任务持续显示</span><strong>最近任务</strong></div><button type="button" aria-label="关闭最近任务" onClick={() => setHistoryOpen(false)}><X /></button></header>
            <section className="sbw-history-list" aria-label="分镜生图失败记录">
              <div className="flex items-center justify-between gap-2">
                <div><strong>生图失败记录</strong><p>仅显示明确失败且已保存的原参数；载入不会自动生成</p></div>
                <button type="button" disabled={imageFailureHistoryLoading} onClick={() => void loadStoryboardImageFailureHistory(1)}>{imageFailureHistoryLoading ? "读取中…" : "刷新"}</button>
              </div>
              {imageFailureHistoryError && <p role="alert">{imageFailureHistoryError}</p>}
              {imageFailureHistory.map((record) => (
                <article key={record.id} data-storyboard-image-failure-id={record.id}>
                  <div><strong>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.modelName}</strong><span>{record.aspectRatio} · {record.resolution}</span></div>
                  <p>{record.prompt}</p>
                  <p>{record.error.message} · 原报价 ¥{record.quotedPriceYuan.toFixed(2)} · {record.billing.state === "charged"
                    ? `已扣 ¥${Number(record.billing.chargedAmount || 0).toFixed(2)}`
                    : record.billing.state === "unknown" ? "费用待确认" : "未扣费"}</p>
                  {record.retryBlockReason && <p role="alert">{record.retryBlockReason}</p>}
                  <div className="sbw-history-actions"><button type="button" disabled={!record.canLoadForRetry} onClick={() => prepareStoryboardImageFailureRetry(record)}>{record.canLoadForRetry ? "载入参数" : "等待费用确认"}</button></div>
                </article>
              ))}
              {!imageFailureHistoryLoading && !imageFailureHistoryError && !imageFailureHistory.length && <p>暂无明确失败的分镜生图记录。</p>}
              {imageFailureHistoryNextPage !== null && <button type="button" disabled={imageFailureHistoryLoading} onClick={() => void loadStoryboardImageFailureHistory(imageFailureHistoryNextPage)}>加载更多生图失败记录</button>}
            </section>
            <section className="sbw-history-list" aria-label="分镜视频生成记录">
              <div className="flex items-center justify-between gap-2">
                <div><strong>视频生成记录</strong><p>按任务展示故事板图片与视频结果；点击即可放大或播放</p></div>
                <button type="button" disabled={videoHistoryLoading} onClick={() => void loadVideoHistory()}>{videoHistoryLoading ? "读取中…" : "刷新"}</button>
              </div>
              {videoHistoryError && <p role="alert">{videoHistoryError}</p>}
              {videoHistoryTasks.map((task, index) => {
                const taskId = String(task.id || task.taskIdExternal || `video-history-${index}`);
                const displayIndex = Number(task.cardIndex) > 0 ? Number(task.cardIndex) : index + 1;
                const poster = String(task.thumbnailUrl || task.firstFrameUrl || "");
                const completed = task.status === "completed" && Boolean(task.id || task.taskIdExternal);
                return (
                  <article key={taskId} data-video-history-task={taskId} className="sbw-history-video-task">
                    <div>
                      <strong><span className="sbw-history-day">{beijingHistoryDayLabel(task.completedAt || task.createdAt || Date.now())}</span>任务 {displayIndex} · {task.modelName || "视频模型"}</strong>
                      <span>{task.completedAt || task.createdAt ? new Date(task.completedAt || task.createdAt || "").toLocaleString("zh-CN") : ""}</span>
                    </div>
                    {task.prompt && <p>{task.prompt}</p>}
                    <div className="sbw-history-project-media">
                      {task.firstFrameUrl ? (
                        <button type="button" onClick={() => setPreviewMedia({ url: String(task.firstFrameUrl), type: "image" })} aria-label={`放大任务${displayIndex}图片`}>
                          <img src={task.firstFrameUrl} alt={`任务${displayIndex}图片`} />
                        </button>
                      ) : <div className="sbw-history-media-state">暂无故事板图片</div>}
                      {completed ? (
                        expandedHistoryVideoTaskId === taskId ? (
                          <TicketedVideo
                            url={String(task.videoUrl || "")}
                            taskId={String(task.id || task.taskIdExternal || "")}
                            token={token}
                            poster={poster || undefined}
                            onExpand={(url) => setPreviewMedia({ url, type: "video", poster: poster || undefined })}
                          />
                        ) : (
                          <button type="button" onClick={() => setExpandedHistoryVideoTaskId(taskId)} aria-label={`播放 任务${displayIndex}视频`}>
                            {poster ? <img src={poster} alt={`任务${displayIndex}视频首帧`} /> : <span className="sbw-history-media-state">视频已完成</span>}
                            <span><Film />播放视频</span>
                          </button>
                        )
                      ) : <div className="sbw-history-media-state">{task.status === "failed" ? "视频生成失败" : task.status === "cancelled" ? "视频已终止" : "视频生成中"}</div>}
                    </div>
                  </article>
                );
              })}
              {!videoHistoryLoading && !videoHistoryError && !videoHistoryTasks.length && <p>暂无分镜视频记录。</p>}
            </section>
            <div className="sbw-history-list">
              <div className="flex items-center justify-between gap-2"><strong>分镜任务</strong><button type="button" disabled={cloud.loading} onClick={() => void cloud.refresh()}>{cloud.loading ? "读取中…" : "刷新"}</button></div>
              {cloud.message && <p role="status">{cloud.message}</p>}
              {cloud.projects.map((project) => (
                <article key={`cloud-${project.id}`} data-storyboard-project-id={project.id} className="sbw-history-project">
                  <div>
                    <strong><span className="sbw-history-day">{beijingHistoryDayLabel(project.submittedAt || project.updatedAt)}</span>{project.title}</strong>
                    <span>{project.submittedAt ? `最近提交 ${new Date(project.submittedAt).toLocaleString("zh-CN")}` : "尚无可靠提交时间"} · 最近保存 {new Date(project.updatedAt).toLocaleString("zh-CN")}</span>
                  </div>
                  <p>{project.cardCount} 个任务 · 按提交卡片顺序展示</p>
                  {!!project.cards?.length && <div className="sbw-history-project-cards">
                    {project.cards.map((card) => {
                      const videoKey = `${project.id}:${card.id}`;
                      const poster = card.imageUrl || card.videoThumbnailUrl || undefined;
                      const openingVideo = openingProjectVideoKey === videoKey;
                      return (
                      <section key={`${project.id}-${card.id}`} className="sbw-history-project-card">
                        <strong>任务 {card.order}</strong>
                        <div className="sbw-history-project-media">
                          {card.imageUrl ? (
                            <button type="button" onClick={() => setPreviewMedia({ url: card.imageUrl, type: "image" })} aria-label={`放大任务${card.order}图片`}>
                              <img src={card.imageUrl} alt={`任务${card.order}图片`} />
                            </button>
                          ) : <div className="sbw-history-media-state">{card.imageStatus === "failed" ? "图片生成失败" : "暂无图片"}</div>}
                          {card.videoTaskId || card.videoUrl ? (
                            <button
                              type="button"
                              data-storyboard-project-video={videoKey}
                              data-video-task-id={card.videoTaskId || undefined}
                              disabled={openingVideo}
                              onClick={async () => {
                                setOpeningProjectVideoKey(videoKey);
                                try {
                                  const url = card.videoTaskId
                                    ? await requestVideoAccessUrl(card.videoTaskId, token)
                                    : card.videoUrl;
                                  if (!url) throw new Error("播放地址暂不可用");
                                  if (!scopeMountedRef.current) return;
                                  setPreviewMedia({ url, type: "video", poster });
                                } catch {
                                  if (scopeMountedRef.current) setNotice("播放地址暂不可用，请稍后再试");
                                } finally {
                                  if (scopeMountedRef.current) setOpeningProjectVideoKey("");
                                }
                              }}
                              aria-label={`放大任务${card.order}视频`}
                            >
                              {poster
                                ? <img src={poster} alt={`任务${card.order}视频首帧`} />
                                : <span className="sbw-history-media-state">视频已完成</span>}
                              <span>{openingVideo ? <Loader2 className="animate-spin" /> : <Film />}{openingVideo ? "正在打开…" : "播放视频"}</span>
                            </button>
                          ) : <div className="sbw-history-media-state">{card.videoStatus === "failed" ? "视频生成失败" : "暂无视频"}</div>}
                        </div>
                      </section>
                      );
                    })}
                  </div>}
                  <div className="sbw-history-actions">
                    <button type="button" disabled={handoffImportBlocked} onClick={async () => {
                      if (!window.confirm("打开任务会替换当前工作台内容。确认继续？")) return;
                      const loaded = await cloud.restore(project.id);
                      const record = normalizeRun(loaded);
                      if (!record || !scopeMountedRef.current) return;
                      videoHistoryHydratedRef.current = false;
                      submittedRunIdsRef.current.add(record.id);
                      setHistory((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, MAX_HISTORY));
                      runRef.current = record; setRun(record); setHistoryOpen(false); setNotice(`已打开：${record.title}`);
                    }}>打开任务</button>
                    <button type="button" title="删除任务记录" disabled={project.id === run.id && handoffImportBlocked} onClick={async () => {
                      if (!window.confirm("删除这条任务记录？生成的图片和视频会保留。")) return;
                      if (!await cloud.remove(project) || !scopeMountedRef.current) return;
                      submittedRunIdsRef.current.delete(project.id);
                      setHistory((current) => current.filter((item) => item.id !== project.id));
                      if (runRef.current.id === project.id) { const empty = createRun(); runRef.current = empty; setRun(empty); }
                    }}><Trash2 /></button>
                  </div>
                </article>
              ))}
              {!cloud.loading && !cloud.projects.length && <p>暂无最近任务；提交图片或视频后会自动保存到账户。</p>}
               {cloud.nextOffset !== null && <button type="button" disabled={cloud.loading} onClick={() => void cloud.refresh(cloud.nextOffset!)}>加载更多任务</button>}
              {history.some((record) => !cloud.projects.some((project) => project.id === record.id)) && <strong>此浏览器待确认任务</strong>}
              {history.filter((record) => !cloud.projects.some((project) => project.id === record.id)).map((record) => (
                <article key={record.id}>
                  <div><strong><span className="sbw-history-day">{beijingHistoryDayLabel(record.lastSubmittedAt || record.updatedAt)}</span>{record.title}</strong><span>{new Date(record.updatedAt).toLocaleString("zh-CN")}</span></div>
                  <p>{record.cards.length}张卡 · 图片{record.cards.filter((item) => item.imageStatus === "done").length} · 视频{record.cards.filter((item) => item.videoStatus === "done").length}</p>
                  <div className="sbw-history-actions"><button type="button" onClick={() => { submittedRunIdsRef.current.add(record.id); runRef.current = record; setRun(record); setHistoryOpen(false); setNotice(`已打开：${record.title}`); }}>打开任务</button><button type="button" title="删除记录" onClick={() => setHistory((current) => current.filter((item) => item.id !== record.id))}><Trash2 /></button></div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      )}

      {previewMedia && <MediaLightbox media={previewMedia} onClose={() => setPreviewMedia(null)} />}
    </div>
  );
}
