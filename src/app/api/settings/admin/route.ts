import { NextRequest, NextResponse } from "next/server";
import { invalidateGlobalSystemPrefixCache } from "@/app/api/llm/llm-state";
import { clearCozeConfigCache } from "@/lib/coze-api";
import {
  adminPlatformSettingKeysForScope,
  adminPlatformSettingPermission,
  adminPlatformSettingScopeForKey,
  adminPlatformSettingScopesForKeys,
  isAdminPlatformSettingScope,
  PlatformSettingValidationError,
  parsePlatformSettingPatch,
  type AdminPlatformSettingScope,
} from "@/lib/platform-settings-contract";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import {
  isBlankOrMaskedSecret,
  isPlatformSecretSettingKey,
  redactPlatformSettings,
} from "@/lib/server/platform-secret-settings";
import { isReservedPlatformSettingKey } from "@/lib/server/platform-settings-reserved";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const VERSIONED_WORKSPACE_SETTING_KEYS = new Set([
  "workspace_model_assignment_overrides_v1",
  "image_model_surface_orders_v1",
  "video_model_surface_orders_v1",
]);

type SettingsAuthorization = Extract<AdminCapabilityResult, { ok: true }>;

function requestedScope(request: NextRequest): AdminPlatformSettingScope | null {
  const value = request.nextUrl.searchParams.get("scope");
  return isAdminPlatformSettingScope(value) ? value : null;
}

async function authorizeScope(request: NextRequest, scope: AdminPlatformSettingScope, mode: "read" | "write") {
  return authorizeAdminCapability(request, adminPlatformSettingPermission(scope, mode), {
    operation: `platform_settings_${scope}_${mode}`,
    requireStepUp: true,
  });
}

async function auditSettingsResult(
  request: NextRequest,
  authorization: SettingsAuthorization,
  scope: AdminPlatformSettingScope,
  mode: "read" | "write",
  result: "success" | "failure",
  reasonCode: string,
  metadata: Record<string, unknown> = {},
) {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: adminPlatformSettingPermission(scope, mode),
    action: `platform_settings_${scope}_${mode}`,
    result,
    reasonCode,
    resource: `platform_settings:${scope}`,
    request,
    requestKey: (request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "").slice(0, 200),
    metadata,
  });
}

// GET /api/settings/admin?scope=<scope> - 每次只读取一个授权域。
// 密钥值仍只返回 *_configured，不进入浏览器内存。
export async function GET(request: NextRequest) {
  const scope = requestedScope(request);
  if (!scope) {
    return NextResponse.json(
      { error: "请选择要读取的设置范围", code: "PLATFORM_SETTING_SCOPE_REQUIRED" },
      { status: 400 },
    );
  }
  const authorization = await authorizeScope(request, scope, "read");
  if (!authorization.ok) return authorization.response;

  try {
    const keys = adminPlatformSettingKeysForScope(scope);
    const { data, error } = await getSupabaseAdminClient()
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", [...keys]);
    if (error) throw error;
    await auditSettingsResult(request, authorization, scope, "read", "success", "PLATFORM_SETTINGS_SCOPE_READ", {
      keyCount: keys.length,
    });
    return NextResponse.json({ scope, settings: redactPlatformSettings(data || []) });
  } catch (error) {
    await auditSettingsResult(request, authorization, scope, "read", "failure", "PLATFORM_SETTINGS_READ_FAILED");
    console.error("Failed to fetch scoped admin settings:", error);
    return NextResponse.json({ error: "获取设置失败", code: "PLATFORM_SETTINGS_READ_FAILED" }, { status: 500 });
  }
}

