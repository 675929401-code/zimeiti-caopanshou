#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const viewport = { width: 1440, height: 900 };
const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
const evidenceDir = path.resolve(".codex-evidence", "theme-command-brand-live", runId);
const allowedTelemetryWrites = new Set([
  "/api/announcements/events",
  "/api/product-usage/events",
  "/api/operation-events",
]);

assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
await mkdir(evidenceDir, { recursive: true });

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  origin,
  viewport,
  runtime: null,
  commandCenter: {},
  brandCenter: null,
  adjacentPages: [],
  screenshots: [],
  blockedWrites: [],
  externalRequests: [],
  serverErrors: [],
  pageErrors: [],
  consoleErrors: [],
  requestFailures: [],
  ok: false,
};

const browser = await chromium.launch({ headless: true });
try {
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  report.runtime = await versionResponse.json();

  const context = await browser.newContext({ viewport, serviceWorkers: "block", reducedMotion: "reduce", colorScheme: "light" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript((sessionToken) => {
    localStorage.setItem("auth_token", sessionToken);
    sessionStorage.setItem("entered_app", "1");
  }, token);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.externalRequests.push({ method, origin: url.origin, pathname: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.blockedWrites.push({ method, pathname: url.pathname, telemetry: allowedTelemetryWrites.has(url.pathname) });
      await route.fulfill({ status: allowedTelemetryWrites.has(url.pathname) ? 204 : 409, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue({ headers: { ...request.headers(), Authorization: `Bearer ${token}` } });
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/ERR_ABORTED|AbortError|user aborted/iu.test(message.text())) {
      report.consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      const url = new URL(response.url());
      report.serverErrors.push({ status: response.status(), pathname: url.pathname });
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    if (!/ERR_ABORTED|BLOCKED_BY_CLIENT/iu.test(failure)) {
      const url = new URL(request.url());
      report.requestFailures.push({ method: request.method(), pathname: url.pathname, failure });
    }
  });

  async function waitForCommandView(view) {
    await page.goto(`${origin}/admin?tab=dashboard&view=${view}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("admin-command-center").waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction((expected) => {
      const root = document.querySelector('[data-testid="admin-command-center"]');
      const active = document.querySelector(`[data-testid="command-center-view-${expected}"]`);
      return root?.getAttribute("data-view") === expected
        && root?.getAttribute("aria-busy") === "false"
        && Boolean(root?.getAttribute("data-snapshot-id"))
        && active?.getAttribute("aria-current") === "page";
    }, view, { timeout: 60_000 });
  }

  async function inspectCommandView(view) {
    await waitForCommandView(view);
    const metrics = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="command-center-goal-navigation"]');
      const sections = document.querySelector('[data-testid="command-center-sections"]');
      if (!(nav instanceof HTMLElement) || !(sections instanceof HTMLElement)) throw new Error("COMMAND_CENTER_LAYOUT_MISSING");
      const navStyle = getComputedStyle(nav);
      const navRect = nav.getBoundingClientRect();
      const buttons = [...nav.querySelectorAll(":scope > button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      });
      const panels = [...sections.querySelectorAll(':scope > [data-testid^="command-center-section-"]')];
      const sectionRect = sections.getBoundingClientRect();
      const panelRects = panels.map((panel) => {
        const rect = panel.getBoundingClientRect();
        const cards = [...panel.querySelectorAll('[data-testid^="command-center-metric-"]')].map((card) => {
          const cardRect = card.getBoundingClientRect();
          return { top: cardRect.top, left: cardRect.left, right: cardRect.right, width: cardRect.width };
        });
        return {
          testId: panel.getAttribute("data-testid"),
          left: rect.left,
          right: rect.right,
          width: rect.width,
          cards,
          metricColumns: getComputedStyle(panel.querySelector(':scope [data-testid^="command-center-metric-"]')?.parentElement || panel).gridTemplateColumns,
        };
      });
      return {
        pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        navigation: {
          display: navStyle.display,
          gridAutoFlow: navStyle.gridAutoFlow,
          overflowX: navStyle.overflowX,
          borderTopWidth: navStyle.borderTopWidth,
          borderRadius: navStyle.borderRadius,
          backgroundColor: navStyle.backgroundColor,
          clientWidth: nav.clientWidth,
          scrollWidth: nav.scrollWidth,
          rect: { left: navRect.left, right: navRect.right, width: navRect.width },
          buttons,
        },
        sections: { left: sectionRect.left, right: sectionRect.right, width: sectionRect.width, panelRects },
      };
    });

    assert.equal(metrics.pageOverflowX, 0, `${view}:PAGE_HORIZONTAL_OVERFLOW`);
    assert.equal(metrics.navigation.display, "grid", `${view}:NAV_NOT_GRID`);
    assert.match(metrics.navigation.gridAutoFlow, /column/u, `${view}:NAV_NOT_HORIZONTAL`);
    assert.equal(metrics.navigation.buttons.length, 7, `${view}:NAV_BUTTON_COUNT`);
    assert.ok(Number.parseFloat(metrics.navigation.borderTopWidth) >= 1, `${view}:NAV_CONTAINER_BORDER_MISSING`);
    assert.ok(Number.parseFloat(metrics.navigation.borderRadius) >= 10, `${view}:NAV_CONTAINER_RADIUS_MISSING`);
    assert.equal(new Set(metrics.navigation.buttons.map((button) => Math.round(button.top))).size, 1, `${view}:NAV_WRAPPED_TO_MULTIPLE_ROWS`);
    assert.equal(metrics.sections.panelRects.length, 1, `${view}:EXPECTED_ONE_EVIDENCE_DOMAIN`);
    const panel = metrics.sections.panelRects[0];
    assert.ok(panel.width / metrics.sections.width >= 0.985, `${view}:EVIDENCE_DOMAIN_NOT_FULL_WIDTH`);
    assert.ok(Math.abs(panel.right - metrics.sections.right) <= 2, `${view}:EVIDENCE_DOMAIN_RIGHT_GAP`);
    const firstRowTop = Math.min(...panel.cards.map((card) => card.top));
    const firstRow = panel.cards.filter((card) => Math.abs(card.top - firstRowTop) <= 2);
    assert.ok(firstRow.length >= Math.min(3, panel.cards.length), `${view}:METRICS_NOT_LAID_OUT_HORIZONTALLY`);

    const screenshot = path.join(evidenceDir, `command-center-${view}-1440x900.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    report.screenshots.push(screenshot);
    report.commandCenter[view] = { ...metrics, screenshot };
  }

  await inspectCommandView("members");
  await inspectCommandView("revenue");

  await page.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const brandCenter = page.getByTestId("platform-brand-settings");
  await brandCenter.waitFor({ state: "visible", timeout: 45_000 });
  const brandMetrics = await brandCenter.evaluate((node) => {
    const preview = node.querySelector('[data-testid="brand-live-preview"]');
    const advanced = node.querySelector('[data-testid="brand-advanced-assets"]');
    return {
      stickyActions: node.querySelectorAll('[data-testid="brand-actions-sticky"]').length,
      bottomActions: node.querySelectorAll('[data-testid="brand-actions-bottom"]').length,
      primaryLogoCards: node.querySelectorAll('[data-testid="brand-asset-logo_square"]').length,
      advancedOpen: advanced?.hasAttribute("open") || false,
      advancedCards: advanced?.querySelectorAll('[data-testid^="brand-asset-"]').length || 0,
      previewBackground: preview ? getComputedStyle(preview).backgroundImage : "",
      pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });
  assert.equal(brandMetrics.stickyActions, 1, "BRAND_ACTION_BAR_NOT_UNIQUE");
  assert.equal(brandMetrics.bottomActions, 0, "BRAND_DUPLICATE_BOTTOM_ACTIONS");
  assert.equal(brandMetrics.primaryLogoCards, 1, "BRAND_PRIMARY_LOGO_CARD_COUNT");
  assert.equal(brandMetrics.advancedOpen, false, "BRAND_ADVANCED_ASSETS_SHOULD_START_COLLAPSED");
  assert.equal(brandMetrics.advancedCards, 5, "BRAND_ADVANCED_ASSET_COUNT");
  assert.match(brandMetrics.previewBackground, /linear-gradient/iu, "BRAND_GRADIENT_PREVIEW_MISSING");
  assert.equal(brandMetrics.pageOverflowX, 0, "BRAND_PAGE_HORIZONTAL_OVERFLOW");
  const brandScreenshot = path.join(evidenceDir, "brand-center-1440x900.png");
  await page.screenshot({ path: brandScreenshot, fullPage: false });
  report.screenshots.push(brandScreenshot);
  report.brandCenter = { ...brandMetrics, screenshot: brandScreenshot };

  for (const tab of ["users", "theme"]) {
    await page.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('.admin-light-shell[data-admin-theme="soft-white"][data-mode="light"]').waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction(() => (document.querySelector(".admin-light-shell")?.textContent?.trim().length || 0) > 100, null, { timeout: 45_000 });
    const pageState = await page.evaluate(() => ({
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      textLength: document.querySelector(".admin-light-shell")?.textContent?.trim().length || 0,
      adminTheme: document.querySelector(".admin-light-shell")?.getAttribute("data-admin-theme") || "",
    }));
    assert.equal(pageState.overflowX, 0, `${tab}:ADJACENT_PAGE_HORIZONTAL_OVERFLOW`);
    assert.ok(pageState.textLength > 20, `${tab}:ADJACENT_PAGE_EMPTY`);
    assert.equal(pageState.adminTheme, "soft-white", `${tab}:ADMIN_THEME_DRIFT`);
    report.adjacentPages.push({ tab, ...pageState });
  }

  assert.equal(report.serverErrors.length, 0, "SERVER_5XX_DETECTED");
  assert.equal(report.pageErrors.length, 0, "PAGE_ERRORS_DETECTED");
  assert.equal(report.consoleErrors.length, 0, "CONSOLE_ERRORS_DETECTED");
  assert.equal(report.requestFailures.length, 0, "REQUEST_FAILURES_DETECTED");
  assert.equal(report.externalRequests.length, 0, "EXTERNAL_REQUESTS_DETECTED");
  assert.equal(report.blockedWrites.filter((entry) => !entry.telemetry).length, 0, "BUSINESS_WRITE_ATTEMPT_DETECTED");
  report.ok = true;
} finally {
  await browser.close();
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ok: report.ok, evidenceDir, runtime: report.runtime, commandViews: Object.keys(report.commandCenter), adjacentPages: report.adjacentPages.map((entry) => entry.tab) }, null, 2));
