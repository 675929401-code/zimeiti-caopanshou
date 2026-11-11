"use client";
import { resolveAiVideoInputAspectRatio } from "@/lib/ai-video-page-capabilities";
import { readVideoDurationBehavior, type VideoDurationBehavior } from "@/lib/video-duration-behavior";
import { VideoDurationBehaviorNotice } from "@/components/video-duration-behavior-notice";
import { resolveStoryboardExecutionMode, storyboardChainFingerprint, StoryboardChainRequestSchema, storyboardChainInputFingerprint, type StoryboardExecutionMode, type StoryboardChainRequest, type StoryboardChainAnchorConfirmation } from "@/lib/storyboard-chain-contract";
import { storyboardChainContext, storyboardChainSnapshotMatches, storyboardChainManualReferences, storyboardChainPlanFingerprint, runStoryboardChainQueue } from "@/lib/storyboard-chain-controller";

import { adoptInitialStoryboardReferences } from "@/lib/storyboard-initial-reference-adoption";
import { adoptFirstStoryboardReference } from "@/lib/storyboard-first-reference-adoption";
import { storyboardImageFailurePresentation } from "@/lib/storyboard-image-failure-presentation";
import { videoModelInputHint, videoModelInputLabel } from "@/lib/video-model-selection-state";
import { updateVideoConfirmationMap } from "@/lib/video-task-progress";
import { publicVideoModelCompatibilityCode } from "@/lib/video-model-public-status";
import { buildStoryboardThreeViewPrompt, storyboardFirstThreeViewInput } from "@/lib/storyboard-visual-asset-three-view";
import { prepareStoryboardVideo } from "@/lib/storyboard-video-preparation";
import { resolveStoryboardVideoSameKeyRetryAttempt } from "@/lib/storyboard-video-retry";
import { storyboardProjectAutosaveFingerprint, STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS, STORYBOARD_MONITOR_CHECKPOINT_MS } from "@/lib/storyboard-project-autosave";
import { removeStoryboardReference } from "@/lib/storyboard-reference-removal";
import { resolveStoryboardReferenceImageSettings } from "@/lib/storyboard-reference-image-settings";
import { markVisualAssetMediaStale, visualAssetReferenceContentChanged } from "@/lib/storyboard-visual-asset-media-state";
import { storyboardAgentImportProjectId } from "@/lib/storyboard-agent-import-target";
import modelRailRestoration from "./storyboard-model-rail-restoration.module.css";

import { describeReferenceUpload, readReferenceUploadPending, resolveReferenceUpload, writeReferenceUploadPending, type ReferenceUploadPending } from "@/lib/storyboard-reference-upload";

import {
  ClipboardCopy,
  ClipboardPaste,
  Download,
  Eye,
  Film,
  History,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TicketedVideo, MediaLightbox, type PreviewMedia } from "@/components/storyboard-media-preview";
import { requestVideoAccessUrl } from "@/lib/storyboard-video-access";
import { fetchStoryboardJson, openStoryboardStream, STORYBOARD_VIDEO_SUBMIT_DEADLINE_MS } from "@/lib/storyboard-request-deadline";
import { videoDownloadFile } from "@/lib/video-download-file";
import { VideoLocalAutoCache } from "@/lib/video-local-auto-cache";
import { useRouter, useSearchParams } from "next/navigation";
import "@/app/storyboard-workbench/visual-assets/visual-assets-page.css";
import { GeneratedImageReferenceSchema, generatedImageReferenceUri, generatedImagePreviewUrl, type GeneratedImageReference } from "@/lib/generated-image-reference";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { NavButton, SubPageHeader } from "@/components/sub-page-header";
import { StoryboardEditorViewport } from "./storyboard-editor-viewport";
import { StoryboardVisualAssetsDrawer, type DrawerVisualAsset, type DrawerVisualAssetMutation, type DrawerVisualAssetInput, type ImportReferenceImage } from "@/components/storyboard-visual-assets-drawer";
import type { StoryboardPresetPublic } from "@/lib/storyboard-preset-assets";
import { rememberStoryboardBoardBlob, readStoryboardBoardBlob, type StoryboardBoardBlob, saveStoryboardBoardOriginal, isOwnedStoryboardBoard, needsStoryboardBoardExport, rollbackStoryboardBoardBinding } from "@/lib/storyboard-board-export";
import { saveStoryboardVisualAssetCandidates } from "@/lib/storyboard-visual-asset-library";
import type { ImagePresetReference } from "@/lib/image-generation-request";
import { refreshStoryboardVisualAssetReferences } from "@/lib/storyboard-visual-asset-submission";
import { buildVisualAssetPrompt } from "@/lib/storyboard-visual-asset-prompt";
import { isReferenceSessionId, readReferenceSessionId, writeReferenceSessionId, readReferenceWorkspace, saveReferenceWorkspace, type ReferenceWorkspace } from "@/lib/storyboard-reference-workspace";
import { imageDeliveryRecoveryRequest, type ImageDeliveryRecoveryStatus } from "@/lib/image-workbench-recovery";
import { assetAttemptWasNotAccepted, readStoryboardAssetAttempts, writeStoryboardAssetAttempts, type StoryboardAssetAttempt } from "@/lib/storyboard-asset-attempt";
import { ModelBadge } from "@/components/model-badge";
import { resolveModelBrand } from "@/lib/model-brand";
import { getImageModelCapabilities, IMAGE_RESOLUTION_ORDER, type ImageModelIdentity } from "@/lib/image-model-capabilities";
import { imageDimensionsMatchAspectRatio } from "@/lib/image-output-contract";
import { readStoryboardProtectedPreview, StoryboardImagePreviewError } from "@/lib/storyboard-image-preview";
import { isCompletedProviderImageReceipt, isUnavailableCompletedStoryboardImage, storyboardImageUnavailablePatch, storyboardImageUnavailablePresentation, type StoryboardImageMediaState } from "@/lib/storyboard-image-result-state";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import { normalizeStoryboardVideoInputs, isStoryboardImageWorkflow, type StoryboardVideoInputs } from "@/lib/storyboard-video-inputs";
import { resolveStoryboardAutomaticVideoInputs, storyboardAutomaticVideoProductionFingerprint, storyboardAutomaticVideoProductionBlocker } from "@/lib/storyboard-automatic-video-inputs";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  resolveBrowserClientAttempt,
} from "@/lib/browser-client-attempt";
import type { AutodlH3LifecycleView } from "@/lib/autodl-h3-lifecycle-view";
import { SseEventStreamDecoder } from "@/lib/sse-stream-decoder";
import { createStoryboardPersistenceSnapshot } from "@/lib/storyboard-local-persistence";
import { createImportedStoryboardVisualAssetWorkspace, normalizeStoryboardVisualAssetWorkspace, storyboardReferenceImageSettings, type StoryboardReferenceImageSettings, type StoryboardVisualAssetWorkspace, type StoryboardVisualAssetDraft } from "@/lib/storyboard-visual-asset-workspace";
import { projectGeneratedImageClientReceipt, resolveGeneratedImageClientDelivery } from "@/lib/generated-image-client-delivery";
import { ImageDownloadOperations, readImageDownloadBlob, imageDownloadFilename } from "@/lib/generated-image-download";
import { MEDIA_CANCEL_DEADLINE_MS, providerMediaUrl, readMediaStreamWithDeadline } from "@/lib/generated-media-delivery";
import { storyboardRecoveryStorageKey, readStoryboardRecovery, readStoryboardRecoveryConflicts, clearStoryboardWorkspaceRecovery, writeStoryboardRecovery, storyboardRecoveryContentFingerprint, inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict } from "@/lib/storyboard-workspace-recovery";
import { useStoryboardProjects } from "@/hooks/use-storyboard-projects";
import type { StoryboardAgentOutputSegment } from "@/lib/storyboard-agent-output";
import {
  StoryboardWardrobePlanSchema,
  type StoryboardBottomPanelRole,
  type StoryboardQualityCheck,
  type StoryboardVisualAssetPlan,
  type StoryboardVisualAssetRef,
  type StoryboardWardrobePlan,
  type StoryboardWardrobeChangeEvent,
} from "@/lib/storyboard-workbench";
import { StoryboardAssetSelection } from "@/components/storyboard-asset-selection";
import { changeProjectDefaults, chooseCustomAssets, prepareSelectedCardSourceUpdate, rebindSelectedCard, requestedVisualAssetIds, requestedVisualAssetPlan, rollbackSelectionTransaction, visualAssetBindingSummary, mutateVisualAssetSlot, affectedVisualAssetCards } from "@/lib/storyboard-visual-asset-selection";
import { migrateSavedVisualAssetSource, selectedVisualAssetCandidate, bindVisualAssetPlan, removeVisualAssetBindings, suspendVisualAssetBindings, activeStoryboardVisualAssetRefs, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds, type VisualAssetUrl } from "@/lib/storyboard-visual-asset-binding";
import { VIDEO_HISTORY_SETTLED_BILLING_STATES } from "@/lib/video-history-policy";
import {
  GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY,
  GENERAL_SCRIPT_HANDOFF_STORAGE_KEY,
  parseGeneralScriptStoryboardHandoff,
  type GeneralScriptHandoffErrorCode,
  type ParsedGeneralScriptStoryboardHandoff,
} from "@/lib/short-drama/general-script-storyboard-bridge";
import {
  readAgentWorkbenchHandoff,
  readAgentWorkbenchHandoffAcrossTabs,
  acknowledgeAgentWorkbenchHandoffAcrossTabs,
  type AgentWorkbenchHandoffEnvelope,
} from "@/lib/agent-workbench-handoff";
import {
  parseStoryboardCanvasImport,
  type StoryboardCanvasImportPlan,
} from "@/lib/storyboard-canvas-bridge";
import { buildStoryboardDirectorExecution, compileStoryboardDirectorVideoPrompt, type StoryboardDirectorExecution } from "@/lib/storyboard-director-execution";
import { collectStoryboardDirectorReferenceBindings } from "@/lib/storyboard-director-reference-verification";
import { storyboardProductionPlanFingerprint, storyboardProductionAssetFingerprint, storyboardProductionImageFingerprint, storyboardProductionImageInputMatch, storyboardProductionQuote, runStoryboardProductionQueue } from "@/lib/storyboard-continuous-production";
import { buildStoryboardDirectorResumeCard, StoryboardDirectorIntakeStateSchema, type StoryboardDirectorIntakeState } from "@/lib/storyboard-director-resume";
import { confirmStoryboardDirectorAsset, hasStoryboardDirectorAssetConfirmation, pruneStoryboardDirectorAssetConfirmations, storyboardDirectorCandidateMatchesDraft } from "@/lib/storyboard-director-asset-confirmation";
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
  getVideoBillingUnit,
  readVideoTokenPublicPricing,
  resolveVideoTokenBillingConsent,
  videoTokenBudgetTotal,
  videoTokenRateLabel,
  type VideoTokenBillingRequest,
  type VideoTokenPublicPricing,
  getVideoResolutionCapabilities,
  getVideoTargetDurationOptions,
  resolveVideoResolution,
} from "@/lib/video-model-capabilities";
import { compactPublicVideoModelName } from "@/lib/video-history-presentation";
import { MediaHistoryWorkspace } from "@/components/media-history-workspace";
import {
  buildStoryboardVideoPrompt,
  inferStoryboardNarration,
  narrationCharacterCount,
  storyboardVideoPromptViolation,
  storyboardVideoRuntimeGuard,
} from "@/lib/storyboard-single-frame-video-prompt";
import { validateStoryboardNarrationCapacity } from "@/lib/storyboard-duration-contract";
import { isRestorableImageExactText } from "@/lib/storyboard-annotation-layout";

type TaskStatus = "idle" | "queued" | "running" | "done" | "failed" | "cancelled";
type BatchMode = "" | "images" | "videos";
type StoryboardBatchAuthorization = { isCurrent?: () => boolean; kind: "images" | "videos"; runId: string; settings: string; price: number; tokenBilling?: VideoTokenBillingRequest; inputs: Map<string, string>; started: Set<string> };
type ContinuousProductionAuthorization = {
  owner: string; runId: string; planFingerprint: string; assetFingerprint?: string;
  referencePrice: number; imagePrice: number; videoPrice: number; tokenBilling?: VideoTokenBillingRequest;
  referenceInputs: Map<string, string>; stage: "references" | "images" | "videos";
};
type ContinuousProductionStatus = "idle" | "running" | "waiting" | "paused" | "stopped" | "done";
const WORKBENCH_RATIOS = ["16:9", "9:16", "1:1"] as const;
type WorkbenchRatio = (typeof WORKBENCH_RATIOS)[number];
type VisualAssetRole = "character" | "pet" | "environment" | "prop";
type OwnedVisualAsset = DrawerVisualAsset;
type VisualAssetBatchAuthorization = { isCurrent?: () => boolean; runId: string; modelId: string; resolution: string; ratio: WorkbenchRatio; price: number; inputs: Map<string, string>; started: Set<string> };

type StoryboardImageRequestSnapshot = {
  chainContext?: StoryboardChainRequest;
  runId: string;
  cardId: string;
  cardOrder: number;
  prompt: string;
  modelId: string;
  aspectRatio: WorkbenchRatio;
  resolution: string;
  exactText?: string;
  referenceImageUrls: string[];
  presetReferences?: ImagePresetReference[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  strictSingleSubmit: boolean;
  /** A new explicit user generation gets a new ordinal; recovery keeps the original ordinal. */
  attemptOrdinal?: number;
};

type StoryboardImageAttemptState =
  | "not_found"
  | "processing"
  | "completed"
  | "expired"
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
  generationCompleted?: boolean;
  mediaAvailable?: boolean;
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
  const data = value as Record<string, unknown>;
  const outputPolicyVersion = data.outputPolicyVersion === "image_output_policy.v1" || data.outputPolicyVersion === "image_output_policy.v2" ? data.outputPolicyVersion : undefined;
  const deliveryExpectedPixelSize = typeof data.deliveryExpectedPixelSize === "string" && /^[1-9]\d{1,5}x[1-9]\d{1,5}$/u.test(data.deliveryExpectedPixelSize) ? data.deliveryExpectedPixelSize : undefined;
  return { imageRecordId: receipt.recordId, imageDeliveryMode: receipt.deliveryMode,
    imageMediaState: undefined, ...(deliveryExpectedPixelSize ? { imageDeliveryExpectedPixelSize: deliveryExpectedPixelSize } : {}),
    ...(outputPolicyVersion ? { imageOutputPolicyVersion: outputPolicyVersion } : {}),
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
  chainAnchorConfirmation?: StoryboardChainAnchorConfirmation;
  continuousImageInputFingerprint?: string;
  continuousVideoInputFingerprint?: string;
  id: string;
  order: number;
  sourceNumber?: number;
  label?: string;
  narration?: string;
  imagePrompt: string;
  imageExactText?: string;
  imageTextLayoutEnabled?: boolean;
  imageAnnotationIssue?: string;
  videoPrompt: string;
  videoInputs?: StoryboardVideoInputs;
  directorExecution?: StoryboardDirectorExecution;
  referenceImageUrls: string[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  visualAssetRefsMode?: "legacy" | "explicit";
  visualAssetSelectionMode?: "project" | "custom";
  sceneId?: string;
  sceneZone?: string;
  styleLock?: string;
  sceneLock?: string;
  camera?: string;
  dynamicState?: string[];
  capabilityGaps?: string[];
  bottomPanelRole?: StoryboardBottomPanelRole;
  qualityChecks?: StoryboardQualityCheck[];
  wardrobeChangeEvents?: StoryboardWardrobeChangeEvent[];
  imageStatus: TaskStatus;
  imageReferenceState?: "stale";
  imageUrl?: string;
  imageRef?: GeneratedImageReference;
  imageRecordId?: string;
  imageDeliveryMode?: "provider_url" | "inline_ephemeral";
  imageMediaState?: StoryboardImageMediaState;
  imageDeliveryExpectedPixelSize?: string;
  imageOutputPolicyVersion?: "image_output_policy.v1" | "image_output_policy.v2";
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
  videoSameRequestKeyRequired?: boolean;
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
  executionMode?: StoryboardExecutionMode;
  chainRevision?: number;
  draftImportNotice?: string;
  directorIntake?: StoryboardDirectorIntakeState;
  id: string;
  createdAt: number;
  updatedAt: number;
  lastSubmittedAt?: number;
  ratio: WorkbenchRatio;
  imageRatio?: WorkbenchRatio;
  imageResolution: string;
  videoResolution: string;
  videoDuration: number;
  imageModelId: string;
  videoModelId: string;
  videoContract?: WorkbenchVideoContract;
  wardrobePlan?: StoryboardWardrobePlan;
  visualAssetPlan?: StoryboardVisualAssetPlan;
  visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
  environmentGroups?: Array<{
    sceneId: string;
    name: string;
    fixedAnchors: string[];
    zones: string[];
    availableAngles: Array<"wide" | "front" | "side" | "reverse" | "detail">;
    allowedSegmentKinds: string[];
  }>;
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
  return cards.map((card) => card.videoStatus === "failed" && card.videoRetryable === true && card.videoSameRequestKeyRequired !== true
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
  requiresImage?: boolean;
  minReferenceImages?: number;
  resolution_options?: string[];
  default_resolution?: string;
  resolution_prices?: Record<string, number>;
  aspectRatios?: WorkbenchRatio[];
  family?: "gpt" | "gemini" | "qwen" | "other";
  available: boolean;
  priceReady: boolean;
  generationReady: boolean;
  availabilityMessage?: string;
};

type VideoModel = {
  durationBehavior?: VideoDurationBehavior;
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
  supportsSourceVideoInput?: boolean;
  capabilitiesVerified?: boolean;
  firstFrameRatioPolicy?: "adaptive";
  showFirstFrame?: boolean; showLastFrame?: boolean; showReferenceImages?: boolean; showAudioInputs?: boolean;
  compatibilityCode?: string;
  supportsAudioInput: boolean;
  supportsPrompt: boolean;
  workflowInputMode: string;
  referenceAspectRatioPolicy: "same" | "independent";
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
  resolutionLabels?: Record<string, string>;
  aspectRatios: WorkbenchRatio[];
  billingUnit: "per_use" | "output_second" | "token";
  tokenPricing?: VideoTokenPublicPricing;
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
    requiresImage: firstBoolean(false, capabilities.requiresImage, record.requiresImage),
    minReferenceImages: firstOptionalNumber(capabilities.minReferenceImages, record.minReferenceImages) ?? 0,
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
    generationReady: firstBoolean(true, capabilities.generationReady, record.generationReady, record.generation_ready),
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
  // This message only reaches administrator/selection diagnostics; the public
  // rail renders a stable product label through publicModelSelectionLabel.
  if (!model.available || !model.priceReady || !model.generationReady) return model.availabilityMessage || "当前不可提交";
  return "";
}

function publicModelSelectionLabel(selectionIssue: string) {
  return selectionIssue ? "当前无法生成" : "";
}

/**
 * Keep provider/readiness diagnostics out of the customer workbench.  The
 * server still returns the detailed reason for admin telemetry, while the
 * workbench receives one stable status label.  Input-shape guidance remains
 * specific because it tells the user how to correct the current request.
 */
function publicModelSelectionNotice(selectionIssue: string, subject = "模型") {
  const issue = String(selectionIssue || "").trim();
  if (!issue) return "";
  if (/(?:核验|核对|待配置|配置待|适配|上游|通道|渠道|端点|接口|https?:\/\/|\/v\d+\/|usage\.)/iu.test(issue)) {
    return "当前无法生成，请选择其他模型或稍后重试";
  }
  if (/^(?:不支持故事板图片输入|需要源视频，不能用于故事板图片|需要分别提供首帧和尾帧，当前工作台不支持|需要音频输入，请在 AI 视频制作的对应模式使用|至少需要 \d+ 张参考图；分镜每张卡片仅提交一张故事板，请在视频制作页使用|当前模型不接收故事板图片)$/u.test(issue)
    || /(?:比例|提示词|Prompt|源视频|参考图|首帧|尾帧|音频输入|故事板图片|清晰度|预设|临时图片|已验证分镜图|当前工作台不支持|输入)/iu.test(issue)) {
    return issue;
  }
  if (/图片模型尚未加载/u.test(issue)) return "生图模型尚未加载，请稍后重试";
  if (/视频模型尚未加载/u.test(issue)) return "视频模型尚未加载，请稍后重试";
  return `${subject}${publicModelSelectionLabel(issue)}，请选择其他模型或稍后重试`;
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
  const billingUnit = getVideoBillingUnit(record);
  const tokenPricing = readVideoTokenPublicPricing(record.tokenPricing);
  const hasCompletePrice = billingUnit === "token" ? Boolean(tokenPricing) : (Number.isFinite(pricePerUse)
    || (resolutionOptions.length > 0 && resolutionOptions.every((resolution) => Number.isFinite(resolutionCapabilities.publicPrices[resolution]))));
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
    durationBehavior: readVideoDurationBehavior(capabilities.durationBehavior),
    supportsImageInput: firstBoolean(false, capabilities.supportsImageInput, record.supportsImageInput, record.supports_image_input),
    requiresImage: firstBoolean(false, capabilities.requiresImage, record.requiresImage, record.requires_image),
    requiresSourceVideo: firstBoolean(false, capabilities.requiresSourceVideo, record.requiresSourceVideo, record.requires_source_video),
    supportsSourceVideoInput: firstBoolean(false, capabilities.supportsSourceVideoInput, record.supportsSourceVideoInput),
    capabilitiesVerified: capabilities.capabilitiesVerified !== false,
    firstFrameRatioPolicy: capabilities.firstFrameRatioPolicy === "adaptive" ? "adaptive" : undefined,
    showFirstFrame: firstOptionalBoolean(capabilities.showFirstFrame),
    showLastFrame: firstOptionalBoolean(capabilities.showLastFrame),
    showReferenceImages: firstOptionalBoolean(capabilities.showReferenceImages),
    showAudioInputs: firstOptionalBoolean(capabilities.showAudioInputs),
    compatibilityCode: publicVideoModelCompatibilityCode(capabilities.compatibilityCode),
    supportsAudioInput: firstBoolean(false, capabilities.supportsAudioInput, record.supportsAudioInput, record.supports_audio_input),
    referenceInputMode: firstText(capabilities.workflowInputMode, capabilities.referenceInputMode, record.workflowInputMode, record.referenceInputMode, record.reference_input_mode),
    workflowInputMode: firstText(capabilities.workflowInputMode, capabilities.referenceInputMode, record.workflowInputMode, record.referenceInputMode),
    referenceAspectRatioPolicy: firstText(capabilities.referenceAspectRatioPolicy, record.referenceAspectRatioPolicy) === "independent" ? "independent" : "same",
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
    resolutionLabels: resolutionCapabilities.labels,
    aspectRatios: ratios.length > 0 ? ratios : ["16:9", "9:16"],
    billingUnit,
    tokenPricing,
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

function effectiveImageRatio(run: Pick<WorkbenchRun, "ratio" | "imageRatio">): WorkbenchRatio {
  return run.imageRatio ?? run.ratio;
}
function supportedImageRatios(model?: ImageModel): WorkbenchRatio[] {
  return model?.aspectRatios?.length ? WORKBENCH_RATIOS.filter(ratio => model.aspectRatios!.includes(ratio)) : [...WORKBENCH_RATIOS];
}
function supportedVideoRatios(model?: VideoModel): WorkbenchRatio[] {
  return model?.aspectRatios?.length ? WORKBENCH_RATIOS.filter(ratio => model.aspectRatios.includes(ratio)) : [...WORKBENCH_RATIOS];
}
function allowsIndependentReferenceRatio(model?: VideoModel) {
  return model?.referenceAspectRatioPolicy === "independent" && model.workflowInputMode === "flexible_image"
    && !model.requiresFirstFrame && !model.requiresLastFrame;
}

// Compare input identity while ignoring known expiring transport signatures.
function storyboardImageSubmissionInput(run: WorkbenchRun, card: WorkbenchCard) {
  return JSON.stringify({ runId: run.id, modelId: run.imageModelId, resolution: run.imageResolution,
    ratio: effectiveImageRatio(run), videoDuration: run.videoDuration, plan: run.visualAssetPlan,
    directorIntake: run.directorIntake, cardId: card.id, order: card.order, prompt: card.imagePrompt,
    narration: card.narration,
    references: card.referenceImageUrls, visualAssetRefs: card.visualAssetRefs,
    selectionMode: card.visualAssetSelectionMode, refsMode: card.visualAssetRefsMode,
  }, (_key, value) => {
    if (typeof value !== "string" || !/^https?:\/\//iu.test(value)) return value;
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:q-signature|q-sign-.+|q-ak|q-key-time|q-header-list|q-url-param-list|x-amz-.+|x-cos-.+|signature|expires|OSSAccessKeyId|GoogleAccessId)$/iu.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort(); return url.toString();
    } catch { return value; }
  });
}

function batchSettings(run: WorkbenchRun, kind: "images" | "videos") {
  return JSON.stringify(kind === "images"
    ? [run.imageModelId, run.imageResolution, effectiveImageRatio(run), run.videoDuration, run.visualAssetPlan]
    : [run.videoModelId, run.videoResolution, run.videoDuration, run.ratio, effectiveImageRatio(run), run.videoContract]);
}
function batchCardInput(card: WorkbenchCard, kind: "images" | "videos") {
  return JSON.stringify(kind === "images"
    ? [card.imagePrompt, card.referenceImageUrls, card.visualAssetRefs, card.narration]
    : [card.videoPrompt, normalizeStoryboardVideoInputs(card.videoInputs), card.imageRef, card.imageUrl, card.videoSourceImageUrl, card.imageRecordId, card.imageAssetId, card.imageStorageKey, card.imageWidth, card.imageHeight, card.imageRequestSnapshot?.aspectRatio, card.narration]);
}
function assertBatchSnapshotCurrent(run: WorkbenchRun, cardId: string, kind: "images" | "videos", authorization?: StoryboardBatchAuthorization, expectedInput?: string) {
  if (!authorization) return;
  if (authorization.isCurrent && !authorization.isCurrent()) throw new Error("连续制作已暂停或输入已改变，本段未提交。");
  const card = run.cards.find(item => item.id === cardId);
  if (!card || run.id !== authorization.runId || batchSettings(run, kind) !== authorization.settings
    || batchCardInput(card, kind) !== (expectedInput ?? authorization.inputs.get(cardId))) throw Object.assign(new Error("批量确认后的参数或参考图片已改变，本段未提交，请重新确认"), { upstreamCalled: false, billed: false, confirmedRejected: true });
}
function assertBatchAuthorization(run: WorkbenchRun, card: WorkbenchCard, kind: "images" | "videos", authorization: StoryboardBatchAuthorization | null, supplied?: StoryboardBatchAuthorization) {
  if (!authorization && !supplied) return;
  if (supplied?.isCurrent && !supplied.isCurrent()) throw new Error("连续制作已暂停或输入已改变，本段未提交。");
  if (!authorization || authorization !== supplied || authorization.kind !== kind || authorization.runId !== run.id
    || authorization.settings !== batchSettings(run, kind) || authorization.inputs.get(card.id) !== batchCardInput(card, kind)
    || authorization.started.has(card.id)) throw new Error("批量确认后的项目、模型、参数或提示词已改变，本段未提交；请等待当前批次结束后重新确认");
  authorization.started.add(card.id);
}
const MAX_HISTORY = 20;
const MAX_CARDS = 20;
const MAX_REFERENCES = 9;
const IMAGE_SUBMIT_INTERVAL_MS = 10_000;
const VIDEO_SUBMIT_INTERVAL_MS = 10_000;
const VIDEO_POLL_INTERVAL_MS = 8_000;
const H3_LIFECYCLE_POLL_INTERVAL_MS = 2_000;
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

const STORYBOARD_RECOVERY_NOTICE = "正在核对工作台恢复记录；原生成任务不会重复提交。";

function clearStoryboardRecoveryNotice(current: string) {
  return current === STORYBOARD_RECOVERY_NOTICE ? "" : current;
}

/** 批量视频收尾提示：按卡片真实状态分类；排队/渲染中不是失败，且提醒勿重复提交。 */
function summarizeVideoBatchOutcome(cards: WorkbenchCard[], cardIds: string[]) {
  let done = 0; let failed = 0; let pending = 0; let cancelled = 0; let notSubmitted = 0;
  for (const id of cardIds) {
    const status = cards.find((card) => card.id === id)?.videoStatus;
    if (status === "done") done += 1;
    else if (status === "failed") failed += 1;
    else if (status === "queued" || status === "running") pending += 1;
    else if (status === "cancelled") cancelled += 1;
    else notSubmitted += 1;
  }
  const parts = [`成功${done}个`];
  if (pending) parts.push(`${pending}个仍在生成中`);
  if (failed) parts.push(`失败${failed}个`);
  if (cancelled) parts.push(`已终止${cancelled}个`);
  if (notSubmitted) parts.push(`${notSubmitted}个未提交`);
  const suffix = pending ? "。仍在生成中的任务会在后台继续追踪，请稍后在历史里查看，勿重复提交" : "";
  return `批量视频${pending ? "已提交" : "结束"}：${parts.join("，")}${suffix}`;
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
  if (!checkedAt) return "等待首次查询";
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  return seconds < 2 ? "上次查询：刚刚" : `上次查询：${seconds} 秒前`;
}

function storyboardVideoConfirmationKey(userId: string, runId: string, card: Pick<WorkbenchCard, "id" | "videoClientRequestId">, taskId: string) {
  return [userId, runId, card.id, card.videoClientRequestId || "", taskId].join("\0");
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
    ...(snapshot.chainContext ? { chainContext: snapshot.chainContext } : {}),
    runId: snapshot.runId,
    cardId: snapshot.cardId,
    prompt: snapshot.prompt,
    modelId: snapshot.modelId,
    aspectRatio: snapshot.aspectRatio,
    resolution: snapshot.resolution,
    exactText: snapshot.exactText || "",
    referenceImageUrls: snapshot.referenceImageUrls,
    visualAssetRefs: snapshot.visualAssetRefs || [],
    ...(snapshot.presetReferences?.length ? { presetReferences: snapshot.presetReferences } : {}),
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
    && (snapshot.exactText === undefined || typeof snapshot.exactText === "string" && isRestorableImageExactText(snapshot.exactText))
    && Array.isArray(snapshot.referenceImageUrls)
    && snapshot.referenceImageUrls.every((url) => typeof url === "string" && Boolean(url.trim()))
    && (snapshot.chainContext === undefined || StoryboardChainRequestSchema.safeParse(snapshot.chainContext).success)
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

function visualAssetSelectionError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (message.startsWith("VISUAL_ASSET_REFERENCE_NOT_IN_PLAN")) return "该参考仍被分段单独选用，请先修改相关分段的参考选择，再移除项目参考。";
  if (message.startsWith("VISUAL_ASSET_SOURCE_UNRESOLVED")) return "本段选用的参考图尚未就绪或已失效，请查询原任务或选择可读取的参考图。";
  if (message.startsWith("VISUAL_ASSET_REFERENCE_LIMIT")) return "本段实际参考图超过当前模型上限，请减少本段参考选择或手工参考图。";
  if (message.startsWith("VISUAL_ASSET_MULTIPLE_DEFAULT_ENVIRONMENTS")) return "项目默认只能选择一个背景，其他背景可在分段中单独选择。";
  if (message.startsWith("VISUAL_ASSET_")) return "参考选择未通过校验，原引用已保留，请重新确认。";
  return message;
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
    visualAssetRefs: [],
    visualAssetSelectionMode: "project",
    imageStatus: "idle",
    videoStatus: "idle",
  };
}

function visualAssetPlanId(assetId: string, index = 0) {
  const compact = assetId.toLowerCase().replace(/[^a-z0-9_-]/gu, "").slice(0, 54);
  return `asset_${compact || index + 1}`.slice(0, 64);
}

function withVisualAssetCandidate(run: WorkbenchRun, candidate: DrawerVisualAsset, originalId = candidate.assetId): WorkbenchRun {
  const workspace = run.visualAssetWorkspace || { drafts: [], candidates: [] };
  const candidates = [candidate, ...workspace.candidates.filter(item => item.assetId !== originalId && item.assetId !== candidate.assetId)];
  return { ...run, updatedAt: Date.now(), visualAssetWorkspace: normalizeStoryboardVisualAssetWorkspace({
    ...workspace, drafts: workspace.drafts, candidates: candidates.map(item => ({ ...item, projectId: isReferenceSessionId(run.id) ? undefined : run.id })),
  }), visualAssetPlan: migrateSavedVisualAssetSource(run.visualAssetPlan, originalId, candidate) };
}

/** A library copy is independent of the immutable director generation receipt. */
function directorAssetExportCandidate(run: WorkbenchRun, selected: DrawerVisualAsset): DrawerVisualAsset {
  const candidate = run.visualAssetWorkspace?.candidates.find(item => item.planId === selected.planId && item.assetId === selected.assetId
    && item.role === selected.role && item.historyRecordId === selected.historyRecordId);
  if (!candidate || !/^[a-f0-9]{64}$/u.test(candidate.historyRecordId || "")
    || candidate.assetId !== `generated_${candidate.historyRecordId}` || candidate.storageKey !== undefined || selected.storageKey !== undefined
    || candidate.source === "platform-preset" || !candidate.prompt?.trim()) {
    throw new Error("这张参考的原生成来源尚未确认，请先恢复原生成图，再保存或采用；图库副本仍保留。");
  }
  // The drawer overlays editable draft text when saving. Keep the actual dispatched prompt.
  return { ...selected, ...candidate, previewUrl: selected.previewUrl };
}

function withDirectorAssetLibrarySave(run: WorkbenchRun, candidate: DrawerVisualAsset): WorkbenchRun {
  const workspace = run.visualAssetWorkspace;
  if (!workspace || !workspace.candidates.some(item => item.planId === candidate.planId && item.assetId === candidate.assetId)) {
    throw new Error("项目候选已变化，图库副本已保留，请重新读取原项目。");
  }
  return { ...run, updatedAt: Date.now(), visualAssetWorkspace: { ...workspace,
    candidates: workspace.candidates.map(item => item.planId === candidate.planId && item.assetId === candidate.assetId ? { ...item, saved: true } : item),
  } };
}

function directorLegacyAssetSlotIds(run: WorkbenchRun): string[] {
  if (run.directorIntake?.phase !== "assets") return [];
  return (run.visualAssetPlan?.assets || []).filter(asset => {
    if ((asset.role !== "character" && asset.role !== "pet") || !asset.referencePrompts.some(reference => reference.kind === "turnaround")) return false;
    const legacy = (value: { assetId: string; historyRecordId?: string; storageKey?: string }) => /^[a-f0-9]{64}$/u.test(value.historyRecordId || "")
      && (value.assetId !== `generated_${value.historyRecordId}` || value.storageKey !== undefined);
    return Boolean(asset.source?.kind === "generated-image-history" && legacy(asset.source))
      || Boolean(run.visualAssetWorkspace?.candidates.some(candidate => candidate.planId === asset.id && candidate.role === asset.role && legacy(candidate)));
  }).map(asset => asset.id);
}

function visualAssetReferenceKind(role: VisualAssetRole, cameraCoverage?: "wide" | "front" | "side" | "reverse" | "detail"): StoryboardVisualAssetRef["referenceKinds"][number] {
  if (role === "environment") return cameraCoverage && cameraCoverage !== "wide" ? "environment-angle" : "environment-wide";
  if (role === "prop") return "prop";
  return "identity";
}

function storyboardCandidateToAsset(candidate: DrawerVisualAsset, plan?: StoryboardVisualAssetPlan): StoryboardVisualAssetPlan["assets"][number] {
  return {
    id: /^[a-z][a-z0-9_-]{2,63}$/u.test(candidate.planId) ? candidate.planId : visualAssetPlanId(candidate.planId), role: candidate.role,
    name: candidate.name.slice(0, 80) || "参考资产", identityLock: `沿用${candidate.name}参考图的外观、色彩、服装、毛发、体型与关键识别特征，跨段落保持同一身份。`,
    tags: candidate.tags || [], customCategory: candidate.customCategory || "",
    ...(candidate.sceneId ? { sceneId: candidate.sceneId } : {}),
    ...(candidate.sceneZone ? { sceneZone: candidate.sceneZone } : {}),
    ...(candidate.cameraCoverage ? { cameraCoverage: candidate.cameraCoverage } : {}),
    ...(candidate.fixedAnchors?.length ? { fixedAnchors: candidate.fixedAnchors } : {}),
    ...(candidate.allowedSegmentKinds?.length ? { allowedSegmentKinds: candidate.allowedSegmentKinds } : {}),
    ...(candidate.derivedFromAssetId ? { derivedFromAssetId: candidate.derivedFromAssetId } : {}),
    allowedChanges: ["姿态", "表情", "镜头位置"], referencePrompts: [{ kind: visualAssetReferenceKind(candidate.role, candidate.cameraCoverage), purpose: `保持${candidate.name}跨镜头一致`, prompt: candidate.prompt?.length && candidate.prompt.length >= 20 ? candidate.prompt.slice(0, 2400) : `以${candidate.name}参考图为固定身份，保持外观、色彩、服装、毛发、体型与关键识别特征一致。` }],
    ...plan?.assets.find(asset => asset.id === candidate.planId),
    derivedFromAssetId: candidate.derivedFromAssetId,
    source: { kind: candidate.source === "platform-preset" ? "platform-preset" : "generated-image-history", assetId: candidate.assetId,
      ...(candidate.source === "platform-preset" ? { presetId: candidate.presetId, presetRevision: candidate.presetRevision } : { historyRecordId: candidate.historyRecordId, storageKey: candidate.storageKey }),
      librarySaved: candidate.saved, modelId: candidate.modelId, modelName: candidate.modelName, quotedPrice: candidate.quotedPrice, createdAt: candidate.createdAt },
  };
}

function visualAssetRoleLabel(role: VisualAssetRole) {
  return role === "character" ? "人物" : role === "pet" ? "宠物" : role === "environment" ? "场景" : "道具";
}

function storyboardIdentityAssetLabel(plan?: StoryboardVisualAssetPlan) {
  const roles = [...new Set((plan?.assets || [])
    .filter(asset => asset.role === "character" || asset.role === "pet")
    .map(asset => visualAssetRoleLabel(asset.role)))];
  return roles.length ? `${roles.join("、")}三视图` : "角色三视图";
}

async function browserImageReady(url: string, timeoutMs = 30_000) {
  const original = await readStoryboardProtectedPreview(url, { timeoutMs: Math.min(timeoutMs, 20_000) });
  const preview = original ? URL.createObjectURL(original) : url;
  try { return await new Promise<{ width: number; height: number }>((resolve, reject) => {
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
    image.src = preview;
  }); } finally { if (original) URL.revokeObjectURL(preview); }
}

function hasValidatedImage(card: WorkbenchCard) {
  return !card.imageMediaState && card.imageStatus === "done" && Boolean(card.imageUrl) && Boolean(card.imageValidatedAt);
}

/** Cloud hydrate can preserve done/receipt IDs while explicitly rejecting media. */
function isStoryboardChainHydratedReadback(card: WorkbenchCard | undefined, owned: boolean) {
  if (!card || card.imageError || card.imageRetryBlocked || card.imageMediaState) return false;
  // An inline original can still live only in this browser before owned export.
  if (!owned) return true;
  const url = typeof card.imageUrl === "string" ? card.imageUrl.trim() : "";
  if (!url || card.imageRecoveryReady || card.imageReferenceState === "stale"
    || (!/^https?:\/\//iu.test(url) && !(url.startsWith("/") && !url.startsWith("//")))) return false;
  try { return ["http:", "https:"].includes(new URL(url, "https://storyboard.invalid").protocol); }
  catch { return false; }
}

/** A recovered/provider image can be visible before the browser has decoded it.
 * Keep this state separate from the safety gate: video submission still relies
 * on hasValidatedImage, while the UI explains why the button is temporarily
 * locked and automatically becomes actionable when validation patches the card.
 */
function isImageValidationPending(card: WorkbenchCard) {
  return card.imageStatus === "done"
    && Boolean(card.imageUrl)
    && !card.imageStorageKey
    && !card.imageValidatedAt
    && card.imageDeliveryMode !== "inline_ephemeral";
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
  if (isCompletedInlineImageReceipt(card) || isUnavailableCompletedStoryboardImage(card)) return false;
  return card.imageStatus === "running"
    || card.imageStatus === "queued"
    || card.imageRecoveryReady === true
    || card.imageRetryBlocked === true;
}

function storyboardCardVideoInputIssue(model: VideoModel | undefined, card: WorkbenchCard, run: WorkbenchRun) {
  if (!model) return "视频模型尚未加载";
  const resolved = resolveStoryboardAutomaticVideoInputs(model, card);
  if (!resolved.isStoryboardImageWorkflow && resolved.issue) return resolved.issue;
  if (resolveStoryboardExecutionMode(run) !== "ordinary" && !isStoryboardImageWorkflow(model)) return "当前模型无法使用本段分镜图保持参考一致，请选择单图视频模型或切换普通模式。";
  if (resolved.usesStoryboardImage || resolved.requiresStoryboardImage) {
    if (card.imageReferenceState === "stale") return "参考已更换，请先重新生成分镜；旧图和旧视频仍保留。";
    if (!hasValidatedImage(card)) return isImageValidationPending(card) ? "正在加载/验证本段分镜图，验证完成后将自动解锁视频。" : imageAttemptNeedsResolution(card) ? "原分镜请求或费用尚未确认，请先查询原任务。" : "请先生成并加载本段分镜图。";
    if (card.imageDeliveryMode === "inline_ephemeral") return "请先保存本段分镜图，再生成视频。";
    const ratioIssue = storyboardImageRatioIssue(card, effectiveImageRatio(run), run.ratio, model);
    if (ratioIssue) return ratioIssue;
  }
  return resolved.issue;
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
    wardrobePlan: undefined,
    visualAssetPlan: { mode: "off", assets: [] },
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

function storyboardProjectSnapshotMatches(run: WorkbenchRun, confirmed: string): boolean {
  try {
    return confirmed === run.id + ":" + JSON.stringify(createStoryboardPersistenceSnapshot(run));
  } catch {
    // Keep an oversized editable draft visible; saving reports validation errors.
    return false;
  }
}

function isUnsubmittedReferencePreflightFailure(card: Partial<WorkbenchCard>): boolean {
  if (card.imageStatus !== "failed" || card.videoStatus !== "idle"
    || card.imageRetryBlocked !== false || card.imageRecoveryReady !== false
    || !/^参考尚未落实或已失效：[^\r\n]+。请在视觉资产中确认图片；本次未提交生图$/u.test(String(card.imageError || ""))) return false;
  // Recover only the proven local preflight label. Any task, media, receipt,
  // billing or unrecognized legacy field keeps its original state, even 0/null.
  const inputFields = new Set([
    "id", "order", "sourceNumber", "label", "narration", "imagePrompt", "imageExactText", "imageTextLayoutEnabled", "imageAnnotationIssue",
    "videoPrompt", "referenceImageUrls", "visualAssetRefs", "visualAssetRefsMode", "visualAssetSelectionMode",
    "sceneId", "sceneZone", "styleLock", "sceneLock", "camera", "dynamicState", "capabilityGaps",
    "bottomPanelRole", "qualityChecks", "wardrobeChangeEvents",
    "imageStatus", "imageError", "imageRecoveryReady", "imageRetryBlocked", "videoStatus",
  ]);
  if (Object.entries(card).some(([key, value]) => value !== undefined && !inputFields.has(key))) return false;
  if (!Array.isArray(card.referenceImageUrls) || card.referenceImageUrls.length > 0) return false;
  if (!Array.isArray(card.visualAssetRefs) || card.visualAssetRefs.some((ref) =>
    !ref || typeof ref !== "object"
    || Object.entries(ref).some(([key, value]) => value !== undefined && !["assetId", "role", "referenceKinds"].includes(key))
  )) return false;
  return true;
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
        sceneId: typeof segment.sceneId === "string" ? segment.sceneId : undefined,
        sceneZone: typeof segment.sceneZone === "string" ? segment.sceneZone : undefined,
        styleLock: typeof segment.styleLock === "string" ? segment.styleLock : undefined,
        sceneLock: typeof segment.sceneLock === "string" ? segment.sceneLock : undefined,
        camera: typeof segment.camera === "string" ? segment.camera : undefined,
        dynamicState: Array.isArray(segment.dynamicState) ? segment.dynamicState.filter((item): item is string => typeof item === "string").slice(0, 16) : [],
        capabilityGaps: Array.isArray(segment.capabilityGaps) ? segment.capabilityGaps.filter((item): item is string => typeof item === "string").slice(0, 16) : [],
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
    executionMode: resolveStoryboardExecutionMode(record as WorkbenchRun),
    chainRevision: (record as WorkbenchRun).chainRevision || 1,
    createdAt: Number(record.createdAt || Date.now()),
    updatedAt: Number(record.updatedAt || Date.now()),
    lastSubmittedAt: submissionTimes.length ? Math.max(...submissionTimes) : undefined,
    ratio: selectedContract?.ratio || (isWorkbenchRatio(record.ratio) ? record.ratio : "16:9"),
    ...(isWorkbenchRatio(record.imageRatio) ? { imageRatio: record.imageRatio } : {}),
    imageResolution: String(record.imageResolution || ""),
    videoResolution: selectedContract?.resolution || String(record.videoResolution || ""),
    videoDuration: selectedContract?.duration || Number(record.videoDuration) || 10,
    imageModelId: String(record.imageModelId || ""),
    videoModelId,
    videoContract,
    draftImportNotice: typeof (record as Partial<WorkbenchRun>).draftImportNotice === "string" ? (record as Partial<WorkbenchRun>).draftImportNotice : undefined,
    directorIntake: record.directorIntake === undefined ? undefined : StoryboardDirectorIntakeStateSchema.parse(record.directorIntake),
    wardrobePlan: (() => {
      const candidate = (record as Partial<WorkbenchRun>).wardrobePlan;
      if (!candidate || typeof candidate !== "object") return undefined;
      const parsed = StoryboardWardrobePlanSchema.safeParse(candidate);
      return parsed.success ? parsed.data : undefined;
    })(),
    visualAssetWorkspace: normalizeStoryboardVisualAssetWorkspace(record.visualAssetWorkspace),
    environmentGroups: Array.isArray((record as Partial<WorkbenchRun>).environmentGroups)
      ? (record as Partial<WorkbenchRun>).environmentGroups!.slice(0, 24)
      : [],
    visualAssetPlan: record.visualAssetPlan && typeof record.visualAssetPlan === "object"
      ? record.visualAssetPlan as StoryboardVisualAssetPlan
      : { mode: "off", assets: [] },
    cards: cards.map((card, index) => ({
      ...card,
      imageStatus: isUnsubmittedReferencePreflightFailure(card) ? "idle" : card.imageStatus,
      order: index + 1,
      narration: String(card.narration || inferStoryboardNarration(card.label)),
      imageError: normalizeLegacyImageError(card.imageError, (card as Partial<WorkbenchCard>).imageRecoveryReady === true),
      referenceImageUrls: Array.isArray(card.referenceImageUrls) ? card.referenceImageUrls.slice(0, MAX_REFERENCES) : [],
        visualAssetRefs: Array.isArray((card as Partial<WorkbenchCard>).visualAssetRefs)
        ? (card as Partial<WorkbenchCard>).visualAssetRefs!.slice(0, 16)
        : [],
      visualAssetRefsMode: (card as Partial<WorkbenchCard>).visualAssetRefsMode === "explicit"
        || (typeof (card as Partial<WorkbenchCard>).visualAssetRefsMode !== "string" && Array.isArray((card as Partial<WorkbenchCard>).visualAssetRefs))
        ? "explicit" : "legacy",
      sceneId: typeof (card as Partial<WorkbenchCard>).sceneId === "string" ? (card as Partial<WorkbenchCard>).sceneId : undefined,
      sceneZone: typeof (card as Partial<WorkbenchCard>).sceneZone === "string" ? (card as Partial<WorkbenchCard>).sceneZone : undefined,
      styleLock: typeof (card as Partial<WorkbenchCard>).styleLock === "string" ? (card as Partial<WorkbenchCard>).styleLock : undefined,
      sceneLock: typeof (card as Partial<WorkbenchCard>).sceneLock === "string" ? (card as Partial<WorkbenchCard>).sceneLock : undefined,
      camera: typeof (card as Partial<WorkbenchCard>).camera === "string" ? (card as Partial<WorkbenchCard>).camera : undefined,
      dynamicState: Array.isArray((card as Partial<WorkbenchCard>).dynamicState) ? (card as Partial<WorkbenchCard>).dynamicState!.slice(0, 16) : [],
      capabilityGaps: Array.isArray((card as Partial<WorkbenchCard>).capabilityGaps) ? (card as Partial<WorkbenchCard>).capabilityGaps!.slice(0, 16) : [],
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
  clientRequestId?: string;
  processingStage?: string;
  taskLabel?: string;
  modelId?: string;
  publicModelId?: string;
  modelName?: string;
  prompt?: string;
  firstFrameUrl?: string;
  thumbnailUrl?: string;
  deliveryState?: "saving" | "saved" | "failed" | "expired";
  retainedUntil?: string;
  mediaAvailable?: boolean;
  createdAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  supportsRemoteCancel?: boolean;
  status?: string;
  videoUrl?: string;
  storageUrl?: string;
  resolution?: string;
  aspectRatio?: string;
  errorMessage?: string;
  batchId?: string;
  batchTopic?: string;
  cardIndex?: number;
  canRetry?: boolean;
  billingState?: string;
  priceCharged?: number;
  progress?: number;
  statusDetail?: string;
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

function cardStatus(card: WorkbenchCard): { label: string; status: TaskStatus } {
  if (card.videoStatus === "running" || card.videoStatus === "queued") return { label: card.videoStatus === "queued" ? "视频排队中" : "视频生成中", status: card.videoStatus };
  if (card.videoStatus === "done") return { label: "视频完成", status: "done" };
  if (card.videoStatus === "failed") return { label: "视频失败", status: "failed" };
  if (card.videoStatus === "cancelled") return { label: "视频已终止", status: "cancelled" };
  if (card.imageStatus === "running" || card.imageStatus === "queued") return { label: card.imageStatus === "queued" ? "生图排队中" : "生图中", status: card.imageStatus };
  if (isUnavailableCompletedInlineImage(card)) return { label: "已完成·临时图片不可恢复", status: "done" };
  const unavailable = storyboardImageUnavailablePresentation(card);
  if (unavailable) return { label: unavailable.label, status: "done" };
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
  if (/^[A-Z][A-Z0-9]*$/u.test(label)) return label;
  return "";
}

// Benchmark pattern: the title carries series + version + one differentiator.
// Resolution is kept only when the model has no mode keyword, otherwise the
// mode wins and the resolution stays on the meta line.
const VIDEO_MODEL_TITLE_NOISE = /^(?:\d+\s*秒|\d+\s*[–—-]\s*\d+\s*秒|固定\s*\d+\s*秒|Flow\s*\d+|分组\s*\d+|企业渠道\s*\d+)$/u;
const VIDEO_MODEL_TITLE_SPEC = /^(?:\d{3,4}\s*[pP](?:\s*\/\s*\d{3,4}\s*[pP])?|[1248]\s*[kK])$/u;
const VIDEO_MODEL_TITLE_MODE = /多图|参考|首尾帧|文生视频|图生视频|全能|Token|企业|数字人|音频/iu;

function compactVideoModelName(model: VideoModel) {
  const publicName = publicModelName(model);
  if (/\bveo\s*3\.1\b/iu.test(publicName)) {
    const edition = /\bFast\b/iu.test(publicName) ? "Fast"
      : /\bLite\b/iu.test(publicName) ? "Lite"
      : /质量/u.test(publicName) ? "质量" : "";
    // Keep publicly stated optional-frame semantics; requirements alone cannot
    // distinguish optional tail frames from ordinary multi-image references.
    const mode = /首帧[，,、\s]*尾帧可选/u.test(publicName) ? "首帧，尾帧可选"
      : model.requiresFirstFrame && model.requiresLastFrame ? "首尾帧"
      : model.workflowInputMode === "text" ? "文生视频"
      : model.requiresFirstFrame ? "图生视频"
      : model.workflowInputMode === "multi_image" && model.maxReferenceImages > 1 ? "多图参考"
      : model.requiresImage ? "图生视频"
      : model.workflowInputMode === "flexible_image" ? "文/图生视频" : "";
    return ["Veo 3.1", edition, mode].filter(Boolean).join(" · ");
  }
  const base = compactPublicVideoModelName(publicName);
  const segments = base.split("·").map((segment) => segment.trim()).filter(Boolean);
  const hasMode = segments.slice(1).some((segment) => VIDEO_MODEL_TITLE_MODE.test(segment));
  const kept = segments.filter((segment, index) => {
    if (index === 0) return true;
    if (VIDEO_MODEL_TITLE_NOISE.test(segment)) return false;
    if (VIDEO_MODEL_TITLE_SPEC.test(segment)) return !hasMode;
    return true;
  });
  return kept.join(" · ")
    .replace(/Grok\s+Imagine\s+Video/iu, "Grok Video")
    .replace(/Grok\s+Imagine/iu, "Grok")
    .replace(/\s{2,}/gu, " ")
    .trim() || "视频模型";
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
  return channelCode ? `${compactName} · 渠道${channelCode}` : compactName;
}

function storyboardImageRatioIssue(card: WorkbenchCard, imageRatio: WorkbenchRatio, videoRatio: WorkbenchRatio = imageRatio, model?: VideoModel) {
  const generatedRatio = card.imageRequestSnapshot?.aspectRatio || imageRatio;
  if (hasValidatedImage(card) && card.imageWidth && card.imageHeight
    && !imageDimensionsMatchAspectRatio(card.imageWidth, card.imageHeight, generatedRatio)) {
    return `实际图片 ${card.imageWidth}×${card.imageHeight} 与生成比例 ${generatedRatio} 不一致；请重新生图后再提交视频`;
  }
  if (!hasValidatedImage(card) || generatedRatio === videoRatio || allowsIndependentReferenceRatio(model)
    || resolveAiVideoInputAspectRatio(model, videoRatio, { imageUrl: card.imageUrl }) === "adaptive") return "";
  return `当前故事板为 ${generatedRatio}，所选视频模型要求参考图与视频 ${videoRatio} 同比例；请选择兼容模型或重新生图`;
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
  const response = await fetch(ticketUrl, { cache: "no-store", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `视频下载失败（${response.status}），请稍后重试`);
  }
  const file = videoDownloadFile(filename, response.headers.get("content-type") || "");
  const blob = await response.blob();
  if (!blob.size) throw new Error("视频文件为空，请重新加载后下载");
  const blobUrl = URL.createObjectURL(blob);
  try { triggerDownload(blobUrl, file.name); }
  finally { window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000); }
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
  if (model.billingUnit === "token") return Number.NaN;
  const unitPrice = effectiveVideoPrice(model, requested);
  return model.billingUnit === "output_second"
    ? unitPrice * effectiveVideoDuration(model, duration)
    : unitPrice;
}

function videoResolutionPriceLabel(model: VideoModel, resolution: string, duration: number) {
  if (model.billingUnit === "token") return videoTokenRateLabel(model, resolution);
  const charge = effectiveVideoCharge(model, resolution, duration);
  if (!model.priceReady || !Number.isFinite(charge)) return "价格待配置";
  return `¥${charge.toFixed(2)}${model.billingUnit === "output_second" ? `/${duration}秒` : "/次"}`;
}

function videoResolutionDisplayLabel(model: VideoModel | undefined, resolution: string) {
  if (model?.generationReady === false) return "";
  return model?.resolutionLabels?.[resolution] || resolution || "模型默认画质";
}

function submittedVideoPrompt(prompt: string, model?: VideoModel, requestedDuration?: number) {
  const duration = effectiveVideoDuration(model, requestedDuration);
  return buildStoryboardVideoPrompt({ prompt, duration });
}

export function StoryboardWorkbench({ view = "workbench", historyPage = false, compactEditor = false }: { view?: "workbench" | "visual-assets"; historyPage?: boolean; compactEditor?: boolean }) {
  const params = useSearchParams();
  const requestedProjectId = params.get("projectId")?.trim() || "";
  const requestedSlotId = params.get("slotId")?.trim() || "";
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div><SubPageHeader title="分镜工作台" subtitle="请先登录后查看自己的草稿和历史" /><p role="status" className="p-6 text-sm text-[var(--muted-foreground)]">正在确认登录状态；如未登录，请先登录。</p></div>;
  return <UserStoryboardWorkbench
    key={view === "workbench" ? `${identity.userId}:${identity.token}:workbench:${requestedProjectId}` : `${identity.userId}:${identity.token}:${view}:${requestedProjectId}:${requestedSlotId}`}
    identity={identity}
    view={view}
    historyPage={historyPage}
    compactEditor={compactEditor}
    requestedProjectId={requestedProjectId}
    requestedSlotId={requestedSlotId}
    showAdminModelIds={false}
  />;
}

function UserStoryboardWorkbench({
  identity,
  showAdminModelIds,
  view,
  historyPage,
  compactEditor,
  requestedProjectId: requestedEntryProjectId,
  requestedSlotId,
}: {
  identity: WorkbenchIdentity;
  showAdminModelIds: boolean;
  view: "workbench" | "visual-assets";
  historyPage: boolean;
  compactEditor: boolean;
  requestedProjectId: string;
  requestedSlotId: string;
}) {
  const [freshWorkspace, setFreshWorkspace] = useState(false);
  const requestedProjectId = freshWorkspace ? "" : requestedEntryProjectId;
  const { token, userId } = identity;
  const initialReferenceBlockedRef = useRef(new Set<string>());
  const initialReferenceAdoptionRef = useRef(false);
  const [tokenChargeConsent, setTokenChargeConsent] = useState<{ modelId: string; priceVersion: string; amount: string } | null>(null);
  const tokenChargeConsentRef = useRef(tokenChargeConsent);
  tokenChargeConsentRef.current = tokenChargeConsent;
  const router = useRouter();
  const referenceOnly = view === "visual-assets" && !requestedProjectId;
  const referenceContextRef = useRef<ReferenceWorkspace | null>(null);
  const restoredReferenceContextsRef = useRef(new WeakMap<WorkbenchRun, ReferenceWorkspace>());
  const [projectContext, setProjectContext] = useState<"loading" | "ready" | "error" | "browse">(requestedProjectId || referenceOnly || view === "workbench" ? "loading" : "ready");
  const contextReadyRef = useRef(false);
  const [projectContextError, setProjectContextError] = useState("");
  const [navigating, setNavigating] = useState(false);
  const navigationRef = useRef(false);
  const recoveryKeyRef = useRef("");
  const initialProjectIdRef = useRef(requestedProjectId);
  const initialRecoveryRef = useRef<{ run: WorkbenchRun; baseContentFingerprint: string } | null>(null);
  const [recoveryProjectId, setRecoveryProjectId] = useState("");
  const [projectRestoreAttempt, setProjectRestoreAttempt] = useState(0);
  const [recoveryConflictDraft, setRecoveryConflictDraft] = useState<WorkbenchRun | null>(null);
  const [recoveryExtraDraft, setRecoveryExtraDraft] = useState<WorkbenchRun | null>(null);
  const [savedRecoveryDrafts, setSavedRecoveryDrafts] = useState<Array<{ key: string; run: WorkbenchRun }>>([]);
  const [canDiscardRecovery, setCanDiscardRecovery] = useState(false);
  const projectRestoreGenerationRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const discardedRecoveryRunIdsRef = useRef(new Set<string>());
  const previousHistoryPageRef = useRef(historyPage);
  const explicitHistorySelectionRef = useRef(false);
  const recoveryOverwriteBlockedRef = useRef(false);
  const projectToRestore = requestedProjectId || recoveryProjectId;
  const confirmedRecoveryBaseRef = useRef("");
  const [recoveryReadReady, setRecoveryReadReady] = useState(false);
  const cloud = useStoryboardProjects<WorkbenchRun>(userId, token);
  const lastProjectSaveAtRef = useRef(new Map<string, number>());
  const projectAutosaveRef = useRef<{ timer: number; runId: string; owner: string; dueAt: number } | null>(null);
  const [confirmedProjectSnapshot, setConfirmedProjectSnapshot] = useState("");
  const cloudReady = cloud.ready;
  const [run, setRun] = useState<WorkbenchRun>(() => createRun());
  const [referenceDisplayMode, setReferenceDisplayMode] = useState<"normal" | "reference" | "chained">("normal");
  const referenceDisplayContextRef = useRef("");
  const referenceUploadOperationRef = useRef<string | null>(null);
  const [referenceUploadPending, setReferenceUploadPending] = useState<ReferenceUploadPending[]>([]);
  const referenceUploadPendingRef = useRef<ReferenceUploadPending[]>([]);
  const [history, setHistory] = useState<WorkbenchRun[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [imageModelCatalogState, setImageModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [videoModelCatalogState, setVideoModelCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [modelCatalogReloadKey, setModelCatalogReloadKey] = useState(0);
  const [batchMode, setBatchMode] = useState<BatchMode>("");
  const [videoBatchOutcome, setVideoBatchOutcome] = useState<{ workspaceGeneration: number; runId: string; owner: string; cardIds: string[] } | null>(null);
  const batchAuthorizationRef = useRef<StoryboardBatchAuthorization | null>(null);
  const continuousAuthorizationRef = useRef<ContinuousProductionAuthorization | null>(null);
  const continuousBusyRef = useRef(false);
  const chainAuthorizationRef = useRef<{ runId: string; fingerprint: string; owner: string; price: number } | null>(null);
  const chainBusyRef = useRef(false);
  const chainStartBusyRef = useRef(false);
  const chainAnchorSavingRef = useRef(false);
  const [chainStatus, setChainStatus] = useState<"idle" | "running" | "waiting" | "stopped" | "done">("idle");
  const [continuousStatus, setContinuousStatus] = useState<ContinuousProductionStatus>("idle");
  const [continuousMessage, setContinuousMessage] = useState("");
  const videoBatchPreflightRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [historyNavigationIssue, setHistoryNavigationIssue] = useState<{ open: boolean } | null>(null);
  const historyNavigationTimerRef = useRef<number | null>(null);
  const historyOpen = historyPage;
  useEffect(() => {
    if (historyNavigationTimerRef.current !== null) window.clearTimeout(historyNavigationTimerRef.current);
    historyNavigationTimerRef.current = null;
    setHistoryNavigationIssue(null);
    return () => {
      if (historyNavigationTimerRef.current !== null) window.clearTimeout(historyNavigationTimerRef.current);
      historyNavigationTimerRef.current = null;
    };
  }, [historyPage]);
  const setHistoryOpen = (open: boolean) => {
    const projectId = requestedProjectId;
    const destinationPath = `/storyboard-workbench${open ? "/history" : ""}`;
    const destination = `${destinationPath}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`;
    if (historyNavigationTimerRef.current !== null) window.clearTimeout(historyNavigationTimerRef.current);
    setHistoryNavigationIssue(null);
    try {
      router.push(destination, { scroll: false });
      // Never hard-navigate: doing so unloads unsaved drafts and running tasks.
      // If the SPA transition stalls, leave the workspace intact and allow retry.
      historyNavigationTimerRef.current = window.setTimeout(() => {
        historyNavigationTimerRef.current = null;
        if (window.location.pathname !== destinationPath) setHistoryNavigationIssue({ open });
      }, 3_000);
    } catch {
      setHistoryNavigationIssue({ open });
    }
  };
  const [, setVideoHistoryTasks] = useState<HistoryVideoTask[]>([]);
  const [videoHistoryLoading, setVideoHistoryLoading] = useState(false);
  const [videoHistoryError, setVideoHistoryError] = useState("");
  const [, setVideoHistoryNextOffset] = useState<number | null>(null);
  const videoHistoryAbortRef = useRef<AbortController | null>(null);
  const videoHistorySequenceRef = useRef(0);
  const videoHistoryWindowRef = useRef(100);
  const videoHistoryIdentityRef = useRef("");
  videoHistoryIdentityRef.current = `${userId}\0${token}`;
  const [imageFailureHistory, setImageFailureHistory] = useState<StoryboardImageFailureRecord[]>([]);
  const [imageFailureHistoryLoading, setImageFailureHistoryLoading] = useState(false);
  const [imageFailureHistoryError, setImageFailureHistoryError] = useState("");
  const [imageFailureHistoryNextPage, setImageFailureHistoryNextPage] = useState<number | null>(null);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [uploadingCardId, setUploadingCardId] = useState("");
  const visibleReferenceChoicesRef = useRef<{ owner: string; projectId: string; ids: Record<string, string> } | null>(null);
  const rememberVisibleReferenceChoices = useCallback((projectId: string, ids: Record<string, string>) => {
    visibleReferenceChoicesRef.current = { owner: userId + "\0" + token, projectId, ids };
  }, [userId, token]);
  const [visualAssetLoading, setVisualAssetLoading] = useState(false);
  const [visualAssetError, setVisualAssetError] = useState("");
  const [visualAssetCandidates, setVisualAssetCandidates] = useState<OwnedVisualAsset[]>([]);
  const [resolvedVisualAssetPlan, setResolvedVisualAssetPlan] = useState<{ projectId: string; plan: StoryboardVisualAssetPlan; urls: VisualAssetUrl[] } | null>(null);
  const [presetAssets, setPresetAssets] = useState<DrawerVisualAsset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const visualAssetBatchRef = useRef<VisualAssetBatchAuthorization | null>(null);
  const [visualAssetGenerating, setVisualAssetGenerating] = useState(false);
  const [visualAssetSaving, setVisualAssetSaving] = useState(false);
  const [visualAssetRecoveryRevision, setVisualAssetRecoveryRevision] = useState(0);
  const visualAssetMutationRef = useRef(false);
  const visualAssetGenerationRef = useRef<boolean | symbol>(false);
  const [pendingAssetAttempts, setPendingAssetAttempts] = useState<StoryboardAssetAttempt[]>([]);
  const explicitlyExportedAssetsRef = useRef(new Map<string, DrawerVisualAsset>());
  const [visualAssetNextOffset, setVisualAssetNextOffset] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [generalScriptHandoff, setGeneralScriptHandoff] = useState<GeneralScriptHandoffPanelState>({ status: "hidden" });
  const [generalScriptImportedRunId, setGeneralScriptImportedRunId] = useState("");
  const [agentHandoff, setAgentHandoff] = useState<AgentHandoffPanelState>({ status: "hidden" });
  const agentHandoffConsumedRef = useRef(false);
  const agentImportBusyRef = useRef(false);
  const automaticAgentImportRef = useRef("");
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
  const imageStatusChecksRef = useRef(new Map<string, symbol>());
  const imageInspectionVersionsRef = useRef(new Map<string, symbol>());
  const imageSubmissionsRef = useRef(new Set<string>());
  const imageSubmissionOperationsRef = useRef(new Map<string, symbol>());
  const boardExportLocksRef = useRef(new Set<string>());
  const boardExportHeldUrlsRef = useRef(new Set<string>());
  const boardExportCacheRef = useRef(new Map<string, { assetId: string; storageKey: string }>());
  const [exportingBoardIds, setExportingBoardIds] = useState<Set<string>>(new Set());
  const imageAutoResumeAttemptsRef = useRef(new Map<string, number>());
  const imageAutoResumeTimersRef = useRef(new Map<string, number>());
  const videoSubmissionsRef = useRef(new Set<string>());
  const videoSubmissionOperationsRef = useRef(new Map<string, symbol>());
  const [preparingVideoIds, setPreparingVideoIds] = useState<Set<string>>(new Set());
  // Submitted runs stay in history; reopening the editor does not restore a draft.
  const submittedRunIdsRef = useRef(new Set<string>());
  const videoHistoryHydratedRef = useRef(false);
  const uploadInputsRef = useRef<Record<string, HTMLInputElement | null>>({});
  const videoSectionsRef = useRef<Record<string, HTMLElement | null>>({});
  const scopeMountedRef = useRef(true);
  const ephemeralImageUrlsRef = useRef(new Set<string>());
  const originalBoardBlobsRef = useRef(new Map<string, StoryboardBoardBlob>());
  const imageDownloadOwnerRef = useRef(userId + "\0" + token);
  imageDownloadOwnerRef.current = userId + "\0" + token;
  const [videoConfirmationTasks, setVideoConfirmationTasks] = useState(() => new Map<string, boolean>());
  const rememberVideoConfirmation = useCallback((runId: string, cardId: string, taskId: string, data: Parameters<typeof updateVideoConfirmationMap>[2], clientRequestId: string | undefined) => {
    const owner = userId + "\0" + token;
    const card = runRef.current.cards.find(item => item.id === cardId);
    if (!taskId || !card || runRef.current.id !== runId || imageDownloadOwnerRef.current !== owner || card.videoClientRequestId !== clientRequestId
      || card.videoTaskId && card.videoTaskId !== taskId) return;
    const key = storyboardVideoConfirmationKey(userId, runId, card, taskId);
    setVideoConfirmationTasks(current => {
      const latest = runRef.current.cards.find(item => item.id === cardId);
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== owner || runRef.current.id !== runId
        || !latest || latest.videoClientRequestId !== clientRequestId || latest.videoTaskId && latest.videoTaskId !== taskId) return current;
      return updateVideoConfirmationMap(current, key, data);
    });
  }, [token, userId]);
  useEffect(() => { setVideoConfirmationTasks(new Map()); }, [userId, token, run.id]);
  const localVideoCacheRef = useRef<VideoLocalAutoCache | null>(null);
  const localVideoCacheScopeRef = useRef("");
  const localVideoIdsUserRef = useRef("");
  // IDs are accepted only from explicit business_task_id/businessTaskId fields.
  // A restored card or a provider task_id alone is not proof of internal ID.
  const localVideoInternalIdsRef = useRef(new Set<string>());
  const localVideoPendingIdsRef = useRef(new Set<string>());
  const queueLocalStoryboardVideo = useCallback((cache: VideoLocalAutoCache, taskId: string, owner: string) => {
    localVideoPendingIdsRef.current.add(taskId);
    void cache.enqueue(taskId).then(result => {
      if (localVideoCacheRef.current !== cache || !scopeMountedRef.current || imageDownloadOwnerRef.current !== owner) return;
      localVideoPendingIdsRef.current.delete(taskId);
      if (result.state === "failed" || result.state === "queue_full" || result.state === "unavailable" || result.state === "invalid" || result.state === "not_ready" || result.state === "expired") {
        setNotice("视频已完成，但本机副本未保存；请下载视频保存。");
      }
    });
  }, []);
  useLayoutEffect(() => {
    // A token refresh retains the same user's authoritative business IDs;
    // switching users must clear them before any new session can enqueue.
    if (localVideoIdsUserRef.current !== userId) {
      localVideoInternalIdsRef.current.clear();
      localVideoPendingIdsRef.current.clear();
      localVideoIdsUserRef.current = userId;
    }
    if (!userId || !token) return;
    let cache: VideoLocalAutoCache;
    try {
      cache = new VideoLocalAutoCache({ userId, token, surface: "storyboard-workbench",
        onRemovalSyncFailure: () => { if (scopeMountedRef.current && imageDownloadOwnerRef.current === userId + "\0" + token) setNotice("视频历史已移除，但本机副本清理未完成，请检查浏览器存储。"); },
      });
    } catch {
      localVideoCacheRef.current = null;
      localVideoCacheScopeRef.current = "";
      return;
    }
    localVideoCacheRef.current = cache;
    localVideoCacheScopeRef.current = userId + "\0" + token;
    // If token rotation cancelled a save already in progress, retry only the
    // previously requested completed IDs, not every running task.
    for (const taskId of localVideoPendingIdsRef.current) {
      queueLocalStoryboardVideo(cache, taskId, localVideoCacheScopeRef.current);
    }
    return () => {
      if (localVideoCacheRef.current === cache) {
        localVideoCacheRef.current = null;
        localVideoCacheScopeRef.current = "";
      }
      cache.dispose();
    };
  }, [userId, token, queueLocalStoryboardVideo]);
  const cacheCompletedStoryboardVideo = useCallback((taskId: string) => {
    const owner = userId + "\0" + token;
    if (!taskId || !localVideoInternalIdsRef.current.has(taskId) || imageDownloadOwnerRef.current !== owner) return;
    const cache = localVideoCacheRef.current;
    if (!cache || localVideoCacheScopeRef.current !== owner) {
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === userId + "\0" + token) setNotice("视频已完成，但浏览器本机缓存不可用；请下载保存。");
      return;
    }
    queueLocalStoryboardVideo(cache, taskId, owner);
  }, [userId, token, queueLocalStoryboardVideo]);
  const saveStoryboardProject = useCallback(async (document: WorkbenchRun, manual = false, forReferenceAdoption = false) => {
    if (!contextReadyRef.current) return false;
    const workspaceGeneration = workspaceGenerationRef.current;
    const canSave = () => workspaceGeneration === workspaceGenerationRef.current
      && !initialReferenceBlockedRef.current.has(userId + "\0" + token + "\0" + document.id)
      && (!initialReferenceAdoptionRef.current || forReferenceAdoption);
    if (!canSave()) return false;
    if (isReferenceSessionId(document.id)) throw new Error("独立参考制作不是分镜项目，未写入项目库。");
    const recoveryOwner = userId + "\0" + token;
    const recoveryGeneration = projectRestoreGenerationRef.current;
    const saved = await cloud.save(document, manual, canSave);
    if (saved && scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && imageDownloadOwnerRef.current === recoveryOwner && runRef.current.id === document.id
      && projectRestoreGenerationRef.current === recoveryGeneration) {
      confirmedRecoveryBaseRef.current = storyboardRecoveryContentFingerprint(document);
      lastProjectSaveAtRef.current.set(document.id, Date.now());
      setConfirmedProjectSnapshot(document.id + ":" + JSON.stringify(document));
    }
    return saved;
  }, [cloud.save, token, userId]);
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
    let active = true;
    const workspaceGeneration = workspaceGenerationRef.current;
    if (view !== "workbench") { setRecoveryReadReady(true); if (!requestedProjectId) setStorageReady(true); return; }
    // A session digest scopes recovery without storing the credential itself.
    void storyboardRecoveryStorageKey(userId, token).then(key => {
      if (!active) return;
      recoveryKeyRef.current = key;
      if (discardedRecoveryRunIdsRef.current.size) {
        try { clearStoryboardWorkspaceRecovery(sessionStorage, key, [...discardedRecoveryRunIdsRef.current]); }
        catch { setNotice("当前工作区已清空；浏览器暂存未能完全移除，普通入口不会恢复旧内容。"); }
      }
      // A plain entry is intentionally a new blank workspace. Recovery is only
      // a bridge for an explicit project URL; otherwise an old failed task or
      // a previous browser draft must never reappear after refresh. History is
      // still available through the dedicated history surface and an explicit
      // ?projectId=... URL.
      if (!initialProjectIdRef.current || workspaceGeneration !== workspaceGenerationRef.current) {
        try {
          const primary = readStoryboardRecovery(sessionStorage, key);
          const sidecars = readStoryboardRecoveryConflicts(sessionStorage, key);
          const runIds = [...new Set([
            primary?.run && typeof primary.run.id === "string" ? primary.run.id : "",
            ...sidecars.map(item => item.run && typeof item.run.id === "string" ? item.run.id : ""),
          ].filter(Boolean))];
          if (runIds.length) clearStoryboardWorkspaceRecovery(sessionStorage, key, runIds);
          else sessionStorage.removeItem(`${key}:conflict-index`);
        } catch { /* A blank workspace is still safe when browser storage is unavailable. */ }
        setRecoveryReadReady(true);
        setStorageReady(true);
        contextReadyRef.current = true;
        setProjectContext("ready");
        return;
      }
      const savedDrafts = readStoryboardRecoveryConflicts(sessionStorage, key).flatMap(draft => {
        const normalized = normalizeRun(draft.run);
        return normalized ? [{ key: draft.key, run: normalized }] : [];
      });
      setSavedRecoveryDrafts(savedDrafts);
      if (savedDrafts[0]) setRecoveryConflictDraft(savedDrafts[0].run);
      if (savedDrafts[1]) setRecoveryExtraDraft(savedDrafts[1].run);
      const recovered = readStoryboardRecovery(sessionStorage, key);
      const restored = recovered && normalizeRun(recovered.run);
      const requiresCloudRestore = Boolean(restored && (recovered.baseContentFingerprint || hasSubmittedWork(restored)));
      const conflictProjectId = initialProjectIdRef.current || restored?.id;
      if (conflictProjectId) {
        const conflict = readStoryboardRecovery(sessionStorage, `${key}:conflict:${encodeURIComponent(conflictProjectId)}`);
        if (conflict) setRecoveryConflictDraft(normalizeRun(conflict.run));
        const extra = readStoryboardRecovery(sessionStorage, `${key}:new-workspace:conflict:${encodeURIComponent(conflictProjectId)}`);
        if (extra) setRecoveryExtraDraft(normalizeRun(extra.run));
      }
      if (restored && (!initialProjectIdRef.current || restored.id === initialProjectIdRef.current)) {
        initialRecoveryRef.current = { run: restored, baseContentFingerprint: recovered.baseContentFingerprint };
        confirmedRecoveryBaseRef.current = recovered.baseContentFingerprint;
        if (!initialProjectIdRef.current && requiresCloudRestore) {
          // A saved session is only a local edit candidate. Its cloud task and
          // revision must be read together before allowing autosave.
          contextReadyRef.current = false;
          setProjectContext("loading");
          setRecoveryProjectId(restored.id);
        } else if (!initialProjectIdRef.current) {
          runRef.current = restored;
          setRun(restored);
          if (hasSubmittedWork(restored)) submittedRunIdsRef.current.add(restored.id);
          contextReadyRef.current = true;
          setProjectContext("ready");
        }
      }
      setRecoveryReadReady(true);
      if (!initialProjectIdRef.current) {
        setStorageReady(true);
        if (!requiresCloudRestore) { contextReadyRef.current = true; setProjectContext("ready"); }
      }
    }).catch(() => { if (active) { setRecoveryReadReady(true); if (!initialProjectIdRef.current) { setStorageReady(true); contextReadyRef.current = true; setProjectContext("ready"); } setNotice("浏览器恢复存储暂不可用，请在离开前保存项目。"); } });
    return () => { active = false; };
  }, [userId, token, view]);

  useEffect(() => {
    if (view === "visual-assets" || requestedProjectId || freshWorkspace) return;
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("entry") === "agent" && searchParams.get("handoff") === "storyboard" && !agentHandoffConsumedRef.current) {
      agentHandoffConsumedRef.current = true;
      const parsedAgentHandoff = readAgentWorkbenchHandoffAcrossTabs("storyboard-workbench", userId, Date.now(), searchParams.get("handoffId") ?? undefined);
      if (parsedAgentHandoff.ok) {
        const plan = parseStoryboardCanvasImport(parsedAgentHandoff.handoff.payload, { allowQualityWarnings: Boolean(parsedAgentHandoff.handoff.payload.review_warnings?.length) });
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
  }, [freshWorkspace, requestedProjectId, userId, view]);

  useEffect(() => {
    if (view !== "workbench" || !storageReady || !contextReadyRef.current || !recoveryKeyRef.current || recoveryOverwriteBlockedRef.current) return;
    if (run.id !== runRef.current.id) return;
    try {
      writeStoryboardRecovery(sessionStorage, recoveryKeyRef.current, createStoryboardPersistenceSnapshot(run), confirmedRecoveryBaseRef.current);
    } catch { setNotice("当前内容仍在页面中，但浏览器恢复存储已满或不可用，请保存项目。"); }
  }, [run, storageReady, view, projectContext, confirmedProjectSnapshot]);

  useEffect(() => {
    if (!storageReady) return;
    if (discardedRecoveryRunIdsRef.current.has(run.id)) return;
    runRef.current = run;
    if (submittedRunIdsRef.current.has(run.id)) {
      setHistory((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, MAX_HISTORY));
    }
  }, [run, storageReady]);

  useEffect(() => {
    const clearPending = () => { if (projectAutosaveRef.current) window.clearTimeout(projectAutosaveRef.current.timer); projectAutosaveRef.current = null; };
    if (view !== "workbench" || !contextReadyRef.current || navigating || !storageReady || !cloudReady || visualAssetSaving || exportingBoardIds.size > 0
      || initialReferenceBlockedRef.current.has(userId + "\0" + token + "\0" + run.id)) { clearPending(); return; }
    // Typing, importing prompts or selecting references is session-only until
    // the user explicitly saves or starts a generation attempt. Previously any
    // input created an account project after 1.2s and brought stale drafts back
    // on the next visit.
    const shouldPersist = submittedRunIdsRef.current.has(run.id) || hasSubmittedWork(run);
    if (!shouldPersist || storyboardProjectSnapshotMatches(run, confirmedProjectSnapshot)) { clearPending(); return; }
    let monitorOnly = false;
    try {
      const prefix = run.id + ":";
      monitorOnly = confirmedProjectSnapshot.startsWith(prefix) && storyboardProjectAutosaveFingerprint(createStoryboardPersistenceSnapshot(run))
        === storyboardProjectAutosaveFingerprint(JSON.parse(confirmedProjectSnapshot.slice(prefix.length)));
    } catch { /* The normal save path presents validation errors. */ }
    const now = Date.now();
    const lastSaved = lastProjectSaveAtRef.current.get(run.id);
    const interval = monitorOnly ? STORYBOARD_MONITOR_CHECKPOINT_MS : STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS;
    const hardEarliest = Math.max(lastSaved === undefined ? 0 : lastSaved + interval, cloud.saveRetryAt || 0);
    const dueAt = Math.max(now + 1200, (lastSaved ?? now) + interval, hardEarliest);
    const owner = userId + "\0" + token;
    const pending = projectAutosaveRef.current;
    // Coalesce all cards into one project snapshot. Monitoring updates never
    // restart or multiply the pending timer; business changes may bring it forward.
    if (pending && pending.runId === run.id && pending.owner === owner && pending.dueAt <= dueAt && pending.dueAt >= hardEarliest) return;
    clearPending();
    const runId = run.id;
    const timer = window.setTimeout(() => {
      projectAutosaveRef.current = null;
      if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || imageDownloadOwnerRef.current !== owner
        || runRef.current.id !== runId || boardExportLocksRef.current.size || visualAssetMutationRef.current
        || initialReferenceBlockedRef.current.has(owner + "\0" + runId)) return;
      try { void saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current)); }
      catch { setVisualAssetError("项目草稿超过保存限制，请缩短超长字段；原文仍保留在当前页面。"); }
    }, Math.max(0, dueAt - now));
    projectAutosaveRef.current = { timer, runId, owner, dueAt };
  }, [cloudReady, cloud.saveRetryAt, confirmedProjectSnapshot, navigating, run, saveStoryboardProject, storageReady, exportingBoardIds, visualAssetSaving, view, userId, token]);

  useEffect(() => () => { if (projectAutosaveRef.current) window.clearTimeout(projectAutosaveRef.current.timer); projectAutosaveRef.current = null; }, []);

  useEffect(() => {
    if (!storageReady) return;
    historyRef.current = history;
  }, [history, storageReady]);

  const loadVideoHistory = useCallback(async (offset = 0) => {
    if (!storageReady || !token) return;
    videoHistoryAbortRef.current?.abort();
    const controller = new AbortController();
    videoHistoryAbortRef.current = controller;
    const sequence = ++videoHistorySequenceRef.current;
    const identity = videoHistoryIdentityRef.current;
    setVideoHistoryLoading(true);
    setVideoHistoryError("");
    try {
      const tasks: HistoryVideoTask[] = [];
      let cursor: number | null = offset;
      do {
        const response = await fetch(`/api/video/history?surface=storyboard-workbench&limit=100&offset=${cursor}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
        });
        const data = await response.json().catch(() => ({})) as { tasks?: HistoryVideoTask[]; error?: string; nextOffset?: number | null };
        if (controller.signal.aborted || sequence !== videoHistorySequenceRef.current || identity !== videoHistoryIdentityRef.current) return;
        if (!response.ok) throw new Error(data.error || "视频记录暂时无法读取");
        const page = Array.isArray(data.tasks) ? data.tasks : [];
        tasks.push(...page.filter(item => !tasks.some(existing => existing.id === item.id)));
        cursor = typeof data.nextOffset === "number" && data.nextOffset > cursor ? data.nextOffset : null;
      } while (offset === 0 && cursor !== null && tasks.length < videoHistoryWindowRef.current);
      setVideoHistoryTasks(current => offset ? [...current.filter(item => !tasks.some(task => task.id === item.id)), ...tasks] : tasks);
      videoHistoryWindowRef.current = Math.max(100, offset + tasks.length);
      setVideoHistoryNextOffset(cursor);
      for (const card of runRef.current.cards) {
        const task = card.videoTaskId
          ? tasks.find(item => item.id === card.videoTaskId || item.taskIdExternal === card.videoTaskId)
          : card.videoClientRequestId ? tasks.find(item => item.clientRequestId === card.videoClientRequestId) : undefined;
        if (task && !(task.clientRequestId && card.videoClientRequestId && task.clientRequestId !== card.videoClientRequestId)) {
          rememberVideoConfirmation(runRef.current.id, card.id, card.videoTaskId || task.taskIdExternal || task.id || "", task, card.videoClientRequestId);
        }
      }
      setHistory((current) => current.map((record) => hydrateRunVideoTasks(record, tasks)));
      setRun((current) => {
        const next = hydrateRunVideoTasks(current, tasks);
        runRef.current = next;
        return next;
      });
    } catch (error) {
      if (!controller.signal.aborted && sequence === videoHistorySequenceRef.current && identity === videoHistoryIdentityRef.current) setVideoHistoryError(error instanceof Error ? error.message : "视频记录暂时无法读取");
    } finally {
      if (sequence === videoHistorySequenceRef.current && identity === videoHistoryIdentityRef.current) setVideoHistoryLoading(false);
    }
  }, [rememberVideoConfirmation, storageReady, token]);

  useEffect(() => {
    setVideoHistoryTasks([]);
    setVideoHistoryNextOffset(null);
    videoHistoryWindowRef.current = 100;
    videoHistoryHydratedRef.current = false;
    return () => { videoHistoryAbortRef.current?.abort(); videoHistorySequenceRef.current++; };
  }, [userId, token]);

  // 旧历史可能只保存了已过期的 videoUrl。用服务端任务记录补回稳定 task id
  // 和最新播放凭据；同时保留独立任务列表，避免后端完成但工程卡片尚未映射时结果消失。
  useEffect(() => {
    if (view !== "workbench" || historyPage || !contextReadyRef.current || !storageReady || !token || videoHistoryHydratedRef.current) return;
    videoHistoryHydratedRef.current = true;
    void loadVideoHistory();
  }, [loadVideoHistory, run.id, storageReady, token, view, historyPage]);

  useEffect(() => {
    if (!historyPage || !storageReady) return;
    void loadVideoHistory();
    void cloud.refresh();
  }, [historyPage, storageReady, loadVideoHistory, cloud.refresh]);

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
      originalBoardBlobsRef.current.clear();
      for (const controller of polls.values()) controller.abort();
      for (const controller of lifecycles.values()) controller.abort();
      for (const controller of submissions.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    const visible = new Set(run.cards.map(card => card.imageUrl).filter(Boolean));
    if (previewMedia?.url) visible.add(previewMedia.url);
    for (const url of boardExportHeldUrlsRef.current) visible.add(url);
    for (const url of ephemeralImageUrlsRef.current) if (!visible.has(url)) {
      URL.revokeObjectURL(url);
      ephemeralImageUrlsRef.current.delete(url);
      originalBoardBlobsRef.current.delete(url);
    }
  }, [run.cards, previewMedia, exportingBoardIds]);

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
          || nextImages.find((model) => model.id === STRICT_GPT_IMAGE_PUBLIC_ID && !storyboardImageModelSelectionIssue(model) && supportedImageRatios(model).includes(effectiveImageRatio(current)))?.id
          || nextImages.find((model) => !storyboardImageModelSelectionIssue(model) && supportedImageRatios(model).includes(effectiveImageRatio(current)))?.id
          || "";
        const selectedImageModel = nextImages.find((model) => model.id === imageModelId);
        const imageResolution = effectiveImageResolution(selectedImageModel, current.imageResolution);
        const requestedVideoModelId = current.videoModelId || current.videoContract?.modelId;
        const videoModelId = resolveStoryboardInitialVideoModelId(requestedVideoModelId, nextVideos);
        const selectedVideoModel = nextVideos.find((model) => model.id === videoModelId);
        const selectedContract = videoModelId === current.videoContract?.modelId ? current.videoContract : undefined;
        const requestedVideoResolution = selectedContract?.resolution || current.videoResolution;
        const requestedVideoDuration = selectedContract?.duration || current.videoDuration;
        const resolvedVideoSelection = selectedVideoModel && selectedVideoModel.generationReady !== false
          ? resolveStoryboardVideoSelection(selectedVideoModel, {
              ratio: selectedContract?.ratio || current.ratio,
              duration: requestedVideoDuration,
              resolution: requestedVideoResolution,
            })
          : null;
        const videoResolution = resolvedVideoSelection?.resolution || requestedVideoResolution;
        const videoDuration = resolvedVideoSelection?.duration || requestedVideoDuration;
        // Loading a catalog must not silently change either saved ratio.
        const ratio = selectedContract?.ratio || current.ratio;
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
            .filter((model) => Boolean(model.id));
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
  // Every resolution any catalog model supports stays visible; the ones the
  // active model cannot produce are rendered disabled instead of disappearing,
  // so switching models never silently locks the user into one size.
  const imageResolutionChoices = useMemo(() => {
    const supported = new Set<string>(imageCapabilities.resolutionOptions);
    for (const model of imageModels) {
      for (const value of getImageModelCapabilities(model).resolutionOptions) supported.add(value);
    }
    const ordered = IMAGE_RESOLUTION_ORDER.filter((value) => supported.has(value));
    return ordered.length ? ordered : imageCapabilities.resolutionOptions;
  }, [imageModels, imageCapabilities.resolutionOptions]);
  const activeImageResolution = effectiveImageResolution(activeImageModel, run.imageResolution);
  const activeVideoResolution = effectiveVideoResolution(activeVideoModel, run.videoResolution);
  const activeVideoDuration = effectiveVideoDuration(activeVideoModel, run.videoDuration);
  const activeVideoPrice = effectiveVideoCharge(activeVideoModel, activeVideoResolution, activeVideoDuration);
  const activeVideoDurationOptions = useMemo(() => videoDurationOptions(activeVideoModel), [activeVideoModel]);
  const activeImageRatio = effectiveImageRatio(run);
  const activeImageRatioOptions = useMemo(() => supportedImageRatios(activeImageModel), [activeImageModel]);
  const activeVideoRatioOptions = useMemo(() => supportedVideoRatios(activeVideoModel), [activeVideoModel]);
  const activeImageSelectionIssue = activeImageModel
    ? storyboardImageModelSelectionIssue(activeImageModel)
    : "图片模型尚未加载";
  const activeImageRatioIssue = activeImageModel && !activeImageRatioOptions.includes(activeImageRatio) ? "当前图片模型不支持所选图片比例，请重新选择图片比例。" : "";
  const readReferenceImageSettings = useCallback((document: WorkbenchRun) => {
    const settings = storyboardReferenceImageSettings(document);
    const model = imageModels.find(item => item.id === settings.modelId);
    if (!model) return settings;
    const capabilities = getImageModelCapabilities(model);
    return resolveStoryboardReferenceImageSettings(settings, { resolutionOptions: capabilities.resolutionOptions,
      defaultResolution: capabilities.defaultResolution, aspectRatios: supportedImageRatios(model) });
  }, [imageModels]);
  const referenceSettings = readReferenceImageSettings(run);
  const referenceImageModel = imageModels.find(model => model.id === referenceSettings.modelId);
  const referenceImageResolution = effectiveImageResolution(referenceImageModel, referenceSettings.resolution);
  const referenceImageRatioOptions = supportedImageRatios(referenceImageModel);
  const referenceImageSelectionIssue = referenceImageModel ? storyboardImageModelSelectionIssue(referenceImageModel) : "图片模型尚未加载";
  const referenceImageRatioIssue = referenceImageModel && !referenceImageRatioOptions.includes(referenceSettings.ratio) ? "当前参考图模型不支持所选比例，请重新选择参考图比例。" : "";
  const visualAssetGenerationIssue = (referenceImageSelectionIssue
    ? publicModelSelectionNotice(referenceImageSelectionIssue, "参考图模型")
    : "") || referenceImageRatioIssue || (referenceImageModel?.requiresImage || (referenceImageModel?.minReferenceImages || 0) > 0
    ? "当前模型需要已有参考图，不能直接从文字制作参考图。请选择支持文字生图的模型，或从图库选择、上传已有参考图。"
    : "");
  const activeVideoSelectionIssue = activeVideoModel
    ? storyboardVideoModelSelectionIssue(activeVideoModel, {
        ratio: run.ratio,
        duration: activeVideoDuration,
        resolution: run.videoResolution,
      })
    : "视频模型尚未加载";
  const batchVideoMissingImages = run.cards.filter(card => activeVideoModel && resolveStoryboardAutomaticVideoInputs(activeVideoModel, card).requiresStoryboardImage && !hasValidatedImage(card)).length;
  const batchVideoInputIssue = run.cards.map(card => storyboardCardVideoInputIssue(activeVideoModel, card, run)).find(Boolean) || "";
  const batchVideoMissingPrompts = videoPromptRequired ? run.cards.filter(card => !card.videoPrompt.trim()).length : 0;
  const batchVideoRatioMismatches = run.cards.filter(card => activeVideoModel && resolveStoryboardAutomaticVideoInputs(activeVideoModel, card).usesStoryboardImage && storyboardImageRatioIssue(card, activeImageRatio, run.ratio, activeVideoModel)).length;
  const batchVideoBlockedReason = activeVideoSelectionIssue
    ? publicModelSelectionNotice(activeVideoSelectionIssue, "视频模型")
    : batchMode ? "当前批量任务正在处理，请等待完成。"
    : batchVideoMissingImages ? `还有 ${batchVideoMissingImages} 张分镜图尚未生成或验证，请先完成这些图片。`
    : batchVideoMissingPrompts ? `还有 ${batchVideoMissingPrompts} 段未填写视频提示词。`
    : batchVideoRatioMismatches ? `还有 ${batchVideoRatioMismatches} 张分镜图与视频画幅不一致，请核对图片与视频比例。`
    : batchVideoInputIssue;
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
    if (!contextReadyRef.current || navigationRef.current) return;
    setRun((current) => {
      const next = { ...current,
        ...(patch.ratio !== undefined && patch.imageRatio === undefined ? { imageRatio: effectiveImageRatio(current) } : {}),
        ...patch, updatedAt: Date.now() };
      runRef.current = next;
      return next;
    });
  }, []);

  const patchReferenceImageSettings = useCallback((patch: Partial<StoryboardReferenceImageSettings>) => {
    if (!contextReadyRef.current || navigationRef.current || visualAssetGenerationRef.current || visualAssetBatchRef.current) return;
    setRun(current => {
      const workspace = current.visualAssetWorkspace || { drafts: [], candidates: [] };
      const next = { ...current, updatedAt: Date.now(), visualAssetWorkspace: normalizeStoryboardVisualAssetWorkspace({
        ...workspace, generationSettings: { ...readReferenceImageSettings(current), ...patch },
      }) };
      runRef.current = next;
      return next;
    });
  }, [readReferenceImageSettings]);

  const selectReferenceImageModel = useCallback((model: ImageModel) => {
    const issue = storyboardImageModelSelectionIssue(model);
    if (issue) { setVisualAssetError(publicModelSelectionNotice(issue, "参考图模型")); return; }
    const current = readReferenceImageSettings(runRef.current);
    const ratios = supportedImageRatios(model);
    // Keep the tier the user already picked whenever the new model can render it;
    // switching models must not silently push them back to the default.
    const nextResolutions: string[] = getImageModelCapabilities(model).resolutionOptions;
    const keptResolution = nextResolutions.includes(current.resolution)
      ? current.resolution
      : preferredStoryboardImageResolution(model);
    patchReferenceImageSettings({ modelId: model.id, resolution: keptResolution,
      ratio: ratios.includes(current.ratio) ? current.ratio : ratios[0] || current.ratio });
    setVisualAssetError("");
  }, [patchReferenceImageSettings, readReferenceImageSettings]);

  // 参考图与分镜共用顶部唯一的模型/清晰度/比例选择。这里只做单向镜像，
  // 避免工作台里出现第二套参数控件，也避免两处设置各自漂移导致提交值与所见不一致。
  useEffect(() => {
    if (!run.imageModelId || runRef.current.id !== run.id) return;
    const current = readReferenceImageSettings(runRef.current);
    const visibleRatios = ["16:9", "9:16", "1:1"];
    // 只镜像有效的用户选择；旧项目可能没有 imageRatio/resolution，缺值必须沿用当前值，
    // 否则会把 undefined 写进持久化合同并让整个工作台无法加载。
    const desired = {
      modelId: run.imageModelId,
      resolution: run.imageResolution || current.resolution,
      ratio: visibleRatios.includes(String(run.imageRatio)) ? run.imageRatio : current.ratio,
    };
    if (!desired.resolution) return;
    if (current.modelId === desired.modelId && current.resolution === desired.resolution && current.ratio === desired.ratio) return;
    patchReferenceImageSettings(desired);
  }, [run.id, run.imageModelId, run.imageResolution, run.imageRatio, patchReferenceImageSettings, readReferenceImageSettings]);

  useEffect(() => {
    if (!runRef.current.visualAssetWorkspace || !referenceImageModel || !contextReadyRef.current || navigationRef.current || visualAssetGenerationRef.current
      || visualAssetBatchRef.current || visualAssetMutationRef.current || referenceUploadOperationRef.current) return;
    const stored = storyboardReferenceImageSettings(runRef.current);
    const effective = readReferenceImageSettings(runRef.current);
    if (stored.modelId !== referenceSettings.modelId || JSON.stringify(stored) === JSON.stringify(effective)) return;
    patchReferenceImageSettings(effective);
  }, [run.visualAssetWorkspace, referenceImageModel, referenceSettings.modelId, referenceSettings.resolution, referenceSettings.ratio, patchReferenceImageSettings, readReferenceImageSettings]);

  const patchCard = useCallback((cardId: string, patch: Partial<WorkbenchCard>, runPatch?: Pick<WorkbenchRun, "lastSubmittedAt">, guard?: (current: WorkbenchRun) => boolean) => {
    if (!contextReadyRef.current || navigationRef.current) return;
    setRun((current) => {
      if (guard && !guard(current)) return current;
      const next = {
        ...current,
        ...runPatch,
        updatedAt: Date.now(),
        cards: current.cards.map((card) => card.id === cardId ? { ...card, ...patch,
          ...((patch.imagePrompt !== undefined && patch.imagePrompt !== card.imagePrompt || patch.imageExactText !== undefined && patch.imageExactText !== card.imageExactText
            || patch.imageTextLayoutEnabled !== undefined && patch.imageTextLayoutEnabled !== card.imageTextLayoutEnabled)
            && (card.imageUrl || card.imageRecordId) ? { imageReferenceState: "stale" as const } : {}) } : card),
      };
      runRef.current = next;
      return next;
    });
  }, []);

  const abandonImageAttempt = useCallback((cardId: string) => {
    if (isUnavailableCompletedStoryboardImage(runRef.current.cards.find(card => card.id === cardId))) {
      setNotice("原图片已生成，任务与费用收据保留；请使用明确的新任务入口重新生成。");
      return;
    }
    imageInspectionVersionsRef.current.set(cardId, Symbol("abandoned-image-inspection"));
    imageStatusChecksRef.current.delete(cardId);
    patchCard(cardId, {
      imageStatus: "idle" as const,
      imageRetryBlocked: false,
      imageRecoveryReady: false,
      imageError: undefined,
      imageUrl: undefined,
      imageRef: undefined,
      imageRecordId: undefined,
      imageDeliveryMode: undefined,
      imageMediaState: undefined,
      imageDeliveryExpectedPixelSize: undefined,
      imageOutputPolicyVersion: undefined,
      imageValidatedAt: undefined,
      imageBillingState: undefined,
      imageQuotedPrice: undefined,
    });
    setNotice("已放弃本次待确认结果，可以重新生成；原请求仍保留在费用核对记录中。");
  }, [patchCard]);

  const saveVisualAssetContext = useCallback(async (document: WorkbenchRun, manual = false): Promise<boolean> => {
    if (!isReferenceSessionId(document.id)) return saveStoryboardProject(createStoryboardPersistenceSnapshot(document), manual);
    try {
      const previous = referenceContextRef.current?.sessionId === document.id ? referenceContextRef.current : restoredReferenceContextsRef.current.get(document);
      if (!previous) throw new Error("参考制作上下文不存在，原结果仍保留。");
      const workspace = document.visualAssetWorkspace || { drafts: [], candidates: [] };
      const settings = storyboardReferenceImageSettings(document);
      const saved = saveReferenceWorkspace(window.localStorage, userId, { ...previous, modelId: settings.modelId,
        resolution: settings.resolution, ratio: settings.ratio, workspace: { ...workspace, drafts: workspace.drafts,
          candidates: workspace.candidates.map(({ projectId: _projectId, ...candidate }) => candidate) } });
      if (referenceContextRef.current?.sessionId === document.id) {
        referenceContextRef.current = saved;
        writeReferenceSessionId(window.sessionStorage, userId, document.id);
      }
      return true;
    } catch (error) { setVisualAssetError(error instanceof Error ? error.message : "本地参考制作保存未确认，本次未提交。"); return false; }
  }, [saveStoryboardProject, userId]);

  const restoreVisualAssetContext = useCallback(async (scope: { kind: "project"; projectId: string } | { kind: "reference-session"; referenceSessionId: string }): Promise<WorkbenchRun | null> => {
    if (scope.kind === "project") return normalizeRun(await cloud.restore(scope.projectId));
    const document = readReferenceWorkspace(window.localStorage, userId, scope.referenceSessionId);
    if (!document) return null;
    const adapter = { ...createRun(1), id: document.sessionId, cards: [], imageModelId: document.modelId,
      imageResolution: document.resolution, imageRatio: document.ratio, visualAssetWorkspace: document.workspace };
    restoredReferenceContextsRef.current.set(adapter, document);
    return adapter;
  }, [cloud.restore, userId]);

  useEffect(() => {
    if (!referenceOnly) return;
    try {
      const id = readReferenceSessionId(window.sessionStorage, userId);
      const stored = id ? readReferenceWorkspace(window.localStorage, userId, id) : null;
      if (id && !stored) throw new Error("原参考制作记录不存在，未新建或覆盖。");
      const document: ReferenceWorkspace = stored || { schema: "storyboard-reference-workspace.v1", sessionId: `reference-session_${crypto.randomUUID()}`,
        revision: 0, modelId: "", resolution: "2K", ratio: "16:9", workspace: { drafts: [], candidates: [] } };
      referenceContextRef.current = document;
      const next = { ...runRef.current, id: document.sessionId, cards: [], imageModelId: document.modelId || runRef.current.imageModelId,
        imageResolution: document.resolution, imageRatio: document.ratio, visualAssetWorkspace: document.workspace };
      runRef.current = next; setRun(next); setStorageReady(true); contextReadyRef.current = true; setProjectContext("ready");
    } catch (error) { contextReadyRef.current = false; setProjectContext("error"); setProjectContextError(error instanceof Error ? error.message : "参考制作记录无法读取，原记录已保留。"); }
    return () => { contextReadyRef.current = false; };
  }, [referenceOnly, userId]);

  const changeVisualAssetDrafts = useCallback((drafts: StoryboardVisualAssetDraft[]) => {
    if (!contextReadyRef.current || navigationRef.current || !scopeMountedRef.current) return;
    const current = runRef.current;
    // Keep the complete editable text in memory; the persistence schema rejects
    // oversize input explicitly before navigation or generation, without slicing it.
    const next = { ...current, updatedAt: Date.now(), visualAssetWorkspace: { ...current.visualAssetWorkspace, drafts: structuredClone(drafts), candidates: current.visualAssetWorkspace?.candidates || [] } };
    if (next.directorIntake?.phase === "planned") next.directorIntake = pruneStoryboardDirectorAssetConfirmations(next);
    runRef.current = next; setRun(next);
    if (isReferenceSessionId(next.id)) void saveVisualAssetContext(next);
  }, [saveVisualAssetContext]);

  const rememberVisualAssetCandidate = useCallback((candidate: DrawerVisualAsset, projectId: string, originalId?: string) => {
    if (!scopeMountedRef.current || !contextReadyRef.current || runRef.current.id !== projectId) throw new Error("项目已切换，资产结果保留在原请求中，请查询原项目。");
    const next = withVisualAssetCandidate(runRef.current, candidate, originalId);
    runRef.current = next; setRun(next);
    setVisualAssetCandidates(items => [candidate, ...items.filter(item => item.assetId !== (originalId || candidate.assetId) && item.assetId !== candidate.assetId)]);
    return next;
  }, []);

  const rememberDirectorAssetExport = useCallback((candidate: DrawerVisualAsset, projectId: string) => {
    if (!scopeMountedRef.current || !contextReadyRef.current || runRef.current.id !== projectId) throw new Error("项目已切换，图库副本已保留，请读取原项目。");
    const next = withDirectorAssetLibrarySave(runRef.current, candidate);
    runRef.current = next; setRun(next);
    setVisualAssetCandidates(items => [candidate, ...items.filter(item => item.assetId !== candidate.assetId || item.planId !== candidate.planId)]);
    return next;
  }, []);

  const loadVisualAssetCandidates = useCallback(async (offset = 0) => {
    if (!token) {
      setVisualAssetError("请先登录后读取自己的视觉资产");
      return;
    }
    setVisualAssetLoading(true);
    setVisualAssetError("");
    try {
      const response = await fetch(`/api/storyboard/visual-assets?offset=${offset}&limit=60`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as {
        assets?: Array<{ assetId?: string; previewUrl?: string; prompt?: string; storageKey?: string; role?: VisualAssetRole; name?: string; projectId?: string; createdAt?: string; tags?: string[]; customCategory?: string; sceneId?: string; sceneZone?: string; cameraCoverage?: DrawerVisualAsset["cameraCoverage"]; fixedAnchors?: string[]; allowedSegmentKinds?: string[]; derivedFromAssetId?: string }>;
        error?: string; nextOffset?: number | null;
      };
      if (!response.ok) throw new Error(data.error || "视觉资产历史暂时无法读取");
      const candidates: OwnedVisualAsset[] = [];
      const seen = new Set<string>();
      for (const item of data.assets || []) {
        const assetId = String(item.assetId || "").trim();
        const previewUrl = String(item.previewUrl || "").trim();
        if (!assetId || !previewUrl || seen.has(assetId)) continue;
        seen.add(assetId);
        candidates.push({
          assetId,
          planId: visualAssetPlanId(assetId, candidates.length),
          previewUrl,
          prompt: String(item.prompt || "").trim(),
          name: String(item.name || "").trim() || `我的视觉资产 ${candidates.length + 1}`,
          role: item.role && ["character", "pet", "environment", "prop"].includes(item.role) ? item.role : "prop",
          storageKey: String(item.storageKey || "").trim() || undefined,
          projectId: String(item.projectId || "").trim() || undefined,
          createdAt: String(item.createdAt || "").trim() || undefined,
          tags: item.tags || [], customCategory: item.customCategory || "", source: "personal",
          sceneId: item.sceneId, sceneZone: item.sceneZone, cameraCoverage: item.cameraCoverage,
          fixedAnchors: item.fixedAnchors, allowedSegmentKinds: item.allowedSegmentKinds, derivedFromAssetId: item.derivedFromAssetId,
          saved: true,
        });
      }
      setVisualAssetCandidates((current) => [...current.filter(item => (!item.saved || offset > 0) && !candidates.some(next => next.assetId === item.assetId)), ...candidates]);
      setVisualAssetNextOffset(typeof data.nextOffset === "number" ? data.nextOffset : null);
    } catch (error) {
      setVisualAssetError(error instanceof Error ? error.message : "视觉资产历史暂时无法读取");
      // Preserve project candidates when the library read fails.
    } finally {
      setVisualAssetLoading(false);
    }
  }, [token]);

  const loadPresetAssets = useCallback(async () => {
    if (!token) return;
    setPresetsLoading(true);
    try {
      const response = await fetch("/api/storyboard/presets?limit=100", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const result = await response.json() as { presets?: StoryboardPresetPublic[]; error?: string };
      if (!response.ok || !Array.isArray(result.presets)) throw new Error(result.error || "平台预设暂时无法读取");
      setPresetAssets(result.presets.map(item => ({ ...item, assetId: item.presetId, planId: visualAssetPlanId(item.presetId),
        presetRevision: item.revision, source: "platform-preset", saved: true })));
    } catch (error) { setVisualAssetError(error instanceof Error ? error.message : "平台预设暂时无法读取"); }
    finally { setPresetsLoading(false); }
  }, [token]);
  useEffect(() => { void loadPresetAssets(); void loadVisualAssetCandidates(); }, [loadPresetAssets, loadVisualAssetCandidates]);

  const updateVisualAssetMetadata = useCallback(async (asset: DrawerVisualAsset) => {
    if (!token || !asset.saved || asset.source === "platform-preset") return false;
    const projectId = runRef.current.id;
    try {
      const response = await fetch("/api/storyboard/visual-assets", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assetId: asset.assetId, role: asset.role, name: asset.name, prompt: asset.prompt || "", projectId: referenceOnly ? "" : asset.projectId || "", tags: asset.tags || [], customCategory: asset.customCategory || "",
          sceneId: asset.sceneId, sceneZone: asset.sceneZone, cameraCoverage: asset.cameraCoverage, fixedAnchors: asset.fixedAnchors || [], allowedSegmentKinds: asset.allowedSegmentKinds || [], derivedFromAssetId: asset.derivedFromAssetId }) });
      const data = await response.json();
      if (!response.ok || !data.asset?.assetId) throw new Error(data.error || "资产信息保存未确认");
      const updated = { ...asset, ...data.asset, saved: true };
      if (runRef.current.visualAssetWorkspace?.candidates.some(item => item.assetId === asset.assetId)) {
        const next = rememberVisualAssetCandidate(updated, projectId);
        if (!await saveVisualAssetContext(createStoryboardPersistenceSnapshot(next), true)) throw new Error("资产库信息已保存；项目记录尚未保存，请保留本页后重试保存项目。");
      } else if (scopeMountedRef.current && runRef.current.id === projectId) setVisualAssetCandidates(items => items.map(item => item.assetId === asset.assetId ? updated : item));
      setNotice("资产信息已保存，刷新后可读回"); return true;
    } catch (error) { setVisualAssetError(error instanceof Error ? error.message : "资产信息保存失败"); return false; }
  }, [rememberVisualAssetCandidate, saveVisualAssetContext, token, referenceOnly]);

  const inspectStoryboardImageAttempt = useCallback(async (card: WorkbenchCard, signal?: AbortSignal) => {
    const clientIdempotencyKey = String(card.imageClientRequestId || "").trim();
    const clientTraceId = deriveStoryboardImageTraceId(card);
    if (!token || !clientIdempotencyKey || !clientTraceId) return null;
    const query = new URLSearchParams({ clientIdempotencyKey, clientTraceId });
    const { response, data } = await fetchStoryboardJson<StoryboardImageAttemptStatus>(`/api/image/status?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    });
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
    const result = await fetchStoryboardJson(`/api/storyboard/image?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const response = result.response;
    const data = result.data as {
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

  const restoreOwnedBoard = useCallback(async (cardId: string, recordId?: string, inspectionGuard?: (current: WorkbenchRun) => boolean): Promise<boolean> => {
    const currentId = runRef.current.id;
    const owner = userId + "\0" + token;
    const card = runRef.current.cards.find(item => item.id === cardId);
    if (!isOwnedStoryboardBoard(card, recordId)) return false;
    if (boardExportLocksRef.current.has(cardId) || imageDownloadOwnerRef.current !== owner) return true;
    const stillOwned = () => scopeMountedRef.current && (!inspectionGuard || inspectionGuard(runRef.current)) && imageDownloadOwnerRef.current === owner && runRef.current.id === currentId && runRef.current.cards.some(item => item.id === cardId && item.imageRecordId === card!.imageRecordId && item.imageAssetId === card!.imageAssetId && item.imageStorageKey === card!.imageStorageKey && isOwnedStoryboardBoard(item));
    try {
      const owned = await readOwnedStoryboardImage({ assetId: card!.imageAssetId, storageKey: card!.imageStorageKey }, card!.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(runRef.current));
      if (owned.assetId !== card!.imageAssetId || owned.storageKey !== card!.imageStorageKey) throw new Error("故事板归属标识不一致");
      if (card!.imageWidth && card!.imageHeight && (owned.width !== card!.imageWidth || owned.height !== card!.imageHeight)) throw new Error("原故事板完整尺寸已变化，未替换原图。");
      if (stillOwned()) patchCard(cardId, { imageStatus: "done", imageUrl: owned.url, imageWidth: owned.width, imageHeight: owned.height, imageValidatedAt: Date.now(), imageRef: undefined, imageDeliveryMode: undefined, imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined }, undefined, inspectionGuard);
    } catch (error) { if (stillOwned()) patchCard(cardId, { imageStatus: "done", imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: false, imageError: `${error instanceof Error ? error.message : "保存的故事板暂不可读取"}；请重新读取原图，不会重新生成。` }, undefined, inspectionGuard); }
    return true;
  }, [patchCard, readOwnedStoryboardImage, token, userId]);

  const saveBoardForVideo = useCallback(async (cardId: string, ownsVideoPreparation = false): Promise<boolean> => {
    if (!token || !scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || boardExportLocksRef.current.has(cardId) || imageSubmissionsRef.current.has(cardId) || videoSubmissionsRef.current.has(cardId) && !ownsVideoPreparation) return false;
    const beforeRun = runRef.current;
    const before = beforeRun.cards.find(card => card.id === cardId);
    if (!before || !needsStoryboardBoardExport(before) || !hasValidatedImage(before) || isActiveVideoStatus(before.videoStatus)) return false;
    const originalUrl = before.imageUrl!;
    const owner = userId + "\0" + token;
    if (originalUrl.startsWith("blob:") && !ephemeralImageUrlsRef.current.has(originalUrl)) { setNotice("原临时分镜图不属于当前页面，未保存。"); return false; }
    const stillCurrent = () => scopeMountedRef.current && imageDownloadOwnerRef.current === owner && contextReadyRef.current && runRef.current.id === beforeRun.id && runRef.current.cards.some(card => card.id === cardId && card.imageRecordId === before.imageRecordId && card.imageUrl === originalUrl && needsStoryboardBoardExport(card));
    boardExportHeldUrlsRef.current.add(originalUrl);
    boardExportLocksRef.current.add(cardId); setExportingBoardIds(new Set(boardExportLocksRef.current));
    let attemptedPatch: Partial<WorkbenchCard> | undefined;
    try {
      const owned = await saveStoryboardBoardOriginal({ userId, runId: beforeRun.id, cardId, recordId: before.imageRecordId || "", url: originalUrl,
        width: before.imageWidth || 0, height: before.imageHeight || 0, token, cache: boardExportCacheRef.current, stillCurrent,
        readOriginal: async url => readStoryboardBoardBlob(originalBoardBlobsRef.current, url, { owner, runId: beforeRun.id, cardId, recordId: before.imageRecordId || "" }),
        readOwned: async reference => readOwnedStoryboardImage(reference, before.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(beforeRun)) });
      if (!stillCurrent()) throw new Error("原故事板已变化，保存副本保留，未更改当前卡片。");
      attemptedPatch = { imageAssetId: owned.assetId, imageStorageKey: owned.storageKey, imageUrl: owned.url, imageWidth: owned.width, imageHeight: owned.height,
        imageRef: undefined, imageDeliveryMode: undefined, imageStatus: "done", imageValidatedAt: Date.now(), imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined };
      const latest = runRef.current;
      const next = { ...latest, updatedAt: Date.now(), cards: latest.cards.map(card => card.id === cardId ? { ...card, ...attemptedPatch } : card) };
      runRef.current = next; setRun(next);
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true)) throw new Error("原图副本已保存，但项目绑定未确认；原临时图保留，可重试保存绑定。");
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== owner || !contextReadyRef.current || navigationRef.current || runRef.current.id !== beforeRun.id
        || !runRef.current.cards.some(card => card.id === cardId && card.imageRecordId === before.imageRecordId && card.imageAssetId === owned.assetId && card.imageStorageKey === owned.storageKey && isOwnedStoryboardBoard(card))) return false;
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === beforeRun.id) setNotice("分镜图已保存并可用于视频；未生成视频或加入角色库。");
      return true;
    } catch (error) {
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === beforeRun.id) {
        if (attemptedPatch) { const current = runRef.current; const next = { ...current, cards: current.cards.map(card => card.id === cardId && card.imageRecordId === before.imageRecordId ? rollbackStoryboardBoardBinding(card, before, attemptedPatch!) : card) }; runRef.current = next; setRun(next); }
        if (imageDownloadOwnerRef.current === owner) setNotice(error instanceof Error ? error.message : "保存未确认，原分镜图仍保留。");
      }
      return false;
    } finally { boardExportHeldUrlsRef.current.delete(originalUrl); boardExportLocksRef.current.delete(cardId); if (scopeMountedRef.current) setExportingBoardIds(new Set(boardExportLocksRef.current)); }
  }, [readOwnedStoryboardImage, saveStoryboardProject, token, userId]);

  const loadImportImages = useCallback(async (offset: number): Promise<{ assets: ImportReferenceImage[]; nextOffset: number | null }> => {
    if (!token || !scopeMountedRef.current) throw new Error("请先登录后读取自己的图片。");
    const response = await fetch(`/api/storyboard/visual-assets?includeUnclassified=1&offset=${offset}&limit=24`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const data = await response.json() as { assets?: Array<ImportReferenceImage & { classified?: boolean }>; nextOffset?: number | null; error?: string };
    if (!response.ok) throw new Error(data.error || "图片库读取失败。");
    return { assets: (data.assets || []).filter(image => image.classified === false && Boolean(image.assetId && image.storageKey && image.previewUrl)), nextOffset: typeof data.nextOffset === "number" ? data.nextOffset : null };
  }, [token]);

  const importReferenceImage = useCallback(async (image: ImportReferenceImage, input: DrawerVisualAssetInput, uploadOperationId?: string): Promise<DrawerVisualAsset | null> => {
    if (!contextReadyRef.current || navigationRef.current || (visualAssetMutationRef.current && (!uploadOperationId || referenceUploadOperationRef.current !== uploadOperationId)) || visualAssetGenerationRef.current || !scopeMountedRef.current) return null;
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    const contextId = runRef.current.id;
    const importOwner = userId + "\0" + token;
    const importCurrent = () => scopeMountedRef.current && contextReadyRef.current && runRef.current.id === contextId && imageDownloadOwnerRef.current === importOwner;
    let attemptedEntry: NonNullable<WorkbenchRun["visualAssetWorkspace"]>["candidates"][number] | undefined;
    let originalEntry: typeof attemptedEntry;
    const rollback = () => {
      if (!scopeMountedRef.current || runRef.current.id !== contextId || !attemptedEntry) return;
      const current = runRef.current;
      if (!current.visualAssetWorkspace?.candidates.includes(attemptedEntry)) return;
      const entries = current.visualAssetWorkspace.candidates.flatMap(entry => entry === attemptedEntry ? originalEntry ? [originalEntry] : [] : [entry]);
      const next = { ...current, visualAssetWorkspace: { ...current.visualAssetWorkspace, candidates: entries } };
      runRef.current = next; setRun(next);
    };
    try {
      const owned = await readOwnedStoryboardImage({ assetId: image.assetId, storageKey: image.storageKey });
      if (owned.assetId !== image.assetId || owned.storageKey !== image.storageKey) throw new Error("图片归属标识不一致，未导入。");
      if (!importCurrent()) return null;
      const current = runRef.current;
      if (requestedSlotId && !current.visualAssetWorkspace?.drafts.some(draft => draft.planId === requestedSlotId) && !current.visualAssetPlan?.assets.some(asset => asset.id === requestedSlotId)) throw new Error("原参考位置不存在，请返回工作台重新选择。");
      const candidate: DrawerVisualAsset = { ...input, assetId: owned.assetId, storageKey: owned.storageKey, previewUrl: owned.url,
        saved: false, source: "personal", projectId: referenceOnly ? undefined : contextId };
      originalEntry = current.visualAssetWorkspace?.candidates.find(entry => entry.assetId === candidate.assetId);
      const next = withVisualAssetCandidate(current, candidate);
      attemptedEntry = next.visualAssetWorkspace?.candidates.find(entry => entry.assetId === candidate.assetId);
      runRef.current = next; setRun(next);
      if (!await saveVisualAssetContext(next, true)) { rollback(); return null; }
      if (!importCurrent()) { rollback(); return null; }
      setVisualAssetCandidates(items => [candidate, ...items.filter(item => item.assetId !== candidate.assetId)]);
      return candidate;
    } catch (error) { rollback(); if (scopeMountedRef.current && runRef.current.id === contextId) setVisualAssetError(error instanceof Error ? error.message : "图片导入未确认，原选择已保留。"); return null; }
    finally { if (!uploadOperationId && scopeMountedRef.current && runRef.current.id === contextId) { visualAssetMutationRef.current = false; setVisualAssetSaving(false); } }
  }, [readOwnedStoryboardImage, referenceOnly, requestedSlotId, saveVisualAssetContext, userId, token]);

  useEffect(() => {
    if (!contextReadyRef.current || !userId || projectContext !== "ready") return;
    try {
      const pending = readReferenceUploadPending(localStorage, userId);
      referenceUploadPendingRef.current = pending; setReferenceUploadPending(pending);
      const current = runRef.current;
      const missing = pending.filter(item => item.contextId === current.id && !current.visualAssetWorkspace?.drafts.some(draft => draft.planId === item.draft.planId));
      if (missing.length) {
        const workspace = normalizeStoryboardVisualAssetWorkspace({ ...current.visualAssetWorkspace, drafts: [...(current.visualAssetWorkspace?.drafts || []), ...missing.map(item => item.draft)], candidates: current.visualAssetWorkspace?.candidates || [] })!;
        const next = { ...current, visualAssetWorkspace: workspace }; runRef.current = next; setRun(next);
      }
    } catch (error) { setVisualAssetError(error instanceof Error ? error.message : "上传记录读取失败，原记录已保留。"); }
  }, [projectContext, run.id, userId]);

  const uploadReferenceImage = useCallback(async (file: File | undefined, input: DrawerVisualAssetInput): Promise<DrawerVisualAsset | null> => {
    if (!contextReadyRef.current || navigationRef.current || referenceUploadOperationRef.current || visualAssetMutationRef.current || visualAssetGenerationRef.current || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size || boardExportLocksRef.current.size) return null;
    const owner = userId + "\0" + token, contextId = runRef.current.id;
    const operationId = crypto.randomUUID(); referenceUploadOperationRef.current = operationId;
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    const stillCurrent = () => scopeMountedRef.current && contextReadyRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === contextId && referenceUploadOperationRef.current === operationId && Boolean(runRef.current.visualAssetWorkspace?.drafts.some(draft => draft.planId === input.planId));
    const persist = (pending: ReferenceUploadPending | null, removeId?: string) => {
      const remember = () => { if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner) { const next = [...referenceUploadPendingRef.current.filter(item => item.id !== (pending?.id || removeId)), ...(pending ? [pending] : [])]; referenceUploadPendingRef.current = next; setReferenceUploadPending(next); } };
      // Retain a confirmed key in RAM even if storage becomes unavailable after upload.
      if (pending?.storageKey) remember();
      writeReferenceUploadPending(localStorage, userId, pending, removeId);
      if (!pending?.storageKey) remember();
    };
    try {
      const original = referenceUploadPendingRef.current.find(item => item.contextId === contextId && item.draft.planId === input.planId) || readReferenceUploadPending(localStorage, userId).find(item => item.contextId === contextId && item.draft.planId === input.planId);
      if (file && original) throw new Error("此位置已有待确认上传，请先读取原上传图，勿重复上传。");
      let pending = original;
      if (!pending) {
        if (!file) throw new Error("没有可恢复的原上传记录。");
        const description = await describeReferenceUpload(file);
        const draft = runRef.current.visualAssetWorkspace?.drafts.find(item => item.planId === input.planId);
        if (!draft || !stillCurrent()) throw new Error("参考位置已变化，未上传。");
        pending = { id: crypto.randomUUID(), contextId, contextKind: referenceOnly ? "reference-session" : "project", draft: { ...draft, ...input, tagsText: (input.tags || []).join("，"), customCategory: input.customCategory || "" }, ...description, status: "uploading" };
        // An independent reference session remains local; make its identity recoverable before upload.
        if (referenceOnly && !await saveVisualAssetContext(runRef.current, true)) throw new Error("参考草稿未保存，未上传图片。");
      }
      const result = await resolveReferenceUpload({ pending, file, persist, stillCurrent,
        upload: async originalFile => {
          const form = new FormData(); form.set("file", originalFile); form.set("category", "image"); form.set("source", "storyboard-reference-upload");
          const response = await fetch("/api/storage/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, redirect: "error", signal: AbortSignal.timeout(60000) });
          const data = await response.json() as { success?: boolean; file?: { key?: string }; error?: string };
          if (!response.ok || data.success !== true || !data.file?.key) throw new Error(data.error || "上传结果未确认，请在我的图片中核对原图，勿重复上传。");
          return { storageKey: data.file.key };
        },
        readOwned: storageKey => readOwnedStoryboardImage({ storageKey }),
        register: (owned, receipt) => importReferenceImage({ assetId: owned.assetId, storageKey: owned.storageKey, previewUrl: owned.url, name: receipt.draft.name }, { role: receipt.draft.role, name: receipt.draft.name, prompt: receipt.draft.prompt, planId: receipt.draft.planId, tags: receipt.draft.tagsText.split(/[，,]/u).map(tag => tag.trim()).filter(Boolean), customCategory: receipt.draft.customCategory || undefined }, operationId),
      });
      if (stillCurrent()) setNotice("参考图已上传为候选；使用与保存到图库可分别选择。");
      return result;
    } catch (error) { if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === contextId) setVisualAssetError(error instanceof Error ? error.message : "上传未确认，原记录已保留。"); return null; }
    finally { if (referenceUploadOperationRef.current === operationId) { referenceUploadOperationRef.current = null; visualAssetMutationRef.current = false; if (scopeMountedRef.current) setVisualAssetSaving(false); } }
  }, [importReferenceImage, readOwnedStoryboardImage, referenceOnly, saveVisualAssetContext, token, userId]);

  useEffect(() => {
    if (!contextReadyRef.current || !token || visualAssetLoading) return;
    const workspace = run.visualAssetWorkspace;
    if (visualAssetMutationRef.current) return;
    if (!workspace?.candidates.length) return;
    let active = true;
    const projectId = run.id;
    void Promise.all(workspace.candidates.map(async metadata => {
      try {
        if (metadata.projectId && metadata.projectId !== projectId) throw new Error("项目不匹配");
        let previewUrl: string;
        if (metadata.source === "platform-preset") {
          const query = new URLSearchParams({ presetId: metadata.presetId!, revision: String(metadata.presetRevision) });
          const response = await fetch(`/api/storyboard/presets?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const data = await response.json();
          if (!response.ok || !data.preset?.previewUrl) throw new Error("预设暂不可用");
          previewUrl = data.preset.previewUrl;
        } else if (!metadata.storageKey && metadata.historyRecordId) {
          const response = await fetch(`/api/storyboard/visual-assets?recordId=${encodeURIComponent(metadata.historyRecordId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const data = await response.json();
          if (!response.ok || !data.reference?.previewUrl) throw new Error("原生成记录暂不可用");
          previewUrl = data.reference.previewUrl;
        } else {
          previewUrl = (await readOwnedStoryboardImage({ assetId: metadata.assetId })).url;
        }
        return { ...metadata, projectId: isReferenceSessionId(projectId) ? undefined : projectId, previewUrl } as DrawerVisualAsset;
      } catch { return null; }
    })).then(results => {
      if (!active || !scopeMountedRef.current || runRef.current.id !== projectId) return;
      const restored = results.filter((item): item is DrawerVisualAsset => item !== null);
      setVisualAssetCandidates(current => [...restored, ...current.filter(item => !restored.some(next => next.assetId === item.assetId))]);
      const missing = results.length - restored.length;
      if (missing) setVisualAssetError(`${missing}项候选原图暂不可读取，项目记录和提示词仍保留；可刷新资产再次查询，不会重新生成。`);
    });
    return () => { active = false; };
  }, [readOwnedStoryboardImage, run.id, run.visualAssetWorkspace?.candidates, token, visualAssetLoading]);

  const updateAssetAttempts = useCallback((attempts: StoryboardAssetAttempt[]) => {
    writeStoryboardAssetAttempts(window.localStorage, userId, attempts);
    setPendingAssetAttempts(attempts);
  }, [userId]);
  useEffect(() => {
    try { setPendingAssetAttempts(readStoryboardAssetAttempts(window.localStorage, userId)); }
    catch { setVisualAssetError("资产原请求记录无法读取，请核对历史状态；已阻止新生成"); }
  }, [userId]);

  const recoverPendingAssets = useCallback(async () => {
    if (visualAssetGenerationRef.current || !token) return;
    const owner = userId + "\0" + token;
    const stillOwned = () => scopeMountedRef.current && imageDownloadOwnerRef.current === owner;
    if (!stillOwned()) return;
    const operation = Symbol("asset-delivery-recovery");
    visualAssetGenerationRef.current = operation; setVisualAssetGenerating(true); setVisualAssetError("");
    try {
      const attempts = readStoryboardAssetAttempts(window.localStorage, userId);
      for (const attempt of attempts) {
        if (!stillOwned()) return;
        const originalContextId = attempt.referenceSessionId || attempt.projectId!;
        const query = new URLSearchParams({ clientIdempotencyKey: attempt.clientIdempotencyKey, clientTraceId: attempt.clientTraceId });
        const readReceipt = async (): Promise<ImageDeliveryRecoveryStatus> => {
          const response = await fetch(`/api/image/status?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
          const receipt = await response.json() as ImageDeliveryRecoveryStatus;
          if (!response.ok) throw new Error(receipt.message || "原资产请求查询失败，未重新生成");
          return receipt;
        };
        let receipt = await readReceipt();
        if (!stillOwned()) return;
        if (receipt.state === "provider_completed_pending_delivery" && receipt.canRecover === true) {
          const body = imageDeliveryRecoveryRequest(receipt, { ...attempt, historySurface: "storyboard-workbench",
            referenceUsage: attempt.role === "character" || attempt.role === "pet" ? "character-identity" : "general" });
          if (!body) throw new Error("原结果的恢复快照不完整或不匹配，已保留原请求；不会重新生成。");
          // This is the original key's persistence recovery, never a fresh
          // provider submission. The server rechecks checkpoint and lease.
          const resumed = await fetch("/api/image/generate", { method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
          const result = await resumed.json() as { error?: string; message?: string };
          if (!stillOwned()) return;
          if (!resumed.ok) throw new Error(result.error || result.message || "原结果保存仍未完成，已保留原请求；请稍后查询。");
          receipt = await readReceipt();
          if (!stillOwned()) return;
        }
        if (receipt.state === "completed" && receipt.deliveryReady && (receipt.assetId || receipt.recordId)) {
          let previewUrl = ""; let storageKey: string | undefined;
          if (receipt.assetId) { const owned = await readOwnedStoryboardImage({ assetId: receipt.assetId }); previewUrl = owned.url; storageKey = owned.storageKey; }
          else {
            const resolved = await fetch(`/api/storyboard/visual-assets?recordId=${encodeURIComponent(receipt.recordId!)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
            const data = await resolved.json() as { reference?: { previewUrl?: string }; error?: string };
            if (!resolved.ok || !data.reference?.previewUrl) throw new Error(data.error || "原资产图片暂不可读取，保留原请求");
            previewUrl = data.reference.previewUrl;
          }
          const candidate: DrawerVisualAsset = { assetId: receipt.assetId || `generated_${receipt.recordId}`, planId: attempt.planId, role: attempt.role,
            name: attempt.name, prompt: attempt.prompt, tags: attempt.tags, customCategory: attempt.customCategory, previewUrl, storageKey, historyRecordId: receipt.recordId,
            derivedFromAssetId: attempt.derivedFromAssetId, identityState: attempt.identityState,
            modelId: attempt.modelId, modelName: attempt.modelName, quotedPrice: attempt.quotedPrice, projectId: attempt.projectId, createdAt: attempt.createdAt, saved: false };
          if (!stillOwned()) return;
          if (contextReadyRef.current && runRef.current.id === originalContextId) {
            const next = rememberVisualAssetCandidate(candidate, originalContextId);
            if (!await saveVisualAssetContext(next, true)) throw new Error("原图已找回，但项目候选保存未确认；原请求保留，请再次查询，不会重新生成。");
          } else {
            // The pending ledger is per user. Recover a different project's
            // result into that owned project, never into the currently open one.
            const original = await restoreVisualAssetContext(attempt.referenceSessionId ? { kind: "reference-session", referenceSessionId: attempt.referenceSessionId } : { kind: "project", projectId: attempt.projectId! });
            if (!stillOwned()) return;
            if (!original || original.id !== originalContextId) throw new Error("原项目暂不可读取，已保留资产请求；不会绑定到当前项目。");
            const restoredNext = withVisualAssetCandidate(original, candidate);
            const restoredReference = restoredReferenceContextsRef.current.get(original);
            if (restoredReference) restoredReferenceContextsRef.current.set(restoredNext, restoredReference);
            if (!await saveVisualAssetContext(restoredNext, true)) throw new Error("原项目候选保存未确认，已保留原请求。");
          }
          if (!stillOwned()) return;
          updateAssetAttempts(readStoryboardAssetAttempts(window.localStorage, userId).filter(item => item.clientIdempotencyKey !== attempt.clientIdempotencyKey));
          setNotice(runRef.current.id === originalContextId ? "原资产结果已恢复并保存到当前项目，未重新生成；请预览后选用" : "原资产结果已保存回原项目，未更改当前项目；请回到原页面查看参考候选。");
        } else if ((receipt.state === "rejected" && receipt.canResubmit === true) || receipt.state === "expired") {
          updateAssetAttempts(readStoryboardAssetAttempts(window.localStorage, userId).filter(item => item.clientIdempotencyKey !== attempt.clientIdempotencyKey));
          setVisualAssetError(receipt.message || "原请求终态已确认；需要时可手动重新生成");
        } else { setVisualAssetError(receipt.message || "原资产请求仍在确认中，请稍后查询；不会重复生成"); }
      }
    } catch (error) { if (stillOwned()) setVisualAssetError(error instanceof Error ? error.message : "原请求查询失败，已保留请求编号"); }
    finally {
      if (visualAssetGenerationRef.current === operation) {
        visualAssetGenerationRef.current = false;
        if (scopeMountedRef.current) setVisualAssetGenerating(false);
      }
    }
  }, [restoreVisualAssetContext, saveVisualAssetContext, readOwnedStoryboardImage, rememberVisualAssetCandidate, token, updateAssetAttempts, userId]);

  const resolveVisualAssetUrls = useCallback(async (plan?: StoryboardVisualAssetPlan): Promise<VisualAssetUrl[]> => {
    if (plan?.mode !== "selected") return [];
    const urls = await Promise.all(plan.assets.map(async asset => {
      if (!asset.source) return null;
      try {
        if (asset.source.kind === "platform-preset") {
          if (!asset.source.presetId || !asset.source.presetRevision) return null;
          const query = new URLSearchParams({ presetId: asset.source.presetId, revision: String(asset.source.presetRevision) });
          const response = await fetch(`/api/storyboard/presets?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const data = await response.json() as { preset?: StoryboardPresetPublic };
          return response.ok && data.preset?.previewUrl ? { assetId: asset.source.assetId, previewUrl: data.preset.previewUrl } : null;
        }
        if (!asset.source.storageKey && /^[a-f0-9]{64}$/u.test(asset.source.historyRecordId || "")) {
          const response = await fetch(`/api/storyboard/visual-assets?recordId=${asset.source.historyRecordId}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const data = await response.json() as { reference?: { previewUrl?: string }; error?: string };
          if (!response.ok || !data.reference?.previewUrl) return null;
          return { assetId: asset.source.assetId, previewUrl: data.reference.previewUrl };
        }
        const image = await readOwnedStoryboardImage(asset.source);
        return { assetId: asset.source.assetId, storageKey: image.storageKey, previewUrl: image.url };
      } catch { return null; }
    }));
    return urls.filter((item): item is NonNullable<typeof item> => item !== null);
  }, [readOwnedStoryboardImage, token]);

  /** The authenticated original-receipt endpoint verifies the immutable submitted prompt. */
  const verifyPlannedDirectorReferences = useCallback(async (): Promise<() => void> => {
    const before = runRef.current;
    if (resolveStoryboardExecutionMode(before) !== "reference" || before.directorIntake?.phase !== "planned") return () => undefined;
    const owner = imageDownloadOwnerRef.current;
    const planFingerprint = storyboardProductionPlanFingerprint(before);
    const sourceFingerprint = storyboardProductionAssetFingerprint(before);
    const bindings = collectStoryboardDirectorReferenceBindings(before, before.directorIntake.input);
    const assertCurrent = () => {
      const latest = runRef.current;
      if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || imageDownloadOwnerRef.current !== owner
        || latest.id !== before.id || storyboardProductionPlanFingerprint(latest) !== planFingerprint
        || storyboardProductionAssetFingerprint(latest) !== sourceFingerprint) throw new Error("角色、提示词、项目或登录身份已改变，请重新确认本次生成。");
    };
    assertCurrent();
    if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(before), true)) throw new Error("角色确认尚未保存，本次未提交生成。");
    assertCurrent();
    for (const binding of bindings) {
      const response = await fetch(`/api/storyboard/director-assets/original?projectId=${encodeURIComponent(before.id)}&assetId=${encodeURIComponent(binding.assetId)}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as { candidate?: DrawerVisualAsset; error?: string };
      assertCurrent();
      const candidate = data.candidate;
      const local = before.visualAssetWorkspace?.candidates.find(item => item.planId === binding.assetId && item.assetId === binding.sourceAssetId);
      if (!response.ok || !candidate || candidate.projectId !== before.id || candidate.planId !== binding.assetId
        || candidate.assetId !== binding.sourceAssetId || candidate.historyRecordId !== binding.historyRecordId || candidate.role !== binding.role
        || candidate.storageKey !== undefined || !candidate.previewUrl?.trim() || candidate.prompt !== local?.prompt) {
        throw new Error(data.error || "角色三视图的原生成回执与当前确认不一致，请核对原图后继续；本次未提交生成。");
      }
    }
    return assertCurrent;
  }, [saveStoryboardProject, token]);

  const generateVisualAsset = useCallback(async (rawInput: DrawerVisualAssetInput, batch?: VisualAssetBatchAuthorization): Promise<DrawerVisualAsset | null> => {
    if (initialReferenceBlockedRef.current.has(imageDownloadOwnerRef.current + "\0" + runRef.current.id)) { setVisualAssetError("上次参考采用保存结果尚未确认，请刷新读取原项目核对；图片已保留，请勿重复生成。"); return null; }
    if (!contextReadyRef.current || navigationRef.current) { setVisualAssetError("请先选择并加载项目，再生成参考图。"); return null; }
    if (visualAssetGenerationRef.current || !token || visualAssetBatchRef.current && visualAssetBatchRef.current !== batch) return null;
    try {
      const pending = readStoryboardAssetAttempts(window.localStorage, userId);
      if (pending.length) { setPendingAssetAttempts(pending); setVisualAssetError("原资产请求结果仍待确认，请先点击查询原请求；本次未提交"); return null; }
    } catch { setVisualAssetError("无法确认资产原请求记录，已阻止新生成"); return null; }
    const model = referenceImageModel;
    let input: DrawerVisualAssetInput;
    try { input = storyboardFirstThreeViewInput(rawInput, rawInput.threeView?.petState, rawInput.threeView?.sourceAssetId); }
    catch (error) { setVisualAssetError(error instanceof Error ? error.message : "三视图身份未确认，本次未提交。"); return null; }
    if ((runRef.current.visualAssetWorkspace?.candidates.length || 0) >= 32) { setVisualAssetError("本项目已有32项候选，请使用新项目继续生成；已有候选均已保留。"); return null; }
    if (!model || visualAssetGenerationIssue || !input.prompt.trim()) {
      setVisualAssetError(visualAssetGenerationIssue || "请先选择可用的生图模型并填写资产提示词"); return null;
    }
    const price = storyboardImagePrice(model, referenceImageResolution);
    if (!Number.isFinite(price) || price < 0) { setVisualAssetError("资产生成报价尚未确认，本次未提交"); return null; }
    const requestedResolution = readReferenceImageSettings(runRef.current).resolution;
    if (requestedResolution !== referenceImageResolution) { setVisualAssetError(`当前模型不支持所选${requestedResolution}，请选择兼容模型或清晰度；本次未提交。`); return null; }
    const sourceAsset = input.threeView?.sourceAssetId ? runRef.current.visualAssetPlan?.assets.find(asset => asset.id === input.planId) : undefined;
    const sourceCandidate = sourceAsset ? selectedVisualAssetCandidate(sourceAsset, visualAssetCandidates, runRef.current.id) : undefined;
    if (input.threeView?.sourceAssetId) {
      if (!sourceAsset?.source || sourceAsset.role !== input.role || !["character", "pet"].includes(input.role)
        || (sourceAsset.source.assetId !== input.threeView.sourceAssetId && sourceCandidate?.assetId !== input.threeView.sourceAssetId)) {
        setVisualAssetError("所选身份参考的归属或采用状态未确认；可取消使用已有图，直接依据身份描述生成三视图。本次未提交。"); return null;
      }
      const capabilities = getImageModelCapabilities(model);
      if (!capabilities.supportsReferenceInput || capabilities.maxReferenceImages < 1) { setVisualAssetError("当前模型不能接收身份参考图，请选择兼容模型，或取消使用已有图直接生成。"); return null; }
    }
    const basePrompt = input.threeView ? buildStoryboardThreeViewPrompt(input.role as "character" | "pet", input.threeView.petState, input.prompt, Boolean(sourceAsset)) : input.prompt.trim();
    // 身份锁定必须进入请求，否则模型只能“看图猜”；没有锁定项时保持原文
    const identityLock = sourceAsset?.identityLock?.trim();
    const generationPrompt = identityLock ? `${basePrompt}\n身份锁定：${identityLock}；除允许变化外保持一致。` : basePrompt;
    const sourceIdentity = sourceAsset ? JSON.stringify(sourceAsset.source) : undefined;
    if (batch) {
      if (visualAssetBatchRef.current !== batch || batch.runId !== runRef.current.id || batch.modelId !== readReferenceImageSettings(runRef.current).modelId
        || batch.resolution !== effectiveImageResolution(model, readReferenceImageSettings(runRef.current).resolution) || batch.ratio !== readReferenceImageSettings(runRef.current).ratio
        || batch.isCurrent && !batch.isCurrent() || batch.price !== price || batch.inputs.get(input.planId) !== JSON.stringify(input) || batch.started.has(input.planId)) {
        setVisualAssetError("资产批次参数已变化，剩余资产未提交，请重新确认"); return null;
      }
      batch.started.add(input.planId);
    }
    visualAssetGenerationRef.current = true;
    setVisualAssetGenerating(true); setVisualAssetError("");
    try {
      const runId = runRef.current.id;
      const frozenRatio = batch?.ratio || readReferenceImageSettings(runRef.current).ratio;
      const frozenResolution = batch?.resolution || referenceImageResolution;
      const referenceUrls = sourceAsset ? await resolveVisualAssetUrls({ mode: "selected", assets: [sourceAsset] }) : [];
      if (sourceAsset && (referenceUrls.length !== 1 || referenceUrls[0].assetId !== sourceAsset.source?.assetId
        || JSON.stringify(runRef.current.visualAssetPlan?.assets.find(asset => asset.id === input.planId)?.source) !== sourceIdentity)) {
        throw new Error("当前主图的归属、可读性或选用状态未确认，本次未提交三视图。");
      }
      if (!await saveVisualAssetContext(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("当前项目未保存确认，本次未提交资产生成");
      if (batch?.isCurrent && !batch.isCurrent()) throw new Error("连续制作已暂停或输入已改变，本项未提交。");
      if (!scopeMountedRef.current || !contextReadyRef.current || runRef.current.id !== runId || readReferenceImageSettings(runRef.current).modelId !== model.id || readReferenceImageSettings(runRef.current).ratio !== frozenRatio
        || effectiveImageResolution(model, readReferenceImageSettings(runRef.current).resolution) !== frozenResolution || storyboardImagePrice(model, frozenResolution) !== price
        || sourceAsset && JSON.stringify(runRef.current.visualAssetPlan?.assets.find(asset => asset.id === input.planId)?.source) !== sourceIdentity) {
        throw new Error("项目、模型、画幅或报价已改变，本次未提交资产生成，请重新确认");
      }
      const clientTraceId = `visual_asset_trace_${crypto.randomUUID()}`;
      const attempt: StoryboardAssetAttempt = { ...(referenceOnly ? { referenceSessionId: runId } : { projectId: runId }), planId: input.planId, role: input.role, name: input.name.trim(), prompt: generationPrompt,
        derivedFromAssetId: sourceAsset?.source?.assetId, identityState: input.threeView?.petState,
        tags: input.tags, customCategory: input.customCategory,
        modelId: model.id, modelName: storyboardImageModelName(model), resolution: frozenResolution, ratio: frozenRatio, quotedPrice: price,
        clientTraceId, clientIdempotencyKey: `visual_asset_key_${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
      // Persist and read back before dispatch. Timeout, parsing errors and reload retain this exact request.
      updateAssetAttempts([attempt]);
      const response = await fetch("/api/image/generate", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(320_000),
        body: JSON.stringify({ prompt: input.threeView ? generationPrompt : buildVisualAssetPrompt(input.role, generationPrompt), mode: "local", modelId: model.id,
          style: "", aspectRatio: attempt.ratio, resolution: attempt.resolution, referenceImageUrls: referenceUrls.map(item => item.previewUrl),
          referenceUsage: input.role === "character" || input.role === "pet" ? "character-identity" : "general",
          clientTraceId, clientIdempotencyKey: attempt.clientIdempotencyKey, noRetry: true,
          strictSingleSubmit: true, clientNodeId: `${runId}-${input.planId}`,
          clientNodeTitle: `${visualAssetRoleLabel(input.role)}视觉资产`, historySurface: "storyboard-workbench" }),
      });
      const data = await response.json() as { images?: Array<{ url?: string; assetId?: string; storageKey?: string; recordId?: string }>; recordId?: string; error?: string; code?: string; upstreamCalled?: boolean; billed?: boolean; taskSubmitted?: boolean; state?: string; canResubmit?: boolean };
      const generated = data.images?.[0];
      if (!response.ok && assetAttemptWasNotAccepted(data)) updateAssetAttempts([]);
      if (!response.ok || !generated?.url) throw new Error(data.error || "资产生成没有取得可预览结果，请查询原任务，不要重复提交");
      if (!scopeMountedRef.current || !contextReadyRef.current || runRef.current.id !== runId) throw new Error("当前项目已切换，生成结果保留在原任务历史中");
      const recordId = String(generated.recordId || data.recordId || "").trim();
      const permanentId = String(generated.assetId || "").trim();
      if (!permanentId && !/^[a-f0-9]{64}$/u.test(recordId)) throw new Error("图片返回但生成记录未确认，请保留原请求并查询状态");
      if (runRef.current.directorIntake && !/^[a-f0-9]{64}$/u.test(recordId)) throw new Error("角色图片的生成历史尚未确认，请查询原任务；本次不会重新生成。");
      const candidate: DrawerVisualAsset = { assetId: runRef.current.directorIntake ? `generated_${recordId}` : permanentId || `generated_${recordId}`, planId: input.planId,
        previewUrl: generated.url, role: input.role, name: input.name.trim(), prompt: generationPrompt, tags: input.tags, customCategory: input.customCategory,
        derivedFromAssetId: attempt.derivedFromAssetId, identityState: attempt.identityState,
        historyRecordId: recordId || undefined, storageKey: runRef.current.directorIntake ? undefined : generated.storageKey, projectId: referenceOnly ? undefined : runId,
        modelId: model.id, modelName: storyboardImageModelName(model), quotedPrice: price, createdAt: new Date().toISOString(), saved: false };
      const next = rememberVisualAssetCandidate(candidate, runId);
      if (!await saveVisualAssetContext(createStoryboardPersistenceSnapshot(next), true)) throw new Error("图片已生成，但项目候选保存未确认；原请求已保留，请查询原请求，不要重新生成。");
      if (!scopeMountedRef.current || runRef.current.id !== runId) throw new Error("结果已保存到原项目，请回到原项目查看。");
      updateAssetAttempts([]);
      setNotice("资产候选已生成，请预览后选用；尚未应用或加入资产库");
      return candidate;
    } catch (error) { setVisualAssetError(error instanceof Error ? error.message : "资产生成状态待确认，请查询原任务"); return null; }
    finally { visualAssetGenerationRef.current = false; setVisualAssetGenerating(Boolean(visualAssetBatchRef.current)); }
  }, [readReferenceImageSettings, referenceImageModel, referenceImageResolution, visualAssetGenerationIssue, rememberVisualAssetCandidate, saveVisualAssetContext, token, updateAssetAttempts, userId, referenceOnly, resolveVisualAssetUrls, visualAssetCandidates]);

  const generateVisualAssets = useCallback(async (inputs: DrawerVisualAssetInput[]) => {
    if (!contextReadyRef.current || navigationRef.current) return [];
    if (visualAssetGenerationIssue) { setVisualAssetError(visualAssetGenerationIssue); return []; }
    if (visualAssetBatchRef.current || visualAssetGenerationRef.current || !referenceImageModel || referenceImageSelectionIssue) return [];
    let frozen: DrawerVisualAssetInput[];
    try { frozen = structuredClone(inputs).map(input => storyboardFirstThreeViewInput(input, input.threeView?.petState, input.threeView?.sourceAssetId)); }
    catch (error) { setVisualAssetError(error instanceof Error ? error.message : "三视图身份未确认，本次未提交。"); return []; }
    const frozenSettings = readReferenceImageSettings(runRef.current);
    if (frozenSettings.resolution !== referenceImageResolution) { setVisualAssetError("请确认当前模型支持的参考图清晰度；本次未提交。"); return []; }
    if (!frozen.length || frozen.length > 16 || new Set(frozen.map(item => item.planId)).size !== frozen.length
      || frozen.some(item => !item.name.trim() || !item.prompt.trim())) return [];
    const price = storyboardImagePrice(referenceImageModel, referenceImageResolution);
    if (!Number.isFinite(price) || price < 0) return [];
    const batch: VisualAssetBatchAuthorization = { runId: runRef.current.id, modelId: referenceImageModel.id, resolution: referenceImageResolution,
      ratio: readReferenceImageSettings(runRef.current).ratio, price, inputs: new Map(frozen.map(item => [item.planId, JSON.stringify(item)])), started: new Set() };
    visualAssetBatchRef.current = batch; setVisualAssetGenerating(true);
    const results: (DrawerVisualAsset | null)[] = [];
    try {
      for (const input of frozen) { const result = await generateVisualAsset(input, batch); results.push(result); if (!result) break; }
      return results;
    } finally { visualAssetBatchRef.current = null; setVisualAssetGenerating(false); }
  }, [readReferenceImageSettings, referenceImageModel, referenceImageResolution, referenceImageSelectionIssue, visualAssetGenerationIssue, generateVisualAsset]);

  const openVisualAssetStudio = useCallback(async (slotId?: string, slotDrafts?: StoryboardVisualAssetDraft[]) => {
    if (!contextReadyRef.current || navigationRef.current || visualAssetGenerationRef.current || visualAssetMutationRef.current || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size) return;
    navigationRef.current = true; setNavigating(true);
    try {
      if (slotId && !runRef.current.visualAssetWorkspace?.drafts.some(draft => draft.planId === slotId) && !runRef.current.visualAssetPlan?.assets.some(asset => asset.id === slotId)) {
        if (!slotDrafts?.some(draft => draft.planId === slotId)) throw new Error("参考位置不存在，请重新选择。");
        const current = runRef.current;
        const workspace = normalizeStoryboardVisualAssetWorkspace({ ...current.visualAssetWorkspace, drafts: slotDrafts, candidates: current.visualAssetWorkspace?.candidates || [] })!;
        const next = { ...current, visualAssetWorkspace: workspace };
        runRef.current = next; setRun(next);
      }
      const snapshot = createStoryboardPersistenceSnapshot(runRef.current);
      const fingerprint = JSON.stringify(snapshot);
      if (!await saveStoryboardProject(snapshot, true)) throw new Error("项目未保存成功，仍留在当前工作台，请重试。");
      if (!scopeMountedRef.current || runRef.current.id !== snapshot.id || JSON.stringify(createStoryboardPersistenceSnapshot(runRef.current)) !== fingerprint) throw new Error("项目内容已变化，请重新打开角色参考。");
      router.push('/storyboard-workbench/visual-assets?projectId=' + encodeURIComponent(snapshot.id) + (slotId ? '&slotId=' + encodeURIComponent(slotId) : ''));
    } catch (error) { setNotice(error instanceof Error ? error.message : "未能打开角色参考"); navigationRef.current = false; setNavigating(false); }
  }, [router, saveStoryboardProject]);

  const selectVisualAssetMode = useCallback(async (mode: "off" | "selected"): Promise<boolean> => {
    if (!contextReadyRef.current || navigationRef.current) return false;
    if (visualAssetMutationRef.current || visualAssetGenerationRef.current || referenceUploadOperationRef.current || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size || boardExportLocksRef.current.size) return false;
    const current = runRef.current;
    const owner = userId + "\0" + token;
    const sameContext = () => scopeMountedRef.current && runRef.current.id === current.id && imageDownloadOwnerRef.current === owner;
    const unresolvedCards = mode === "off" ? current.cards.filter((card) => unresolvedVisualAssetBindingIds(card, current.visualAssetPlan).length) : [];
    if (unresolvedCards.length) {
      setNotice(`分段 ${unresolvedCards.map((card) => card.order).join("、")} 的旧视觉资产参考图缺少归属记录，无法安全区分自动参考与手动上传；请重新确认或手动清除参考图后再切换普通模式。原模式与参考图已保留`);
      return false;
    }
    const next: WorkbenchRun = {
      ...current,
      updatedAt: Date.now(),
      executionMode: mode === "selected" ? "reference" : "ordinary",
      visualAssetPlan: mode === "selected"
        ? { ...current.visualAssetPlan, mode: "selected", assets: current.visualAssetPlan?.assets || [] }
        : { ...current.visualAssetPlan, mode: "off", assets: current.visualAssetPlan?.assets || [] },
      // Switching back to ordinary mode removes only references owned by this
      // visual-asset plan. Manually uploaded references stay on their cards.
      cards: mode === "off"
        ? current.cards.map((card) => suspendVisualAssetBindings(card, current.visualAssetPlan))
        : current.cards,
    };
    runRef.current = next;
    setRun(next);
    visualAssetMutationRef.current = true;
    setVisualAssetSaving(true);
    let saved = false;
    try { saved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true); }
    catch { /* Keep the unconfirmed transition out of the success path. */ }
    finally { if (scopeMountedRef.current && runRef.current.id === current.id) { visualAssetMutationRef.current = false; setVisualAssetSaving(false); } }
    if (!sameContext()) {
      if (scopeMountedRef.current && runRef.current.id === current.id) { const restored = rollbackVisualAssetMode(runRef.current, current, next); runRef.current = restored; setRun(restored); }
      return false;
    }
    if (!saved) {
      const restored = rollbackVisualAssetMode(runRef.current, current, next);
      runRef.current = restored;
      setRun(restored);
      setNotice("模式切换未保存确认，已恢复原模式和参考图；请稍后重试");
      return false;
    }
    if (mode === "selected") {
      setNotice("已切换到视觉资产模式：生成并确认资产后会自动绑定到任务1…N");
    } else {
      setNotice("已切换到普通模式：不再向分镜卡自动附加视觉资产参考图");
    }
    return true;
  }, [saveStoryboardProject, token, userId]);

  useEffect(() => {
    if (!storageReady || !token) return;
    let active = true;
    const inspectionOwner = userId + "\0" + token;
    const inspectionRunId = runRef.current.id;
    const controllers = new Set<AbortController>();

    const inspectActiveImages = async () => {
      const candidates = runRef.current.cards.filter((card) => (
        !imageSubmissionsRef.current.has(card.id)
        && !isCompletedInlineImageReceipt(card)
        && !isUnavailableCompletedStoryboardImage(card)
        && (card.imageStatus === "running"
          || card.imageStatus === "queued"
          || card.imageRetryBlocked === true)
      ));
      await Promise.all(candidates.map(async (card) => {
        if (!active || imageStatusChecksRef.current.has(card.id)) return;
        const requestId = String(card.imageClientRequestId || "").trim();
        const traceId = deriveStoryboardImageTraceId(card);
        const operation = Symbol("image-status-inspection");
        imageInspectionVersionsRef.current.set(card.id, operation);
        const isCurrentInspection = (current = runRef.current) => active && scopeMountedRef.current && contextReadyRef.current
          && !navigationRef.current && imageDownloadOwnerRef.current === inspectionOwner && current.id === inspectionRunId
          && imageInspectionVersionsRef.current.get(card.id) === operation
          && current.cards.some(item => item.id === card.id && String(item.imageClientRequestId || "").trim() === requestId
            && deriveStoryboardImageTraceId(item) === traceId && item.imageClientRequestFingerprint === card.imageClientRequestFingerprint
            && item.imageAttemptOrdinal === card.imageAttemptOrdinal && item.imageSubmittedAt === card.imageSubmittedAt
            && item.imageStatus === card.imageStatus && item.imageRecordId === card.imageRecordId);
        const patchInspection = (patch: Partial<WorkbenchCard>) => patchCard(card.id, patch, undefined, isCurrentInspection);
        if (!requestId || !traceId) {
          patchInspection({
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图任务缺少可核验的请求号，已锁定重试；不会自动重新生成。",
          });
          return;
        }
        imageStatusChecksRef.current.set(card.id, operation);
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const status = await inspectStoryboardImageAttempt(card, controller.signal);
          if (!isCurrentInspection() || !status) return;
          if (status.state === "rejected" && status.canResubmit === true && status.sameKeyCanResubmit === false) {
            const snapshot = card.imageRequestSnapshot;
            if (isStoryboardImageRequestSnapshot(snapshot)) {
              clearBrowserClientAttempt(`storyboard-image:${snapshot.runId}:${snapshot.cardId}`, requestId);
            }
            patchInspection({
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
          if (status.state === "expired" && status.generationCompleted === true && status.deliveryMode === "provider_url"
            && typeof status.recordId === "string" && /^[a-f0-9]{64}$/u.test(status.recordId)) {
            patchInspection({ ...storyboardGeneratedReceiptFields(status),
              imageRef: { schema: "generated_image_ref.v1", recordId: status.recordId },
              imageRecordId: status.recordId, imageDeliveryMode: "provider_url", ...storyboardImageUnavailablePatch("expired") });
            return;
          }
          if (status.state === "completed" && status.deliveryMode === "inline_ephemeral") {
            if (await restoreOwnedBoard(card.id, status.recordId, isCurrentInspection)) return;
            if (!isCurrentInspection()) return;
            const latest = runRef.current.cards.find(item => item.id === card.id);
            const keepMedia = Boolean(latest && latest.imageRecordId === status.recordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
            patchInspection({ ...storyboardInlineReceiptFields(status), imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRef: undefined, imageRecordId: status.recordId, imageDeliveryMode: "inline_ephemeral", imageRecoveryReady: false, imageRetryBlocked: !keepMedia, imageError: keepMedia ? undefined : "图片已生成且费用收据已保留；临时图片仅原页面可用，刷新后无法恢复" });
            return;
          }
          if (status.state === "completed" && status.deliveryMode === "provider_url" && status.recordId) {
            const parsed = GeneratedImageReferenceSchema.safeParse({ schema: "generated_image_ref.v1", recordId: status.recordId });
            if (parsed.success) {
              patchInspection({ ...storyboardGeneratedReceiptFields(status), imageStatus: "done", imageRef: parsed.data, imageRecordId: parsed.data.recordId, imageDeliveryMode: "provider_url", imageUrl: generatedImagePreviewUrl(parsed.data), imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined });
              return;
            }
          }
          if (status.canRecover === true) {
            if (status.state === "completed" && status.assetId) {
              try {
                const restored = await readOwnedStoryboardImage(
                  { assetId: status.assetId },
                  card.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(runRef.current),
                );
                if (!isCurrentInspection()) return;
                patchInspection({
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
                patchInspection({
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
              patchInspection({
                imageStatus: "failed",
                imageRecoveryReady: false,
                imageRetryBlocked: true,
                imageError: "原请求已有结果，但旧任务缺少完整记录；请求号已保留，请在历史中查看。",
              });
              return;
            }
            patchInspection({
              imageStatus: "running",
              imageClientTraceId: traceId,
              imageRecoveryReady: true,
              imageRetryBlocked: false,
              imageError: status.message || "图片已生成，系统正在自动完成保存和展示。",
            });
            return;
          }
          if (status.state === "processing") {
            patchInspection({
              imageStatus: "running",
              imageClientTraceId: traceId,
              imageRecoveryReady: false,
              imageRetryBlocked: true,
              imageError: status.message || "原生图任务仍在处理中；不会重复提交。",
            });
            return;
          }
          patchInspection({
            imageStatus: "failed",
            imageClientTraceId: traceId,
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: status.message || "图片结果待确认，原请求已保留；不会重复提交。",
          });
        } catch (error) {
          if (!isCurrentInspection()) return;
          patchInspection({
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: `${error instanceof Error ? error.message : "生图状态暂时无法确认"}；原请求已保留，勿重复提交。`,
          });
        } finally {
          controllers.delete(controller);
          if (imageStatusChecksRef.current.get(card.id) === operation) imageStatusChecksRef.current.delete(card.id);
        }
      }));
    };

    void inspectActiveImages();
    const timer = window.setInterval(() => { void inspectActiveImages(); }, VIDEO_POLL_INTERVAL_MS);
    return () => {
      active = false;
      controllers.forEach(controller => controller.abort());
      window.clearInterval(timer);
    };
  }, [inspectStoryboardImageAttempt, patchCard, readOwnedStoryboardImage, restoreOwnedBoard, run.id, storageReady, token, userId]);

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
    const hydrationRunId = run.id;
    const hydrationOwner = userId + "\0" + token;
    for (const card of run.cards) {
      const storageKey = String(card.imageStorageKey || "").trim();
      const hydrationKey = `${card.id}\0${String(card.imageAssetId || "")}\0${storageKey}`;
      if (!storageKey || boardExportLocksRef.current.has(card.id)
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
          const data = await response.json().catch(() => ({})) as { url?: string; assetId?: string; storageKey?: string; error?: string };
          if (data.storageKey !== storageKey || card.imageAssetId && data.assetId !== card.imageAssetId) throw new Error("故事板归属标识不一致");
          if (!response.ok || !data.url) throw new Error(data.error || "故事板图片读取失败");
          const dimensions = await browserImageReady(data.url);
          const expectedAspectRatio = card.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(runRef.current);
          if (card.imageWidth && card.imageHeight && (dimensions.width !== card.imageWidth || dimensions.height !== card.imageHeight)) throw new Error("原故事板完整尺寸已变化，未替换原图。");
          if (!imageDimensionsMatchAspectRatio(dimensions.width, dimensions.height, expectedAspectRatio)) {
            throw new Error(`实际图片 ${dimensions.width}×${dimensions.height} 与 ${expectedAspectRatio} 不一致`);
          }
          if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== hydrationOwner || runRef.current.id !== hydrationRunId || !runRef.current.cards.some(item => item.id === card.id && item.imageAssetId === card.imageAssetId && item.imageStorageKey === storageKey)) return;
          patchCard(card.id, {
            imageStatus: "done", imageRecoveryReady: false, imageRetryBlocked: false,
            imageUrl: data.url,
            imageWidth: dimensions.width,
            imageHeight: dimensions.height,
            imageValidatedAt: Date.now(),
            imageError: undefined,
          });
          hydratedStoredImageKeysRef.current.add(hydrationKey);
        })
        .catch((error) => {
          hydratedStoredImageKeysRef.current.add(hydrationKey);
          if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== hydrationOwner || runRef.current.id !== hydrationRunId || !runRef.current.cards.some(item => item.id === card.id && item.imageAssetId === card.imageAssetId && item.imageStorageKey === storageKey)) return;
          patchCard(card.id, { imageStatus: "done", imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: false,
            imageError: `${error instanceof Error ? error.message : "保存的故事板暂不可读取"}；请重新读取原图，不会重新生成。` });
        })
        .finally(() => hydratingStoredImagesRef.current.delete(card.id));
    }
  }, [patchCard, run.cards, run.id, storageReady, token, userId]);

  // 切换生图模型时，失败只代表上一次模型/渠道的尝试结束，不应把卡片永久锁死。
  // 保留 Prompt、参考图和视频 Prompt，只清理本次失败产生的临时结果，让用户可以立即重试。
  const selectImageModel = useCallback((model: ImageModel) => {
    const selectionIssue = storyboardImageModelSelectionIssue(model);
    if (selectionIssue) {
      setNotice(`${storyboardImageModelName(model)} ${publicModelSelectionNotice(selectionIssue, "该生图模型")}`);
      return;
    }
    const nextRatios = supportedImageRatios(model);
    const nextReferenceLimit = getImageModelCapabilities(model).maxReferenceImages;
    const incompatibleReferenceCards = runRef.current.cards.filter((card) => card.referenceImageUrls.length > nextReferenceLimit).length;
    setRun((current) => {
      const next = {
        ...current,
        updatedAt: Date.now(),
        imageModelId: model.id,
        // Preserve the user's chosen clarity across model switches while the new
        // model supports it; only fall back when it genuinely cannot render it.
        imageResolution: (getImageModelCapabilities(model).resolutionOptions as string[]).includes(current.imageResolution)
          ? current.imageResolution
          : preferredStoryboardImageResolution(model),
        imageRatio: nextRatios.includes(effectiveImageRatio(current)) ? effectiveImageRatio(current) : nextRatios[0] || effectiveImageRatio(current),
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
  }, []);

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
      imageRatio: isWorkbenchRatio(record.aspectRatio) ? record.aspectRatio : effectiveImageRatio(base),
      imageResolution: record.resolution || base.imageResolution,
      imageModelId: selectedModel?.id || base.imageModelId,
      cards: [{ ...base.cards[0], imagePrompt: record.prompt }],
    };
    runRef.current = next;
    setRun(next);
    explicitHistorySelectionRef.current = true;
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
    const validationOwner = userId + "\0" + token;
    const validationRunId = run.id;
    for (const card of run.cards) {
      // Owned images have one recovery path: re-sign and verify their stored
      // identity above. An expired old URL must never race that fresh result.
      if (card.imageStorageKey || card.imageStatus !== "done" || !card.imageUrl || card.imageValidatedAt) continue;
      const validationKey = JSON.stringify([validationOwner, validationRunId, card.id, card.imageRecordId, card.imageUrl]);
      if (validatingImagesRef.current.has(validationKey)) continue;
      validatingImagesRef.current.add(validationKey);
      const stillCurrent = (current = runRef.current) => scopeMountedRef.current && contextReadyRef.current && imageDownloadOwnerRef.current === validationOwner
        && current.id === validationRunId && current.cards.some(item => item.id === card.id && item.imageUrl === card.imageUrl
          && item.imageRecordId === card.imageRecordId && item.imageClientRequestId === card.imageClientRequestId
          && item.imageClientRequestFingerprint === card.imageClientRequestFingerprint
          && item.imageStatus === "done" && !item.imageStorageKey && !item.imageValidatedAt);
      void browserImageReady(card.imageUrl)
        .then(({ width, height }) => {
          if (!stillCurrent()) return;
          const expectedRatio = card.imageRequestSnapshot?.aspectRatio || activeImageRatio;
          if (!imageDimensionsMatchAspectRatio(width, height, expectedRatio)) {
            patchCard(card.id, isCompletedProviderImageReceipt(card) ? {
              ...storyboardImageUnavailablePatch("unavailable"), imageWidth: width, imageHeight: height,
              imageError: `当前读取图片 ${width}×${height} 与原画幅 ${expectedRatio} 不一致；原任务与费用收据保留，请核对原结果。`,
            } : {
              imageStatus: "failed",
              imageWidth: width,
              imageHeight: height,
              imageValidatedAt: undefined,
              imageError: `实际图片 ${width}×${height} 与 ${expectedRatio} 不一致，请重新生图`,
            }, undefined, stillCurrent);
            return;
          }
          patchCard(card.id, { imageWidth: width, imageHeight: height, imageMediaState: undefined, imageRetryBlocked: false, imageValidatedAt: Date.now(), imageError: undefined }, undefined, stillCurrent);
        })
        .catch((error) => { if (stillCurrent()) patchCard(card.id, isCompletedProviderImageReceipt(card)
          ? { ...storyboardImageUnavailablePatch(error instanceof StoryboardImagePreviewError ? error.mediaState : "unavailable"),
              ...(error instanceof StoryboardImagePreviewError ? { imageError: error.message } : {}) }
          : { imageStatus: "failed", imageValidatedAt: undefined, imageError: error instanceof Error ? error.message : "图片加载失败" }, undefined, stillCurrent); })
        .finally(() => validatingImagesRef.current.delete(validationKey));
    }
  }, [patchCard, run.cards, run.id, activeImageRatio, storageReady, token, userId]);

  const saveVisualAssetSelection = useCallback(async (selected: DrawerVisualAsset[]) => {
    if (!contextReadyRef.current || navigationRef.current) return [];
    if (!token || visualAssetMutationRef.current || visualAssetGenerationRef.current) return [];
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    const beforeSourceUpdate = runRef.current;
    const contextId = beforeSourceUpdate.id;
    const projectId = referenceOnly ? "" : contextId;
    const directorAssets = Boolean(beforeSourceUpdate.directorIntake);
    let attemptedSourceUpdate: WorkbenchRun | undefined;
    try {
      const originals = directorAssets ? selected.map(candidate => directorAssetExportCandidate(beforeSourceUpdate, candidate)) : structuredClone(selected);
      const result = await saveStoryboardVisualAssetCandidates({ selected: originals.map((candidate, index) => directorAssets
        ? { ...candidate, name: selected[index].name, tags: selected[index].tags, customCategory: selected[index].customCategory } : candidate), projectId, token,
        exported: explicitlyExportedAssetsRef.current, onSaved: (candidate, original) => {
          if (directorAssets) rememberDirectorAssetExport({ ...originals.find(item => item.planId === original.planId && item.assetId === original.assetId)!, saved: true }, contextId);
          else rememberVisualAssetCandidate(candidate, contextId, original.assetId);
        } });
      attemptedSourceUpdate = runRef.current;
      const projectSaved = !result.savedNames.length || await saveVisualAssetContext(createStoryboardPersistenceSnapshot(attemptedSourceUpdate), true);
      if (!projectSaved) {
        if (runRef.current.id === beforeSourceUpdate.id) {
          const restored = rollbackVisualAssetMode(runRef.current, beforeSourceUpdate, attemptedSourceUpdate);
          runRef.current = restored; setRun(restored);
        }
        setVisualAssetError(`已保存${result.savedNames.length}项到角色库；项目来源更新未保存，原项目引用已保留，请重试保存项目。${result.error || ""}`);
      }
      else if (result.error) setVisualAssetError(`${result.savedNames.length ? `已保存${result.savedNames.length}项；` : ""}${result.error}`);
      else setNotice(`已保存${result.savedNames.length}项到我的视觉资产；项目引用由你另行选择应用`);
      return directorAssets ? result.assets.map(candidate => ({ ...originals.find(item => item.planId === candidate.planId)!, saved: candidate.saved })) : result.assets;
    } catch (error) {
      if (attemptedSourceUpdate && runRef.current.id === beforeSourceUpdate.id) {
        const restored = rollbackVisualAssetMode(runRef.current, beforeSourceUpdate, attemptedSourceUpdate);
        runRef.current = restored; setRun(restored);
      }
      setVisualAssetError(error instanceof Error ? error.message : "资产保存未确认，当前候选仍保留"); return [];
    }
    finally { visualAssetMutationRef.current = false; setVisualAssetSaving(false); }
  }, [rememberDirectorAssetExport, rememberVisualAssetCandidate, saveVisualAssetContext, token, referenceOnly]);

  const applyVisualAssets = useCallback(async (mutation: DrawerVisualAssetMutation, saveToLibrary: boolean, removeDraft = false): Promise<boolean> => {
    if (initialReferenceBlockedRef.current.has(imageDownloadOwnerRef.current + "\0" + runRef.current.id)) { setVisualAssetError("上次参考采用保存结果尚未确认，请刷新读取原项目核对后再修改引用。"); return false; }
    if (referenceOnly && !removeDraft) { setVisualAssetError("参考图库可制作和保存图片；请从分镜工作台选择需要使用的位置。"); return false; }
    if (!contextReadyRef.current || navigationRef.current) { setVisualAssetError("请先选择并加载项目，再选用参考图。"); return false; }
    if (visualAssetMutationRef.current || imageSubmissionsRef.current.size) { setVisualAssetError("请等待当前参考更新或生图提交完成"); return false; }
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    const before = runRef.current;
    const owner = imageDownloadOwnerRef.current;
    let attempted: WorkbenchRun | undefined;
    let rollbackBaseline = before;
    const savedNames: string[] = [];
    const assertEditable = (cards: WorkbenchCard[]) => {
      if (cards.some(card => imageAttemptNeedsResolution(card) || card.imageBillingState === "pending"
        || videoNeedsRequestReconciliation(card) || isActiveVideoStatus(card.videoStatus)
        || (card.videoStatus === "failed" && card.videoRetryable !== true)
        || (card.videoBillingState !== undefined && card.videoBillingState !== null
          && !(VIDEO_HISTORY_SETTLED_BILLING_STATES as readonly string[]).includes(card.videoBillingState))
        || videoSubmissionsRef.current.has(card.id) || boardExportLocksRef.current.has(card.id))) {
        throw new Error("对应段落仍有原请求或费用待确认，请先查询原任务；当前参考与全部结果保持不变。");
      }
    };
    const confirmMediaUpdate = (cards: WorkbenchCard[]) => {
      const count = cards.filter(card => card.imageUrl || card.imageRef || card.imageRecordId || card.videoUrl || card.videoTaskId).length;
      return !count || window.confirm(`此参考影响 ${count} 个已有媒体的段落。更换后保留旧分镜与视频，并标记需要更新；请手动重新生成分镜后再生成视频。本次仅更新引用，不生成、不扣费。`);
    };
    try {
      if (mutation.type === "remove" && (visualAssetGenerationRef.current
        || pendingAssetAttempts.some(attempt => attempt.planId === mutation.slotId)
        || referenceUploadPending.some(upload => upload.contextId === before.id && upload.draft.planId === mutation.slotId))) {
        throw new Error("这张参考仍有生成或上传结果待确认，请先查询原请求；本次未删除。");
      }
      const priorAffected = before.cards.filter(card => requestedVisualAssetIds(card, before.visualAssetPlan).includes(mutation.slotId));
      if (mutation.type === "remove") {
        assertEditable(priorAffected);
        if (!confirmMediaUpdate(priorAffected)) return false;
        attempted = { ...removeStoryboardReference(before, mutation.slotId, removeDraft), updatedAt: Date.now() };
        attempted.directorIntake = pruneStoryboardDirectorAssetConfirmations(attempted, mutation.slotId);
        runRef.current = attempted; setRun(attempted);
        if (!await saveVisualAssetContext(createStoryboardPersistenceSnapshot(attempted), true)) throw new Error("参考卡片删除保存未确认，卡片与引用仍保留，请重试。");
        if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== owner || runRef.current.id !== before.id) return false;
        if (removeDraft) setVisualAssetCandidates(items => items.filter(item => item.planId !== mutation.slotId || item.projectId && item.projectId !== before.id));
        setNotice(removeDraft ? "已删除这张参考卡及项目引用；图库图片、旧分镜和视频均保留。" : "已移除此项项目引用；图库图片、旧分镜和视频均保留。");
        return true;
      }
      let candidates = [{ ...mutation.asset, planId: mutation.slotId }];
      if (candidates.some(candidate => { const existing = before.visualAssetPlan?.assets.find(asset => asset.id === candidate.planId); return existing && existing.role !== candidate.role; })) throw new Error("替换参考时类别必须一致，请为其他类别新建参考位置。");
      const candidateToAsset = (candidate: DrawerVisualAsset) => storyboardCandidateToAsset(candidate, before.visualAssetPlan);
      let plan = mutateVisualAssetSlot(before.visualAssetPlan || { mode: "selected", assets: [] }, { type: "upsert", asset: candidateToAsset(candidates[0]) });
      const affected = affectedVisualAssetCards(before.cards, before.visualAssetPlan, plan);
      assertEditable(affected);
      if (!confirmMediaUpdate(affected)) return false;
      if (saveToLibrary) {
        const directorAssets = Boolean(before.directorIntake);
        const originals = directorAssets ? candidates.map(candidate => directorAssetExportCandidate(before, candidate)) : candidates;
        const result = await saveStoryboardVisualAssetCandidates({ selected: originals, projectId: before.id, token: token || "", exported: explicitlyExportedAssetsRef.current,
          onSaved: (candidate, original) => {
            if (directorAssets) rememberDirectorAssetExport({ ...originals.find(item => item.planId === original.planId && item.assetId === original.assetId)!, saved: true }, before.id);
            else rememberVisualAssetCandidate(candidate, before.id, original.assetId);
          } });
        savedNames.push(...result.savedNames);
        if (result.savedNames.length && !await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("资产库已保存，项目候选记录未保存确认；请保留本页后重试保存项目。");
        if (result.error) throw new Error(result.error);
        candidates = directorAssets ? result.assets.map(candidate => ({ ...originals.find(item => item.planId === candidate.planId)!, saved: candidate.saved })) : result.assets;
        if (!candidates[0]) throw new Error("参考候选未确认，未修改项目引用。");
        plan = mutateVisualAssetSlot(before.visualAssetPlan || { mode: "selected", assets: [] }, { type: "upsert", asset: candidateToAsset(candidates[0]) });
      }
      const adoptedSlotId = candidateToAsset(candidates[0]).id;
      const neededIds = new Set([adoptedSlotId, ...affected.flatMap(card => requestedVisualAssetIds(card, plan))]);
      const urls = await resolveVisualAssetUrls({ ...plan, assets: plan.assets.filter(asset => neededIds.has(asset.id)), defaultAssetIds: undefined });
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== owner) throw new Error("登录身份已改变，未在当前页面更新引用");
      const adoptedSource = plan.assets.find(asset => asset.id === adoptedSlotId)?.source;
      if (!adoptedSource || !urls.some(url => url.assetId === adoptedSource.assetId && url.previewUrl.trim())) throw new Error("参考图片归属或可读性未确认，未更新引用");
      if ((!saveToLibrary && runRef.current !== before) || runRef.current.id !== before.id) throw new Error("项目内容已变化，请重新确认引用");
      const latest = runRef.current;
      assertEditable(affectedVisualAssetCards(latest.cards, latest.visualAssetPlan, plan));
      rollbackBaseline = latest;
      const affectedIds = new Set(affected.map(card => card.id));
      const cards = latest.cards.map(card => affectedIds.has(card.id) ? markVisualAssetMediaStale(card,
        prepareSelectedCardSourceUpdate({ card, previousPlan: latest.visualAssetPlan, plan, urls, limit: referenceLimit }).card,
        latest.visualAssetPlan, plan) : card);
      attempted = { ...latest, updatedAt: Date.now(), visualAssetPlan: plan, cards };
      // Explicit Apply confirms this exact generated image in the same durable save.
      attempted.directorIntake = confirmStoryboardDirectorAsset(attempted, adoptedSlotId, new Date().toISOString());
      runRef.current = attempted; setRun(attempted);
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(attempted), true)) throw new Error("项目引用保存未确认，候选仍保留");
      submittedRunIdsRef.current.add(attempted.id);
      setNotice(`已确认${plan.assets.length}项项目参考；${cards.filter(card => card.visualAssetSelectionMode === "project").length}段使用项目默认，单独选择的分段保持各自引用${saveToLibrary ? "，新资产已保存到库" : ""}`);
      return true;
    } catch (error) {
      let rollbackNotice = "";
      if (attempted && scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === before.id) {
        const latest = runRef.current;
        const selectionRestored = rollbackSelectionTransaction(latest, rollbackBaseline, attempted);
        const confirmationRestored = selectionRestored !== latest && latest.directorIntake === attempted.directorIntake
          ? { ...selectionRestored, directorIntake: rollbackBaseline.directorIntake } : selectionRestored;
        const restored = removeDraft && confirmationRestored !== latest && latest.visualAssetWorkspace === attempted.visualAssetWorkspace
          ? { ...confirmationRestored, visualAssetWorkspace: rollbackBaseline.visualAssetWorkspace } : confirmationRestored;
        runRef.current = restored; setRun(restored);
        rollbackNotice = restored !== latest ? "；已恢复本次变更前的引用" : "；检测到后续编辑，当前页面保留最新内容，请核对并重新保存";
      }
      const message = visualAssetSelectionError(error, "参考应用失败") + rollbackNotice;
      setVisualAssetError(savedNames.length ? `${savedNames.join("、")}已保存到库；${message}` : message);
      return false;
    } finally { visualAssetMutationRef.current = false; setVisualAssetSaving(false); }
  }, [referenceLimit, rememberDirectorAssetExport, rememberVisualAssetCandidate, resolveVisualAssetUrls, saveStoryboardProject, saveVisualAssetContext, token, referenceOnly, pendingAssetAttempts, referenceUploadPending]);

  // User-initiated completion only: restoring history never silently selects a new source.
  // Generation/upload has already saved its receipt and released its own lock here.
  const withFirstReferenceAdoption = useCallback(async (
    input: DrawerVisualAssetInput, operation: () => Promise<DrawerVisualAsset | null>,
  ): Promise<DrawerVisualAsset | null> => {
    const original = runRef.current;
    const owner = imageDownloadOwnerRef.current;
    if (initialReferenceBlockedRef.current.has(owner + "\0" + original.id)) { setVisualAssetError("上次参考采用保存结果尚未确认，请刷新读取原项目核对后继续；已有图片保留。"); return null; }
    const draft = original.visualAssetWorkspace?.drafts.find(item => item.planId === input.planId);
    // Director turnarounds stay candidates until the user inspects and applies each image.
    const canAdopt = !original.directorIntake && !referenceOnly && Boolean(draft) && draft?.role === input.role
      && !original.visualAssetPlan?.assets.find(asset => asset.id === input.planId)?.source
      && (original.visualAssetPlan?.mode !== "off" || original.visualAssetPlan.assets.length === 0);
    const draftIdentity = JSON.stringify(draft);
    const planIdentity = JSON.stringify(original.visualAssetPlan);
    const result = await operation();
    if (!result || !canAdopt) return result;
    const intentCurrent = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && Boolean(userId && token) && imageDownloadOwnerRef.current === owner && owner === userId + "\0" + token
      && runRef.current.id === original.id && result.planId === input.planId && result.role === input.role
      && JSON.stringify(runRef.current.visualAssetPlan) === planIdentity
      && JSON.stringify(runRef.current.visualAssetWorkspace?.drafts.find(item => item.planId === input.planId)) === draftIdentity;
    if (!intentCurrent() || visualAssetMutationRef.current
      || initialReferenceBlockedRef.current.has(owner + "\0" + original.id)) return result;
    visualAssetMutationRef.current = true; initialReferenceAdoptionRef.current = true; setVisualAssetSaving(true);
    const before = runRef.current;
    let saveStarted = false;
    const assertCurrent = () => {
      if (!intentCurrent() || runRef.current !== before) throw new Error("身份、项目、参考或分镜已改变，自动关联未确认，图片候选已保留。");
    };
    try {
      const busy = Boolean(visualAssetGenerationRef.current || visualAssetBatchRef.current || referenceUploadOperationRef.current
        || referenceUploadPendingRef.current.length || readStoryboardAssetAttempts(window.localStorage, userId).length
        || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size || boardExportLocksRef.current.size || batchAuthorizationRef.current);
      const adoption = await adoptFirstStoryboardReference({ document: before, candidate: result,
        asset: storyboardCandidateToAsset(result, before.visualAssetPlan), busy, limit: referenceLimit,
        assertCurrent, resolve: resolveVisualAssetUrls,
        save: async next => { saveStarted = true; return saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true, true); },
        commit: next => { runRef.current = next; setRun(next); submittedRunIdsRef.current.add(next.id); },
      });
      if (adoption.status === "adopted") {
        setNotice(`“${result.name}”已自动采用并关联${adoption.affectedCount}个分段；每段可单独选择参考，生成分镜和视频由你点击执行。`);
      } else {
        setNotice("参考图已保存为候选；已有结果或参考操作需要先确认，可查看图片下方的采用状态。");
      }
    } catch (error) {
      // The original paid operation succeeded. Never retry it for an adoption/save failure.
      if (saveStarted) initialReferenceBlockedRef.current.add(owner + "\0" + original.id);
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === original.id) {
        const reason = error instanceof Error && !/^FIRST_REFERENCE_/u.test(error.message) ? error.message : "参考图片归属或自动关联保存尚未确认";
        setVisualAssetError(`图片已保存为候选；${reason}${saveStarted ? "。请刷新读取原项目核对后继续，勿重新生成图片。" : "。可明确点击使用这张后继续。"}`);
      }
    } finally { initialReferenceAdoptionRef.current = false; visualAssetMutationRef.current = false; if (scopeMountedRef.current) setVisualAssetSaving(false); }
    return result;
  }, [referenceOnly, referenceLimit, resolveVisualAssetUrls, saveStoryboardProject, token, userId]);

  const updateVisualAssetSelection = useCallback(async (assetIds: string[], cardId?: string, mode?: "project" | "custom") => {
    if (!contextReadyRef.current || navigationRef.current || visualAssetMutationRef.current || imageSubmissionsRef.current.size) return;
    const before = runRef.current;
    const plan = before.visualAssetPlan;
    if (plan?.mode !== "selected") return;
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    let attempted: WorkbenchRun | undefined;
    try {
      const target = cardId ? before.cards.find(card => card.id === cardId) : undefined;
      if (cardId && !target) throw new Error("原分段不存在，请重新选择");
      const requestedCard = target && mode === "project" ? { ...target, visualAssetSelectionMode: "project" as const } : undefined;
      const subset = requestedCard ? requestedVisualAssetPlan(requestedCard, plan) : { ...plan, assets: plan.assets.filter(asset => assetIds.includes(asset.id)), defaultAssetIds: undefined };
      const urls = await resolveVisualAssetUrls(subset);
      if (runRef.current !== before) throw new Error("项目内容已变化，请重新确认引用");
      if (target) {
        const changed = requestedCard
          ? rebindSelectedCard({ card: requestedCard, previousPlan: plan, plan, urls, limit: referenceLimit })
          : chooseCustomAssets({ card: target, plan, assetIds, urls, limit: referenceLimit });
        attempted = { ...before, updatedAt: Date.now(), cards: before.cards.map(card => card.id === target.id ? changed : card) };
      } else {
        const changed = changeProjectDefaults({ cards: before.cards, plan, defaultAssetIds: assetIds, urls, limit: referenceLimit });
        attempted = { ...before, updatedAt: Date.now(), cards: changed.cards, visualAssetPlan: changed.plan };
      }
      const changedReferences = attempted.cards.filter(card => visualAssetReferenceContentChanged(
        before.cards.find(item => item.id === card.id)!, card, before.visualAssetPlan, attempted!.visualAssetPlan!));
      if (changedReferences.some(card => imageAttemptNeedsResolution(card) || card.imageBillingState === "pending"
        || videoNeedsRequestReconciliation(card) || isActiveVideoStatus(card.videoStatus)
        || (card.videoStatus === "failed" && card.videoRetryable !== true)
        || (card.videoBillingState !== undefined && card.videoBillingState !== null
          && !(VIDEO_HISTORY_SETTLED_BILLING_STATES as readonly string[]).includes(card.videoBillingState))
        || videoSubmissionsRef.current.has(card.id) || boardExportLocksRef.current.has(card.id))) {
        attempted = undefined; throw new Error("原媒体任务或费用尚未确认，未更改参考选择。");
      }
      const changedMedia = changedReferences.filter(card => {
        const old = before.cards.find(item => item.id === card.id)!;
        return Boolean(old.imageUrl || old.imageRef || old.imageRecordId || old.videoUrl || old.videoTaskId);
      });
      if (changedMedia.length && !window.confirm(`参考选择将影响 ${changedMedia.length} 个已有媒体的段落。旧结果保留并标记需要更新；本次不生成、不扣费。`)) { attempted = undefined; return; }
      attempted = { ...attempted, cards: attempted.cards.map(card => markVisualAssetMediaStale(before.cards.find(item => item.id === card.id)!, card, before.visualAssetPlan, attempted!.visualAssetPlan!)) };
      runRef.current = attempted; setRun(attempted);
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(attempted), true)) throw new Error("参考选择保存未确认");
      setNotice(cardId ? "已保存本段参考选择" : "已保存项目默认，跟随项目的分段已更新");
    } catch (error) {
      let rollbackNotice = "";
      if (attempted) {
        const latest = runRef.current;
        const restored = rollbackSelectionTransaction(latest, before, attempted);
        runRef.current = restored; setRun(restored);
        rollbackNotice = restored !== latest ? "；已恢复本次变更前的选择" : "；检测到后续编辑，当前页面保留最新内容，请核对并重新保存";
      }
      setVisualAssetError(visualAssetSelectionError(error, "参考选择未确认") + rollbackNotice);
    } finally { visualAssetMutationRef.current = false; setVisualAssetSaving(false); }
  }, [referenceLimit, resolveVisualAssetUrls, saveStoryboardProject]);

  const addCard = useCallback(async () => {
    if (!contextReadyRef.current || navigationRef.current) return;
    if (visualAssetMutationRef.current) return;
    const current = runRef.current;
    if (current.cards.length >= MAX_CARDS) return;
    visualAssetMutationRef.current = true;
    setVisualAssetSaving(true);
    try {
      const newCard = createCard(current.cards.length + 1);
      const urls = await resolveVisualAssetUrls(requestedVisualAssetPlan(newCard, current.visualAssetPlan));
      if (runRef.current !== current) { setNotice("当前项目内容已变化，请重新添加分段"); return; }
      const boundCard = rebindSelectedCard({ card: newCard, plan: current.visualAssetPlan, urls, limit: referenceLimit });
      const next = { ...current, updatedAt: Date.now(), cards: [...current.cards, boundCard] };
      runRef.current = next;
      setRun(next);
      setVisualAssetError("");
    } catch (error) { setVisualAssetError(visualAssetSelectionError(error, "参考图未就绪，未添加分段")); } finally { visualAssetMutationRef.current = false; setVisualAssetSaving(false); }
  }, [referenceLimit, resolveVisualAssetUrls]);

  const copyCompletedImageToNewCard = useCallback((cardId: string) => {
    if (!contextReadyRef.current || navigationRef.current || visualAssetMutationRef.current || batchMode) return;
    setRun(current => {
      const original = current.cards.find(card => card.id === cardId);
      if (!original || !isUnavailableCompletedStoryboardImage(original) || current.cards.length >= MAX_CARDS) return current;
      const copied = { ...createCard(current.cards.length + 1),
        imagePrompt: original.imagePrompt, imageExactText: original.imageExactText,
        imageTextLayoutEnabled: original.imageTextLayoutEnabled, imageAnnotationIssue: original.imageAnnotationIssue, videoPrompt: original.videoPrompt, videoInputs: normalizeStoryboardVideoInputs(original.videoInputs),
        narration: original.narration, referenceImageUrls: [...original.referenceImageUrls],
        visualAssetRefs: original.visualAssetRefs?.map(ref => ({ ...ref })),
        visualAssetRefsMode: original.visualAssetRefsMode, visualAssetSelectionMode: original.visualAssetSelectionMode };
      const next = { ...current, updatedAt: Date.now(), cards: [...current.cards, copied] };
      runRef.current = next;
      return next;
    });
    setNotice("已复制提示词与参考到新分镜，原卡和费用收据保留；请在新卡确认报价后手动提交，本次未生成或扣费。");
  }, [batchMode]);

  const retryCompletedImageRead = useCallback((card: WorkbenchCard) => {
    if (card.imageMediaState !== "unavailable" || !isUnavailableCompletedStoryboardImage(card) || !card.imageRef) return;
    patchCard(card.id, { imageMediaState: undefined, imageRetryBlocked: false, imageError: undefined,
      imageUrl: generatedImagePreviewUrl(card.imageRef), imageValidatedAt: undefined }, undefined,
    current => current.cards.some(item => item.id === card.id && item.imageRecordId === card.imageRecordId && item.imageMediaState === "unavailable"));
  }, [patchCard]);

  const removeCard = useCallback((cardId: string) => {
    if (imageSubmissionsRef.current.has(cardId) || videoSubmissionsRef.current.has(cardId)) return;
    setRun((current) => {
      const target = current.cards.find((card) => card.id === cardId);
      if (!target || imageSubmissionsRef.current.has(cardId) || videoSubmissionsRef.current.has(cardId) || imageAttemptNeedsResolution(target) || isActiveVideoStatus(target.videoStatus) || current.cards.length === 1) return current;
      const next = {
        ...current,
        updatedAt: Date.now(),
        cards: current.cards.filter((card) => card.id !== cardId).map((card, index) => ({ ...card, order: index + 1 })),
      };
      runRef.current = next;
      return next;
    });
  }, []);

  const copyText = useCallback(async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`${label}已复制`);
  }, []);

  const pastePrompt = useCallback(async (cardId: string, field: "imagePrompt" | "videoPrompt", label: string) => {
    const owner = imageDownloadOwnerRef.current;
    const projectId = runRef.current.id;
    const canPaste = () => {
      const card = runRef.current.cards.find(item => item.id === cardId);
      return scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
        && imageDownloadOwnerRef.current === owner && runRef.current.id === projectId && !!card
        && !imageSubmissionsRef.current.has(cardId) && !videoSubmissionsRef.current.has(cardId)
        && !imageAttemptNeedsResolution(card) && !isActiveVideoStatus(card.videoStatus) && !batchAuthorizationRef.current;
    };
    if (!canPaste()) { setNotice("当前分段任务正在处理，请等待完成后修改提示词。"); return; }
    if (!navigator.clipboard?.readText) {
      setNotice("当前浏览器不支持直接读取剪贴板，请在输入框中使用 Ctrl+V");
      return;
    }
    try {
      const value = await navigator.clipboard.readText();
      if (!canPaste()) { setNotice("任务或项目已改变，未粘贴提示词。"); return; }
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

  const applyImportedSegments = useCallback(async (input: {
    projectId?: string;
    executionMode?: StoryboardExecutionMode;
    segments: Array<StoryboardAgentOutputSegment & { visualAssetRefs?: StoryboardVisualAssetRef[]; directorExecution?: StoryboardDirectorExecution }>;
    visualAssetPlan?: StoryboardVisualAssetPlan;
    directorIntake?: StoryboardDirectorIntakeState;
    draftImportNotice?: string;
    wardrobePlan?: StoryboardWardrobePlan;
    environmentGroups?: WorkbenchRun["environmentGroups"];
    title: string;
    ratio?: WorkbenchRatio | null;
    videoDuration?: 8 | 10 | 15;
    successNotice: string;
  }): Promise<string | null> => {
    if (visualAssetMutationRef.current || visualAssetGenerationRef.current || referenceUploadOperationRef.current || pendingAssetAttempts.length) {
      setNotice("参考资产正在处理或结果待核验，请先确认原请求后再导入新项目");
      return null;
    }
    if (runRef.current.cards.some((card) => imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus))) {
      setNotice("当前有任务正在生成、自动保存或待核验，请等待系统处理完成");
      return null;
    }
    if (!input.segments.length || input.segments.length > MAX_CARDS) {
      setNotice(`一次只能导入 1 至 ${MAX_CARDS} 段分镜`);
      return null;
    }

    const current = runRef.current;
    const importGeneration = workspaceGenerationRef.current;
    visualAssetMutationRef.current = true;
    setVisualAssetSaving(true);
    try {
      const now = Date.now();
      const hasProposedPlan = input.visualAssetPlan !== undefined;
      const importedMode = input.executionMode || (input.visualAssetPlan?.mode === "selected" ? "reference" : "ordinary");
      const proposedPlan = input.visualAssetPlan ? { ...input.visualAssetPlan, mode: importedMode === "reference" ? "selected" as const : "off" as const } : undefined;
      const proposedUrls = await resolveVisualAssetUrls(proposedPlan);
      const proposedPlanResolved = Boolean(proposedPlan?.mode === "selected" && proposedPlan.assets.every((asset) =>
        proposedUrls.some((item) => item.assetId === asset.source?.assetId)));
      const activeVisualAssetPlan = hasProposedPlan
        ? proposedPlan
        : current.visualAssetPlan?.mode === "selected" ? current.visualAssetPlan : undefined;
      const importedVisualAssetWorkspace = createImportedStoryboardVisualAssetWorkspace(activeVisualAssetPlan);
      if (input.directorIntake && activeVisualAssetPlan?.mode === "selected") {
        // An assets-only package owns explicit drafts even when a legacy generation policy is absent.
        importedVisualAssetWorkspace.drafts = activeVisualAssetPlan.assets
          .filter(asset => (asset.role === "character" || asset.role === "pet") && !asset.source)
          .map(asset => ({ planId: asset.id, role: asset.role, name: asset.name,
            prompt: asset.referencePrompts.find(reference => reference.kind === "turnaround")!.prompt,
            tagsText: (asset.tags || []).join("，"), customCategory: asset.customCategory || "" }));
      }
      // Keep every URL that did resolve. A failed, unrelated environment asset
      // must not block a segment that explicitly requests another scene.
      const inheritedUrls = hasProposedPlan ? proposedUrls : await resolveVisualAssetUrls(activeVisualAssetPlan);
      if (importGeneration !== workspaceGenerationRef.current || runRef.current !== current) return null;
      const segmentBindingFailures: string[] = [];
      const bindImportedSegment = (segment: StoryboardAgentOutputSegment & { visualAssetRefs?: StoryboardVisualAssetRef[] }) => {
        const refsSpecified = segment.visualAssetRefs !== undefined;
        const scopedCard = { ...createCard(1), sceneId: segment.sceneId, sceneZone: segment.sceneZone, visualAssetRefsMode: refsSpecified ? "explicit" as const : "legacy" as const, visualAssetSelectionMode: refsSpecified ? "custom" as const : segment.sceneId ? undefined : "project" as const, visualAssetRefs: segment.visualAssetRefs || [] };
        const requestedIds = requestedVisualAssetIds(scopedCard, activeVisualAssetPlan);
        const binding = bindVisualAssetPlan(scopedCard, activeVisualAssetPlan, inheritedUrls, referenceLimit, requestedIds);
        if (proposedPlanResolved && activeVisualAssetPlan?.mode === "selected" && (binding.missing.length || binding.overLimit.length)) {
          segmentBindingFailures.push(`分段${segment.sourceNumber || ""}:${[...binding.missing, ...binding.overLimit].join(",")}`);
        }
        return binding;
      };
      const legacyBinding = bindImportedSegment(input.segments[0]);
      if (segmentBindingFailures.length) throw new Error(`部分分段环境资产未能按段绑定：${segmentBindingFailures.join("；")}`);
      archiveRunSnapshot("批量建卡前");
      const next: WorkbenchRun = {
        ...current,
        id: input.projectId || createId("storyboard-run"),
        executionMode: importedMode,
        chainRevision: 1,
        createdAt: now,
        updatedAt: now,
        ratio: input.ratio && isWorkbenchRatio(input.ratio) ? input.ratio : current.ratio,
        // Three equal views need a landscape sheet; the original video ratio stays in the intake.
        ...(input.directorIntake?.phase === "assets" ? { imageRatio: "16:9" as const }
          : input.ratio && isWorkbenchRatio(input.ratio) ? { imageRatio: input.ratio } : {}),
        videoDuration: input.videoDuration || current.videoDuration,
        title: input.title,
        directorIntake: input.directorIntake,
        draftImportNotice: input.draftImportNotice,
        wardrobePlan: input.wardrobePlan || current.wardrobePlan,
        environmentGroups: input.environmentGroups || current.environmentGroups || [],
        visualAssetPlan: { ...activeVisualAssetPlan, mode: importedMode === "reference" ? "selected" : "off", assets: activeVisualAssetPlan?.assets || [] },
        visualAssetWorkspace: importedVisualAssetWorkspace,
        cards: input.segments.map((segment, index) => {
          const binding = index === 0 ? legacyBinding : bindImportedSegment(segment);
          return {
          ...binding.card,
          ...createCard(index + 1),
          label: `分段 ${index + 1}`,
          sourceNumber: segment.sourceNumber,
          narration: segment.narration,
          imagePrompt: segment.imagePrompt,
          videoPrompt: segment.videoPrompt,
          directorExecution: segment.directorExecution,
          sceneId: segment.sceneId,
          sceneZone: segment.sceneZone,
          styleLock: segment.styleLock,
          sceneLock: segment.sceneLock,
          camera: segment.camera,
          dynamicState: segment.dynamicState || [],
          capabilityGaps: segment.capabilityGaps || [],
           bottomPanelRole: segment.bottomPanelRole,
           qualityChecks: segment.qualityChecks,
           wardrobeChangeEvents: segment.wardrobeChangeEvents,
          visualAssetRefsMode: segment.visualAssetRefs !== undefined ? "explicit" : "legacy",
          visualAssetSelectionMode: segment.visualAssetRefs !== undefined ? "custom" : segment.sceneId ? undefined : "project",
          referenceImageUrls: [...binding.card.referenceImageUrls],
          // An unresolved new plan stays pending; it never inherits old images.
          visualAssetRefs: (() => {
            const expected = segment.visualAssetRefs !== undefined
              ? segment.visualAssetRefs.filter((ref) => !activeVisualAssetPlan || activeVisualAssetPlan.assets.some((asset) => asset.id === ref.assetId))
              : (activeVisualAssetPlan?.mode === "selected"
                ? requestedVisualAssetIds({ ...createCard(1), visualAssetSelectionMode: segment.sceneId ? undefined : "project", sceneId: segment.sceneId, sceneZone: segment.sceneZone, visualAssetRefsMode: "legacy" }, activeVisualAssetPlan)
                    .flatMap((assetId) => {
                      const asset = activeVisualAssetPlan.assets.find((item) => item.id === assetId);
                      return asset ? [{ assetId: asset.id, role: asset.role, referenceKinds: [visualAssetReferenceKind(asset.role, asset.cameraCoverage)], sceneId: asset.sceneId, sceneZone: asset.sceneZone, cameraCoverage: asset.cameraCoverage }] : [];
                    }) : []);
            const boundIds = new Set(binding.card.visualAssetRefs.map((ref) => ref.assetId));
            return [...binding.card.visualAssetRefs, ...expected.filter((ref) => !boundIds.has(ref.assetId))];
          })(),
          };
        }),
      };
      if (segmentBindingFailures.length) throw new Error(`部分分段环境资产未能按段绑定：${segmentBindingFailures.join("；")}`);
      runRef.current = next;
      setRun(next);
      const pendingAssetNotice = proposedPlan?.mode === "selected" && !proposedPlanResolved
        ? `；Agent 提出了 ${proposedPlan.assets.length} 个视觉资产计划，但尚未与“我的视觉资产”中的真实图片匹配，请确认资产后再生成`
        : "";
      const bindingWarning = segmentBindingFailures.length
        ? `部分分段环境资产未能按段绑定：${segmentBindingFailures.join("；")}`
        : "";
      setNotice(`${input.successNotice}${pendingAssetNotice}${bindingWarning ? `；${bindingWarning}` : ""}`);
      return next.id;
    } finally {
      if (importGeneration === workspaceGenerationRef.current) { visualAssetMutationRef.current = false; setVisualAssetSaving(false); }
    }
  }, [archiveRunSnapshot, pendingAssetAttempts.length, referenceLimit, resolveVisualAssetUrls]);

  const confirmGeneralScriptHandoff = useCallback(async () => {
    if (generalScriptHandoff.status !== "ready") return;
    const workspaceGeneration = workspaceGenerationRef.current;
    const { handoff } = generalScriptHandoff;
    const plan = handoff.bridge.workbenchImport;
    const importedDurations = new Set(
      plan.segments.map((segment) => segment.targetDurationSeconds).filter((duration): duration is 8 | 10 | 15 => Boolean(duration)),
    );
    if (importedDurations.size > 1) {
      setNotice("通用短剧包含多个视频时长，当前工作台不能把不同段落安全合并到一个运行；请按时长分批导入");
      return;
    }
    const importedRunId = await applyImportedSegments({
      segments: plan.segments,
      title: plan.title,
      ratio: plan.workbenchRatio,
      videoDuration: [...importedDurations][0],
      successNotice: `已导入 ${plan.segments.length} 个生产段：生图 Prompt 和视频 Prompt 已建卡；没有调用模型或扣费`,
    });
    if (!importedRunId || workspaceGeneration !== workspaceGenerationRef.current) return;

    setGeneralScriptImportedRunId(importedRunId);
    setGeneralScriptHandoff({ status: "imported", handoff });
  }, [applyImportedSegments, generalScriptHandoff]);

  const confirmAgentHandoff = useCallback(async () => {
    if (agentHandoff.status !== "ready" || agentImportBusyRef.current || !token || !userId || !contextReadyRef.current) return;
    agentImportBusyRef.current = true;
    const { handoff, plan } = agentHandoff;
    const ownerAtStart = userId + "\0" + token;
    const workspaceGeneration = workspaceGenerationRef.current;
    const isCurrentImport = () => scopeMountedRef.current && imageDownloadOwnerRef.current === ownerAtStart
      && workspaceGeneration === workspaceGenerationRef.current;
    try {
    const projectId = await storyboardAgentImportProjectId(userId, handoff.handoff_id, handoff.payload);
    if (!isCurrentImport()) return;
    if (runRef.current.id === projectId) {
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("同一交接的项目保存未确认，当前草稿保留；请核对原项目，不会另建副本。");
      if (!isCurrentImport()) return;
      acknowledgeAgentWorkbenchHandoffAcrossTabs("storyboard-workbench", userId, handoff.handoff_id);
      setAgentHandoff({ status: "imported", handoff, plan });
      router.replace(`/storyboard-workbench?projectId=${encodeURIComponent(projectId)}`);
      return;
    }
    const lookup = await fetch(`/api/storyboard/projects?id=${encodeURIComponent(projectId)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!isCurrentImport()) return;
    if (lookup.ok) {
      const existing = normalizeRun(await cloud.restore(projectId));
      if (!existing || existing.id !== projectId) throw new Error("同一交接已有项目，但当前读取未确认；未新建或覆盖草稿。");
      if (!isCurrentImport()) return;
      runRef.current = existing; setRun(existing); setConfirmedProjectSnapshot(existing.id + ":" + JSON.stringify(createStoryboardPersistenceSnapshot(existing)));
      acknowledgeAgentWorkbenchHandoffAcrossTabs("storyboard-workbench", userId, handoff.handoff_id);
      setAgentHandoff({ status: "imported", handoff, plan });
      setNotice("已打开这次交接的原项目；已有编辑、参考和媒体保持不变，未重复创建。");
      router.replace(`/storyboard-workbench?projectId=${encodeURIComponent(projectId)}`);
      return;
    }
    const lookupBody = await lookup.json().catch(() => ({})) as { code?: string };
    if (!isCurrentImport()) return;
    if (lookup.status !== 404 || lookupBody.code !== "PROJECT_NOT_FOUND") throw new Error("交接项目状态暂不可确认，本次未新建项目；请稍后重新读取。");
    const importedRunId = await applyImportedSegments({
      projectId,
      executionMode: plan.executionMode,
      segments: plan.phase === "assets" ? [{ sourceNumber: 1, narration: plan.sourceScript, imagePrompt: "", videoPrompt: "" }] : plan.segments.map((segment) => ({
        sourceNumber: segment.sourceIndex,
        narration: segment.narration,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
        directorExecution: plan.promptDraft || plan.phase === "draft" ? undefined : buildStoryboardDirectorExecution(plan, segment),
        visualAssetRefs: segment.visualAssetRefs,
        sceneId: segment.sceneId,
        sceneZone: segment.sceneZone,
        styleLock: segment.styleLock,
        sceneLock: segment.sceneLock,
        camera: segment.camera,
        dynamicState: segment.dynamicState,
        capabilityGaps: segment.capabilityGaps,
         bottomPanelRole: segment.bottomPanelRole,
         qualityChecks: segment.qualityChecks,
         wardrobeChangeEvents: segment.wardrobeChangeEvents,
      })),
      wardrobePlan: plan.wardrobePlan,
      draftImportNotice: plan.phase === "draft" && !plan.promptDraft ? `${plan.legacyDraftWarning || "历史提示词草稿，请核对原备注与分段"}\n原特殊备注：${plan.originalInput.special_notes || "无"}` : undefined,
      directorIntake: plan.phase === "assets" || plan.phase === "planned" ? { phase: plan.phase, input: plan.originalInput, sourceMessageId: plan.messageId } : undefined,
      visualAssetPlan: plan.visualAssetPlan,
      environmentGroups: plan.environmentGroups,
      title: plan.phase === "assets" ? "角色三视图 · 分镜前置" : plan.promptDraft && !plan.intakeVerified ? `提示词草稿（待核对）· ${plan.segments.length} 段` : `Agent 分镜 · ${plan.segments.length} 个生产段`,
      ratio: plan.settings.aspectRatio,
      videoDuration: plan.settings.targetDurationSeconds,
      successNotice: plan.promptDraft ? `已导入 ${plan.segments.length} 段生图和视频提示词${plan.visualAssetPlan?.assets.length ? `及 ${plan.visualAssetPlan.assets.length} 张角色参考卡` : ""}，未生成、未扣费。${plan.importWarnings?.join(" ") || ""}` : plan.phase === "draft" ? "历史提示词草稿已导入，未生成、未扣费。请先核对原备注与每段提示词，再逐段操作。" : plan.phase === "planned" ? `完整计划已导入：角色参考和 ${plan.segments.length} 段图、视频提示词均已就绪。可在工作台连续制作，无需返回对话；本次导入未生成、未扣费。` : plan.phase === "assets" ? `已导入${storyboardIdentityAssetLabel(plan.visualAssetPlan)}提示词。请先生成并采用图片，再复制续写卡回原智能体继续分镜。` : `已导入 ${plan.segments.length} 个 Agent 分镜段；生图和视频 Prompt 已建卡，未调用模型、未扣费`,
    });
    if (!importedRunId) return;
    if (!isCurrentImport() || runRef.current.id !== projectId) return;
    if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("分镜已完整建卡，但项目保存尚未确认；当前草稿保留，不会另建副本或生成媒体。");
    if (!isCurrentImport()) return;
    acknowledgeAgentWorkbenchHandoffAcrossTabs("storyboard-workbench", userId, handoff.handoff_id);
    setAgentHandoff({ status: "imported", handoff, plan });
    router.replace(`/storyboard-workbench?projectId=${encodeURIComponent(projectId)}`);
    } catch (error) { if (isCurrentImport()) setNotice(error instanceof Error ? error.message : "交接保存未确认，当前内容保留。"); }
    finally { if (isCurrentImport()) agentImportBusyRef.current = false; }
  }, [agentHandoff, applyImportedSegments, cloud.restore, router, saveStoryboardProject, token, userId]);

  const copyDirectorResume = useCallback(async () => {
    const current = runRef.current;
    const owner = imageDownloadOwnerRef.current;
    try {
      const text = buildStoryboardDirectorResumeCard(current);
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(current), true)) throw new Error("资产项目尚未保存确认，请稍后再复制续写卡。");
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== owner || runRef.current !== current) throw new Error("资产或项目已改变，请重新确认后复制。");
      await navigator.clipboard.writeText(text);
      setNotice("续写卡已复制。粘贴到原智能体对话继续；系统会核验已采用的人物、宠物三视图，再输出分镜提示词。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "复制未完成，请重试复制；已有图片会保留。");
    }
  }, [saveStoryboardProject]);

  const restoreDirectorOriginalAssets = useCallback(async () => {
    if (!contextReadyRef.current || navigationRef.current || !token || visualAssetMutationRef.current || visualAssetGenerationRef.current) return false;
    const before = runRef.current;
    const slotIds = directorLegacyAssetSlotIds(before);
    if (!slotIds.length) return false;
    const owner = imageDownloadOwnerRef.current;
    const assertCurrent = () => {
      if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || imageDownloadOwnerRef.current !== owner || runRef.current !== before) {
        throw new Error("项目或登录身份已变化，原图未应用；请重新读取原项目。");
      }
    };
    visualAssetMutationRef.current = true; setVisualAssetSaving(true); setVisualAssetError("");
    try {
      const recovered: DrawerVisualAsset[] = [];
      for (const slotId of slotIds) {
        assertCurrent();
        const response = await fetch(`/api/storyboard/director-assets/original?projectId=${encodeURIComponent(before.id)}&assetId=${encodeURIComponent(slotId)}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const data = await response.json() as { candidate?: DrawerVisualAsset; error?: string };
        if (!response.ok || !data.candidate?.previewUrl?.trim()) throw new Error(data.error || "原生成图暂不可读取，旧项目与图库副本仍保留。");
        const candidate = normalizeStoryboardVisualAssetWorkspace({ drafts: [], candidates: [data.candidate] })!.candidates[0];
        const asset = before.visualAssetPlan?.assets.find(item => item.id === slotId);
        if (!asset || candidate.planId !== slotId || candidate.projectId !== before.id || candidate.role !== asset.role
          || candidate.assetId !== `generated_${candidate.historyRecordId}` || candidate.storageKey !== undefined || !candidate.prompt?.trim()) {
          throw new Error("原生成图回执不完整，旧项目保持不变。");
        }
        recovered.push({ ...candidate, previewUrl: data.candidate.previewUrl });
      }
      assertCurrent();
      const restoredIds = new Set(recovered.map(candidate => candidate.planId));
      const workspace = before.visualAssetWorkspace || { drafts: [], candidates: [] };
      const next: WorkbenchRun = { ...before, updatedAt: Date.now(), visualAssetWorkspace: normalizeStoryboardVisualAssetWorkspace({ ...workspace,
        candidates: [...recovered, ...workspace.candidates.filter(candidate => !restoredIds.has(candidate.planId))],
      }), directorIntake: before.directorIntake ? { ...before.directorIntake,
        confirmedAssets: (before.directorIntake.confirmedAssets || []).filter(confirmation => !restoredIds.has(confirmation.planId)),
      } : undefined };
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true)) throw new Error("原生成图已找回，但项目保存未确认；旧状态保留，请重试恢复，不会重新生成。");
      assertCurrent();
      runRef.current = next; setRun(next);
      setVisualAssetCandidates(items => [...recovered, ...items.filter(candidate => candidate.projectId !== before.id || !restoredIds.has(candidate.planId))]);
      setVisualAssetRecoveryRevision(revision => revision + 1);
      setNotice("已恢复原生成图，请查看人物和宠物图片后分别点击“使用这张”。本次仅找回原图，未生成新图、未重新确认采用。");
      return true;
    } catch (error) {
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === before.id) {
        setVisualAssetError(error instanceof Error ? error.message : "原生成图恢复未确认，旧项目与图库副本仍保留。");
      }
      return false;
    } finally { visualAssetMutationRef.current = false; if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner) setVisualAssetSaving(false); }
  }, [saveStoryboardProject, token]);

  useEffect(() => {
    if (!storageReady || !cloudReady || projectContext !== "ready" || agentHandoff.status !== "ready"
      || new URLSearchParams(window.location.search).get("autoImport") !== "1") return;
    if (automaticAgentImportRef.current === agentHandoff.handoff.handoff_id) return;
    automaticAgentImportRef.current = agentHandoff.handoff.handoff_id;
    void confirmAgentHandoff();
  }, [agentHandoff, cloudReady, confirmAgentHandoff, projectContext, storageReady]);

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
        const data = await response.json().catch(() => ({})) as { file?: { url?: string; key?: string }; error?: string };
        if (!response.ok) throw new Error(data.error || `${file.name}上传失败`);
        // 私有存储不返回公开 url：用 storageKey 换取当前用户可读的地址，避免线上“上传失败”
        const owned = data.file?.url ? { url: data.file.url } : data.file?.key ? await readOwnedStoryboardImage({ storageKey: data.file.key }) : null;
        if (!owned?.url) throw new Error(data.error || `${file.name}上传结果未能读取，请到我的图片核对`);
        urls.push(owned.url);
      }
      patchCard(card.id, { referenceImageUrls: (replaceExisting ? urls : [...card.referenceImageUrls, ...urls]).slice(0, referenceLimit),
        ...(replaceExisting ? { visualAssetRefs: [] } : {}) });
      setNotice(`分段${card.order}已${replaceExisting ? "替换" : "加入"}${urls.length}张参考图`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "参考图上传失败");
    } finally {
      setUploadingCardId("");
    }
  }, [patchCard, readOwnedStoryboardImage, referenceLimit, token]);

  const ensureInitialReferencesAdopted = useCallback(async (): Promise<boolean> => {
    if (resolveStoryboardExecutionMode(runRef.current) !== "reference") return true;
    const before = runRef.current;
    const owner = imageDownloadOwnerRef.current;
    if (before.directorIntake?.phase === "planned") {
      try { collectStoryboardDirectorReferenceBindings(before, before.directorIntake.input); return true; }
      catch (error) { setNotice(error instanceof Error ? error.message : "请先逐项确认角色三视图。"); return false; }
    }
    if (initialReferenceBlockedRef.current.has(owner + "\0" + before.id)) { setNotice("上次参考采用保存结果尚未确认，请刷新页面重新读取原项目核对后继续；本次未提交生图"); return false; }
    const confirmNewIdentityAdopted = () => {
      const current = runRef.current;
      const choices = visibleReferenceChoicesRef.current;
      if ((current.visualAssetPlan?.mode !== "selected" && referenceDisplayMode !== "reference") || choices?.projectId !== current.id
        || choices.owner !== imageDownloadOwnerRef.current) return true;
      const pending = current.visualAssetWorkspace?.candidates.find(candidate => candidate.projectId === current.id
        && (candidate.role === "character" || candidate.role === "pet")
        && choices.ids[candidate.planId] === candidate.assetId
        && !current.visualAssetPlan?.assets.find(asset => asset.id === candidate.planId)?.source?.assetId);
      if (!pending) return true;
      setNotice(`上方“${pending.name}”仍是未采用候选，请先点击“使用这张”；若不需要此角色，可删除该参考卡或切换普通模式。本次未提交分镜生成。`);
      return false;
    };
    const missing = before.visualAssetPlan?.mode === "selected" && before.visualAssetPlan.generationPolicy?.initialRequiredAssetIds.some(id => !before.visualAssetPlan!.assets.find(asset => asset.id === id)?.source);
    if (!missing) return confirmNewIdentityAdopted();
    if (initialReferenceAdoptionRef.current || visualAssetMutationRef.current) { setNotice("参考采用正在保存，请等待确认；本次未提交生图"); return false; }
    const choices = visibleReferenceChoicesRef.current;
    const ids = { ...(choices?.ids || {}) };
    const assertCurrent = () => {
      if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || !token || !userId
        || imageDownloadOwnerRef.current !== owner || owner !== userId + "\0" + token || runRef.current !== before
        || choices?.owner !== owner || choices.projectId !== before.id
        || visibleReferenceChoicesRef.current?.owner !== owner || visibleReferenceChoicesRef.current.projectId !== before.id
        || JSON.stringify(visibleReferenceChoicesRef.current.ids) !== JSON.stringify(ids)) throw new Error("身份、项目或可见参考已改变，本次未提交生图");
    };
    initialReferenceAdoptionRef.current = true;
    visualAssetMutationRef.current = true; setVisualAssetSaving(true);
    let saveStarted = false;
    try {
      const busy = Boolean(visualAssetGenerationRef.current || visualAssetBatchRef.current || referenceUploadOperationRef.current
        || referenceUploadPendingRef.current.length || readStoryboardAssetAttempts(window.localStorage, userId).length
        || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size || boardExportLocksRef.current.size || batchAuthorizationRef.current);
      await adoptInitialStoryboardReferences({ document: before, visibleIds: ids, busy, limit: referenceLimit,
        assertCurrent, resolve: resolveVisualAssetUrls,
        save: async next => { saveStarted = true; return saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true, true); },
        commit: next => { runRef.current = next; setRun(next); },
      });
      return confirmNewIdentityAdopted();
    } catch (error) {
      if (saveStarted) initialReferenceBlockedRef.current.add(owner + "\0" + before.id);
      if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === before.id) setNotice(error instanceof Error ? error.message : "参考采用尚未确认，本次未提交生图");
      return false;
    } finally { initialReferenceAdoptionRef.current = false; visualAssetMutationRef.current = false; if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner) setVisualAssetSaving(false); }
  }, [referenceDisplayMode, referenceLimit, resolveVisualAssetUrls, saveStoryboardProject, token, userId]);

  const generateImage = useCallback(async (cardId: string, batchAuthorization?: StoryboardBatchAuthorization) => {
    const invocationRunId = runRef.current.id;
    const invocationOwner = userId + "\0" + token;
    if (resolveStoryboardExecutionMode(runRef.current) !== "chained" && runRef.current.directorIntake?.phase === "assets") { setNotice("请先生成计划中已声明角色的三视图并确认采用，再复制续写卡回原智能体生成分镜提示词。"); return null; }
    if (resolveStoryboardExecutionMode(runRef.current) === "reference" && runRef.current.directorIntake?.phase === "planned") {
      try { collectStoryboardDirectorReferenceBindings(runRef.current, runRef.current.directorIntake.input); }
      catch (error) { setNotice(error instanceof Error ? error.message : "请先逐项确认角色三视图。"); return null; }
    }
    // A click that silently returns reads as a broken button; tell the user why.
    if (!contextReadyRef.current) { setNotice("页面数据尚未就绪，请稍候再试或刷新页面"); return null; }
    if (navigationRef.current || view !== "workbench") return null;
    if (!scopeMountedRef.current) { setNotice("页面正在切换，请稍后再试"); return null; }
    let assertPlannedDirectorReferencesCurrent: () => void;
    try { assertPlannedDirectorReferencesCurrent = resolveStoryboardExecutionMode(runRef.current) !== "reference" ? () => undefined : await verifyPlannedDirectorReferences(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "角色原生成回执核验失败，本次未提交。"); return null; }
    if (!scopeMountedRef.current) { setNotice("页面正在切换，请稍后再试"); return null; }
    if (imageDownloadOwnerRef.current !== invocationOwner || runRef.current.id !== invocationRunId) { setNotice("当前账号或项目已变化，请刷新页面后重试"); return null; }
    if (visualAssetMutationRef.current) { setNotice("参考资产正在保存，请确认完成后再生成分镜图"); return null; }
    let current = runRef.current;
    const imageSubmissionOwner = imageDownloadOwnerRef.current;
    let card = current.cards.find((item) => item.id === cardId);
    if (resolveStoryboardExecutionMode(current) === "chained" && chainBusyRef.current && !batchAuthorization && !card?.imageRecoveryReady) { setNotice("串联正在等待当前原任务，请暂停后再单独生成。"); return null; }
    if (boardExportLocksRef.current.has(cardId)) { setNotice("本段正在导出分镜板，请稍后再试"); return null; }
    if (imageSubmissionsRef.current.has(cardId)) {
      setNotice(`分段${card?.order || ""}的生图请求已经提交，请勿重复点击`);
      return null;
    }
    if (!token) { setNotice("请先登录后再生成"); return null; }
    if (!card) { setNotice("分镜卡片不存在，请刷新后重试"); return null; }
    if (card.imageReferenceState !== "stale" && isOwnedStoryboardBoard(card) && (!hasValidatedImage(card) || card.imageRecoveryReady)) { setNotice(`正在恢复分段${card.order}的已有分镜图，请稍候`); await restoreOwnedBoard(cardId, card.imageRecordId); return null; }
    try { assertBatchAuthorization(current, card, "images", batchAuthorizationRef.current, batchAuthorization); }
    catch (error) { setNotice(error instanceof Error ? error.message : "批量参数已改变，本段未提交"); return null; }
    if (card.imageRetryBlocked) {
      setNotice(isCompletedInlineImageReceipt(card)
        ? `分段${card.order}的图片已完成，临时图片不可恢复，已禁止重复提交`
        : `分段${card.order}的原生图结果仍待确认，已禁止重复提交`);
      return null;
    }
    if (isActiveVideoStatus(card.videoStatus)) {
      setNotice(`分段${card.order}的视频仍在生成，请先终止视频任务再重新生图`);
      return null;
    }
    const targetDuration = current.videoDuration === 8 || current.videoDuration === 10 || current.videoDuration === 15
      ? current.videoDuration
      : 10;
    const narration = String(card.narration || inferStoryboardNarration(card.label)).trim();
    const narrationCapacity = validateStoryboardNarrationCapacity(narration, targetDuration);
    if (!narrationCapacity.ok) {
      setNotice(`分段${card.order}口播${narrationCapacity.effectiveCharacters}个有效字/${targetDuration}秒，超过每秒6字要求；请重新分段后再生成图片`);
      return null;
    }
    if (!batchAuthorization && !imageAttemptNeedsResolution(card)) {
      if (!await ensureInitialReferencesAdopted()) return null;
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== invocationOwner || runRef.current.id !== invocationRunId
        || imageSubmissionsRef.current.has(cardId) || visualAssetMutationRef.current || navigationRef.current) return null;
      current = runRef.current; card = current.cards.find(item => item.id === cardId);
      if (!card) return null;
    }
    imageSubmissionsRef.current.add(cardId);
    const imageOperation = Symbol(cardId);
    imageSubmissionOperationsRef.current.set(cardId, imageOperation);
    let clientIdempotencyKey = "";
    let clientTraceId = "";
    let requestSnapshot: StoryboardImageRequestSnapshot | null = null;
    let preparedImageBatchInput: string | undefined;
    let completedInlineReceipt: Partial<WorkbenchCard> | null = null;
    let imageProviderDispatched = false;
    let rollbackImageSubmission: () => void = () => undefined;
    let expectedImageInput = storyboardImageSubmissionInput(current, card);
    const sameImageSubmissionScope = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && imageDownloadOwnerRef.current === imageSubmissionOwner && runRef.current.id === current.id;
    const sameImageRequestCurrent = () => {
      const latest = runRef.current.cards.find(item => item.id === cardId);
      return sameImageSubmissionScope() && imageSubmissionOperationsRef.current.get(cardId) === imageOperation && imageSubmissionsRef.current.has(cardId)
        && Boolean(clientIdempotencyKey && latest?.imageClientRequestId === clientIdempotencyKey);
    };
    const assertImageSubmissionCurrent = () => {
      const latest = runRef.current.cards.find(item => item.id === cardId);
      if (!sameImageSubmissionScope() || imageSubmissionOperationsRef.current.get(cardId) !== imageOperation || !latest || !imageSubmissionsRef.current.has(cardId)
        || storyboardImageSubmissionInput(runRef.current, latest) !== expectedImageInput) {
        throw Object.assign(new Error("项目、账号、提示词或参考输入已改变，本次未提交生图"),
          { requestAccepted: false, confirmedRejected: true, upstreamCalled: false, billed: false });
      }
    };
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
          setNotice(`分段${card.order}缺少原请求号，无法安全续接`);
          return null;
        }
        clientIdempotencyKey = card.imageClientRequestId;
        clientTraceId = deriveStoryboardImageTraceId(card);
        const confirmed = await inspectStoryboardImageAttempt(card).catch(() => null);
        if (!sameImageRequestCurrent()) return null;
        if (confirmed?.state === "completed" && confirmed.deliveryMode === "inline_ephemeral") {
          if (await restoreOwnedBoard(cardId, confirmed.recordId)) return null;
          if (!sameImageRequestCurrent()) return null;
          const latest = runRef.current.cards.find(item => item.id === cardId);
          const keepMedia = Boolean(latest && latest.imageRecordId === confirmed.recordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
          patchCard(cardId, { ...storyboardInlineReceiptFields(confirmed), imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRef: undefined, imageRecordId: confirmed.recordId, imageDeliveryMode: "inline_ephemeral", imageRecoveryReady: false, imageRetryBlocked: !keepMedia, imageError: keepMedia ? undefined : "临时图片仅原页面可用，费用收据已保留；本次未重新生成" });
          return null;
        }
        if (confirmed?.state === "completed" && confirmed.deliveryMode === "provider_url" && confirmed.recordId) {
          const ref = GeneratedImageReferenceSchema.parse({ schema: "generated_image_ref.v1", recordId: confirmed.recordId });
          const preview = generatedImagePreviewUrl(ref);
          const decoded = await browserImageReady(preview);
          if (!sameImageRequestCurrent()) return null;
          patchCard(cardId, { ...storyboardGeneratedReceiptFields(confirmed), imageStatus: "done", imageRef: ref, imageRecordId: ref.recordId, imageDeliveryMode: "provider_url", imageUrl: preview, imageWidth: decoded.width, imageHeight: decoded.height, imageValidatedAt: Date.now(), imageRecoveryReady: false, imageRetryBlocked: false, imageError: undefined });
          return { cardId, imageUrl: preview };
        }
        if (confirmed?.state === "completed" && confirmed.assetId) {
          try {
            const restored = await readOwnedStoryboardImage(
              { assetId: confirmed.assetId },
              card.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(current),
            );
            if (!sameImageRequestCurrent()) return null;
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
            setNotice(`分段${card.order}图片已自动显示，没有再次调用生成模型`);
            return { cardId, imageUrl: restored.url };
          } catch (error) {
            if (!sameImageRequestCurrent()) return null;
            patchCard(cardId, {
              imageStatus: "running",
              imageValidatedAt: undefined,
              imageRecoveryReady: true,
              imageRetryBlocked: false,
              imageError: `${error instanceof Error ? error.message : "已完成图片暂时无法读取"}；系统正在重新获取展示地址。`,
            });
            setNotice(`分段${card.order}图片已生成，系统正在重新获取展示地址，不会再次调用模型`);
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
          setNotice(`分段${card.order}的原结果尚未确认，未提交任何生成`);
          return null;
        }
        if (!isStoryboardImageRequestSnapshot(card.imageRequestSnapshot) || !card.imageClientRequestFingerprint) {
          patchCard(cardId, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图请求参数不完整，已保留任务并禁止重放。",
          });
          setNotice(`分段${card.order}缺少原请求参数，无法安全续接`);
          return null;
        }
        requestSnapshot = card.imageRequestSnapshot;
        imageClientRequestFingerprint = await buildClientRequestFingerprint(storyboardImageFingerprintPayload(requestSnapshot));
        if (!sameImageRequestCurrent()) return null;
        if (imageClientRequestFingerprint !== card.imageClientRequestFingerprint) {
          patchCard(cardId, {
            imageStatus: "failed",
            imageRecoveryReady: false,
            imageRetryBlocked: true,
            imageError: "原生图请求快照校验失败，已禁止重放。",
          });
          setNotice(`分段${card.order}的原请求快照校验失败，未提交任何生成`);
          return null;
        }
        modelName = card.imageModelNameUsed || "原生图模型";
      } else {
        if (!card.imagePrompt.trim()) { setNotice("请先粘贴分镜生图 Prompt"); return null; }
        const model = imageModels.find((item) => item.id === current.imageModelId);
        if (!model) { setNotice("图片模型尚未加载"); return null; }
        const selectionIssue = storyboardImageModelSelectionIssue(model);
        if (selectionIssue) { setNotice(publicModelSelectionNotice(selectionIssue, "生图模型")); return null; }
        if (!supportedImageRatios(model).includes(effectiveImageRatio(current))) { setNotice("当前图片模型不支持所选图片比例，请重新选择图片比例。"); return null; }
        const capabilities = getImageModelCapabilities(model);
        if (resolveStoryboardExecutionMode(current) === "chained") {
          const ordered = [...current.cards].sort((a,b) => a.order-b.order), position = ordered.findIndex(item => item.id === cardId);
          if (position > 0) {
            await chainSaveAndReadback(ordered[0].id);
            if (position > 1) await chainSaveAndReadback(ordered[position-1].id);
            assertImageSubmissionCurrent(); current = runRef.current;
          }
        }
        if (resolveStoryboardExecutionMode(current) === "chained" && storyboardChainManualReferences(card).length) throw new Error("此段保留了手动参考图，请先移除手动参考图再使用串联；原参考图未更改，本次未提交。");
        const chainContext = resolveStoryboardExecutionMode(current) === "chained" ? storyboardChainContext(current, cardId, capabilities.maxReferenceImages) : undefined;
        const refreshed = chainContext ? { ...card, referenceImageUrls: [] as string[], visualAssetRefs: [] } : await refreshStoryboardVisualAssetReferences({ card, plan: current.visualAssetPlan, limit: capabilities.maxReferenceImages, resolve: resolveVisualAssetUrls });
        const beforeReferenceCommit = runRef.current;
        const liveCard = beforeReferenceCommit.cards.find(item => item.id === cardId);
        assertImageSubmissionCurrent();
        if (!liveCard) throw new Error("分镜卡片已删除，本次未提交");
        assertBatchSnapshotCurrent(runRef.current, cardId, "images", batchAuthorization);
        preparedImageBatchInput = batchCardInput(chainContext ? card : refreshed, "images");
        if (!chainContext && refreshed !== card) {
          // Commit this verified resolver refresh before async hashing and snapshot checks.
          // A scheduled React updater cannot be the authority for the next request step.
          const next = { ...beforeReferenceCommit, updatedAt: Date.now(), cards: beforeReferenceCommit.cards.map(item => item.id === cardId
            ? { ...item, referenceImageUrls: refreshed.referenceImageUrls, visualAssetRefs: refreshed.visualAssetRefs } : item) };
          runRef.current = next; setRun(next);
        }
        expectedImageInput = storyboardImageSubmissionInput(runRef.current, runRef.current.cards.find(item => item.id === cardId)!);
        if (refreshed.referenceImageUrls.length > capabilities.maxReferenceImages) {
          setNotice(capabilities.supportsReferenceInput
            ? `当前图片模型最多接收${capabilities.maxReferenceImages}张参考图，请移除多余图片或切换模型`
            : "当前图片模型不支持参考图，请移除参考图或切换模型");
          return null;
        }
        modelName = storyboardImageModelName(model);
        const quote = storyboardImagePrice(model, effectiveImageResolution(model, current.imageResolution));
        if (!Number.isFinite(quote) || quote < 0) throw new Error("生图报价尚未确认，本次未提交");
        if (batchAuthorization && quote !== batchAuthorization.price) throw new Error("批量生图报价已改变，本段未提交");
        requestSnapshot = {
          runId: current.id,
          cardId: card.id,
          cardOrder: card.order,
          prompt: card.imagePrompt,
          modelId: model.id,
          aspectRatio: effectiveImageRatio(current),
          resolution: effectiveImageResolution(model, current.imageResolution),
          ...(chainContext ? { chainContext } : {}),
          referenceImageUrls: [...refreshed.referenceImageUrls],
          presetReferences: activeStoryboardVisualAssetRefs(refreshed, current.visualAssetPlan).flatMap(ref => {
            const source = current.visualAssetPlan?.assets.find(asset => asset.id === ref.assetId)?.source;
            if (source?.kind !== "platform-preset") return [];
            const referenceIndex = refreshed.referenceImageUrls.indexOf(ref.boundReferenceUrl || ref.ownedReferenceUrl || "");
            if (!source.presetId || !source.presetRevision || referenceIndex < 0) throw new Error("预设身份或参考图片未落实，请重新选择，本次未提交");
            return [{ presetId: source.presetId, revision: source.presetRevision, referenceIndex }];
          }),
          visualAssetRefs: activeStoryboardVisualAssetRefs(refreshed, current.visualAssetPlan).slice(0, 16),
          strictSingleSubmit: true,
          attemptOrdinal: Math.max(1, Number(card.imageAttemptOrdinal || 0) + 1),
        };
        imageClientRequestFingerprint = await buildClientRequestFingerprint(storyboardImageFingerprintPayload(requestSnapshot));
        const imageClientAttemptScope = `storyboard-image:${requestSnapshot.runId}:${requestSnapshot.cardId}`;
        const exactDigest = requestSnapshot.strictSingleSubmit
          ? await stableImageRequestDigest({
              ...storyboardImageFingerprintPayload(requestSnapshot),
              cardOrder: requestSnapshot.cardOrder,
            })
          : "";
        assertBatchSnapshotCurrent(runRef.current, cardId, "images", batchAuthorization, chainContext ? batchCardInput(card, "images") : batchCardInput(refreshed, "images"));
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
        if (card.imageUrl || card.videoUrl) archiveRunSnapshot(`分段${card.order}重新生图前`);
      }

      const submittedAt = Date.now();
      const imageSubmissionPatch: Partial<WorkbenchCard> = {
        continuousImageInputFingerprint: recovering ? card.continuousImageInputFingerprint : storyboardProductionImageFingerprint(current, { ...card, referenceImageUrls: requestSnapshot.referenceImageUrls, visualAssetRefs: requestSnapshot.visualAssetRefs }, requestSnapshot),
        continuousVideoInputFingerprint: undefined,
        imageStatus: "running",
        imageReferenceState: recovering ? card.imageReferenceState : undefined,
        imageUrl: undefined,
        imageAssetId: undefined,
        imageStorageKey: undefined,
        imageRef: undefined,
        imageRecordId: undefined,
        imageDeliveryMode: undefined,
        imageMediaState: undefined,
        imageDeliveryExpectedPixelSize: undefined,
        imageOutputPolicyVersion: undefined,
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
      assertImageSubmissionCurrent();
      const beforeSave = runRef.current;
      const beforeCard = beforeSave.cards.find(item => item.id === cardId)!;
      const submissionRun: WorkbenchRun = {
        ...beforeSave,
        lastSubmittedAt: submittedAt,
        updatedAt: submittedAt,
        cards: beforeSave.cards.map((item) => item.id === cardId ? { ...item, ...imageSubmissionPatch } : item),
      };
      rollbackImageSubmission = () => {
        if (!sameImageSubmissionScope()) return;
        const latest = runRef.current;
        const target = latest.cards.find(item => item.id === cardId);
        if (!target || target.imageClientRequestId !== clientIdempotencyKey || target.imageSubmittedAt !== submittedAt) return;
        const restored = { ...target } as unknown as Record<string, unknown>;
        const previous = beforeCard as unknown as Record<string, unknown>;
        for (const [field, written] of Object.entries(imageSubmissionPatch)) {
          if (!Object.is(restored[field], written)) continue;
          if (previous[field] === undefined) delete restored[field]; else restored[field] = previous[field];
        }
        const otherSubmission = latest.cards.some(item => item.id !== cardId
          && ((item.imageSubmittedAt || 0) >= submittedAt || (item.videoStartedAt || 0) >= submittedAt));
        const next = { ...latest, updatedAt: Date.now(),
          ...(latest.lastSubmittedAt === submittedAt && !otherSubmission ? { lastSubmittedAt: beforeSave.lastSubmittedAt } : {}),
          cards: latest.cards.map(item => item.id === cardId ? restored as unknown as WorkbenchCard : item) };
        runRef.current = next; setRun(next);
      };
      runRef.current = submissionRun;
      setRun(submissionRun);
      const projectSaved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(submissionRun), true);
      if (!sameImageRequestCurrent()) return null;
      if (!projectSaved) {
        // The project is the durable carrier for the prompt, model binding and
        // exact request keys. Never dispatch a paid provider call when that
        // carrier was not saved: closing this page would otherwise leave an
        // orphaned attempt that no storyboard can safely reconcile.
        rollbackImageSubmission();
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
      if (!recovering) assertBatchSnapshotCurrent(runRef.current, cardId, "images", batchAuthorization, preparedImageBatchInput);
      setNotice(recovering
        ? `任务${card.order}已保存，正在自动完成原故事板结果，不会创建新任务`
        : `任务${card.order}已保存，正在使用 ${modelName} ${card.imageUrl ? "重新生成" : "生成"}故事板`);

      // One explicit user action performs one POST; recoveries keep the original snapshot/key.
      {
        if (!scopeMountedRef.current) return null;
        let pendingInlineBlobUrl: string | undefined;
        let pendingInlineBlob: Blob | undefined;
        let pendingInlineRevoke: (() => void) | undefined;
        try {
          try { assertPlannedDirectorReferencesCurrent(); }
          catch (error) {
            if (recovering) throw error;
            throw Object.assign(error instanceof Error ? error : new Error("角色确认已改变，本次未提交。"),
              { requestAccepted: false, confirmedRejected: true, upstreamCalled: false, billed: false });
          }
          assertImageSubmissionCurrent();
          const dispatchCard = runRef.current.cards.find(item => item.id === cardId)!;
          if (dispatchCard.imageClientRequestId !== clientIdempotencyKey
            || dispatchCard.imageClientRequestFingerprint !== imageClientRequestFingerprint
            || dispatchCard.imageRequestSnapshot !== requestSnapshot) throw new Error("原生图请求身份已改变，本次未提交");
          imageProviderDispatched = true;
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
              ...(recovering && requestSnapshot.exactText ? { coverText: requestSnapshot.exactText } : {}),
              referenceImageUrls: requestSnapshot.referenceImageUrls,
              ...(requestSnapshot.chainContext ? { chainContext: requestSnapshot.chainContext } : {}),
              ...(requestSnapshot.presetReferences?.length ? { presetReferences: requestSnapshot.presetReferences } : {}),
              referenceUsage: requestSnapshot.visualAssetRefs?.some((ref) => ref.role === "character" || ref.role === "pet")
                ? "character-identity"
                : "general",
              clientTraceId,
              clientIdempotencyKey,
              noRetry: requestSnapshot.strictSingleSubmit,
              strictSingleSubmit: requestSnapshot.strictSingleSubmit,
              resumeDeliveryOnly: recovering,
              clientNodeId: `${requestSnapshot.runId}-shot-${requestSnapshot.cardOrder}`,
              clientNodeTitle: `分镜工作台分段${requestSnapshot.cardOrder}`,
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
          if (!sameImageRequestCurrent()) return null;
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
            pendingInlineBlob = delivery.blob;
            pendingInlineBlobUrl = generatedUrl;
            if (!sameImageRequestCurrent()) return null;
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
            if (!sameImageRequestCurrent()) return null;
            if (!imageDimensionsMatchAspectRatio(decoded.width, decoded.height, requestSnapshot.aspectRatio)) {
              throw new RetryableImageFileError(`实际图片 ${decoded.width}×${decoded.height} 与 ${requestSnapshot.aspectRatio} 不一致`);
            }
            stored.width = decoded.width;
            stored.height = decoded.height;
          } catch (error) {
            if (!sameImageRequestCurrent()) return null;
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
            if (!sameImageRequestCurrent()) return null;
            if (restored) {
              stored.url = restored.url;
              stored.key = restored.storageKey;
              stored.width = restored.width;
              stored.height = restored.height;
            } else {
              throw new RetryableImageFileError("图片已入库，但展示地址暂时无法读取");
            }
          }
          if (!sameImageRequestCurrent()) return null;
          if (generatedImage?.deliveryMode === "inline_ephemeral" && stored.url.startsWith("blob:")) {
            if (!pendingInlineBlob) throw new Error("原始故事板字节未保留，费用收据仍保留。");
            rememberStoryboardBoardBlob(originalBoardBlobsRef.current, stored.url, { owner: userId + "\0" + token, runId: current.id, cardId, recordId: String(generatedImage.recordId || data.recordId || ""), blob: pendingInlineBlob });
            ephemeralImageUrlsRef.current.add(stored.url);
          }
          patchCard(cardId, {
            imageStatus: "done",
            imageReferenceState: requestSnapshot.chainContext
              ? storyboardChainSnapshotMatches(runRef.current, cardId, requestSnapshot) ? runRef.current.cards.find(item => item.id === cardId)?.imageReferenceState : "stale"
              : recovering ? runRef.current.cards.find(item => item.id === cardId)?.imageReferenceState : undefined,
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
            if (sameImageRequestCurrent()) {
              patchCard(cardId, { ...completedInlineReceipt, imageStatus: "done", imageUrl: undefined, imageRef: undefined,
                imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: true,
                imageError: "图片已成功生成且费用收据已保留；当前预览不可用，临时图片无法恢复。不会再次生成或扣费" });
              setNotice(`分段${card.order}已生成；当前预览不可用，费用收据已保留`);
            }
            return null;
          }
          throw error;
        } finally {
          if (pendingInlineBlobUrl) { originalBoardBlobsRef.current.delete(pendingInlineBlobUrl); ephemeralImageUrlsRef.current.delete(pendingInlineBlobUrl); if (pendingInlineRevoke) pendingInlineRevoke(); else URL.revokeObjectURL(pendingInlineBlobUrl); }
        }
      }
      return null;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message: string }).message)
          : "故事板生成失败";
      if (!imageProviderDispatched) {
        rollbackImageSubmission();
        if (sameImageSubmissionScope()) setNotice(`${message}；本次未提交生图，当前编辑和已有结果已保留`);
        return null;
      }
      if (!sameImageRequestCurrent()) return null;
      // Reference/quote preflight failed before creating or dispatching a request.
      // Keep the prior media receipt intact and let the user correct the input.
      if (!clientIdempotencyKey && card.imageRecoveryReady !== true) {
        if (runRef.current.id === current.id) patchCard(cardId, { imageError: message });
        setNotice(`${message}；本次未提交、未扣费，修正后可再次生成`);
        return null;
      }
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
      if (!sameImageRequestCurrent()) return null;
      const recoveredInlineReceipt = status?.state === "completed" ? storyboardInlineReceiptFields(status) : null;
      if (recoveredInlineReceipt) {
        if (await restoreOwnedBoard(cardId, recoveredInlineReceipt.imageRecordId)) return null;
        if (!sameImageRequestCurrent()) return null;
        const latest = runRef.current.cards.find(item => item.id === cardId);
        const keepMedia = Boolean(latest && latest.imageRecordId === recoveredInlineReceipt.imageRecordId && latest.imageDeliveryMode === "inline_ephemeral" && latest.imageUrl?.startsWith("blob:") && ephemeralImageUrlsRef.current.has(latest.imageUrl) && latest.imageValidatedAt);
        patchCard(cardId, { ...recoveredInlineReceipt, imageStatus: "done", imageUrl: keepMedia ? latest?.imageUrl : undefined, imageRef: undefined,
          imageValidatedAt: keepMedia ? latest?.imageValidatedAt : undefined, imageRecoveryReady: false, imageRetryBlocked: !keepMedia,
          imageError: keepMedia ? undefined : "图片已成功生成且费用收据已保留；临时图片仅原页面可用，当前无法恢复。不会重新生成或扣费" });
        setNotice(`分段${card.order}已生成，费用收据已保留；本次未重新提交`);
        return null;
      }
      const failurePresentation = storyboardImageFailurePresentation(typed, status, message);
      const confirmedRejected = failurePresentation.confirmedRejected;
      if (status?.canRecover === true && requestSnapshot) {
        patchCard(cardId, {
          imageStatus: "running",
          imageValidatedAt: undefined,
          imageRecoveryReady: true,
          imageRetryBlocked: false,
          imageError: status.message || `${message}；系统正在自动完成保存和展示。`,
        });
        setNotice(`分段${card.order}图片已生成，系统正在自动完成保存和展示，不会再次调用模型`);
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
          imageError: failurePresentation.message,
        });
        setNotice(`分段${card.order}生图失败：${failurePresentation.message}`);
      } else {
        patchCard(cardId, {
          imageStatus: status?.state === "processing" ? "running" : "failed",
          imageValidatedAt: undefined,
          imageRecoveryReady: false,
          imageRetryBlocked: true,
          imageError: `${status?.message || message}；原请求已保留，确认前禁止重放。`,
        });
        setNotice(`分段${card.order}结果待确认，已保留原请求并禁止重复提交`);
      }
      return null;
    } finally {
      if (imageSubmissionOperationsRef.current.get(cardId) === imageOperation) {
        imageSubmissionOperationsRef.current.delete(cardId);
        imageSubmissionsRef.current.delete(cardId);
      }
    }
  }, [ensureInitialReferencesAdopted, archiveRunSnapshot, imageModels, inspectStoryboardImageAttempt, patchCard, readOwnedStoryboardImage, resolveVisualAssetUrls, restoreOwnedBoard, saveStoryboardProject, token, userId, verifyPlannedDirectorReferences]);

  // Provider output recovery is infrastructure work, not a user command.
  // Reuse the same immutable request key with bounded exponential backoff; the
  // exactly-once store guarantees these attempts never submit the model twice.
  useEffect(() => {
    if (!storageReady || !contextReadyRef.current) return;
    const pendingIds = new Set(run.cards.filter((card) => (
      card.imageRecoveryReady === true
      && !isOwnedStoryboardBoard(card)
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
  }, [generateImage, run.cards, storageReady]);

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
      errorCode?: string;
      taskIdExternal?: string;
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

    const pollingOwner = userId + "\0" + token;
    const pollingRunId = runRef.current.id;
    const pollingClientRequestId = runRef.current.cards.find(card => card.id === cardId)?.videoClientRequestId;
    const isCurrentVideoTask = () => !signal.aborted && scopeMountedRef.current && contextReadyRef.current
      && !navigationRef.current && imageDownloadOwnerRef.current === pollingOwner && runRef.current.id === pollingRunId
      && runRef.current.cards.some(card => card.id === cardId && card.videoTaskId === taskId);
    if (!isCurrentVideoTask()) return null;
    const applyStatus = (data: StatusPayload, source: "stream" | "poll") => {
      if (!isCurrentVideoTask()) return { terminal: true, videoUrl: "" };
      rememberVideoConfirmation(pollingRunId, cardId, taskId, data, pollingClientRequestId);
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
        setNotice(`分段${target?.order || ""}视频生成完成，结果已同步`);
        cacheCompletedStoryboardVideo(taskId);
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
        setNotice(`分段${target?.order || ""}视频失败：${message}`);
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
        setNotice(`分段${target?.order || ""}视频任务已终止`);
        return { terminal: true, videoUrl: "" };
      }

      const nextStatus = status === "queued" ? "queued" : "running";
      const currentCard = runRef.current.cards.find((card) => card.id === cardId);
      const providerStartedAt = Date.parse(String(data.startedAt || ""));
      const providerLastSyncedAt = Date.parse(String(data.lastSyncedAt || ""));
      const detail = data.message
        || data.errorMessage
        || (data.processingStage === "trimming"
          ? "视频已生成，正在处理并同步播放地址"
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
    });
    let closeStream: (() => void) | undefined;
    try {
      patchCard(cardId, { videoStatusDetail: "正在建立实时状态连接" });
      const stream = await openStoryboardStream(`/api/video/stream?${streamParams.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
        cache: "no-store",
      });
      closeStream = stream.close;
      const response = stream.response;
      if (!isCurrentVideoTask()) { await response.body?.cancel().catch(() => undefined); return null; }
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
        if (!isCurrentVideoTask()) { await reader.cancel().catch(() => undefined); return null; }
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
      if (!isCurrentVideoTask()) return null;
      if (isAbortError(error) || signal.aborted) throw error;
      patchCard(cardId, {
        videoStatusDetail: `${friendlyVideoError(error instanceof Error ? error.message : "实时连接中断")}，已切换主动查询`,
        videoPollFailures: 1,
      });
    } finally { closeStream?.(); }

    let consecutiveFailures = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (attempt > 0) await abortableDelay(VIDEO_POLL_INTERVAL_MS, signal);
      if (!isCurrentVideoTask()) return null;
      try {
        const params = new URLSearchParams({ taskId, modelId, contentUrl });
        const { response, data } = await fetchStoryboardJson<StatusPayload>(`/api/video/status?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
          cache: "no-store",
        });
        if (!isCurrentVideoTask()) return null;
        if (!response.ok) throw new Error(friendlyVideoError(data.error || data.errorMessage || `视频状态查询失败（${response.status}）`, response.status));
        consecutiveFailures = 0;
        const applied = applyStatus(data, "poll");
        if (applied.terminal) return applied.videoUrl || null;
      } catch (error) {
        if (!isCurrentVideoTask()) return null;
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
  }, [cacheCompletedStoryboardVideo, patchCard, rememberVideoConfirmation, token, userId]);

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
    setNotice(`分段${card.order}${message}`);
  }, [canRemotelyCancelVideoTask, patchCard]);

  const cancelVideo = useCallback(async (cardId: string) => {
    const card = runRef.current.cards.find((item) => item.id === cardId);
    if (!card || !isActiveVideoStatus(card.videoStatus)) return;
    const cancellingOwner = userId + "\0" + token;
    const cancellingRunId = runRef.current.id;
    const isCurrentCancellation = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && imageDownloadOwnerRef.current === cancellingOwner && runRef.current.id === cancellingRunId
      && runRef.current.cards.some(item => item.id === cardId && item.videoClientRequestId === card.videoClientRequestId && item.videoTaskId === card.videoTaskId && isActiveVideoStatus(item.videoStatus));

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
      if (!isCurrentCancellation()) return;
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
    setNotice(`分段${card.order}的视频任务已终止`);
    } catch (error) {
      if (!isCurrentCancellation()) return;
      const message = `取消结果暂未确认，已保留任务追踪：${friendlyVideoError(error instanceof Error ? error.message : "网络暂不可用")}`;
      patchCard(cardId, { videoStatusDetail: message });
      setNotice(message);
      return;
    }
  }, [canRequestVideoTermination, patchCard, token, userId]);

  const generateVideo = useCallback(async (cardId: string, batchAuthorization?: StoryboardBatchAuthorization, ownsVideoPreparation = false) => {
    const invocationRunId = runRef.current.id;
    const invocationOwner = userId + "\0" + token;
    if (resolveStoryboardExecutionMode(runRef.current) !== "chained" && runRef.current.directorIntake?.phase === "assets") { setNotice("当前正在准备角色三视图，请完成资产并续写分镜后再生成视频。"); return null; }
    if (resolveStoryboardExecutionMode(runRef.current) === "reference" && runRef.current.directorIntake?.phase === "planned") {
      try { collectStoryboardDirectorReferenceBindings(runRef.current, runRef.current.directorIntake.input); }
      catch (error) { setNotice(error instanceof Error ? error.message : "请先逐项确认角色三视图。"); return null; }
    }
    if (resolveStoryboardExecutionMode(runRef.current) === "reference" && initialReferenceBlockedRef.current.has(imageDownloadOwnerRef.current + "\0" + runRef.current.id)) { setNotice("参考采用保存结果尚未确认，请刷新读取原项目核对后再生成视频。"); return null; }
    if (!contextReadyRef.current || navigationRef.current || view !== "workbench") return null;
    let assertPlannedDirectorReferencesCurrent: () => void;
    try { assertPlannedDirectorReferencesCurrent = resolveStoryboardExecutionMode(runRef.current) !== "reference" ? () => undefined : await verifyPlannedDirectorReferences(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "角色原生成回执核验失败，本次未提交。"); return null; }
    if (!scopeMountedRef.current) { setNotice("页面正在切换，请稍后再试"); return null; }
    if (imageDownloadOwnerRef.current !== invocationOwner || runRef.current.id !== invocationRunId) { setNotice("当前账号或项目已变化，请刷新页面后重试"); return null; }
    const current = runRef.current;
    const card = current.cards.find((item) => item.id === cardId);
    const model = videoModels.find((item) => item.id === current.videoModelId);
    const resolvedVideoInputs = model && card ? resolveStoryboardAutomaticVideoInputs(model, card) : null;
    if (boardExportLocksRef.current.has(cardId) || card && resolvedVideoInputs?.usesStoryboardImage && needsStoryboardBoardExport(card)) { setNotice("请先保存分镜图后再生成视频。"); return null; }
    if (videoSubmissionsRef.current.has(cardId) && !ownsVideoPreparation) {
      setNotice(`分段${card?.order || ""}的视频请求已经提交，请勿重复点击`);
      return null;
    }
    if (card && isActiveVideoStatus(card.videoStatus)) { setNotice(`分段${card.order}的视频仍在生成，请等待结果`); return null; }
    if (resolvedVideoInputs?.usesStoryboardImage && card?.continuousImageInputFingerprint && !storyboardProductionImageInputMatch(current, card).matches) {
      setNotice("分镜图与当前提示词、参考或图片模型参数不一致，请重新生成本段分镜图后再制作视频。"); return null;
    }
    if (card?.videoStatus === "failed" && card.videoRetryable !== true) {
      setNotice(`分段${card.order}的原任务或费用尚未确认，请先刷新历史状态，当前不会重复提交`);
      return null;
    }
    if (!token) { setNotice("请先登录后再生成"); return null; }
    if (!card || !model || !resolvedVideoInputs) return null;
    const cardInputIssue = storyboardCardVideoInputIssue(model, card, current);
    if (cardInputIssue) { setNotice(cardInputIssue); return null; }
    try { assertBatchAuthorization(current, card, "videos", batchAuthorizationRef.current, batchAuthorization); }
    catch (error) { setNotice(error instanceof Error ? error.message : "批量参数已改变，本段未提交"); return null; }
    if (!model) { setNotice("原视频模型当前不可选，请手动选择视频模型"); return null; }
    const imageRatioIssue = resolvedVideoInputs.usesStoryboardImage ? storyboardImageRatioIssue(card, effectiveImageRatio(current), current.ratio, model) : "";
    if (imageRatioIssue) { setNotice(imageRatioIssue); return null; }
    if (model.supportsPrompt && !card.videoPrompt.trim()) { setNotice("请先粘贴图生视频 Prompt"); return null; }
    const selectionIssue = storyboardVideoModelSelectionIssue(model, { ratio: current.ratio, duration: effectiveVideoDuration(model, current.videoDuration), resolution: current.videoResolution });
    if (selectionIssue) { setNotice(publicModelSelectionNotice(selectionIssue, "视频模型")); return null; }
    const duration = effectiveVideoDuration(model, current.videoDuration);
    if (card.directorExecution && card.videoPrompt === card.directorExecution.sourceVideoPrompt
      && duration !== card.directorExecution.targetDurationSeconds) {
      setNotice(`导演分镜按${card.directorExecution.targetDurationSeconds}秒编排，当前视频为${duration}秒；请选择匹配时长的模型，或明确修改本段时间线后再提交。`);
      return null;
    }
    // Narration is source metadata here. This silent-video surface does not
    // synthesize speech, so a voiceover reading-speed limit is not applicable.
    const executionPrompt = model.supportsPrompt ? submittedVideoPrompt(compileStoryboardDirectorVideoPrompt(card.videoPrompt, card.directorExecution), model, duration) : "";
    const promptViolation = model.supportsPrompt ? storyboardVideoPromptViolation(card.videoPrompt) : null;
    if (promptViolation) { setNotice(promptViolation); return null; }
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
    const submissionVideoInputs = resolveStoryboardAutomaticVideoInputs(model, { ...card, videoPrompt: executionPrompt });
    if (submissionVideoInputs.issue) { setNotice(submissionVideoInputs.issue); return null; }
    const submissionVideoInputIdentity = JSON.stringify(submissionVideoInputs.identity);
    const submissionAspectRatio = resolveAiVideoInputAspectRatio(model, current.ratio, submissionVideoInputs.input);
    const modelName = compactVideoModelName(model);
    const submissionOwner = userId + "\0" + token;
    const submissionInput = batchCardInput(card, "videos");
    const submissionSettings = JSON.stringify([current.videoModelId, current.ratio, current.videoDuration, current.videoResolution, current.videoContract]);
    const submissionConsent = JSON.stringify(tokenChargeConsentRef.current);
    const sameSubmissionScope = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && imageDownloadOwnerRef.current === submissionOwner && runRef.current.id === current.id;
    const assertSubmissionCurrent = () => {
      const latest = runRef.current;
      const item = latest.cards.find(candidate => candidate.id === cardId);
      if (!sameSubmissionScope() || videoSubmissionOperationsRef.current.get(cardId) !== videoOperation || !item || (submissionVideoInputs.usesStoryboardImage && item.imageReferenceState === "stale") || JSON.stringify(resolveStoryboardAutomaticVideoInputs(model, { ...item, videoPrompt: executionPrompt }).identity) !== submissionVideoInputIdentity || batchCardInput(item, "videos") !== submissionInput
        || JSON.stringify([latest.videoModelId, latest.ratio, latest.videoDuration, latest.videoResolution, latest.videoContract]) !== submissionSettings
        || JSON.stringify(tokenChargeConsentRef.current) !== submissionConsent) {
        throw new Error("账号、项目、分镜图或视频参数已变化，本次未提交；请重新确认。");
      }
    };
    const submittedAt = Date.now();
    const tokenBilling = resolveVideoTokenBillingConsent(model, tokenChargeConsentRef.current);
    if (model.billingUnit === "token" && !tokenBilling) { setNotice("请明确填写本次每条视频最多自动扣款金额（正数，最多两位小数）"); return null; }
    if (batchAuthorization?.tokenBilling && (tokenBilling?.maxChargeYuan !== batchAuthorization.tokenBilling.maxChargeYuan || tokenBilling?.priceVersion !== batchAuthorization.tokenBilling.priceVersion)) { setNotice("批量确认后的 Token 费率或每条额度已改变，本段未提交"); return null; }
    const quotedPrice = tokenBilling?.maxChargeYuan ?? effectiveVideoCharge(model, resolution, duration);
    if (!Number.isFinite(quotedPrice) || quotedPrice < 0) { setNotice("视频报价尚未确认，本次未提交"); return null; }
    if (batchAuthorization && quotedPrice !== batchAuthorization.price) { setNotice("批量视频报价已改变，本段未提交"); return null; }
    videoSubmissionsRef.current.add(cardId);
    const videoOperation = Symbol(cardId);
    videoSubmissionOperationsRef.current.set(cardId, videoOperation);
    window.setTimeout(() => videoSectionsRef.current[cardId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
    const pendingVideoPatch: Partial<WorkbenchCard> = {
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
      videoSameRequestKeyRequired: undefined,
      videoBillingState: "pending",
      videoPriceCharged: undefined,
    };
    let submissionController: AbortController | undefined;
    let providerSubmissionDispatched = false;
    let confirmedUnsubmitted = false;
    let preparedClientRequestId: string | undefined;
    let rollbackVideoSubmission: () => void = () => undefined;
    const sameVideoRequestCurrent = () => sameSubmissionScope() && videoSubmissionOperationsRef.current.get(cardId) === videoOperation
      && Boolean(preparedClientRequestId && runRef.current.cards.find(item => item.id === cardId)?.videoClientRequestId === preparedClientRequestId);
    try {
      submissionController = new AbortController();
      videoSubmissionControllersRef.current.set(cardId, submissionController);
      const videoClientRequestFingerprint = await buildClientRequestFingerprint({
        runId: current.id,
        cardId: card.id,
        cardOrder: card.order,
        modelId: model.id,
        prompt: executionPrompt,
        duration,
        aspectRatio: submissionAspectRatio,
        sourceImageAspectRatio: submissionVideoInputs.usesStoryboardImage ? card.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(current) : undefined,
        sourceImageDimensions: submissionVideoInputs.usesStoryboardImage ? [card.imageWidth, card.imageHeight] : undefined,
        referenceAspectRatioPolicy: allowsIndependentReferenceRatio(model) ? "independent" : "same",
        resolution,
        tokenBilling,
        // Keep existing same-key retry fingerprints unchanged for untouched legacy
        // single-image cards. Retained custom inputs bind only the automatic effective identity.
        ...(card.videoInputs === undefined && submissionVideoInputs.usesStoryboardImage ? {
          sourceImage: submissionVideoInputs.requestFields.image_ref
            ? generatedImageReferenceUri(submissionVideoInputs.requestFields.image_ref)
            : submissionVideoInputs.requestFields.image_storage_key || (submissionVideoInputs.requestFields.image_url || "").split("?", 1)[0],
        } : { videoInputs: submissionVideoInputs.identity }),
      });
      assertSubmissionCurrent();
      const videoClientAttemptScope = `storyboard-video:${current.id}:${card.id}`;
      const videoClientAttempt = resolveStoryboardVideoSameKeyRetryAttempt({
        currentFingerprint: videoClientRequestFingerprint,
        previousRequestId: card.videoClientRequestId,
        previousFingerprint: card.videoClientRequestFingerprint,
        sameRequestKeyRequired: card.videoSameRequestKeyRequired,
      }) ?? resolveBrowserClientAttempt({
        storageKey: videoClientAttemptScope,
        fingerprint: videoClientRequestFingerprint,
        prefix: "sbw-video",
        previousRequestId: card.videoClientRequestId,
        previousFingerprint: card.videoClientRequestFingerprint,
        previousTerminal: card.videoSameRequestKeyRequired !== true && (card.videoStatus === "done" || card.videoStatus === "cancelled"
          || card.videoStatus === "failed" && card.videoRetryable === true),
      });
      const stableVideoClientRequestId = videoClientAttempt.clientRequestId;
      preparedClientRequestId = stableVideoClientRequestId;
      assertBatchSnapshotCurrent(runRef.current, cardId, "videos", batchAuthorization);
      // Keep the last usable result until consent, local reference validation and
      // durable request-identity preparation have all succeeded.
      if (card.videoUrl) archiveRunSnapshot(`分段${card.order}重新生成视频前`);
      setNotice(`分段${card.order}正在使用 ${modelName} 提交视频任务`);
      const videoSubmissionPatch: Partial<WorkbenchCard> = {
        continuousVideoInputFingerprint: storyboardAutomaticVideoProductionFingerprint(current, card, card.continuousImageInputFingerprint ? card.imageRequestSnapshot : undefined),
        videoClientRequestId: stableVideoClientRequestId,
        videoClientRequestFingerprint,
      };
      const beforeSave = runRef.current;
      const beforeCard = beforeSave.cards.find(item => item.id === cardId)!;
      const writtenPatch = { ...pendingVideoPatch, ...videoSubmissionPatch };
      rollbackVideoSubmission = () => {
        if (!sameVideoRequestCurrent()) return;
        const latest = runRef.current;
        const target = latest.cards.find(item => item.id === cardId)!;
        const restored = { ...target } as unknown as Record<string, unknown>;
        const previous = beforeCard as unknown as Record<string, unknown>;
        for (const [field, written] of Object.entries(writtenPatch)) {
          if (!Object.is(restored[field], written)) continue;
          if (previous[field] === undefined) delete restored[field]; else restored[field] = previous[field];
        }
        const otherSubmission = latest.cards.some(item => item.id !== cardId
          && ((item.imageSubmittedAt || 0) >= submittedAt || (item.videoStartedAt || 0) >= submittedAt));
        const next = { ...latest, updatedAt: Date.now(),
          ...(latest.lastSubmittedAt === submittedAt && !otherSubmission ? { lastSubmittedAt: beforeSave.lastSubmittedAt } : {}),
          cards: latest.cards.map(item => item.id === cardId ? restored as unknown as WorkbenchCard : item) };
        runRef.current = next; setRun(next);
      };
      const submissionRun: WorkbenchRun = {
        ...beforeSave,
        lastSubmittedAt: submittedAt,
        updatedAt: Date.now(),
        // `patchCard` schedules a React state update. Build the durable
        // pre-dispatch snapshot from the same pending patch explicitly so the
        // account project records queued/running state even when React batches
        // that update with the provider request.
        cards: beforeSave.cards.map((item) => item.id === cardId
          ? { ...item, ...pendingVideoPatch, ...videoSubmissionPatch }
          : item),
      };
      runRef.current = submissionRun;
      setRun(submissionRun);
      const projectSaved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(submissionRun), true);
      if (!sameVideoRequestCurrent()) return null;
      assertSubmissionCurrent();
      if (!projectSaved) {
        throw new Error("视频请求与项目绑定尚未保存确认，本次未提交；原图片、已有视频和原请求信息均已保留。");
      }
      submittedRunIdsRef.current.add(submissionRun.id);
      assertBatchSnapshotCurrent(runRef.current, cardId, "videos", batchAuthorization);
      assertPlannedDirectorReferencesCurrent();
      providerSubmissionDispatched = true;
      const submitted = await fetchStoryboardJson("/api/video/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": stableVideoClientRequestId,
        },
        signal: submissionController.signal,
        body: JSON.stringify({
          model_id: model.id,
          ...(tokenBilling ? { tokenBilling } : {}),
          prompt: executionPrompt,
          ...submissionVideoInputs.requestFields,
          duration,
          aspect_ratio: submissionAspectRatio,
          resolution_tier: resolution,
          task_label: `分镜工作台分段${card.order}`,
          batch_id: current.id,
          // 批次名用于历史分组标题：用项目/文案标题，避免所有批次都显示同一个内部 key。
          batch_topic: (current.title || "").trim() || "分镜制作",
          card_index: card.order,
          surface: "storyboard-workbench",
          client_request_id: stableVideoClientRequestId,
        }),
      }, { timeoutMs: STORYBOARD_VIDEO_SUBMIT_DEADLINE_MS, message: "视频提交等待超时，正在保留原请求并核对受理结果" });
      const response = submitted.response;
      const data = submitted.data as {
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
      if (!sameVideoRequestCurrent()) return null;
      videoSubmissionControllersRef.current.delete(cardId);
      if (typeof data.business_task_id === "string" && data.business_task_id) localVideoInternalIdsRef.current.add(data.business_task_id);
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
        setNotice(`分段${card.order}视频失败：${message}`);
        return null;
      }
      const trackingTaskId = data.business_task_id || data.task_id || "";
      rememberVideoConfirmation(current.id, cardId, trackingTaskId, data, stableVideoClientRequestId);
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
        setNotice(`分段${card.order}上游已受理，正在继续追踪原任务，不会重复提交`);
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
        setNotice(`分段${card.order}视频生成完成 · ${modelName}`);
        if (data.business_task_id) cacheCompletedStoryboardVideo(data.business_task_id);
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
        setNotice(`分段${card.order}的视频任务已终止`);
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
      const rawMessage = error instanceof Error ? error.message : "视频生成失败";
      const message = rawMessage.startsWith("VIDEO_RETRY_")
        ? "原请求必须沿用同一请求号和相同参数；当前图片或参数已改变，或原请求信息不完整。请恢复原参数并查询原请求后再确认，本次未提交。"
        : friendlyVideoError(rawMessage);
      if (!sameSubmissionScope()) return null;
      const latest = runRef.current.cards.find(item => item.id === cardId);
      if (!providerSubmissionDispatched) {
        if (preparedClientRequestId && card.videoSameRequestKeyRequired !== true) clearBrowserClientAttempt(`storyboard-video:${current.id}:${card.id}`, preparedClientRequestId);
        rollbackVideoSubmission();
        setNotice(`分段${card.order}本次未提交：${message}${card.videoUrl ? "。已有视频已保留" : ""}`);
        return null;
      }
      if (!sameVideoRequestCurrent()) return null;
      if (isAbortError(error) || latest?.videoStatus === "cancelled") return null;
      if (providerSubmissionDispatched && !confirmedUnsubmitted && latest?.videoStatus !== "failed" && latest?.videoStatus !== "done") {
        patchCard(cardId, { videoStatus: latest?.videoTaskId ? "running" : "queued", videoError: undefined,
          videoStatusDetail: `结果暂未确认，已保留原任务：${message}`, videoLastCheckedAt: Date.now() });
        setNotice(`分段${card.order}结果暂未确认，正在保留原任务追踪`);
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
          videoSameRequestKeyRequired: undefined,
          videoRetryable: true,
          videoBillingState: "not_required",
          videoPriceCharged: 0,
        });
      } else {
        patchCard(cardId, { videoStatus: "failed", videoError: message, videoStatusDetail: message, videoLastCheckedAt: Date.now(), videoRetryable: false });
      }
      setNotice(`分段${card.order}视频失败：${message}`);
      return null;
    } finally {
      if (videoSubmissionControllersRef.current.get(cardId) === submissionController) videoSubmissionControllersRef.current.delete(cardId);
      if (videoSubmissionOperationsRef.current.get(cardId) === videoOperation) {
        videoSubmissionOperationsRef.current.delete(cardId);
        videoSubmissionsRef.current.delete(cardId);
      }
    }
  }, [archiveRunSnapshot, cacheCompletedStoryboardVideo, patchCard, rememberVideoConfirmation, saveStoryboardProject, startPolling, token, userId, videoModels, verifyPlannedDirectorReferences]);

  const prepareAndGenerateVideo = useCallback(async (cardId: string, batchAuthorization?: StoryboardBatchAuthorization): Promise<string | null> => {
    const current = runRef.current;
    const card = current.cards.find(item => item.id === cardId);
    const model = videoModels.find(item => item.id === current.videoModelId);
    if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || view !== "workbench" || !card || !token || !model) return null;
    if (videoSubmissionsRef.current.has(cardId) || boardExportLocksRef.current.has(cardId) || (resolveStoryboardAutomaticVideoInputs(model, card).usesStoryboardImage && imageAttemptNeedsResolution(card)) || isActiveVideoStatus(card.videoStatus)) return null;
    if (card.videoStatus === "failed" && card.videoRetryable !== true) { setNotice("原视频请求或费用尚未确认，请先查询原任务；本次未提交。"); return null; }
    const resolvedVideoInputs = resolveStoryboardAutomaticVideoInputs(model, card);
    const cardInputIssue = storyboardCardVideoInputIssue(model, card, current);
    if (cardInputIssue) { setNotice(cardInputIssue); return null; }
    const issue = storyboardVideoModelSelectionIssue(model, { ratio: current.ratio, duration: effectiveVideoDuration(model, current.videoDuration), resolution: current.videoResolution })
      || (resolvedVideoInputs.usesStoryboardImage ? storyboardImageRatioIssue(card, effectiveImageRatio(current), current.ratio, model) : "")
      || (model.supportsPrompt && !card.videoPrompt.trim() ? "请先填写本段视频提示词。" : "")
      || (model.supportsPrompt ? storyboardVideoPromptViolation(card.videoPrompt) : "");
    if (issue) { setNotice(publicModelSelectionNotice(issue, "视频模型")); return null; }
    const owner = userId + "\0" + token;
    const identity = () => {
      const latest = runRef.current;
      const item = latest.cards.find(candidate => candidate.id === cardId);
      if (!scopeMountedRef.current || !contextReadyRef.current || navigationRef.current || imageDownloadOwnerRef.current !== owner || latest.id !== current.id || !item) return null;
      return JSON.stringify([owner, latest.id, item.id, item.imageRecordId, item.imageWidth, item.imageHeight, item.imageRequestSnapshot,
        item.imageReferenceState, item.visualAssetRefs, item.referenceImageUrls, item.videoPrompt, item.videoStatus, item.videoTaskId,
        item.videoClientRequestId, item.videoClientRequestFingerprint, resolveStoryboardAutomaticVideoInputs(model, item).identity, latest.videoModelId, latest.ratio, latest.videoDuration,
        latest.videoResolution, latest.videoContract, tokenChargeConsentRef.current]);
    };
    try {
      assertBatchSnapshotCurrent(current, cardId, "videos", batchAuthorization);
      return await prepareStoryboardVideo({ cardId, locks: videoSubmissionsRef.current, identity, needsSave: resolvedVideoInputs.usesStoryboardImage && needsStoryboardBoardExport(card),
        save: () => saveBoardForVideo(cardId, true), submit: () => {
          if (batchAuthorization) {
            if (runRef.current.id !== batchAuthorization.runId || batchSettings(runRef.current, "videos") !== batchAuthorization.settings) throw new Error("批量视频参数已改变，本段未提交。");
            const prepared = runRef.current.cards.find(item => item.id === cardId);
            if (!prepared) throw new Error("分镜卡片已移除，本段未提交。");
            // The shared preparation guard verified the same image/request.
            // Only its durable URL/asset binding changed during owned export.
            batchAuthorization.inputs.set(cardId, batchCardInput(prepared, "videos"));
          }
          return generateVideo(cardId, batchAuthorization, true);
        },
        onPreparing: preparing => { if (scopeMountedRef.current) setPreparingVideoIds(ids => { const next = new Set(ids); if (preparing) next.add(cardId); else next.delete(cardId); return next; }); },
      });
    } catch (error) { if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner) setNotice(error instanceof Error ? error.message : "视频准备未确认，本次未提交。"); return null; }
  }, [generateVideo, saveBoardForVideo, token, userId, videoModels, view]);

  const reconcileVideoRequest = useCallback(async (cardId: string, source: "auto" | "manual" = "manual") => {
    const reconciliationRunId = runRef.current.id;
    const reconciliationOwner = imageDownloadOwnerRef.current;
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
      const result = await fetchStoryboardJson(`/api/video/request-status?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const response = result.response;
      const data = result.data as {
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
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== reconciliationOwner || runRef.current.id !== reconciliationRunId) return null;
      const latest = runRef.current.cards.find((item) => item.id === cardId);
      if (!latest || latest.videoClientRequestId !== clientRequestId || latest.videoTaskId) return null;
      if (data.found) {
        const taskId = String(data.businessTaskId || data.taskId || "");
        if (typeof data.businessTaskId === "string" && data.businessTaskId) localVideoInternalIdsRef.current.add(data.businessTaskId);
        const modelId = String(data.modelId || latest.videoTaskModelId || "");
        if (!taskId || !modelId) throw new Error("原视频任务存在，但任务编号或模型编号不完整");
        const remoteStatus = normalizeRemoteVideoStatus(data.status);
        patchCard(cardId, {
          videoStatus: remoteStatus === "running" ? "running" : "queued",
          videoTaskId: taskId,
          videoTaskModelId: modelId,
          videoError: undefined,
          videoRetryable: false,
          videoSameRequestKeyRequired: undefined,
          videoBillingState: data.billingState || latest.videoBillingState || "pending",
          videoPriceCharged: Number.isFinite(Number(data.priceCharged)) ? Math.max(0, Number(data.priceCharged)) : latest.videoPriceCharged,
          videoStatusDetail: "已找回原视频任务，正在继续查询结果",
          videoLastCheckedAt: Date.now(),
        });
        setNotice(`分段${latest.order}已找回原视频任务，不会重复提交`);
        return await startPolling(cardId, taskId, modelId, latest.videoContentUrl || "");
      }
      if (data.canResubmit && data.sameRequestKeyRequired) {
        patchCard(cardId, {
          videoStatus: "failed",
          videoError: "服务器未建立该视频任务，本次未扣费；可点击重试，系统会沿用原请求号防止重复投递",
          videoStatusDetail: data.message || "未发现持久任务，可沿用原请求号人工重试",
          videoLastCheckedAt: Date.now(),
          videoRetryable: true,
          videoSameRequestKeyRequired: true,
          videoBillingState: "not_required",
          videoPriceCharged: 0,
        });
        setNotice(`分段${latest.order}未建立视频任务、未扣费；可点击重试，仍使用原请求号`);
        return null;
      }
      patchCard(cardId, {
        videoStatus: "queued",
        videoError: undefined,
        videoRetryable: false,
        videoStatusDetail: data.message || "原视频请求仍待确认，请稍后再次刷新状态",
        videoLastCheckedAt: Date.now(),
      });
      setNotice(`分段${latest.order}的原视频请求仍待确认，不会重复提交`);
      return null;
    } catch (error) {
      if (!scopeMountedRef.current || imageDownloadOwnerRef.current !== reconciliationOwner || runRef.current.id !== reconciliationRunId
        || !runRef.current.cards.some(item => item.id === cardId && item.videoClientRequestId === clientRequestId && !item.videoTaskId)) return null;
      const latest = runRef.current.cards.find((item) => item.id === cardId);
      const message = friendlyVideoError(error instanceof Error ? error.message : "原视频请求查询失败");
      patchCard(cardId, {
        videoStatus: "queued",
        videoError: undefined,
        videoRetryable: false,
        videoStatusDetail: `状态查询暂不可用，原请求仍被保护：${message}`,
        videoLastCheckedAt: Date.now(),
      });
      setNotice(`分段${latest?.order || ""}状态查询暂不可用，未重新提交`);
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
      setNotice(`分段${card.order}正在继续查询原视频任务`);
      try {
        return await startPolling(cardId, card.videoTaskId, card.videoTaskModelId, card.videoContentUrl || "");
      } catch (error) {
        if (isAbortError(error)) return null;
        const message = friendlyVideoError(error instanceof Error ? error.message : "视频状态读取失败");
        patchCard(cardId, {
          videoStatusDetail: `结果暂未确认，保留原任务：${message}`,
          videoLastCheckedAt: Date.now(),
        });
        setNotice(`分段${card.order}状态查询暂不可用，未重新提交`);
        return null;
      }
    }
    if (card.videoClientRequestId) return await reconcileVideoRequest(cardId, "manual");
    return null;
  }, [patchCard, reconcileVideoRequest, startPolling]);

  useEffect(() => {
    if (!token || !storageReady || !contextReadyRef.current) return;
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
  }, [patchCard, reconcileVideoRequest, run.cards, run.videoModelId, startPolling, storageReady, token]);

  useEffect(() => {
    const plan = run.visualAssetPlan;
    if (plan?.mode !== "selected" || !plan.assets.length || !token) return;
    let alive = true;
    void resolveVisualAssetUrls(plan).then(urls => {
      if (!alive) return;
      setResolvedVisualAssetPlan({ projectId: run.id, plan, urls });
      const restored: OwnedVisualAsset[] = plan.assets.flatMap(asset => {
        const url = urls.find(item => item.assetId === asset.source?.assetId);
        if (!asset.source || !url) return [];
        return [{ assetId: asset.source.assetId, planId: asset.id, previewUrl: url.previewUrl, name: asset.name, prompt: asset.referencePrompts[0]?.prompt,
          role: asset.role, historyRecordId: asset.source.historyRecordId, storageKey: asset.source.storageKey, projectId: run.id,
          modelId: asset.source.modelId, modelName: asset.source.modelName, quotedPrice: asset.source.quotedPrice,
          tags: asset.tags, customCategory: asset.customCategory, source: asset.source.kind === "platform-preset" ? "platform-preset" : "personal",
          presetId: asset.source.presetId, presetRevision: asset.source.presetRevision, saved: asset.source.librarySaved === true || asset.source.kind === "platform-preset" }];
      });
      setVisualAssetCandidates(current => [...current, ...restored.filter(item => !current.some(existing => existing.assetId === item.assetId))]);
    });
    return () => { alive = false; };
  }, [resolveVisualAssetUrls, run.id, run.visualAssetPlan, token]);

  // 批量生产仍是工作台的正式生产入口。每一批冻结项目、模型、参数、
  // 报价和卡片输入，并把同一授权对象传入单卡提交门禁，防止参数变化
  // 或组件重复点击造成重复派发。
  const runImageBatch = useCallback(async (cardIds: string[], authorization: StoryboardBatchAuthorization) => {
    const requests: Array<Promise<{ cardId: string; imageUrl: string } | null>> = [];
    for (let index = 0; index < cardIds.length; index += 1) {
      if (!scopeMountedRef.current || batchAuthorizationRef.current !== authorization || runRef.current.id !== authorization.runId) break;
      requests.push(generateImage(cardIds[index], authorization).catch((error) => {
        const message = error instanceof Error ? error.message : "故事板生成失败";
        const card = runRef.current.cards.find((item) => item.id === cardIds[index]);
        if (card && (card.imageStatus === "queued" || card.imageStatus === "running")) {
          patchCard(card.id, { imageStatus: "failed", imageValidatedAt: undefined, imageError: message });
        }
        setNotice(`分段${card?.order || ""}生图失败：${message}`);
        return null;
      }));
      if (index < cardIds.length - 1) await delay(IMAGE_SUBMIT_INTERVAL_MS);
    }
    return Promise.all(requests);
  }, [generateImage, patchCard]);

  const runVideoBatch = useCallback(async (cardIds: string[], authorization: StoryboardBatchAuthorization) => {
    const requests: Array<Promise<string | null>> = [];
    for (let index = 0; index < cardIds.length; index += 1) {
      if (!scopeMountedRef.current || batchAuthorizationRef.current !== authorization || runRef.current.id !== authorization.runId) break;
      requests.push(prepareAndGenerateVideo(cardIds[index], authorization));
      if (index < cardIds.length - 1) await delay(VIDEO_SUBMIT_INTERVAL_MS);
    }
    return Promise.all(requests);
  }, [prepareAndGenerateVideo]);

  const buildBatchAuthorization = useCallback((kind: "images" | "videos", cardIds: string[]): StoryboardBatchAuthorization | null => {
    const model = kind === "images" ? activeImageModel : activeVideoModel;
    const tokenBilling = kind === "videos" ? resolveVideoTokenBillingConsent(activeVideoModel, tokenChargeConsentRef.current) : undefined;
    if (kind === "videos" && activeVideoModel?.billingUnit === "token" && !tokenBilling) return null;
    const price = kind === "images"
      ? storyboardImagePrice(activeImageModel, activeImageResolution)
      : tokenBilling?.maxChargeYuan ?? effectiveVideoCharge(activeVideoModel, activeVideoResolution, activeVideoDuration);
    if (!model || !Number.isFinite(price) || price < 0) return null;
    return {
      kind,
      runId: runRef.current.id,
      settings: batchSettings(runRef.current, kind),
      price,
      ...(tokenBilling ? { tokenBilling } : {}),
      inputs: new Map(cardIds.map((cardId) => {
        const card = runRef.current.cards.find((item) => item.id === cardId);
        return [cardId, card ? batchCardInput(card, kind) : ""];
      })),
      started: new Set(),
    };
  }, [activeImageModel, activeImageResolution, activeVideoDuration, activeVideoModel, activeVideoResolution]);

  const ordinaryBatchImages = useCallback(async () => {
    if (batchMode || batchAuthorizationRef.current || initialReferenceAdoptionRef.current) return;
    const workspaceGeneration = workspaceGenerationRef.current;
    if (!await ensureInitialReferencesAdopted()) return;
    if (workspaceGeneration !== workspaceGenerationRef.current) return;
    if (batchAuthorizationRef.current || initialReferenceAdoptionRef.current || visualAssetMutationRef.current || navigationRef.current) return;
    const current = runRef.current;
    const cardsNeedingGeneration = current.cards.filter((card) => !isCompletedInlineImageReceipt(card) && !card.imageRecoveryReady && (card.imageStatus === "idle" || card.imageStatus === "failed"));
    const invalid = cardsNeedingGeneration.filter((card) => !card.imagePrompt.trim());
    if (invalid.length) return setNotice(`还有${invalid.length}张分段卡没有粘贴生图 Prompt`);
    if (cardsNeedingGeneration.length > 0 && (activeImageSelectionIssue || activeImageRatioIssue)) {
      return setNotice(activeImageRatioIssue || publicModelSelectionNotice(activeImageSelectionIssue, "生图模型"));
    }
    const incompatibleReferences = cardsNeedingGeneration.filter((card) => card.referenceImageUrls.length > imageCapabilities.maxReferenceImages);
    if (incompatibleReferences.length) return setNotice("还有卡片的参考图超过当前模型上限，请替换或清除后再批量生成");
    const blockedCount = current.cards.filter((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card)).length;
    if (blockedCount) return setNotice(`还有${blockedCount}张故事板结果待确认，已禁止批量重放`);
    const cardIds = current.cards.filter((card) => card.imageStatus === "idle" || (card.imageStatus === "failed" && !card.imageRetryBlocked)).map((card) => card.id);
    const activeCount = current.cards.filter((card) => card.imageStatus === "queued" || card.imageStatus === "running").length;
    if (!cardIds.length && activeCount) return setNotice(`还有${activeCount}张故事板正在生成，请等待当前任务完成`);
    if (!cardIds.length) return setNotice("所有故事板图片已经完成");
    const authorization = buildBatchAuthorization("images", cardIds);
    if (!authorization) return setNotice("生图报价尚未确认，本次未提交");
    batchAuthorizationRef.current = authorization;
    setBatchMode("images");
    setNotice(`批量生图已开始，每10秒提交1个，共${cardIds.length}个`);
    try {
      const results = await runImageBatch(cardIds, authorization);
      if (workspaceGeneration === workspaceGenerationRef.current) setNotice(`批量生图结束：成功${results.filter(Boolean).length}个，失败${results.filter((item) => !item).length}个`);
    } catch (error) {
      if (workspaceGeneration === workspaceGenerationRef.current) setNotice(error instanceof Error ? `批量生图异常：${error.message}` : "批量生图异常中断");
    } finally {
      if (batchAuthorizationRef.current === authorization) { batchAuthorizationRef.current = null; setBatchMode(""); }
    }
  }, [ensureInitialReferencesAdopted, activeImageSelectionIssue, activeImageRatioIssue, batchMode, buildBatchAuthorization, imageCapabilities.maxReferenceImages, runImageBatch]);

  // This authorization exists only in memory: refresh never resumes paid dispatches.
  const chainDelivered = (card: WorkbenchCard | undefined) => Boolean(card && card.imageStatus === "done" && hasValidatedImage(card)
    && card.imageReferenceState !== "stale" && card.imageRecordId && !card.imageRecoveryReady && !card.imageRetryBlocked
    && (resolveStoryboardExecutionMode(runRef.current) !== "chained" || storyboardProductionImageInputMatch(runRef.current, card).matches));
  const chainSaveAndReadback = async (cardId: string): Promise<boolean> => {
    const originalRun = runRef.current, original = originalRun.cards.find(item => item.id === cardId);
    const owner = imageDownloadOwnerRef.current, plan = storyboardChainPlanFingerprint(originalRun);
    const snapshot = storyboardChainFingerprint(original?.imageRequestSnapshot ?? null), confirmation = storyboardChainFingerprint(original?.chainAnchorConfirmation ?? null);
    // Compare the restored request to the document actually sent to storage.
    // The live request also contains transient inputs, such as presetReferences.
    const matchesSavedRequest = (saved: WorkbenchCard | undefined, sent: WorkbenchRun) => {
      const expected = sent.cards.find(item => item.id === cardId);
      return Boolean(saved && expected && saved.imageClientRequestId === expected.imageClientRequestId
        && saved.imageClientRequestFingerprint === expected.imageClientRequestFingerprint
        && storyboardChainFingerprint(saved.imageRequestSnapshot ?? null) === storyboardChainFingerprint(expected.imageRequestSnapshot ?? null));
    };
    const current = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current && imageDownloadOwnerRef.current === owner
      && runRef.current.id === originalRun.id && storyboardChainPlanFingerprint(runRef.current) === plan
      && runRef.current.cards.some(item => item.id === cardId && item.imageRecordId === original?.imageRecordId
        && storyboardChainFingerprint(item.imageRequestSnapshot ?? null) === snapshot && storyboardChainFingerprint(item.chainAnchorConfirmation ?? null) === confirmation && chainDelivered(item));
    const assertCurrent = () => { if (!current()) throw new Error("账号、项目或原分镜已改变，串联保存已停止。"); };
    if (!chainDelivered(original)) throw new Error("分镜图尚未真实交付，串联停止；请查询原任务。");
    assertCurrent();
    if (original && (!original.imageAssetId || !original.imageStorageKey)) {
      const sent = createStoryboardPersistenceSnapshot(runRef.current);
      if (!await saveStoryboardProject(sent, true)) throw new Error("分镜记录保存未确认，本次未导出。");
      assertCurrent();
      const originalReadback = normalizeRun(await cloud.restore(originalRun.id)); assertCurrent();
      const savedOriginal = originalReadback?.cards.find(item => item.id === cardId);
      if (!originalReadback || originalReadback.id !== originalRun.id || storyboardChainPlanFingerprint(originalReadback) !== plan || savedOriginal?.imageRecordId !== original.imageRecordId
        || !isStoryboardChainHydratedReadback(savedOriginal, false) || !matchesSavedRequest(savedOriginal, sent)) throw new Error("原分镜记录回读未确认，本次未导出。");
      if (boardExportLocksRef.current.has(cardId)) throw new Error("本段原图正在保存，请等待完成。");
      boardExportLocksRef.current.add(cardId); setExportingBoardIds(new Set(boardExportLocksRef.current));
      try {
        const owned = await saveStoryboardBoardOriginal({ userId, runId:originalRun.id, cardId, recordId:original.imageRecordId!,
          url:original.imageRef ? generatedImagePreviewUrl(original.imageRef) : original.imageUrl!, width:original.imageWidth || 0, height:original.imageHeight || 0, token,
          chainOriginal:{projectId:originalRun.id,cardId,recordId:original.imageRecordId!},
          cache:boardExportCacheRef.current, stillCurrent:current,
          readOriginal:async () => {
            assertCurrent();
            if (original.imageUrl?.startsWith("blob:")) return readStoryboardBoardBlob(originalBoardBlobsRef.current, original.imageUrl,
              {owner,runId:originalRun.id,cardId,recordId:original.imageRecordId!});
            if (!original.imageRef && original.imageAssetId && original.imageStorageKey) {
              const savedOwned = await readOwnedStoryboardImage({assetId:original.imageAssetId,storageKey:original.imageStorageKey}, original.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(originalRun)); assertCurrent();
              const ownedResponse = await fetch(savedOwned.url, {cache:"no-store"}); assertCurrent();
              if (!ownedResponse.ok) throw new Error("已保存原图暂不可读取。");
              const ownedBlob = await ownedResponse.blob(); assertCurrent();
              return {bytes:new Uint8Array(await ownedBlob.arrayBuffer()),mime:ownedBlob.type.split(";",1)[0]};
            }
            const recordRef = GeneratedImageReferenceSchema.parse(original.imageRef || { schema:"generated_image_ref.v1", recordId:original.imageRecordId });
            const response = await fetch(generatedImagePreviewUrl(recordRef), { headers:{ Authorization:`Bearer ${token}` }, cache:"no-store" });
            assertCurrent();
            if (!response.ok) throw new Error("原分镜记录的完整图片暂不可读取，串联已停止。");
            const blob = await response.blob(); assertCurrent();
            return { bytes:new Uint8Array(await blob.arrayBuffer()), mime:blob.type.split(";",1)[0] };
          },
          readOwned:async reference => readOwnedStoryboardImage(reference, original.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(originalRun)) });
        assertCurrent();
        const latest = runRef.current;
        const next = { ...latest, updatedAt:Date.now(), cards:latest.cards.map(item => item.id === cardId ? { ...item,
          imageAssetId:owned.assetId, imageStorageKey:owned.storageKey, imageUrl:owned.url, imageWidth:owned.width, imageHeight:owned.height,
          imageRef:undefined, imageDeliveryMode:undefined, imageValidatedAt:Date.now() } : item) };
        runRef.current = next; setRun(next);
      } finally { boardExportLocksRef.current.delete(cardId); setExportingBoardIds(new Set(boardExportLocksRef.current)); }
    }
    assertCurrent();
    const card = runRef.current.cards.find(item => item.id === cardId)!;
    if (!card.imageAssetId || !card.imageStorageKey) throw new Error("分镜图持久保存未确认，串联已停止。");
    await readOwnedStoryboardImage({ assetId: card.imageAssetId, storageKey: card.imageStorageKey }, card.imageRequestSnapshot?.aspectRatio || effectiveImageRatio(originalRun));
    assertCurrent();
    const sent = createStoryboardPersistenceSnapshot(runRef.current);
    if (!await saveStoryboardProject(sent, true)) throw new Error("项目保存失败，串联已停止。");
    assertCurrent();
    const restored = normalizeRun(await cloud.restore(originalRun.id));
    assertCurrent();
    const saved = restored?.cards.find(item => item.id === cardId);
    if (!restored || restored.id !== originalRun.id || resolveStoryboardExecutionMode(restored) !== "chained" || storyboardChainPlanFingerprint(restored) !== plan
      || !saved || saved.imageStatus !== "done" || !isStoryboardChainHydratedReadback(saved, true) || !storyboardProductionImageInputMatch(restored, saved).matches || saved.imageRecordId !== card.imageRecordId || saved.imageAssetId !== card.imageAssetId || saved.imageStorageKey !== card.imageStorageKey
      || !matchesSavedRequest(saved, sent) || storyboardChainFingerprint(saved.chainAnchorConfirmation ?? null) !== confirmation) throw new Error("保存回读未确认，串联已停止。");
    return true;
  };
  const processChainedImages = async () => {
    const session = chainAuthorizationRef.current;
    if (!session || chainBusyRef.current) return;
    chainBusyRef.current = true; setChainStatus("running");
    const current = () => chainAuthorizationRef.current === session && scopeMountedRef.current && contextReadyRef.current && !navigationRef.current
      && imageDownloadOwnerRef.current === session.owner && storyboardChainPlanFingerprint(runRef.current) === session.fingerprint
      && storyboardImagePrice(imageModelsRef.current.find(model => model.id === runRef.current.imageModelId), effectiveImageResolution(imageModelsRef.current.find(model => model.id === runRef.current.imageModelId), runRef.current.imageResolution)) === session.price;
    try {
      const outcome = await runStoryboardChainQueue({ current, cardIds: [...runRef.current.cards].sort((a,b) => a.order-b.order).map(card => card.id),
        delivered: id => chainDelivered(runRef.current.cards.find(card => card.id === id)),
        anchorConfirmed: () => { try { const cards = runRef.current.cards; if (cards.length < 2) return Boolean(cards[0]?.chainAnchorConfirmation); storyboardChainContext(runRef.current, cards[1].id, imageCapabilities.maxReferenceImages); return true; } catch { return false; } },
        saveAndReadback: chainSaveAndReadback,
        generate: async id => {
          const card = runRef.current.cards.find(item => item.id === id);
          if (!card || card.imageRecoveryReady || card.imageRetryBlocked || ["queued", "running"].includes(card.imageStatus) || card.imageClientRequestId && card.imageStatus !== "done") throw new Error("存在原任务待核验；串联不会重复提交，请先查询原任务。");
          const authorization = buildBatchAuthorization("images", [id]);
          if (!authorization || authorization.price !== session.price) throw new Error("报价已改变，串联已停止。");
          authorization.isCurrent = current; batchAuthorizationRef.current = authorization; setBatchMode("images");
          try {
            await generateImage(id, authorization); await delay(0);
            const original = runRef.current.cards.find(item => item.id === id);
            const requestId = original?.imageClientRequestId, requestFingerprint = original?.imageClientRequestFingerprint;
            const frozen = storyboardChainFingerprint(original?.imageRequestSnapshot ?? null);
            // Infrastructure may finish an already accepted task through status/delivery recovery.
            // Release dispatch ownership so that recovery can use the exact original key.
            if (batchAuthorizationRef.current === authorization) batchAuthorizationRef.current = null;
            while (current()) {
              const latest = runRef.current.cards.find(item => item.id === id);
              if (!latest || latest.imageClientRequestId !== requestId || latest.imageClientRequestFingerprint !== requestFingerprint || storyboardChainFingerprint(latest.imageRequestSnapshot ?? null) !== frozen) return false;
              if (chainDelivered(latest)) return true;
              if (!latest.imageRecoveryReady && !["running", "queued"].includes(latest.imageStatus)
                && !(latest.imageStatus === "done" && latest.imageUrl && !latest.imageValidatedAt && !latest.imageError)) return false;
              await delay(500);
            }
            return false;
          } finally { if (batchAuthorizationRef.current === authorization) batchAuthorizationRef.current = null; setBatchMode(""); }
        } });
      if (chainAuthorizationRef.current !== session) return;
      setChainStatus(outcome === "completed" ? "done" : outcome === "waiting" ? "waiting" : "stopped");
      setNotice(outcome === "waiting" ? "首段已保存，请查看图片并点击“确认并用于后续分镜”。" : outcome === "completed" ? "串联分镜图已逐段完成并保存。" : "串联已停止，请核对当前原任务；不会自动重试。");
      if (outcome !== "waiting") chainAuthorizationRef.current = null;
    } catch (error) {
      if (chainAuthorizationRef.current === session) {
        chainAuthorizationRef.current = null;
        if (imageDownloadOwnerRef.current === session.owner && runRef.current.id === session.runId) { setChainStatus("stopped"); setNotice(error instanceof Error ? error.message : "串联已停止。"); }
      }
    }
    finally { chainBusyRef.current = false; }
  };
  const startChainedImagesImpl = async () => {
    if (chainBusyRef.current || batchAuthorizationRef.current || visualAssetMutationRef.current || navigationRef.current) return;
    if (imageCapabilities.maxReferenceImages < 1) { setNotice("当前模型不支持参考图，无法开始串联；本次未提交任何生成。"); return; }
    if (activeImageSelectionIssue || activeImageRatioIssue) { setNotice(activeImageRatioIssue || publicModelSelectionNotice(activeImageSelectionIssue, "生图模型")); return; }
    if (runRef.current.cards.some(card => storyboardChainManualReferences(card).length)) { setNotice("项目保留了手动参考图，请先在对应分镜处理参考图后再使用串联；现有参考图与角色资产未更改，本次未提交。"); return; }
    if (runRef.current.cards.some(card => !card.imagePrompt.trim())) { setNotice("请补齐每段生图提示词。"); return; }
    if (runRef.current.cards.some(card => card.imageRecoveryReady || card.imageRetryBlocked || ["queued", "running"].includes(card.imageStatus))) { setNotice("原任务尚未确认，请先查询原任务；本次未提交。"); return; }
    const price = storyboardImagePrice(activeImageModel, activeImageResolution);
    if (!Number.isFinite(price) || price < 0) { setNotice("生图报价尚未确认，本次未提交。"); return; }
    const before = runRef.current, owner = imageDownloadOwnerRef.current;
    const effective = { ...before, imageResolution: activeImageResolution, imageRatio: activeImageRatio, updatedAt: Date.now() };
    const expectedPlan = storyboardChainPlanFingerprint(effective);
    const sameScope = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current && imageDownloadOwnerRef.current === owner
      && runRef.current.id === before.id && storyboardChainPlanFingerprint(runRef.current) === expectedPlan;
    if (before.imageResolution !== effective.imageResolution || before.imageRatio !== effective.imageRatio) { runRef.current = effective; setRun(effective); await delay(0); }
    if (!sameScope()) return;
    if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) { if (sameScope()) setNotice("串联参数保存失败，本次未提交。"); return; }
    if (!sameScope()) return;
    const saved = normalizeRun(await cloud.restore(before.id));
    if (!sameScope()) return;
    if (!saved || storyboardChainPlanFingerprint(saved) !== expectedPlan) { setNotice("串联参数回读未确认，本次未提交。"); return; }
    chainAuthorizationRef.current = { runId: runRef.current.id, fingerprint: storyboardChainPlanFingerprint(runRef.current), owner: userId + "\0" + token, price };
    await processChainedImages();
  };
  const startChainedImages = async () => {
    if (chainStartBusyRef.current || chainAnchorSavingRef.current) return;
    chainStartBusyRef.current = true;
    const owner = imageDownloadOwnerRef.current, runId = runRef.current.id;
    try { await startChainedImagesImpl(); }
    catch (error) { if (scopeMountedRef.current && imageDownloadOwnerRef.current === owner && runRef.current.id === runId) { chainAuthorizationRef.current = null; setChainStatus("stopped"); setNotice(error instanceof Error ? error.message : "串联保存未确认，本次未继续。"); } }
    finally { chainStartBusyRef.current = false; }
  };
  const confirmChainAnchor = async () => {
    if (chainBusyRef.current || chainAnchorSavingRef.current || chainStartBusyRef.current) return;
    const before = runRef.current, first = [...before.cards].sort((a,b) => a.order-b.order)[0];
    const owner = imageDownloadOwnerRef.current, plan = storyboardChainPlanFingerprint(before);
    let writtenConfirmation: StoryboardChainAnchorConfirmation | undefined;
    const ownsAnchor = () => scopeMountedRef.current && contextReadyRef.current && !navigationRef.current && imageDownloadOwnerRef.current === owner
      && runRef.current.id === before.id && storyboardChainPlanFingerprint(runRef.current) === plan
      && runRef.current.cards.some(card => card.id === first?.id && card.imageRecordId === first?.imageRecordId && storyboardChainFingerprint(card.imageRequestSnapshot ?? null) === storyboardChainFingerprint(first?.imageRequestSnapshot ?? null));
    if (!chainDelivered(first) || !first.imageRecordId) { setNotice("首段尚未真实解码完成，无法确认。"); return; }
    chainAnchorSavingRef.current = true;
    try {
      if (!await chainSaveAndReadback(first.id) || !ownsAnchor()) return;
      const confirmation: StoryboardChainAnchorConfirmation = { schema: "storyboard_chain_anchor_confirmation.v1", recordId: first.imageRecordId,
        confirmedAt: Date.now(), inputFingerprint: storyboardChainInputFingerprint(before, first), chainRevision: before.chainRevision || 1 };
      if (!ownsAnchor()) return;
      writtenConfirmation = confirmation;
      const next = { ...runRef.current, updatedAt: Date.now(), cards: runRef.current.cards.map(card => card.id === first.id ? { ...card, chainAnchorConfirmation: confirmation } : card) };
      runRef.current = next; setRun(next);
      if (!await chainSaveAndReadback(first.id) || !ownsAnchor()) return;
      setNotice("首段已确认并保存，可用于后续分镜。");
      chainAnchorSavingRef.current = false;
      if (chainAuthorizationRef.current) await processChainedImages();
      else setChainStatus("idle");
    } catch (error) {
      if (ownsAnchor()) {
        chainAuthorizationRef.current = null;
        const latest = runRef.current;
        if (writtenConfirmation && latest.cards.some(card => card.id === first.id && storyboardChainFingerprint(card.chainAnchorConfirmation ?? null) === storyboardChainFingerprint(writtenConfirmation ?? null))) {
          const next = { ...latest, cards: latest.cards.map(card => card.id === first.id ? { ...card, chainAnchorConfirmation: undefined } : card) }; runRef.current = next; setRun(next);
        }
        setChainStatus("stopped"); setNotice(error instanceof Error ? error.message : "首段确认保存失败。");
      }
    }
    finally { chainAnchorSavingRef.current = false; }
  };
  const batchImages = () => resolveStoryboardExecutionMode(runRef.current) === "chained" ? startChainedImages() : ordinaryBatchImages();
  useEffect(() => {
    chainAuthorizationRef.current = null; setChainStatus("idle");
    return () => { chainAuthorizationRef.current = null; };
  }, [userId, token, run.id]);
  const previousChainRunRef = useRef<WorkbenchRun | null>(null);
  useEffect(() => {
    const previous = previousChainRunRef.current; previousChainRunRef.current = run;
    if (!previous || previous.id !== run.id || resolveStoryboardExecutionMode(run) !== "chained") return;
    const changedPlan = storyboardChainPlanFingerprint(previous) !== storyboardChainPlanFingerprint(run) || JSON.stringify(previous.cards.map(storyboardChainManualReferences)) !== JSON.stringify(run.cards.map(storyboardChainManualReferences));
    let index = run.cards.findIndex((card, i) => previous.cards[i]?.id !== card.id || storyboardChainInputFingerprint(previous, previous.cards[i]) !== storyboardChainInputFingerprint(run, card)
      || Boolean(previous.cards[i]?.imageRecordId && previous.cards[i].imageRecordId !== card.imageRecordId));
    if (index < 0 && previous.cards.length !== run.cards.length) index = 0;
    if (index < 0) return;
    if (changedPlan || index === 0 && previous.cards[0]?.chainAnchorConfirmation) { chainAuthorizationRef.current = null; continuousAuthorizationRef.current = null; batchAuthorizationRef.current = null; setChainStatus("stopped"); }
    const cards = run.cards.map((card,i) => ({ ...card,
      ...(i === 0 && index === 0 ? { chainAnchorConfirmation: undefined } : {}),
      ...(i >= index && (i > index || changedPlan) && (card.imageUrl || card.imageRecordId) ? { imageReferenceState: "stale" as const } : {}) }));
    if (JSON.stringify(cards) === JSON.stringify(run.cards)) return;
    const next = { ...run, cards }; previousChainRunRef.current = next; runRef.current = next; setRun(next);
  }, [run]);

  const batchVideos = useCallback(async () => {
    if (batchMode || videoBatchPreflightRef.current) return;
    const workspaceGeneration = workspaceGenerationRef.current;
    videoBatchPreflightRef.current = true;
    try {
      if (batchVideoBlockedReason) return setNotice(batchVideoBlockedReason);
      const blockedFailures = run.cards.filter((card) => card.videoStatus === "failed" && card.videoRetryable !== true).length;
      if (blockedFailures) return setNotice(`还有${blockedFailures}条失败视频的原任务或费用尚未确认，请先刷新历史状态`);
      const cardIds = run.cards.filter((card) => card.videoStatus === "idle" || ((card.videoStatus === "failed" || card.videoStatus === "cancelled") && card.videoRetryable === true)).map((card) => card.id);
      const activeCount = run.cards.filter((card) => card.videoStatus === "queued" || card.videoStatus === "running").length;
      if (!cardIds.length && activeCount) return setNotice(`还有${activeCount}条视频正在生成，请等待当前任务完成`);
      if (!cardIds.length) return setNotice("所有视频已经完成");
      const authorization = buildBatchAuthorization("videos", cardIds);
      if (!authorization) return setNotice(activeVideoModel?.billingUnit === "token" ? "请明确填写每条视频最多自动扣款金额（正数，最多两位小数）" : "视频报价尚未确认，本次未提交");
      if (authorization.tokenBilling) {
        const totalBudget = videoTokenBudgetTotal(authorization.tokenBilling.maxChargeYuan, cardIds.length);
        let balance = Number.NaN;
        try {
          const response = await fetch(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
          const wallet = await response.json();
          if (response.ok && typeof wallet.cashBalance === "number") balance = wallet.cashBalance;
        } catch { /* A missing wallet cannot authorize a batch budget. */ }
        if (workspaceGeneration !== workspaceGenerationRef.current) return;
        if (!Number.isFinite(balance)) return setNotice("现金余额暂未确认，Token 批量任务尚未提交，请稍后重试");
        if (!Number.isFinite(totalBudget) || totalBudget > balance) return setNotice(`本批 ${cardIds.length} 条视频需预留总额度 ¥${Number.isFinite(totalBudget) ? totalBudget.toFixed(2) : "待确认"}，请检查余额和每条额度；预留不是扣费`);
      }
      batchAuthorizationRef.current = authorization;
      setBatchMode("videos");
      setNotice(`批量视频已开始，每10秒提交1个，共${cardIds.length}个`);
      try {
        await runVideoBatch(cardIds, authorization);
        // A null result is not a failure. Publish a summary request after all card
        // updates have been queued; the effect reads the committed React snapshot.
        if (workspaceGeneration === workspaceGenerationRef.current) {
          setVideoBatchOutcome({ workspaceGeneration, runId: authorization.runId, owner: userId + "\0" + token, cardIds });
        }
      } catch (error) {
        if (workspaceGeneration === workspaceGenerationRef.current) setNotice(error instanceof Error ? `批量视频异常：${error.message}` : "批量视频异常中断");
      } finally {
        if (batchAuthorizationRef.current === authorization) { batchAuthorizationRef.current = null; setBatchMode(""); }
      }
    } finally {
      if (workspaceGeneration === workspaceGenerationRef.current) videoBatchPreflightRef.current = false;
    }
  }, [activeVideoModel, batchVideoBlockedReason, batchMode, buildBatchAuthorization, run.cards, runVideoBatch, token, userId]);

  useEffect(() => {
    if (!videoBatchOutcome) return;
    if (scopeMountedRef.current && videoBatchOutcome.workspaceGeneration === workspaceGenerationRef.current
      && videoBatchOutcome.owner === imageDownloadOwnerRef.current && videoBatchOutcome.runId === run.id) {
      setNotice(summarizeVideoBatchOutcome(run.cards, videoBatchOutcome.cardIds));
    }
    setVideoBatchOutcome(null);
  }, [run.id, run.cards, videoBatchOutcome]);

  const pauseContinuousProduction = useCallback(() => {
    continuousAuthorizationRef.current = null;
    setContinuousStatus("paused");
    setContinuousMessage("连续制作已暂停。已提交的任务继续保留并查询；继续时重新确认剩余费用。");
  }, []);

  const processContinuousProduction = useCallback(async () => {
    const session = continuousAuthorizationRef.current;
    if (!session || continuousBusyRef.current) return;
    continuousBusyRef.current = true;
    const current = () => {
      const latest = runRef.current;
      const imageModel = imageModelsRef.current.find(model => model.id === latest.imageModelId);
      const videoModel = videoModelsRef.current.find(model => model.id === latest.videoModelId);
      const settings = readReferenceImageSettings(latest);
      const referenceModel = imageModelsRef.current.find(model => model.id === settings.modelId);
      const tokenBilling = resolveVideoTokenBillingConsent(videoModel, tokenChargeConsentRef.current);
      return continuousAuthorizationRef.current === session && scopeMountedRef.current && contextReadyRef.current
        && !navigationRef.current && imageDownloadOwnerRef.current === session.owner && latest.id === session.runId
        && storyboardProductionPlanFingerprint(latest) === session.planFingerprint
        && (!session.assetFingerprint || storyboardProductionAssetFingerprint(latest) === session.assetFingerprint)
        && storyboardImagePrice(imageModel, effectiveImageResolution(imageModel, latest.imageResolution)) === session.imagePrice
        && (resolveStoryboardExecutionMode(latest) !== "reference" || storyboardImagePrice(referenceModel, effectiveImageResolution(referenceModel, settings.resolution)) === session.referencePrice)
        && (tokenBilling?.maxChargeYuan ?? effectiveVideoCharge(videoModel, effectiveVideoResolution(videoModel, latest.videoResolution), effectiveVideoDuration(videoModel, latest.videoDuration))) === session.videoPrice
        && JSON.stringify(tokenBilling) === JSON.stringify(session.tokenBilling);
    };
    const assertCurrent = () => { if (!current()) throw new Error("账号、项目、提示词、模型、参考或报价已改变，请重新确认剩余制作费用。"); };
    try {
      const outcome = await runStoryboardProductionQueue({ current,
        cards: () => runRef.current.cards,
        onStage: stage => {
          session.stage = stage; setContinuousStatus("running");
          setContinuousMessage(stage === "references" ? "正在准备角色三视图；生成后请逐项查看并点击“使用这张”。" : stage === "images" ? "正在逐段制作分镜图，完成后继续制作视频。" : "分镜图已就绪，正在逐段制作视频。");
        },
        references: async () => {
          assertCurrent();
          const intake = runRef.current.directorIntake;
          if (intake?.phase === "assets") throw new Error("此为旧版仅角色交接，请使用完整计划后再连续制作。");
          if (resolveStoryboardExecutionMode(runRef.current) !== "reference") return true;
          if (intake?.phase === "planned") {
            const assets = runRef.current.visualAssetPlan?.assets.filter(asset => asset.role === "character" || asset.role === "pet") || [];
            if (!assets.length) throw new Error("完整参考计划至少需要一项人物或宠物的角色三视图位置。");
            const settings = readReferenceImageSettings(runRef.current);
            const referenceBatch: VisualAssetBatchAuthorization = { runId: session.runId, modelId: settings.modelId, resolution: referenceImageResolution,
              ratio: settings.ratio, price: session.referencePrice, inputs: session.referenceInputs, started: new Set(), isCurrent: current };
            visualAssetBatchRef.current = referenceBatch;
            try {
              for (const asset of assets) {
                assertCurrent();
                const latest = runRef.current;
                const confirmed = pruneStoryboardDirectorAssetConfirmations(latest)?.confirmedAssets?.some(item => item.planId === asset.id);
                if (confirmed) continue;
                const draft = latest.visualAssetWorkspace?.drafts.find(item => item.planId === asset.id && item.role === asset.role);
                if (!draft?.prompt.trim()) throw new Error(`请补齐${asset.role === "character" ? "人物" : "宠物"}的三视图提示词。`);
                const candidate = latest.visualAssetWorkspace?.candidates.find(item => item.planId === asset.id && item.role === asset.role
                  && item.projectId === latest.id && item.assetId === `generated_${item.historyRecordId}` && item.storageKey === undefined
                  && storyboardDirectorCandidateMatchesDraft(item, draft, asset));
                if (candidate) continue;
                const encoded = session.referenceInputs.get(asset.id);
                if (!encoded) throw new Error("角色输入已改变，请重新确认本次制作。");
                const result = await generateVisualAsset(JSON.parse(encoded) as DrawerVisualAssetInput, referenceBatch);
                if (!result) throw new Error("角色生成结果未确认，连续制作已停止。请在角色区查询原请求，不会自动重试。");
              }
            } finally { if (visualAssetBatchRef.current === referenceBatch) visualAssetBatchRef.current = null; setVisualAssetGenerating(false); }
            assertCurrent();
            try { collectStoryboardDirectorReferenceBindings(runRef.current, intake.input); }
            catch { setReferenceDisplayMode("reference"); return false; }
          } else if (!await ensureInitialReferencesAdopted()) throw new Error("请先确认当前参考，再继续连续制作。");
          assertCurrent();
          session.assetFingerprint = storyboardProductionAssetFingerprint(runRef.current);
          const urls = await resolveVisualAssetUrls(runRef.current.visualAssetPlan);
          assertCurrent();
          if (runRef.current.visualAssetPlan?.mode === "selected" && runRef.current.visualAssetPlan.assets.some(asset =>
            (asset.role === "character" || asset.role === "pet") && !urls.some(item => item.assetId === asset.source?.assetId))) throw new Error("角色图片暂不可读取，请确认原结果后继续。");
          if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("角色确认尚未保存，请稍后继续。");
          assertCurrent(); return true;
        },
        image: async cardId => {
          assertCurrent();
          const authorization = buildBatchAuthorization("images", [cardId]);
          if (!authorization || authorization.price !== session.imagePrice) throw new Error("分镜图报价已改变，本段未提交。");
          authorization.isCurrent = current; batchAuthorizationRef.current = authorization; setBatchMode("images");
          try {
            await generateImage(cardId, authorization); await delay(0); assertCurrent();
            const card = runRef.current.cards.find(item => item.id === cardId);
            if (!card || !hasValidatedImage(card)) throw new Error("分镜图结果未确认，连续制作已停止。请在对应段落查询原任务，不会自动重试。");
            if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("分镜图已完成，但结果保存尚未确认；请读取原任务后继续，不会自动重试。");
            assertCurrent();
            return true;
          } finally { if (batchAuthorizationRef.current === authorization) batchAuthorizationRef.current = null; setBatchMode(""); }
        },
        video: async cardId => {
          assertCurrent();
          const card = runRef.current.cards.find(item => item.id === cardId);
          if (!card || !hasValidatedImage(card) || !storyboardProductionImageInputMatch(runRef.current, card).matches) throw new Error("分镜图与当前输入不一致，请先核对并重新生成对应分镜图。");
          if (needsStoryboardBoardExport(card) && !await saveBoardForVideo(cardId, true)) throw new Error("分镜原图保存未确认，本次未提交视频。");
          assertCurrent();
          const authorization = buildBatchAuthorization("videos", [cardId]);
          if (!authorization || authorization.price !== session.videoPrice) throw new Error("视频报价或额度已改变，本段未提交。");
          authorization.isCurrent = current; batchAuthorizationRef.current = authorization; setBatchMode("videos");
          try {
            await generateVideo(cardId, authorization); await delay(0); assertCurrent();
            const latest = runRef.current.cards.find(item => item.id === cardId);
            if (latest?.videoStatus !== "done" || !latest.videoUrl) throw new Error("视频结果未确认，连续制作已停止。请查询原任务，不会自动重试。");
            if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(runRef.current), true)) throw new Error("视频已完成，但结果保存尚未确认；请读取原任务后继续，不会自动重试。");
            assertCurrent();
            return true;
          } finally { if (batchAuthorizationRef.current === authorization) batchAuthorizationRef.current = null; setBatchMode(""); }
        },
      });
      if (continuousAuthorizationRef.current !== session) return;
      if (outcome === "waiting") {
        setContinuousStatus("waiting"); setContinuousMessage("请查看每张角色三视图并分别点击“使用这张”。全部确认保存后会在本页继续分镜图和视频；可随时暂停。");
      } else {
        continuousAuthorizationRef.current = null; setContinuousStatus(outcome === "completed" ? "done" : "stopped");
        setContinuousMessage(outcome === "completed" ? "本项目的分镜图与视频已完成。" : "制作已停止，请核对当前段落或重新确认剩余费用。");
      }
    } catch (error) {
      if (continuousAuthorizationRef.current === session) {
        continuousAuthorizationRef.current = null; setContinuousStatus("stopped");
        setContinuousMessage(error instanceof Error ? error.message : "连续制作已停止，请核对原任务后继续。");
      }
    } finally { continuousBusyRef.current = false; }
  }, [buildBatchAuthorization, ensureInitialReferencesAdopted, generateImage, generateVideo, generateVisualAsset,
    readReferenceImageSettings, referenceImageResolution, resolveVisualAssetUrls, saveBoardForVideo, saveStoryboardProject]);

  const startContinuousProduction = useCallback(async () => {
    if (resolveStoryboardExecutionMode(runRef.current) === "chained") { setNotice("串联模式请使用批量生图，确认首段后逐段完成，再制作视频。"); return; }
    if (continuousBusyRef.current || continuousAuthorizationRef.current || batchAuthorizationRef.current || visualAssetGenerationRef.current || visualAssetMutationRef.current
      || navigationRef.current || !contextReadyRef.current || !token || !userId || runRef.current.directorIntake?.phase === "assets" || runRef.current.draftImportNotice) return;
    const current = runRef.current;
    if (!activeVideoModel || !isStoryboardImageWorkflow(activeVideoModel)) { setContinuousMessage("连续制作需要支持单张分镜图的视频模型；请先选择兼容模型。"); return; }
    const blocker = storyboardAutomaticVideoProductionBlocker(current);
    if (blocker) { setContinuousStatus("stopped"); setContinuousMessage(blocker); return; }
    if (pendingAssetAttempts.length || referenceUploadPending.length) { setContinuousMessage("角色原请求或上传仍待核验，请先处理原任务。"); return; }
    if (activeImageSelectionIssue || activeImageRatioIssue || activeVideoSelectionIssue) {
      setContinuousMessage(activeImageRatioIssue || publicModelSelectionNotice(activeImageSelectionIssue || activeVideoSelectionIssue, activeImageSelectionIssue ? "生图模型" : "视频模型"));
      return;
    }
    const referenceInputs = new Map<string, string>();
    let referenceCount = 0;
    try {
      if (resolveStoryboardExecutionMode(current) === "reference" && current.directorIntake?.phase === "planned") for (const draft of current.visualAssetWorkspace?.drafts || []) {
        if (draft.role !== "character" && draft.role !== "pet") continue;
        const input = storyboardFirstThreeViewInput({ planId: draft.planId, role: draft.role, name: draft.name, prompt: draft.prompt, tags: draft.tagsText.split(/[，,]/u).map(value => value.trim()).filter(Boolean), customCategory: draft.customCategory });
        referenceInputs.set(draft.planId, JSON.stringify(input));
        const candidate = current.visualAssetWorkspace?.candidates.find(item => item.planId === draft.planId && item.projectId === current.id
          && item.role === draft.role && item.assetId === `generated_${item.historyRecordId}` && item.storageKey === undefined
          && storyboardDirectorCandidateMatchesDraft(item, draft, current.visualAssetPlan!.assets.find(asset => asset.id === draft.planId)!));
        if (!candidate && !pruneStoryboardDirectorAssetConfirmations(current)?.confirmedAssets?.some(item => item.planId === draft.planId)) referenceCount++;
      }
      if (referenceCount && visualAssetGenerationIssue) throw new Error(visualAssetGenerationIssue);
      const tokenBilling = resolveVideoTokenBillingConsent(activeVideoModel, tokenChargeConsentRef.current);
      if (activeVideoModel?.billingUnit === "token" && !tokenBilling) throw new Error("请明确填写每条视频最多自动扣款金额，再确认总费用。");
      const referencePrice = resolveStoryboardExecutionMode(current) === "reference" ? storyboardImagePrice(referenceImageModel, referenceImageResolution) : 0;
      const imagePrice = storyboardImagePrice(activeImageModel, activeImageResolution);
      const videoPrice = tokenBilling?.maxChargeYuan ?? effectiveVideoCharge(activeVideoModel, activeVideoResolution, activeVideoDuration);
      const images = current.cards.filter(card => card.imageStatus !== "done").length;
      const videos = current.cards.filter(card => card.videoStatus !== "done").length;
      storyboardProductionQuote({ references: referenceCount, images, videos, referencePrice, imagePrice, videoPrice });
      if (!referenceCount && !images && !videos) { setContinuousStatus("done"); setContinuousMessage("本项目的分镜图与视频已完成。"); return; }
      if (runRef.current !== current) throw new Error("项目已变化，请重新确认本次制作。");
      continuousAuthorizationRef.current = { owner: userId + "\0" + token, runId: current.id, planFingerprint: storyboardProductionPlanFingerprint(current),
        referencePrice, imagePrice, videoPrice, tokenBilling, referenceInputs, stage: "references" };
      setContinuousStatus("running"); void processContinuousProduction();
    } catch (error) { setContinuousStatus("stopped"); setContinuousMessage(error instanceof Error ? error.message : "制作报价未确认，本次未提交。"); }
  }, [activeImageModel, activeImageRatioIssue, activeImageResolution, activeImageSelectionIssue, activeVideoDuration, activeVideoModel, activeVideoResolution,
    activeVideoSelectionIssue, pendingAssetAttempts.length, processContinuousProduction, referenceImageModel, referenceImageResolution, referenceUploadPending.length, token, userId, visualAssetGenerationIssue]);

  useEffect(() => {
    const session = continuousAuthorizationRef.current;
    if (!session) return;
    if (run.id !== session.runId || imageDownloadOwnerRef.current !== session.owner || storyboardProductionPlanFingerprint(run) !== session.planFingerprint
      || session.assetFingerprint && storyboardProductionAssetFingerprint(run) !== session.assetFingerprint) { pauseContinuousProduction(); return; }
    if (continuousStatus !== "waiting" || visualAssetSaving || visualAssetGenerating || continuousBusyRef.current || !run.directorIntake) return;
    if (resolveStoryboardExecutionMode(run) === "reference") {
      try { collectStoryboardDirectorReferenceBindings(run, run.directorIntake.input); }
      catch { return; }
    }
    void processContinuousProduction();
  }, [continuousStatus, pauseContinuousProduction, processContinuousProduction, run, visualAssetGenerating, visualAssetSaving]);

  useEffect(() => {
    if (!projectToRestore || !recoveryReadReady) return;
    let active = true; contextReadyRef.current = false; setProjectContext("loading");
    const generation = ++projectRestoreGenerationRef.current;
    setNotice(STORYBOARD_RECOVERY_NOTICE);
    const clearRecoveryNotice = () => setNotice(current =>
      active && generation === projectRestoreGenerationRef.current ? clearStoryboardRecoveryNotice(current) : current);
    void cloud.restore(projectToRestore).then(document => {
      if (!active || generation !== projectRestoreGenerationRef.current) return;
      const normalized = normalizeRun(document);
      if (!normalized || normalized.id !== projectToRestore) { clearRecoveryNotice(); setProjectContext("error"); setProjectContextError("项目不存在、无权访问或读取失败；本地未保存内容仍保留，请重新读取。"); return; }
      // Reapply local edits only against unchanged saved business content.
      // Monitoring timestamps/statuses can never make a stale draft win a conflict.
      const recovery = initialRecoveryRef.current;
      const base = storyboardRecoveryContentFingerprint(normalized);
      const result = inspectStoryboardRecoveryEdits(normalized, recovery);
      if (recovery && (result.status === "conflict" || !recovery.baseContentFingerprint)) {
        setRecoveryConflictDraft(recovery.run);
        try {
          preserveStoryboardRecoveryConflict(sessionStorage, recoveryKeyRef.current, recovery);
          setNotice("云端项目已有新内容，本地未保存稿已另行保留；可下载未保存稿，不会覆盖云端任务。");
        } catch {
          recoveryOverwriteBlockedRef.current = true;
          setNotice("浏览器未能另存冲突稿，原恢复记录已保留；请下载本地未保存稿，并及时保存新编辑。");
        }
      }
      const restored = result.run;
      if (hasSubmittedWork(normalized) || recovery?.baseContentFingerprint) submittedRunIdsRef.current.add(normalized.id);
      confirmedRecoveryBaseRef.current = base;
      runRef.current = restored; setRun(restored); setConfirmedProjectSnapshot(normalized.id + ":" + JSON.stringify(createStoryboardPersistenceSnapshot(normalized))); contextReadyRef.current = true; setProjectContext("ready"); setStorageReady(true);
      clearRecoveryNotice();
    }).catch(() => {
      if (!active || generation !== projectRestoreGenerationRef.current) return;
      clearRecoveryNotice();
      contextReadyRef.current = false;
      setProjectContext("error"); setProjectContextError("项目草稿未通过完整性校验，原记录仍保留；请重新读取，不会覆盖为空项目。");
    });
    return () => {
      active = false;
      if (generation === projectRestoreGenerationRef.current) contextReadyRef.current = false;
    };
  }, [cloud.restore, projectToRestore, projectRestoreAttempt, recoveryReadReady]);

  const downloadRecoveryDraft = (draft = recoveryConflictDraft) => {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(createStoryboardPersistenceSnapshot(draft), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "分镜-本地未保存稿.json");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const startFreshWorkspace = useCallback((discardLocalRecovery = false) => {
    if (!discardLocalRecovery && !recoveryReadReady) return;
    const previous = initialRecoveryRef.current;
    try {
      if (previous && recoveryKeyRef.current && !discardLocalRecovery) {
        try { preserveStoryboardRecoveryConflict(sessionStorage, recoveryKeyRef.current, previous); }
        catch {
          // A distinct older conflict is retained. A second bounded slot lets
          // the user leave this project without discarding either draft.
          preserveStoryboardRecoveryConflict(sessionStorage, `${recoveryKeyRef.current}:new-workspace`, previous, recoveryKeyRef.current);
          setRecoveryExtraDraft(previous.run);
        }
      }
      const fresh = createRun();
      const discardedRunIds = [runRef.current.id, initialProjectIdRef.current, previous?.run.id || ""];
      if (discardLocalRecovery) for (const id of discardedRunIds) if (id) discardedRecoveryRunIdsRef.current.add(id);
      // Invalidate reads and queued edits before releasing the old workspace.
      workspaceGenerationRef.current++;
      projectRestoreGenerationRef.current++;
      initialProjectIdRef.current = "";
      initialRecoveryRef.current = null;
      confirmedRecoveryBaseRef.current = "";
      recoveryOverwriteBlockedRef.current = false;
      if (projectAutosaveRef.current) window.clearTimeout(projectAutosaveRef.current.timer);
      projectAutosaveRef.current = null;
      for (const timer of imageAutoResumeTimersRef.current.values()) window.clearTimeout(timer);
      imageAutoResumeTimersRef.current.clear();
      batchAuthorizationRef.current = null;
      continuousAuthorizationRef.current = null;
      visualAssetBatchRef.current = null;
      videoBatchPreflightRef.current = false;
      agentHandoffConsumedRef.current = true;
      automaticAgentImportRef.current = "";
      agentImportBusyRef.current = false;
      referenceUploadOperationRef.current = null;
      visualAssetMutationRef.current = false;
      visualAssetGenerationRef.current = false;
      visibleReferenceChoicesRef.current = null;
      referenceDisplayContextRef.current = fresh.id;
      runRef.current = fresh;
      setRun(fresh);
      setAgentHandoff({ status: "hidden" });
      setGeneralScriptHandoff({ status: "hidden" });
      setGeneralScriptImportedRunId("");
      setBatchMode("");
      setContinuousStatus("idle");
      setContinuousMessage("");
      setReferenceDisplayMode("normal");
      setResolvedVisualAssetPlan(null);
      setVisualAssetCandidates([]);
      setVisualAssetSaving(false);
      setVisualAssetGenerating(false);
      setVisualAssetError("");
      setPreviewMedia(null);
      setUploadingCardId("");
      setRecoveryConflictDraft(null);
      setRecoveryExtraDraft(null);
      setSavedRecoveryDrafts([]);
      setCanDiscardRecovery(false);
      setFreshWorkspace(true);
      setRecoveryProjectId("");
      setConfirmedProjectSnapshot("");
      contextReadyRef.current = true;
      navigationRef.current = false;
      setNavigating(false);
      setRecoveryReadReady(true);
      setStorageReady(true);
      setProjectContext("ready");
      setProjectContextError("");
      let storageCleared = true;
      try {
        if (discardLocalRecovery && recoveryKeyRef.current) clearStoryboardWorkspaceRecovery(sessionStorage, recoveryKeyRef.current, discardedRunIds);
        if (agentHandoff.status === "ready" || agentHandoff.status === "imported") {
          storageCleared = acknowledgeAgentWorkbenchHandoffAcrossTabs("storyboard-workbench", userId, agentHandoff.handoff.handoff_id);
        }
        sessionStorage.removeItem(workbenchUserStorageKey(GENERAL_SCRIPT_HANDOFF_STORAGE_KEY, userId));
        sessionStorage.removeItem(workbenchUserStorageKey(GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY, userId));
      } catch { storageCleared = false; }
      router.replace("/storyboard-workbench", { scroll: false });
      setNotice(storageCleared ? "当前工作区已清空，已新建 3 张空卡。已提交任务和历史作品保留。"
        : "当前工作区已清空，已新建 3 张空卡；浏览器暂存未能完全移除，普通入口不会恢复旧内容。历史作品保留。");
    } catch {
      if (previous) setRecoveryExtraDraft(previous.run);
      projectRestoreGenerationRef.current++;
      setNotice(clearStoryboardRecoveryNotice);
      contextReadyRef.current = false;
      setProjectContext("error"); setCanDiscardRecovery(true);
      setProjectContextError("浏览器未能另存当前稿，已有稿件均未覆盖。可以下载稿件，或明确放弃当前本地恢复后新建。");
    }
  }, [agentHandoff, recoveryReadReady, router, userId]);

  useEffect(() => {
    const returningFromHistory = previousHistoryPageRef.current && !historyPage;
    previousHistoryPageRef.current = historyPage;
    if (!returningFromHistory) return;
    if (explicitHistorySelectionRef.current) { explicitHistorySelectionRef.current = false; return; }
    if (view === "workbench" && !requestedEntryProjectId) startFreshWorkspace(true);
  }, [historyPage, requestedEntryProjectId, startFreshWorkspace, view]);

  const preferredVideoPresetActive = Boolean(run.videoContract && run.videoModelId === run.videoContract.modelId);
  const selectableImageModelCount = imageModels.filter((model) => !storyboardImageModelSelectionIssue(model)).length;
  const selectableVideoModelCount = videoModels.filter((model) => !storyboardVideoModelSelectionIssue(model, {
    ratio: run.videoContract?.modelId === model.id ? run.videoContract.ratio : run.ratio,
    duration: effectiveVideoDuration(model, run.videoContract?.modelId === model.id ? run.videoContract.duration : run.videoDuration),
  })).length;
  const activeGeneralScriptHandoff = generalScriptHandoff.status === "ready" || generalScriptHandoff.status === "imported"
    ? generalScriptHandoff.handoff
    : null;
  const activeGeneralScriptPreview = activeGeneralScriptHandoff?.bridge.preview;
  const handoffImportBlocked = run.cards.some((card) => (
    imageAttemptNeedsResolution(card)
    || isActiveVideoStatus(card.videoStatus)
  ));

  useEffect(() => {
    if (!storageReady || !contextReadyRef.current || projectContext !== "ready" || referenceDisplayContextRef.current === run.id) return;
    referenceDisplayContextRef.current = run.id;
    setReferenceDisplayMode(resolveStoryboardExecutionMode(run) === "chained" ? "chained" : resolveStoryboardExecutionMode(run) === "reference" ? "reference" : "normal");
  }, [projectContext, run.id, run.visualAssetPlan, storageReady]);
  const changeReferenceDisplayMode = async (mode: "normal" | "reference" | "chained") => {
    if (navigationRef.current || visualAssetMutationRef.current || visualAssetGenerationRef.current || referenceUploadOperationRef.current || boardExportLocksRef.current.size || imageSubmissionsRef.current.size || videoSubmissionsRef.current.size || !contextReadyRef.current) return;
    chainAuthorizationRef.current = null; continuousAuthorizationRef.current = null; batchAuthorizationRef.current = null;
    setChainStatus("idle");
    if (mode === "chained") {
      if (resolveStoryboardExecutionMode(runRef.current) === "chained") return;
      const before = runRef.current;
      const next: WorkbenchRun = { ...before, executionMode: "chained", chainRevision: (before.chainRevision || 1) + 1,
        visualAssetPlan: { ...before.visualAssetPlan, mode: "off", assets: before.visualAssetPlan?.assets || [] },
        cards: before.cards.map(card => ({ ...card, chainAnchorConfirmation: undefined, ...((card.imageUrl || card.imageRecordId) ? { imageReferenceState: "stale" as const } : {}) })), updatedAt: Date.now() };
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true)) { setNotice("串联模式保存未确认，请重试。"); return; }
      if (runRef.current.id !== before.id) return;
      runRef.current = next; setRun(next); setReferenceDisplayMode("chained");
      setNotice("串联模式：先生成并确认首段；后续逐段使用已保存分镜作为参考。现有角色资产与手动参考保留。"); return;
    }
    if (mode === "reference") {
      if (scopeMountedRef.current) setReferenceDisplayMode("reference");
      if (runRef.current.visualAssetPlan?.mode !== "selected" && !await selectVisualAssetMode("selected")) {
        if (scopeMountedRef.current) setReferenceDisplayMode("normal");
      }
      return;
    }
    if (runRef.current.visualAssetPlan?.mode === "selected" && !await selectVisualAssetMode("off")) return;
    if (resolveStoryboardExecutionMode(runRef.current) === "chained") {
      const next = { ...runRef.current, executionMode: "ordinary" as const, updatedAt: Date.now() };
      if (!await saveStoryboardProject(createStoryboardPersistenceSnapshot(next), true)) return;
      runRef.current = next; setRun(next);
    }
    if (scopeMountedRef.current) setReferenceDisplayMode("normal");
  };
  const currentVisualAssetUrls = resolvedVisualAssetPlan?.projectId === run.id && resolvedVisualAssetPlan.plan === run.visualAssetPlan ? resolvedVisualAssetPlan.urls : [];
  const assetBindingSummaries = run.cards.map(card => {
    try { return visualAssetBindingSummary(card, run.visualAssetPlan, currentVisualAssetUrls); }
    catch { return { requestedIds: [], boundIds: [], missingIds: [], complete: false, intentionallyEmpty: false }; }
  });
  const assetUsageCounts = Object.fromEntries((run.visualAssetPlan?.assets || []).map(asset => [asset.id, assetBindingSummaries.filter(summary => summary.boundIds.includes(asset.id)).length]));
  const assetUsageSegments = Object.fromEntries((run.visualAssetPlan?.assets || []).map(asset => [asset.id,
    run.cards.filter((_card, index) => assetBindingSummaries[index]?.boundIds.includes(asset.id)).map(card => card.order)]));
  const selectedAssets: DrawerVisualAsset[] = (run.visualAssetPlan?.mode === "selected" ? run.visualAssetPlan.assets : []).flatMap(asset => {
    const candidate = selectedVisualAssetCandidate(asset, visualAssetCandidates, run.id);
    // 平台预设不在 user_files 候选里，按 presetId+revision 兜底，避免已绑定槽位显示“来源不可读取”
    const presetFallback = !candidate && asset.source?.kind === "platform-preset"
      ? presetAssets.find(item => item.presetId === asset.source?.presetId && (asset.source?.presetRevision == null || item.presetRevision === asset.source.presetRevision))
      : undefined;
    const resolved = candidate || presetFallback;
    return resolved ? [{ ...resolved, planId: asset.id, sceneId: asset.sceneId, sceneZone: asset.sceneZone, cameraCoverage: asset.cameraCoverage, fixedAnchors: asset.fixedAnchors, allowedSegmentKinds: asset.allowedSegmentKinds, derivedFromAssetId: asset.derivedFromAssetId, saved: resolved.saved === true }] : [];
  });


  const leaveAssetProject = async (destination: string, replace = false) => {
    if (navigationRef.current || visualAssetGenerationRef.current || visualAssetMutationRef.current || pendingAssetAttempts.length) { setVisualAssetError("请先确认当前生成或保存结果。"); return; }
    navigationRef.current = true; setNavigating(true);
    try {
      if (projectContext === "ready" && (!referenceOnly || Boolean(runRef.current.visualAssetWorkspace?.drafts.length || runRef.current.visualAssetWorkspace?.candidates.length))) {
        const snapshot = createStoryboardPersistenceSnapshot(runRef.current);
        const fingerprint = JSON.stringify(snapshot);
        if (!await saveVisualAssetContext(snapshot, true)) throw new Error("项目未保存成功，已保留当前页面，请重试。");
        if (!scopeMountedRef.current || runRef.current.id !== snapshot.id || JSON.stringify(createStoryboardPersistenceSnapshot(runRef.current)) !== fingerprint) throw new Error("项目内容已变化，请确认后再离开。");
      }
      if (replace) router.replace(destination); else router.push(destination);
      // The visual-assets page can reuse this component instance when it
      // returns to the workbench. Release the navigation lock after the
      // durable snapshot is confirmed so project-level actions (including
      // adding a card) are available on the returned workbench.
      navigationRef.current = false;
      setNavigating(false);
    } catch (error) {
      navigationRef.current = false; setNavigating(false);
      setVisualAssetError(error instanceof Error ? error.message : "保存未确认，已保留当前页面。");
    }
  };
  const returnFromAssets = () => {
    const projectId = requestedProjectId || (projectContext === "ready" && !referenceOnly ? run.id : "");
    void leaveAssetProject(projectId ? '/storyboard-workbench?projectId=' + encodeURIComponent(projectId) : '/storyboard-workbench');
  };
  const applyAndReturn = async (mutation: DrawerVisualAssetMutation, save: boolean) => {
    const id = runRef.current.id; const success = await applyVisualAssets(mutation, save);
    if(success && scopeMountedRef.current && runRef.current.id === id && view === "visual-assets") {
      router.push('/storyboard-workbench?projectId=' + encodeURIComponent(id));
      navigationRef.current = false;
      setNavigating(false);
    }
    return success;
  };
  const referenceImagePrice = storyboardImagePrice(referenceImageModel, referenceImageResolution);
  const referenceImageSummary = referenceImageModel && !referenceImageSelectionIssue && Number.isFinite(referenceImagePrice)
    ? `图 ${referenceImageResolution} ¥${referenceImagePrice.toFixed(2)}` : "参考图价格待确认";
  // 只给独立的「角色参考」页面用：那里没有顶部工具栏，需要就地选择模型/清晰度/比例。
  // 工作台内不再渲染这套控件，避免与顶部参数重复。
  const modelControls = <section className="sbw-asset-model-controls" aria-label="参考图生成设置">
    <label>参考图模型<select aria-label="参考图生图模型" value={referenceSettings.modelId} disabled={projectContext !== "ready" || visualAssetGenerating || visualAssetSaving || navigating} onChange={event=>{const model=imageModels.find(item=>item.id===event.target.value);if(model)selectReferenceImageModel(model);}}><option value="" disabled>选择模型</option>{imageModels.map(model=>{const issue=storyboardImageModelSelectionIssue(model);return <option key={model.id} value={model.id} disabled={Boolean(issue)}>{storyboardImageModelName(model)} · {issue ? publicModelSelectionLabel(issue) : '¥'+storyboardImagePrice(model,effectiveImageResolution(model,referenceSettings.resolution)).toFixed(2)}</option>})}</select></label>
    <label>参考图清晰度<select aria-label="参考图清晰度" value={referenceImageResolution} disabled={projectContext !== "ready" || visualAssetGenerating || visualAssetSaving || navigating} onChange={event=>patchReferenceImageSettings({resolution:event.target.value})}>{(referenceImageModel?.resolution_options || [referenceImageResolution]).map(value=><option key={value} value={value}>{value}</option>)}</select></label>
    <label>参考图比例<select aria-label="参考图比例" value={referenceSettings.ratio} disabled={projectContext !== "ready" || visualAssetGenerating || visualAssetSaving || navigating} onChange={event=>patchReferenceImageSettings({ratio:event.target.value as WorkbenchRatio})}>{!referenceImageRatioOptions.includes(referenceSettings.ratio) && <option value={referenceSettings.ratio} disabled>{referenceSettings.ratio}（当前模型不支持）</option>}{referenceImageRatioOptions.map(value=><option key={value} value={value}>{value}</option>)}</select></label><span>{referenceImageSummary}</span>
  </section>;
  const directorConfirmedSlots = run.directorIntake ? new Set(run.visualAssetPlan?.assets.filter(asset => {
    const source = asset.source;
    return (asset.role === "character" || asset.role === "pet") && source?.kind === "generated-image-history" && source.historyRecordId
      && source.assetId === `generated_${source.historyRecordId}` && source.storageKey === undefined
      && run.visualAssetWorkspace?.candidates.some(candidate => candidate.planId === asset.id && candidate.role === asset.role
        && candidate.assetId === source.assetId && candidate.historyRecordId === source.historyRecordId && candidate.storageKey === undefined)
      && hasStoryboardDirectorAssetConfirmation(run.directorIntake?.confirmedAssets, {
        planId: asset.id, sourceAssetId: source.assetId, historyRecordId: source.historyRecordId, role: asset.role,
      });
  }).map(asset => asset.id) || []) : undefined;
  const directorLegacySlots = directorLegacyAssetSlotIds(run);

  // Viewing an existing result is local UI state; it never changes saved media or billing.
  const [cardMediaViews, setCardMediaViews] = useState<Record<string, "image" | "video">>({});
  const switchExistingCardMedia = (card: WorkbenchCard, media: "image" | "video", current: "image" | "video") => {
    if (!card.imageUrl || !card.videoUrl || current === media) return false;
    if (navigationRef.current || visualAssetMutationRef.current || imageSubmissionsRef.current.has(card.id)
      || videoSubmissionsRef.current.has(card.id) || imageAttemptNeedsResolution(card)
      || isActiveVideoStatus(card.videoStatus) || batchMode || exportingBoardIds.has(card.id)) return true;
    setCardMediaViews(views => ({ ...views, [run.id + ":" + card.id]: media }));
    return true;
  };
  // Wheel gestures only scroll the rail. Stepping the selection at an edge used
  // to jump the scrollbar back to the opposite end, so model switching stays a
  // deliberate click.
  const imageModelListRef = useRef<HTMLDivElement | null>(null);
  const videoModelListRef = useRef<HTMLDivElement | null>(null);
  // A single sliding indicator per rail: the bar glides to the selected row
  // instead of blinking off one row and on another.
  const [imageModelIndicator, setImageModelIndicator] = useState<{ top: number; height: number } | null>(null);
  const [videoModelIndicator, setVideoModelIndicator] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const measure = (list: HTMLDivElement | null) => {
      const active = list?.querySelector<HTMLButtonElement>("button.is-active");
      return active && list ? { top: active.offsetTop, height: active.offsetHeight } : null;
    };
    const frame = requestAnimationFrame(() => {
      setImageModelIndicator(measure(imageModelListRef.current));
      setVideoModelIndicator(measure(videoModelListRef.current));
    });
    return () => cancelAnimationFrame(frame);
  }, [run.imageModelId, run.videoModelId, imageModels.length, videoModels.length]);

  const referenceCreation = (<>
    {view !== "visual-assets" && modelControls}
    <StoryboardVisualAssetsDrawer open={true} onOpenChange={() => undefined} presentation={view === "visual-assets" ? "page" : "inline"} canGenerate={projectContext === "ready" && !navigating} canApply={projectContext === "ready" && !referenceOnly && !navigating && (!requestedSlotId || Boolean(run.visualAssetWorkspace?.drafts.some(draft => draft.planId === requestedSlotId) || run.visualAssetPlan?.assets.some(asset => asset.id === requestedSlotId)))} targetSlotId={requestedSlotId} onOpenLibrary={openVisualAssetStudio} pendingUploads={referenceUploadPending.filter(item => item.contextId === run.id).map(item => ({ planId: item.draft.planId, canRead: Boolean(item.storageKey), unknown: !item.storageKey }))} onReturn={returnFromAssets} modelControls={view === "visual-assets" ? modelControls : undefined} projectId={projectContext === "ready" && !referenceOnly ? run.id : ""}
        key={visualAssetRecoveryRevision} onVisibleCandidatesChange={rememberVisibleReferenceChoices} initialDrafts={run.visualAssetWorkspace?.drafts} onDraftsChange={changeVisualAssetDrafts}
        onDeleteDraft={planId => applyVisualAssets({ type: "remove", slotId: planId }, false, true)}
        requiresExplicitAdoption={Boolean(run.directorIntake)} continuesInWorkbench={run.directorIntake?.phase === "planned"} taskCount={run.cards.length} assetUsageCounts={assetUsageCounts} assetUsageSegments={assetUsageSegments} referenceLimit={referenceLimit} modelName={referenceImageModel ? storyboardImageModelName(referenceImageModel) : ""}
        priceLabel={referenceImageSummary} generationIssue={visualAssetGenerationIssue} candidates={visualAssetCandidates.map(item => ({ ...item, saved: item.saved === true }))}
        selectedAssets={directorConfirmedSlots ? selectedAssets.filter(asset => directorConfirmedSlots.has(asset.planId)) : selectedAssets} selectedSlotIds={run.visualAssetPlan?.mode === "selected" ? run.visualAssetPlan.assets.filter(asset => Boolean(asset.source?.assetId) && (!directorConfirmedSlots || directorConfirmedSlots.has(asset.id))).map(asset => asset.id) : []} loading={visualAssetLoading} generating={visualAssetGenerating} saving={visualAssetSaving} error={visualAssetError}
        pendingRecoveryCount={pendingAssetAttempts.length} onRecoverPending={recoverPendingAssets}
        onUploadReference={(file, input) => withFirstReferenceAdoption(input, () => uploadReferenceImage(file, input))} onLoadImportImages={loadImportImages} onImportImage={(image, input) => withFirstReferenceAdoption(input, () => importReferenceImage(image, input))}
        onReload={() => loadVisualAssetCandidates()} onGenerate={input => withFirstReferenceAdoption(input, () => generateVisualAsset(input))} onGenerateBatch={generateVisualAssets} onUpdateAsset={updateVisualAssetMetadata} onSaveSelected={saveVisualAssetSelection} onApply={applyAndReturn}
        presetAssets={presetAssets} presetsLoading={presetsLoading} onReloadPresets={loadPresetAssets}
        hasMore={visualAssetNextOffset !== null} onLoadMore={() => loadVisualAssetCandidates(visualAssetNextOffset || 0)} />
  </>);
  if(view === "visual-assets" && (projectContext === "loading" || projectContext === "error")) return <div className="voice-studio-root vs-workbench sbw-root sbw-assets-page"><SubPageHeader title="角色参考" subtitle="身份参考生成 · 分类角色库" /><p role="status" className="p-6">{projectContext === "loading" ? '正在加载项目…' : projectContextError}</p>{visualAssetError && <p role="alert">{visualAssetError}</p>}<button type="button" disabled={navigating} onClick={returnFromAssets}>返回分镜工作台</button></div>;
  if(view === "visual-assets") return <div className="voice-studio-root vs-workbench sbw-root sbw-assets-page"><SubPageHeader title="角色参考" subtitle="身份参考生成 · 分类角色库" />{notice && <p className="sbw-asset-context" role="status">{notice}</p>}{referenceCreation}</div>;
  if(!historyPage && (projectContext === "loading" || projectContext === "error")) return <div className="voice-studio-root vs-workbench sbw-root"><SubPageHeader title="分镜工作台" /><p role="status" className="p-6">{projectContext === "loading" ? '正在加载项目…' : projectContextError}</p>{projectContext === "error" && <button type="button" onClick={() => setProjectRestoreAttempt(value => value + 1)}>重新读取项目</button>}{recoveryConflictDraft && <button type="button" onClick={() => downloadRecoveryDraft()}>下载本地未保存稿</button>}<button type="button" disabled={!recoveryReadReady} onClick={() => startFreshWorkspace()}>返回新工作台</button>{recoveryExtraDraft && <button type="button" onClick={() => downloadRecoveryDraft(recoveryExtraDraft)}>下载另一份本地稿</button>}{canDiscardRecovery && <button type="button" onClick={() => { if (window.confirm("确认放弃当前本地恢复并新建？云端项目和已有费用记录不会删除。请先下载需要保留的本地稿。")) startFreshWorkspace(true); }}>放弃当前本地恢复并新建</button>}</div>;
  return (
    <div className="voice-studio-root vs-workbench sbw-root sbw-editor" data-ratio={activeImageRatio}>
      <div className="sbw-main" hidden={historyPage} aria-hidden={historyPage || undefined}>
      <StoryboardEditorViewport enabled={compactEditor}>
      <SubPageHeader
        title="分镜工作台"
        icon={<Sparkles className="h-5 w-5" />}
        showThemeSwitcher={false}
        rightSlot={null}
      />

      <fieldset className="sbw-body" disabled={navigating || visualAssetSaving}><main className="sbw-shell">
        <aside className={`${modelRailRestoration.rail}${compactEditor ? ` ${modelRailRestoration.publicRail}` : ""} sbw-model-rail`} aria-label="生成模型">
          <section className="sbw-model-section sbw-image-model-section" aria-label="生图模型">
            <header><span>生图模型</span><small className="sbw-model-hint">{imageModelCatalogState === "loading" && imageModels.length === 0 ? "读取中" : `${imageModels.length} 个模型 · ${selectableImageModelCount} 个可选`}</small></header>
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
            <div className="sbw-model-list sbw-image-model-list" ref={imageModelListRef}>
              {imageModelIndicator && <span className="sbw-model-indicator" aria-hidden="true" style={{ height: imageModelIndicator.height, transform: `translateY(${imageModelIndicator.top}px)` }} />}
              {imageModels.map((model) => {
                const capabilities = getImageModelCapabilities(model);
                const displayName = storyboardImageModelName(model);
                const brand = resolveModelBrand(displayName, model.display_name, model.name, model.model_name, model.provider) || "generic";
                const preferredResolution = preferredStoryboardImageResolution(model);
                const selectionIssue = storyboardImageModelSelectionIssue(model);
                const preferredPrice = storyboardImagePrice(model, preferredResolution);
                // Show every tier the catalog actually allows, not just the default,
                // so a model that supports 1K/2K/4K never looks like a 1K-only model.
                const resolutionSummary = capabilities.resolutionOptions.length
                  ? capabilities.resolutionOptions.join("/")
                  : preferredResolution;
                const imagePriceLabel = model.priceReady && Number.isFinite(preferredPrice)
                  ? `${resolutionSummary} ¥${preferredPrice.toFixed(2)}/张`
                  : `${resolutionSummary} · 价格待配置`;
                const imagePriceChip = model.priceReady && Number.isFinite(preferredPrice)
                  ? `¥${preferredPrice.toFixed(2)}`
                  : "待配置";
                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={Boolean(selectionIssue)}
                    data-model-brand={brand}
                    data-model-id={model.id}
                    data-model-selectable={selectionIssue ? "false" : "true"}
                    data-reference-limit={capabilities.maxReferenceImages}
                    className={run.imageModelId === model.id ? "is-active" : ""}
                    aria-label={selectionIssue ? `${displayName} 当前未开放` : `选择生图模型：${displayName}`}
                    aria-disabled={Boolean(selectionIssue)}
                    title={displayName}
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
                      <strong title={displayName}>
                        <span className="sbw-model-name">{displayName}</span>
                        {model.variantLabel && <em className="sbw-model-variant">{model.variantLabel}</em>}
                      </strong>
                      <small className="sbw-model-meta" title={`默认 ${capabilities.defaultResolution} · ${capabilities.referenceCapabilityLabel}`}>
                        <span className="sbw-model-tier">{resolutionSummary}</span>
                        {!compactEditor && <span className="sbw-model-cap">{capabilities.referenceCapabilityLabel}</span>}
                        <span className={`sbw-model-price${model.priceReady ? "" : " is-pending"}`} title={imagePriceLabel}>
                          {imagePriceChip}{model.priceReady && <em>/张</em>}
                        </span>
                      </small>
                      {compactEditor && <span className="sbw-model-cap" title={capabilities.referenceCapabilityLabel}>{capabilities.referenceCapabilityLabel}</span>}
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
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="sbw-model-section sbw-video-model-section" aria-label="视频模型">
            <header><span>视频模型</span><small className="sbw-model-hint">{videoModelCatalogState === "loading" && videoModels.length === 0 ? "读取中" : `${videoModels.length} 个模型 · ${selectableVideoModelCount} 个可选`}</small></header>
            {videoModelCatalogState === "loading" && videoModels.length === 0 && (
              <p className="sbw-model-catalog-state" role="status"><Loader2 className="animate-spin" />正在读取可用视频模型…</p>
            )}
            {videoModelCatalogState === "error" && videoModels.length === 0 && (
              <div className="sbw-model-catalog-state is-error" role="alert"><span>视频模型暂时无法读取</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {videoModelCatalogState === "ready" && videoModels.length === 0 && (
              <div className="sbw-model-catalog-state"><span>当前暂无已添加的视频模型</span><button type="button" onClick={() => setModelCatalogReloadKey((value) => value + 1)}><RotateCcw />重新加载</button></div>
            )}
            {run.videoModelId && !activeVideoModel && <p role="status">原视频模型当前不可选，请手动选择。</p>}
            <div className="sbw-model-list sbw-video-model-list" ref={videoModelListRef}>
              {videoModelIndicator && <span className="sbw-model-indicator" aria-hidden="true" style={{ height: videoModelIndicator.height, transform: `translateY(${videoModelIndicator.top}px)` }} />}
              {videoModels.map((model) => {
                const displayName = compactVideoModelName(model);
                const fullDisplayName = publicModelName(model);
                const brand = resolveModelBrand(displayName, model.display_name, model.name, model.id) || "generic";
                const channelCode = modelChannelCode(model);
                const channelLabel = channelCode ? `渠道${channelCode}` : "";
                const defaultDuration = effectiveVideoDuration(model);
                const preferredResolution = effectiveVideoResolution(model);
                const defaultCharge = effectiveVideoCharge(model, preferredResolution, defaultDuration);
                const outputSecondPrice = model.billingUnit === "output_second" && defaultDuration > 0
                  ? defaultCharge / defaultDuration
                  : 0;
                const priceLabel = model.generationReady === false
                  ? model.billingUnit === "token" ? "Token 计价" : model.priceReady && Number.isFinite(model.pricePerUse)
                    ? `¥${Number(model.pricePerUse).toFixed(2)}/${model.billingUnit === "output_second" ? "秒" : "次"}` : "—"
                  : model.billingUnit === "token" ? videoTokenRateLabel(model, preferredResolution) : model.priceReady && Number.isFinite(defaultCharge) && Number.isFinite(outputSecondPrice)
                  ? `¥${model.billingUnit === "output_second" ? outputSecondPrice.toFixed(2) : defaultCharge.toFixed(2)}/${model.billingUnit === "output_second" ? "秒" : "次"}`
                  : "—";
                const isPreferredContractModel = run.videoContract?.modelId === model.id;
                const selectionTarget = {
                  ratio: isPreferredContractModel ? run.videoContract!.ratio : run.ratio,
                  duration: effectiveVideoDuration(model, isPreferredContractModel ? run.videoContract!.duration : run.videoDuration),
                };
                const selectionIssue = storyboardVideoModelSelectionIssue(model, selectionTarget);
                const inputLabel = videoModelInputLabel(model);
                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={Boolean(selectionIssue)}
                    data-model-brand={brand}
                    data-model-id={model.id}
                    data-model-selectable={selectionIssue ? "false" : "true"}
                    className={run.videoModelId === model.id ? "is-active" : ""}
                    aria-label={`选择视频模型：${fullDisplayName}`}
                    aria-disabled={Boolean(selectionIssue)}
                    title={fullDisplayName}
                    onClick={() => {
                      if (selectionIssue) {
                        setNotice("请选择其他视频模型");
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
                      const supportedRatios = supportedVideoRatios(model);
                      const nextRatio = supportedRatios.includes(resolvedSelection.ratio as WorkbenchRatio)
                        ? resolvedSelection.ratio as WorkbenchRatio
                        : supportedRatios[0] || run.ratio;
                      const failedVideoCards = run.cards.filter((card) => card.videoStatus === "failed").length;
                      const resettableFailedVideoCards = run.cards.filter((card) => card.videoStatus === "failed" && card.videoRetryable === true && card.videoSameRequestKeyRequired !== true).length;
                      const retainedFailedVideoCards = failedVideoCards - resettableFailedVideoCards;
                      patchRun({
                        videoModelId: model.id,
                        videoResolution: resolvedSelection.resolution,
                        videoDuration: resolvedSelection.duration,
                        ratio: nextRatio,
                        cards: resetFailedVideoCardsForModelSwitch(run.cards),
                      });
                      setNotice([
                        `已选择 ${fullDisplayName}`,
                        resettableFailedVideoCards > 0 ? `${resettableFailedVideoCards} 个失败任务可按当前模型重新提交` : "",
                        retainedFailedVideoCards > 0 ? `${retainedFailedVideoCards} 个原视频任务仍需先查询或按原参数处理` : "",
                      ].filter(Boolean).join("，"));
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
                      <strong title={fullDisplayName}><span className="sbw-model-name">{displayName}</span></strong>
                      <small className="sbw-model-meta" title={[channelLabel, priceLabel, videoModelInputHint(model)].filter(Boolean).join(" · ")}>
                        {channelLabel && <span className="sbw-model-channel">{channelLabel}</span>}
                        {model.generationReady !== false && <span className="sbw-model-tier">{videoResolutionDisplayLabel(model, preferredResolution)}</span>}
                        {!compactEditor && inputLabel && <span className="sbw-model-need">{inputLabel}</span>}
                        <span className={`sbw-model-price${model.priceReady ? "" : " is-pending"}`} title={priceLabel} aria-label={priceLabel}>
                          {model.billingUnit === "token" ? priceLabel.replace(" · 按实际用量结算", "") : priceLabel}
                        </span>
                      </small>
                      {compactEditor && <span className="sbw-model-need" title={inputLabel}>{inputLabel.split(" · ", 1)[0]}</span>}
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
                      <strong>{agentHandoff.plan.phase === "assets" ? storyboardIdentityAssetLabel(agentHandoff.plan.visualAssetPlan) : `${agentHandoff.plan.segments.length} 个生产段`}</strong>
                      <span>{agentHandoff.plan.settings.aspectRatio} · {agentHandoff.plan.settings.animationStyle}</span>
                    </div>
                    <div className="sbw-control-group is-video">
                      <span className="sbw-control-tag">稳定机器包</span>
                      <strong>{agentHandoff.plan.schemaVersion}</strong>
                      <span>{!agentHandoff.plan.intakeVerified ? "提示词草稿：请核对分段、比例、时长和原提示词；原回复保持完整。" : agentHandoff.plan.phase === "assets" ? "先生成并采用角色三视图，再续写分镜提示词" : agentHandoff.plan.promptDraft ? "已读取原接收卡和成组图、视频提示词；生成前请核对内容。" : "文案、生图 Prompt、视频 Prompt、时长与连续性已校验"}{agentHandoff.plan.visualAssetPlan?.assets.length ? ` · 含 ${agentHandoff.plan.visualAssetPlan.assets.length} 个视觉资产` : ""}</span>
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
              {(agentHandoff.status === "ready" || agentHandoff.status === "imported") && agentHandoff.plan.importWarnings?.length ? (
                <p role="note" style={{ margin: "12px 0 0", lineHeight: 1.7 }}>{agentHandoff.plan.importWarnings.join(" ")}</p>
              ) : null}
              <div className="sbw-toolbar-actions">
                {agentHandoff.status === "ready" && (
                  <button
                    type="button"
                    className="is-primary"
                    data-testid="agent-storyboard-handoff-confirm"
                    disabled={handoffImportBlocked}
                    onClick={confirmAgentHandoff}
                    title="只把结构化双 Prompt 建成分段卡，不调用模型、不扣费"
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
                      <span>{activeGeneralScriptPreview.silentNarration ? "后期旁白；表情、动作、视线和语义道具推进" : "确认后仍需人工检查分段表演"}</span>
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
                    title="只把双 Prompt 建成分段卡，不调用模型、不扣费"
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

          <section className="sbw-toolbar sbw-global-toolbar" aria-label="分镜工作台全局设置">
            <div className="sbw-toolbar-settings">
              <div className="sbw-control-group is-image">
                <span className="sbw-control-tag">{run.directorIntake?.phase === "assets" ? "三视图比例" : "分镜图比例"}</span>
                <div className="sbw-ratio-control" aria-label="图片比例">
                  {WORKBENCH_RATIOS.map((value) => {
                    const disabled = Boolean(batchMode) || !activeImageRatioOptions.includes(value);
                    return <button key={value} type="button" aria-pressed={activeImageRatio === value} disabled={disabled} title={disabled ? "当前图片模型不支持此比例" : `图片比例 ${value}`} className={activeImageRatio === value ? "is-active" : ""} onClick={() => patchRun({ imageRatio: value })}>{value}</button>;
                  })}
                </div>
                <select className="sbw-resolution-select" aria-label="图片分辨率" value={activeImageResolution} disabled={Boolean(batchMode) || imageResolutionChoices.length <= 1} title={activeImageModel ? "仅当前生图模型支持的清晰度可选" : undefined} onChange={(event) => patchRun({ imageResolution: event.target.value })}>
                  {imageResolutionChoices.map((value) => {
                    const supported = imageCapabilities.resolutionOptions.includes(value);
                    return <option key={value} value={value} disabled={!supported}>{value}</option>;
                  })}
                </select>
              </div>
              <div className="sbw-control-group is-video">
                <span className="sbw-control-tag">视频比例</span>
                <div className="sbw-ratio-control" aria-label="视频比例">
                  {WORKBENCH_RATIOS.map(value => <button key={value} type="button" aria-pressed={run.ratio === value} disabled={Boolean(batchMode) || activeVideoModel?.generationReady === false || preferredVideoPresetActive || !activeVideoRatioOptions.includes(value)} title={preferredVideoPresetActive ? `当前预设视频比例 ${run.videoContract!.ratio}` : `视频比例 ${value}`} className={run.ratio === value ? "is-active" : ""} onClick={() => patchRun({ ratio: value })}>{value}</button>)}
                </div>
                <select className="sbw-resolution-select" aria-label="视频分辨率" value={activeVideoResolution} disabled={Boolean(batchMode) || activeVideoModel?.generationReady === false || preferredVideoPresetActive || (activeVideoModel?.resolutionOptions.length || 0) <= 1} title={activeVideoModel?.resolutionOptions.length ? `${videoResolutionDisplayLabel(activeVideoModel, activeVideoResolution)} · ${videoResolutionPriceLabel(activeVideoModel, activeVideoResolution, activeVideoDuration)}` : "清晰度由模型自动确定"} onChange={(event) => patchRun({ videoResolution: event.target.value })}>
                  {activeVideoModel?.resolutionOptions.length ? activeVideoModel.resolutionOptions.map((value) => (
                    <option key={value} value={value}>{videoResolutionDisplayLabel(activeVideoModel, value)}</option>
                  )) : <option value={activeVideoResolution}>自动</option>}
                </select>
                <select className="sbw-resolution-select" aria-label="视频时长" value={activeVideoDuration} disabled={Boolean(batchMode) || activeVideoModel?.generationReady === false || preferredVideoPresetActive || activeVideoDurationOptions.length <= 1} title={activeVideoDurationOptions.length <= 1 ? `固定 ${activeVideoDuration} 秒` : "选择当前模型支持的视频时长"} onChange={(event) => patchRun({ videoDuration: Number(event.target.value) })}>
                  {activeVideoDurationOptions.length ? activeVideoDurationOptions.map((value) => <option key={value} value={value}>{value} 秒</option>) : <option value={activeVideoDuration}>固定 {activeVideoDuration} 秒</option>}
                </select>
              </div>
              <div className="sbw-mode-group" role="group" aria-label="分镜创作模式" data-testid="storyboard-mode-toggle">
                <span className="sbw-mode-label">创作模式</span>
                <div className="sbw-mode-toggle">
                  <button
                    type="button"
                    aria-pressed={referenceDisplayMode === "normal"}
                    disabled={Boolean(batchMode) || navigating || visualAssetSaving || visualAssetGenerating || projectContext !== "ready"}
                    onClick={() => void changeReferenceDisplayMode("normal")}
                    title="只使用每个分段自己的生图提示词和视频提示词"
                  >普通模式</button>
                  <button
                    type="button"
                    aria-pressed={referenceDisplayMode === "reference"}
                    disabled={Boolean(batchMode) || navigating || visualAssetSaving || visualAssetGenerating || projectContext !== "ready"}
                    onClick={() => void changeReferenceDisplayMode("reference")}
                    title="先维护角色参考资产，再将已确认的参考绑定到分镜卡"
                  >角色参考</button>
                  <button type="button" aria-pressed={referenceDisplayMode === "chained"} disabled={Boolean(batchMode) || navigating || visualAssetSaving || visualAssetGenerating || projectContext !== "ready"}
                    onClick={() => void changeReferenceDisplayMode("chained")} title="首段确认后，逐段使用首段与上一段参考生成">串联模式</button>
                </div>
              </div>
              <section className="sbw-parameter-info" aria-label="当前模型参数与计费说明">
                <div className="sbw-parameter-info-panel">
                  {activeImageRatioIssue && <p role="status" className="sbw-image-ratio-notice">{activeImageRatioIssue}</p>}
                  <p>视频清晰度：{activeVideoModel?.resolutionOptions.length ? videoResolutionDisplayLabel(activeVideoModel, activeVideoResolution) : "由模型自动确定"} · {activeVideoDurationOptions.length <= 1 ? "固定 " : "所选 "}{activeVideoDuration} 秒</p>
                  {activeVideoModel && <p>{videoResolutionPriceLabel(activeVideoModel, activeVideoResolution, activeVideoDuration)}</p>}
                  <VideoDurationBehaviorNotice durationBehavior={activeVideoModel?.durationBehavior} />
                  {activeVideoModel?.billingUnit === "token" && <label className="sbw-token-budget-label">
                    每条视频本次最多自动扣款金额（元）
                    <input aria-label="每条视频本次最多自动扣款金额" type="text" inputMode="decimal" autoComplete="off" placeholder="请填写金额" className="sbw-token-budget-input" disabled={Boolean(batchMode)}
                      value={tokenChargeConsent?.modelId === activeVideoModel.id && tokenChargeConsent.priceVersion === activeVideoModel.tokenPricing?.priceVersion ? tokenChargeConsent.amount : ""}
                      onChange={event => setTokenChargeConsent({ modelId: activeVideoModel.id, priceVersion: activeVideoModel.tokenPricing?.priceVersion || "", amount: event.target.value })} />
                    <small>按实际 Token 用量结算；预留不是扣费，超额待确认。批量每条使用同一额度。</small>
                  </label>}
                </div>
              </section>
            </div>
            <div className="sbw-toolbar-actions">
              <button type="button" className="sbw-batch-action is-image-batch" onClick={() => void batchImages()} disabled={Boolean(activeImageSelectionIssue && !run.cards.some((card) => card.imageRecoveryReady)) || Boolean(batchMode) || run.cards.some((card) => card.imageRetryBlocked && imageAttemptNeedsResolution(card))} title="按当前项目与报价顺序生成所有待处理分镜图"><ImageIcon />批量生图</button>
              <button type="button" className="sbw-batch-action is-video-batch" onClick={() => void batchVideos()} disabled={Boolean(batchVideoBlockedReason)} aria-describedby={batchVideoBlockedReason ? "sbw-batch-video-blocker" : undefined} title={batchVideoBlockedReason || "使用每段已确认的视频素材按顺序生成视频"}><Film />批量视频</button>
              <button type="button" className="sbw-toolbar-add-card" title="新增一个独立分段，填写该段的生图和视频提示词；参考图另行选择" disabled={visualAssetSaving || run.cards.length >= MAX_CARDS} onClick={() => void addCard()}><Plus />添加分镜</button>
              <span className="sbw-history-action"><NavButton icon={History} label="历史" variant="ghost" onClick={() => setHistoryOpen(true)} /></span>
            </div>
          </section>

          {batchVideoBlockedReason && <span id="sbw-batch-video-blocker" className="sr-only">{batchVideoBlockedReason}</span>}
          {referenceDisplayMode === "chained" && <section className="sbw-toolbar" aria-label="串联分镜控制" data-testid="storyboard-chain-control">
            <div role="status">{chainStatus === "running" ? "逐段生成中；正在等待当前分镜交付与保存。" : chainStatus === "waiting" ? "请查看首段图片，确认后将自动继续后续分镜。" : "首段确认一次；后续逐段使用首段（多图模型另带上一段）。"}</div>
            <div className="sbw-toolbar-actions">
              {!run.cards[0]?.chainAnchorConfirmation && chainDelivered(run.cards[0]) && <button type="button" className="is-primary" disabled={chainBusyRef.current} onClick={() => void confirmChainAnchor()}>确认并用于后续分镜</button>}
              {(chainStatus === "running" || chainStatus === "waiting") && <button type="button" onClick={() => { chainAuthorizationRef.current = null; setChainStatus("stopped"); setNotice("串联已暂停；当前原任务仍保留，继续前请重新确认剩余费用。"); }}>暂停串联</button>}
            </div>
          </section>}
          {run.draftImportNotice && <section className="sbw-toolbar" role="note" data-testid="storyboard-historical-draft-notice" style={{ whiteSpace: "pre-wrap" }}><strong>历史提示词草稿，请逐段核对</strong><p>{run.draftImportNotice}</p></section>}
          {referenceDisplayMode === "reference" && <section className="sbw-reference-step" aria-label="第一步 角色参考">{referenceCreation}</section>}
          {run.directorIntake?.phase === "assets" && <section className="sbw-toolbar" data-testid="director-assets-first-stage" aria-label="三视图完成后继续">
            <div className="sbw-toolbar-settings"><strong>先完成人物、宠物三视图</strong><span>请查看图片，分别点击“使用这张”确认外观、服装和三个视角，再复制续写卡到原智能体对话。已确认 {directorConfirmedSlots?.size || 0} 项。</span></div>
            <div className="sbw-toolbar-actions">{directorLegacySlots.length > 0 && <button type="button" onClick={() => void restoreDirectorOriginalAssets()} disabled={visualAssetGenerating || visualAssetSaving || projectContext !== "ready"}>恢复原生成图</button>}<button type="button" className="is-primary" onClick={() => void copyDirectorResume()} disabled={visualAssetGenerating || visualAssetSaving || projectContext !== "ready"}><ClipboardCopy />复制续写卡</button></div>
          </section>}
          <section className="sbw-project-heading" aria-label="当前项目">
            <h2 className="sbw-task-step-heading">{referenceDisplayMode === "reference" ? "第二步 · 分段分镜" : "分段分镜"}</h2>
            {referenceDisplayMode === "reference" && <span className="sbw-segment-purpose">每张卡制作一段图片和视频；“添加分镜”增加分段，参考图按需选择。</span>}
            <input aria-label="项目名称" value={run.title} onChange={event => patchRun({ title: event.target.value.slice(0, 120) })} />
            <small role="status">{storyboardProjectSnapshotMatches(run, confirmedProjectSnapshot) ? "项目已保存" : cloud.message && cloud.message !== "任务已保存" && cloud.message !== "已读取任务" ? cloud.message : "有未保存更改"}</small>
            {recoveryConflictDraft && <button type="button" className="sbw-clear-empty-cards" onClick={() => downloadRecoveryDraft()}>下载本地未保存稿</button>}
            {recoveryExtraDraft && <button type="button" className="sbw-clear-empty-cards" onClick={() => downloadRecoveryDraft(recoveryExtraDraft)}>下载另一份本地稿</button>}
            {savedRecoveryDrafts.length > 2 && <select aria-label="下载其他本地未保存稿" value="" onChange={event => { const draft = savedRecoveryDrafts.find(item => item.key === event.target.value); if (draft) downloadRecoveryDraft(draft.run); }}><option value="">下载其他本地稿（{savedRecoveryDrafts.length}）</option>{savedRecoveryDrafts.map((draft, index) => <option key={draft.key} value={draft.key}>{index + 1}. {draft.run.title || "未命名项目"}</option>)}</select>}
            {run.visualAssetPlan?.mode === "selected" && run.visualAssetPlan.assets.length > 0 && <span className="sbw-reference-count" aria-label="本项目参考">计划 {run.visualAssetPlan.assets.length} 项 · 已选来源 {run.visualAssetPlan.assets.filter(asset => Boolean(asset.source?.assetId)).length} 项 · 已绑定 {assetBindingSummaries.filter(summary => summary.requestedIds.length > 0 && summary.complete).length}/{run.cards.length} 个分段</span>}
            <button type="button" className="sbw-clear-empty-cards" onClick={() => startFreshWorkspace(true)} title="清空当前文案、提示词、参考和生成结果，重新开始；历史作品保留"><Trash2 />一键清理</button>
          </section>


          {run.visualAssetPlan?.mode === "selected" && run.visualAssetPlan.assets.length > 0 && <StoryboardAssetSelection plan={run.visualAssetPlan} assetIds={run.visualAssetPlan.defaultAssetIds ?? run.visualAssetPlan.assets.filter(asset => asset.role === "character" || asset.role === "pet").map(asset => asset.id)} disabled={visualAssetSaving || Boolean(batchMode)} onChange={ids => void updateVisualAssetSelection(ids)} />}

          <section className="sbw-shot-grid" aria-label="分段任务卡片">
            {run.directorIntake?.phase !== "assets" && run.cards.map((card, cardIndex) => {
              const confirmingVideoSubmission = isActiveVideoStatus(card.videoStatus) && (videoNeedsRequestReconciliation(card)
                || videoConfirmationTasks.get(storyboardVideoConfirmationKey(userId, run.id, card, card.videoTaskId || "")) === true);
              const cardMediaBusy = imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus)
                || Boolean(batchMode) || visualAssetSaving || exportingBoardIds.has(card.id) || preparingVideoIds.has(card.id);
              const showVideoMedia = isActiveVideoStatus(card.videoStatus) || (Boolean(card.videoUrl)
                && (!card.imageUrl || (!imageAttemptNeedsResolution(card) && cardMediaViews[run.id + ":" + card.id] !== "image")));
              const imageViewOnly = Boolean(card.imageUrl && card.videoUrl && showVideoMedia);
              const videoViewOnly = Boolean(card.imageUrl && card.videoUrl && !showVideoMedia);
              const bindingSummary = assetBindingSummaries[cardIndex];
              const resolvedPreviousReferenceError = bindingSummary?.complete && !card.imageClientRequestId && !card.imageRequestSnapshot
                && /^参考尚未落实或已失效：/u.test(card.imageError || "");
              const cardVideoInputs = activeVideoModel ? resolveStoryboardAutomaticVideoInputs(activeVideoModel, card) : null;
              const videoStartIssue = publicModelSelectionNotice(activeVideoSelectionIssue, "视频模型")
                || storyboardCardVideoInputIssue(activeVideoModel, card, run)
                || (cardVideoInputs?.usesStoryboardImage && needsStoryboardBoardExport(card) ? "生成前将保存并确认当前分镜原图；保存失败不会提交视频。" : "");
              const showVideoStartIssue = Boolean(videoStartIssue);
              const showInlineVideoStartIssue = compactEditor && videoStartIssue === "请先生成并加载本段分镜图。"
                && !videoViewOnly && !isActiveVideoStatus(card.videoStatus) && !videoNeedsRequestReconciliation(card);
              return (
              <article
                key={card.id}
                id={"sbw-card-" + card.id}
                data-sbw-card-id={card.id}
                className="sbw-shot-card"
                data-testid={generalScriptImportedRunId === run.id && card.order === 1 ? "general-script-imported-card" : undefined}
                data-card-state={cardStatus(card).status}
                data-narration-chars={narrationCharacterCount(card.narration || inferStoryboardNarration(card.label))}
              >
                <header className="sbw-card-header">

                <div className="sbw-card-title"><strong>分段 {card.order}{card.sourceNumber && card.sourceNumber !== card.order ? ` · 原文段 ${card.sourceNumber}` : ""}</strong><span>{card.videoTaskDuration && (card.videoTaskId || card.videoClientRequestId || card.videoUrl) ? `${card.videoTaskDuration} 秒` : activeVideoModel?.generationReady === false ? "" : `${activeVideoDuration} 秒`}</span></div>
                  {cardStatus(card).status !== "idle" && <div className="sbw-status-pair"><span data-status={cardStatus(card).status}>{confirmingVideoSubmission ? "正在确认结果" : cardStatus(card).label}</span></div>}
                  <button type="button" className="sbw-icon-button sbw-delete-card" aria-label={`删除分段 ${card.order}`} title={imageAttemptNeedsResolution(card) ? "请先完成原生图任务的状态处理" : `删除分段 ${card.order}`} disabled={run.cards.length === 1 || imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus)} onClick={() => removeCard(card.id)}><X /></button>
                </header>

                {(card.sceneId || card.sceneZone || card.camera) && <div className="sbw-scene-context" aria-label={`分段${card.order}场景引用`}>
                  <span>场景</span><strong>{card.sceneId || "未指定"}</strong>
                  {card.sceneZone && <><span>区域</span><strong>{card.sceneZone}</strong></>}
                  {card.camera && <><span>机位</span><strong>{card.camera}</strong></>}
                  {card.capabilityGaps?.length ? <em title={card.capabilityGaps.join("；")}>待补覆盖</em> : null}
                </div>}
                {run.visualAssetPlan?.mode === "selected" && run.visualAssetPlan.assets.length > 0 && <StoryboardAssetSelection plan={run.visualAssetPlan} assetIds={card.visualAssetSelectionMode === "project" ? (run.visualAssetPlan.defaultAssetIds ?? run.visualAssetPlan.assets.filter(asset => asset.role === "character" || asset.role === "pet").map(asset => asset.id)) : (card.visualAssetRefs || []).map(ref => ref.assetId)} mode={card.visualAssetSelectionMode} segmentNumber={card.order} referenceCount={bindingSummary?.complete ? card.referenceImageUrls.length : bindingSummary?.boundIds.length || 0} disabled={visualAssetSaving || imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus) || Boolean(batchMode)} onChange={(ids, mode) => void updateVisualAssetSelection(ids, card.id, mode)} />}
                <div className="sbw-generation-stack">
                  <section className="sbw-flow-section sbw-image-flow">
                    <div className="sbw-stage-label sbw-prompt-stage-label">
                      <span className="sbw-stage-index">01</span>
                      <strong>生图提示词</strong>
                      <em>{card.imageStatus === "done" ? "已完成" : statusText(card.imageStatus)}</em>
                      <button type="button" className="sbw-prompt-paste" title="粘贴生图提示词" aria-label={`粘贴分段${card.order}生图提示词`} disabled={imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus) || Boolean(batchMode) || preparingVideoIds.has(card.id)} onClick={() => void pastePrompt(card.id, "imagePrompt", `分段${card.order}生图提示词`)}><ClipboardPaste /></button>
                    </div>
                    <div className="sbw-flow-prompt">
                      <textarea aria-label={`分段${card.order}生图提示词`} rows={6} disabled={imageAttemptNeedsResolution(card)} value={card.imagePrompt} onChange={(event) => patchCard(card.id, { imagePrompt: event.target.value })} placeholder="写下这一段的画面…" />
                    </div>

                    <div className="sbw-zone-title"><span className="sbw-stage-index">03</span><strong className="sbw-zone-title-main">{showVideoMedia ? <Film size={15} /> : <ImageIcon size={15} />}{showVideoMedia ? "媒体结果" : "分镜图"}</strong><span title={!showVideoMedia && hasValidatedImage(card) ? `已验证 ${card.imageWidth && card.imageHeight ? `${card.imageWidth}×${card.imageHeight}` : ""} ${needsStoryboardBoardExport(card) ? "· 保存后用于视频" : "并自动绑定"}${card.imageModelNameUsed ? ` · ${card.imageModelNameUsed}` : ""}` : undefined}>{showVideoMedia ? (card.videoStatus === "done" ? `已完成 · ${submittedVideoTaskLabel(card)}` : submittedVideoTaskLabel(card)) : storyboardImageRatioIssue(card, activeImageRatio, run.ratio, activeVideoModel) || (hasValidatedImage(card) ? `${needsStoryboardBoardExport(card) ? "需保存原图" : "已绑定"}${card.imageWidth && card.imageHeight ? ` · ${card.imageWidth}×${card.imageHeight}` : ""}` : isImageValidationPending(card) ? "正在加载/验证" : "")}</span>{showInlineVideoStartIssue && <span className="sbw-inline-video-prerequisite" role="status" title={videoStartIssue} aria-label={videoStartIssue}>待生成分镜图</span>}</div>
                    <div
                      className={`sbw-shared-media-frame sbw-ratio-frame ${showVideoMedia ? "is-video" : card.imageUrl ? "has-result" : "is-placeholder"} ${(showVideoMedia ? run.ratio : card.imageRequestSnapshot?.aspectRatio || activeImageRatio) === "9:16" ? "is-portrait" : ""}`}
                      style={{ aspectRatio: (showVideoMedia ? run.ratio : card.imageRequestSnapshot?.aspectRatio || activeImageRatio).replace(":", " / ") }}
                      data-media-mode={showVideoMedia ? "video" : "image"}
                    >
                      {showVideoMedia ? (
                        card.videoUrl ? (
                          <TicketedVideo url={card.videoUrl} taskId={card.videoTaskId} token={token} poster={card.imageUrl} onExpand={(url, currentTime) => setPreviewMedia({ url, type: "video", poster: card.imageUrl, taskId: card.videoTaskId, token, currentTime })} />
                        ) : isActiveVideoStatus(card.videoStatus) ? (
                          <div className="sbw-loading-state sbw-realtime-state">
                            <Loader2 className="animate-spin" />
                            <strong>{confirmingVideoSubmission ? "正在确认结果" : card.videoLifecycle?.headline || statusText(card.videoStatus)}</strong>
                            <small>{submittedVideoTaskLabel(card)}</small>
                            {!confirmingVideoSubmission && <>
                            <span className="sbw-stage-detail">{card.videoLifecycle?.detail || card.videoStatusDetail || "正在等待上游首次状态回报"}</span>
                            <div
                              className="sbw-render-progress"
                              data-indeterminate={typeof card.videoProgress === "number" ? undefined : "true"}
                              role="progressbar"
                              aria-label={`${submittedVideoTaskLabel(card)}渲染进度`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={typeof card.videoProgress === "number" ? Math.round(card.videoProgress) : undefined}
                            >
                              <span style={typeof card.videoProgress === "number" ? { width: `${Math.max(3, Math.min(100, card.videoProgress))}%` } : undefined} />
                            </div>
                            <small className="sbw-render-progress-label">
                              {typeof card.videoProgress === "number" ? `渲染进度 ${Math.round(card.videoProgress)}%` : "正在渲染 · 进度待上游回报"}
                            </small>
                            <ol className="sbw-video-stage-steps" aria-label={`${submittedVideoTaskLabel(card)}处理阶段`}>
                              {VIDEO_DELIVERY_STAGES.map((label, index) => {
                                const activeStage = cardVideoStageIndex(card);
                                return <li key={label} className={index < activeStage ? "is-done" : index === activeStage ? "is-current" : ""} aria-current={index === activeStage ? "step" : undefined}><span>{index + 1}</span><small>{label}</small></li>;
                              })}
                            </ol>
                            <small>{formatElapsed(card.videoStartedAt, clockNow)} · {formatLastChecked(card.videoLastCheckedAt, clockNow)}</small>
                            </>}
                          </div>
                        ) : (
                          <div className="sbw-empty-state"><Film /><span>视频结果待确认</span></div>
                        )
                      ) : card.imageUrl ? (
                        <button type="button" onClick={() => setPreviewMedia({ url: card.imageUrl || "", type: "image" })} title="查看原图" aria-label={`放大分段 ${card.order} 分镜图`}><img src={card.imageUrl} alt={`任务${card.order}故事板`} /><span><Eye />查看原图</span></button>
                      ) : card.imageStatus === "running" || card.imageStatus === "queued" ? (
                        <div className="sbw-loading-state"><Loader2 className="animate-spin" /><strong>{statusText(card.imageStatus)}</strong><span>故事板图片正在生成</span></div>
                      ) : (
                        <div className="sbw-empty-state"><ImageIcon /><span>{storyboardImageUnavailablePresentation(card)?.label || (isUnavailableCompletedInlineImage(card) ? "已完成·临时图片不可恢复" : "尚未生成")}</span></div>
                      )}
                    </div>
                    {card.imageReferenceState === "stale" && <p className="sbw-error-line" role="status">参考已更新；当前分镜与视频是旧结果，已保留。请明确重新生成分镜后再制作视频。</p>}
                    {isImageValidationPending(card) && <p className="sbw-billing-line" role="status">正在加载/验证分镜图，完成后会自动解锁视频生成；期间不会提交视频请求。</p>}
                    {card.imageError && <p className="sbw-error-line">{resolvedPreviousReferenceError ? `上次参考检查未通过；当前引用已落实，可以重新提交。原提示：${card.imageError}` : card.imageError}</p>}
                    {card.imageDeliveryExpectedPixelSize && <p className="sbw-billing-line">{card.imageOutputPolicyVersion === "image_output_policy.v2" ? "本次交付目标：至少 " : "原请求参考尺寸："}{card.imageDeliveryExpectedPixelSize.replace("x", "×")} 像素{card.imageWidth && card.imageHeight ? ` · 实际 ${card.imageWidth}×${card.imageHeight}` : ""}</p>}
                    {isUnavailableCompletedStoryboardImage(card) && (
                      <button type="button" className="sbw-abandon-attempt" disabled={Boolean(batchMode) || visualAssetSaving || run.cards.length >= MAX_CARDS} onClick={() => copyCompletedImageToNewCard(card.id)} title="保留原分镜和费用收据，复制提示词到新分镜；确认新报价后才能生成和收费">新建分镜重新生成</button>
                    )}
                    {card.imageRetryBlocked && !isUnavailableCompletedStoryboardImage(card) && (
                      <button type="button" className="sbw-abandon-attempt" onClick={() => abandonImageAttempt(card.id)} title="放弃本次待确认结果并重新生成；原请求仍保留在费用核对中">放弃本次结果并重新生成</button>
                    )}
                    {card.imageBillingState && <p className="sbw-billing-line">图片费用：{card.imageBillingState === "pending"
                      ? `原报价 ¥${Number(card.imageQuotedPrice || 0).toFixed(2)}，原请求费用正在核对`
                      : card.imageBillingState === "restored"
                        ? `实际扣费 ¥${Number(card.imagePriceCharged || 0).toFixed(2)}`
                        : card.imageBillingState === "not_charged"
                          ? "本次未扣费"
                          : `实际扣费 ¥${Number(card.imagePriceCharged || 0).toFixed(2)}`}</p>}
                    <div className="sbw-media-actions">
                      <button type="button" title="复制生图 Prompt" onClick={() => copyText(card.imagePrompt, `分段${card.order}生图 Prompt`)}><ClipboardCopy /></button>
                      {card.imageUrl && <button type="button" title="下载故事板" onClick={() => void downloadStoryboardImage(card)}><Download /></button>}
                      {card.videoUrl && <button type="button" title="复制视频 Prompt" onClick={() => copyText(card.videoPrompt, `分段${card.order}视频 Prompt`)}><ClipboardCopy /></button>}
                      {card.videoUrl && <button type="button" title="下载视频" onClick={() => void openVideoDownload(card.videoTaskId, `分段${card.order}.mp4`, token).catch(error => setNotice(error instanceof Error ? error.message : "视频下载暂不可用，请稍后重试"))}><Download /></button>}
                      {needsStoryboardBoardExport(card) && <button type="button" className="sbw-board-export" disabled={exportingBoardIds.has(card.id) || !hasValidatedImage(card) || isActiveVideoStatus(card.videoStatus)} onClick={() => void saveBoardForVideo(card.id)}>{exportingBoardIds.has(card.id) ? "正在保存…" : "保存并用于视频"}</button>}
                      <button
                        type="button"
                        className="is-command is-image-command"
                        title={isUnavailableCompletedStoryboardImage(card) ? storyboardImageUnavailablePresentation(card)?.message : imageViewOnly ? "查看已有图片，不会生成或扣费" : isActiveVideoStatus(card.videoStatus)
                          ? "请先终止本分段的视频任务"
                          : isUnavailableCompletedInlineImage(card)
                            ? "图片已完成，临时图片不可恢复，已禁止重复提交"
                          : card.imageRetryBlocked
                            ? "原结果待确认，已禁止重复提交"
                            : card.imageRecoveryReady
                              ? "图片已生成，系统正在自动保存和展示"
                              : activeImageSelectionIssue
                                ? publicModelSelectionNotice(activeImageSelectionIssue, "生图模型")
                              : batchMode && card.imageStatus !== "done"
                                ? "当前卡片正在批量流程中"
                                : card.imageStatus === "done" ? "使用当前所选生图模型重新生成" : "生成故事板图片"}
                        disabled={isUnavailableCompletedStoryboardImage(card) ? cardMediaBusy || card.imageMediaState === "expired" || !card.imageRef : imageViewOnly ? cardMediaBusy : card.imageRetryBlocked
                          || card.imageRecoveryReady
                          || (!card.imageRecoveryReady && (Boolean(activeImageSelectionIssue) || !card.imagePrompt.trim()))
                          || card.imageStatus === "running"
                          || card.imageStatus === "queued"
                          || Boolean(batchMode && card.imageStatus !== "done")}
                        onClick={() => { if (isUnavailableCompletedStoryboardImage(card)) { setNotice(`正在重新读取分段${card.order}已生成的分镜图，请稍候`); retryCompletedImageRead(card); return; } if (!switchExistingCardMedia(card, "image", showVideoMedia ? "video" : "image")) void generateImage(card.id); }}
                      >
                        {card.imageStatus === "running" || card.imageStatus === "queued" ? <Loader2 className="animate-spin" /> : card.imageStatus === "done" || card.imageStatus === "failed" ? <RotateCcw /> : <Sparkles />}
                        {isUnavailableCompletedStoryboardImage(card) ? storyboardImageUnavailablePresentation(card)?.actionLabel : imageViewOnly ? "查看图片" : card.imageStatus === "running" || card.imageStatus === "queued"
                          ? statusText(card.imageStatus)
                          : isUnavailableCompletedInlineImage(card)
                            ? "图片不可恢复"
                          : card.imageRetryBlocked
                            ? "结果待确认"
                            : card.imageRecoveryReady
                              ? "正在保存结果"
                              : card.imageStatus === "done" ? "重新生成图片" : card.imageStatus === "failed" ? "重试生图" : "生成图片"}
                      </button>
                      <button
                        type="button"
                        className={`is-command is-video-command ${isActiveVideoStatus(card.videoStatus) && canRequestVideoTermination(card) ? "is-stop-command" : ""}`}
                         title={videoViewOnly ? "查看已有视频，不会生成或扣费" : videoNeedsRequestReconciliation(card) ? "查询原请求号；只恢复既有任务状态，不会自动重复提交" : isActiveVideoStatus(card.videoStatus) ? `${submittedVideoTaskLabel(card)} · ${canRequestVideoTermination(card) ? "管理视频任务" : "缺少可核验请求编号"}` : card.videoStatus === "failed" && card.videoRetryable !== true ? "原任务或费用尚未确认，请先刷新历史状态" : videoStartIssue || (batchMode && card.videoStatus !== "done" ? "当前卡片正在批量流程中" : card.videoStatus === "done" ? "使用当前所选视频模型重新生成" : "生成视频")}
                         disabled={preparingVideoIds.has(card.id) || (videoViewOnly ? cardMediaBusy : isActiveVideoStatus(card.videoStatus) ? (videoNeedsRequestReconciliation(card) ? false : !canRequestVideoTermination(card)) : (Boolean(activeVideoSelectionIssue) || Boolean(storyboardCardVideoInputIssue(activeVideoModel, card, run)) || exportingBoardIds.has(card.id) || Boolean(batchMode && card.videoStatus !== "done")))}
                        onClick={() => { if (switchExistingCardMedia(card, "video", showVideoMedia ? "video" : "image")) return; void (videoNeedsRequestReconciliation(card) ? reconcileVideoRequest(card.id, "manual") : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? resumeVideoMonitoring(card.id) : isActiveVideoStatus(card.videoStatus) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? pauseVideoMonitoring(card.id) : cancelVideo(card.id)) : prepareAndGenerateVideo(card.id)); }}
                      >
                        {videoNeedsRequestReconciliation(card) || isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? <RefreshCw /> : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? <Square /> : <Loader2 className="animate-spin" />) : card.videoStatus === "done" || card.videoStatus === "failed" || card.videoStatus === "cancelled" ? <RotateCcw /> : <Film />}
                        {preparingVideoIds.has(card.id) ? "正在准备视频…" : videoViewOnly ? "查看视频" : videoNeedsRequestReconciliation(card) ? "刷新视频" : isActiveVideoStatus(card.videoStatus) && card.videoMonitoringPaused === true ? "继续查询" : isActiveVideoStatus(card.videoStatus) ? (canRequestVideoTermination(card) ? (card.videoTaskId && !canRemotelyCancelVideoTask(card) ? "停止等待" : "终止生成") : confirmingVideoSubmission ? "确认中" : "生成中") : cardVideoInputs?.usesStoryboardImage && needsStoryboardBoardExport(card) ? "保存分镜并生成视频" : card.videoStatus === "done" || card.videoStatus === "cancelled" ? "重新生成视频" : card.videoStatus === "failed" ? card.videoRetryable === true ? "重试视频" : "状态待确认" : "生成视频"}
                      </button>
                    </div>
                  </section>

                  <section id={`sbw-video-flow-${card.id}`} ref={(element) => { videoSectionsRef.current[card.id] = element; }} className={`sbw-flow-section sbw-video-flow ${storyboardCardVideoInputIssue(activeVideoModel, card, run) ? "is-locked" : ""} ${card.videoUrl ? "has-result" : ""} is-expanded`}>
                    <div className="sbw-stage-label sbw-prompt-stage-label">
                      <span className="sbw-stage-index">02</span>
                      <strong>视频提示词</strong>
                      <em>{storyboardCardVideoInputIssue(activeVideoModel, card, run) ? cardVideoInputs?.usesStoryboardImage && isImageValidationPending(card) ? "正在验证" : "待补素材" : "可生成"}</em>
                      <button type="button" className="sbw-prompt-paste" title="粘贴视频提示词" aria-label={`粘贴分段${card.order}视频提示词`} disabled={imageAttemptNeedsResolution(card) || isActiveVideoStatus(card.videoStatus) || Boolean(batchMode) || preparingVideoIds.has(card.id)} onClick={() => void pastePrompt(card.id, "videoPrompt", `分段${card.order}视频提示词`)}><ClipboardPaste /></button>
                    </div>
                    <div className="sbw-flow-prompt">
                      <textarea aria-label={`分段${card.order}视频提示词`} rows={6} disabled={card.videoStatus === "running" || card.videoStatus === "queued"} value={card.videoPrompt} onChange={(event) => patchCard(card.id, { videoPrompt: event.target.value })} placeholder="描述动作、镜头运动和节奏…" />
                    </div>
                    {activeVideoModel?.firstFrameRatioPolicy === "adaptive" && cardVideoInputs?.input.imageUrl && <p className="sbw-note">视频比例：跟随首帧比例</p>}
                    {cardVideoInputs && <div className="sbw-video-reference-summary"><Film aria-hidden="true" /><span>{cardVideoInputs.requiresStoryboardImage ? "使用当前分镜图" : "仅使用当前视频提示词"}</span></div>}
                    {showVideoStartIssue && !showInlineVideoStartIssue && !videoViewOnly && !isActiveVideoStatus(card.videoStatus) && !videoNeedsRequestReconciliation(card) && <p className="sbw-note" role="status">{videoStartIssue}</p>}
                    {card.videoError && <p className="sbw-error-line">{card.videoError}</p>}
                    {card.videoBillingState && <p className="sbw-billing-line">视频费用：{isActiveVideoStatus(card.videoStatus)
                      ? "任务处理中，成功交付后扣费"
                      : card.videoStatus === "done"
                        ? `实际扣费 ¥${Number(card.videoPriceCharged || 0).toFixed(2)}`
                        : card.videoPriceCharged === 0 ? "未扣费" : "费用待确认"}</p>}
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
            )})}
          </section>

        </div>
      </main></fieldset>
      </StoryboardEditorViewport>
      </div>

      {!historyPage && (notice || batchMode) && <div className="sbw-notice" role="status">{batchMode && <Loader2 className="animate-spin" />}{notice}</div>}

      {historyNavigationIssue && <div className="sbw-notice" role="alert">
        <span>页面切换较慢，当前工作内容仍保留。</span>
        <button type="button" onClick={() => setHistoryOpen(historyNavigationIssue.open)}>重试切换</button>
      </div>}
      {historyOpen && <MediaHistoryWorkspace
        initialCategory="storyboard-workbench"
        onBack={() => setHistoryOpen(false)}
        recoveryContent={<>
            {videoHistoryLoading && <p role="status">正在同步分镜任务状态…</p>}
            {videoHistoryError && <p role="alert">{videoHistoryError}。<button type="button" onClick={() => void loadVideoHistory()}>重试同步</button></p>}
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
            <section className="sbw-history-list" aria-label="未完成项目恢复">
              <div className="flex items-center justify-between gap-2"><strong>未完成项目</strong><button type="button" disabled={cloud.loading} onClick={() => void cloud.refresh()}>{cloud.loading ? "读取中…" : "刷新"}</button></div>
              {cloud.message && <p role="status">{cloud.message}</p>}
              {cloud.projects.filter((project) => !project.cards?.length || project.cards.some((card) => card.videoStatus !== "done" || card.imageStatus !== "done")).map((project) => (
                <article key={`cloud-${project.id}`} data-storyboard-project-id={project.id} className="sbw-history-project">
                  <div><strong>{project.title}</strong><span>{new Date(project.updatedAt).toLocaleString("zh-CN")}</span></div>
                  <p>{project.cardCount} 个段落</p>
                  <div className="sbw-history-actions"><button type="button" disabled={handoffImportBlocked} onClick={async () => {
                    if (!window.confirm("打开任务会替换当前工作台内容。确认继续？")) return;
                    if (visualAssetGenerationRef.current || visualAssetMutationRef.current || navigationRef.current) { setNotice("请等待当前资产操作完成后再打开其他项目。"); return; }
                    await leaveAssetProject('/storyboard-workbench?projectId=' + encodeURIComponent(project.id));
                  }}>打开任务</button></div>
                </article>
              ))}
              {cloud.nextOffset !== null && <button type="button" disabled={cloud.loading} onClick={() => void cloud.refresh(cloud.nextOffset!)}>加载更多任务</button>}
              {history.filter((record) => !cloud.projects.some((project) => project.id === record.id) && record.cards.some((card) => card.videoStatus !== "done" || card.imageStatus !== "done" || card.imageRetryBlocked || card.imageRecoveryReady || card.videoMonitoringPaused)).map((record) => (
                <article key={record.id}>
                  <div><strong>{record.title}</strong><span>{new Date(record.updatedAt).toLocaleString("zh-CN")}</span></div>
                  <p>此浏览器待确认 · {record.cards.length} 个段落</p>
                  <div className="sbw-history-actions"><button type="button" disabled={handoffImportBlocked} onClick={() => { submittedRunIdsRef.current.add(record.id); explicitHistorySelectionRef.current = true; runRef.current = record; setRun(record); setHistoryOpen(false); setNotice(`已打开：${record.title}`); }}>打开任务</button></div>
                </article>
              ))}
            </section>
        </>}
      />}

      {previewMedia && <MediaLightbox media={previewMedia} onClose={() => setPreviewMedia(null)} />}
    </div>
  );
}
