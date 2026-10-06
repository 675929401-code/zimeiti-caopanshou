import {
  normalizeTheme,
  normalizeThemeModePreference,
  type ThemeModePreference,
} from "@/lib/themes";

export type StoredUserAppearancePreference = {
  user_id: string;
  theme_key: string;
  mode_preference: string;
  ip_hash: string;
  expires_at: string;
  updated_at: string;
};

export type UserAppearanceLeaseStatus = "active" | "none" | "expired" | "ip_changed";

export type EvaluatedUserAppearanceLease = {
  status: UserAppearanceLeaseStatus;
  theme: string | null;
  modePreference: ThemeModePreference | null;
  expiresAt: string | null;
};

/** Pure lease evaluation shared by the server store and zero-cost tests. */
export function evaluateUserAppearanceLease(
  row: StoredUserAppearancePreference | null,
  currentIPHash: string,
  now: Date,
): EvaluatedUserAppearanceLease {
  if (!row) {
    return { status: "none", theme: null, modePreference: null, expiresAt: null };
  }

  const expiresAt = new Date(row.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", theme: null, modePreference: null, expiresAt: null };
  }

  if (row.ip_hash !== currentIPHash) {
    return { status: "ip_changed", theme: null, modePreference: null, expiresAt: null };
  }

  const modePreference = normalizeThemeModePreference(row.mode_preference);
  if (!modePreference || normalizeTheme(row.theme_key) !== row.theme_key) {
    return { status: "none", theme: null, modePreference: null, expiresAt: null };
  }

  return {
    status: "active",
    theme: row.theme_key,
    modePreference,
    expiresAt: expiresAt.toISOString(),
  };
}
