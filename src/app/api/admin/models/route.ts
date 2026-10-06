import { RETIRED_MODEL_PROVIDER, isPermanentlyRetiredModel, modelRetirementPatch } from "@/lib/model-retirement";
import { updateVideoModelAtomic } from "@/lib/video-model-atomic-update";
import { pendingImageConfigurationUpdate } from "@/lib/image-model-availability";
import { ImageAdminValidationError } from "@/lib/image-admin-validation";
import { ImageProviderBindingError, resolveImageProviderContract } from "@/lib/image-provider-contract";
import {
  canonicalLlmProtocolConfig,
  LlmProviderBindingError,
} from "@/lib/llm-provider-contract";
/**
 * 缁熶竴妯″瀷绠＄悊 API
 * GET  - 鑱氬悎鍒楀嚭鎵€鏈夌被鍨嬫ā鍨嬶紙缁樺浘/鏂囨/瑙嗛锛?
 * POST - 鏂板妯″瀷锛堟牴鎹?model_type 鍐欏叆涓嶅悓琛級
 */
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import {
  authorizeAdminCapability,
  readAdminStepUpSnapshot,
} from "@/lib/server/admin-governance-authority";
import {
  AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
  AUTODL_H3_SELFHOST_IMAGE_MODEL,
  AUTODL_H3_SELFHOST_PROTOCOL,
  AUTODL_H3_SELFHOST_PROVIDER,
  AUTODL_H3_SELFHOST_SECRET_REF,
  AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
  AUTODL_H3_SELFHOST_VIDEO_MODEL,
  assertAutodlH3SelfhostModelBinding,
  autodlH3SelfhostImageEndpoint,
  autodlH3SelfhostVideoEndpoint,
} from "@/lib/autodl-h3-selfhost";
import {
  ModelActivationGateError,
  PENDING_TEXT_USER_ACCESS,
  assertOrdinaryAdminUpdateDoesNotActivate,
  prepareVideoModelBindingUpdate,
  forceNewVideoModelPending,
  newPendingImageModelId,
  preservePersistedVideoActivationGate,
} from "@/lib/model-activation-gate";
import { AUTODL_COMFYUI_WORKFLOW_PROTOCOL } from "@/lib/video-autodl-comfyui-workflow";
import { shouldSyncLegacyAgentMessagePricing } from "@/lib/text-model-admin-sync";
import {
  VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY,
  normalizeVideoModelOrderSurface,
  parseVideoModelSurfaceOrders,
} from "@/lib/video-model-surface-order";
import { videoPriceConfigurationError } from "@/lib/model-price-rounding";
import {
  stageLegacyModelPoolCatalogState,
  stageLegacyModelPoolOrder,
  stageLegacyModelPoolUpsert,
  stageLegacyWorkspaceMutation,
  type LegacyModelTable,
} from "@/lib/server/platform-configuration-compatibility";

const AUTODL_H3_WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2";
const AUTODL_H3_ADMIN_NOTES = [
  "【内部渠道备注｜仅管理员可见】",
  "供应商：AutoDL.Art 托管 ComfyUI 工作流；工作流 ID：minimax_h3_image_audio_to_video_v2。",
  "计费口径：成本价字段填写默认 768p 的单秒成本 ¥0.07，不是 10 秒总成本；系统按实际提交时长结算。",
  "分档成本：480p ¥0.05/输出秒；768p ¥0.07/输出秒；1080p ¥0.11/输出秒。",
  "默认参数：10 秒、768p；允许 1–10 秒整数；仅 16:9/9:16；最多 9 张参考图 + 3 段参考音频。",
  "10 秒参考总成本：480p ¥0.50；768p ¥0.70；1080p ¥1.10。",
  "并发说明：允许多任务异步提交/排队，但平台未公开真实同时 RUNNING 数与 SLA，实测前不得承诺 2/3 路真并发。",
  "运维说明：上游不支持远程取消；提交后仍可能产生费用；成功结果短链需立即转存。",
  "密钥说明：数据库只保存 secret:// 引用；服务器从 AUTODL_COMFYUI_API_KEY 环境变量读取，本机开发才回退 Windows DPAPI 文件。禁止在备注或数据库中粘贴明文令牌。",
].join("\n");

function autoDLH3ProtocolConfig(value: unknown): Record<string, unknown> {
  const existing = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...existing,
    workflow_id: String(existing.workflow_id || AUTODL_H3_WORKFLOW_ID),
    supports_duration: true,
    min_duration: 1,
    max_duration: 10,
    min_submit_duration: 1,
    duration_step: 1,
    default_duration: 10,
    resolution_options: ["480p", "768p", "1080p"],
    default_resolution: String(existing.default_resolution || "768p"),
    resolution: String(existing.resolution || existing.default_resolution || "768p"),
    resolution_cost_prices: existing.resolution_cost_prices || { "480p": 0.05, "768p": 0.07, "1080p": 0.11 },
    resolution_prices: existing.resolution_prices || { "480p": 0.05, "768p": 0.07, "1080p": 0.11 },
    billing_unit: "output_second",
    aspect_ratios: ["16:9", "9:16"],
    max_reference_images: 9,
    max_reference_audios: 3,
    supports_audio_input: true,
    workspace_surfaces: ["ai-video", "storyboard"],
    persist_result_immediately: true,
    supports_remote_cancel: false,
  };
}

const AUTODL_H3_SELFHOST_ADMIN_NOTES = [
  "【内部渠道备注｜仅管理员可见】",
  "渠道：AutoDL 自租 GPU 实例；与 AutoDL 托管 ComfyUI API 完全隔离。",
  "硬件型号不写入模型名称；实例换卡后必须先做单条 canary，再确认速度、显存和稳定性。",
  "接口：Bearer 网关 /v1/models、/v1/video/generations；模型 minimax-h3-turbo。",
  "原生时长：5/10/15 秒；分辨率档仅 480p，像素随画幅映射为 864x480、480x864、768x768。",
  "图片输入为可选：无图走文生视频，上传首帧/参考图才走图生视频；禁止自动偷偷生成参考图。",
  "结果为短期签名地址，必须立即转存对象存储；不支持远程取消。",
  "密钥：数据库只保存 secret://autodl-h3-selfhost；严禁复用托管 ComfyUI Token。",
  "当前仅限本地 V2.6 内测；普通 AutoDL 实例不得直接作为全国用户生产公网入口。",
].join("\n");

