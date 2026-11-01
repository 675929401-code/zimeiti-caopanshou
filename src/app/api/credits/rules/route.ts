import { NextResponse } from "next/server";
import { getBillingConfig } from "@/lib/billing";
import { buildPublicBillingRules } from "@/lib/public-billing-explanation";
import { findModelByPublicId, publicModelDisplayName } from "@/lib/public-model-dto";
import { isPublishedTextModelEligible } from "@/lib/text-model-eligibility";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const HEADERS = { "Cache-Control": "private, no-store" };

// GET /api/credits/rules - 获取积分规则说明（面向用户，无需认证）
export async function GET(request: Request) {
  try {
    const modelId = new URL(request.url).searchParams.get("modelId");
    if (modelId !== null && !/^pm_[A-Za-z0-9_-]{24}$/u.test(modelId)) {
      return NextResponse.json({ error: "模型标识无效" }, { status: 400, headers: HEADERS });
    }
    const config = await getBillingConfig();
    if (!modelId) return NextResponse.json(buildPublicBillingRules(config), { headers: HEADERS });
    const { data, error } = await getSupabaseClient().from("llm_models")
      .select("id, name, model_name, description, category, is_active, is_hidden, user_access, token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit")
      .eq("is_active", true).neq("is_hidden", true).neq("user_access", "hidden");
    if (error) return NextResponse.json({ error: "获取模型计费说明失败" }, { status: 503, headers: HEADERS });
    const publishedModels = (data || []).filter(isPublishedTextModelEligible);
    // The chat switcher and agent editor publish different IDs for the same row.
    // Match the same two namespaces accepted by /api/llm without exposing internal IDs.
    const row = findModelByPublicId("chat", publishedModels, modelId)
      || findModelByPublicId("llm", publishedModels, modelId);
    if (!row) return NextResponse.json({ error: "模型未公开或不存在" }, { status: 404, headers: HEADERS });
    return NextResponse.json({ ...buildPublicBillingRules(config, row), modelId, displayName: publicModelDisplayName(row) }, { headers: HEADERS });
  } catch (err) {
    console.error("Credits rules GET error:", err);
    return NextResponse.json({ error: "获取积分规则失败" }, { status: 500, headers: HEADERS });
  }
}
