import { getSupabaseClient } from "@/storage/database/supabase-client";
import { readImagePublicationStates } from "@/lib/image-model-availability";
import { cleanImageModelText, publicImageModelCapabilities } from "@/lib/image-admin-validation";
import { NextResponse } from "next/server";
import { publicMediaBillingCapabilities, toPublicModelDto } from "@/lib/public-model-dto";
import { publicImageResolutionPrices, resolveImageResolutionPrice } from "@/lib/image-resolution-pricing";
import { ImageProviderBindingError, resolveImageProviderContract } from "@/lib/image-provider-contract";
import {
  AUTODL_H3_SELFHOST_IMAGE_VERIFIED_ASPECT_RATIOS,
  AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES,
  AUTODL_H3_SELFHOST_IMAGE_VERIFIED_REQUEST_PIXEL_SIZES,
  AUTODL_H3_SELFHOST_IMAGE_VERIFIED_RESOLUTION,
  AUTODL_H3_SELFHOST_PROVIDER,
} from "@/lib/autodl-h3-selfhost";
import {
  IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY,
  imageModelSurfaceSortOrder,
  normalizeImageModelOrderSurface,
  parseImageModelSurfaceOrders,
} from "@/lib/image-model-surface-order";
import {
  configuredAspectRatios,
  imageWorkspaceSurfaceFromRequest,
} from "@/lib/workspace-model-policy";
import {
  WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY,
  isWorkspaceModelAssigned,
  parseWorkspaceModelAssignmentOverrides,
} from "@/lib/workspace-model-assignment-settings";
// 公共接口 — 获取可用封面模型列表（不含密钥）
export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };

function publicImageReferenceRequirement(model: Record<string, unknown>) {
  try {
    const requiresImage = resolveImageProviderContract(model).requestProtocol === "images_edits";
    return { requiresImage, minReferenceImages: requiresImage ? 1 : 0 };
  } catch (error) {
    // An unbound catalog entry remains visible; its existing admission state
    // still controls generation. Do not infer an input contract from its name.
    if (error instanceof ImageProviderBindingError) return { requiresImage: false, minReferenceImages: 0 };
    throw error;
  }
}

function imageProtocolConfig(model: Record<string, unknown>): Record<string, unknown> {
  return model.api_protocol_config && typeof model.api_protocol_config === "object" && !Array.isArray(model.api_protocol_config)
    ? model.api_protocol_config as Record<string, unknown>
    : {};
}

function disabledImageModelMessage(model: Record<string, unknown>): string {
  const config = imageProtocolConfig(model);
  const publicReason = String(config.public_unavailable_reason || "").trim().replace(/\s+/gu, " ");
  // Public reasons are useful only when they are actionable and cannot carry
  // endpoints, credentials, stack traces, or provider response payloads.
  if (publicReason.length >= 4
    && publicReason.length <= 160
    && /^[\p{Script=Han}0-9\s，。；：、（）()“”‘’·+-]+$/u.test(publicReason)) {
    return publicReason;
  }
  const code = String(config.public_availability_code || "").toLowerCase();
  if (code === "upstream_account_unavailable") return "上游账户异常";
  if (code === "upstream_channel_unavailable") return "上游通道异常";
  // Provider and validation diagnostics belong to the administrator catalog.
  // The public workbench only needs a stable, non-technical availability label.
  return "当前未开放";
}

function publicImageFamily(model: Record<string, unknown>): "gpt" | "gemini" | "qwen" | "other" {
  const identity = [model.name, model.model_name, model.provider]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/gpt[\s_-]*image|openai[\s_-]*gpt[\s_-]*image/u.test(identity)) return "gpt";
  if (/gemini|google[\s_-]*image|nano[\s_-]*banana|imagen/u.test(identity)) return "gemini";
  if (/qwen[\s_-]*image/u.test(identity)) return "qwen";
  return "other";
}

function publicImageCatalogPriority(model: Record<string, unknown>): number {
  const identity = [model.name, model.model_name, model.provider]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/gpt[\s_-]*image|openai[\s_-]*gpt[\s_-]*image/u.test(identity)) return 0;
  if (/nano[\s_-]*banana/u.test(identity)) return 1;
  if (/gemini|google[\s_-]*image|imagen/u.test(identity)) return 2;
  if (/seedream|豆包/u.test(identity)) return 3;
  if (/qwen[\s_-]*image/u.test(identity)) return 4;
  return 5;
}

