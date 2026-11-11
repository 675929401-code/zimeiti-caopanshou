import { humanDurationCapabilities } from '@/features/digital-human/duration-policy';
import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
  getVideoBillingUnit,
} from "@/lib/video-model-capabilities";
import { getVideoTokenPublicPricing } from "@/lib/video-token-billing";
import { getVideoInputContract } from "@/lib/video-input-contract";
import { isRegisteredVideoProtocol } from "@/lib/video-adapter";
import { gaoruiVideoCreateContractAdmission } from "@/lib/gaorui-video-contract-admission";
import { isDigitalHumanWorkspaceModel } from "@/lib/video-model-surface";
import { readGaoruiPersonAssetAdmission } from "@/lib/gaorui-person-asset-admission";
import { supportsConfirmedVideoCancellation } from "@/lib/video-cancellation";
import { publicMediaBillingCapabilities, toPublicModelDto } from "@/lib/public-model-dto";
import { publicVideoModelCompatibilityMessage, publicVideoModelInputCompatibilityCode } from "@/lib/video-model-public-status";
import { isVisibleInPublicWorkspace } from "@/lib/video-workspace-catalog";
import { RETIRED_MODEL_PROVIDER } from "@/lib/model-retirement";
import { AUTODL_H3_SELFHOST_PROTOCOL } from "@/lib/autodl-h3-selfhost";
import { requireVideoPriceSnapshot } from "@/lib/video-terminal-finalizer";
import {
  videoBillingAdapterAdmission,
  videoModelAvailabilityMessage,
  videoOperatorSubmissionAdmission,
} from "@/lib/video-model-availability";
import {
  VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY,
  normalizeVideoModelOrderSurface,
  parseVideoModelSurfaceOrders,
  videoModelSurfaceSortOrder,
} from "@/lib/video-model-surface-order";
import {
  evaluateWorkspaceModelCompatibility,
  videoWorkspaceSurfaceFromRequest,
} from "@/lib/workspace-model-policy";
import {
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
  isWorkspaceModelAssigned,
  parseWorkspaceModelAssignmentOverrides,
} from "@/lib/workspace-model-assignment-settings";

// Model availability is managed live from the admin backend. Never cache this
// endpoint, otherwise newly enabled providers remain invisible until restart.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface RankedVideoModel {
  row: Record<string, unknown>;
  durationCapabilities: ReturnType<typeof getVideoDurationCapabilities>;
  resolutionTier: string;
  resolutionOptions: string[];
  defaultResolution: string;
  resolutionPrices: string[];
  resolutionLabels: string[];
  directVerifiedCombinations: string[];
  verificationNotice: string;
  aspectRatios: string[];
  supportsSourceVideoInput: boolean;
  requiresSourceVideo: boolean;
  maxReferenceImages: number;
  minReferenceImages: number;
  maxReferenceAudios: number;
  minReferenceAudios: number;
  supportsAudioInput: boolean;
  supportsImageInput: boolean;
  requiresImage: boolean;
  workflowInputMode: string;
  referenceAspectRatioPolicy: "same" | "independent";
  supportsPrompt: boolean;
  requiresFirstFrame: boolean;
  requiresLastFrame: boolean;
  showFirstFrame: boolean;
  showLastFrame: boolean;
  showReferenceImages: boolean;
  showAudioInputs: boolean;
  billingUnit: "per_use" | "output_second" | "token";
  tokenPricing: ReturnType<typeof getVideoTokenPublicPricing>;
  workspaceSurfaces: string[];
  supportsRemoteCancel: boolean;
  supportsGenerateAudioToggle: boolean;
  durationStep: number;
  successRate: number;
  totalRequests: number;
  lastSuccessAt: string | null;
  sortOrder: number;
  surfaceSortOrder: number | null;
  channelKey: string;
  channelOrder: number;
  available: boolean;
  priceReady: boolean;
  generationReady: boolean;
  readinessMessage: string;
  availabilityMessage: string;
  surfaceCompatible: boolean;
  compatibilityCode: string;
  capabilitiesVerified: boolean;
}

const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"]);

function hasLocallyValidVideoEndpoint(value: unknown): boolean {
  try {
    const endpoint = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) return false;
    return ![...endpoint.searchParams.keys()].some(key =>
      /^(?:xapikey|apikey|key|token|accesstoken|authtoken|refreshtoken|idtoken|secret|clientsecret|auth|authorization|credentials?|password|signature|sig)$/iu.test(key.replace(/[-_.]/gu, "")),
    );
  } catch {
    return false;
  }
}

