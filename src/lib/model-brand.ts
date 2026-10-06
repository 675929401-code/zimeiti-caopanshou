export type ModelBrand = "google" | "openai" | "bytedance" | "xai" | "generic";

const IMAGE_SOURCE_PATTERN = /^(?:https?:\/\/|\/|\.\/|\.\.\/|data:image\/|blob:)|\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu;

export function resolveModelBrand(...values: Array<string | null | undefined>): ModelBrand | null {
  const identity = values.filter(Boolean).join(" ").toLowerCase();
  if (/google|gemini|veo|imagen|nano.?banana/u.test(identity)) return "google";
  if (/openai|chatgpt|gpt(?:-|\s|$)|dall.?e/u.test(identity)) return "openai";
  if (/seedance|doubao|dreamina|即梦|豆包/u.test(identity)) return "bytedance";
  if (/grok|xai|x\.ai/u.test(identity)) return "xai";
  return null;
}

export function modelBrandAsset(brand: ModelBrand) {
  return `/model-brands/${brand}.svg`;
}

export function isModelAvatarImage(value: string | null | undefined) {
  return IMAGE_SOURCE_PATTERN.test(String(value || "").trim());
}

export function modelInitial(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "AI";

  const han = text.match(/\p{Script=Han}/u)?.[0];
  if (han) return han;

  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  const initials = words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
  return initials || Array.from(text).slice(0, 2).join("").toUpperCase();
}
