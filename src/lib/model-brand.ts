export const MODEL_BRAND_OPTIONS = [
  { key: "minimax", label: "MiniMax", asset: "/model-brands/minimax.svg" },
  { key: "xai", label: "xAI / Grok", asset: "/model-brands/xai.svg" },
  { key: "google", label: "Google / Veo", asset: "/model-brands/google-v2.svg" },
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
  const identities = values.filter((value): value is string => Boolean(value)).map(value => value.toLowerCase());
  // Public model families outrank a relay/provider label in another field.
  // Keep the caller's identity order when several fields name model families.
  for (const identity of identities) {
    if (/minimax|海螺|hailuo/u.test(identity)) return "minimax";
    if (/kling|可灵/u.test(identity)) return "kling";
    if (/vidu/u.test(identity)) return "vidu";
    if (/gk[-\s]?video|gk[-\s]?3(?:\.5)?/u.test(identity)) return "gk";
    if (/qwen|通义|千问/u.test(identity)) return "qwen";
    if (/chatgpt|gpt(?:[-_\s]|\d|$)|dall.?e|\bopenai\b.*\bomni\b|\bomni\b.*\bopenai\b/u.test(identity)) return "openai";
    if (/gemini|veo|imagen|nano.?banana/u.test(identity)) return "google";
    if (/seedance|doubao|dreamina|即梦|豆包/u.test(identity)) return "bytedance";
    if (/grok/u.test(identity)) return "xai";
  }
  // Omni is a public family alias, not evidence of an upstream brand.
  if (identities.some(isOmniFamilyIdentity)) return null;
  for (const identity of identities) {
    if (/google/u.test(identity)) return "google";
    if (/openai/u.test(identity)) return "openai";
    if (/xai|x\.ai/u.test(identity)) return "xai";
  }
  return null;
}

function isOmniFamilyIdentity(value: string) {
  return /(?:^|[^a-z0-9])omni(?:$|[^a-z0-9])/iu.test(value);
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

export type ModelBadgeImageCandidate = {
  source: string;
  kind: "avatar" | "brand" | "generic";
};

/** Only known local stock assets can be corrected; custom images stay explicit. */
function isStockModelAvatar(value: string) {
  const asset = value.split(/[?#]/u, 1)[0];
  return MODEL_BRAND_OPTIONS.some(option => option.asset === asset)
    || ["/model-brands/bytedance.svg", "/model-brands/doubao.svg", "/model-brands/google.svg", "/model-brands/openai.svg"].includes(asset);
}

export function resolveModelBadgeAppearance(name: string, avatarUrl?: string | null, identity: Array<string | null | undefined> = []) {
  const avatar = String(avatarUrl || "").trim();
  const brand = resolveModelBrand(name, ...identity);
  const stockAvatar = isStockModelAvatar(avatar);
  const neutralOmni = !brand && [name, ...identity].some(value => typeof value === "string" && isOmniFamilyIdentity(value));
  const genericSource = modelBrandAsset("generic");
  const candidates: ModelBadgeImageCandidate[] = [];

  if (isModelAvatarImage(avatar) && (!stockAvatar || (!brand && !neutralOmni))) {
    candidates.push({ source: displayModelAvatar(avatar), kind: "avatar" });
  }
  if (brand) candidates.push({ source: modelBrandAsset(brand), kind: "brand" });
  candidates.push({ source: genericSource, kind: "generic" });

  return {
    brand,
    candidates: candidates.filter((candidate, index, values) => values.findIndex(value => value.source === candidate.source) === index),
  };
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
