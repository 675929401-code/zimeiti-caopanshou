import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  authorizeAdminCapability,
  readAdminStepUpSnapshot,
} from "@/lib/server/admin-governance-authority";
import { readImagePublicationStates } from "@/lib/image-model-availability";
import { getImageModelCapabilities } from "@/lib/image-model-capabilities";
import { resolveImageResolutionPrice } from "@/lib/image-resolution-pricing";
import { formatModelPrice, modelConnectionSummary } from "@/lib/model-connection-summary";
import { RETIRED_MODEL_PROVIDER } from "@/lib/model-retirement";
import { inspectVideoModelActivationReadiness, type VideoActivationBinding } from "@/lib/model-activation-gate";
import { getVideoBillingUnit, getVideoDurationCapabilities, getVideoResolutionCapabilities } from "@/lib/video-model-capabilities";
import { requireVideoPriceSnapshot } from "@/lib/video-terminal-finalizer";
import {
  VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY,
  parseVideoModelSurfaceOrders,
  type VideoModelOrderSurface,
  type VideoModelSurfaceOrders,
} from "@/lib/video-model-surface-order";
import {
  IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY,
  parseImageModelSurfaceOrders,
  type ImageModelOrderSurface,
  type ImageModelSurfaceOrders,
} from "@/lib/image-model-surface-order";
import {
  WORKSPACE_MODEL_SURFACES,
  evaluateWorkspaceModelCompatibility,
  type WorkspaceModelKind,
  type WorkspaceModelSurface,
} from "@/lib/workspace-model-policy";
import {
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
  WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY,
  isWorkspaceModelCandidateBlocked,
  isWorkspaceModelAssigned,
  parseWorkspaceModelCandidateBlocks,
  parseWorkspaceModelAssignmentOverrides,
} from "@/lib/workspace-model-assignment-settings";
import { stageLegacyWorkspaceMutation } from "@/lib/server/platform-configuration-compatibility";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function authorizeWorkspaceRead(request: NextRequest) {
  return authorizeAdminCapability(request, "models.view", {
    operation: "workspace_models_view",
  });
}

async function authorizeWorkspaceWrite(request: NextRequest) {
  return authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "workspace_models_manage",
  });
}

function definition(surface: WorkspaceModelSurface) {
  return WORKSPACE_MODEL_SURFACES.find((entry) => entry.id === surface) || null;
}

function imagePriceReady(model: Record<string, unknown>) {
  const capabilities = getImageModelCapabilities(model);
  return capabilities.resolutionOptions.length > 0 && capabilities.resolutionOptions.every((resolution) => {
    const cost = resolveImageResolutionPrice(model, resolution, "cost");
    const selling = resolveImageResolutionPrice(model, resolution, "selling");
    return Number.isFinite(cost) && cost >= 0 && Number.isFinite(selling) && selling >= cost;
  });
}

function videoPriceReady(model: Record<string, unknown>) {
  const resolution = getVideoResolutionCapabilities(model);
  const duration = getVideoDurationCapabilities(model);
  try {
    requireVideoPriceSnapshot(model, resolution.defaultResolution, duration.defaultDuration);
    return true;
  } catch {
    return false;
  }
}

