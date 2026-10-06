#!/usr/bin/env node

/**
 * Desktop-only, read-only acceptance for the administration soft-white lock.
 * Run after the unified build is current:
 *   node scripts/with-local-admin-session.mjs scripts/verify-admin-softwhite-theme-live.mjs
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
const evidenceDir = path.resolve(".codex-evidence", "admin-softwhite-theme-live", runId);
const allowedWritePaths = new Set(["/api/announcements/events", "/api/product-usage/events", "/api/operation-events"]);
const commandCenterViews = ["overview", "members", "revenue", "production", "security", "system", "evidence"];
const supplementalPanels = {
  members: ["member-region-readiness-panel", "product-usage-panel"],
  revenue: ["recharge-timeline-panel"],
  system: ["runtime-telemetry-panel", "external-site-monitor-panel"],
  evidence: ["slo-metric-registry-panel"],
};

assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

await mkdir(evidenceDir, { recursive: true });

const report = {
  ok: false,
  checkedAt: new Date().toISOString(),
  runId,
  origin,
  viewport: { width: 1440, height: 900 },
  scenarios: [],
  views: [],
  motion: null,
  themePage: null,
  portal: null,
  help: null,
  screenshots: [],
  blockedWrites: [],
  externalRequests: [],
  httpErrors: [],
  pageErrors: [],
  consoleErrors: [],
  error: null,
};

function parseRgb(value) {
  const match = String(value || "").match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?\s*\)/u);
  if (!match) return null;
  return { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]), alpha: match[4] === undefined ? 1 : Number(match[4]) };
}

function relativeLuminance(value) {
  const rgb = parseRgb(value);
  if (!rgb || rgb.alpha < 0.9) return null;
  const channels = [rgb.red, rgb.green, rgb.blue].map((component) => {
    const channel = component / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const [lighter, darker] = [foregroundLuminance, backgroundLuminance].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function isActionableConsoleError(text) {
  return !["net::ERR_FAILED", "net::ERR_ABORTED", "AbortError", "The user aborted a request"].some((fragment) => text.includes(fragment));
}

async function persistReport() {
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const browser = await chromium.launch({ headless: true });
let failure = null;
try {
  const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block", colorScheme: "dark" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript((sessionToken) => {
    localStorage.setItem("auth_token", sessionToken);
    sessionStorage.setItem("entered_app", "1");
  }, token);

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== origin) {
      report.externalRequests.push({ method, url: request.url() });
      return route.abort();
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (allowedWritePaths.has(url.pathname)) return route.fulfill({ status: 204, body: "" });
      report.blockedWrites.push({ method, pathname: url.pathname });
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "BLOCKED_BY_ADMIN_SOFTWHITE_ACCEPTANCE" }) });
    }
    return route.continue();
  });

  const page = await context.newPage();
  const commandCenterReads = [];
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/api/admin/command-center") {
      commandCenterReads.push({ at: Date.now(), method: request.method(), search: url.search });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && isActionableConsoleError(message.text())) report.consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    report.httpErrors.push({ method: response.request().method(), status: response.status(), pathname: url.pathname });
  });

  const response = await page.goto(`${origin}/admin?tab=dashboard&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, "ADMIN_DASHBOARD_HTTP");
  const shell = page.locator('.admin-light-shell[data-admin-theme="soft-white"][data-theme="soft-white"][data-mode="light"]');
  await shell.waitFor({ state: "visible", timeout: 45_000 });
  await shell.locator(":scope > header").waitFor({ state: "visible", timeout: 45_000 });
  await shell.locator(":scope > div > aside").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId("admin-primary-nav-dashboard").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId("admin-command-center").waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await page.locator('body[data-admin-surface-active="true"]').count(), 1, "ADMIN_BODY_SCOPE_MISSING");

  async function readPalette() {
    return shell.evaluate((node) => {
      const style = getComputedStyle(node);
      const header = node.querySelector(":scope > header");
      const aside = node.querySelector(":scope > div > aside");
      const commandCenter = node.querySelector('[data-testid="admin-command-center"]');
      const read = (target) => {
        if (!target) return null;
        const computed = getComputedStyle(target);
        return { color: computed.color, backgroundColor: computed.backgroundColor, borderColor: computed.borderColor, colorScheme: computed.colorScheme };
      };
      return {
        shell: read(node),
        header: read(header),
        aside: read(aside),
        commandCenter: commandCenter ? {
          ...read(commandCenter),
          backgroundImage: getComputedStyle(commandCenter).backgroundImage,
          variables: {
            background: getComputedStyle(commandCenter).getPropertyValue("--cc-bg").trim(),
            panel: getComputedStyle(commandCenter).getPropertyValue("--cc-panel").trim(),
            text: getComputedStyle(commandCenter).getPropertyValue("--cc-text").trim(),
            muted: getComputedStyle(commandCenter).getPropertyValue("--cc-dim").trim(),
            accent: getComputedStyle(commandCenter).getPropertyValue("--cc-blue").trim(),
          },
        } : null,
        variables: {
          background: style.getPropertyValue("--background").trim(), foreground: style.getPropertyValue("--foreground").trim(),
          card: style.getPropertyValue("--card").trim(), popover: style.getPropertyValue("--popover").trim(),
          primary: style.getPropertyValue("--primary").trim(), mutedForeground: style.getPropertyValue("--muted-foreground").trim(),
          chart1: style.getPropertyValue("--chart-1").trim(),
        },
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    });
  }

  const rootScenarios = [
    { theme: "lattice", mode: "dark", darkClass: true },
    { theme: "soft-white", mode: "light", darkClass: false },
    { theme: "crystal-aurora", mode: "dark", darkClass: true },
  ];
  let baseline = null;
  for (const scenario of rootScenarios) {
    await page.evaluate(({ theme, mode, darkClass }) => {
      const root = document.documentElement;
      root.setAttribute("data-theme-selection", theme);
      root.setAttribute("data-theme", theme);
      root.setAttribute("data-mode-preference", mode);
      root.setAttribute("data-mode", mode);
      root.classList.toggle("dark", darkClass);
    }, scenario);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const palette = await readPalette();
    assert.equal(palette.overflowX, false, `ADMIN_OVERFLOW_${scenario.theme}_${scenario.mode}`);
    if (baseline === null) baseline = palette;
    else assert.deepEqual(palette, baseline, `ADMIN_PALETTE_DRIFT_${scenario.theme}_${scenario.mode}`);
    report.scenarios.push({ ...scenario, palette });
  }
  assert.equal(baseline.variables.background, "#f3f4ef", "ADMIN_BACKGROUND_TOKEN");
  assert.equal(baseline.variables.card, "#fffefa", "ADMIN_CARD_TOKEN");
  assert.equal(baseline.variables.primary, "#0b7466", "ADMIN_PRIMARY_TOKEN");
  assert.equal(baseline.commandCenter?.variables.background, "#f3f4ef", "ADMIN_COMMAND_CENTER_BACKGROUND_TOKEN");
  assert.equal(baseline.commandCenter?.variables.panel, "#fffefa", "ADMIN_COMMAND_CENTER_PANEL_TOKEN");
  assert.equal(baseline.commandCenter?.variables.text, "#17201d", "ADMIN_COMMAND_CENTER_TEXT_TOKEN");
  assert.equal(baseline.commandCenter?.variables.muted, "#5f6d68", "ADMIN_COMMAND_CENTER_MUTED_TOKEN");
  assert.equal(baseline.commandCenter?.variables.accent, "#0b7466", "ADMIN_COMMAND_CENTER_ACCENT_TOKEN");
  assert.equal(baseline.commandCenter?.colorScheme, "light", "ADMIN_COMMAND_CENTER_COLOR_SCHEME");

  async function waitForCommandCenterView(view) {
    const button = page.getByTestId(`command-center-view-${view}`);
    await button.waitFor({ state: "visible", timeout: 45_000 });
    if (await button.getAttribute("aria-current") !== "page") await button.click();
    await page.waitForFunction((expectedView) => {
      const root = document.querySelector('[data-testid="admin-command-center"]');
      const active = document.querySelector(`[data-testid="command-center-view-${expectedView}"]`);
      const url = new URL(window.location.href);
      return url.searchParams.get("tab") === "dashboard" && url.searchParams.get("view") === expectedView
        && active?.getAttribute("aria-current") === "page" && root?.getAttribute("data-view") === expectedView
        && root?.getAttribute("aria-busy") === "false" && Boolean(root?.getAttribute("data-snapshot-id")?.trim());
    }, view, { timeout: 60_000 });
  }

  async function inspectPanel(testId) {
    const locator = page.getByTestId(testId);
    await locator.waitFor({ state: "visible", timeout: 45_000 });
    const style = await locator.evaluate((node) => {
      const computed = getComputedStyle(node);
      const candidates = [node, ...node.querySelectorAll("header, article, section, table, [class]")];
      const surface = candidates.map((candidate) => {
        const current = getComputedStyle(candidate);
        return { backgroundColor: current.backgroundColor, backgroundImage: current.backgroundImage, color: current.color };
      }).find((candidate) => {
        const parsed = candidate.backgroundColor.match(/rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)(?:\D+(\d+(?:\.\d+)?))?\s*\)/u);
        const alpha = parsed?.[4] === undefined ? 1 : Number(parsed[4]);
        return Boolean(parsed && alpha >= 0.9 && candidate.backgroundColor !== "rgba(0, 0, 0, 0)");
      }) || null;
      return {
        color: computed.color, colorScheme: computed.colorScheme, backgroundColor: computed.backgroundColor,
        backgroundImage: computed.backgroundImage, surface, overflowX: node.scrollWidth > node.clientWidth + 2,
      };
    });
    assert.equal(style.colorScheme, "light", `ADMIN_${testId}_LIGHT_COLOR_SCHEME`);
    assert.equal(style.color, "rgb(23, 32, 29)", `ADMIN_${testId}_TEXT_COLOR`);
    assert.equal(style.overflowX, false, `ADMIN_${testId}_HORIZONTAL_OVERFLOW`);
    assert.ok(style.backgroundImage !== "none" || style.surface, `ADMIN_${testId}_LIGHT_SURFACE_MISSING`);
    if (style.surface) {
      const backgroundLuminance = relativeLuminance(style.surface.backgroundColor);
      assert.ok(backgroundLuminance !== null && backgroundLuminance >= 0.75, `ADMIN_${testId}_SURFACE_NOT_LIGHT`);
      const ratio = contrastRatio(style.color, style.surface.backgroundColor);
      if (ratio !== null) assert.ok(ratio >= 4.5, `ADMIN_${testId}_TEXT_CONTRAST_${ratio.toFixed(2)}`);
    }
    return style;
  }

  for (const view of commandCenterViews) {
    await waitForCommandCenterView(view);
    const commandCenter = page.getByTestId("admin-command-center");
    const snapshotId = await commandCenter.getAttribute("data-snapshot-id");
    const palette = await readPalette();
    assert.equal(palette.commandCenter?.colorScheme, "light", `ADMIN_COMMAND_CENTER_${view}_LIGHT_COLOR_SCHEME`);
    assert.equal(palette.commandCenter?.color, "rgb(23, 32, 29)", `ADMIN_COMMAND_CENTER_${view}_TEXT_COLOR`);
    assert.equal(palette.overflowX, false, `ADMIN_COMMAND_CENTER_${view}_PAGE_HORIZONTAL_OVERFLOW`);
    assert.equal(await commandCenter.evaluate((node) => node.scrollWidth > node.clientWidth + 2), false, `ADMIN_COMMAND_CENTER_${view}_ROOT_HORIZONTAL_OVERFLOW`);
    const panels = {};
    for (const testId of supplementalPanels[view] || []) panels[testId] = await inspectPanel(testId);
    const screenshot = path.join(evidenceDir, `command-center-${view}-softwhite-1440x900.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    report.screenshots.push(screenshot);
    report.views.push({ view, snapshotId, palette, panels, screenshot });
  }

  await waitForCommandCenterView("overview");
  const commandCenter = page.getByTestId("admin-command-center");
  const snapshotBeforeMotionRefresh = await commandCenter.getAttribute("data-snapshot-id");
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="command-center-refresh"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 75_000 });
  await page.getByTestId("command-center-refresh").click();
  await page.waitForFunction((previousSnapshotId) => {
    const root = document.querySelector('[data-testid="admin-command-center"]');
    return root?.getAttribute("aria-busy") === "false"
      && Boolean(root?.getAttribute("data-snapshot-id")?.trim())
      && root?.getAttribute("data-snapshot-id") !== previousSnapshotId;
  }, snapshotBeforeMotionRefresh, { timeout: 75_000 });

  const idleReadCountBefore = commandCenterReads.length;
  await page.waitForTimeout(2_500);
  assert.equal(commandCenterReads.length, idleReadCountBefore, "COMMAND_CENTER_HIGH_FREQUENCY_IDLE_POLLING");

  const motionNormal = await commandCenter.evaluate((root) => {
    const readAnimation = (selector) => {
      const node = root.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return { animationName: style.animationName, animationIterationCount: style.animationIterationCount };
    };
    return {
      snapshotId: root.getAttribute("data-snapshot-id"),
      numericMotion: [...root.querySelectorAll('[data-testid^="command-center-headline-value-"]')].map((node) => node.getAttribute("data-motion")),
      trendPointCounts: [...root.querySelectorAll('[data-point-count]')].map((node) => Number(node.getAttribute("data-point-count"))),
      waitingTrendCount: root.querySelectorAll('[class*="metricTrendWaiting"]').length,
      viewBody: readAnimation('[data-view="overview"]'),
      snapshotPulse: readAnimation('[class*="snapshotPulse"]'),
      alertPulse: readAnimation('[class*="alertPulse"]'),
      trendLine: readAnimation('[class*="metricTrend"] polyline'),
      overflowX: root.scrollWidth > root.clientWidth + 2,
    };
  });
  assert.equal(motionNormal.overflowX, false, "COMMAND_CENTER_MOTION_HORIZONTAL_OVERFLOW");
  assert.ok(motionNormal.numericMotion.length > 0, "COMMAND_CENTER_ANIMATED_NUMERIC_VALUE_MISSING");
  assert.ok(motionNormal.numericMotion.includes("animated"), "COMMAND_CENTER_NUMERIC_MOTION_NOT_ACTIVE");
  assert.equal(motionNormal.numericMotion.every((state) => state === "animated" || state === "static"), true, "COMMAND_CENTER_NON_NUMERIC_MOTION_STATE_INVALID");
  assert.ok(motionNormal.trendPointCounts.length > 0, "COMMAND_CENTER_REAL_SNAPSHOT_TREND_NOT_RENDERED");
  assert.equal(motionNormal.trendPointCounts.every((count) => count >= 2 && count <= 8), true, "COMMAND_CENTER_TREND_POINT_BOUND_INVALID");
  assert.equal(motionNormal.viewBody?.animationIterationCount, "1", "COMMAND_CENTER_VIEW_MOTION_NOT_ONE_SHOT");
  assert.equal(motionNormal.snapshotPulse?.animationIterationCount, "1", "COMMAND_CENTER_SNAPSHOT_MOTION_NOT_ONE_SHOT");
  if (motionNormal.alertPulse) assert.equal(motionNormal.alertPulse.animationIterationCount, "1", "COMMAND_CENTER_ALERT_MOTION_NOT_ONE_SHOT");
  assert.equal(motionNormal.trendLine?.animationIterationCount, "1", "COMMAND_CENTER_TREND_MOTION_NOT_ONE_SHOT");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => {
    const values = [...document.querySelectorAll('[data-testid^="command-center-headline-value-"]')];
    const states = values.map((node) => node.getAttribute("data-motion"));
    return states.includes("reduced") && states.every((state) => state === "reduced" || state === "static");
  }, null, { timeout: 15_000 });
  const motionReduced = await commandCenter.evaluate((root) => {
    const animationName = (selector) => {
      const node = root.querySelector(selector);
      return node ? getComputedStyle(node).animationName : null;
    };
    return {
      numericMotion: [...root.querySelectorAll('[data-testid^="command-center-headline-value-"]')].map((node) => node.getAttribute("data-motion")),
      viewBody: animationName('[data-view="overview"]'),
      snapshotPulse: animationName('[class*="snapshotPulse"]'),
      alertPulse: animationName('[class*="alertPulse"]'),
      trendLine: animationName('[class*="metricTrend"] polyline'),
    };
  });
  assert.ok(motionReduced.numericMotion.includes("reduced"), "COMMAND_CENTER_REDUCED_NUMERIC_MOTION_NOT_APPLIED");
  assert.equal(motionReduced.numericMotion.every((state) => state === "reduced" || state === "static"), true, "COMMAND_CENTER_REDUCED_TEXT_MOTION_STATE_INVALID");
  for (const [name, animationName] of Object.entries(motionReduced)) {
    if (name === "numericMotion" || animationName == null) continue;
    assert.equal(animationName, "none", `COMMAND_CENTER_REDUCED_MOTION_${name.toUpperCase()}`);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const motionShot = path.join(evidenceDir, "command-center-motion-overview-softwhite-1440x900.png");
  await page.screenshot({ path: motionShot, fullPage: true });
  report.screenshots.push(motionShot);
  report.motion = {
    snapshotBeforeMotionRefresh,
    snapshotAfterMotionRefresh: motionNormal.snapshotId,
    normal: motionNormal,
    reduced: motionReduced,
    commandCenterReads,
    idleSampleMs: 2_500,
    idleReadCount: 0,
    screenshot: motionShot,
  };

  const themeRequests = [];
  const recordThemeRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/settings/appearance" || url.pathname === "/api/settings/admin") themeRequests.push({ method: request.method(), pathname: url.pathname });
  };
  page.on("request", recordThemeRequest);
  const appearanceResponsePromise = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/settings/appearance", { timeout: 45_000 });
  const themeResponse = await page.goto(`${origin}/admin?tab=theme&view=revenue`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(themeResponse?.status(), 200, "ADMIN_THEME_HTTP");
  const appearanceResponse = await appearanceResponsePromise;
  assert.equal(appearanceResponse.status(), 200, "ADMIN_THEME_PUBLIC_APPEARANCE_HTTP");
  // Theme is a child view under the Brand & UI primary navigation group.
  await page.getByTestId("admin-primary-nav-general").waitFor({ state: "visible", timeout: 45_000 });
  await page.getByRole("heading", { name: "主题风格", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  page.off("request", recordThemeRequest);

  const unlockButton = page.getByRole("button", { name: "解锁敏感操作", exact: true });
  await unlockButton.waitFor({ state: "visible", timeout: 45_000 });
  const selectedThemeCard = page.locator('button[aria-pressed="true"]', { hasText: "柔光白" });
  await selectedThemeCard.waitFor({ state: "visible", timeout: 45_000 });
  await selectedThemeCard.getByText("全站已发布", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  const publishButton = page.locator('[data-admin-default-theme-push="true"]');
  await publishButton.getByText("已全站生效", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await publishButton.isDisabled(), true, "ADMIN_THEME_PUBLISHED_BUTTON_NOT_DISABLED");
  assert.equal(await page.getByText("待推送", { exact: true }).count(), 0, "ADMIN_THEME_FALSE_PENDING_STATE");
  assert.ok(themeRequests.some((entry) => entry.method === "GET" && entry.pathname === "/api/settings/appearance"), "ADMIN_THEME_PUBLIC_APPEARANCE_NOT_READ_WHILE_LOCKED");
  assert.equal(themeRequests.some((entry) => entry.pathname === "/api/settings/admin"), false, "ADMIN_THEME_SENSITIVE_SETTINGS_READ_WHILE_LOCKED");
  report.themePage = { locked: true, requests: themeRequests, selectedTheme: "soft-white", publishedBadge: "全站已发布", publishAction: "已全站生效", pendingVisible: false };
  const themeShot = path.join(evidenceDir, "theme-locked-softwhite-published-1440x900.png");
  await page.screenshot({ path: themeShot, fullPage: false });
  report.screenshots.push(themeShot);

  await unlockButton.click();
  const dialog = page.getByRole("dialog", { name: "解锁敏感操作 10 分钟", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  report.portal = await dialog.evaluate((node) => {
    const style = getComputedStyle(node);
    const input = node.querySelector("input");
    const inputStyle = input ? getComputedStyle(input) : null;
    return {
      stepUpDialog: node.getAttribute("aria-modal") === "true", color: style.color, backgroundColor: style.backgroundColor,
      borderColor: style.borderColor, colorScheme: style.colorScheme, backgroundToken: style.getPropertyValue("--background").trim(),
      foregroundToken: style.getPropertyValue("--foreground").trim(), inputColorScheme: inputStyle?.colorScheme || null,
    };
  });
  assert.equal(report.portal.backgroundToken, "#f3f4ef", "ADMIN_PORTAL_BACKGROUND_TOKEN");
  assert.equal(report.portal.foregroundToken, "#17201d", "ADMIN_PORTAL_FOREGROUND_TOKEN");
  assert.equal(report.portal.colorScheme, "light", "ADMIN_PORTAL_COLOR_SCHEME");
  assert.equal(report.portal.inputColorScheme, "light", "ADMIN_PORTAL_INPUT_COLOR_SCHEME");
  assert.equal(report.portal.stepUpDialog, true, "ADMIN_STEP_UP_DIALOG_ROLE");
  const portalShot = path.join(evidenceDir, "step-up-dialog-softwhite-under-crystal-dark-1440x900.png");
  await page.screenshot({ path: portalShot, fullPage: false });
  report.screenshots.push(portalShot);

  const helpResponse = await page.goto(`${origin}/admin/help`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(helpResponse?.status(), 200, "ADMIN_HELP_HTTP");
  const helpShell = page.locator('.admin-light-shell[data-admin-theme="soft-white"][data-theme="soft-white"][data-mode="light"]');
  await helpShell.waitFor({ state: "visible", timeout: 45_000 });
  await page.getByText("学习中心管理", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme-selection", "crystal-aurora"); root.setAttribute("data-theme", "crystal-aurora");
    root.setAttribute("data-mode-preference", "dark"); root.setAttribute("data-mode", "dark"); root.classList.add("dark");
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.help = await helpShell.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      adminTheme: node.getAttribute("data-admin-theme"), theme: node.getAttribute("data-theme"), mode: node.getAttribute("data-mode"),
      bodyScoped: document.body.getAttribute("data-admin-surface-active"), rootPublicTheme: document.documentElement.getAttribute("data-theme"),
      rootPublicMode: document.documentElement.getAttribute("data-mode"), colorScheme: style.colorScheme,
      backgroundToken: style.getPropertyValue("--background").trim(), foregroundToken: style.getPropertyValue("--foreground").trim(),
      cardToken: style.getPropertyValue("--card").trim(), primaryToken: style.getPropertyValue("--primary").trim(),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
  assert.equal(report.help.rootPublicTheme, "crystal-aurora", "ADMIN_HELP_PUBLIC_DARK_THEME_NOT_APPLIED_TO_TEST_ROOT");
  assert.equal(report.help.rootPublicMode, "dark", "ADMIN_HELP_PUBLIC_DARK_MODE_NOT_APPLIED_TO_TEST_ROOT");
  assert.equal(report.help.adminTheme, "soft-white", "ADMIN_HELP_FIXED_THEME_SCOPE");
  assert.equal(report.help.theme, "soft-white", "ADMIN_HELP_PUBLIC_THEME_OVERRIDE");
  assert.equal(report.help.mode, "light", "ADMIN_HELP_FIXED_MODE");
  assert.equal(report.help.bodyScoped, "true", "ADMIN_HELP_BODY_SCOPE");
  assert.equal(report.help.colorScheme, "light", "ADMIN_HELP_COLOR_SCHEME");
  assert.equal(report.help.backgroundToken, "#f3f4ef", "ADMIN_HELP_BACKGROUND_TOKEN");
  assert.equal(report.help.foregroundToken, "#17201d", "ADMIN_HELP_FOREGROUND_TOKEN");
  assert.equal(report.help.cardToken, "#fffefa", "ADMIN_HELP_CARD_TOKEN");
  assert.equal(report.help.primaryToken, "#0b7466", "ADMIN_HELP_PRIMARY_TOKEN");
  assert.equal(report.help.overflowX, false, "ADMIN_HELP_HORIZONTAL_OVERFLOW");
  const helpShot = path.join(evidenceDir, "admin-help-softwhite-under-crystal-dark-1440x900.png");
  await page.screenshot({ path: helpShot, fullPage: false });
  report.screenshots.push(helpShot);

  assert.deepEqual(report.blockedWrites, [], "ADMIN_THEME_ACCEPTANCE_TRIGGERED_WRITE");
  assert.deepEqual(report.externalRequests, [], "ADMIN_THEME_ACCEPTANCE_EXTERNAL_REQUEST");
  assert.deepEqual(report.httpErrors, [], "ADMIN_THEME_HTTP_ERRORS");
  assert.deepEqual(report.pageErrors, [], "ADMIN_THEME_PAGE_ERRORS");
  assert.deepEqual(report.consoleErrors, [], "ADMIN_THEME_CONSOLE_ERRORS");
  report.ok = true;
} catch (error) {
  failure = error;
  report.ok = false;
  report.error = { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null };
} finally {
  await persistReport();
  await browser.close();
}

console.log(JSON.stringify({
  ok: report.ok, evidenceDir, scenarios: report.scenarios.length,
  views: report.views.map((item) => ({ view: item.view, snapshotId: item.snapshotId, panels: Object.keys(item.panels) })),
  themePage: report.themePage, httpErrors: report.httpErrors, pageErrors: report.pageErrors, consoleErrors: report.consoleErrors, error: report.error,
}, null, 2));

if (failure) throw failure;
