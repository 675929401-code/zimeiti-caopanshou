"use client";

import { useEffect } from "react";
import { applyThemeColorSettings } from "@/lib/theme-color-settings";
import { DEFAULT_MODE_PREFERENCE, normalizeTheme, normalizeThemeModePreference } from "@/lib/themes";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeSetItem as safeSet } from "@/lib/safe-storage";
import {
  getClientBootstrapAppearance,
  invalidateClientBootstrapAppearance,
} from "@/lib/client-bootstrap-cache";

export function ThemeInit() {
  useEffect(() => {
    let cancelled = false;

    // Clear inline variables left by the retired global color override before
    // client-side color settings are restored. layout/app-context own all
    // data-theme and data-mode attributes so this bootstrap cannot race them.
    applyThemeColorSettings({});

    const syncThemeColors = async (force = false) => {
      try {
        const response = await getClientBootstrapAppearance({ force });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          applyThemeColorSettings(data.settings || {});
          const platformTheme = normalizeTheme(data.settings?.theme);
          const platformMode = normalizeThemeModePreference(data.settings?.theme_mode)
            || DEFAULT_MODE_PREFERENCE;
          safeSet(STORAGE_KEYS.PLATFORM_THEME, platformTheme);
          safeSet(STORAGE_KEYS.PLATFORM_THEME_MODE, platformMode);
        }
      } catch {
        // CSS defaults remain active when settings are unavailable.
      }
    };

    const handleThemeUpdated = () => {
      invalidateClientBootstrapAppearance();
      void syncThemeColors(true);
    };

    void syncThemeColors();
    window.addEventListener("theme-updated", handleThemeUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("theme-updated", handleThemeUpdated);
    };
  }, []);

  return null;
}
