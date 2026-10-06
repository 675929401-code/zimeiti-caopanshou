export const PLATFORM_BRAND_PROFILE_ID = "default" as const;
export const PLATFORM_BRAND_SCHEMA = "platform-brand/v1" as const;

export const PLATFORM_BRAND_ASSET_PURPOSES = [
  "logo_square",
  "logo_horizontal_light",
  "logo_horizontal_dark",
  "favicon",
  "social_share",
  "login_background",
] as const;

export type PlatformBrandAssetPurpose = typeof PLATFORM_BRAND_ASSET_PURPOSES[number];

export interface PlatformBrandPayload {
  schema: typeof PLATFORM_BRAND_SCHEMA;
  name: string;
  shortName: string;
  slogan: string;
  welcomeMessage: string;
  description: string;
  seo: {
    title: string;
    description: string;
  };
  colors: {
    primary: string;
    accent: string;
  };
  assetIds: Partial<Record<PlatformBrandAssetPurpose, string>>;
}

export interface PublicPlatformBrandAsset {
  id: string;
  purpose: PlatformBrandAssetPurpose;
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface PublicPlatformBranding {
  source: "published" | "legacy";
  generation: number;
  revisionId: string | null;
  revisionVersion: number | null;
  publishedAt: string | null;
  brand: PlatformBrandPayload;
  assets: Partial<Record<PlatformBrandAssetPurpose, PublicPlatformBrandAsset>>;
  legacyLogoUrl?: string;
  legacyLogoOmitted?: boolean;
}

export function platformBrandingLegacyCompatibilitySettings(
  branding: PublicPlatformBranding,
): Record<"platform_name" | "platform_cover" | "welcome_message", string> {
  const publishedLogo = branding.assets.logo_horizontal_light?.url
    || branding.assets.logo_horizontal_dark?.url
    || branding.assets.logo_square?.url
    || "";
  return {
    platform_name: branding.brand.name,
    platform_cover: branding.source === "published" ? publishedLogo : branding.legacyLogoUrl || "",
    welcome_message: branding.brand.welcomeMessage,
  };
}

export class PlatformBrandValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PlatformBrandValidationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const ALLOWED_ROOT_KEYS = new Set(["schema", "name", "shortName", "slogan", "welcomeMessage", "description", "seo", "colors", "assetIds"]);
const ALLOWED_SEO_KEYS = new Set(["title", "description"]);
const ALLOWED_COLOR_KEYS = new Set(["primary", "accent"]);
const ASSET_PURPOSE_SET = new Set<string>(PLATFORM_BRAND_ASSET_PURPOSES);

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformBrandValidationError(`${field} 必须是对象`, "BRAND_FIELD_INVALID");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new PlatformBrandValidationError(`${field} 包含未知字段: ${unknown}`, "BRAND_FIELD_UNKNOWN");
  }
}

function stringField(value: unknown, field: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new PlatformBrandValidationError(`${field} 不能为空`, "BRAND_FIELD_REQUIRED");
    return "";
  }
  if (typeof value !== "string") {
    throw new PlatformBrandValidationError(`${field} 必须是字符串`, "BRAND_FIELD_INVALID");
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (required && !normalized) {
    throw new PlatformBrandValidationError(`${field} 不能为空`, "BRAND_FIELD_REQUIRED");
  }
  if (normalized.length > max) {
    throw new PlatformBrandValidationError(`${field} 最多 ${max} 个字符`, "BRAND_FIELD_TOO_LONG");
  }
  return normalized;
}

function colorField(value: unknown, field: string, fallback: string): string {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw new PlatformBrandValidationError(`${field} 必须是六位十六进制颜色`, "BRAND_COLOR_INVALID");
  }
  return value.toUpperCase();
}

export function isPlatformBrandAssetPurpose(value: unknown): value is PlatformBrandAssetPurpose {
  return typeof value === "string" && ASSET_PURPOSE_SET.has(value);
}