export async function GET(request: Request) {
  try {
    const surface = new URL(request.url).searchParams.get("surface");
    const includeAutodlH3Selfhost = surface === "image-workbench"
      || surface === "storyboard-workbench";
    const commerceCatalog = surface === "commerce-agent";
    const dbClient = getSupabaseClient();
    const requestedWorkspaceSurface = imageWorkspaceSurfaceFromRequest(surface);
    const orderSurface = normalizeImageModelOrderSurface(surface);
    const [publicationStates, configuredRowsResult, orderResult, assignmentResult] = await Promise.all([
      readImagePublicationStates(dbClient),
      // Publication RPCs intentionally protect generation admission and may
      // omit inactive rows. Read the non-secret catalog columns separately so
      // paused, non-hidden models can remain discoverable as disabled cards.
      dbClient.from("cover_models")
        .select("id,name,model_name,provider,cost_price,selling_price,is_active,is_hidden,supports_image_input,sort_order")
        .eq("is_hidden", false)
        .order("sort_order", { ascending: true }),
      requestedWorkspaceSurface
        ? dbClient.from("platform_settings").select("setting_value").eq("setting_key", IMAGE_MODEL_SURFACE_ORDER_SETTING_KEY).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      requestedWorkspaceSurface
        ? dbClient.from("platform_settings").select("setting_value").eq("setting_key", WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (configuredRowsResult.error) throw new Error("图片模型目录暂不可读取");
    if (orderResult.error || assignmentResult.error) throw new Error("图片工作台配置暂不可读取");
    const surfaceOrders = parseImageModelSurfaceOrders(orderResult.data?.setting_value);
    const assignmentOverrides = parseWorkspaceModelAssignmentOverrides(assignmentResult.data?.setting_value);
    const publicationById = new Map(publicationStates.map(entry => [String(entry.model.id || ""), entry]));
    const configuredModels = ((configuredRowsResult.data || []) as Record<string, unknown>[])
      .map((model): Record<string, unknown> => publicationById.get(String(model.id || ""))?.model || model)
      .filter(model => includeAutodlH3Selfhost || model.provider !== AUTODL_H3_SELFHOST_PROVIDER)
      .filter(model => {
        // General creation workbenches expose the complete configured catalog.
        // Workspace assignment is an administrator organization aid, not a
        // prerequisite for users to discover an otherwise configured model.
        if (commerceCatalog) return true;
        if (requestedWorkspaceSurface) return isWorkspaceModelAssigned(
          assignmentOverrides,
          "image",
          model,
          requestedWorkspaceSurface,
        );
        // 工作面分发：显式配置了 workspace_surfaces 的模型只在所属工作面出现；未配置的保持全可见（兼容旧数据）。
        const cfgSurfaces = (model.api_protocol_config && Array.isArray((model.api_protocol_config as Record<string, unknown>).workspace_surfaces))
          ? ((model.api_protocol_config as Record<string, unknown>).workspace_surfaces as unknown[]).map(String)
          : null;
        if (!surface || !cfgSurfaces || cfgSurfaces.length === 0) return true;
        const normalizedSurface = surface === "storyboard" ? "storyboard-workbench" : surface;
        return cfgSurfaces.includes(normalizedSurface) || cfgSurfaces.includes(surface);
      })
      .map((model): Record<string, unknown> => ({ ...model, name: cleanImageModelText(model, model.name), model_name: cleanImageModelText(model, model.model_name), ...publicImageModelCapabilities(model) }))
      .sort((left, right) => {
        const priorityDifference = publicImageCatalogPriority(left) - publicImageCatalogPriority(right);
        // Cover's dropdown follows the administrator's workspace order. Other
        // image workbenches keep their existing family-grouped presentation.
        if (orderSurface !== "cover-studio" && priorityDifference !== 0) return priorityDifference;
        const leftSurfaceOrder = requestedWorkspaceSurface ? imageModelSurfaceSortOrder(surfaceOrders, orderSurface, left.id) : null;
        const rightSurfaceOrder = requestedWorkspaceSurface ? imageModelSurfaceSortOrder(surfaceOrders, orderSurface, right.id) : null;
        if ((leftSurfaceOrder !== null) !== (rightSurfaceOrder !== null)) return leftSurfaceOrder !== null ? -1 : 1;
        if (leftSurfaceOrder !== null && rightSurfaceOrder !== null && leftSurfaceOrder !== rightSurfaceOrder) return leftSurfaceOrder - rightSurfaceOrder;
        if (priorityDifference !== 0) return priorityDifference;
        return Number((left as { sort_order?: unknown }).sort_order || 0) - Number((right as { sort_order?: unknown }).sort_order || 0)
          || String(left.id || '').localeCompare(String(right.id || ''));
      });
    const models = configuredModels
      .map((model: Record<string, unknown>, index: number) => {
        const publicationState = publicationById.get(String(model.id || ""));
        const defaultResolution = model.provider === AUTODL_H3_SELFHOST_PROVIDER
          ? AUTODL_H3_SELFHOST_IMAGE_VERIFIED_RESOLUTION
          : String(model.defaultResolution || "1K");
        const costPrice = resolveImageResolutionPrice(model, defaultResolution, "cost");
        const sellingPrice = resolveImageResolutionPrice(model, defaultResolution, "selling");
        const priceReady = Number.isFinite(costPrice) && costPrice >= 0
          && Number.isFinite(sellingPrice) && sellingPrice >= 0;
        return toPublicModelDto("cover", {
          ...model,
          // The cover UI charges the default resolution. Project that exact
          // verified public price instead of a possibly unrelated base price.
          selling_price: Number.isFinite(sellingPrice) ? sellingPrice : model.selling_price,
        }, index, {
        type: "image",
        ...publicMediaBillingCapabilities("per_use"),
        family: publicImageFamily(model),
        admission: publicationState?.admission || 'pending',
        available: priceReady && publicationState?.available === true,
        priceReady,
        availabilityMessage: !priceReady
          ? "当前未开放"
            : model.is_active !== true
              ? disabledImageModelMessage(model)
              : publicationState?.configured !== true
                ? "当前未开放"
              : "",
        supportsImageInput: Boolean(model.supports_image_input),
        ...publicImageReferenceRequirement(model),
        resolutionOptions: model.provider === AUTODL_H3_SELFHOST_PROVIDER
          ? [AUTODL_H3_SELFHOST_IMAGE_VERIFIED_RESOLUTION]
          : (Array.isArray(model.resolutionOptions) ? model.resolutionOptions as string[] : []),
        defaultResolution,
        aspectRatios: configuredAspectRatios(imageProtocolConfig(model)).filter((ratio) => {
          if (!/^\d+:\d+$/u.test(ratio)) return false;
          return ratio.split(":").map(Number).every((value) => Number.isSafeInteger(value) && value > 0);
        }),
        supportsReferenceInput: Boolean(model.supportsReferenceInput),
        referenceInputMode: String(model.referenceInputMode || "none"),
        identityReferenceLevel: String(model.identityReferenceLevel || "none"),
        maxReferenceImages: Number(model.maxReferenceImages) || 0,
        maxCharacterReferences: Number(model.maxCharacterReferences) || 0,
        referenceCapabilityLabel: String(model.referenceCapabilityLabel || "仅文本生图"),
        resolutionPrices: publicImageResolutionPrices(model),
        ...(model.provider === AUTODL_H3_SELFHOST_PROVIDER
          ? {
              aspectRatios: [...AUTODL_H3_SELFHOST_IMAGE_VERIFIED_ASPECT_RATIOS],
              requestPixelSizes: Object.entries(AUTODL_H3_SELFHOST_IMAGE_VERIFIED_REQUEST_PIXEL_SIZES)
                .map(([aspectRatio, size]) => `${aspectRatio}=${size}`),
              verifiedOutputPixelSizes: Object.entries(AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES)
                .map(([aspectRatio, size]) => `${aspectRatio}=${size}`),
            }
          : {}),
        });
      });
    return NextResponse.json({ models }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[CoverModels/Public] GET error:", error);
    return NextResponse.json({
      error: "封面模型目录暂时不可用，请稍后刷新",
      code: "IMAGE_MODEL_CATALOG_UNAVAILABLE",
      models: [],
    }, { status: 503, headers: noStoreHeaders });
  }
}
