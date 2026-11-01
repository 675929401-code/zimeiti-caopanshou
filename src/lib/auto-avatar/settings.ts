import { getSupabaseClient } from "@/storage/database/supabase-client";

// Keep this module independent of the image generator: settings saves must not
// initialize provider SDKs or perform any generation/storage work.
let enabledCache = true;
let cacheTime = 0;
let settingsEpoch = 0;
let verifiedEpoch = -1;
const SWITCH_CACHE_TTL = 1000;

export function invalidateAutoAvatarSettingsCache(): void {
  settingsEpoch++;
  cacheTime = 0;
}

export async function isAutoAvatarEnabled(): Promise<boolean> {
  if (process.env.AUTO_AVATAR_ENABLED === "false") return false;

  for (;;) {
    if (Date.now() - cacheTime < SWITCH_CACHE_TTL) return verifiedEpoch === settingsEpoch && enabledCache;
    const readEpoch = settingsEpoch;
    let nextEnabled = enabledCache;
    let readSucceeded = false;
    try {
      const { data, error } = await getSupabaseClient()
        .from("platform_settings")
        .select("setting_value")
        .eq("setting_key", "auto_avatar_enabled")
        .maybeSingle();
      if (error) throw error;
      nextEnabled = data?.setting_value !== "false";
      readSucceeded = true;
    } catch {
      // Preserve the last valid state, including an explicit disabled state.
    }
    // This value is an admission decision, not an in-flight price snapshot.
    // A save during the read requires re-reading, even on an error/fallback.
    if (readEpoch !== settingsEpoch) continue;
    if (readSucceeded) {
      enabledCache = nextEnabled;
      verifiedEpoch = readEpoch;
    }
    cacheTime = Date.now();
    // A successful save invalidates the old admission decision. Keep the old
    // value for recovery, but do not admit automatically until this epoch has
    // been read successfully (an unavailable DB must not undo a saved disable).
    return verifiedEpoch === settingsEpoch && enabledCache;
  }
}
