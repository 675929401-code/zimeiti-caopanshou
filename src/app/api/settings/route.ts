import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { isReservedPlatformSettingKey } from "@/lib/server/platform-settings-reserved";
import { clearCozeConfigCache } from "@/lib/coze-api";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  normalizeTheme,
  normalizeThemeModePreference,
} from "@/lib/themes";
import {
  isBlankOrMaskedSecret,
  isPlatformSecretSettingKey,
} from "@/lib/server/platform-secret-settings";
import {
  adminPlatformSettingPermission,
  adminPlatformSettingScopesForKeys,
  PlatformSettingValidationError,
  parsePlatformSettingPatch,
  type AdminPlatformSettingScope,
} from "@/lib/platform-settings-contract";
import { platformBrandingLegacyCompatibilitySettings } from "@/lib/branding/contracts";
import { readPublishedPlatformBranding } from "@/lib/server/brand-authority";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";

// /api/settings is a public browser-bootstrap contract. Authentication must
// never widen this list; internal and sensitive settings belong exclusively to
// /api/settings/admin, which enforces a field-scoped capability plus step-up.
const PUBLIC_DATABASE_SETTING_KEYS = [
  "theme",
  "theme_mode",
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
  "page_layout",
  "card_layout",
  "video_page_config",
] as const;

type PublicDatabaseSettingKey = typeof PUBLIC_DATABASE_SETTING_KEYS[number];
type RequiredPublicSettingKey =
  | "theme"
  | "theme_mode"
  | "platform_name"
  | "platform_cover"
  | "welcome_message";
type PublicSettingsDto = Partial<Record<PublicDatabaseSettingKey, string>>
  & Record<RequiredPublicSettingKey, string>;

type PublicBranding = Awaited<ReturnType<typeof readPublishedPlatformBranding>>;

interface PublicSettingsResponseDto {
  settings: PublicSettingsDto;
  authorities: {
    branding: Pick<
      PublicBranding,
      "source" | "generation" | "revisionId" | "revisionVersion" | "publishedAt"
    >;
    general: { source: "platform_settings" };
  };
}

const PUBLIC_DATABASE_SETTING_KEY_SET = new Set<string>(PUBLIC_DATABASE_SETTING_KEYS);

// 敏感字段黑名单：即使出现在 PUBLIC_KEYS 中也不得返回给非管理员
// 这些字段包含 API 密钥、Token、管理员联系方式等敏感信息
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /key/i,
  /secret/i,
  /password/i,
  /api_url/i,
  /api_base/i,
  /admin/i,
  /wechat/i,
  /微信/i,
  /邮箱/i,
  /email/i,
  /phone/i,
  /手机/i,
];

const VERSIONED_WORKSPACE_SETTING_KEYS = new Set([
  "workspace_model_assignment_overrides_v1",
  "image_model_surface_orders_v1",
  "video_model_surface_orders_v1",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

// 敏感值模式：即使 key 在白名单中，值内含有这些模式也应脱敏
const SENSITIVE_VALUE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /微信[：:]\s*\S+/gi, replacement: "微信：***" },
  { pattern: /wechat[：:]\s*\S+/gi, replacement: "WeChat: ***" },
  { pattern: /[\w.-]+@[\w.-]+\.\w{2,}/g, replacement: "***@***.***" }, // 邮箱
  { pattern: /1[3-9]\d{9}/g, replacement: "1**********" }, // 手机号
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "sk-***" }, // API keys
  { pattern: /[a-f0-9]{32,}/gi, replacement: "***" }, // Hex tokens
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}/g, replacement: "eyJ***" }, // JWT tokens
];

