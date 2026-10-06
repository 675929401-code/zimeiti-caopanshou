/**
 * 全站主题统一注册表（单一数据源）
 *
 * 当前在线主题：
 *   lattice        深空晶（固定深色主题，保留晶格结构光）
 *   soft-white     柔光白（固定浅色主题）
 *   crystal-aurora 黑曜霓彩（固定深色主题，黑曜底座与青蓝双色结构光）
 *
 * 安全机制：
 *   所有入口（用户偏好 DB / localStorage / 管理员设置）必须经过
 *   normalizeTheme() 校验——已下线或未知主题统一回退到默认主题，
 *   防止 CSS 变量缺失导致页面无样式。
 */

/**
 * 平台未发布外观或外观读取暂不可用时的安全兜底。
 * 2026-10-03 起全平台默认发布为柔光白，确保首次访问、部署切换和
 * 数据库短暂不可用时不会回落到另一套主题。
 */
export const DEFAULT_THEME = "soft-white";

export type ThemeMode = "light" | "dark";

/**
 * 三套主题均为完整、固定的明暗视觉。持久化层保留 system/light/dark
 * 兼容值，实际渲染仍由主题自身决定，避免系统外观把柔光白切成深色。
 */
export const THEME_MODE_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemeModePreference = (typeof THEME_MODE_PREFERENCES)[number];

/** 柔光白是默认固定浅色主题；平台未写入设置时也必须保持浅色。 */
export const DEFAULT_MODE_PREFERENCE: ThemeModePreference = "light";

/** 用户个性化外观恰好保留七天；服务端 IP 指纹变化会提前失效。 */
export const USER_APPEARANCE_PREFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 浅色主题清单：命中则 data-mode="light"，否则 dark */
export const LIGHT_THEMES: readonly string[] = ["soft-white"];

/** 合法主题白名单：旧主题与未知主题一律回退到默认主题 */
export const VALID_THEMES: readonly string[] = [
  "lattice",
  "soft-white",
  "crystal-aurora",
];

/** 主题合法性收敛：已下线/未知主题 → 默认主题 */
export function normalizeTheme(theme: string | null | undefined): string {
  return theme && VALID_THEMES.includes(theme) ? theme : DEFAULT_THEME;
}

/**
 * 兼容旧偏好的明暗推断。只在用户尚未保存独立模式偏好时使用，
 * 不参与后续主题切换，避免主题 key 再次绑死明暗模式。
 */
export function modeForTheme(theme: string): ThemeMode {
  return LIGHT_THEMES.includes(theme) ? "light" : "dark";
}

export function normalizeThemeModePreference(value: string | null | undefined): ThemeModePreference | null {
  if (THEME_MODE_PREFERENCES.includes(value as ThemeModePreference)) {
    return value as ThemeModePreference;
  }
  return null;
}

export function resolveThemeMode(_preference: ThemeModePreference, systemPrefersDark: boolean): ThemeMode {
  return systemPrefersDark ? "dark" : "light";
}

/** 将系统明暗映射为单色主题：柔光白永远保持白色。 */
export function resolveThemeModeForTheme(
  theme: string,
  _preference: ThemeModePreference,
  _systemPrefersDark: boolean,
): ThemeMode {
  return modeForTheme(normalizeTheme(theme));
}

/**
 * 主题选择与实际渲染保持一一对应。主页、登录抽屉和登录后的应用界面
 * 都读取同一个稳定主题 key，避免系统明暗状态替换用户选定的主题。
 */
export function resolveRenderedTheme(
  theme: string,
  _preference: ThemeModePreference,
  _mode: ThemeMode,
): string {
  return normalizeTheme(theme);
}

/** 用户端主题切换器（导航栏圆点）选项 */
export const USER_THEME_OPTIONS = [
  { id: "lattice", label: "深空晶", description: "深空底座、晶格结构光与澄澈重点", dot: "#6EE7E0", ring: "rgba(110,231,224,0.30)" },
  { id: "soft-white", label: "柔光白", description: "温润柔白底色、玉石强调与克制状态", dot: "#17675A", ring: "rgba(23,103,90,0.20)" },
  { id: "crystal-aurora", label: "黑曜霓彩", description: "黑曜底座、青绿与曜蓝双色结构光、霓彩功能图标", dot: "#28D5C0", ring: "rgba(40,213,192,0.28)" },
] as const;

/** 管理后台主题卡片选项（带预览色板） */
export const ADMIN_THEME_OPTIONS = [
  { id: "lattice", name: "深空晶", accent: "#6EE7E0", bg: "#112540", sidebar: "#07141F", desc: "深空底座、晶格结构光与澄澈重点" },
  { id: "soft-white", name: "柔光白", accent: "#17675A", bg: "#F5F3EE", sidebar: "#FFFEFB", desc: "温润柔白底色、清晰文字层级与克制状态色" },
  { id: "crystal-aurora", name: "黑曜霓彩", accent: "#28D5C0", bg: "#05070A", sidebar: "#060A0E", desc: "黑曜底座、青绿与曜蓝双色结构光、霓彩功能图标" },
] as const;