function workspaceSurfaceList(row: Record<string, unknown>, config: Record<string, unknown>): string[] {
  const configured = Array.isArray(config.workspace_surfaces)
    ? config.workspace_surfaces.map(String).map((value) => {
      const normalized = value.trim().toLowerCase();
      return normalized === "storyboard-workbench" ? "storyboard" : normalized === "video-page" ? "ai-video" : normalized;
    }).filter(Boolean)
    : [];
  // Legacy self-host H3 rows predate the storyboard surface flag. Normalize
  // them here until the stored admin record is updated as well.
  if (row.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL) configured.push("ai-video", "storyboard");
  return [...new Set(configured)];
}

function modelIdentity(row: Record<string, unknown>): string {
  const config = (row.api_protocol_config as Record<string, unknown>) || {};
  return [row.protocol_type, row.name, config.display_name, config.provider, config.model]
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase();
}

function protocolResolutionAllowlist(row: Record<string, unknown>): Set<string> | null {
  const protocol = String(row.protocol_type || "").trim();
  const modelName = String(row.model_name || "").trim().toLowerCase();
  if (protocol === "secure_skill_doubao_seedance") return new Set(["720p"]);
  if (protocol === "secure_skill_enterprise_video" && modelName === "seedance-2.5") return new Set(["720p"]);
  if (protocol === "secure_skill_seedance_video") return new Set(["480p", "720p"]);
  return null;
}

function videoChannelKey(row: Record<string, unknown>): string {
  const identity = modelIdentity(row);
  if (row.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL || /autodl/u.test(identity)) return "autodl";
  if (/seedance|豆包|即梦/u.test(identity)) return "seedance";
  if (/grok|xai/u.test(identity)) return "grok";
  if (/veo|gemini|google/u.test(identity)) return "google";
  if (/omni/u.test(identity)) return "omni";
  if (/minimax|h3/u.test(identity)) return "minimax";
  if (isDigitalHumanWorkspaceModel(row)) return "digital-human";
  return String(row.protocol_type || "standard").trim().toLowerCase() || "standard";
}

function modelMatchesSurface(row: Record<string, unknown>, requestedSurface: string): boolean {
  if (row.provider === RETIRED_MODEL_PROVIDER) return false;
  // AutoDL 托管工作流（autodl.art）已废弃：既不在目录展示，也不进入任何工作区。
  const protocol = String(row.protocol_type || "");
  if (protocol === AUTODL_H3_SELFHOST_PROTOCOL || protocol === "autodl_comfyui_workflow") return false;
  if (!requestedSurface) return true;
  const isDigitalHuman = isDigitalHumanWorkspaceModel(row);
  if (requestedSurface === "digital-human") return isDigitalHuman;
  // Workspace assignment and the capability policy are evaluated separately
  // below. A mismatch never changes the resource-pool record.
  return true;
}

function videoOutputCapabilities(row: Record<string, unknown>, config: Record<string, unknown>) {
  const resolutionCapabilities = getVideoResolutionCapabilities({ ...row, api_protocol_config: config });
  const protocolAllowlist = protocolResolutionAllowlist(row);
  const resolutionOptions = protocolAllowlist
    ? resolutionCapabilities.options.filter((value) => protocolAllowlist.has(value))
    : resolutionCapabilities.options;
  const defaultResolution = resolutionOptions.includes(resolutionCapabilities.defaultResolution)
    ? resolutionCapabilities.defaultResolution
    : resolutionOptions[0] || "";

  const configuredRatios = [config.aspect_ratios, config.supported_aspect_ratios]
    .find(Array.isArray) as unknown[] | undefined;
  const aspectRatios = (configuredRatios || ["16:9", "9:16"])
    .map((value) => String(value || "").trim())
    .filter((value) => VIDEO_ASPECT_RATIOS.has(value));

  return {
    resolutionOptions,
    defaultResolution,
    resolutionPrices: Object.entries(resolutionCapabilities.publicPrices)
      .filter(([resolution]) => resolutionOptions.includes(resolution))
      .map(([resolution, price]) => `${resolution}=${price}`),
    resolutionLabels: resolutionOptions
      .map((resolution) => `${resolution}=${resolutionCapabilities.labels[resolution] || resolution}`),
    directVerifiedCombinations: Array.isArray(config.direct_verified_combinations)
      ? config.direct_verified_combinations.map(String).filter((value) => /^(lite|480p|720p|768p|1080p|2K|4K)\|(\d+(?:\.\d+)?)\|(16:9|9:16|1:1|4:3|3:4|21:9)$/u.test(value))
      : [],
    verificationNotice: (
      String(config.verification_notice || "").trim()
      || (resolutionOptions.length === 0
        ? "输出清晰度由当前服务自动选择"
        : protocolAllowlist && resolutionOptions.length < resolutionCapabilities.options.length
          ? `界面已按当前协议收敛为 ${resolutionOptions.join("/")}`
        : "")
    ).slice(0, 240),
    aspectRatios: aspectRatios.length > 0 ? [...new Set(aspectRatios)] : ["16:9", "9:16"],
  };
}

