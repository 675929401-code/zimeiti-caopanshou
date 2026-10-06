import "server-only";

export const MANJU_PLATFORM_SETTINGS_PREFIX = "manju.config.v1.";

export function isReservedPlatformSettingKey(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MANJU_PLATFORM_SETTINGS_PREFIX);
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