export function parsePlatformBrandPayload(input: unknown): PlatformBrandPayload {
  const root = record(input, "brand");
  rejectUnknownKeys(root, ALLOWED_ROOT_KEYS, "brand");
  if (root.schema !== PLATFORM_BRAND_SCHEMA) {
    throw new PlatformBrandValidationError(`schema 必须是 ${PLATFORM_BRAND_SCHEMA}`, "BRAND_SCHEMA_INVALID");
  }

  const seo = root.seo == null ? {} : record(root.seo, "seo");
  rejectUnknownKeys(seo, ALLOWED_SEO_KEYS, "seo");
  const colors = root.colors == null ? {} : record(root.colors, "colors");
  rejectUnknownKeys(colors, ALLOWED_COLOR_KEYS, "colors");
  const rawAssetIds = root.assetIds == null ? {} : record(root.assetIds, "assetIds");

  const assetIds: Partial<Record<PlatformBrandAssetPurpose, string>> = {};
  for (const [purpose, rawId] of Object.entries(rawAssetIds)) {
    if (!isPlatformBrandAssetPurpose(purpose)) {
      throw new PlatformBrandValidationError(`不支持的品牌资产用途: ${purpose}`, "BRAND_ASSET_PURPOSE_INVALID");
    }
    if (typeof rawId !== "string" || !UUID.test(rawId)) {
      throw new PlatformBrandValidationError(`${purpose} 的资产编号无效`, "BRAND_ASSET_ID_INVALID");
    }
    assetIds[purpose] = rawId.toLowerCase();
  }

  return {
    schema: PLATFORM_BRAND_SCHEMA,
    name: stringField(root.name, "平台名称", 80, true),
    shortName: stringField(root.shortName, "平台简称", 40),
    slogan: stringField(root.slogan, "品牌标语", 120),
    welcomeMessage: stringField(root.welcomeMessage, "欢迎语", 240),
    description: stringField(root.description, "品牌说明", 500),
    seo: {
      title: stringField(seo.title, "SEO 标题", 70),
      description: stringField(seo.description, "SEO 描述", 180),
    },
    colors: {
      primary: colorField(colors.primary, "品牌主色", "#168D7A"),
      accent: colorField(colors.accent, "品牌强调色", "#2F80FF"),
    },
    assetIds,
  };
}

export function extractPlatformBrandAssetIds(payload: PlatformBrandPayload): Array<{ purpose: PlatformBrandAssetPurpose; assetId: string }> {
  return PLATFORM_BRAND_ASSET_PURPOSES.flatMap((purpose) => {
    const assetId = payload.assetIds[purpose];
    return assetId ? [{ purpose, assetId }] : [];
  });
}

export function parseExpectedBrandGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PlatformBrandValidationError("expectedGeneration 必须是非负整数", "BRAND_GENERATION_INVALID");
  }
  return Number(value);
}

export function parseBrandRevisionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new PlatformBrandValidationError("revisionId 无效", "BRAND_REVISION_ID_INVALID");
  }
  return value.toLowerCase();
}

export function stableLegacyBrandImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const raw = value.trim();
  try {
    const relative = raw.startsWith("/") && !raw.startsWith("//");
    const absolute = /^https?:\/\//iu.test(raw);
    if (!relative && !absolute) return undefined;
    const url = new URL(raw, "https://brand.invalid");
    if (absolute && !["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password || url.hash) return undefined;
    const suspicious = ["signature", "sig", "token", "expires", "credential", "x-amz-", "q-sign-"];
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (keys.some((key) => suspicious.some((marker) => key.includes(marker)))) return undefined;
    return relative ? `${url.pathname}${url.search}` : url.toString();
  } catch {
    return undefined;
  }
}

export function legacyPlatformBrandPayload(settings: Record<string, string>): PlatformBrandPayload {
  const legacyText = (value: unknown, fallback: string, max: number) => {
    const normalized = typeof value === "string" ? value.replace(/\r\n?/gu, "\n").trim() : "";
    return (normalized || fallback).slice(0, max);
  };
  const name = legacyText(settings.platform_name, "自媒体操盘手", 80);
  return {
    schema: PLATFORM_BRAND_SCHEMA,
    name,
    shortName: "",
    slogan: "",
    welcomeMessage: legacyText(settings.welcome_message, "", 240),
    description: "",
    seo: { title: name, description: "" },
    colors: { primary: "#168D7A", accent: "#2F80FF" },
    assetIds: {},
  };
}
