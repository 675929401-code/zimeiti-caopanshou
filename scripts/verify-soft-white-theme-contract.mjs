import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const themes = read("src/lib/themes.ts");
const layout = read("src/app/layout.tsx");
const css = read("src/app/theme-soft-white.css");
const switcher = read("src/components/user-theme-switcher.tsx");
const marketplace = read("src/components/agent-marketplace.tsx");
const admin = read("src/app/admin/page.tsx");
const darkCss = read("src/app/theme-lattice.css");
const landing = read("src/components/landing-page.tsx");
const landingCss = read("src/components/landing/soft-white-landing.css");
const runtimeColors = read("src/lib/theme-color-settings.ts");

const checks = [
  ["soft white is the deployment-safe platform default", themes.includes('DEFAULT_THEME = "soft-white"') && themes.includes('DEFAULT_MODE_PREFERENCE: ThemeModePreference = "light"')],
  ["soft white is the only fixed light theme", themes.includes('LIGHT_THEMES: readonly string[] = ["soft-white"]')],
  ["three user themes use product names", themes.includes('id: "lattice", label: "深空晶"') && themes.includes('id: "soft-white", label: "柔光白"') && themes.includes('id: "crystal-aurora", label: "黑曜霓彩"')],
  ["three admin themes use product names", themes.includes('id: "lattice", name: "深空晶"') && themes.includes('id: "soft-white", name: "柔光白"') && themes.includes('id: "crystal-aurora", name: "黑曜霓彩"')],
  ["cross-theme readability guard is loaded last", layout.indexOf('import "./ui-shell-fixes.css";') > layout.indexOf('import "./theme-soft-white.css";')],
  ["pre-hydration allowlist comes from registry", layout.includes("var allowedThemes = ${SERIALIZED_VALID_THEMES};")],
  ["pre-hydration keeps every selected theme on its own homepage and login palette", layout.includes("var selectedMode = lightThemes.indexOf(selectedTheme) >= 0 ? 'light' : 'dark';") && layout.includes("var renderedTheme = selectedTheme;")],
  ["pre-hydration no longer forces dark", !layout.includes("localStorage.setItem('app_mode', 'dark')")],
  ["soft white stylesheet is independently scoped", css.includes('html[data-theme="soft-white"][data-mode="light"]') && !css.includes('html[data-theme="lattice"][data-mode="light"]')],
  ["page background has no decorative image", css.includes("background-image: none !important;")],
  ["light workbench uses warm neutral tokens", css.includes("--vs-bg: #f5f3ee;") && css.includes("--vs-primary: #17675a;")],
  ["dark theme uses restrained semantic tokens", darkCss.includes("--background: #0d141a;") && darkCss.includes("--primary: #68c7b4;")],
  ["focus state is visible and theme aligned", css.includes("--ui-focus: 0 0 0 3px rgba(11, 116, 102, 0.2);")],
  ["conversation history has distinct active hierarchy", css.includes(".sidebar-conv-item.active") && css.includes("inset 3px 0 #17675a")],
  ["compact theme trigger is used in primary navigation", switcher.includes("labeled?: boolean") && marketplace.includes("<UserThemeSwitcher />")],
  ["theme choices are machine-testable", switcher.includes("data-theme-option={option.id}")],
  ["admin no longer overwrites stored theme", !admin.includes("...(data.settings || {}), theme: DEFAULT_THEME")],
  ["legacy API colors cannot overwrite semantic tokens", runtimeColors.includes("return {} as Record<string, string>")],
  ["both themes share the business homepage", landing.includes('themeId === "soft-white" || themeId === "lattice"')],
  ["homepage owns vertical desktop scrolling", landingCss.includes("height: 100dvh") && landingCss.includes("overflow-y: auto")],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
} else {
  console.log(`Soft-white theme contract passed (${checks.length}/${checks.length}).`);
}
