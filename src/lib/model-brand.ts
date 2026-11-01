export const MODEL_BRAND_OPTIONS = [
  { key: "minimax", label: "MiniMax", asset: "/model-brands/minimax.svg" },
  { key: "xai", label: "xAI / Grok", asset: "/model-brands/xai.svg" },
  { key: "google", label: "Google / Veo / Omni", asset: "/model-brands/google-v2.svg" },
  { key: "bytedance", label: "字节 / Seedance", asset: "/model-brands/bytedance-v2.svg" },
  { key: "kling", label: "可灵 Kling", asset: "/model-brands/kling.svg" },
  { key: "openai", label: "OpenAI", asset: "/model-brands/openai-v2.svg" },
  { key: "vidu", label: "Vidu", asset: "/model-brands/vidu.svg" },
  { key: "gk", label: "GK", asset: "/model-brands/gk.svg" },
  { key: "qwen", label: "通义千问", asset: "/model-brands/qwen.svg" },
  { key: "generic", label: "通用 AI", asset: "/model-brands/generic.svg" },
] as const;

export type ModelBrand = (typeof MODEL_BRAND_OPTIONS)[number]["key"];

const IMAGE_SOURCE_PATTERN = /^(?:https?:\/\/|\/|\.\/|\.\.\/|data:image\/|blob:)|\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu;

export function resolveModelBrand(...values: Array<string | null | undefined>): ModelBrand | null {
  const identity = values.filter(Boolean).join(" ").toLowerCase();
  if (/minimax|海螺|hailuo/u.test(identity)) return "minimax";
  if (/kling|可灵/u.test(identity)) return "kling";
  if (/vidu/u.test(identity)) return "vidu";
  if (/gk[-\s]?video|gk[-\s]?3(?:\.5)?/u.test(identity)) return "gk";
  if (/qwen|通义|千问/u.test(identity)) return "qwen";
  if (/google|gemini|veo|imagen|nano.?banana|omni/u.test(identity)) return "google";
  if (/openai|chatgpt|gpt(?:-|\s|$)|dall.?e/u.test(identity)) return "openai";
  if (/seedance|doubao|dreamina|即梦|豆包/u.test(identity)) return "bytedance";
  if (/grok|xai|x\.ai/u.test(identity)) return "xai";
  return null;
}

export function modelBrandAsset(brand: ModelBrand) {
  return MODEL_BRAND_OPTIONS.find(option => option.key === brand)?.asset || "/model-brands/generic.svg";
}

export function displayModelAvatar(value: string) {
  switch (value) {
    case "/model-brands/bytedance.svg": return modelBrandAsset("bytedance");
    case "/model-brands/google.svg": return modelBrandAsset("google");
    case "/model-brands/openai.svg": return modelBrandAsset("openai");
    default: return value;
  }
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
