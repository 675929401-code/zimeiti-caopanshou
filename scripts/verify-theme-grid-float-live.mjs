#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const themes = [
  { id: "lattice", label: "深空晶", mode: "dark", grid: 64 },
  { id: "soft-white", label: "柔光白", mode: "light", grid: 68 },
  { id: "crystal-aurora", label: "黑曜霓彩", mode: "dark", grid: 64 },
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const outputRoot = path.resolve(process.env.THEME_GRID_FLOAT_OUTPUT_DIR || ".codex-evidence/theme-grid-float-live-20260930");
const outputDir = path.join(outputRoot, new Date().toISOString().replace(/[:.]/gu, "-"));

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

async function getIdentity() {
  const response = await fetch(origin + "/api/auth/me", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(30_000),
  });
  requireCondition(response.ok, "LOCAL_ADMIN_SESSION_INVALID:" + response.status);
  const body = await response.json();
  requireCondition(body && body.user && body.user.role === "admin", "LOCAL_ADMIN_ROLE_REQUIRED");
  return body.user;
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  requireCondition(token.length > 0, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await mkdir(outputDir, { recursive: true });

  const identity = await getIdentity();
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    outputDir,
    themes: [],
    adjacentPages: [],
    autoThemeTransitions: [],
    blockedWrites: [],
    paidRequests: [],
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
  };
  const browser = await chromium.launch({ headless: true });

  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        const scope = theme.id + "-" + viewport.width + "x" + viewport.height;
        const context = await browser.newContext({ viewport, serviceWorkers: "block", colorScheme: theme.mode });
        const localUser = {
          ...identity,
          themePreference: theme.id,
          theme_preference: theme.id,
          themeModePreference: "system",
          theme_mode_preference: "system",
        };
        await context.addInitScript((payload) => {
          localStorage.setItem("user_theme_preference", payload.id);
          localStorage.setItem("user_theme_mode_preference", payload.mode);
          localStorage.setItem("app_theme", payload.id);
          localStorage.setItem("app_mode", payload.mode);
          localStorage.setItem("auth_token", payload.token);
          localStorage.setItem("auth_user", JSON.stringify(payload.user));
          sessionStorage.setItem("entered_app", "1");
        }, { id: theme.id, mode: "system", token, user: localUser });
        await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);

        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const method = request.method();
          if (url.origin !== origin) {
            await route.abort();
            return;
          }
          if (method === "GET" && url.pathname === "/api/settings") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ settings: { theme: theme.id, theme_mode: "system" } }),
            });
            return;
          }
          if (method === "GET" && url.pathname === "/api/auth/me") {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: localUser }) });
            return;
          }
          if (method === "GET" && url.pathname === "/api/announcements/inbox") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ announcements: [], unreadCount: 0, cursor: "empty" }),
            });
            return;
          }
          if (method === "GET" && url.pathname === "/api/video/active-tasks") {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
            return;
          }
          if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
            report.blockedWrites.push({ scope, method, pathname: url.pathname });
            await route.fulfill({ status: 204, body: "" });
            return;
          }
          if (/\/(?:generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) {
            report.paidRequests.push({ scope, method, pathname: url.pathname });
          }
          await route.continue();
        });

        const page = await context.newPage();
        page.on("pageerror", (error) => report.pageErrors.push({ scope, message: error.message }));
        page.on("console", (message) => {
          if (message.type() === "error" && !message.text().includes("net::ERR_FAILED")) report.consoleErrors.push({ scope, message: message.text() });
        });
        page.on("response", (response) => {
          if (response.status() >= 500) {
            report.serverErrors.push({ scope, status: response.status(), pathname: new URL(response.url()).pathname });
          }
        });

        const response = await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        assert.equal(response && response.status(), 200, scope + ":HOME_HTTP");
        await page.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });
        const card = page.locator(".marketplace-agent-grid .agent-card-hover").first();
        await card.waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForTimeout(450);

        const field = await page.evaluate(() => {
          const shell = document.querySelector(".marketplace-shell");
          const cardNode = document.querySelector(".marketplace-agent-grid .agent-card-hover");
          const shellStyle = shell ? getComputedStyle(shell) : null;
          const cardStyle = cardNode ? getComputedStyle(cardNode) : null;
          const gridImage = shellStyle ? shellStyle.backgroundImage : "";
          return {
            theme: document.documentElement.dataset.theme || "",
            themeSelection: document.documentElement.dataset.themeSelection || "",
            mode: document.documentElement.dataset.mode || "",
            image: gridImage,
            attachment: shellStyle ? shellStyle.backgroundAttachment : "",
            size: shellStyle ? shellStyle.backgroundSize : "",
            radialLayers: (gridImage.match(/radial-gradient/gu) || []).length,
            linearLayers: (gridImage.match(/linear-gradient/gu) || []).length,
            cardTransition: cardStyle ? cardStyle.transition : "",
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });
        const themeEvidence = { scope, label: theme.label, field, cardHover: null, screenshot: null };
        report.themes.push(themeEvidence);
        assert.equal(field.theme, theme.id, scope + ":THEME_MISMATCH");
        assert.equal(field.themeSelection, theme.id, scope + ":THEME_SELECTION_MISMATCH");
        assert.equal(field.mode, theme.mode, scope + ":MODE_MISMATCH");
        assert.equal(field.overflowX, 0, scope + ":HORIZONTAL_OVERFLOW");
        requireCondition(field.linearLayers >= 2, scope + ":ORTHOGONAL_GRID_MISSING");
        requireCondition(field.radialLayers >= 1, scope + ":THEME_GRADIENT_ACCENT_MISSING");
        requireCondition(field.attachment.includes("fixed"), scope + ":GRID_NOT_FIXED");
        requireCondition(field.size.includes(String(theme.grid) + "px"), scope + ":GRID_SIZE_MISMATCH");
        requireCondition(field.cardTransition.includes("transform"), scope + ":CARD_FLOAT_TRANSITION_MISSING");

        await card.hover();
        await page.waitForTimeout(230);
        const cardHover = await card.evaluate((node) => {
          const style = getComputedStyle(node);
          const matched = style.transform.match(/matrix(?:3d)?\(([^)]+)\)/u);
          const numbers = matched ? matched[1].split(",").map((value) => Number(value.trim())) : [];
          const translateY = numbers.length === 6 ? numbers[5] : numbers.length === 16 ? numbers[13] : 0;
          return { transform: style.transform, translateY };
        });
        requireCondition(cardHover.translateY <= -1, scope + ":CARD_FLOAT_MISSING:" + cardHover.transform);

        let visibleThemeLabels = null;
        if (theme.id === "lattice" && viewport.width === 1440) {
          const trigger = page.locator('[data-theme-switcher-trigger="true"]:visible').first();
          await trigger.click();
          visibleThemeLabels = await page.locator("[data-theme-option]").evaluateAll((nodes) => nodes.map((node) => ({
            id: node.getAttribute("data-theme-option") || "",
            text: (node.textContent || "").replace(/s+/gu, " ").trim(),
          })));
          const expectedLabels = [
            ["lattice", "深空晶"],
            ["soft-white", "柔光白"],
            ["crystal-aurora", "黑曜霓彩"],
          ];
          for (const [id, label] of expectedLabels) {
            const option = visibleThemeLabels.find((item) => item.id === id);
            requireCondition(Boolean(option && option.text.includes(label)), "THEME_LABEL_MISMATCH:" + id + ":" + label);
          }
          requireCondition(!visibleThemeLabels.some((item) => item.id === "stellar-blue" || item.text.includes("极光蓝")), "RETIRED_THEME_VISIBLE");
          requireCondition(await page.getByText(/当前 IP 保留 7 天/u).count() === 0, "THEME_RETENTION_EXPLANATION_VISIBLE");
          requireCondition(await page.locator("[data-theme-mode-option]").count() === 0, "MODE_SWITCHER_STILL_VISIBLE");
          requireCondition(await page.getByText("明暗模式", { exact: true }).count() === 0, "MODE_PANEL_STILL_VISIBLE");
          await page.keyboard.press("Escape");
        }

        const screenshot = path.join(outputDir, scope + "-marketplace.png");
        await page.screenshot({ path: screenshot, fullPage: false });
        themeEvidence.cardHover = cardHover;
        themeEvidence.screenshot = screenshot;

        if (viewport.width === 1440) {
          for (const pathname of ["/tools", "/video"]) {
            const adjacentResponse = await page.goto(origin + pathname, { waitUntil: "domcontentloaded", timeout: 60_000 });
            assert.equal(adjacentResponse && adjacentResponse.status(), 200, scope + ":" + pathname + ":HTTP");
            await page.waitForTimeout(700);
            const adjacent = await page.evaluate(() => ({
              theme: document.documentElement.dataset.theme || "",
              selection: document.documentElement.dataset.themeSelection || "",
              mode: document.documentElement.dataset.mode || "",
              overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
              textLength: (document.body.innerText || "").trim().length,
            }));
            assert.equal(adjacent.theme, theme.id, scope + ":" + pathname + ":THEME_MISMATCH");
            assert.equal(adjacent.selection, theme.id, scope + ":" + pathname + ":THEME_SELECTION_MISMATCH");
            assert.equal(adjacent.mode, theme.mode, scope + ":" + pathname + ":MODE_MISMATCH");
            assert.equal(adjacent.overflowX, 0, scope + ":" + pathname + ":HORIZONTAL_OVERFLOW");
            requireCondition(adjacent.textLength > 30, scope + ":" + pathname + ":CONTENT_MISSING");
            report.adjacentPages.push({ scope, pathname, ...adjacent });
          }
        }
        await context.close();
      }
    }

    for (const transition of [
      { colorScheme: "light", selectedTheme: "lattice", renderedTheme: "lattice", mode: "dark" },
      { colorScheme: "dark", selectedTheme: "lattice", renderedTheme: "lattice", mode: "dark" },
    ]) {
      const context = await browser.newContext({ viewport: viewports[0], serviceWorkers: "block", colorScheme: transition.colorScheme });
      const localUser = {
        ...identity,
        themePreference: transition.selectedTheme,
        theme_preference: transition.selectedTheme,
        themeModePreference: "system",
        theme_mode_preference: "system",
      };
      await context.addInitScript((payload) => {
        localStorage.setItem("user_theme_preference", payload.theme);
        localStorage.setItem("user_theme_mode_preference", "system");
        localStorage.setItem("app_theme", payload.theme);
        localStorage.setItem("app_mode", "system");
        localStorage.setItem("auth_token", payload.token);
        localStorage.setItem("auth_user", JSON.stringify(payload.user));
        sessionStorage.setItem("entered_app", "1");
      }, { theme: transition.selectedTheme, token, user: localUser });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (request.method() === "GET" && url.pathname === "/api/settings") {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { theme: transition.selectedTheme, theme_mode: "system" } }) });
        }
        if (request.method() === "GET" && url.pathname === "/api/auth/me") {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: localUser }) });
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          report.blockedWrites.push({ scope: "auto-" + transition.colorScheme, method: request.method(), pathname: url.pathname });
          return route.fulfill({ status: 204, body: "" });
        }
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(response && response.status(), 200, "AUTO_THEME_HOME_HTTP");
      await page.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });
      const actual = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme || "",
        selection: document.documentElement.dataset.themeSelection || "",
        mode: document.documentElement.dataset.mode || "",
      }));
      assert.deepEqual(actual, { theme: transition.renderedTheme, selection: transition.selectedTheme, mode: transition.mode }, "AUTO_THEME_TRANSITION_MISMATCH");
      report.autoThemeTransitions.push({ ...transition, actual });
      await context.close();
    }

    assert.equal(report.paidRequests.length, 0, "PAID_REQUEST_BLOCKED");
    assert.equal(report.pageErrors.length, 0, "PAGE_ERRORS:" + JSON.stringify(report.pageErrors));
    assert.equal(report.consoleErrors.length, 0, "CONSOLE_ERRORS:" + JSON.stringify(report.consoleErrors));
    assert.equal(report.serverErrors.length, 0, "SERVER_ERRORS:" + JSON.stringify(report.serverErrors));
    await writeFile(path.join(outputDir, "report.json"), JSON.stringify({ ...report, ok: true }, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({
      ok: true,
      outputDir,
      themeViews: report.themes.length,
      adjacentViews: report.adjacentPages.length,
      blockedWrites: report.blockedWrites.length,
    }, null, 2));
  } catch (error) {
    await writeFile(path.join(outputDir, "failure.json"), JSON.stringify({ ...report, error: String(error) }, null, 2) + "\n", "utf8");
    throw error;
  } finally {
    await browser.close();
  }
}

const isCli = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