// POST /api/settings/admin[?scope=<scope>] - 字段所属域决定写权限；scope 可进一步收窄请求。
export async function POST(request: NextRequest) {
  const authorizations: Array<{ scope: AdminPlatformSettingScope; authorization: SettingsAuthorization }> = [];
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
    const raw = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const reservedKey = Object.keys(raw)
      .find((key) => isReservedPlatformSettingKey(key) || VERSIONED_WORKSPACE_SETTING_KEYS.has(key));
    if (reservedKey) {
      throw new PlatformSettingValidationError(
        "版本化工作台或漫剧配置只能通过专用配置控制平面修改",
        "VERSIONED_PLATFORM_SETTING_KEY",
        reservedKey,
      );
    }

    const patch = parsePlatformSettingPatch(body, "admin");
    const keys = Object.keys(patch.values);
    if (!keys.length) {
      throw new PlatformSettingValidationError("没有可保存的设置项", "PLATFORM_SETTINGS_EMPTY");
    }
    const declaredScopeValue = request.nextUrl.searchParams.get("scope");
    if (declaredScopeValue && !isAdminPlatformSettingScope(declaredScopeValue)) {
      throw new PlatformSettingValidationError("设置范围无效", "PLATFORM_SETTING_SCOPE_INVALID");
    }
    const declaredScope = isAdminPlatformSettingScope(declaredScopeValue) ? declaredScopeValue : null;
    const outsideScopeKey = declaredScope
      ? keys.find((key) => adminPlatformSettingScopeForKey(key) !== declaredScope)
      : undefined;
    if (outsideScopeKey) {
      throw new PlatformSettingValidationError("提交内容超出当前设置范围", "PLATFORM_SETTING_SCOPE_MISMATCH", outsideScopeKey);
    }

    const scopes = adminPlatformSettingScopesForKeys(keys);
    for (const scope of scopes) {
      const authorization = await authorizeScope(request, scope, "write");
      if (!authorization.ok) return authorization.response;
      authorizations.push({ scope, authorization });
    }

    const values = Object.fromEntries(Object.entries(patch.values).filter(
      ([key, value]) => !isPlatformSecretSettingKey(key) || !isBlankOrMaskedSecret(value),
    ));
    const writeKeys = Object.keys(values);
    const database = getSupabaseAdminClient();
    const current = writeKeys.length
      ? await database.from("platform_settings").select("setting_key,setting_value").in("setting_key", writeKeys)
      : { data: [], error: null };
    if (current.error) throw current.error;
    const currentValues = new Map(
      ((current.data || []) as Array<{ setting_key: string; setting_value: string | null }>)
        .map((row) => [row.setting_key, row.setting_value || ""]),
    );
    const changedKeys = writeKeys.filter((key) => currentValues.get(key) !== values[key]);

    if (changedKeys.length) {
      const updatedAt = new Date().toISOString();
      const { error } = await database.from("platform_settings").upsert(
        changedKeys.map((key) => ({ setting_key: key, setting_value: values[key], updated_at: updatedAt })),
        { onConflict: "setting_key" },
      );
      if (error) throw error;
    }
    const persisted = writeKeys.length
      ? await database
        .from("platform_settings")
        .select("setting_key,setting_value,updated_at")
        .in("setting_key", writeKeys)
      : { data: [], error: null };
    if (persisted.error) throw persisted.error;
    const persistedRows = (persisted.data || []) as Array<{
      setting_key: string;
      setting_value: string | null;
      updated_at: string | null;
    }>;
    const persistedValues = new Map(persistedRows.map((row) => [row.setting_key, row.setting_value || ""]));
    const mismatchedKey = writeKeys.find((key) => persistedValues.get(key) !== values[key]);
    if (mismatchedKey) {
      throw new PlatformSettingValidationError(
        "设置已提交但数据库读回不一致，请刷新后重试",
        "PLATFORM_SETTINGS_READBACK_MISMATCH",
        mismatchedKey,
      );
    }
    if (changedKeys.includes("global_system_prefix")) invalidateGlobalSystemPrefixCache();
    if (changedKeys.some((key) => key.startsWith("coze_"))) clearCozeConfigCache();

    for (const item of authorizations) {
      await auditSettingsResult(request, item.authorization, item.scope, "write", "success", "PLATFORM_SETTINGS_SCOPE_UPDATED", {
        changedKeys: changedKeys.filter((key) => adminPlatformSettingScopeForKey(key) === item.scope),
        ignoredKeys: patch.ignoredKeys,
      });
    }
    const publicReceiptKeys = ["theme", "theme_mode"]
      .filter((key) => writeKeys.includes(key));
    const settings = Object.fromEntries(publicReceiptKeys.map((key) => [key, persistedValues.get(key) || ""]));
    const publishedAt = persistedRows
      .filter((row) => publicReceiptKeys.includes(row.setting_key) && row.updated_at)
      .map((row) => row.updated_at as string)
      .sort()
      .at(-1) || null;
    return NextResponse.json(
      {
        success: true,
        scopes,
        changedKeys,
        verifiedKeys: writeKeys,
        verification: "database-readback",
        ignoredKeys: patch.ignoredKeys,
        settings,
        publishedAt,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" } },
    );
  } catch (error) {
    const code = error instanceof PlatformSettingValidationError
      ? error.code
      : "PLATFORM_SETTINGS_WRITE_FAILED";
    for (const item of authorizations) {
      await auditSettingsResult(request, item.authorization, item.scope, "write", "failure", code, {
        ...(error instanceof PlatformSettingValidationError && error.settingKey
          ? { settingKey: error.settingKey }
          : {}),
      });
    }
    console.error("Failed to update scoped admin settings:", error);
    return error instanceof PlatformSettingValidationError
      ? NextResponse.json({ error: error.message, code: error.code, setting_key: error.settingKey }, { status: 400 })
      : NextResponse.json({ error: "保存设置失败", code }, { status: 500 });
  }
}