function autoDLH3SelfhostProtocolConfig(value: unknown): Record<string, unknown> {
  const existing = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (existing && Object.keys(existing).length > 0) {
    return {
      ...existing,
      auto_generate_reference: false,
      persist_result_immediately: true,
      supports_remote_cancel: false,
      billing_unit: "per_use",
      workspace_surfaces: ["ai-video", "storyboard"],
    };
  }
  return {
    supports_duration: true,
    duration_options: [5, 10, 15],
    min_duration: 5,
    max_duration: 15,
    min_submit_duration: 5,
    duration_step: 5,
    default_duration: 10,
    exact_duration_only: true,
    resolution_options: ["480p"],
    default_resolution: "480p",
    resolution: "480p",
    resolution_cost_prices: { "480p": 0 },
    resolution_prices: { "480p": 0 },
    aspect_ratios: ["16:9", "9:16", "1:1"],
    pixel_size_by_aspect_ratio: {
      "16:9": "864x480",
      "9:16": "480x864",
      "1:1": "768x768",
    },
    auto_generate_reference: false,
    persist_result_immediately: true,
    supports_remote_cancel: false,
    billing_unit: "per_use",
    workspace_surfaces: ["ai-video", "storyboard"],
  };
}

class AutodlH3SelfhostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutodlH3SelfhostConfigError";
  }
}

function assertAdminAutodlH3SelfhostBinding(
  kind: "drawing" | "video" | "text",
  fields: Record<string, unknown>,
) {
  try {
    assertAutodlH3SelfhostModelBinding({
      kind: kind === "drawing" ? "image" : kind,
      provider: fields.provider,
      protocolType: fields.protocol_type,
      modelName: fields.model_name || fields.name,
      apiEndpoint: fields.api_endpoint,
      apiKey: fields.api_key,
    });
  } catch (error) {
    throw new AutodlH3SelfhostConfigError(
      error instanceof Error ? error.message : "AutoDL H3 自租模型配置不合法",
    );
  }
}

function requireAutodlH3SelfhostExactValue(value: unknown, expected: string, label: string) {
  const configured = String(value || "").trim();
  if (configured && configured !== expected) {
    throw new AutodlH3SelfhostConfigError(`AutoDL H3 自租${label}必须为系统固定值`);
  }
}

function normalizeAutodlH3SelfhostImageFields(
  fields: Record<string, unknown>,
  lockedFields?: Record<string, unknown> | null,
) {
  requireAutodlH3SelfhostExactValue(fields.model_name, AUTODL_H3_SELFHOST_IMAGE_MODEL, "生图模型");
  requireAutodlH3SelfhostExactValue(fields.api_key, AUTODL_H3_SELFHOST_SECRET_REF, "密钥引用");
  let apiEndpoint = AUTODL_H3_SELFHOST_IMAGE_ENDPOINT;
  try {
    apiEndpoint = autodlH3SelfhostImageEndpoint(String(fields.api_endpoint || AUTODL_H3_SELFHOST_IMAGE_ENDPOINT));
  } catch (error) {
    throw new AutodlH3SelfhostConfigError(error instanceof Error ? error.message : "AutoDL H3 自租生图地址无效");
  }
  return {
    ...fields,
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    model_name: AUTODL_H3_SELFHOST_IMAGE_MODEL,
    api_endpoint: apiEndpoint,
    api_key: AUTODL_H3_SELFHOST_SECRET_REF,
    supports_image_input: false,
  };
}

function normalizeAutodlH3SelfhostVideoFields(
  fields: Record<string, unknown>,
  lockedFields?: Record<string, unknown> | null,
) {
  requireAutodlH3SelfhostExactValue(fields.model_name, AUTODL_H3_SELFHOST_VIDEO_MODEL, "视频模型");
  requireAutodlH3SelfhostExactValue(fields.api_key, AUTODL_H3_SELFHOST_SECRET_REF, "密钥引用");
  let apiEndpoint = AUTODL_H3_SELFHOST_VIDEO_ENDPOINT;
  try {
    apiEndpoint = autodlH3SelfhostVideoEndpoint(String(fields.api_endpoint || AUTODL_H3_SELFHOST_VIDEO_ENDPOINT));
  } catch (error) {
    throw new AutodlH3SelfhostConfigError(error instanceof Error ? error.message : "AutoDL H3 自租视频地址无效");
  }
  return {
    ...fields,
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    protocol_type: AUTODL_H3_SELFHOST_PROTOCOL,
    model_name: AUTODL_H3_SELFHOST_VIDEO_MODEL,
    api_endpoint: apiEndpoint,
    api_key: AUTODL_H3_SELFHOST_SECRET_REF,
    duration_seconds: lockedFields ? Number(lockedFields.duration_seconds) || 10 : 10,
    max_duration: lockedFields ? Number(lockedFields.max_duration) || 15 : 15,
    supports_image_input: true,
    requires_image: false,
    api_protocol_config: autoDLH3SelfhostProtocolConfig(lockedFields?.api_protocol_config),
  };
}

// 鈹€鈹€鈹€ 绠＄悊鍛橀獙璇?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function authorizeModelRead(request: NextRequest) {
  return authorizeAdminCapability(request, "models.view", {
    operation: "models_view",
  });
}

async function authorizeModelWrite(request: NextRequest) {
  return authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "models_manage",
  });
}

// 鈹€鈹€鈹€ 缁熶竴妯″瀷绫诲瀷 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
export type ModelType = "drawing" | "text" | "video";

export interface UnifiedModel {
  id: string;
  name: string;
  model_type: ModelType;
  model_name: string;        // 搴曞眰妯″瀷鏍囪瘑
  api_endpoint: string;
  api_key_configured: boolean;
  // 璁¤垂妯″紡: per_use=鍗曟璁¤垂, token=鍏宠仈Token璁¤垂, credit=鎸夋鎵ｇН鍒?
  billing_mode: "per_use" | "token" | "credit";
  // 鍗曟璁¤垂 / 鎸夋鎵ｇН鍒?
  cost_per_use: number;      // 鍞环锛堢敤鎴蜂粯璐癸級
  cost_price: number;        // 杩涗环锛堟垚鏈級
  // Token璁¤垂鍙傛暟
  token_billing_enabled: boolean;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  cached_cost_per_million: number | null;
  profit_margin: number | null;
  token_rounding_unit: number;
  // 閫氱敤瀛楁
  is_active: boolean;
  is_hidden: boolean;
  sort_order: number;
  provider: string;
  protocol_type: string;
  admin_notes: string;
  // 瑙嗛涓撳睘
  duration_seconds?: number;
  max_duration?: number;
  api_protocol_config?: Record<string, unknown>;
  supports_image_input?: boolean;
  requires_image?: boolean;
  // 鏂囨涓撳睘
  max_context_rounds?: number;
  max_context_tokens?: number;
  max_reply_tokens?: number;
  timeout?: number;
  enable_web_search?: boolean;
  deep_thinking_type?: number;
  deduct_deep_think?: number;
  temperature?: number | null;
  response_format?: string | null;
  proxy_url?: string;
  description?: string;
  category?: string;
  user_access?: string;
  frequency_limit?: number;
  image_parsing?: string;
  file_parsing?: string;
  icon_url?: string;
  // 缁熻
  total_requests?: number;
  success_count?: number;
  fail_count?: number;
  // 鍏冧俊鎭?
  created_at: string;
  updated_at?: string;
  // 鍏宠仈
  agent_id?: string;         // 鏂囨妯″瀷鍏宠仈鐨?agents 琛?ID
}

