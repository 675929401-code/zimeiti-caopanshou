#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = process.cwd();
const baseUrl = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const baseOrigin = new URL(baseUrl).origin;
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const evidenceDir = path.join(root, ".codex-evidence", "voice-cover-ui-20260928");
const themes = [
  { id: "lattice", mode: "dark", label: "深空金" },
  { id: "crystal-aurora", mode: "dark", label: "黑曜霓彩" },
  { id: "soft-white", mode: "light", label: "柔光白" },
  { id: "stellar-blue", mode: "dark", label: "极光蓝" },
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

function rgbLuminance(value) {
  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `Cannot parse color ${value}`);
  const linear = channels.map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function safePath(value) {
  const url = new URL(value, baseUrl);
  return url.origin === baseOrigin ? url.pathname : "external";
}

async function configureContext(browser, theme, viewport, audit) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.addInitScript(({ themeId, authToken }) => {
    localStorage.setItem("app_theme", themeId);
    localStorage.setItem("user_theme_preference", themeId);
    localStorage.setItem("auth_token", authToken);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("ai-cover-director-draft-v5:") || key.startsWith("cover-generation-attempt:")) localStorage.removeItem(key);
    }
  }, { themeId: theme.id, authToken: token });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => audit.pageErrors.push(`${theme.id}/${viewport.width}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) {
      audit.consoleErrors.push(`${theme.id}/${viewport.width}: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) audit.httpErrors.push(`${theme.id}/${viewport.width}: ${response.status()} ${safePath(response.url())}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== baseOrigin) {
      audit.externalRequests.push(`${request.method()} ${url.hostname}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (request.method() === "GET" && url.pathname === "/api/auth/me") {
      const response = await route.fetch();
      assert.ok(response.ok(), `Local identity unavailable: ${response.status()}`);
      const payload = await response.json();
      return route.fulfill({
        response,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ...payload, user: { ...payload.user, themePreference: theme.id, theme_preference: theme.id } }),
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      if (["/api/diagnostic-logs", "/api/announcements/events"].includes(url.pathname)) {
        audit.passiveTelemetry.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 204, body: "" });
      }
      audit.blockedWrites.push(`${request.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return { context, page };
}

async function verifyVoice(browser, theme, viewport, audit) {
  const { context, page } = await configureContext(browser, theme, viewport, audit);
  try {
    const response = await page.goto(`${baseUrl}/voice-studio/workspace`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(response?.status(), 200);
    await page.locator(".vs-synthesis-editor").waitFor({ state: "visible" });
    const historyButton = page.locator('.vs-history-flyout button[aria-controls="voice-generation-history-content"]');
    await historyButton.waitFor({ state: "visible" });
    const initial = await page.evaluate(() => {
      const shell = document.querySelector(".vs-studio-shell");
      const intro = document.querySelector(".vs-page-intro");
      const hero = document.querySelector(".vs-page-hero");
      const history = document.querySelector(".vs-history-flyout > section");
      const toolbar = document.querySelector(".vs-model-toolbar");
      const editor = document.querySelector(".vs-synthesis-editor");
      if (!(shell instanceof HTMLElement) || !(intro instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(history instanceof HTMLElement) || !(toolbar instanceof HTMLElement) || !(editor instanceof HTMLElement)) throw new Error("Voice workspace structure incomplete");
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellOverflowX: shell.scrollWidth - shell.clientWidth,
        shellOverflowY: getComputedStyle(shell).overflowY,
        shellScrollable: shell.scrollHeight > shell.clientHeight + 40,
        shellBackground: getComputedStyle(shell).backgroundColor,
        intro: box(intro), hero: box(hero), history: box(history), toolbar: box(toolbar), editor: box(editor),
      };
    });
    assert.equal(initial.theme, theme.id);
    assert.equal(initial.mode, theme.mode);
    assert.ok(initial.documentOverflowX <= 1, `Voice document overflow ${initial.documentOverflowX}`);
    assert.ok(initial.shellOverflowX <= 1, `Voice shell overflow ${initial.shellOverflowX}`);
    assert.match(initial.shellOverflowY, /auto|scroll/u);
    assert.ok(initial.shellScrollable, "Voice shell must have scrollable content");
    assert.ok(initial.history.width <= 50 && initial.history.height <= 50, `History control is not compact: ${JSON.stringify(initial.history)}`);
    assert.ok(initial.history.right <= viewport.width - 20 && initial.history.left > initial.hero.left + initial.hero.width * 0.7, "History control must stay in the upper-right of the title area");
    assert.ok(initial.toolbar.top - initial.intro.bottom <= 28, `Voice editor wastes vertical space: ${initial.toolbar.top - initial.intro.bottom}px`);
    assert.ok(initial.editor.top < viewport.height, "Voice editor must start in the first viewport");
    assert.ok(theme.mode === "light" ? rgbLuminance(initial.shellBackground) > 0.7 : rgbLuminance(initial.shellBackground) < 0.2, initial.shellBackground);

    await page.mouse.move(viewport.width / 2, viewport.height * 0.72);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
    const scrollTop = await page.locator(".vs-studio-shell").evaluate((element) => element.scrollTop);
    assert.ok(scrollTop > 120, `Mouse wheel did not scroll the voice shell: ${scrollTop}`);
    await page.locator(".vs-studio-shell").evaluate((element) => { element.scrollTop = 0; });

    await historyButton.click();
    await page.locator('.vs-history-flyout button[aria-expanded="true"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const history = document.querySelector(".vs-history-flyout > section");
      return history instanceof HTMLElement && history.getBoundingClientRect().width >= 520;
    });
    const expanded = await page.locator(".vs-history-flyout > section").boundingBox();
    assert.ok(expanded && expanded.width >= 520 && expanded.x + expanded.width <= viewport.width - 20, `History flyout geometry invalid: ${JSON.stringify(expanded)}`);
    await page.getByRole("button", { name: "收起生成历史", exact: true }).click();
    await page.waitForFunction(() => {
      const history = document.querySelector(".vs-history-flyout > section");
      return history instanceof HTMLElement && history.getBoundingClientRect().width <= 50;
    });

    const screenshot = path.join(evidenceDir, `voice-${theme.id}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    audit.scenarios.push({ page: "/voice-studio/workspace", theme: theme.id, viewport, screenshot, initial, wheelScrollTop: scrollTop, historyExpandedWidth: expanded.width });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function verifyCover(browser, theme, viewport, audit) {
  const { context, page } = await configureContext(browser, theme, viewport, audit);
  try {
    const response = await page.goto(`${baseUrl}/cover`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(response?.status(), 200);
    await page.locator(".cover-empty-state").waitFor({ state: "visible" });
    await page.locator(".cover-flagship-models button").first().waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector(".cover-rebuild-shell");
      const director = document.querySelector(".cover-director-panel");
      const card = document.querySelector(".cover-director-panel .cover-priority-card");
      const input = document.querySelector('.cover-brief-card > textarea[aria-label="输入文案"]');
      const result = document.querySelector(".cover-copy-result-editor");
      const cost = document.querySelector(".cover-cost-line");
      const preview = document.querySelector(".cover-main-preview.is-idle");
      const stage = document.querySelector(".cover-result-stage");
      const flow = document.querySelectorAll(".cover-empty-flow > span");
      const emptyState = document.querySelector(".cover-empty-state");
      const flagshipModels = document.querySelectorAll(".cover-flagship-models button");
      const setupCards = [...document.querySelectorAll(".cover-setup-card")];
      if (!(shell instanceof HTMLElement) || !(director instanceof HTMLElement) || !(card instanceof HTMLElement) || !(input instanceof HTMLElement) || !(result instanceof HTMLElement) || !(cost instanceof HTMLElement) || !(preview instanceof HTMLElement) || !(stage instanceof HTMLElement)) throw new Error("Cover workspace structure incomplete");
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const effectiveBackground = (element) => {
        let current = element;
        while (current instanceof HTMLElement) {
          const color = getComputedStyle(current).backgroundColor;
          if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
          current = current.parentElement;
        }
        return getComputedStyle(document.documentElement).backgroundColor;
      };
      const cardBoxes = setupCards.map(box);
      const cardBackgrounds = setupCards.map(effectiveBackground);
      const stageBefore = getComputedStyle(stage, "::before");
      return {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellOverflowX: shell.scrollWidth - shell.clientWidth,
        shellBackground: getComputedStyle(shell).backgroundColor,
        director: box(director), card: box(card), input: box(input), result: box(result), cost: box(cost), preview: box(preview),
        trailingGap: box(card).bottom - box(cost).bottom,
        setupCardCount: setupCards.length,
        flagshipModelCount: flagshipModels.length,
        setupCardHeights: cardBoxes.map((item) => item.height),
        setupCardBackgrounds: cardBackgrounds,
        flowCount: flow.length,
        emptyStateTitle: emptyState?.querySelector("strong")?.textContent?.trim() || "",
        emptyStateDescription: emptyState?.querySelector("span:not(.cover-empty-icon)")?.textContent?.trim() || "",
        stageDecoration: { width: Number.parseFloat(stageBefore.width), height: Number.parseFloat(stageBefore.height), clipPath: stageBefore.clipPath, opacity: Number.parseFloat(stageBefore.opacity) },
      };
    });
    assert.equal(metrics.theme, theme.id);
    assert.equal(metrics.mode, theme.mode);
    assert.ok(metrics.documentOverflowX <= 1, `Cover document overflow ${metrics.documentOverflowX}`);
    assert.ok(metrics.shellOverflowX <= 1, `Cover shell overflow ${metrics.shellOverflowX}`);
    assert.equal(metrics.setupCardCount, 4);
    assert.ok(metrics.flagshipModelCount >= 3, `Expected three flagship cover models, found ${metrics.flagshipModelCount}`);
    assert.ok(Math.max(...metrics.setupCardHeights) - Math.min(...metrics.setupCardHeights) <= 1.5, `Setup cards are not equal height: ${metrics.setupCardHeights}`);
    assert.ok(metrics.card.height >= metrics.director.height - 2, "Copy card must fill the left rail");
    assert.ok(metrics.input.height >= 110 && metrics.input.height <= 155, `Input copy height is unreasonable: ${metrics.input.height}`);
    assert.ok(metrics.result.height >= 145, `Decomposition result is too short: ${metrics.result.height}`);
    assert.ok(metrics.trailingGap <= 18, `Left rail keeps an unused bottom gap: ${metrics.trailingGap}`);
    assert.ok(metrics.preview.width <= 570 && metrics.preview.height <= metrics.director.height - 18, `Idle preview is oversized: ${JSON.stringify(metrics.preview)}`);
    assert.equal(metrics.flowCount, 0, "Legacy three-step empty flow must stay removed");
    assert.equal(metrics.emptyStateTitle, "还没有生成封面");
    assert.match(metrics.emptyStateDescription, /完成拆解并确认封面文字/u);
    assert.ok(metrics.stageDecoration.width <= 190 && metrics.stageDecoration.height <= 190 && metrics.stageDecoration.opacity <= 0.14, `Stage decoration is too dominant: ${JSON.stringify(metrics.stageDecoration)}`);
    if (theme.mode === "dark") {
      assert.ok(metrics.setupCardBackgrounds.every((color) => rgbLuminance(color) < 0.2), `Dark theme contains light setup cards: ${metrics.setupCardBackgrounds.join(", ")}`);
      assert.ok(rgbLuminance(metrics.shellBackground) < 0.2, metrics.shellBackground);
    } else {
      assert.ok(metrics.setupCardBackgrounds.every((color) => rgbLuminance(color) > 0.65), `Light theme contains dark setup cards: ${metrics.setupCardBackgrounds.join(", ")}`);
    }
    const screenshot = path.join(evidenceDir, `cover-${theme.id}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    audit.scenarios.push({ page: "/cover", theme: theme.id, viewport, screenshot, metrics });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function verifyAdjacent(browser, theme, audit) {
  const viewport = { width: 1440, height: 900 };
  for (const pageCase of [
    { path: "/voice-studio/voices", selector: ".voice-studio-root", marker: "音色" },
    { path: "/tools?tab=video", selector: '[data-page="tools"]', marker: "视频" },
  ]) {
    const { context, page } = await configureContext(browser, theme, viewport, audit);
    try {
      const response = await page.goto(`${baseUrl}${pageCase.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200);
      await page.locator(pageCase.selector).waitFor({ state: "visible" });
      await page.getByText(pageCase.marker, { exact: false }).first().waitFor({ state: "visible" });
      const metrics = await page.evaluate((selector) => {
        const rootElement = document.querySelector(selector);
        if (!(rootElement instanceof HTMLElement)) throw new Error(`Adjacent root missing: ${selector}`);
        const rect = rootElement.getBoundingClientRect();
        return {
          theme: document.documentElement.dataset.theme,
          mode: document.documentElement.dataset.mode,
          documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rootOverflowX: rootElement.scrollWidth - rootElement.clientWidth,
          box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          textLength: rootElement.innerText.trim().length,
        };
      }, pageCase.selector);
      assert.equal(metrics.theme, theme.id);
      assert.equal(metrics.mode, theme.mode);
      assert.ok(metrics.documentOverflowX <= 1 && metrics.rootOverflowX <= 1, `${pageCase.path} horizontal overflow`);
      assert.ok(metrics.box.left >= -1 && metrics.box.right <= viewport.width + 1, `${pageCase.path} root outside viewport`);
      assert.ok(metrics.textLength >= 60, `${pageCase.path} content incomplete`);
      const screenshot = path.join(evidenceDir, `adjacent-${pageCase.path.includes("voices") ? "voices" : "tools-video"}-${theme.id}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      audit.scenarios.push({ page: pageCase.path, theme: theme.id, viewport, screenshot, metrics, adjacentRegression: true });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  }
}

export async function main() {
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const localBuildId = fs.readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim();
  const versionResponse = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.ok(versionResponse.ok, `Local version unavailable: ${versionResponse.status}`);
  const version = await versionResponse.json();
  assert.equal(version.buildId, localBuildId, "Served runtime is not the current local build");

  const audit = { scenarios: [], pageErrors: [], consoleErrors: [], httpErrors: [], externalRequests: [], blockedWrites: [], passiveTelemetry: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        await verifyVoice(browser, theme, viewport, audit);
        await verifyCover(browser, theme, viewport, audit);
      }
      await verifyAdjacent(browser, theme, audit);
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(audit.blockedWrites, [], `Unexpected business writes: ${audit.blockedWrites.join(" | ")}`);
  assert.deepEqual(audit.pageErrors, [], `Page errors: ${audit.pageErrors.join(" | ")}`);
  assert.deepEqual(audit.consoleErrors, [], `Console errors: ${audit.consoleErrors.join(" | ")}`);
  assert.deepEqual(audit.httpErrors, [], `HTTP errors: ${audit.httpErrors.join(" | ")}`);
  assert.deepEqual(audit.externalRequests, [], `External requests: ${audit.externalRequests.join(" | ")}`);

  const report = {
    passed: true,
    buildId: localBuildId,
    observedAt: new Date().toISOString(),
    source: "LIVE_LOCAL_BROWSER_ZERO_COST",
    viewports,
    themes,
    scenarioCount: audit.scenarios.length,
    scenarios: audit.scenarios,
    paidRequests: 0,
    providerCalls: 0,
    businessWrites: 0,
    pageErrors: 0,
    consoleErrors: 0,
    httpErrors: 0,
    externalRequests: 0,
    passiveTelemetry: audit.passiveTelemetry,
  };
  const reportPath = path.join(evidenceDir, "voice-cover-ui-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
  console.log(JSON.stringify({ passed: true, buildId: localBuildId, scenarioCount: audit.scenarios.length, reportPath }, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