function safeProviderUrl(endpoint: unknown) {
  try {
    const url = new URL(String(endpoint || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return `${url.protocol}//${url.host}/`;
  } catch {
    return "";
  }
}

function modelPresentation(kind: WorkspaceModelKind, model: Record<string, unknown>) {
  const endpoint = String(model.api_endpoint || "");
  const config = record(model.api_protocol_config);
  const connection = modelConnectionSummary(endpoint, config);
  const providerUrl = safeProviderUrl(endpoint);
  const channelLabel = [connection.provider, connection.group]
    .filter((value, index, values) => value && value !== "分组待核对" && values.indexOf(value) === index)
    .join(" · ");
  if (kind === "image") {
    const capabilities = getImageModelCapabilities(model);
    return {
      provider: String(model.provider || ""),
      providerUrl,
      providerHost: connection.host,
      channelLabel,
      priceLabels: capabilities.resolutionOptions.map((resolution) => `${resolution} 售 ¥${formatModelPrice(resolveImageResolutionPrice(model, resolution, "selling"))}`),
      costLabels: capabilities.resolutionOptions.map((resolution) => `${resolution} 成本 ¥${formatModelPrice(resolveImageResolutionPrice(model, resolution, "cost"))}`),
    };
  }
  const capabilities = getVideoResolutionCapabilities(model);
  const unit = getVideoBillingUnit(model) === "output_second" ? "/输出秒" : "/次";
  const options = capabilities.options.length > 0 ? capabilities.options : [""];
  return {
    provider: String(model.provider || ""),
    providerUrl,
    providerHost: connection.host,
    channelLabel,
    priceLabels: options.map((resolution) => `${resolution ? `${resolution} ` : ""}售 ¥${formatModelPrice(capabilities.publicPrices[resolution] ?? model.price_per_use)}${unit}`),
    costLabels: options.map((resolution) => `${resolution ? `${resolution} ` : ""}成本 ¥${formatModelPrice(capabilities.costPrices[resolution] ?? model.cost_price)}${unit}`),
  };
}

function imageOrderForSurface(orders: ImageModelSurfaceOrders, surface: WorkspaceModelSurface, modelId: string) {
  const key = imageOrderKey(surface);
  if (!key) return null;
  const value = orders[key][modelId];
  return Number.isFinite(value) ? value : null;
}

function videoOrderForSurface(orders: VideoModelSurfaceOrders, surface: WorkspaceModelSurface, modelId: string) {
  const key = videoOrderKey(surface);
  if (!key) return null;
  const value = orders[key][modelId];
  return Number.isFinite(value) ? value : null;
}

function imageOrderKey(surface: WorkspaceModelSurface): ImageModelOrderSurface | null {
  if (surface === "image-workbench") return "image-workbench";
  if (surface === "cover-studio") return "cover-studio";
  if (surface === "storyboard-image") return "storyboard-workbench";
  if (surface === "free-canvas-image") return "free-canvas";
  if (surface === "film-studio-image") return "film-studio";
  return null;
}

function videoOrderKey(surface: WorkspaceModelSurface): VideoModelOrderSurface | null {
  if (surface === "video-page") return "ai-video";
  if (surface === "storyboard-video") return "storyboard";
  if (surface === "free-canvas-video") return "free-canvas";
  if (surface === "film-studio-video") return "film-studio";
  if (surface === "commerce-video") return "commerce-agent";
  return null;
}

function availabilityMessage(input: {
  active: boolean;
  hidden: boolean;
  priceReady: boolean;
  configured: boolean;
  inactiveReason?: string;
}) {
  if (!input.configured) return "接口凭据尚未就绪";
  if (!input.priceReady) return "成本价或销售价配置不完整";
  if (!input.active) return input.inactiveReason || "接口与密钥已保存；该模型记录当前处于停用状态";
  if (input.hidden) return "模型已保存到资源池，普通用户目录暂不展示";
  return "生成已启用，可提交";
}

function missingImageProtocolConfigColumn(error: unknown) {
  const message = String((error as { message?: unknown } | null)?.message || "");
  const code = String((error as { code?: unknown } | null)?.code || "");
  return code === "42703" || code === "PGRST204"
    || /api_protocol_config.*cover_models|cover_models.*api_protocol_config|column.*api_protocol_config.*does not exist/iu.test(message);
}

async function readImageResourcePool(
  db: ReturnType<typeof getSupabaseAdminClient>,
): Promise<Record<string, unknown>[]> {
  const selection = "id,name,model_name,provider,api_endpoint,cost_price,selling_price,supports_image_input,is_active,is_hidden,sort_order,api_protocol_config";
  const primary = await db.from("cover_models").select(selection)
    .order("sort_order", { ascending: true }).order("id", { ascending: true });
  if (!primary.error) return (primary.data || []) as Record<string, unknown>[];
  if (!missingImageProtocolConfigColumn(primary.error)) throw new Error("生图模型资源池暂不可读取");
  const fallback = await db.from("cover_models")
    .select("id,name,model_name,provider,api_endpoint,cost_price,selling_price,supports_image_input,is_active,is_hidden,sort_order")
    .order("sort_order", { ascending: true }).order("id", { ascending: true });
  if (fallback.error) throw new Error("生图模型资源池暂不可读取");
  return ((fallback.data || []) as Record<string, unknown>[])
    .map((model): Record<string, unknown> => ({ ...model, api_protocol_config: {} }));
}

async function readCatalog() {
  const db = getSupabaseAdminClient();
  const [imageRows, videoResult, imageOrderResult, videoOrderResult, assignmentResult, candidateBlockResult] = await Promise.all([
    readImageResourcePool(db),
    db.from("video_models").select("id,name,model_name,provider,protocol_type,api_endpoint,api_key,price_per_use,cost_price,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,api_protocol_config").order("sort_order", { ascending: true }).order("id", { ascending: true }),
    db.from("platform_settings").select("setting_value").eq("setting_key", IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY).maybeSingle(),
    db.from("platform_settings").select("setting_value").eq("setting_key", VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY).maybeSingle(),
    db.from("platform_settings").select("setting_value").eq("setting_key", WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY).maybeSingle(),
    db.from("platform_settings").select("setting_value").eq("setting_key", WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY).maybeSingle(),
  ]);
  if (videoResult.error) throw new Error("视频模型资源池暂不可读取");
  if (imageOrderResult.error || videoOrderResult.error || assignmentResult.error || candidateBlockResult.error) throw new Error("工作台模型排序暂不可读取");
  const imageOrders = parseImageModelSurfaceOrders(imageOrderResult.data?.setting_value);
  const videoOrders = parseVideoModelSurfaceOrders(videoOrderResult.data?.setting_value);
  const assignmentOverrides = parseWorkspaceModelAssignmentOverrides(assignmentResult.data?.setting_value);
  const candidateBlocks = parseWorkspaceModelCandidateBlocks(candidateBlockResult.data?.setting_value);

  const imageModels = imageRows
    .filter((model) => model.provider !== RETIRED_MODEL_PROVIDER);
  const images = await Promise.all(imageModels.map(async (model) => {
    const state = (await readImagePublicationStates(db, String(model.id || "")))[0] || null;
    const mergedModel: Record<string, unknown> = state?.model
      ? { ...model, ...state.model }
      : model;
    return { model: mergedModel, state };
  }));
  const videos = ((videoResult.data || []) as Record<string, unknown>[])
    .filter((model) => model.provider !== RETIRED_MODEL_PROVIDER);

  const surfaces = WORKSPACE_MODEL_SURFACES.map((surface) => {
    const source = surface.kind === "image" ? images.map((entry) => entry.model) : videos;
    const models = source.map((model) => {
      const id = String(model.id || "");
      const compatibility = evaluateWorkspaceModelCompatibility(surface.kind, model, surface.id);
      const active = model.is_active === true;
      const hidden = model.is_hidden === true;
      const protocol = model.api_protocol_config && typeof model.api_protocol_config === "object" && !Array.isArray(model.api_protocol_config)
        ? model.api_protocol_config as Record<string, unknown>
        : {};
      const inactiveReason = surface.kind === "image"
        ? String(protocol.public_unavailable_reason || "").trim()
        : "";
      const imageState = surface.kind === "image"
        ? images.find((entry) => String(entry.model.id || "") === id)?.state
        : null;
      const configured = surface.kind === "image"
        ? imageState?.configured === true
        : Boolean(String(model.api_key || "").trim());
      const priceReady = surface.kind === "image" ? imagePriceReady(model) : videoPriceReady(model);
      const activationBinding: VideoActivationBinding | null = surface.kind === "video"
        ? {
            id: String(model.id || ""),
            model_name: String(model.model_name || ""),
            provider: String(model.provider || ""),
            protocol_type: String(model.protocol_type || ""),
            api_endpoint: String(model.api_endpoint || ""),
            api_key: String(model.api_key || ""),
            api_protocol_config: model.api_protocol_config,
          }
        : null;
      const activation = activationBinding
        ? inspectVideoModelActivationReadiness(activationBinding)
        : { ready: true, reason: "not_applicable" };
      const publishable = compatibility.compatible && active && !hidden && configured && priceReady;
      const assigned = isWorkspaceModelAssigned(assignmentOverrides, surface.kind, model, surface.id);
      const catalogDisplayable = !hidden;
      const visibleNow = assigned && catalogDisplayable;
      const order = surface.kind === "image"
        ? imageOrderForSurface(imageOrders, surface.id, id)
        : videoOrderForSurface(videoOrders, surface.id, id);
      return {
        id,
        name: String(model.name || model.model_name || id),
        modelName: String(model.model_name || ""),
        kind: surface.kind,
        assigned,
        compatible: compatibility.compatible,
        publishable,
        catalogDisplayable,
        visibleNow,
        active,
        hidden,
        priceReady,
        activationReady: activation.ready,
        activationReason: activation.reason,
        availabilityMessage: availabilityMessage({ active, hidden, priceReady, configured, inactiveReason }),
        capabilityLabels: compatibility.capabilityLabels,
        issues: compatibility.issues,
        warnings: compatibility.warnings,
        order,
        fallbackOrder: Number(model.sort_order) || 0,
        ...modelPresentation(surface.kind, model),
      };
    }).filter((model) => (model.publishable || model.assigned) && !isWorkspaceModelCandidateBlocked(candidateBlocks, model.id)).sort((left, right) => {
      if (left.assigned !== right.assigned) return left.assigned ? -1 : 1;
      const leftConfigured = left.order !== null;
      const rightConfigured = right.order !== null;
      if (leftConfigured !== rightConfigured) return leftConfigured ? -1 : 1;
      if (left.order !== right.order && left.order !== null && right.order !== null) return left.order - right.order;
      return left.fallbackOrder - right.fallbackOrder || left.name.localeCompare(right.name, "zh-CN");
    });
    return { ...surface, models };
  });
  return { surfaces };
}

function readOnlyCatalog(catalog: Awaited<ReturnType<typeof readCatalog>>) {
  return {
    surfaces: catalog.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      label: surface.label,
      description: surface.description,
      models: surface.models
        .filter((model) => model.visibleNow)
        .map((model) => ({
          id: model.id,
          name: model.name,
          modelName: "",
          kind: model.kind,
          assigned: true,
          compatible: model.compatible,
          publishable: model.publishable,
          catalogDisplayable: model.catalogDisplayable,
          visibleNow: model.visibleNow,
          active: model.active,
          hidden: model.hidden,
          priceReady: model.priceReady,
          activationReady: model.activationReady,
          availabilityMessage: model.publishable ? "当前可供用户使用" : "当前模型暂不可提交",
          capabilityLabels: model.capabilityLabels,
          issues: [],
          warnings: [],
          order: model.order,
          fallbackOrder: model.fallbackOrder,
          provider: "",
          providerUrl: "",
          providerHost: "",
          channelLabel: "",
          priceLabels: model.priceLabels,
          costLabels: [],
        })),
    })),
  };
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeWorkspaceRead(request);
  if (!authorization.ok) return authorization.response;
  const canManageModels = authorization.access.permissionKeys.includes("models.manage")
    && (await readAdminStepUpSnapshot(request, authorization.actor.userId, "models.manage")).status === "ready";
  try {
    const catalog = await readCatalog();
    return NextResponse.json({
      ...(canManageModels ? catalog : readOnlyCatalog(catalog)),
      access: { mode: canManageModels ? "manage" : "read" },
    }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[WorkspaceModels/Admin] GET failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "工作台模型配置暂不可读取" }, { status: 503, headers: noStoreHeaders });
  }
}

