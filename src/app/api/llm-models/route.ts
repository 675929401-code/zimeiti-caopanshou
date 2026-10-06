/**
 * LLM 模型预设列表 API（公共）
 * GET - 列出所有活跃的 LLM 模型预设，供智能体创建/编辑表单选择
 */
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { toPublicModelDto, type PublicModelDto } from "@/lib/public-model-dto";
import { isPublishedTextModelEligible } from "@/lib/text-model-eligibility";
import { publicTextModelBillingCapabilities } from "@/lib/text-model-pricing";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(request: Request) {
  try {
    // The default catalog is always the public, sanitized DTO, including when
    // the caller happens to hold an administrator session. Private model
    // configuration is an explicit control-plane operation so an employee's
    // role cannot silently widen ordinary product requests.
    const adminConfigurationRequested = new URL(request.url).searchParams.get("admin") === "1";
    if (adminConfigurationRequested) {
      const capabilityRequest = request instanceof NextRequest
        ? request
        : new NextRequest(request.url, { method: request.method, headers: request.headers });
      const modelAccess = await authorizeAdminCapability(capabilityRequest, "models.manage", {
        requireStepUp: true,
        operation: "llm_model_full_configuration_read",
      });
      if (!modelAccess.ok) return modelAccess.response;
      const agentAccess = await authorizeAdminCapability(capabilityRequest, "agents.manage", {
        requireStepUp: true,
        operation: "llm_model_agent_binding_read",
      });
      if (!agentAccess.ok) return agentAccess.response;
    }
    const dbClient = getSupabaseClient();
    const query = dbClient
      .from("llm_models")
      .select(adminConfigurationRequested
        ? "*"
        : "id, name, model_name, description, category, deep_thinking_type, enable_web_search, image_parsing, file_parsing, icon_url, is_active, is_hidden, sort_order, user_access, token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit")
      .eq("is_active", true)
      .neq("is_hidden", true)
      .neq("user_access", "hidden")
      .order("sort_order")
      .order("id", { ascending: true });

    const { data, error } = await query;

    if (error) {
      console.error("[LLMModels] Supabase data source unavailable:", error);
      return NextResponse.json({ error: "Realtime LLM model data unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
    }

    const textModels = (data || []).filter(isPublishedTextModelEligible);

    // The administrator selector keeps the complete configuration fields for
    // eligible text models. 🔒 安全加固（20260914 审计#P1）：密钥不再回传浏览器，
    // 仅返回 api_key_configured 布尔；回填沿用 replacementApiKey 掩码机制。
    if (adminConfigurationRequested) {
      const adminModels = textModels.map((model: Record<string, unknown>) => {
        const { api_key, ...rest } = model;
        return { ...rest, api_key_configured: Boolean(String(api_key || "").trim()) };
      });
      return NextResponse.json({ models: adminModels }, { headers: NO_STORE_HEADERS });
    }

    const safeModels = textModels.map((model: Record<string, unknown>, index: number) => toPublicModelDto("llm", model, index, {
      type: "text",
      deepThinking: Number(model.deep_thinking_type) > 0,
      webSearch: Boolean(model.enable_web_search),
      imageParsing: Boolean(model.image_parsing),
      fileParsing: Boolean(model.file_parsing),
      ...publicTextModelBillingCapabilities(model),
    }));

    return NextResponse.json({
      models: safeModels.filter((model: PublicModelDto) => model.capabilities.priceReady === true),
      unavailableModels: safeModels.filter((model: PublicModelDto) => model.capabilities.priceReady !== true),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[LLMModels] GET error:", error);
    return NextResponse.json({ error: "获取模型列表失败" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
