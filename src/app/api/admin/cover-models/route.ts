import { modelPoolMutationRequest, modelPoolMutationFailure, resumeModelPoolMutationResponse } from "@/lib/server/model-pool-mutation-http";
import { explicitNonNegativePrice } from "@/lib/model-price-rounding";
import { imageModelAdminMetadata } from "@/lib/image-model-admin-fields";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { newPendingImageModelId } from "@/lib/model-activation-gate";
import { stageLegacyModelPoolUpsert } from "@/lib/server/platform-configuration-compatibility";
import { ImageProviderBindingError, resolveImageProviderContract } from "@/lib/image-provider-contract";

function publicModel<T extends Record<string, unknown>>(model: T): Omit<T, "api_key"> & { api_key_configured: boolean } {
  const { api_key, ...safe } = model;
  return { ...safe, api_key_configured: Boolean(String(api_key || "").trim()) };
}

// 管理后台 — 封面模型管理
// GET: 列出所有封面模型
// POST: 新增封面模型

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.slice(7);
    const payload = token ? await verifyAdminToken(token) : null;
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const dbClient = getSupabaseClient();
    const { data, error } = await dbClient
      .from("cover_models")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ models: (data || []).filter((model: Record<string, unknown>) => model.provider !== "retired_configuration").map(publicModel) });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("[CoverModels] GET error:", error);
    return NextResponse.json({ error: "获取封面模型失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.slice(7);
    const payload = token ? await verifyAdminToken(token) : null;
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const body = await request.json();
    const mutationRequest = modelPoolMutationRequest(request, body);
    const resumedMutation = await resumeModelPoolMutationResponse(payload.userId, mutationRequest);
    if (resumedMutation) return resumedMutation;
    const { name, model_name, provider, api_endpoint, api_key, cost_price, selling_price, supports_image_input, api_protocol_config } = body as {
      name: string;
      model_name: string;
      provider?: string;
      api_endpoint: string;
      api_key: string;
      cost_price?: number;
      selling_price?: number;
      supports_image_input?: boolean;
      api_protocol_config?: Record<string, unknown>;
    };

    if (!name || !model_name || !api_endpoint || !api_key) {
      return NextResponse.json({ error: "名称、模型名、API地址和密钥为必填" }, { status: 400 });
    }
    if (provider === "retired_configuration") {
      return NextResponse.json({ error: "退役记录只能通过删除接口管理" }, { status: 400 });
    }
    try {
      resolveImageProviderContract({
        provider,
        model_name,
        api_endpoint,
        supports_image_input,
        api_protocol_config,
      });
    } catch (error) {
      if (error instanceof ImageProviderBindingError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      throw error;
    }

    const id = newPendingImageModelId();
    if (explicitNonNegativePrice(cost_price) === null || explicitNonNegativePrice(selling_price) === null) {
      return NextResponse.json({ error: "请填写明确的非负生图成本与售价", code: "IMAGE_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
    }
    const metadata = imageModelAdminMetadata(body);
    if (!metadata.ok) return NextResponse.json({ error: metadata.error, code: metadata.code }, { status: 400 });
    const result = await stageLegacyModelPoolUpsert({
        ...mutationRequest,
      actorId: payload.userId,
      table: "cover_models",
      id,
      changeNote: `新增生图模型 ${model_name}`,
      values: {
        id,
        name,
        model_name,
        provider: provider || "vectorengine",
        api_endpoint,
        api_key,
        cost_price: Number(cost_price),
        selling_price: Number(selling_price),
        is_active: true,
        is_hidden: false,
        supports_image_input: supports_image_input || false,
        api_protocol_config,
        ...metadata.fields,
      },
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("[CoverModels] POST error:", error);
    return NextResponse.json({ error: "新增封面模型失败" }, { status: 500 });
  }
}
