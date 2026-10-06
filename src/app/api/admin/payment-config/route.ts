import { NextRequest, NextResponse } from "next/server";
import {
  PAYMENT_PLATFORM_SETTING_KEYS,
  PlatformSettingValidationError,
  parsePlatformSettingPatch,
} from "@/lib/platform-settings-contract";
import { clearConfigCache as clearEpayConfigCache } from "@/lib/epay";
import { clearConfigCache as clearXunhuConfigCache } from "@/lib/xunhupay";
import { validateSafeUrl } from "@/lib/safe-fetch";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import { readBoundedPaymentConfigBody } from "@/lib/server/payment-config-request-body";
import {
  isBlankOrMaskedSecret,
  isPlatformSecretSettingKey,
  redactPlatformSettings,
} from "@/lib/server/platform-secret-settings";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type PaymentAuthorization = Extract<AdminCapabilityResult, { ok: true }>;
const XUNHU_OUTBOUND_GATEWAY_KEYS = [
  "xunhu_gateway",
  "xunhu_gateway_backup",
  "xunhu_refund_gateway",
  "xunhu_refund_gateway_backup",
] as const;
const TRUSTED_XUNHU_GATEWAY_HOSTS = ["api.xunhupay.com", "api.dpweixin.com"] as const;

async function validateXunhuGatewayTargets(values: Record<string, string>): Promise<void> {
  for (const key of XUNHU_OUTBOUND_GATEWAY_KEYS) {
    const value = values[key]?.trim();
    if (!value) continue;
    try {
      await validateSafeUrl(value, {
        allowedPorts: [443],
        trustedHostnames: [...TRUSTED_XUNHU_GATEWAY_HOSTS],
      });
    } catch {
      throw new PlatformSettingValidationError(
        `${key} 必须解析到公网 HTTPS 地址`,
        "INVALID_XUNHU_GATEWAY_URL",
        key,
      );
    }
  }
}

async function auditPaymentConfig(
  request: NextRequest,
  authorization: PaymentAuthorization,
  result: "allowed" | "success" | "failure",
  reasonCode: string,
  metadata: Record<string, unknown> = {},
) {
  return appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "payment.settings.manage",
    action: request.method === "GET" ? "payment_config_read" : "payment_config_patch",
    result,
    reasonCode,
    resource: "platform_settings:payment",
    request,
    requestKey: (request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "").slice(0, 200),
    metadata,
  });
}

async function authorizePaymentConfig(request: NextRequest) {
  return authorizeAdminCapability(request, "payment.settings.manage", {
    operation: request.method === "GET" ? "payment_config_read" : "payment_config_patch",
    requireStepUp: true,
  });
}

export async function GET(request: NextRequest) {
  const authorization = await authorizePaymentConfig(request);
  if (!authorization.ok) return authorization.response;

  try {
    const { data, error } = await getSupabaseAdminClient()
      .from("platform_settings")
      .select("setting_key,setting_value")
      .in("setting_key", [...PAYMENT_PLATFORM_SETTING_KEYS]);
    if (error) throw error;

    const settings = redactPlatformSettings(data || []);
    await auditPaymentConfig(request, authorization, "success", "PAYMENT_CONFIG_READ");
    return NextResponse.json({ settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to fetch payment configuration:", error);
    await auditPaymentConfig(request, authorization, "failure", "PAYMENT_CONFIG_READ_FAILED");
    return NextResponse.json(
      { error: "读取支付配置失败", code: "PAYMENT_CONFIG_READ_FAILED" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizePaymentConfig(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await readBoundedPaymentConfigBody(request);
    const patch = parsePlatformSettingPatch(body, "payment");
    await validateXunhuGatewayTargets(patch.values);

    const values = Object.fromEntries(Object.entries(patch.values).filter(
      ([key, value]) => !isPlatformSecretSettingKey(key) || !isBlankOrMaskedSecret(value),
    ));
    const keys = Object.keys(values);
    const database = getSupabaseAdminClient();
    const current = keys.length
      ? await database.from("platform_settings").select("setting_key,setting_value").in("setting_key", keys)
      : { data: [], error: null };
    if (current.error) throw current.error;

    const currentValues = new Map(
      ((current.data || []) as Array<{ setting_key: string; setting_value: string | null }>)
        .map((row) => [row.setting_key, row.setting_value || ""]),
    );
    const changedKeys = keys.filter((key) => currentValues.get(key) !== values[key]);

    if (changedKeys.length) {
      // A strict, durable mutation-intent record is written before any payment
      // credential changes. If the audit store is unavailable, fail closed and
      // leave the current payment configuration untouched.
      const intentAudited = await auditPaymentConfig(
        request,
        authorization,
        "allowed",
        "PAYMENT_CONFIG_PATCH_AUTHORIZED",
        { changedKeys, ignoredKeys: patch.ignoredKeys },
      );
      if (!intentAudited) {
        return NextResponse.json(
          { error: "支付配置审计暂不可用，本次修改未执行", code: "PAYMENT_CONFIG_AUDIT_UNAVAILABLE" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      const updatedAt = new Date().toISOString();
      const { error } = await database.from("platform_settings").upsert(
        changedKeys.map((key) => ({ setting_key: key, setting_value: values[key], updated_at: updatedAt })),
        { onConflict: "setting_key" },
      );
      if (error) throw error;
      clearXunhuConfigCache();
      clearEpayConfigCache();
    }

    const resultAudited = await auditPaymentConfig(request, authorization, "success", "PAYMENT_CONFIG_UPDATED", {
      changedKeys,
      ignoredKeys: patch.ignoredKeys,
    });
    return NextResponse.json(
      {
        success: true,
        changedKeys,
        ignoredKeys: patch.ignoredKeys,
        auditStatus: resultAudited ? "complete" : "authorized_intent_only",
        ...(!resultAudited ? { warning: "配置已生效，结果审计待运维核查；授权变更记录已保留" } : {}),
      },
      { status: resultAudited ? 200 : 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = error instanceof PlatformSettingValidationError
      ? error.code
      : "PAYMENT_CONFIG_WRITE_FAILED";
    await auditPaymentConfig(request, authorization, "failure", code, {
      ...(error instanceof PlatformSettingValidationError && error.settingKey
        ? { settingKey: error.settingKey }
        : {}),
    });
    console.error("Failed to update payment configuration:", error);
    return error instanceof PlatformSettingValidationError
      ? NextResponse.json(
          { error: error.message, code: error.code, setting_key: error.settingKey },
          {
            status: error.code === "PAYMENT_CONFIG_REQUEST_TOO_LARGE" ? 413 : 400,
            headers: { "Cache-Control": "no-store" },
          },
        )
      : NextResponse.json(
          { error: "保存支付配置失败", code },
          { status: 500, headers: { "Cache-Control": "no-store" } },
        );
  }
}