async function updateAssignment(input: {
  actorId: string;
  kind: WorkspaceModelKind;
  surface: WorkspaceModelSurface;
  modelId: string;
  enabled: boolean;
}) {
  const surface = definition(input.surface);
  if (!surface || surface.kind !== input.kind) throw new Error("工作台与模型类型不匹配");
  const db = getSupabaseAdminClient();
  const table = input.kind === "image" ? "cover_models" : "video_models";
  const result = await db.from(table).select("*").eq("id", input.modelId).maybeSingle();
  if (result.error || !result.data) throw new Error("模型不存在或资源池暂不可读取");
  const model = result.data as Record<string, unknown>;
  if (model.provider === RETIRED_MODEL_PROVIDER) throw new Error("已退役模型不能发布到工作台");
  if (input.enabled && model.is_hidden === true) throw new Error("请先在模型资源池显示模型，再添加到工作台");
  if (input.enabled) {
    const blocked = await db.from("platform_settings").select("setting_value")
      .eq("setting_key", WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY).maybeSingle();
    if (blocked.error) throw new Error("工作台模型候选状态暂不可读取");
    if (isWorkspaceModelCandidateBlocked(parseWorkspaceModelCandidateBlocks(blocked.data?.setting_value), input.modelId)) {
      throw new Error("该模型接口通信异常，修复后才能添加到业务页面");
    }
    const compatibility = evaluateWorkspaceModelCompatibility(input.kind, model, input.surface);
    if (!compatibility.compatible) {
      throw new Error(compatibility.issues[0]?.message || "该模型与当前工作台能力不匹配");
    }
  }
  return stageLegacyWorkspaceMutation({
    actorId: input.actorId,
    mutation: { action: "assign", surface: input.surface, modelId: input.modelId, enabled: input.enabled },
    changeNote: `${input.surface} ${input.enabled ? "分配" : "移除"}模型 ${input.modelId}`,
  });
}

