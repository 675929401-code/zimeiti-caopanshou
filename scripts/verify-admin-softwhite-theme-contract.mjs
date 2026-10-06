#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const adminPagePath = new URL("../src/app/admin/page.tsx", import.meta.url);
const adminHelpPagePath = new URL("../src/app/admin/help/page.tsx", import.meta.url);
const adminHelpCssPath = new URL("../src/app/admin/help/help-admin.module.css", import.meta.url);
const commandCenterCssPath = new URL("../src/components/admin/command-center-panel.module.css", import.meta.url);
const liveVerifierPath = new URL("./verify-admin-softwhite-theme-live.mjs", import.meta.url);
const shellCssPath = new URL("../src/app/ui-shell-fixes.css", import.meta.url);
const commandCenterSubpanelPaths = [
  ["MEMBER_REGION_READINESS", new URL("../src/components/admin/member-region-readiness-panel.module.css", import.meta.url)],
  ["PRODUCT_USAGE", new URL("../src/components/admin/product-usage-panel.module.css", import.meta.url)],
  ["RECHARGE_TIMELINE", new URL("../src/components/admin/recharge-timeline-panel.module.css", import.meta.url)],
  ["SLO_METRIC_REGISTRY", new URL("../src/components/admin/slo-metric-registry-panel.module.css", import.meta.url)],
  ["RUNTIME_TELEMETRY", new URL("../src/components/admin/runtime-telemetry-panel.module.css", import.meta.url)],
  ["EXTERNAL_SITE_MONITOR", new URL("../src/components/admin/external-site-monitor-panel.module.css", import.meta.url)],
];

const [adminPage, adminHelpPage, adminHelpCss, commandCenterCss, liveVerifier, shellCss] = await Promise.all([
  readFile(adminPagePath, "utf8"),
  readFile(adminHelpPagePath, "utf8"),
  readFile(adminHelpCssPath, "utf8"),
  readFile(commandCenterCssPath, "utf8"),
  readFile(liveVerifierPath, "utf8"),
  readFile(shellCssPath, "utf8"),
]);
const commandCenterSubpanels = await Promise.all(commandCenterSubpanelPaths.map(async ([name, path]) => ({
  name,
  css: await readFile(path, "utf8"),
})));

const assertions = [];
function check(condition, label) {
  assert.ok(condition, label);
  assertions.push(label);
}

check(adminPage.includes('body.setAttribute("data-admin-surface-active", "true")'), "ADMIN_BODY_PORTAL_SCOPE_ENABLED");
check(adminPage.includes('body.removeAttribute("data-admin-surface-active")'), "ADMIN_BODY_PORTAL_SCOPE_CLEANED_UP");
check((adminPage.match(/data-admin-theme="soft-white"/gu) || []).length >= 2, "ADMIN_LOADING_AND_READY_SHELLS_SCOPED");
check((adminPage.match(/data-theme="soft-white"/gu) || []).length >= 2, "ADMIN_SHELL_THEME_IS_EXPLICIT");
check((adminPage.match(/data-mode="light"/gu) || []).length >= 2, "ADMIN_SHELL_MODE_IS_EXPLICIT");
check(adminHelpPage.includes("className={`${styles.adminRoot} admin-light-shell`}"), "ADMIN_HELP_USES_FIXED_SHELL");
check(adminHelpPage.includes('data-admin-theme="soft-white"'), "ADMIN_HELP_THEME_IS_EXPLICIT");
check(adminHelpPage.includes('data-theme="soft-white"'), "ADMIN_HELP_PUBLIC_THEME_IS_OVERRIDDEN");
check(adminHelpPage.includes('data-mode="light"'), "ADMIN_HELP_MODE_IS_EXPLICIT");
check(adminHelpPage.includes('body.setAttribute("data-admin-surface-active", "true")'), "ADMIN_HELP_PORTAL_SCOPE_ENABLED");
check(adminHelpPage.includes('body.removeAttribute("data-admin-surface-active")'), "ADMIN_HELP_PORTAL_SCOPE_CLEANED_UP");
check(adminHelpCss.includes("color-scheme: light"), "ADMIN_HELP_COLOR_SCHEME_FIXED");
check(adminHelpCss.includes("var(--background, #f3f4ef)"), "ADMIN_HELP_BACKGROUND_FALLBACK_SOFTWHITE");
check(adminHelpCss.includes("var(--card, #fffefa)"), "ADMIN_HELP_CARD_FALLBACK_SOFTWHITE");
check(!adminHelpCss.includes("var(--background, #080d16)"), "ADMIN_HELP_DARK_BACKGROUND_FALLBACK_REMOVED");
const commandCenterSoftwhiteStart = commandCenterCss.indexOf("The administrator command center is part of the fixed soft-white workspace.");
check(commandCenterSoftwhiteStart >= 0, "ADMIN_COMMAND_CENTER_SOFTWHITE_OVERRIDE_PRESENT");
const commandCenterSoftwhite = commandCenterCss.slice(commandCenterSoftwhiteStart);
check(commandCenterSoftwhite.includes("--cc-bg: #f3f4ef"), "ADMIN_COMMAND_CENTER_BACKGROUND_SOFTWHITE");
check(commandCenterSoftwhite.includes("--cc-panel: #fffefa"), "ADMIN_COMMAND_CENTER_PANEL_SOFTWHITE");
check(commandCenterSoftwhite.includes("--cc-text: #17201d"), "ADMIN_COMMAND_CENTER_TEXT_SOFTWHITE");
check(commandCenterSoftwhite.includes("--cc-blue: #0b7466"), "ADMIN_COMMAND_CENTER_ACCENT_SOFTWHITE");
check(commandCenterSoftwhite.includes("color-scheme: light"), "ADMIN_COMMAND_CENTER_LIGHT_SCHEME_FIXED");

