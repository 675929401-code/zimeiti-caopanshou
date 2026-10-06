import { buildMangaAgentModelCatalog } from "@/lib/manga-agent-model-policy";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const SHORT_DRAMA_TEXT_MODEL_SELECT = [
  "id",
  "name",
  "model_name",
  "description",
  "category",
  "icon_url",
  "deep_thinking_type",
  "enable_web_search",
  "image_parsing",
  "file_parsing",
  "is_active",
  "is_hidden",
  "sort_order",
  "user_access",
  "token_billing_enabled",
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
  "token_rounding_unit",
].join(", ");

export interface ShortDramaTextModelSelection {
  readonly id: string;
  readonly displayName: string;
}

export class ShortDramaTextModelSelectionError extends Error {
  constructor(
    readonly status: 503,
    readonly code: "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaTextModelSelectionError";
  }
}

/**
 * Resolve one control-plane healthy model before any paid request: active,
 * visible, ordinary-user accessible and text compatible. Provider calls are
 * deliberately not retried with another model after submission.
 */
export async function selectShortDramaTextModel(
  requestedPublicId = "",
): Promise<ShortDramaTextModelSelection> {
  let db: ReturnType<typeof getSupabaseClient>;
  try {
    db = getSupabaseClient();
  } catch {
    throw new ShortDramaTextModelSelectionError(
      503,
      "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE",
      "当前无法读取已发布的文案模型，请稍后重试",
    );
  }

  const { data, error } = await db
    .from("llm_models")
    .select(SHORT_DRAMA_TEXT_MODEL_SELECT)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    throw new ShortDramaTextModelSelectionError(
      503,
      "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE",
      "当前无法读取已发布的文案模型，请稍后重试",
    );
  }

  const catalog = buildMangaAgentModelCatalog(data || []);
  const normalizedRequestedId = requestedPublicId.trim();
  const selected = normalizedRequestedId
    ? catalog.models.find((model) => model.id === normalizedRequestedId)
    : catalog.models.find((model) => model.id === catalog.policy.defaultModelId)
      || catalog.models[0];
  if (!selected) {
    throw new ShortDramaTextModelSelectionError(
      503,
      "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE",
      normalizedRequestedId
        ? "所选文案模型已下架或不再兼容，请重新选择后再提交"
        : "暂无已发布且兼容的公共文案模型，已阻止本次付费请求",
    );
  }

  return { id: selected.id, displayName: selected.displayName };
}
