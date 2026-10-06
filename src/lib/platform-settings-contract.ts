import { isValidHexColor } from "@/lib/theme-color-settings";
import { normalizeTheme, normalizeThemeModePreference } from "@/lib/themes";

export const LEGACY_PLATFORM_BRAND_SETTING_KEYS = [
  "platform_name",
  "platform_cover",
  "welcome_message",
] as const;

const LEGACY_BRAND_KEY_SET = new Set<string>(LEGACY_PLATFORM_BRAND_SETTING_KEYS);

// 旧“一键恢复”浏览器入口已经永久停用。保留忽略列表只为兼容尚未刷新的旧后台，
// 这些字段不会再被读取、写入或返回。
export const RETIRED_PLATFORM_SETTING_KEYS = [
  "restore_token",
  "restore_token_configured",
] as const;

const RETIRED_PLATFORM_SETTING_KEY_SET = new Set<string>(RETIRED_PLATFORM_SETTING_KEYS);

export const BRAND_PLATFORM_SETTING_KEYS = [
  "theme",
  "theme_mode",
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
  "card_layout",
  "page_layout",
  "video_page_config",
] as const;

export const INTEGRATION_PLATFORM_SETTING_KEYS = [
  "coze_api_base_url",
  "coze_api_token",
  "coze_workspace_id",
  "coze_coding_api_url",
  "coze_coding_api_token",
  "extract_api_url",
  "extract_api_token",
  "email_smtp_host",
  "email_smtp_port",
  "email_smtp_user",
  "email_smtp_pass",
  "email_from",
] as const;

export const MODEL_PLATFORM_SETTING_KEYS = [
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "cover_workflow_api_url",
  "cover_workflow_app_id",
  "cover_workflow_token",
  "thinking_model_name",
  "thinking_model_api_base",
  "thinking_model_api_key",
  "auto_avatar_enabled",
  "auto_avatar_model_id",
] as const;

export const PAYMENT_RULE_PLATFORM_SETTING_KEYS = [
  "extract_price_per_use",
  "profit_margin",
  "credits_per_yuan",
  "token_rounding_unit",
  "token_rounding_enabled",
  "token_rounding_min",
  "token_rounding_max",
] as const;

export const PROMPT_PLATFORM_SETTING_KEYS = ["global_system_prefix"] as const;

export const GENERAL_PLATFORM_SETTING_KEYS = [
  "theme",
  "theme_mode",
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
  "card_layout",
  "page_layout",
  "video_page_config",
  "coze_api_base_url",
  "coze_api_token",
  "coze_workspace_id",
  "coze_coding_api_url",
  "coze_coding_api_token",
  "extract_api_url",
  "extract_api_token",
  "email_smtp_host",
  "email_smtp_port",
  "email_smtp_user",
  "email_smtp_pass",
  "email_from",
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "cover_workflow_api_url",
  "cover_workflow_app_id",
  "cover_workflow_token",
  "thinking_model_name",
  "thinking_model_api_base",
  "thinking_model_api_key",
  "auto_avatar_enabled",
  "auto_avatar_model_id",
  "extract_price_per_use",
  "profit_margin",
  "credits_per_yuan",
  "token_rounding_unit",
  "token_rounding_enabled",
  "token_rounding_min",
  "token_rounding_max",
  "global_system_prefix",
] as const;

export const ADMIN_PLATFORM_SETTING_KEYS = [
  "theme",
  "theme_mode",
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
  "card_layout",
  "page_layout",
  "video_page_config",
  "coze_api_base_url",
  "coze_api_token",
  "coze_workspace_id",
  "coze_coding_api_url",
  "coze_coding_api_token",
  "extract_api_url",
  "extract_api_token",
  "email_smtp_host",
  "email_smtp_port",
  "email_smtp_user",
  "email_smtp_pass",
  "email_from",
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "cover_workflow_api_url",
  "cover_workflow_app_id",
  "cover_workflow_token",
  "thinking_model_name",
  "thinking_model_api_base",
  "thinking_model_api_key",
  "auto_avatar_enabled",
  "auto_avatar_model_id",
  "extract_price_per_use",
  "profit_margin",
  "credits_per_yuan",
  "token_rounding_unit",
  "token_rounding_enabled",
  "token_rounding_min",
  "token_rounding_max",
  "global_system_prefix",
] as const;