const requiredSubpanelTokens = [
  ["TEXT", "#17201d"],
  ["MUTED", "#5f6d68"],
  ["PRIMARY", "#0b7466"],
  ["SUCCESS", "#0b6b58"],
  ["WARNING", "#805300"],
  ["DANGER", "#b42318"],
  ["PAPER", "#fffefa"],
  ["CANVAS", "#f3f4ef"],
];
for (const { name, css } of commandCenterSubpanels) {
  check(css.includes("color-scheme: light"), `ADMIN_COMMAND_CENTER_${name}_LIGHT_SCHEME_FIXED`);
  check(!css.includes("color-scheme: dark"), `ADMIN_COMMAND_CENTER_${name}_HAS_NO_DARK_SCHEME`);
  for (const [tokenName, token] of requiredSubpanelTokens) {
    check(css.includes(token), `ADMIN_COMMAND_CENTER_${name}_${tokenName}_TOKEN_FIXED`);
  }
  const openSubpanelBraces = (css.match(/\{/gu) || []).length;
  const closeSubpanelBraces = (css.match(/\}/gu) || []).length;
  check(openSubpanelBraces === closeSubpanelBraces, `ADMIN_COMMAND_CENTER_${name}_CSS_BRACES_BALANCED`);
}
for (const { name, css } of commandCenterSubpanels.filter(({ name }) => name !== "MEMBER_REGION_READINESS")) {
  check(css.includes("#2e6f96"), `ADMIN_COMMAND_CENTER_${name}_BLUE_TOKEN_FIXED`);
}

const shellWaitIndex = liveVerifier.indexOf('await shell.waitFor({ state: "visible"');
const headerWaitIndex = liveVerifier.indexOf('shell.locator(":scope > header").waitFor');
const asideWaitIndex = liveVerifier.indexOf('shell.locator(":scope > div > aside").waitFor');
const navigationWaitIndex = liveVerifier.indexOf('getByTestId("admin-primary-nav-dashboard").waitFor');
const scenarioIndex = liveVerifier.indexOf("const rootScenarios = [");
check(shellWaitIndex >= 0 && headerWaitIndex > shellWaitIndex, "ADMIN_THEME_LIVE_WAITS_FOR_READY_HEADER");
check(asideWaitIndex > headerWaitIndex, "ADMIN_THEME_LIVE_WAITS_FOR_READY_ASIDE");
check(navigationWaitIndex > asideWaitIndex, "ADMIN_THEME_LIVE_WAITS_FOR_READY_NAVIGATION");
check(liveVerifier.includes('getByTestId("admin-command-center").waitFor'), "ADMIN_THEME_LIVE_WAITS_FOR_COMMAND_CENTER");
check(scenarioIndex > navigationWaitIndex, "ADMIN_THEME_BASELINE_AFTER_READY_LAYOUT");
check(liveVerifier.includes('getByRole("button", { name: "解锁敏感操作", exact: true })'), "ADMIN_THEME_LIVE_USES_VISIBLE_STEP_UP_ENTRY");
check(liveVerifier.includes('getByRole("dialog", { name: "解锁敏感操作 10 分钟", exact: true })'), "ADMIN_THEME_LIVE_CHECKS_STEP_UP_DIALOG");
check(!liveVerifier.includes('{ name: "添加模型", exact: true }'), "ADMIN_THEME_LIVE_DOES_NOT_REQUIRE_LOCKED_MODEL_WRITE_ENTRY");
check(liveVerifier.includes('page.goto(`${origin}/admin/help`'), "ADMIN_HELP_LIVE_ROUTE_INCLUDED");
check(liveVerifier.includes('root.setAttribute("data-theme", "crystal-aurora")'), "ADMIN_HELP_LIVE_PUBLIC_DARK_THEME_INCLUDED");
check(liveVerifier.includes('assert.equal(report.help.theme, "soft-white"'), "ADMIN_HELP_LIVE_FIXED_THEME_ASSERTED");
check(liveVerifier.includes('assert.equal(report.help.colorScheme, "light"'), "ADMIN_HELP_LIVE_LIGHT_SCHEME_ASSERTED");
check(liveVerifier.includes('assert.equal(report.help.backgroundToken, "#f3f4ef"'), "ADMIN_HELP_LIVE_SOFTWHITE_TOKEN_ASSERTED");
check(liveVerifier.includes('assert.equal(baseline.commandCenter?.variables.background, "#f3f4ef"'), "ADMIN_COMMAND_CENTER_LIVE_BACKGROUND_ASSERTED");
check(liveVerifier.includes('assert.equal(baseline.commandCenter?.variables.panel, "#fffefa"'), "ADMIN_COMMAND_CENTER_LIVE_PANEL_ASSERTED");
for (const view of ["overview", "members", "revenue", "production", "security", "system", "evidence"]) {
  check(liveVerifier.includes(`"${view}"`), `ADMIN_COMMAND_CENTER_LIVE_${view.toUpperCase()}_VIEW_INCLUDED`);
}
check(liveVerifier.includes('root?.getAttribute("aria-busy") === "false"'), "ADMIN_COMMAND_CENTER_LIVE_WAITS_FOR_IDLE");
check(liveVerifier.includes('root?.getAttribute("data-snapshot-id")'), "ADMIN_COMMAND_CENTER_LIVE_REQUIRES_SNAPSHOT");
check(liveVerifier.includes('url.pathname === "/api/settings/appearance"'), "ADMIN_THEME_LIVE_READS_PUBLIC_APPEARANCE");
check(liveVerifier.includes('url.pathname === "/api/settings/admin"'), "ADMIN_THEME_LIVE_OBSERVES_SENSITIVE_BOUNDARY");
check(liveVerifier.includes('getByText("全站已发布"'), "ADMIN_THEME_LIVE_ASSERTS_PUBLISHED_BADGE");
check(liveVerifier.includes('getByText("已全站生效"'), "ADMIN_THEME_LIVE_ASSERTS_PUBLISHED_ACTION");
check(liveVerifier.includes('getByText("待推送"'), "ADMIN_THEME_LIVE_REJECTS_FALSE_PENDING_STATE");