function unifiedStats(models: Array<{ model_type?: string; is_active?: boolean }>) {
  return {
    drawing: models.filter(m => m.model_type === "drawing").length,
    text: models.filter(m => m.model_type === "text").length,
    video: models.filter(m => m.model_type === "video").length,
    total: models.length,
    active: models.filter(m => m.is_active).length,
  };
}

const MASKED_SECRET = /^(?:[*•●·]+|已配置)$/u;

function replacementApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !MASKED_SECRET.test(trimmed) ? trimmed : undefined;
}

function publicModel<T extends Record<string, unknown>>(model: T): Omit<T, "api_key"> & { api_key_configured: boolean } {
  const { api_key, ...safe } = model;
  return { ...safe, api_key_configured: Boolean(String(api_key || "").trim()) };
}

/**
 * `models.view` exposes the user-facing catalogue only. Supplier identity,
 * endpoint, cost, protocol, credential state, internal notes and tuning
 * parameters stay on the server unless the caller also has an active
 * `models.manage` step-up session.
 */
function readOnlyModel(model: UnifiedModel) {
  return {
    id: model.id,
    name: model.name,
    model_type: model.model_type,
    billing_mode: model.billing_mode,
    selling_price: model.cost_per_use,
    price_per_use: model.cost_per_use,
    is_active: model.is_active,
    is_hidden: model.is_hidden,
    sort_order: model.sort_order,
    duration_seconds: model.duration_seconds,
    max_duration: model.max_duration,
    supports_image_input: model.supports_image_input,
    requires_image: model.requires_image,
    description: model.description,
    category: model.category,
    user_access: model.user_access,
    icon_url: model.icon_url,
    created_at: model.created_at,
    updated_at: model.updated_at,
  };
}

function textTokenConfigurationError(fields: Record<string, unknown>): string | null {
  for (const [key, label] of [
    ["input_cost_per_million", "输入成本"],
    ["output_cost_per_million", "输出成本"],
    ["cached_cost_per_million", "缓存成本"],
  ] as const) {
    const raw = fields[key];
    if (raw === null || raw === undefined || String(raw).trim() === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      return `${label}必须是大于或等于 0 的每百万 Token 成本`;
    }
  }
  const margin = fields.profit_margin;
  if (margin === null || margin === undefined || String(margin).trim() === ""
    || !Number.isFinite(Number(margin)) || Number(margin) < 0 || Number(margin) >= 100) {
    return "利润率必须在 0（含）到 100（不含）之间";
  }
  const contextTokens = Number(fields.max_context_tokens);
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return "上下文长度必须是大于 0 的 Token 数";
  }
  return null;
}