export const ADMIN_PLATFORM_SETTING_SCOPES = [
  "brand",
  "integrations",
  "models",
  "payment",
  "prompts",
] as const;

export type AdminPlatformSettingScope = typeof ADMIN_PLATFORM_SETTING_SCOPES[number];
export type AdminPlatformSettingAccessMode = "read" | "write";

const ADMIN_SCOPE_KEYS: Readonly<Record<AdminPlatformSettingScope, readonly string[]>> = {
  brand: BRAND_PLATFORM_SETTING_KEYS,
  integrations: INTEGRATION_PLATFORM_SETTING_KEYS,
  models: MODEL_PLATFORM_SETTING_KEYS,
  payment: PAYMENT_RULE_PLATFORM_SETTING_KEYS,
  prompts: PROMPT_PLATFORM_SETTING_KEYS,
};

const ADMIN_SCOPE_PERMISSIONS: Readonly<Record<
  AdminPlatformSettingScope,
  Readonly<Record<AdminPlatformSettingAccessMode, string>>
>> = {
  brand: { read: "brand.settings.manage", write: "brand.settings.manage" },
  integrations: { read: "integrations.manage", write: "integrations.manage" },
  models: { read: "models.manage", write: "models.manage" },
  payment: { read: "payment.settings.manage", write: "payment.settings.manage" },
  prompts: { read: "prompts.view", write: "prompts.edit" },
};

const ADMIN_SCOPE_SET = new Set<string>(ADMIN_PLATFORM_SETTING_SCOPES);
const SETTING_SCOPE_BY_KEY = new Map<string, AdminPlatformSettingScope>(
  ADMIN_PLATFORM_SETTING_SCOPES.flatMap((scope) => (
    ADMIN_SCOPE_KEYS[scope].map((key) => [key, scope] as const)
  )),
);

export function isAdminPlatformSettingScope(value: unknown): value is AdminPlatformSettingScope {
  return typeof value === "string" && ADMIN_SCOPE_SET.has(value);
}

export function adminPlatformSettingKeysForScope(scope: AdminPlatformSettingScope): readonly string[] {
  return ADMIN_SCOPE_KEYS[scope];
}

export function adminPlatformSettingPermission(
  scope: AdminPlatformSettingScope,
  mode: AdminPlatformSettingAccessMode,
): string {
  return ADMIN_SCOPE_PERMISSIONS[scope][mode];
}

export function adminPlatformSettingScopeForKey(key: string): AdminPlatformSettingScope | null {
  return SETTING_SCOPE_BY_KEY.get(key) || null;
}

export function adminPlatformSettingScopesForKeys(keys: readonly string[]): AdminPlatformSettingScope[] {
  const requested = new Set(keys.map(adminPlatformSettingScopeForKey).filter(
    (scope): scope is AdminPlatformSettingScope => scope !== null,
  ));
  return ADMIN_PLATFORM_SETTING_SCOPES.filter((scope) => requested.has(scope));
}

export type AdminPlatformSettingKey = typeof ADMIN_PLATFORM_SETTING_KEYS[number];
export type AdminPlatformSettingConfiguredKey = `${AdminPlatformSettingKey}_configured`;
export type AdminPlatformSettingsDto = Partial<Record<
  AdminPlatformSettingKey | AdminPlatformSettingConfiguredKey,
  string | boolean
>>;

// 支付凭据只允许经专用、需二次验证的支付控制平面读写。将它们与通用
// admin 设置分离，避免通用表单把支付字段带回 /api/settings 或绕过缓存刷新。
export const PAYMENT_PLATFORM_SETTING_KEYS = [
  "xunhu_appid",
  "xunhu_secret",
  "xunhu_gateway",
  "xunhu_gateway_backup",
  "xunhu_wap_url",
  "xunhu_refund_gateway",
  "xunhu_refund_gateway_backup",
  "epay_pid",
  "epay_key",
  "epay_gateway",
] as const;

