export const THEME_COLOR_SETTING_KEYS = [
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
] as const;

export type ThemeColorSettingKey = (typeof THEME_COLOR_SETTING_KEYS)[number];

export type ThemeColorSettings = Partial<Record<ThemeColorSettingKey, string>>;

export const MANAGED_THEME_COLOR_CSS_VARS = [
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--sidebar-ring",
  "--brand",
  "--msg-think-border",
  "--theme-glow",
  "--accent-foreground",
  "--theme-accent-color",
  "--theme-gradient-start",
  "--theme-gradient-mid",
  "--theme-gradient-end",
] as const;

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(value?: string | null): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value.trim());
}

export function normalizeHexColor(value: string | undefined, fallback: string): string {
  return isValidHexColor(value) ? value.trim() : fallback;
}

export function getThemeColorCssVars(settings: ThemeColorSettings) {
  // These settings are retained for backward-compatible admin read/write only.
  // The four standardized themes own their semantic tokens in scoped CSS. Writing
  // legacy colors to <html> would outrank those theme tokens and mix the former
  // legacy colors to <html> would mix the former blue/cyan/purple palette into them.
  void settings;
  return {} as Record<string, string>;
}

export function applyThemeColorSettings(settings: ThemeColorSettings) {
  if (typeof document === "undefined") return;

  const vars = getThemeColorCssVars(settings);
  MANAGED_THEME_COLOR_CSS_VARS.forEach((key) => {
    if (!(key in vars)) document.documentElement.style.removeProperty(key);
  });
  Object.entries(vars).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
}
