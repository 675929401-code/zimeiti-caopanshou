import { NextResponse } from "next/server";
import { buildMangaAgentModelCatalog } from "@/lib/manga-agent-model-policy";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * Branch-specific, credential-free text model catalog for the creation Agent.
 * The response contains only public DTOs and a deterministic selection policy.
 */
export async function GET() {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("llm_models")
      .select("id, name, model_name, description, category, icon_url, deep_thinking_type, enable_web_search, image_parsing, file_parsing, is_active, is_hidden, sort_order, user_access, token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("Failed to load manga-workbench text models:", error);
      return NextResponse.json(
        { error: "Manga workbench model catalog unavailable" },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      buildMangaAgentModelCatalog(data || []),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("Manga workbench model catalog error:", error);
    return NextResponse.json(
      { error: "Manga workbench model catalog unavailable" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
