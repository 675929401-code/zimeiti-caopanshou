import "server-only";

import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  normalizeTheme,
  normalizeThemeModePreference,
  type ThemeModePreference,
} from "@/lib/themes";
import { THEME_COLOR_SETTING_KEYS, type ThemeColorSettings } from "@/lib/theme-color-settings";

export const PLATFORM_APPEARANCE_SETTING_KEYS = [
  "theme",
  "theme_mode",
  ...THEME_COLOR_SETTING_KEYS,
] as const;

export interface PublicPlatformAppearance {
  settings: ThemeColorSettings & {
    theme: string;
    theme_mode: ThemeModePreference;
  };
  authority: {
    source: "platform_settings" | "safe_default";
    authoritative: boolean;
    publishedAt: string | null;
  };
}

export interface PlatformAppearance {
  theme: string;
  modePreference: ThemeModePreference;
  authoritative: boolean;
}

function safeDefaultAppearance(): PublicPlatformAppearance {
  return {
    settings: {
      theme: DEFAULT_THEME,
      theme_mode: DEFAULT_MODE_PREFERENCE,
    },
    authority: {
      source: "safe_default",
      authoritative: false,
      publishedAt: null,
    },
  };
}

/**
 * Public appearance is deliberately independent from the versioned branding
 * control plane. A missing brand migration or brand asset outage must not stop
 * the theme bootstrap from returning a trustworthy theme/mode pair.
 */
export async function readPublicPlatformAppearance(): Promise<PublicPlatformAppearance> {
  try {
    const { data, error } = await getSupabaseAdminClient()
      .from("platform_settings")
      .select("setting_key, setting_value, updated_at")
      .in("setting_key", [...PLATFORM_APPEARANCE_SETTING_KEYS]);

    if (error) throw error;

    const settings = new Map<string, string>();
    const updatedAtValues: string[] = [];
    for (const item of data || []) {
      if (typeof item?.setting_key === "string" && typeof item?.setting_value === "string") {
        settings.set(item.setting_key, item.setting_value);
      }
      if (typeof item?.updated_at === "string" && Number.isFinite(Date.parse(item.updated_at))) {
        updatedAtValues.push(item.updated_at);
      }
    }

    const colors = Object.fromEntries(
      THEME_COLOR_SETTING_KEYS.flatMap((key) => {
        const value = settings.get(key);
        return value ? [[key, value]] : [];
      }),
    ) as ThemeColorSettings;

    return {
      settings: {
        ...colors,
        theme: normalizeTheme(settings.get("theme")),
        theme_mode: normalizeThemeModePreference(settings.get("theme_mode"))
          || DEFAULT_MODE_PREFERENCE,
      },
      authority: {
        source: "platform_settings",
        authoritative: true,
        publishedAt: updatedAtValues.sort().at(-1) || null,
      },
    };
  } catch (error) {
    console.warn("[appearance] public platform appearance unavailable", error);
    return safeDefaultAppearance();
  }
}

/**
 * Read the two public appearance values directly for the server rendered root.
 * The browser API remains the client side authority after hydration, while this
 * read prevents the first paint from falling back to a hard coded theme.
 */
export async function readPlatformAppearance(): Promise<PlatformAppearance> {
  const appearance = await readPublicPlatformAppearance();
  return {
    theme: appearance.settings.theme,
    modePreference: appearance.settings.theme_mode,
    authoritative: appearance.authority.authoritative,
  };
}