/**
 * 视频模型列表（公共接口）
 * ⚠️ 过滤敏感字段：api_key、admin_notes 不返回给前端
 * 排序规则：权重(sort_order)优先，数字越小排越前；同权重再按成功率降序
 */
export async function GET(request: Request) {
  try {
    const requestedSurface = new URL(request.url).searchParams.get("surface") || "";
    const nativeCatalog = requestedSurface === "publish-center-video";
    const orderSurface = normalizeVideoModelOrderSurface(requestedSurface);
    const workspaceSurface = videoWorkspaceSurfaceFromRequest(requestedSurface);
    // Every public consumer can create tasks, including callers with no/unknown surface.
    // Surface selection narrows capabilities. Publication evidence and channel
    // history are administrator diagnostics and do not control catalog visibility.
    const supabase = getSupabaseClient();
    const [orderSettingResult, assignmentSettingResult] = await Promise.all([
      orderSurface
        ? supabase.from("platform_settings").select("setting_value")
          .eq("setting_key", VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      workspaceSurface
        ? supabase.from("platform_settings").select("setting_value")
          .eq("setting_key", WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (orderSettingResult.error) {
      console.warn("[VideoModels/Public] Surface order settings unavailable:", orderSettingResult.error.message);
    }
    if (assignmentSettingResult.error) {
      console.warn("[VideoModels/Public] Workspace assignment settings unavailable:", assignmentSettingResult.error.message);
    }
    const surfaceOrders = parseVideoModelSurfaceOrders(orderSettingResult.data?.setting_value);
    const assignmentOverrides = parseWorkspaceModelAssignmentOverrides(assignmentSettingResult.data?.setting_value);
    const { data, error } = await supabase
      .from("video_models")
      .select("id, name, model_name, icon_url, provider, protocol_type, api_endpoint, api_key, price_per_use, cost_price, duration_seconds, max_duration, supports_image_input, requires_image, is_active, is_hidden, sort_order, total_requests, success_count, last_success_at, api_protocol_config")
      .eq("is_hidden", false)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[VideoModels/Public] Supabase data source unavailable:", error);
      return NextResponse.json({ error: "视频模型列表暂不可用，请稍后刷新", code: "VIDEO_MODEL_CATALOG_UNAVAILABLE", models: [] }, { status: 503 });
    }

    const rows = ((Array.isArray(data) ? data : []) as Record<string, unknown>[])
      .filter((row) => nativeCatalog || modelMatchesSurface(row, requestedSurface))
      .filter((row) => nativeCatalog || !workspaceSurface || isWorkspaceModelAssigned(
        assignmentOverrides,
        "video",
        row,
        workspaceSurface,
      ));
    const rankedModels: RankedVideoModel[] = rows.map((m) => {
      const durationCapabilities = getVideoDurationCapabilities(m);
      const total = Number(m.total_requests) || 0;
      const success = Number(m.success_count) || 0;
      const successRate = total > 0 ? Math.round((success / total) * 100) : -1; // -1表示无数据
      const lastSuccessAt = m.last_success_at as string | null;
      
      // 从 api_protocol_config 提取前端需要的字段
      const protocolConfig = (m.api_protocol_config as Record<string, unknown>) || {};
      const outputCapabilities = videoOutputCapabilities(m, protocolConfig);
      // Keep the machine-submitted default empty when the provider owns the
      // output size, but make the catalog label explicit for users.
      const resolutionTier = outputCapabilities.defaultResolution || "自动选择";
      const plainNativeSeedance = m.protocol_type === "gaorui_video" && ["seedance-2.0", "seedance-2.5"].includes(String(m.model_name)) && gaoruiVideoCreateContractAdmission(m).ready;
      const inputContract = { ...getVideoInputContract(m), ...(plainNativeSeedance ? { showFirstFrame: true, showReferenceImages: false } : {}) };
      const { supportsSourceVideoInput, requiresSourceVideo, maxReferenceImages, minReferenceImages, maxReferenceAudios, minReferenceAudios, supportsPrompt, requiresFirstFrame, requiresLastFrame,
        showFirstFrame, showLastFrame, showReferenceImages, showAudioInputs } = inputContract;
      const supportsAudioInput = inputContract.showAudioInputs;
      const workflowInputMode = inputContract.mode;
      const referenceAspectRatioPolicy = protocolConfig.reference_aspect_ratio_policy === "independent"
        && workflowInputMode === "flexible_image" && !requiresFirstFrame && !requiresLastFrame ? "independent" : "same";
      const billingUnit = protocolConfig.provider_billing_unit === "token" ? "token" : getVideoBillingUnit(m);
      const tokenPricing = billingUnit === "token" || protocolConfig.provider_billing_unit === "token" ? getVideoTokenPublicPricing(m) : null;
      const workspaceSurfaces = workspaceSurfaceList(m, protocolConfig);
      const supportsRemoteCancel = supportsConfirmedVideoCancellation(m.protocol_type, protocolConfig);
      const supportsGenerateAudioToggle = protocolConfig.supports_generate_audio_toggle === true;
      const configuredDurationStep = Number(protocolConfig.duration_step);
      const durationStep = Number.isFinite(configuredDurationStep) && configuredDurationStep > 0
        ? configuredDurationStep
        : 0.5;
      const surfaceCompatibility = workspaceSurface
        ? evaluateWorkspaceModelCompatibility("video", m, workspaceSurface)
        : null;
      let priceSnapshotReady = true;
      try {
        if (billingUnit === "token" || protocolConfig.provider_billing_unit === "token") {
          priceSnapshotReady = tokenPricing !== null;
        } else requireVideoPriceSnapshot(m, resolutionTier, durationCapabilities.defaultDuration);
      } catch {
        priceSnapshotReady = false;
      }
      const billingAdmission = videoBillingAdapterAdmission(protocolConfig);
      const priceReady = priceSnapshotReady;
      // Publication evidence, canary receipts and channel history are
      // administrator diagnostics. They must never make a configured model
      // disappear from the public catalog or turn a transient APM/provider
      // observation into a permanent submission gate. The submit route still
      // validates the current protocol, credential, price and delivery
      // contract immediately before it calls the upstream provider.
      // Credential references are declarations here. Resolving them belongs to
      // submission; a catalog GET must never read secret files or invoke DPAPI.
      const configuredForSubmission = String(m.api_key || "").trim().length > 0
        && isRegisteredVideoProtocol(m.protocol_type)
        && hasLocallyValidVideoEndpoint(m.api_endpoint);
      const baseAvailable = m.is_active === true && configuredForSubmission && priceReady && billingAdmission.ready;
      const personAssetAdmission = readGaoruiPersonAssetAdmission(m, { surface: requestedSurface });
      const operatorAdmission = videoOperatorSubmissionAdmission(m.api_protocol_config, m);
      const capabilitiesVerified = protocolConfig.capability_contract_verified !== false;
      const compatibilityCode = surfaceCompatibility?.compatible === false ? publicVideoModelInputCompatibilityCode(surfaceCompatibility.issues) || "VIDEO_CONFIGURATION_PENDING"
        : !operatorAdmission.ready ? operatorAdmission.code
        : !billingAdmission.ready ? billingAdmission.code
        : !personAssetAdmission.ready ? "VIDEO_PERSON_REFERENCE_PENDING"
        : !priceReady ? "VIDEO_PRICE_UNCONFIGURED"
        : m.is_active !== true ? "VIDEO_MODEL_INACTIVE"
        : !configuredForSubmission ? "VIDEO_CONFIGURATION_PENDING" : "";
      const nativeWorkspaceAssigned = !nativeCatalog || isWorkspaceModelAssigned(assignmentOverrides, "video", m, "publish-center-video");
      const available = nativeWorkspaceAssigned && baseAvailable && surfaceCompatibility?.compatible !== false && personAssetAdmission.ready && operatorAdmission.ready;
      const availabilityMessage = nativeCatalog && !nativeWorkspaceAssigned ? "该模型尚未加入发布中心场景，目录保留展示" : publicVideoModelCompatibilityMessage(compatibilityCode) || (surfaceCompatibility?.compatible === false
        ? "当前页面不支持该模型所需的输入方式"
        : !operatorAdmission.ready
          ? operatorAdmission.message
        : !billingAdmission.ready
          ? billingAdmission.message
        : !personAssetAdmission.ready
          ? personAssetAdmission.message || "当前人物参考接入尚未完成配置"
        : videoModelAvailabilityMessage({
        available: baseAvailable,
        active: m.is_active === true,
        activationReady: true,
        priceReady,
        healthReadable: true,
        healthRecorded: true,
        circuitState: "closed",
        lastError: "",
        }));
      // A configured model is selectable. Real credential/protocol failures
      // are reported by the submit contract for this request; stale canary or
      // APM health rows do not down-list the model.
      const generationReady = available;

      return {
        row: m,
        durationCapabilities,
        resolutionTier,
        resolutionOptions: outputCapabilities.resolutionOptions,
        defaultResolution: outputCapabilities.defaultResolution,
        resolutionPrices: outputCapabilities.resolutionPrices,
        resolutionLabels: outputCapabilities.resolutionLabels,
        directVerifiedCombinations: outputCapabilities.directVerifiedCombinations,
        verificationNotice: outputCapabilities.verificationNotice,
        aspectRatios: outputCapabilities.aspectRatios,
        supportsSourceVideoInput,
        requiresSourceVideo,
        maxReferenceImages,
        minReferenceImages,
        maxReferenceAudios,
        minReferenceAudios,
        supportsAudioInput,
        supportsImageInput: inputContract.maxReferenceImages > 0,
        requiresImage: inputContract.minReferenceImages > 0,
        workflowInputMode,
        referenceAspectRatioPolicy,
        supportsPrompt,
        requiresFirstFrame,
        requiresLastFrame,
        showFirstFrame,
        showLastFrame,
        showReferenceImages,
        showAudioInputs,
        billingUnit,
        tokenPricing,
        workspaceSurfaces,
        supportsRemoteCancel,
        supportsGenerateAudioToggle,
        durationStep,
        successRate,
        totalRequests: total,
        lastSuccessAt,
        sortOrder: Number(m.sort_order) || 0,
        surfaceSortOrder: videoModelSurfaceSortOrder(surfaceOrders, orderSurface, m.id),
        channelKey: videoChannelKey(m),
        channelOrder: 0,
        available,
        priceReady,
        generationReady,
        readinessMessage: "",
        availabilityMessage,
        surfaceCompatible: surfaceCompatibility?.compatible !== false,
        compatibilityCode,
        capabilitiesVerified,
      };
    });

    const publicWorkspaceModels = rankedModels.filter((model) => isVisibleInPublicWorkspace(model, workspaceSurface));

    if (orderSurface) {
      // Each workspace has its own administrator order. Models without an
      // explicit workspace position follow the pinned block and continue to
      // rank by observed usage and health evidence.
      publicWorkspaceModels.sort((a, b) => {
        const aConfigured = a.surfaceSortOrder !== null;
        const bConfigured = b.surfaceSortOrder !== null;
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
        if (aConfigured && bConfigured && a.surfaceSortOrder !== b.surfaceSortOrder) {
          return Number(a.surfaceSortOrder) - Number(b.surfaceSortOrder);
        }
        const aRate = a.successRate === -1 ? -1 : a.successRate;
        const bRate = b.successRate === -1 ? -1 : b.successRate;
        if (aRate !== bRate) return bRate - aRate;
        if (a.totalRequests !== b.totalRequests) return b.totalRequests - a.totalRequests;
        const aLast = a.lastSuccessAt;
        const bLast = b.lastSuccessAt;
        if (aLast && !bLast) return -1;
        if (!aLast && bLast) return 1;
        return a.sortOrder - b.sortOrder || String(a.row.id || "").localeCompare(String(b.row.id || ""));
      });
    } else {
      // Non-workspace consumers keep the legacy channel grouping.
      const channelFirstSort = new Map<string, number>();
      for (const model of publicWorkspaceModels) {
        const current = channelFirstSort.get(model.channelKey);
        if (current === undefined || model.sortOrder < current) channelFirstSort.set(model.channelKey, model.sortOrder);
      }
      const channelOrder = [...channelFirstSort.entries()]
        .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
        .map(([key], index) => [key, index] as const);
      const channelOrderByKey = new Map(channelOrder);
      for (const model of publicWorkspaceModels) model.channelOrder = channelOrderByKey.get(model.channelKey) ?? 999;

      publicWorkspaceModels.sort((a, b) => {
        if (a.channelOrder !== b.channelOrder) return a.channelOrder - b.channelOrder;
        // 同渠道，成功率高、调用次数多且最近成功的模型排前面。
        const aRate = a.successRate === -1 ? -1 : a.successRate;
        const bRate = b.successRate === -1 ? -1 : b.successRate;
        if (aRate !== bRate) return bRate - aRate;
        if (a.totalRequests !== b.totalRequests) return b.totalRequests - a.totalRequests;
        const aLast = a.lastSuccessAt;
        const bLast = b.lastSuccessAt;
        if (aLast && !bLast) return -1;
        if (!aLast && bLast) return 1;
        return a.sortOrder - b.sortOrder || String(a.row.id || "").localeCompare(String(b.row.id || ""));
      });
    }

    const models = publicWorkspaceModels.map((model, index) => toPublicModelDto("video", model.row, index, {
      ...humanDurationCapabilities(model.row),
      type: "video",
      supportsImageInput: model.supportsImageInput,
      requiresImage: model.requiresImage,
      supportsSourceVideoInput: model.supportsSourceVideoInput,
      requiresSourceVideo: model.requiresSourceVideo,
      maxReferenceImages: model.maxReferenceImages,
      minReferenceImages: model.minReferenceImages,
      maxReferenceAudios: model.maxReferenceAudios,
      minReferenceAudios: model.minReferenceAudios,
      supportsAudioInput: model.supportsAudioInput,
      workflowInputMode: model.workflowInputMode,
      ...(model.row.protocol_type === "gaorui_video" && model.row.model_name === "seedance-2.5" && gaoruiVideoCreateContractAdmission(model.row).ready ? { firstFrameRatioPolicy: "adaptive" } : {}),
      referenceAspectRatioPolicy: model.referenceAspectRatioPolicy,
      supportsPrompt: model.supportsPrompt,
      requiresFirstFrame: model.requiresFirstFrame,
      requiresLastFrame: model.requiresLastFrame,
      showFirstFrame: model.showFirstFrame,
      showLastFrame: model.showLastFrame,
      showReferenceImages: model.showReferenceImages,
      showAudioInputs: model.showAudioInputs,
      ...publicMediaBillingCapabilities(model.billingUnit),
      workspaceSurfaces: model.workspaceSurfaces,
      ...(nativeCatalog ? { workspaceAssigned: isWorkspaceModelAssigned(assignmentOverrides, "video", model.row, "publish-center-video") } : {}),
      supportsRemoteCancel: model.supportsRemoteCancel,
      supportsGenerateAudioToggle: model.supportsGenerateAudioToggle,
      durationStep: model.durationStep,
      durationMode: model.durationCapabilities.mode,
      minDuration: model.durationCapabilities.minDuration,
      maxDuration: model.durationCapabilities.maxDuration,
      defaultDuration: model.durationCapabilities.defaultDuration,
      nativeDurations: model.durationCapabilities.nativeDurations,
      resolutionTier: model.resolutionTier,
      resolutionOptions: model.resolutionOptions,
      defaultResolution: model.defaultResolution,
      resolutionPrices: model.resolutionPrices,
      resolutionLabels: model.resolutionLabels,
      directVerifiedCombinations: model.directVerifiedCombinations,
      verificationNotice: model.verificationNotice,
      aspectRatios: model.aspectRatios,
      available: model.available,
      priceReady: model.priceReady,
      generationReady: model.generationReady,
      readinessMessage: model.readinessMessage,
      availabilityMessage: model.availabilityMessage,
      compatibilityCode: model.compatibilityCode,
      capabilitiesVerified: model.capabilitiesVerified,
    }, model.tokenPricing));

    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "视频模型列表暂不可用，请稍后刷新", code: "VIDEO_MODEL_CATALOG_UNAVAILABLE", models: [] },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
