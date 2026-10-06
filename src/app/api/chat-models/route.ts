/**
 * 公共对话模型列表 API
 * GET - 返回所有激活的 LLM 模型（从 llm_models 预设表读取，与模型管理实时同步）
 * 替代原先的 chat_models 表，确保管理后台增删模型后，聊天界面立即同步
 */
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextResponse } from "next/server";
import { toPublicModelDto, type PublicModelDto } from "@/lib/public-model-dto";
import { isPublishedTextModelEligible } from "@/lib/text-model-eligibility";
import { publicTextModelBillingCapabilities } from "@/lib/text-model-pricing";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

function isChatCapabilityEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return !["", "0", "false", "none", "off", "disabled", "no", "null", "undefined"]
    .includes(String(value ?? "").trim().toLowerCase());
}

export async function GET() {
  try {
    const supabase = getSupabaseClient();
    const query = supabase
      .from("llm_models")
      .select("id, name, model_name, description, category, icon_url, deep_thinking_type, enable_web_search, image_parsing, file_parsing, is_active, is_hidden, sort_order, user_access, token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit")
      .eq("is_active", true)
      .neq("user_access", "hidden")
      .neq("is_hidden", true)
      .order("sort_order", { ascending: true });

    const { data: models, error } = await query;

    if (error) {
      console.error("Failed to fetch LLM models for chat switcher:", error);
      return NextResponse.json({ error: "Realtime model data unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
    }

    const textModels = (models || []).filter(isPublishedTextModelEligible).map((model: Record<string, unknown>, index: number) => toPublicModelDto("chat", model, index, {
      type: "text",
      deepThinking: Number(model.deep_thinking_type) > 0,
      webSearch: isChatCapabilityEnabled(model.enable_web_search),
      imageParsing: isChatCapabilityEnabled(model.image_parsing),
      fileParsing: isChatCapabilityEnabled(model.file_parsing),
      ...publicTextModelBillingCapabilities(model),
    }));

    return NextResponse.json({
      models: textModels.filter((model: PublicModelDto) => model.capabilities.priceReady === true),
      unavailableModels: textModels.filter((model: PublicModelDto) => model.capabilities.priceReady !== true),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("Error fetching LLM models for chat switcher:", error);
    return NextResponse.json({ error: "Realtime model data unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
