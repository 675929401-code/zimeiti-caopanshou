import { modelPoolMutationRequest, modelPoolMutationFailure, resumeModelPoolMutationResponse } from "@/lib/server/model-pool-mutation-http";
/**
 * 管理员对话模型管理 API
 * GET  - 列出所有对话模型（含未激活）
 * POST - 新增对话模型
 * PUT  - 更新对话模型
 * DELETE - 删除对话模型
 */
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  stageLegacyModelPoolCatalogState,
  stageLegacyModelPoolUpsert,
} from "@/lib/server/platform-configuration-compatibility";

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

async function requireAdmin(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.slice(7);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// GET - 列出所有对话模型（含未激活）
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  try {
    const supabase = getSupabaseClient();
    const { data: models, error } = await supabase
      .from("chat_models")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("Failed to fetch chat models:", error);
      return NextResponse.json({ error: "获取模型列表失败" }, { status: 500 });
    }

    return NextResponse.json({ models: (models || []).map(publicModel) });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("Error fetching chat models:", error);
    return NextResponse.json({ error: "获取模型列表失败" }, { status: 500 });
  }
}

// POST - 新增对话模型
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  try {
    const body = await req.json();
    const mutationRequest = modelPoolMutationRequest(req, body);
    const resumedMutation = await resumeModelPoolMutationResponse(admin.userId, mutationRequest);
    if (resumedMutation) return resumedMutation;
    const { model_name, display_name, icon_url, description, proxy_url, api_key, sort_order } = body;

    if (!model_name || !display_name) {
      return NextResponse.json({ error: "模型名称和显示名称不能为空" }, { status: 400 });
    }

    // 检查模型名是否重复
    const supabase = getSupabaseClient();
    const { data: existing } = await supabase
      .from("chat_models")
      .select("id")
      .eq("model_name", model_name)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ error: "模型名称已存在" }, { status: 409 });
    }

    const result = await stageLegacyModelPoolUpsert({
        ...mutationRequest,
      actorId: admin.userId,
      table: "chat_models",
      changeNote: `新增旧版对话模型 ${model_name}`,
      values: {
        model_name,
        display_name,
        icon_url: icon_url || "",
        description: description || "",
        proxy_url: proxy_url || "",
        api_key: api_key || "",
        is_active: true,
        sort_order: sort_order || 0,
      },
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("Error creating chat model:", error);
    return NextResponse.json({ error: "创建模型失败" }, { status: 500 });
  }
}

// PUT - 更新对话模型
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  try {
    const body = await req.json();
    const mutationRequest = modelPoolMutationRequest(req, body);
    const resumedMutation = await resumeModelPoolMutationResponse(admin.userId, mutationRequest);
    if (resumedMutation) return resumedMutation;
    const { id, model_name, display_name, icon_url, description, proxy_url, api_key, sort_order } = body;

    if (!id) {
      return NextResponse.json({ error: "缺少模型ID" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (model_name !== undefined) updateData.model_name = model_name;
    if (display_name !== undefined) updateData.display_name = display_name;
    if (icon_url !== undefined) updateData.icon_url = icon_url;
    if (description !== undefined) updateData.description = description;
    if (proxy_url !== undefined) updateData.proxy_url = proxy_url;
    const nextApiKey = replacementApiKey(api_key);
    if (nextApiKey !== undefined) updateData.api_key = nextApiKey;
    updateData.is_active = true;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    const result = await stageLegacyModelPoolUpsert({
        ...mutationRequest,
      actorId: admin.userId,
      table: "chat_models",
      id: String(id),
      values: updateData,
      changeNote: `修改旧版对话模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("Error updating chat model:", error);
    return NextResponse.json({ error: "更新模型失败" }, { status: 500 });
  }
}

// DELETE - 删除对话模型
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "缺少模型ID" }, { status: 400 });
    }

    const result = await stageLegacyModelPoolCatalogState({
      actorId: admin.userId,
      table: "chat_models",
      id,
      catalogState: "retired",
      changeNote: `退役旧版对话模型 ${id}`,
    });
    return NextResponse.json({ success: true, staged: true, published: false, result }, { status: 202 });
  } catch (error) {
    const configurationFailure = modelPoolMutationFailure(error);
    if (configurationFailure) return configurationFailure;
    console.error("Error deleting chat model:", error);
    return NextResponse.json({ error: "删除模型失败" }, { status: 500 });
  }
}
