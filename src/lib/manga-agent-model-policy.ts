import { isActivationGatedTextUserAccess } from "@/lib/model-activation-gate";
import { toPublicModelDto, type PublicModelDto } from "@/lib/public-model-dto";
import { isTextModelEligible } from "@/lib/text-model-eligibility";
import { publicTextModelBillingCapabilities } from "@/lib/text-model-pricing";

export const MANGA_AGENT_MODEL_POLICY_VERSION = "manga-agent-text-models-v2";

export interface MangaAgentModelPolicySummary {
  version: typeof MANGA_AGENT_MODEL_POLICY_VERSION;
  branch: "manga-workbench";
  capability: "text";
  defaultModelId: string | null;
  selection: "published-visible-text-compatible";
  fallback: "block-send-no-compatible-model";
  unavailableMessage: string;
}

export interface MangaAgentModelCatalog {
  models: PublicModelDto[];
  unavailableModels: PublicModelDto[];
  policy: MangaAgentModelPolicySummary;
}

type ModelRow = Record<string, unknown>;

const MEDIA_CATEGORIES = new Set([
  "image",
  "drawing",
  "cover",
  "video",
  "audio",
  "music",
  "speech",
  "tts",
]);

const MEDIA_ONLY_MODEL_PATTERN = /(?:seedream|dall[\s-]?e|midjourney|stable[\s-]?diffusion|\bflux\b|\bimagen\b|\bsora\b|\bkling\b|\bsuno\b|\btts\b|生图|绘图|图片生成|视频生成|音乐生成|语音合成)/iu;
const DISABLED_CAPABILITY_VALUES = new Set(["", "0", "false", "none", "off", "disabled", "no", "null", "undefined"]);

function isRecord(value: unknown): value is ModelRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPublishedTextModel(row: ModelRow): boolean {
  if (!isTextModelEligible(row)) return false;
  if (row.is_active !== true || row.is_hidden === true) return false;
  const access = String(row.user_access || "").trim();
  if (access === "hidden" || isActivationGatedTextUserAccess(access)) return false;
  if (!String(row.id || "").trim() || !String(row.model_name || "").trim()) return false;

  const category = String(row.category || "").trim().toLowerCase();
  if (MEDIA_CATEGORIES.has(category)) return false;

  const searchable = [row.name, row.model_name, row.description]
    .map((value) => String(value || "").trim())
    .join(" ");
  return !MEDIA_ONLY_MODEL_PATTERN.test(searchable);
}

function sortOrder(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isCapabilityEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return !DISABLED_CAPABILITY_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * Build the branch-safe model switcher from the current published model rows.
 * Internal IDs are converted to request-time public IDs; provider bindings and
 * credentials are deliberately outside this function's output contract.
 */
export function buildMangaAgentModelCatalog(input: unknown): MangaAgentModelCatalog {
  const rows = Array.isArray(input)
    ? input.filter(isRecord)
      .map((row, sourceIndex) => ({ row, sourceIndex }))
      .filter(({ row }) => isPublishedTextModel(row))
      .sort((left, right) => (
        sortOrder(left.row.sort_order) - sortOrder(right.row.sort_order)
        || left.sourceIndex - right.sourceIndex
      ))
      .map(({ row }) => row)
    : [];

  const catalogModels = rows.map((row, index) => {
    const model = toPublicModelDto("chat", {
      ...row,
      selling_price: undefined,
      price_per_use: undefined,
      cost_per_use: undefined,
    }, index, {
      type: "text",
      deepThinking: Number(row.deep_thinking_type) > 0,
      webSearch: isCapabilityEnabled(row.enable_web_search),
      imageParsing: isCapabilityEnabled(row.image_parsing),
      fileParsing: isCapabilityEnabled(row.file_parsing),
      ...publicTextModelBillingCapabilities(row),
    });
    const sourceName = String(row.name || "");
    const isBackupBinding = /秘钥\s*2/iu.test(sourceName);
    return {
      ...model,
      displayName: model.displayName.replace(/\s*[·|｜/-]?\s*秘钥\s*\d+\s*$/iu, "（备用）"),
      variantLabel: /官方直连/iu.test(sourceName)
        ? "官方"
        : isBackupBinding && model.variantLabel === "A"
          ? "A2"
          : model.variantLabel,
    };
  });
  const models = catalogModels.filter((model) => model.capabilities.priceReady === true);
  const unavailableModels = catalogModels.filter((model) => model.capabilities.priceReady !== true);

  return {
    models,
    unavailableModels,
    policy: {
      version: MANGA_AGENT_MODEL_POLICY_VERSION,
      branch: "manga-workbench",
      capability: "text",
      defaultModelId: models[0]?.id || null,
      selection: "published-visible-text-compatible",
      fallback: "block-send-no-compatible-model",
      unavailableMessage: models.length > 0
        ? unavailableModels.length > 0
          ? `已加载可提交文案模型；${unavailableModels.length} 个计费配置未就绪模型已暂停`
          : "已按主站当前发布且计费就绪的文案兼容模型加载"
        : unavailableModels.length > 0
          ? "暂无计费就绪且兼容的文案模型，为避免错误扣费，已阻止发送"
          : "暂无已发布且兼容的文案模型，为避免误用媒体模型，已阻止发送",
    },
  };
}
