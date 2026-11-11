import "server-only";
import { COVER_STYLE_SETTING_KEY } from "./cover-style-config";

export const MANJU_PLATFORM_SETTINGS_PREFIX = "manju.config.v1.";

export function isReservedPlatformSettingKey(value: unknown): boolean {
  return typeof value === "string" && (value.startsWith(MANJU_PLATFORM_SETTINGS_PREFIX) || value === COVER_STYLE_SETTING_KEY);
}

export function findReservedPlatformSettingKeys(rows: readonly unknown[]): string[] {
  const found = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const key = (row as { setting_key?: unknown }).setting_key;
    if (isReservedPlatformSettingKey(key)) found.add(String(key));
  }
  return [...found].sort();
}
