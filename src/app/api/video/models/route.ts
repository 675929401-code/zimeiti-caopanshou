import { humanDurationCapabilities } from '@/features/digital-human/duration-policy';
import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
} from "@/lib/video-model-capabilities";
import { getVideoInputContract } from "@/lib/video-input-contract";
import { isDigitalHumanWorkspaceModel } from "@/lib/video-model-surface";
import { supportsConfirmedVideoCancellation } from "@/lib/video-cancellation";
import { publicMediaBillingCapabilities, toPublicModelDto } from "@/lib/public-model-dto";
import { AUTODL_H3_SELFHOST_PROTOCOL } from "@/lib/autodl-h3-selfhost";
import { requireVideoPriceSnapshot } from "@/lib/video-terminal-finalizer";
import {
  videoBillingAdapterAdmission,
  videoModelAvailabilityMessage,
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
  supportsPrompt: boolean;
  requiresFirstFrame: boolean;
  requiresLastFrame: boolean;
  showFirstFrame: boolean;
  showLastFrame: boolean;
  showReferenceImages: boolean;
  showAudioInputs: boolean;
  billingUnit: "per_use" | "output_second";
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
  availabilityMessage: string;
  surfaceCompatible: boolean;
}

function isVisibleInPublicWorkspace(
  model: RankedVideoModel,
  surface: ReturnType<typeof videoWorkspaceSurfaceFromRequest>,
) {
  if (surface && !model.surfaceCompatible) return false;
  if (surface === "storyboard-video") {
    return model.maxReferenceImages >= 1
      && model.minReferenceImages <= 1
      && !model.requiresLastFrame
      && !model.requiresSourceVideo
      && model.minReferenceAudios === 0;
  }
  if (surface === "video-page") {
    return model.supportsPrompt || model.maxReferenceImages >= 1;
  }
  if (surface === "commerce-video") {
    return model.maxReferenceImages >= 5;
  }
  return true;
}

const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"]);

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
  if (!requestedSurface) return row.protocol_type !== AUTODL_H3_SELFHOST_PROTOCOL;
  const isDigitalHuman = isDigitalHumanWorkspaceModel(row);
  if (requestedSurface === "digital-human") return isDigitalHuman;
  const surface = videoWorkspaceSurfaceFromRequest(requestedSurface);
  // Workspace assignment and the capability policy are evaluated separately
  // below. A mismatch never changes the resource-pool record.
  if (surface) return row.protocol_type !== AUTODL_H3_SELFHOST_PROTOCOL;
  return row.protocol_type !== AUTODL_H3_SELFHOST_PROTOCOL;
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
      .select("id, name, model_name, provider, protocol_type, api_endpoint, api_key, price_per_use, cost_price, duration_seconds, max_duration, supports_image_input, requires_image, is_active, is_hidden, sort_order, total_requests, success_count, last_success_at, api_protocol_config")
      .eq("is_hidden", false)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[VideoModels/Public] Supabase data source unavailable:", error);
      return NextResponse.json({ error: "视频模型列表暂不可用，请稍后刷新", code: "VIDEO_MODEL_CATALOG_UNAVAILABLE", models: [] }, { status: 503 });
    }

    const rows = ((Array.isArray(data) ? data : []) as Record<string, unknown>[])
      .filter((row) => modelMatchesSurface(row, requestedSurface))
      .filter((row) => !workspaceSurface || isWorkspaceModelAssigned(
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
      const inputContract = getVideoInputContract(m);
      const { supportsSourceVideoInput, requiresSourceVideo, maxReferenceImages, minReferenceImages, maxReferenceAudios, minReferenceAudios, supportsPrompt, requiresFirstFrame, requiresLastFrame,
        showFirstFrame, showLastFrame, showReferenceImages, showAudioInputs } = inputContract;
      const supportsAudioInput = inputContract.showAudioInputs;
      const workflowInputMode = inputContract.mode;
      const billingUnit = protocolConfig.billing_unit === "output_second" ? "output_second" as const : "per_use" as const;
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
        requireVideoPriceSnapshot(m, resolutionTier, durationCapabilities.defaultDuration);
      } catch {
        priceSnapshotReady = false;
      }
      const billingAdmission = videoBillingAdapterAdmission(protocolConfig);
      const priceReady = priceSnapshotReady && billingAdmission.ready;
      // Publication evidence and circuit history stay as internal diagnostics.
      // They must not silently remove or disable an administrator-enabled row.
      const configuredForSubmission = String(m.api_key || "").trim().length > 0
        && String(m.protocol_type || "").trim().length > 0
        && /^https?:\/\//iu.test(String(m.api_endpoint || "").trim());
      const baseAvailable = m.is_active === true && configuredForSubmission && priceReady;
      const available = baseAvailable && surfaceCompatibility?.compatible !== false;
      const availabilityMessage = surfaceCompatibility?.compatible === false
        ? surfaceCompatibility.issues[0]?.message || "当前页面不支持该模型所需的输入方式"
        : !billingAdmission.ready
          ? billingAdmission.message
        : videoModelAvailabilityMessage({
        available: baseAvailable,
        active: m.is_active === true,
        activationReady: true,
        priceReady,
        healthReadable: true,
        healthRecorded: true,
        circuitState: "closed",
        lastError: "",
        });
      // The public workspace follows the live submission contract. Internal
      // acceptance evidence remains available to administrators, but it must
      // not create a second customer-facing gate after an enabled row has a
      // resolvable credential, protocol, endpoint and price.
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
        supportsPrompt,
        requiresFirstFrame,
        requiresLastFrame,
        showFirstFrame,
        showLastFrame,
        showReferenceImages,
        showAudioInputs,
        billingUnit,
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
        availabilityMessage,
        surfaceCompatible: surfaceCompatibility?.compatible !== false,
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
      supportsPrompt: model.supportsPrompt,
      requiresFirstFrame: model.requiresFirstFrame,
      requiresLastFrame: model.requiresLastFrame,
      showFirstFrame: model.showFirstFrame,
      showLastFrame: model.showLastFrame,
      showReferenceImages: model.showReferenceImages,
      showAudioInputs: model.showAudioInputs,
      ...publicMediaBillingCapabilities(model.billingUnit),
      workspaceSurfaces: model.workspaceSurfaces,
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
      availabilityMessage: model.availabilityMessage,
    }));

    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "视频模型列表暂不可用，请稍后刷新", code: "VIDEO_MODEL_CATALOG_UNAVAILABLE", models: [] },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
