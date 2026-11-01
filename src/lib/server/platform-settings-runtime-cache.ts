import "server-only";

import { invalidateGlobalSystemPrefixCache } from "@/app/api/llm/llm-state";
import { invalidateBillingConfigCache } from "@/lib/billing";
import { clearCozeConfigCache } from "@/lib/coze-api";
import { invalidateEmailConfigCache } from "@/lib/email";
import { invalidateAutoAvatarSettingsCache } from "@/lib/auto-avatar/settings";

const BILLING_SETTING_KEYS = new Set([
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
  "credits_per_yuan",
  "token_rounding_enabled",
  "token_rounding_unit",
  "token_rounding_min",
  "token_rounding_max",
]);

const EMAIL_SETTING_KEYS = new Set([
  "email_smtp_host",
  "email_smtp_port",
  "email_smtp_user",
  "email_smtp_pass",
  "email_from",
]);

/**
 * Call immediately after a successful settings write, even if later readback or
 * audit fails. Only this process is invalidated; other processes retain their TTLs.
 * Invalidating does not send/verify mail or mutate previously captured snapshots.
 */
export function invalidatePlatformSettingsRuntimeCaches(changedKeys: readonly string[]): void {
  if (changedKeys.includes("auto_avatar_enabled")) invalidateAutoAvatarSettingsCache();
  if (changedKeys.includes("global_system_prefix")) invalidateGlobalSystemPrefixCache();
  if (changedKeys.some((key) => key.startsWith("coze_"))) clearCozeConfigCache();
  if (changedKeys.some((key) => BILLING_SETTING_KEYS.has(key))) invalidateBillingConfigCache();
  if (changedKeys.some((key) => EMAIL_SETTING_KEYS.has(key))) invalidateEmailConfigCache();
}