// GET - 鑱氬悎鍒楀嚭鎵€鏈夋ā鍨?
export async function GET(req: NextRequest) {
  const authorization = await authorizeModelRead(req);
  if (!authorization.ok) return authorization.response;
  const canManageModels = authorization.access.permissionKeys.includes("models.manage")
    && (await readAdminStepUpSnapshot(req, authorization.actor.userId, "models.manage")).status === "ready";

  const dbClient = getSupabaseClient();
  const models: UnifiedModel[] = [];

  try {
    const surfaceOrderResult = await dbClient
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", VIDEO_MODEL_SURFACE_ORDER_SETTING_KEY)
      .maybeSingle();
    const videoSurfaceOrders = parseVideoModelSurfaceOrders(surfaceOrderResult.data?.setting_value);
    // 鈹€鈹€ 缁樺浘妯″瀷 (cover_models) 鈹€鈹€
    const { data: coverModels, error: coverError } = await dbClient
      .from("cover_models")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (!coverError && coverModels) {
      for (const m of coverModels) {
        models.push({
          id: m.id,
          name: m.name,
          model_type: "drawing",
          model_name: m.model_name || "",
          api_endpoint: m.api_endpoint || "",
          api_key_configured: Boolean(String(m.api_key || "").trim()),
          billing_mode: "per_use",
          cost_per_use: Number(m.selling_price) || 0,
          cost_price: Number(m.cost_price) || 0,
          token_billing_enabled: false,
          input_cost_per_million: null,
          output_cost_per_million: null,
          cached_cost_per_million: null,
          profit_margin: null,
          token_rounding_unit: 0,
          is_active: m.is_active !== false,
          is_hidden: m.is_hidden === true,
          sort_order: m.sort_order || 0,
          provider: m.provider || "vectorengine",
          protocol_type: String(m.api_protocol_config?.protocol || "openai_image"),
          admin_notes: String(m.api_protocol_config?.admin_notes || ""),
          api_protocol_config: m.api_protocol_config || {},
          supports_image_input: m.supports_image_input === true,
          created_at: m.created_at || "",
          updated_at: m.updated_at || "",
        });
      }
    }

    // 鈹€鈹€ 鏂囨妯″瀷 (llm_models 棰勮琛? 鈹€鈹€
    const { data: llmModels, error: llmError } = await dbClient
      .from("llm_models")
      .select("*")
      .order("sort_order")
      .order("id", { ascending: true });

    if (!llmError && llmModels) {
      for (const m of llmModels) {
        const hasTokenBilling = m.token_billing_enabled === true;
        const protocolConfig = m.api_protocol_config && typeof m.api_protocol_config === "object"
          ? m.api_protocol_config as Record<string, unknown>
          : {};
        models.push({
          id: m.id,
          name: m.name,
          model_type: "text",
          model_name: m.model_name || "",
          api_endpoint: m.api_endpoint || m.proxy_url || "",
          api_key_configured: Boolean(String(m.api_key || "").trim()),
          billing_mode: hasTokenBilling ? "token" : (m.billing_mode || "credit"),
          cost_per_use: Number(m.cost_per_use) || 0,
          cost_price: Number(m.cost_price) || 0,
          token_billing_enabled: hasTokenBilling,
          input_cost_per_million: m.input_cost_per_million != null ? Number(m.input_cost_per_million) : null,
          output_cost_per_million: m.output_cost_per_million != null ? Number(m.output_cost_per_million) : null,
          cached_cost_per_million: m.cached_cost_per_million != null ? Number(m.cached_cost_per_million) : null,
          profit_margin: m.profit_margin != null ? Number(m.profit_margin) : null,
          token_rounding_unit: m.token_rounding_unit ?? 0,
          is_active: m.is_active !== false,
          is_hidden: m.is_hidden === true,
          sort_order: m.sort_order || 0,
          provider: String(protocolConfig.provider || ""),
          protocol_type: String(protocolConfig.protocol || ""),
          max_context_rounds: m.max_context_rounds ?? 0,
          max_context_tokens: m.max_context_tokens ?? 0,
          max_reply_tokens: m.max_reply_tokens ?? 0,
          timeout: m.timeout ?? 300,
          enable_web_search: m.enable_web_search ?? false,
          deep_thinking_type: m.deep_thinking_type ?? 0,
          deduct_deep_think: m.deduct_deep_think != null ? Number(m.deduct_deep_think) : 1,
          temperature: m.temperature,
          response_format: m.response_format,
          proxy_url: m.proxy_url || m.api_endpoint || "",
          api_protocol_config: protocolConfig,
          admin_notes: m.admin_notes || "",
          description: m.description || "",
          category: m.category || "閫氱敤",
          user_access: m.user_access || "available",
          frequency_limit: m.frequency_limit ?? 50,
          image_parsing: m.image_parsing || "none",
          file_parsing: m.file_parsing || "none",
          icon_url: m.icon_url || "",
          created_at: m.created_at || "",
          updated_at: m.updated_at || "",
        });
      }
    }

    // 鈹€鈹€ 瑙嗛妯″瀷 (video_models) 鈹€鈹€
    const { data: videoModels, error: videoError } = await dbClient
      .from("video_models")
      .select("*")
      .order("sort_order")
      .order("id", { ascending: true });

    if (!videoError && videoModels) {
      for (const m of videoModels) {
        models.push({
          id: m.id,
          name: m.name,
          model_type: "video",
          model_name: m.model_name || "",
          api_endpoint: m.api_endpoint || "",
          api_key_configured: Boolean(String(m.api_key || "").trim()),
          billing_mode: "per_use",
          cost_per_use: Number(m.price_per_use) || 0,
          cost_price: Number(m.cost_price) || 0,
          token_billing_enabled: false,
          input_cost_per_million: null,
          output_cost_per_million: null,
          cached_cost_per_million: null,
          profit_margin: null,
          token_rounding_unit: 0,
          is_active: m.is_active !== false,
          is_hidden: m.is_hidden === true,
          sort_order: m.sort_order || 0,
          provider: m.provider || m.protocol_type || "",
          protocol_type: m.protocol_type || "openai_compatible",
          admin_notes: m.admin_notes || "",
          duration_seconds: m.duration_seconds || 5,
          max_duration: m.max_duration || 10,
          api_protocol_config: m.api_protocol_config || {},
          supports_image_input: m.supports_image_input !== false,
          requires_image: m.requires_image === true,
          total_requests: m.total_requests || 0,
          success_count: m.success_count || 0,
          fail_count: m.fail_count || 0,
          created_at: m.created_at || "",
        });
      }
    }

    // Group stats
    const currentModels = models.filter(model => model.provider !== RETIRED_MODEL_PROVIDER);
    const stats = unifiedStats(currentModels);

    return NextResponse.json({
      models: canManageModels ? currentModels : currentModels.map(readOnlyModel),
      stats,
      video_surface_orders: canManageModels ? videoSurfaceOrders : {},
      access: { mode: canManageModels ? "manage" : "read" },
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("[UnifiedModels] GET error:", error);
    return NextResponse.json({ error: "获取模型列表失败" }, { status: 500 });
  }
}

// POST - 鏂板妯″瀷锛堟牴鎹?model_type 鍐欏叆涓嶅悓琛級
export async function POST(req: NextRequest) {
  const authorization = await authorizeModelWrite(req);
  if (!authorization.ok) return authorization.response;
  const admin = authorization.actor;

  try {
    const body = await req.json();
    const { model_type, ...fields } = body;

    if (!model_type || !["drawing", "text", "video"].includes(model_type)) {
      return NextResponse.json({ error: "模型类型无效" }, { status: 400 });
    }
    if (String(fields.provider || "") === RETIRED_MODEL_PROVIDER || isPermanentlyRetiredModel(fields)) {
      return NextResponse.json({ error: "该模型或渠道已永久退役，不能重新添加", code: "MODEL_PERMANENTLY_RETIRED" }, { status: 409 });
    }

    const dbClient = getSupabaseClient();

    if (model_type === "drawing") {
      const drawingFields = fields.provider === AUTODL_H3_SELFHOST_PROVIDER
        ? normalizeAutodlH3SelfhostImageFields(fields)
        : fields;
      if (!String(drawingFields.name || drawingFields.model_name || "").trim()
        || !String(drawingFields.api_endpoint || "").trim()
        || !String(drawingFields.api_key || "").trim()) {
        return NextResponse.json({ error: "名称、模型名、API地址和密钥为必填" }, { status: 400 });
      }
      assertAdminAutodlH3SelfhostBinding("drawing", {
        ...drawingFields,
        provider: drawingFields.provider || "vectorengine",
      });
      try {
        resolveImageProviderContract({
          provider: drawingFields.provider,
          model_name: drawingFields.model_name || drawingFields.name,
          api_endpoint: drawingFields.api_endpoint,
          supports_image_input: drawingFields.supports_image_input !== false,
          api_protocol_config: drawingFields.api_protocol_config,
        });
      } catch (error) {
        if (error instanceof ImageProviderBindingError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
      const id = newPendingImageModelId();
      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "cover_models",
        id,
        changeNote: `新增生图模型 ${drawingFields.model_name || drawingFields.name}`,
        values: {
          id,
          name: drawingFields.name,
          model_name: drawingFields.model_name || drawingFields.name,
          provider: drawingFields.provider || "vectorengine",
          api_endpoint: drawingFields.api_endpoint || "https://api.vectorengine.ai/",
          api_key: drawingFields.api_key || "",
          cost_price: Number(drawingFields.cost_price) || 0,
          selling_price: Number(drawingFields.cost_per_use) || 0,
          is_active: true,
          is_hidden: false,
          supports_image_input: drawingFields.supports_image_input !== false,
          api_protocol_config: drawingFields.api_protocol_config || {},
        },
      });
      return NextResponse.json({ success: true, staged: true, published: false, result, model_type }, { status: 202 });

    } else if (model_type === "text") {
      assertAdminAutodlH3SelfhostBinding("text", fields);
      if (!String(fields.name || fields.model_name || "").trim()
        || !String(fields.api_endpoint || "").trim()
        || !String(fields.api_key || "").trim()) {
        return NextResponse.json({ error: "名称、模型名、API地址和密钥为必填" }, { status: 400 });
      }
      const tokenConfigurationError = textTokenConfigurationError(fields);
      if (tokenConfigurationError) {
        return NextResponse.json({ error: tokenConfigurationError, code: "TEXT_TOKEN_CONFIGURATION_REQUIRED" }, { status: 400 });
      }
      let textProtocolConfig: Record<string, unknown>;
      try {
        textProtocolConfig = canonicalLlmProtocolConfig(fields);
      } catch (error) {
        if (error instanceof LlmProviderBindingError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
      // 鈹€鈹€鈹€ 鑷姩妫€娴嬫帹鐞嗘ā鍨嬪苟璁剧疆鏈€浣冲弬鏁帮紙娣诲姞鍗崇敤锛屾棤闇€鎵嬪姩璋冨弬锛夆攢鈹€鈹€
      const modelName = (fields.model_name || fields.name || "").toLowerCase();
      const REASONING_PATTERNS = [
        /\bdeepseek-r\b/, /\bdeepseek-reasoner\b/, /\bdeepseek-v4-pro\b/, /\bdeepseek-v4-flash\b/,
        /\bo1\b/, /\bo1-mini\b/, /\bo1-preview\b/, /\bo3\b/, /\bo3-mini\b/, /\bo4-mini\b/,
        /\bqwq\b/, /\bqwen-qwq\b/,
        /\bglm-5\b/, /\bglm-5\.1\b/, /\bglm-5\.2\b/,
        /\bgpt-5\.4-pro\b/, /\bgpt-5\.4\b/,
        /\bqwen3\b/,  // qwen3 绯诲垪鎺ㄧ悊妯″瀷
        /\bthink\b/, /\breasoning\b/, /\bthinker\b/,
      ];
      const isReasoningModel = REASONING_PATTERNS.some(p => p.test(modelName));

      // 鑷姩濉厖锛氬鏋滅敤鎴锋湭鎸囧畾锛屽垯鏍规嵁妯″瀷绫诲瀷璁剧疆鏈€浣抽粯璁ゅ€?
      const autoDeepThinkingType = fields.deep_thinking_type != null ? fields.deep_thinking_type : (isReasoningModel ? 2 : 0);
      const autoTimeout = fields.timeout != null && fields.timeout > 0 ? fields.timeout : (isReasoningModel ? 300 : 120);
      const autoMaxReplyTokens = fields.max_reply_tokens != null && fields.max_reply_tokens > 0 ? fields.max_reply_tokens : (isReasoningModel ? 65536 : 4096);
      const autoMaxContextTokens = fields.max_context_tokens != null && fields.max_context_tokens > 0 ? fields.max_context_tokens : 64000;
      const autoMaxContextRounds = fields.max_context_rounds != null && fields.max_context_rounds > 0 ? fields.max_context_rounds : 20;
      const autoDeductDeepThink = fields.deduct_deep_think != null ? fields.deduct_deep_think : (isReasoningModel ? 2 : 1);

      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "llm_models",
        changeNote: `新增对话模型 ${fields.model_name || fields.name}`,
        values: {
          name: fields.name,
          description: fields.description || "",
          category: fields.category || "閫氱敤",
          model_name: fields.model_name || fields.name,
          api_endpoint: fields.api_endpoint || "",
          api_key: fields.api_key || "",
          proxy_url: fields.api_endpoint || fields.proxy_url || "",
          billing_mode: "token",
          cost_per_use: 0,
          cost_price: 0,
          token_billing_enabled: true,
          input_cost_per_million: Number(fields.input_cost_per_million),
          output_cost_per_million: Number(fields.output_cost_per_million),
          cached_cost_per_million: Number(fields.cached_cost_per_million),
          profit_margin: Number(fields.profit_margin),
          token_rounding_unit: 0,
          max_context_rounds: autoMaxContextRounds,
          max_context_tokens: autoMaxContextTokens,
          max_reply_tokens: autoMaxReplyTokens,
          timeout: autoTimeout,
          enable_web_search: fields.enable_web_search || false,
          deep_thinking_type: autoDeepThinkingType,
          deduct_deep_think: autoDeductDeepThink,
          temperature: fields.temperature || null,
          response_format: fields.response_format || null,
          user_access: PENDING_TEXT_USER_ACCESS,
          is_active: false,
          is_hidden: false,
          sort_order: Number(fields.sort_order) || 0,
          admin_notes: fields.admin_notes || "",
          frequency_limit: Number(fields.frequency_limit) ?? 50,
          image_parsing: fields.image_parsing || "none",
          file_parsing: fields.file_parsing || "none",
          icon_url: fields.icon_url || "",
          api_protocol_config: textProtocolConfig,
        },
      });
      return NextResponse.json({ success: true, staged: true, published: false, result, model_type }, { status: 202 });

    } else if (model_type === "video") {
      // 鍐欏叆 video_models 琛?
      const generateModelId = (name: string, endpoint: string): string => {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        let platform = "";
        try {
          const host = new URL(endpoint).hostname;
          if (host.includes("yunwu")) platform = "ch1";
          else if (host.includes("vectorengine")) platform = "ch2";
          else if (host.includes("openclaw")) platform = "ch3";
          else if (host.includes("pro.nat6.net")) platform = "lc";
          else if (host.includes("secure-skill")) platform = "ssa";
          else if (host.includes("siliconflow")) platform = "sf";
          else platform = host.replace(/^api\./, "").split(".")[0];
        } catch { platform = "custom"; }
        return `${base}-${platform}`;
      };

      const usesAutodlH3Selfhost = fields.provider === AUTODL_H3_SELFHOST_PROVIDER
        || fields.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL;
      const protocolType = usesAutodlH3Selfhost
        ? AUTODL_H3_SELFHOST_PROTOCOL
        : String(fields.protocol_type || "").trim();
      const videoFields = protocolType === AUTODL_H3_SELFHOST_PROTOCOL
        ? normalizeAutodlH3SelfhostVideoFields(fields)
        : fields;
      if (!String(videoFields.name || videoFields.model_name || "").trim()
        || !String(videoFields.api_endpoint || "").trim()
        || !String(videoFields.api_key || "").trim()
        || !String(videoFields.provider || "").trim()
        || !protocolType) {
        return NextResponse.json({ error: "名称、模型名、渠道、接口协议、API地址和密钥为必填", code: "VIDEO_PROTOCOL_BINDING_REQUIRED" }, { status: 400 });
      }
      assertAdminAutodlH3SelfhostBinding("video", {
        ...videoFields,
        provider: videoFields.provider || protocolType,
      });
      const protocolConfig = protocolType === "autodl_comfyui_h3"
        ? autoDLH3ProtocolConfig(videoFields.api_protocol_config)
        : protocolType === AUTODL_H3_SELFHOST_PROTOCOL
          ? autoDLH3SelfhostProtocolConfig(videoFields.api_protocol_config)
          : (videoFields.api_protocol_config || {});
      const priceError = videoPriceConfigurationError({
        costPrice: videoFields.cost_price,
        sellingPrice: videoFields.cost_per_use ?? videoFields.price_per_use,
        protocolConfig,
      });
      if (priceError) return NextResponse.json({ error: priceError, code: "VIDEO_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
      const modelId = videoFields.id?.toString().startsWith("temp-")
        ? generateModelId(videoFields.model_name || videoFields.name, videoFields.api_endpoint || "")
        : (videoFields.id || generateModelId(videoFields.model_name || videoFields.name, videoFields.api_endpoint || ""));

      const pendingVideoRecord = forceNewVideoModelPending({
        id: modelId,
        name: videoFields.name,
        model_name: videoFields.model_name || videoFields.name,
        provider: videoFields.provider,
        admin_notes: videoFields.admin_notes || (protocolType === "autodl_comfyui_h3"
          ? AUTODL_H3_ADMIN_NOTES
          : protocolType === AUTODL_COMFYUI_WORKFLOW_PROTOCOL
            ? "AutoDL.Art 官方 ComfyUI 工作流；按 workflow_id 精确执行。"
          : protocolType === AUTODL_H3_SELFHOST_PROTOCOL ? AUTODL_H3_SELFHOST_ADMIN_NOTES : ""),
        api_endpoint: videoFields.api_endpoint || "",
        api_key: videoFields.api_key || "",
        protocol_type: protocolType,
        price_per_use: videoFields.cost_per_use != null
          ? Number(videoFields.cost_per_use) || 0
          : (protocolType === "autodl_comfyui_h3" ? 0.07 : protocolType === AUTODL_COMFYUI_WORKFLOW_PROTOCOL ? 0.01 : 0),
        cost_price: videoFields.cost_price != null
          ? Number(videoFields.cost_price) || 0
          : (protocolType === "autodl_comfyui_h3" ? 0.07 : protocolType === AUTODL_COMFYUI_WORKFLOW_PROTOCOL ? 0.01 : 0),
        currency: "CNY",
        duration_seconds: Number(videoFields.duration_seconds) || (protocolType === "autodl_comfyui_h3" || protocolType === AUTODL_H3_SELFHOST_PROTOCOL ? 10 : 5),
        max_duration: Number(videoFields.max_duration) || (protocolType === AUTODL_H3_SELFHOST_PROTOCOL || protocolType === AUTODL_COMFYUI_WORKFLOW_PROTOCOL ? 15 : 10),
        api_protocol_config: protocolConfig,
        supports_image_input: videoFields.supports_image_input !== false,
        requires_image: videoFields.requires_image === true,
        sort_order: Number(videoFields.sort_order) || 100,
      });
      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "video_models",
        id: String(modelId),
        values: pendingVideoRecord,
        changeNote: `新增视频模型 ${videoFields.model_name || videoFields.name}`,
      });
      return NextResponse.json({
        success: true,
        staged: true,
        published: false,
        result,
        model_type,
        detected_protocol: protocolType,
      }, { status: 202 });
    }

    return NextResponse.json({ error: "未知模型类型" }, { status: 400 });
  } catch (error) {
    if (error instanceof ModelActivationGateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof AutodlH3SelfhostConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[UnifiedModels] POST error:", error);
    return NextResponse.json({ error: "新增模型失败" }, { status: 500 });
  }
}

// PUT - 鏇存柊妯″瀷锛堟牴鎹?model_type 鏇存柊涓嶅悓琛級
export async function PUT(req: NextRequest) {
  const authorization = await authorizeModelWrite(req);
  if (!authorization.ok) return authorization.response;
  const admin = authorization.actor;

  try {
    const body = await req.json();
    const { model_type, id, ...fields } = body;
    delete fields.agent_id;
    delete fields.api_key_configured;
    const nextApiKey = replacementApiKey(fields.api_key);
    if (nextApiKey === undefined) delete fields.api_key;
    else fields.api_key = nextApiKey;

    if (!model_type || !id) {
      return NextResponse.json({ error: "缺少模型类型或ID" }, { status: 400 });
    }
    if (String(fields.provider || "") === RETIRED_MODEL_PROVIDER || isPermanentlyRetiredModel({ id, ...fields })) {
      return NextResponse.json({ error: "该模型或渠道已永久退役，不能恢复或修改", code: "MODEL_PERMANENTLY_RETIRED" }, { status: 409 });
    }

    const dbClient = getSupabaseClient();

    if (model_type === "drawing") {
      // 鏇存柊 cover_models
      const { data: currentDrawingModel, error: currentDrawingError } = await dbClient
        .from("cover_models")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (currentDrawingError) {
        return NextResponse.json({ error: currentDrawingError.message }, { status: 500 });
      }
      const drawingFields = currentDrawingModel?.provider === AUTODL_H3_SELFHOST_PROVIDER
        || fields.provider === AUTODL_H3_SELFHOST_PROVIDER
        ? normalizeAutodlH3SelfhostImageFields(fields, currentDrawingModel)
        : fields;
      assertAdminAutodlH3SelfhostBinding("drawing", {
        ...drawingFields,
        provider: drawingFields.provider || currentDrawingModel?.provider || "vectorengine",
      });
      try {
        resolveImageProviderContract({
          ...currentDrawingModel,
          ...drawingFields,
          api_protocol_config: drawingFields.api_protocol_config ?? currentDrawingModel?.api_protocol_config,
        });
      } catch (error) {
        if (error instanceof ImageProviderBindingError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
      const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const allowed = ["name", "model_name", "provider", "api_endpoint", "api_key", "cost_price", "selling_price", "is_active", "is_hidden", "supports_image_input", "api_protocol_config"];
      for (const f of allowed) {
        if (drawingFields[f] !== undefined) updateFields[f] = drawingFields[f];
      }
      // Map unified fields to cover_models fields
      if (drawingFields.cost_per_use !== undefined) updateFields.selling_price = drawingFields.cost_per_use;
      if (!currentDrawingModel) return NextResponse.json({ error: "模型不存在" }, { status: 404 });
      const pendingFields = pendingImageConfigurationUpdate(currentDrawingModel, updateFields);
      pendingFields.is_active = true;
      pendingFields.is_hidden = false;

      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "cover_models",
        id: String(id),
        values: pendingFields,
        changeNote: `修改生图模型 ${id}`,
      });
      return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });

    } else if (model_type === "text") {
      const { data: currentTextModel, error: currentTextError } = await dbClient
        .from("llm_models")
        .select("user_access,is_active,is_hidden,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,max_context_tokens,api_protocol_config")
        .eq("id", id)
        .maybeSingle();
      if (currentTextError) {
        return NextResponse.json({ error: currentTextError.message }, { status: 500 });
      }
      assertOrdinaryAdminUpdateDoesNotActivate(
        "text",
        id,
        currentTextModel?.user_access,
        fields,
      );
      assertAdminAutodlH3SelfhostBinding("text", fields);
      const tokenConfigurationError = textTokenConfigurationError({ ...currentTextModel, ...fields });
      if (tokenConfigurationError) {
        return NextResponse.json({ error: tokenConfigurationError, code: "TEXT_TOKEN_CONFIGURATION_REQUIRED" }, { status: 400 });
      }
      let textProtocolConfig: Record<string, unknown>;
      try {
        textProtocolConfig = canonicalLlmProtocolConfig({
          ...fields,
          api_protocol_config: fields.api_protocol_config ?? currentTextModel?.api_protocol_config,
        });
      } catch (error) {
        if (error instanceof LlmProviderBindingError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
        }
        throw error;
      }
      // 鈹€鈹€鈹€ 鑷姩妫€娴嬫帹鐞嗘ā鍨嬪苟琛ュ叏鍙傛暟 鈹€鈹€鈹€
      const modelName = (fields.model_name || fields.name || "").toLowerCase();
      const REASONING_PATTERNS = [
        /\bdeepseek-r\b/, /\bdeepseek-reasoner\b/, /\bdeepseek-v4-pro\b/, /\bdeepseek-v4-flash\b/,
        /\bo1\b/, /\bo1-mini\b/, /\bo1-preview\b/, /\bo3\b/, /\bo3-mini\b/, /\bo4-mini\b/,
        /\bqwq\b/, /\bqwen-qwq\b/,
        /\bglm-5\b/, /\bglm-5\.1\b/, /\bglm-5\.2\b/,
        /\bgpt-5\.4-pro\b/, /\bgpt-5\.4\b/,
        /\bqwen3\b/,
        /\bthink\b/, /\breasoning\b/, /\bthinker\b/,
      ];
      const isReasoningModel = REASONING_PATTERNS.some(p => p.test(modelName));

      // 濡傛灉model_name鍙樻洿浜嗕笖鐢ㄦ埛鏈墜鍔ㄦ寚瀹歞eep_thinking_type锛岃嚜鍔ㄦ帹鏂?
      if (fields.model_name !== undefined && fields.deep_thinking_type === undefined) {
        fields.deep_thinking_type = isReasoningModel ? 2 : 0;
      }
      if (fields.model_name !== undefined && fields.timeout === undefined) {
        fields.timeout = isReasoningModel ? 300 : 120;
      }
      if (fields.model_name !== undefined && fields.max_reply_tokens === undefined) {
        fields.max_reply_tokens = isReasoningModel ? 65536 : 4096;
      }
      if (fields.model_name !== undefined && fields.deduct_deep_think === undefined) {
        fields.deduct_deep_think = isReasoningModel ? 2 : 1;
      }

      // 鏇存柊 llm_models 棰勮琛?
      const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const allowed = [
        "name", "description", "category", "model_name", "api_endpoint", "api_key", "proxy_url",
        "billing_mode", "cost_per_use", "cost_price",
        "token_billing_enabled", "input_cost_per_million", "output_cost_per_million",
        "cached_cost_per_million", "profit_margin", "token_rounding_unit",
        "max_context_rounds", "max_context_tokens", "max_reply_tokens", "timeout",
        "enable_web_search", "deep_thinking_type", "deduct_deep_think",
        "temperature", "response_format", "user_access", "admin_notes",
        "is_active", "is_hidden", "sort_order",
        "frequency_limit", "image_parsing", "file_parsing", "icon_url",
        "api_protocol_config",
      ];
      // Map unified fields to llm_models fields
      if (fields.model_name !== undefined) updateFields.model_name = fields.model_name;
      if (fields.api_endpoint !== undefined) updateFields.api_endpoint = fields.api_endpoint;
      if (fields.api_endpoint !== undefined) updateFields.proxy_url = fields.api_endpoint;
      if (fields.api_key !== undefined) updateFields.api_key = fields.api_key;
      if (fields.cost_per_use !== undefined) updateFields.cost_per_use = fields.cost_per_use;
      if (fields.cost_price !== undefined) updateFields.cost_price = fields.cost_price;
      if (fields.billing_mode !== undefined) {
        updateFields.billing_mode = fields.billing_mode;
        updateFields.token_billing_enabled = fields.billing_mode === "token";
      }

      for (const f of allowed) {
        if (fields[f] !== undefined) updateFields[f] = fields[f];
      }
      if (currentTextModel?.user_access === PENDING_TEXT_USER_ACCESS) updateFields.user_access = "available";
      updateFields.billing_mode = "token";
      updateFields.token_billing_enabled = true;
      updateFields.cost_per_use = 0;
      updateFields.cost_price = 0;
      updateFields.token_rounding_unit = 0;
      updateFields.is_active = true;
      updateFields.is_hidden = false;
      updateFields.user_access = "available";
      updateFields.api_protocol_config = textProtocolConfig;

      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "llm_models",
        id: String(id),
        values: updateFields,
        changeNote: `修改对话模型 ${id}`,
      });
      return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });

    } else if (model_type === "video") {
      // 鏇存柊 video_models
      const { data: currentVideoModel, error: currentVideoError } = await dbClient
        .from("video_models")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (currentVideoError) {
        return NextResponse.json({ error: currentVideoError.message }, { status: 500 });
      }
      if (!currentVideoModel) return NextResponse.json({ error: "视频模型不存在" }, { status: 404 });
      const usesAutodlH3Selfhost = currentVideoModel?.provider === AUTODL_H3_SELFHOST_PROVIDER
        || currentVideoModel?.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL
        || fields.provider === AUTODL_H3_SELFHOST_PROVIDER
        || fields.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL;
      const videoFields = usesAutodlH3Selfhost
        ? normalizeAutodlH3SelfhostVideoFields(fields, currentVideoModel)
        : fields;
      const effectiveProvider = String(videoFields.provider || currentVideoModel.provider || "").trim();
      const effectiveProtocol = String(videoFields.protocol_type || currentVideoModel.protocol_type || "").trim();
      if (!effectiveProvider || !effectiveProtocol) {
        return NextResponse.json({ error: "视频模型必须显式绑定渠道和接口协议", code: "VIDEO_PROTOCOL_BINDING_REQUIRED" }, { status: 400 });
      }
      assertAdminAutodlH3SelfhostBinding("video", {
        ...currentVideoModel,
        ...videoFields,
        provider: videoFields.provider || currentVideoModel?.provider || videoFields.protocol_type,
        protocol_type: videoFields.protocol_type || currentVideoModel?.protocol_type,
      });
      const updateFields: Record<string, unknown> = {};
      const allowed = [
        "name", "model_name", "provider", "admin_notes", "api_endpoint", "api_key", "protocol_type",
        "price_per_use", "cost_price", "duration_seconds", "max_duration",
        "api_protocol_config", "supports_image_input", "is_active", "is_hidden", "sort_order",
        "requires_image",
      ];
      // Map unified fields
      if (videoFields.cost_per_use !== undefined) updateFields.price_per_use = videoFields.cost_per_use;

      for (const f of allowed) {
        if (videoFields[f] !== undefined) updateFields[f] = videoFields[f];
      }
      if (videoFields.api_protocol_config !== undefined) {
        updateFields.api_protocol_config = preservePersistedVideoActivationGate(
          currentVideoModel?.api_protocol_config,
          videoFields.api_protocol_config,
        );
      }

      const basePriceChanged = videoFields.cost_price !== undefined
        && Number(videoFields.cost_price) !== Number(currentVideoModel.cost_price)
        || videoFields.cost_per_use !== undefined
        && Number(videoFields.cost_per_use) !== Number(currentVideoModel.price_per_use)
        || videoFields.price_per_use !== undefined
        && Number(videoFields.price_per_use) !== Number(currentVideoModel.price_per_use);
      const tierPricesChanged = videoFields.api_protocol_config !== undefined
        && JSON.stringify((videoFields.api_protocol_config as Record<string, unknown>)?.resolution_cost_prices || {})
          !== JSON.stringify((currentVideoModel.api_protocol_config as Record<string, unknown> | undefined)?.resolution_cost_prices || {})
        || videoFields.api_protocol_config !== undefined
        && JSON.stringify((videoFields.api_protocol_config as Record<string, unknown>)?.resolution_prices || {})
          !== JSON.stringify((currentVideoModel.api_protocol_config as Record<string, unknown> | undefined)?.resolution_prices || {});
      if (basePriceChanged || tierPricesChanged) {
        const priceError = videoPriceConfigurationError({
          costPrice: videoFields.cost_price ?? currentVideoModel.cost_price,
          sellingPrice: videoFields.cost_per_use ?? videoFields.price_per_use ?? currentVideoModel.price_per_use,
          protocolConfig: videoFields.api_protocol_config ?? currentVideoModel.api_protocol_config,
        });
        if (priceError) return NextResponse.json({ error: priceError, code: "VIDEO_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
      }

      if (updateFields.protocol_type === "autodl_comfyui_h3" || videoFields.protocol_type === "autodl_comfyui_h3") {
        updateFields.api_protocol_config = autoDLH3ProtocolConfig(updateFields.api_protocol_config ?? videoFields.api_protocol_config);
      }
      if (usesAutodlH3Selfhost) {
        updateFields.api_protocol_config = autoDLH3SelfhostProtocolConfig(updateFields.api_protocol_config ?? videoFields.api_protocol_config);
      }

      updateFields.is_active = true;
      updateFields.is_hidden = false;

      Object.assign(updateFields, prepareVideoModelBindingUpdate({ id, ...currentVideoModel }, updateFields));

      const result = await stageLegacyModelPoolUpsert({
        actorId: admin.userId,
        table: "video_models",
        id: String(id),
        values: updateFields,
        changeNote: `修改视频模型 ${id}`,
      });
      return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
    }

    return NextResponse.json({ error: "未知模型类型" }, { status: 400 });
  } catch (error) {
    if (error instanceof ModelActivationGateError || error instanceof ImageAdminValidationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof AutodlH3SelfhostConfigError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[UnifiedModels] PUT error:", error);
    return NextResponse.json({ error: "更新模型失败" }, { status: 500 });
  }
}

// DELETE - 鍒犻櫎妯″瀷锛堟牴鎹?model_type 鍒犻櫎涓嶅悓琛級
export async function DELETE(req: NextRequest) {
  const authorization = await authorizeModelWrite(req);
  if (!authorization.ok) return authorization.response;
  const admin = authorization.actor;

  try {
    const url = new URL(req.url);
    const modelType = url.searchParams.get("model_type");
    const id = url.searchParams.get("id");
    if (!modelType || !id) {
      return NextResponse.json({ error: "缺少模型类型或ID" }, { status: 400 });
    }

    if (modelType !== "drawing" && modelType !== "text" && modelType !== "video") {
      return NextResponse.json({ error: "未知模型类型" }, { status: 400 });
    }
    const table: LegacyModelTable = modelType === "drawing" ? "cover_models" : modelType === "text" ? "llm_models" : "video_models";
    const result = await stageLegacyModelPoolCatalogState({
      actorId: admin.userId,
      table,
      id,
      catalogState: "retired",
      changeNote: `退役${modelType}模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, deleted: false, retiredCandidate: true, result }, { status: 202 });
  } catch (error) {
    console.error("[UnifiedModels] DELETE error:", error);
    return NextResponse.json({ error: "删除模型失败" }, { status: 500 });
  }
}

// PATCH - 鎵归噺鏇存柊鎺掑簭锛堟嫋鎷芥帓搴忥級
export async function PATCH(req: NextRequest) {
  const authorization = await authorizeModelWrite(req);
  if (!authorization.ok) return authorization.response;
  const admin = authorization.actor;

  try {
    const body = await req.json();
    const { model_type, orders } = body as {
      model_type: string;
      surface?: string;
      orders: Array<{ id: string; sort_order: number }>;
    };

    if (!model_type || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    const surface = model_type === "video"
      ? normalizeVideoModelOrderSurface(body.surface)
      : null;

    if (model_type === "video" && body.surface !== undefined && !surface) {
      return NextResponse.json({ error: "未知视频工作台排序场景" }, { status: 400 });
    }

    if (surface) {
      const orderedModelIds = orders.map((item) => String(item.id || "").trim()).filter(Boolean);
      if (orderedModelIds.length !== orders.length || new Set(orderedModelIds).size !== orderedModelIds.length) {
        return NextResponse.json({ error: "排序列表包含无效模型" }, { status: 400 });
      }
      const workspaceSurface = ({
        "ai-video": "video-page",
        storyboard: "storyboard-video",
        "free-canvas": "free-canvas-video",
        "film-studio": "film-studio-video",
        "commerce-agent": "commerce-video",
      } as const)[surface];
      const result = await stageLegacyWorkspaceMutation({
        actorId: admin.userId,
        mutation: { action: "reorder", surface: workspaceSurface, orderedModelIds },
        changeNote: `${workspaceSurface} 模型排序`,
      });
      return NextResponse.json({ success: true, staged: true, published: false, updated: orders.length, surface, workspace_surface: workspaceSurface, result }, { status: 202 });
    }

    const table = model_type === "drawing" ? "cover_models" : model_type === "text" ? "llm_models" : model_type === "video" ? "video_models" : null;

    if (!table) {
      return NextResponse.json({ error: "未知模型类型" }, { status: 400 });
    }

    const expected = new Map(orders.map((item) => [String(item.id), Number(item.sort_order)]));
    if (expected.size !== orders.length) {
      return NextResponse.json({ error: "排序列表包含重复模型", code: "MODEL_SORT_DUPLICATE_ID" }, { status: 400 });
    }
    const result = await stageLegacyModelPoolOrder({
      actorId: admin.userId,
      table: table as LegacyModelTable,
      orders: [...expected].map(([id, sortOrder]) => ({ id, sortOrder })),
      changeNote: `${model_type} 模型池排序`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, updated: orders.length, result }, { status: 202 });
  } catch (error) {
    console.error("[UnifiedModels] PATCH error:", error);
    return NextResponse.json({ error: "批量排序失败" }, { status: 500 });
  }
}
