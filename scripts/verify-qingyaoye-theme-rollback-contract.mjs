import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const themes = read("src/lib/themes.ts");
const themeCss = read("src/app/theme-crystal-aurora.css");
const homeCss = read("src/components/landing/operating-home-v2.css");
const authCss = read("src/features/public-auth/public-auth-page.module.css");
const routeShell = read("src/components/app-route-shell.module.css");
const shellCss = read("src/app/ui-shell-fixes.css");
const marketplace = read("src/components/agent-marketplace.tsx");

assert.match(themes, /id: "crystal-aurora", label: "黑曜霓彩"/u, "HEIYAO_NICAI_USER_LABEL_MISSING");
assert.match(themes, /id: "crystal-aurora", name: "黑曜霓彩"/u, "HEIYAO_NICAI_ADMIN_LABEL_MISSING");
assert.match(themes, /accent: "#28D5C0", bg: "#05070A", sidebar: "#060A0E"/u, "QINGYAOYE_PREVIEW_PALETTE_MISSING");
assert.doesNotMatch(themes, /暗夜黑/u, "RETIRED_DARK_NIGHT_LABEL_STILL_VISIBLE");

assert.match(themeCss, /--primary: #28d5c0;/u, "CYAN_PRIMARY_MISSING");
assert.match(themeCss, /--background: #05070a;/u, "NEAR_BLACK_BASE_MISSING");
assert.match(themeCss, /--crystal-brand-gradient: linear-gradient\(112deg, #0f8f87 0%, #168fa6 48%, #2f70e8 100%\)/u, "CYAN_BLUE_GRADIENT_MISSING");
assert.match(themeCss, /@media \(max-width: 0px\) and \(min-width: 1px\) \{[\s\S]*已撤销的暗夜黑|已撤销的暗夜黑[\s\S]*@media \(max-width: 0px\) and \(min-width: 1px\)/u, "DARK_NIGHT_LAYER_NOT_DISABLED");

assert.match(homeCss, /黑曜霓彩基线/u, "HOME_BLACK_LAYER_MISSING");
assert.match(homeCss, /--oh-page: #05070a;/u, "HOME_NEAR_BLACK_BASE_MISSING");
assert.match(homeCss, /--oh-accent: #2bd4c1;/u, "HOME_CYAN_ACCENT_MISSING");
assert.match(homeCss, /--oh-accent-two: #4a92ff;/u, "HOME_BLUE_ACCENT_MISSING");
assert.match(authCss, /黑曜霓彩：登录、注册和找回页/u, "PUBLIC_AUTH_HEIYAO_NICAI_SCOPE_MISSING");
assert.match(authCss, /linear-gradient\(145deg, #05070a, #071315 52%, #080d18\)/u, "PUBLIC_AUTH_BLACK_BACKGROUND_MISSING");

assert.match(routeShell, /--route-bg: #05070a;/u, "ROUTE_SHELL_BLACK_BASE_MISSING");
assert.match(routeShell, /--route-accent: #28d5c0;/u, "ROUTE_SHELL_ACCENT_NOT_RESTORED");
assert.match(shellCss, /黑曜霓彩最终保护/u, "FINAL_THEME_GUARD_MISSING");
assert.match(shellCss, /--marketplace-space-grid-size: 64px;/u, "GRID_SIZE_NOT_ALIGNED");
assert.match(shellCss, /content: "" !important;[\s\S]*linear-gradient\(var\(--crystal-grid-line\) 1px/u, "FIXED_GRID_LAYER_MISSING");
assert.match(shellCss, /#22d3ee[\s\S]*#a78bfa[\s\S]*#3b82f6[\s\S]*#f59e0b[\s\S]*#10b981[\s\S]*#ec4899/u, "SATURATED_SHORTCUT_PALETTE_MISSING");
assert.match(marketplace, /data-primary-nav-style="plain-tabs"/u, "PRIMARY_NAV_PLAIN_TABS_MARKER_MISSING");
assert.match(shellCss, /--market-nav-font-size: 17px;/u, "PRIMARY_NAV_FONT_SIZE_NOT_RESTORED");
assert.match(shellCss, /background: transparent !important;[\s\S]*box-shadow: none !important;/u, "PRIMARY_NAV_WRAPPER_NOT_REMOVED");
assert.match(shellCss, /data-primary-nav-style="plain-tabs"[\s\S]*nav-pill-indicator[\s\S]*display: none !important;/u, "PRIMARY_NAV_UNDERLINE_STILL_VISIBLE");
assert.match(shellCss, /color: var\(--nav-icon-color, currentColor\) !important;/u, "PRIMARY_NAV_SEMANTIC_ICON_COLORS_MISSING");

console.log(JSON.stringify({
  status: "PASS",
  contract: "qingyaoye-theme-rollback",
  stableInternalKey: "crystal-aurora",
  publicLabel: "黑曜霓彩",
  palette: {
    base: "#05070A",
    primary: "#28D5C0",
    gradientEnd: "#2F70E8",
  },
  protectedThemes: ["lattice", "soft-white"],
  paidCalls: 0,
  productionWrites: 0,
}, null, 2));
