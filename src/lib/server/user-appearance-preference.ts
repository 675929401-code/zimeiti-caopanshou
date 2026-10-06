import "server-only";

import { createHmac } from "node:crypto";
import { getClientIP } from "@/lib/security";
import { requireServerSecret } from "@/lib/server-secrets";
import {
  USER_APPEARANCE_PREFERENCE_TTL_MS,
  normalizeTheme,
  normalizeThemeModePreference,
  type ThemeModePreference,
} from "@/lib/themes";
import {
  evaluateUserAppearanceLease,
  type StoredUserAppearancePreference,
} from "@/lib/user-appearance-preference-contract";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const TABLE = "user_appearance_preferences";

export type ActiveUserAppearancePreference = {
  theme: string;
  modePreference: ThemeModePreference;
  expiresAt: string;
};

export type UserAppearancePreferenceStatus =
  | "active"
  | "none"
  | "expired"
  | "ip_changed"
  | "storage_unavailable";

export type UserAppearancePreferenceResult = {
  preference: ActiveUserAppearancePreference | null;
  status: UserAppearancePreferenceStatus;
};

function isMissingAppearancePreferenceTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = String(value.code || "");
  const text = `${String(value.message || "")} ${String(value.details || "")}`;
  return code === "42P01" || code === "PGRST205" || /user_appearance_preferences.*(?:does not exist|schema cache)/iu.test(text);
}

/** HMAC protects the low-entropy IP value from offline enumeration. */
export function fingerprintAppearanceRequestIP(request: Request): string {
  const secret = process.env.SECURITY_INTERNAL_KEY?.trim() || requireServerSecret("JWT_SECRET");
  const clientIP = getClientIP(request).trim().toLowerCase();
  return createHmac("sha256", secret)
    .update(`appearance-ip:v1:${clientIP}`)
    .digest("hex");
}

export async function readUserAppearancePreference(
  userId: string,
  request: Request,
  now = new Date(),
): Promise<UserAppearancePreferenceResult> {
  const client = getSupabaseAdminClient();
  const result = await client
    .from(TABLE)
    .select("user_id, theme_key, mode_preference, ip_hash, expires_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    if (isMissingAppearancePreferenceTable(result.error)) {
      return { preference: null, status: "storage_unavailable" };
    }
    throw result.error;
  }

  const row = result.data as StoredUserAppearancePreference | null;
  const lease = evaluateUserAppearanceLease(row, fingerprintAppearanceRequestIP(request), now);
  if (lease.status !== "active" || !lease.theme || !lease.modePreference || !lease.expiresAt) {
    return { preference: null, status: lease.status };
  }

  return {
    preference: {
      theme: lease.theme,
      modePreference: lease.modePreference,
      expiresAt: lease.expiresAt,
    },
    status: "active",
  };
}

export async function saveUserAppearancePreference(
  userId: string,
  request: Request,
  theme: string,
  modePreference: ThemeModePreference,
  now = new Date(),
): Promise<ActiveUserAppearancePreference> {
  const normalizedTheme = normalizeTheme(theme);
  const normalizedMode = normalizeThemeModePreference(modePreference);
  if (normalizedTheme !== theme || !normalizedMode) {
    throw new Error("INVALID_USER_APPEARANCE_PREFERENCE");
  }

  const expiresAt = new Date(now.getTime() + USER_APPEARANCE_PREFERENCE_TTL_MS);
  const client = getSupabaseAdminClient();
  const result = await client.from(TABLE).upsert({
    user_id: userId,
    theme_key: normalizedTheme,
    mode_preference: normalizedMode,
    ip_hash: fingerprintAppearanceRequestIP(request),
    expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  }, { onConflict: "user_id" });

  if (result.error) {
    if (isMissingAppearancePreferenceTable(result.error)) {
      throw new Error("USER_APPEARANCE_PREFERENCE_STORAGE_NOT_READY");
    }
    throw result.error;
  }

  // Keep the historical column synchronized for rollback compatibility. It is
  // no longer trusted for expiry or IP checks by current code.
  await client.from("users").update({ theme_preference: normalizedTheme }).eq("id", userId);

  return {
    theme: normalizedTheme,
    modePreference: normalizedMode,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function clearUserAppearancePreference(userId: string): Promise<void> {
  const client = getSupabaseAdminClient();
  const result = await client.from(TABLE).delete().eq("user_id", userId);
  if (result.error && !isMissingAppearancePreferenceTable(result.error)) throw result.error;
  await client.from("users").update({ theme_preference: null }).eq("id", userId);
}
