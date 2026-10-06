import { isActivationGatedTextUserAccess } from "@/lib/model-activation-gate";
import { isTextModelPriceReady } from "@/lib/text-model-pricing";

type ModelMetadata = {
  id?: unknown;
  name?: unknown;
  model_name?: unknown;
  description?: unknown;
  category?: unknown;
  is_active?: unknown;
  is_hidden?: unknown;
  user_access?: unknown;
};

const NON_TEXT_CATEGORY = /^(?:image|drawing|cover|video|audio|voice|tts|生图|绘图|画图|图片|图像|封面|视频|语音|配音)$/iu;
const IMAGE_GENERATION_ID = /(?:^|[\s/_-])(?:glm[-_\s]*image|gpt[-_\s]*image|dall[-_\s]*e|seedream|stable[-_\s]*diffusion|sd3|flux|cogview|imagen)(?:$|[\s/_.:-])/iu;
const IMAGE_GENERATION_DESCRIPTION = /(?:文生图|图生图|生图模型|绘图模型|画图模型|图片生成|图像生成)/iu;
const NON_TEXT_GENERATION_ID = /(?:^|[\s/_-])(?:sora|kling|runway|veo|seedance|suno|udio|tts|text[-_\s]*to[-_\s]*speech)(?:$|[\s/_.:-])/iu;
const NON_TEXT_GENERATION_DESCRIPTION = /(?:视频生成|音乐生成|歌曲生成|语音合成|文本转语音|声音克隆|音色克隆)/iu;
const TEXT_MEDIA_CATEGORIES = new Set([
  "image",
  "drawing",
  "cover",
  "video",
  "audio",
  "music",
  "speech",
  "tts",
]);
const TEXT_MEDIA_ONLY_MODEL_PATTERN = /(?:seedream|dall[\s-]?e|midjourney|stable[\s-]?diffusion|\bflux\b|\bimagen\b|\bsora\b|\bkling\b|\bsuno\b|\btts\b|生图|绘图|图片生成|视频生成|音乐生成|语音合成)/iu;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether a row in llm_models is eligible for a text/chat selector.
 *
 * The legacy table also contains a small number of image-generation rows.
 * Keep multimodal chat models eligible; only explicit non-text categories,
 * known image-generation model identifiers, or generation descriptions are
 * rejected.
 */
export function isTextModelEligible(model: ModelMetadata): boolean {
  const category = normalize(model.category);
  if (NON_TEXT_CATEGORY.test(category)) return false;

  const identity = `${normalize(model.name)} ${normalize(model.model_name)}`;
  if (IMAGE_GENERATION_ID.test(identity)) return false;
  if (NON_TEXT_GENERATION_ID.test(identity)) return false;

  const description = normalize(model.description);
  return !IMAGE_GENERATION_DESCRIPTION.test(description) && !NON_TEXT_GENERATION_DESCRIPTION.test(description);
}

/** Shared user-facing publication gate for every text model selector. */
export function isPublishedTextModelEligible(model: ModelMetadata): boolean {
  if (!isTextModelEligible(model)) return false;
  if (model.is_active !== true || model.is_hidden === true) return false;
  const access = normalize(model.user_access);
  if (access === "hidden" || isActivationGatedTextUserAccess(access)) return false;
  return Boolean(normalize(model.id) && (normalize(model.model_name) || normalize(model.name)));
}

/** Final server-side gate for a text model that may reach billing and a provider. */
export function isPublishedTextBillingModel(
  model: Record<string, unknown> | null | undefined,
): boolean {
  if (!model || !isPublishedTextModelEligible(model)) return false;
  const category = normalize(model.category).toLowerCase();
  if (TEXT_MEDIA_CATEGORIES.has(category)) return false;
  const searchable = [model.name, model.model_name, model.description]
    .map(normalize)
    .join(" ");
  return !TEXT_MEDIA_ONLY_MODEL_PATTERN.test(searchable) && isTextModelPriceReady(model);
}