async function updateOrder(input: {
  actorId: string;
  kind: WorkspaceModelKind;
  surface: WorkspaceModelSurface;
  modelIds: string[];
}) {
  const surface = definition(input.surface);
  if (!surface || surface.kind !== input.kind) throw new Error("工作台与模型类型不匹配");
  if (input.modelIds.length === 0 || new Set(input.modelIds).size !== input.modelIds.length) throw new Error("排序列表无效");
  const db = getSupabaseAdminClient();
  const table = input.kind === "image" ? "cover_models" : "video_models";
  const result = await db.from(table).select(input.kind === "image"
    ? "id,name,model_name,provider,supports_image_input,is_active,is_hidden,sort_order"
    : "id,name,model_name,provider,protocol_type,duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,api_protocol_config")
    .in("id", input.modelIds);
  if (result.error || (result.data || []).length !== input.modelIds.length) throw new Error("排序模型读取不完整");
  return stageLegacyWorkspaceMutation({
    actorId: input.actorId,
    mutation: { action: "reorder", surface: input.surface, orderedModelIds: input.modelIds },
    changeNote: `${input.surface} 模型排序`,
  });
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeWorkspaceWrite(request);
  if (!authorization.ok) return authorization.response;
  const admin = authorization.actor;
  try {
    const body = record(await request.json());
    const action = String(body.action || "");
    const kind = String(body.kind || "") as WorkspaceModelKind;
    const surface = String(body.surface || "") as WorkspaceModelSurface;
    if (!definition(surface) || !["image", "video"].includes(kind)) {
      return NextResponse.json({ error: "工作台参数无效" }, { status: 400, headers: noStoreHeaders });
    }
    const result = action === "assign"
      ? await updateAssignment({ actorId: admin.userId, kind, surface, modelId: String(body.modelId || "").trim(), enabled: body.enabled === true })
      : action === "reorder"
        ? await updateOrder({ actorId: admin.userId, kind, surface, modelIds: Array.isArray(body.modelIds) ? body.modelIds.map(String).map((value) => value.trim()).filter(Boolean) : [] })
        : null;
    if (!result) return NextResponse.json({ error: "未知操作" }, { status: 400, headers: noStoreHeaders });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202, headers: noStoreHeaders });
  } catch (error) {
    console.error("[WorkspaceModels/Admin] POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "工作台模型配置保存失败" }, { status: 409, headers: noStoreHeaders });
  }
}
