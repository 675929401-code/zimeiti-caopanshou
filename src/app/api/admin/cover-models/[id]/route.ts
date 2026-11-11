import { modelPoolMutationRequest, modelPoolMutationFailure, resumeModelPoolMutationResponse } from "@/lib/server/model-pool-mutation-http";
import { invalidExplicitPriceField } from "@/lib/model-price-rounding";
import { imageModelAdminMetadata } from "@/lib/image-model-admin-fields";
import { pendingImageConfigurationUpdate } from "@/lib/image-model-availability";
import { ImageAdminValidationError } from "@/lib/image-admin-validation";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  ModelActivationGateError,
} from "@/lib/model-activation-gate";
import {
  stageLegacyModelPoolCatalogState,
  stageLegacyModelPoolUpsert,
} from "@/lib/server/platform-configuration-compatibility";
import { ImageProviderBindingError, resolveImageProviderContract } from "@/lib/image-provider-contract";

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

// 管理后台 — 封面模型单项操作
// GET: 读取单个封面模型（只回 api_key_configured 与 updated_at，不回密钥本体）
// PUT: 更新封面模型
// DELETE: 删除封面模型（软删除）

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.slice(7);
    const payload = token ? await verifyAdminToken(token) : null;
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const dbClient = getSupabaseClient();
    const { data, error } = await dbClient.from("cover_models").select("*").eq("id", id).maybeSingle();
    if (error) return NextResponse.json({ error: "当前模型配置不可读取" }, { status: 503 });
    if (!data || data.provider === "retired_configuration") {
      return NextResponse.json({ error: "封面模型不存在" }, { status: 404 });
    }
    return NextResponse.json(
      { model: publicModel(data as Record<string, unknown>) },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("[CoverModels] GET detail error:", error);
    return NextResponse.json({ error: "获取封面模型失败" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.slice(7);
    const payload = token ? await verifyAdminToken(token) : null;
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const body = await request.json();
    const mutationRequest = modelPoolMutationRequest(request, body, id);
    const resumedMutation = await resumeModelPoolMutationResponse(payload.userId, mutationRequest);
    if (resumedMutation) return resumedMutation;
    if (invalidExplicitPriceField(body, ["cost_price", "selling_price"])) {
      return NextResponse.json({ error: "填写的成本或售价必须是明确的非负金额", code: "IMAGE_PRICE_CONFIGURATION_REQUIRED" }, { status: 400 });
    }
    const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() };

    // 只更新传来的字段
    const allowedFields = [
      "name",
      "model_name",
      "provider",
      "api_endpoint",
      "api_key",
      "cost_price",
      "selling_price",
      "is_active",
      "is_hidden",
      "supports_image_input",
      "api_protocol_config",
    ];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateFields[field] = body[field];
      }
    }
    const nextApiKey = replacementApiKey(body.api_key);
    if (nextApiKey === undefined) delete updateFields.api_key;
    else updateFields.api_key = nextApiKey;

    const dbClient = getSupabaseClient();
    const current = await dbClient.from("cover_models").select("*").eq("id", id).maybeSingle();
    if (current.error || !current.data) return NextResponse.json({ error: "当前模型配置不可读取" }, { status: 503 });
    if (current.data.provider === "retired_configuration" || body.provider === "retired_configuration") {
      return NextResponse.json({ error: "模型退役只能使用删除操作", code: "MODEL_RETIREMENT_DELETE_ONLY" }, { status: 409 });
    }
    const metadata = imageModelAdminMetadata(body, current.data.api_protocol_config);
    if (!metadata.ok) return NextResponse.json({ error: metadata.error, code: metadata.code }, { status: 400 });
    Object.assign(updateFields, metadata.fields);
    try {
      resolveImageProviderContract({
        ...current.data,
        ...updateFields,
        api_protocol_config: updateFields.api_protocol_config ?? current.data.api_protocol_config,
      });
    } catch (error) {
      if (error instanceof ImageProviderBindingError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      throw error;
    }
    const pendingFields = pendingImageConfigurationUpdate(current.data, updateFields);
    pendingFields.is_active = true;
    pendingFields.is_hidden = false;
    const result = await stageLegacyModelPoolUpsert({
        ...mutationRequest,
      actorId: payload.userId,
      table: "cover_models",
      id,
      values: pendingFields,
      changeNote: `修改生图模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    if (error instanceof ModelActivationGateError || error instanceof ImageAdminValidationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[CoverModels] PUT error:", error);
    return NextResponse.json({ error: "更新封面模型失败" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get("authorization");
    const token = authHeader?.slice(7);
    const payload = token ? await verifyAdminToken(token) : null;
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    const result = await stageLegacyModelPoolCatalogState({
      actorId: payload.userId,
      table: "cover_models",
      id,
      catalogState: "retired",
      changeNote: `退役生图模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, action: "retirement_candidate", result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("[CoverModels] DELETE error:", error);
    return NextResponse.json({ error: "删除封面模型失败" }, { status: 500 });
  }
}
