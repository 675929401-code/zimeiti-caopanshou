import { createHmac, timingSafeEqual } from "node:crypto";

export type PublicModelKind = "chat" | "cover" | "llm" | "video";
export type PublicModelCapability = string | number | boolean | string[] | number[] | null;
export type PublicMediaBillingUnit = "per_use" | "output_second";
export type PublicMediaPricingMode = "fixed_per_use" | "output_second";

export interface PublicMediaBillingCapabilities {
  pricingMode: PublicMediaPricingMode;
  billingUnit: PublicMediaBillingUnit;
}

export interface PublicModelDto {
  id: string;
  displayName: string;
  variantLabel: string;
  avatarUrl: string;
  capabilities: Record<string, PublicModelCapability>;
  publicPrice: number;
}

const PUBLIC_CAPABILITY_KEYS = new Set([
  "humanInputMin", "humanInputMax", "humanInputMinExclusive", "humanInputMaxExclusive", "supportsVideoExtension", "supportsLongVideoSegmentation", "humanAudioMaxBytes",
  "humanAudioMin", "humanAudioMax", "humanAudioMinExclusive", "humanAudioMaxExclusive", "humanVideoMin", "humanVideoMax",
  "type", "family", "deepThinking", "webSearch", "imageParsing", "fileParsing",
  "supportsImageInput", "requiresImage", "supportsSourceVideoInput", "requiresSourceVideo",
  "workflowInputMode", "supportsPrompt", "requiresFirstFrame", "requiresLastFrame",
  "showFirstFrame", "showLastFrame", "showReferenceImages", "showAudioInputs",
  "minReferenceImages", "minReferenceAudios",
  "durationMode", "minDuration", "maxDuration", "defaultDuration", "nativeDurations", "durationStep",
  "resolutionTier", "resolutionOptions", "defaultResolution", "resolutionPrices", "resolutionLabels", "aspectRatios",
  "requestPixelSizes", "verifiedOutputPixelSizes",
  "directVerifiedCombinations", "verificationNotice",
  "available", "priceReady", "activationReady", "generationReady", "readinessMessage",
  "availabilityMessage", "pricingMode", "explicitlyFree",
  "supportsReferenceInput", "referenceInputMode", "identityReferenceLevel",
  "maxReferenceImages", "maxCharacterReferences", "referenceCapabilityLabel",
  "supportsAudioInput", "maxReferenceAudios", "billingUnit", "workspaceSurfaces", "supportsRemoteCancel",
  "supportsGenerateAudioToggle",
]);

function publicIdSecret(): string {
  const secret = process.env.PUBLIC_MODEL_ID_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production" || process.env.COZE_PROJECT_ENV === "PROD") {
    throw new Error("PUBLIC_MODEL_ID_SECRET or JWT_SECRET is required in production");
  }
  return "development-public-model-id-secret";
}

export function toPublicModelId(kind: PublicModelKind, internalId: string): string {
  const digest = createHmac("sha256", publicIdSecret())
    .update(`${kind}:${internalId}`)
    .digest("base64url")
    .slice(0, 24);
  return `pm_${digest}`;
}

export function publicModelIdMatches(kind: PublicModelKind, internalId: string, publicId: string): boolean {
  const expected = Buffer.from(toPublicModelId(kind, internalId));
  const actual = Buffer.from(publicId);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function findModelByPublicId<T extends { id?: unknown }>(
  kind: PublicModelKind,
  rows: T[],
  publicId: string,
): T | null {
  return rows.find((row) => typeof row.id === "string" && publicModelIdMatches(kind, row.id, publicId)) || null;
}

function variantLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `V${index + 1}`;
}

export function publicVariantLabel(row: Record<string, unknown>, index: number): string {
  const configured = String(row.variant_label || "").trim();
  if (configured) return configured;
  const channelMatch = String(row.name || "").match(/渠道\s*([A-Z])/iu);
  return channelMatch?.[1]?.toUpperCase() || variantLabel(index);
}