function sanitizeValue(value: string): string {
  let sanitized = value;
  for (const { pattern, replacement } of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function buildPublicSettingsDto(
  rows: Array<{ setting_key: string; setting_value: string }>,
  branding: PublicBranding,
): PublicSettingsResponseDto {
  const publicSettings: Partial<Record<PublicDatabaseSettingKey, string>> = {};
  for (const item of rows) {
    if (
      !PUBLIC_DATABASE_SETTING_KEY_SET.has(item.setting_key)
      || isSensitiveKey(item.setting_key)
    ) continue;
    publicSettings[item.setting_key as PublicDatabaseSettingKey] = sanitizeValue(item.setting_value);
  }

  const storedTheme = publicSettings.theme || null;
  const storedMode = publicSettings.theme_mode || null;
  const settings: PublicSettingsDto = {
    ...publicSettings,
    theme: storedTheme ? normalizeTheme(storedTheme) : DEFAULT_THEME,
    theme_mode: normalizeThemeModePreference(storedMode) || DEFAULT_MODE_PREFERENCE,
    ...platformBrandingLegacyCompatibilitySettings(branding),
  };

  return {
    settings,
    authorities: {
      branding: {
        source: branding.source,
        generation: branding.generation,
        revisionId: branding.revisionId,
        revisionVersion: branding.revisionVersion,
        publishedAt: branding.publishedAt,
      },
      general: { source: "platform_settings" },
    },
  };
}

// GET /api/settings - return the same explicit public DTO for every caller.
export async function GET() {
  try {
    let data: Array<{ setting_key: string; setting_value: string }> = [];
    let branding: PublicBranding;
    try {
      const client = getSupabaseAdminClient();
      const [result, publishedBranding] = await Promise.all([
        client
          .from("platform_settings")
          .select("setting_key, setting_value")
          .in("setting_key", [...PUBLIC_DATABASE_SETTING_KEYS]),
        readPublishedPlatformBranding(),
      ]);

      if (result.error) throw result.error;
      data = result.data || [];
      branding = publishedBranding;
    } catch (dbError) {
      console.error("[settings] Supabase data source unavailable:", dbError);
      throw dbError;
    }

    return NextResponse.json(buildPublicSettingsDto(data, branding));
  } catch (err) {
    console.error("Failed to fetch settings:", err);
    return NextResponse.json({ error: "获取设置失败" }, { status: 500 });
  }
}

// PUT /api/settings - 更新平台设置（仅管理员）
export async function PUT(request: NextRequest) {
  const requestKey = (request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "").slice(0, 200);
  const authorizations: Array<{
    scope: AdminPlatformSettingScope;
    authorization: Extract<Awaited<ReturnType<typeof authorizeAdminCapability>>, { ok: true }>;
  }> = [];
  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
      throw new PlatformSettingValidationError("设置请求超过 256KB", "PLATFORM_SETTINGS_REQUEST_TOO_LARGE");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new PlatformSettingValidationError("请求体不是有效 JSON", "PLATFORM_SETTINGS_REQUEST_INVALID");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PlatformSettingValidationError("请求体必须是对象", "PLATFORM_SETTINGS_REQUEST_INVALID");
    }
    const settings = (body as Record<string, unknown>).settings;
    const rawSettings = settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings as Record<string, unknown>
      : {};
    const reservedKey = Object.keys(rawSettings).find((key) => isReservedPlatformSettingKey(key) || VERSIONED_WORKSPACE_SETTING_KEYS.has(key));
    if (reservedKey) {
      throw new PlatformSettingValidationError(
        "版本化工作台或漫剧配置只能通过专用配置控制平面修改",
        "VERSIONED_PLATFORM_SETTING_KEY",
        reservedKey,
      );
    }
    const patch = parsePlatformSettingPatch(settings, "general");
    const requestedKeys = Object.keys(patch.values);
    if (!requestedKeys.length) {
      throw new PlatformSettingValidationError("没有可保存的设置项", "PLATFORM_SETTINGS_EMPTY");
    }
    const scopes = adminPlatformSettingScopesForKeys(requestedKeys);
    for (const scope of scopes) {
      const authorization = await authorizeAdminCapability(
        request,
        adminPlatformSettingPermission(scope, "write"),
        { operation: `platform_settings_${scope}_write`, requireStepUp: true },
      );
      if (!authorization.ok) return authorization.response;
      authorizations.push({ scope, authorization });
    }
    const values = Object.fromEntries(Object.entries(patch.values).filter(
      ([key, value]) => !isPlatformSecretSettingKey(key) || !isBlankOrMaskedSecret(value),
    ));
    const keys = Object.keys(values);
    const client = getSupabaseAdminClient();
    const current = keys.length
      ? await client.from("platform_settings").select("setting_key,setting_value").in("setting_key", keys)
      : { data: [], error: null };
    if (current.error) throw current.error;
    const currentRows = (current.data || []) as Array<{ setting_key: string; setting_value: string | null }>;
    const currentValues = new Map(currentRows.map((row) => [row.setting_key, row.setting_value || ""]));
    const changedKeys = keys.filter((key) => currentValues.get(key) !== values[key]);
    if (changedKeys.length) {
      const updatedAt = new Date().toISOString();
      const { error } = await client.from("platform_settings").upsert(
        changedKeys.map((key) => ({ setting_key: key, setting_value: values[key], updated_at: updatedAt })),
        { onConflict: "setting_key" },
      );
      if (error) throw error;
    }
    if (changedKeys.some((key) => key.startsWith("coze_"))) clearCozeConfigCache();
    for (const item of authorizations) {
      await appendAdminGovernanceAudit({
        actorId: item.authorization.actor.userId,
        actorLevel: item.authorization.access.adminLevel,
        permissionKey: adminPlatformSettingPermission(item.scope, "write"),
        action: `platform_settings_${item.scope}_write`,
        result: "success",
        reasonCode: "PLATFORM_SETTINGS_UPDATED",
        resource: `platform_settings:${item.scope}`,
        request,
        requestKey,
        metadata: { changedKeys, ignoredKeys: patch.ignoredKeys },
      });
    }
    return NextResponse.json({ success: true, scopes, changedKeys, ignoredKeys: patch.ignoredKeys });
  } catch (err) {
    const code = err instanceof PlatformSettingValidationError ? err.code : "PLATFORM_SETTINGS_WRITE_FAILED";
    for (const item of authorizations) {
      await appendAdminGovernanceAudit({
        actorId: item.authorization.actor.userId,
        actorLevel: item.authorization.access.adminLevel,
        permissionKey: adminPlatformSettingPermission(item.scope, "write"),
        action: `platform_settings_${item.scope}_write`,
        result: "failure",
        reasonCode: code,
        resource: `platform_settings:${item.scope}`,
        request,
        requestKey,
        metadata: err instanceof PlatformSettingValidationError && err.settingKey ? { settingKey: err.settingKey } : {},
      });
    }
    console.error("Failed to update settings:", err);
    return err instanceof PlatformSettingValidationError
      ? NextResponse.json({ error: err.message, code: err.code, setting_key: err.settingKey }, { status: 400 })
      : NextResponse.json({ error: "更新设置失败", code }, { status: 500 });
  }
}