check(shellCss.includes('body[data-admin-surface-active="true"]'), "ADMIN_PORTAL_SCOPE_STYLED");
check(shellCss.includes('[data-slot="dialog-content"]'), "ADMIN_DIALOG_PORTAL_STYLED");
check(shellCss.includes('[data-slot="select-content"]'), "ADMIN_SELECT_PORTAL_STYLED");
check(shellCss.includes('[data-sonner-toaster]'), "ADMIN_TOASTER_PORTAL_STYLED");
check(shellCss.includes('--chart-1: #0b7466'), "ADMIN_CHART_PALETTE_FIXED");
check(shellCss.includes('.recharts-cartesian-axis-tick text'), "ADMIN_CHART_TEXT_CONTRAST_STYLED");
check(!/html(?:\[[^\]]+\]|:is\([^)]*\))\s+\.admin-light-shell/u.test(shellCss), "ADMIN_SHELL_NO_LONGER_BINDS_TO_HTML_THEME");

const adminBlockStart = shellCss.indexOf("/* Administrator surfaces are a product-owned soft-white workspace.");
const adminBlockEnd = shellCss.indexOf("/* Theme-aware marketplace finish.");
check(adminBlockStart >= 0 && adminBlockEnd > adminBlockStart, "ADMIN_FIXED_THEME_BLOCK_PRESENT");
const adminBlock = shellCss.slice(adminBlockStart, adminBlockEnd);
check(!adminBlock.includes("color-scheme: dark"), "ADMIN_FIXED_THEME_HAS_NO_DARK_COLOR_SCHEME");
check(!/data-theme="(?:lattice|crystal-aurora|stellar-blue)"/u.test(adminBlock), "ADMIN_FIXED_THEME_HAS_NO_PUBLIC_THEME_BRANCHES");

function parseHex(hex) {
  const normalized = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
}

function relativeLuminance(hex) {
  const channels = parseHex(hex).map((channel) => (
    channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const contrastPairs = [
  ["body", "#17201d", "#f3f4ef", 4.5],
  ["card", "#17201d", "#fffefa", 4.5],
  ["muted", "#66716d", "#fffefa", 4.5],
  ["primary", "#ffffff", "#0b7466", 4.5],
  ["accent", "#125548", "#dfece7", 4.5],
  ["destructive", "#b42318", "#fffefa", 4.5],
];

const contrasts = contrastPairs.map(([name, foreground, background, minimum]) => {
  const ratio = contrast(foreground, background);
  check(ratio >= minimum, `ADMIN_${name.toUpperCase()}_CONTRAST_${ratio.toFixed(2)}`);
  return { name, foreground, background, ratio: Number(ratio.toFixed(2)), minimum };
});

const openBraces = (shellCss.match(/\{/gu) || []).length;
const closeBraces = (shellCss.match(/\}/gu) || []).length;
check(openBraces === closeBraces, "ADMIN_THEME_CSS_BRACES_BALANCED");

console.log(JSON.stringify({
  ok: true,
  assertions: assertions.length,
  contrasts,
}, null, 2));