function finitePublicPrice(row: Record<string, unknown>): number {
  for (const key of ["selling_price", "price_per_use"]) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

const MODEL_AVATAR_RESOURCE_PATTERN = /^(?:https?:\/\/|\/|data:image\/)/iu;
const MODEL_AVATAR_MOJIBAKE_PATTERN = /[\u0080-\u009f\u00c2\u00c3\u00e2\u00f0\ufffd]/u;
const MODEL_AVATAR_EMOJI_PATTERN = /[\p{Extended_Pictographic}\u2600-\u27bf]/u;

/**
 * Model icons are sometimes stored after UTF-8 bytes were decoded as Latin-1.
 * Repair that narrow emoji case at the public DTO boundary so every workbench
 * receives the same icon, while leaving URLs, upload paths and ordinary keys
 * untouched.
 */
export function normalizePublicModelAvatarUrl(value: unknown): string {
  const source = String(value || "").trim();
  if (!source || MODEL_AVATAR_RESOURCE_PATTERN.test(source) || !MODEL_AVATAR_MOJIBAKE_PATTERN.test(source)) {
    return source;
  }

  const codePoints = Array.from(source);
  if (codePoints.some((character) => character.codePointAt(0)! > 0xff)) return source;

  try {
    const repaired = Buffer.from(codePoints.map((character) => character.charCodeAt(0))).toString("utf8");
    if (!repaired || repaired.includes("\ufffd") || !MODEL_AVATAR_EMOJI_PATTERN.test(repaired)) return source;
    return repaired;
  } catch {
    return source;
  }
}

export function publicModelDisplayName(row: Record<string, unknown>): string {
  const configured = String(row.public_name || "").trim();
  const sourceName = configured || String(row.name || "").trim();
  const protocolConfig = row.api_protocol_config && typeof row.api_protocol_config === "object"
    && !Array.isArray(row.api_protocol_config) ? row.api_protocol_config as Record<string, unknown> : {};
  const internalAnnotations = new Set(
    [row.id, row.model_name, row.internal_model_id, protocolConfig.provider_group_name]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim().toLowerCase()),
  );
  const configuredHasRoutingMarker = /(?:(?<![A-Za-z0-9])[A-Z]\s*渠道|渠道\s*[A-Z0-9一二三四五六七八九十]+|中转|密钥|autodl(?:\.art)?|secure[-\s]?skill|lconai)/iu.test(sourceName);
  // Older names created by configure-gpt-image2-channels-local can reach
  // history without protocol metadata. Match only those evidenced names,
  // never arbitrary hyphenated product names or capability annotations.
  const legacyChannelName = sourceName.match(
    /^GPT\s+Image\s+2\s*·\s*[A-Z]\s*渠道(?:低成本档|官方档)\s*[（(]\s*(image-2-1k|adobe-image2-mid|image2-官key)\s*[）)]$/iu,
  );
  if (legacyChannelName) internalAnnotations.add(legacyChannelName[1].toLowerCase());

  return (sourceName || "模型")
    .replace(/\s*[（(]([^）)]*)[）)]/gu, (annotation, content: string) => (
      (!configured || configuredHasRoutingMarker) && internalAnnotations.has(content.trim().toLowerCase()) ? "" : annotation
    ))
    .replace(/\s*[（(][^）)]*(?:autodl(?:\.art)?|secure[-\s]?skill|lconai|中转|渠道)[^）)]*[）)]/giu, "")
    .replace(/\s*(?:中转\s*)?(?:lconai|secure[-\s]?skill)(?:\s*高质量)?(?:\s*渠道)?/giu, "")
    .replace(/\s*autodl(?:\.art)?(?:\s*(?:官方|托管|自租|在线|渠道|实例|工作流|加速版|pro\d*))*/giu, "")
    .replace(/(?<![A-Za-z0-9])[A-Z]\s*渠道/giu, "")
    .replace(/渠道\s*[A-Z0-9一二三四五六七八九十]+/giu, "")
    .replace(/\s*[（(]\s*密钥[^）)]*[）)]/giu, "")
    .replace(/\s*[（(]?\s*(?:配置待验收|待验收|待开放)\s*[）)]?\s*$/gu, "")
    .replace(/\s*[·|｜/]\s*高端渠道\s*$/u, "")
    .replace(/\s*[·|｜/]\s*(?=[·|｜/])/gu, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s*[·|｜/-]\s*$/u, "")
    .trim() || "模型";
}

function sanitizeCapabilities(
  capabilities: Record<string, PublicModelCapability>,
): Record<string, PublicModelCapability> {
  return Object.fromEntries(
    Object.entries(capabilities).filter(([key, value]) => (
      PUBLIC_CAPABILITY_KEYS.has(key)
      && (value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
        || (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")))
    )),
  );
}

/**
 * Public media catalogues expose the same billing vocabulary as their server
 * charge resolver: one fixed charge per request, or a fixed rate per output
 * second. This is descriptive metadata only; it does not calculate a price.
 */
export function publicMediaBillingCapabilities(
  billingUnit: PublicMediaBillingUnit,
): PublicMediaBillingCapabilities {
  return billingUnit === "output_second"
    ? { pricingMode: "output_second", billingUnit: "output_second" }
    : { pricingMode: "fixed_per_use", billingUnit: "per_use" };
}

export function toPublicModelDto(
  kind: PublicModelKind,
  row: Record<string, unknown>,
  index: number,
  capabilities: Record<string, PublicModelCapability> = {},
): PublicModelDto {
  const internalId = String(row.id || "");
  if (!internalId) throw new Error("Model row is missing id");
  return {
    id: toPublicModelId(kind, internalId),
    displayName: publicModelDisplayName(row),
    variantLabel: publicVariantLabel(row, index),
    avatarUrl: normalizePublicModelAvatarUrl(row.avatar_url || row.icon_url || ""),
    capabilities: sanitizeCapabilities(capabilities),
    publicPrice: finitePublicPrice(row),
  };
}

export const FORBIDDEN_PUBLIC_MODEL_KEYS = new Set([
  "provider", "channel", "protocol", "protocoltype", "proxy", "proxyurl", "proxy_url",
  "endpoint", "apiendpoint", "api_endpoint", "apikey", "api_key", "modelname", "model_name",
  "internalmodelid", "internal_model_id", "costprice", "cost_price", "totalrequests",
  "successcount", "failcount", "lastsuccessat", "adminnotes", "admin_notes",
  "token_billing_enabled", "input_cost_per_million", "output_cost_per_million",
  "cached_cost_per_million", "profit_margin", "token_rounding_unit", "cost_per_use",
  "tokenbillingenabled", "inputcostpermillion", "outputcostpermillion",
  "cachedcostpermillion", "profitmargin", "tokenroundingunit", "costperuse",
]);

export function containsForbiddenPublicModelKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenPublicModelKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
    FORBIDDEN_PUBLIC_MODEL_KEYS.has(key.toLowerCase()) || containsForbiddenPublicModelKey(nested)
  ));
}
