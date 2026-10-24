#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(process.env.WDS_EVIDENCE_DIR || ".codex-evidence/wds-tools-workarea-R001140");
const user = { id: "wds-fixture-user", username: "wds_fixture", displayName: "WDS 验收夹具", role: "admin", status: "active", is_active: true, credits: 0 };
const themes = [
  { id: "lattice", mode: "dark" },
  { id: "soft-white", mode: "light" },
  { id: "crystal-aurora", mode: "dark" },
];
const routes = [
  { id: "tools-text", path: "/tools?tab=text", root: "tools" },
  { id: "tools-utility-text", path: "/tools/utility?tab=text", root: "tools-utility" },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { schemaVersion: 1, origin, themes: [], blockedWrites: [], pageErrors: [], consoleErrors: [], protectedRouteChecks: [] };

try {
  for (const theme of themes) {
    for (const routeInfo of routes) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      await context.addInitScript(({ selectedTheme, selectedMode, authUser }) => {
        localStorage.setItem("auth_token", "wds-fixture-token");
        localStorage.setItem("auth_user", JSON.stringify(authUser));
        localStorage.setItem("entered_app", "1");
        sessionStorage.setItem("entered_app", "1");
        localStorage.setItem("user_theme_preference", selectedTheme);
        localStorage.setItem("user_theme_mode_preference", selectedMode);
        localStorage.setItem("platform_theme", selectedTheme);
        localStorage.setItem("platform_theme_mode", selectedMode);
      }, { selectedTheme: theme.id, selectedMode: theme.mode, authUser: user });
      const page = await context.newPage();
      page.on("pageerror", (error) => report.pageErrors.push({ route: routeInfo.id, theme: theme.id, message: error.message }));
      page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push({ route: routeInfo.id, theme: theme.id, message: message.text() }); });
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin && /^https?:$/u.test(url.protocol)) return route.abort("blockedbyclient");
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (request.method() !== "GET") {
          if (url.pathname === "/api/product-usage/events" || url.pathname === "/api/client-error-report") return route.fulfill({ status: 204, body: "" });
          report.blockedWrites.push({ route: routeInfo.id, theme: theme.id, method: request.method(), pathname: url.pathname });
          return route.fulfill({ status: 204, body: "" });
        }
        const body = url.pathname === "/api/auth/me" ? { user }
          : url.pathname === "/api/member-permissions" ? { permission: { userId: user.id, role: "admin", featureNavigationKeys: ["toolbox"], agentNavigationKeys: [], revision: 1, integrityValid: true } }
            : url.pathname === "/api/settings" || url.pathname === "/api/settings/appearance" ? { settings: { theme: theme.id, theme_mode: theme.mode } }
              : url.pathname === "/api/credits" ? { credits: 0, cash_balance: 0 }
                : url.pathname === "/api/cash/balance" ? { balance: 0, cashBalance: 0 }
                  : url.pathname === "/api/bots" ? { agents: [] }
                    : url.pathname === "/api/version" ? { buildId: "wds-fixture", sourceVersion: "wds-fixture" } : {};
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      const response = await page.goto(`${origin}${routeInfo.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200, `${routeInfo.id}/${theme.id} HTTP status`);
      await page.waitForTimeout(900);
      const view = await page.evaluate((expectedRoot) => {
        const root = document.documentElement;
        const frame = document.querySelector(".workspace-depth-frame");
        const canvas = document.querySelector(".workspace-depth-canvas");
        const card = document.querySelector(".toolbox-input-surface, .toolbox-results-block, .toolbox-state-surface, .toolbox-empty-result");
        const frameStyle = frame ? getComputedStyle(frame) : null;
        const canvasStyle = canvas ? getComputedStyle(canvas) : null;
        const cardStyle = card ? getComputedStyle(card) : null;
        return {
          theme: root.getAttribute("data-theme"),
          mode: root.getAttribute("data-mode"),
          rootCount: document.querySelectorAll(`[data-page="${expectedRoot}"]`).length,
          frameCount: document.querySelectorAll(".workspace-depth-frame").length,
          canvasCount: document.querySelectorAll(".workspace-depth-canvas").length,
          frameBackgroundImage: frameStyle?.backgroundImage || "",
          frameBackgroundSize: frameStyle?.backgroundSize || "",
          frameBackgroundColor: frameStyle?.backgroundColor || "",
          canvasBackgroundColor: canvasStyle?.backgroundColor || "",
          cardCount: document.querySelectorAll(".toolbox-input-surface, .toolbox-results-block, .toolbox-state-surface, .toolbox-empty-result").length,
          cardShadow: cardStyle?.boxShadow || "",
          cardTransform: cardStyle?.transform || "none",
          bodyTextLength: document.body.innerText.length,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        };
      }, routeInfo.root);
      assert.equal(view.theme, theme.id, `${routeInfo.id}/${theme.id} theme`);
      assert.equal(view.mode, theme.mode, `${routeInfo.id}/${theme.id} mode`);
      assert.equal(view.rootCount, 1, `${routeInfo.id}/${theme.id} root count`);
      assert.equal(view.frameCount, 1, `${routeInfo.id}/${theme.id} WDS frame`);
      assert.equal(view.canvasCount, 1, `${routeInfo.id}/${theme.id} WDS canvas`);
      assert.match(view.frameBackgroundImage, /linear-gradient/iu, `${routeInfo.id}/${theme.id} grid background`);
      assert.match(view.frameBackgroundSize, /56px 56px/iu, `${routeInfo.id}/${theme.id} grid size`);
      assert.match(view.cardShadow, /rgba|rgb/iu, `${routeInfo.id}/${theme.id} card shadow`);
      assert.equal(view.canvasBackgroundColor, "rgba(0, 0, 0, 0)", `${routeInfo.id}/${theme.id} canvas transparency`);
      assert.equal(view.overflowX, false, `${routeInfo.id}/${theme.id} horizontal overflow`);
      assert.ok(view.bodyTextLength > 30, `${routeInfo.id}/${theme.id} rendered content`);
      const cards = page.locator(".toolbox-input-surface, .toolbox-results-block, .toolbox-state-surface, .toolbox-empty-result");
      let visibleCard = null;
      for (let index = 0; index < await cards.count(); index += 1) {
        const candidate = cards.nth(index);
        if (await candidate.isVisible()) { visibleCard = candidate; break; }
      }
      if (visibleCard) {
        await visibleCard.hover();
        const hoverTransform = await visibleCard.evaluate((element) => getComputedStyle(element).transform);
        assert.notEqual(hoverTransform, "none", `${routeInfo.id}/${theme.id} hover lift`);
        view.hoverTransform = hoverTransform;
      }
      const screenshot = path.join(outputDir, `${theme.id}-${routeInfo.id}-1440x900.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      report.themes.push({ theme: theme.id, mode: theme.mode, route: routeInfo.id, view, screenshot });
      await context.close();
    }
  }

  const protectedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await protectedContext.addInitScript(({ authUser }) => { localStorage.setItem("auth_token", "wds-fixture-token"); localStorage.setItem("auth_user", JSON.stringify(authUser)); localStorage.setItem("entered_app", "1"); }, { authUser: user });
  const protectedPage = await protectedContext.newPage();
  const protectedPaths = ["/youcai/tools?tab=text", "/commerce"];
  for (const protectedPath of protectedPaths) {
    let response = null;
    let navigationError = null;
    try {
      response = await protectedPage.goto(`${origin}${protectedPath}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      navigationError = error instanceof Error ? error.message : String(error);
    }
    report.protectedRouteChecks.push({ path: protectedPath, http: response?.status() || null, navigationError, finalUrl: protectedPage.url(), wdsNodes: await protectedPage.locator(".workspace-depth-frame, .workspace-depth-canvas").count() });
  }
  await protectedContext.close();
} finally {
  await browser.close();
}

assert.equal(report.blockedWrites.length, 0, `WDS_BLOCKED_WRITES:${JSON.stringify(report.blockedWrites)}`);
assert.equal(report.pageErrors.length, 0, `WDS_PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
assert.equal(report.consoleErrors.length, 0, `WDS_CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
assert.ok(report.protectedRouteChecks.every((item) => item.wdsNodes === 0), `WDS_PROTECTED_SELECTOR_HIT:${JSON.stringify(report.protectedRouteChecks)}`);
await writeFile(path.join(outputDir, "report.json"), JSON.stringify({ passed: true, ...report }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, checks: report.themes.length, protectedRouteChecks: report.protectedRouteChecks, outputDir }, null, 2));