const GENERAL_KEY_SET = new Set<string>(GENERAL_PLATFORM_SETTING_KEYS);
const ADMIN_KEY_SET = new Set<string>(ADMIN_PLATFORM_SETTING_KEYS);
const PAYMENT_KEY_SET = new Set<string>(PAYMENT_PLATFORM_SETTING_KEYS);
const CLIENT_META_KEYS = new Set<string>([
  "coze_api_token_configured",
  "coze_coding_api_token_configured",
  "cover_workflow_token_configured",
  "thinking_model_api_key_configured",
  "extract_api_token_configured",
  "xunhu_secret_configured",
  "epay_key_configured",
  "email_smtp_pass_configured",
]);
const URL_KEYS = new Set<string>([
  "coze_api_base_url",
  "coze_coding_api_url",
  "cover_workflow_api_url",
  "thinking_model_api_base",
  "extract_api_url",
  "xunhu_gateway",
  "xunhu_gateway_backup",
  "xunhu_wap_url",
  "xunhu_refund_gateway",
  "xunhu_refund_gateway_backup",
  "epay_gateway",
]);
const XUNHU_PUBLIC_HTTPS_URL_KEYS = new Set<string>([
  "xunhu_gateway",
  "xunhu_gateway_backup",
  "xunhu_wap_url",
  "xunhu_refund_gateway",
  "xunhu_refund_gateway_backup",
]);
const LOCAL_GATEWAY_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".example",
  ".invalid",
  ".test",
  ".onion",
] as const;
const NON_NEGATIVE_NUMBER_KEYS = new Set<string>([
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
  "credits_per_yuan",
  "token_rounding_unit",
  "token_rounding_min",
  "token_rounding_max",
  "extract_price_per_use",
]);
const BOOLEAN_STRING_KEYS = new Set<string>(["token_rounding_enabled", "auto_avatar_enabled"]);
const COLOR_KEYS = new Set<string>([
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
]);
const JSON_KEYS = new Set<string>(["card_layout", "page_layout", "video_page_config"]);
const LARGE_TEXT_KEYS = new Set<string>(["global_system_prefix", ...JSON_KEYS]);

export class PlatformSettingValidationError extends Error {
  constructor(message: string, readonly code: string, readonly settingKey?: string) {
    super(message);
    this.name = "PlatformSettingValidationError";
  }
}

export interface ParsedPlatformSettingPatch {
  values: Record<string, string>;
  ignoredKeys: string[];
}

export function isLegacyPlatformBrandSettingKey(value: unknown): value is typeof LEGACY_PLATFORM_BRAND_SETTING_KEYS[number] {
  return typeof value === "string" && LEGACY_BRAND_KEY_SET.has(value);
}

function parseIpv4Hostname(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets as [number, number, number, number];
}

function isNonPublicXunhuGatewayHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (
    !hostname
    || hostname === "localhost"
    || LOCAL_GATEWAY_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return true;
  }

  const ipv4 = parseIpv4Hostname(hostname);
  if (ipv4) {
    const [first, second, third] = ipv4;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  }

  if (hostname.includes(":")) {
    const address = hostname.split("%", 1)[0];
    if (address.startsWith("::")) return true;
    const groups = address.split(":");
    const firstGroup = Number.parseInt(groups[0] || "0", 16);
    const secondGroup = Number.parseInt(groups[1] || "0", 16);
    if (!Number.isInteger(firstGroup)) return true;
    return (firstGroup & 0xfe00) === 0xfc00
      || (firstGroup & 0xffc0) === 0xfe80
      || (firstGroup & 0xffc0) === 0xfec0
      || (firstGroup & 0xff00) === 0xff00
      || (firstGroup === 0x2001 && secondGroup === 0x0db8)
      || (firstGroup === 0x2001 && secondGroup === 0x0002)
      || (firstGroup === 0x2001 && (secondGroup & 0xfff0) === 0x0010)
      || (firstGroup === 0x2001 && secondGroup === 0x0000)
      || firstGroup === 0x2002
      || (firstGroup === 0x0100 && secondGroup === 0)
      || (firstGroup === 0x0064 && secondGroup === 0xff9b);
  }

  return !hostname.includes(".");
}

