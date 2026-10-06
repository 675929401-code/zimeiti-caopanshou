export const PLATFORM_SECRET_SETTING_KEYS = [
  "coze_api_token",
  "coze_coding_api_token",
  "cover_workflow_token",
  "thinking_model_api_key",
  "extract_api_token",
  "xunhu_secret",
  "epay_key",
  "email_smtp_pass",
] as const;

const PLATFORM_SECRET_SETTING_KEY_SET = new Set<string>(PLATFORM_SECRET_SETTING_KEYS);

export function isPlatformSecretSettingKey(key: string): boolean {
  return PLATFORM_SECRET_SETTING_KEY_SET.has(key);
}

export function isBlankOrMaskedSecret(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  return /^(?:\*{3,}|•{3,}|已配置|configured)$/i.test(normalized);
}

export function redactPlatformSettings(
  rows: Array<{ setting_key: string; setting_value: string | null }>,
): Record<string, string | boolean> {
  const settings: Record<string, string | boolean> = {};
  for (const item of rows) {
    if (isPlatformSecretSettingKey(item.setting_key)) {
      settings[`${item.setting_key}_configured`] = Boolean(item.setting_value?.trim());
      continue;
    }
    settings[item.setting_key] = item.setting_value || "";
  }
  return settings;
}