function normalizeSettingValue(key: string, value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const maxLength = LARGE_TEXT_KEYS.has(key) ? 64 * 1024 : 16 * 1024;
  if (normalized.length > maxLength) {
    throw new PlatformSettingValidationError(`${key} 超过长度限制`, "PLATFORM_SETTING_TOO_LONG", key);
  }
  const trimmed = normalized.trim();
  if (key === "theme") {
    if (normalizeTheme(trimmed) !== trimmed) {
      throw new PlatformSettingValidationError("theme 必须是已启用的主题", "INVALID_THEME", key);
    }
  } else if (key === "theme_mode") {
    if (normalizeThemeModePreference(trimmed) !== trimmed) {
      throw new PlatformSettingValidationError("theme_mode 必须是已启用的模式", "INVALID_THEME_MODE", key);
    }
  } else if (COLOR_KEYS.has(key) && trimmed && !isValidHexColor(trimmed)) {
    throw new PlatformSettingValidationError(`${key} 必须是六位十六进制颜色`, "INVALID_THEME_COLOR", key);
  } else if (BOOLEAN_STRING_KEYS.has(key) && !["true", "false"].includes(trimmed)) {
    throw new PlatformSettingValidationError(`${key} 只能是 true 或 false`, "INVALID_BOOLEAN_SETTING", key);
  } else if (NON_NEGATIVE_NUMBER_KEYS.has(key) && trimmed) {
    const number = Number(trimmed);
    if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) {
      throw new PlatformSettingValidationError(`${key} 必须是有效的非负数`, "INVALID_NUMBER_SETTING", key);
    }
  } else if (key === "email_smtp_port" && trimmed) {
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PlatformSettingValidationError("email_smtp_port 必须是 1-65535 的整数", "INVALID_SMTP_PORT", key);
    }
  } else if (URL_KEYS.has(key) && trimmed) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new PlatformSettingValidationError(`${key} 必须是有效 URL`, "INVALID_URL_SETTING", key);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new PlatformSettingValidationError(`${key} 只允许无凭据、无片段的 HTTP(S) URL`, "INVALID_URL_SETTING", key);
    }
    if (XUNHU_PUBLIC_HTTPS_URL_KEYS.has(key)
      && (parsed.protocol !== "https:" || isNonPublicXunhuGatewayHostname(parsed.hostname))) {
      throw new PlatformSettingValidationError(
        `${key} 必须使用公网 HTTPS 地址`,
        "INVALID_XUNHU_GATEWAY_URL",
        key,
      );
    }
  } else if (JSON_KEYS.has(key) && trimmed) {
    try {
      JSON.parse(trimmed);
    } catch {
      throw new PlatformSettingValidationError(`${key} 必须是有效 JSON`, "INVALID_JSON_SETTING", key);
    }
  }
  return LARGE_TEXT_KEYS.has(key) ? normalized : trimmed;
}

export function parsePlatformSettingPatch(
  input: unknown,
  surface: "general" | "admin" | "payment",
): ParsedPlatformSettingPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PlatformSettingValidationError("设置载荷必须是对象", "PLATFORM_SETTINGS_INVALID");
  }
  const allowed = surface === "general"
    ? GENERAL_KEY_SET
    : surface === "payment"
      ? PAYMENT_KEY_SET
      : ADMIN_KEY_SET;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 80) {
    throw new PlatformSettingValidationError("一次最多提交 80 个设置项", "PLATFORM_SETTINGS_TOO_MANY");
  }
  const values: Record<string, string> = {};
  const ignoredKeys: string[] = [];
  for (const [key, value] of entries) {
    if (
      CLIENT_META_KEYS.has(key)
      || RETIRED_PLATFORM_SETTING_KEY_SET.has(key)
      || (surface === "general" && isLegacyPlatformBrandSettingKey(key))
    ) {
      ignoredKeys.push(key);
      continue;
    }
    if (!allowed.has(key)) {
      throw new PlatformSettingValidationError(`不允许通过此接口修改设置项: ${key}`, "PLATFORM_SETTING_NOT_ALLOWED", key);
    }
    if (typeof value !== "string") {
      throw new PlatformSettingValidationError(`${key} 必须是字符串`, "PLATFORM_SETTING_TYPE_INVALID", key);
    }
    values[key] = normalizeSettingValue(key, value);
  }
  return { values, ignoredKeys: ignoredKeys.sort() };
}
