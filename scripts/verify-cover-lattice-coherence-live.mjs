#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const outputDir = path.resolve(process.env.COVER_LATTICE_OUTPUT_DIR || ".codex-evidence/cover-design-selection-20260928/live");
const themes = [
  { id: "lattice", mode: "dark", label: "深空晶" },
  { id: "crystal-aurora", mode: "dark", label: "黑曜霓彩" },
  { id: "soft-white", mode: "light", label: "柔光白" },
];
const coverViewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const adjacentPages = [
  { route: "/voice-studio/workspace", selector: ".voice-studio-root", slug: "voice-workspace" },
  { route: "/tools?tab=video", selector: '[data-page="tools"]', slug: "tools-video" },
];

function safeRoute(value) {
  const url = new URL(value, origin);
  return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}` : `external:${url.hostname}${url.pathname}`;
}

function colorChannels(value) {
  return value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) || [];
}

function luminance(value) {
  const channels = colorChannels(value);
  assert.equal(channels.length, 3, `Unable to parse color: ${value}`);
  const linear = channels.map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function createContext(browser, theme, viewport, audit) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block", colorScheme: theme.mode });
  await context.addInitScript(({ authToken, selectedTheme }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("app_theme", selectedTheme);
    localStorage.removeItem("app_mode");
    localStorage.setItem("user_theme_preference", selectedTheme);
    sessionStorage.setItem("entered_app", "1");
  }, { authToken: token, selectedTheme: theme.id });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => audit.pageErrors.push(`${theme.id}/${viewport.width}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) {
      audit.consoleErrors.push(`${theme.id}/${viewport.width}: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) audit.httpErrors.push(`${theme.id}/${viewport.width}: ${response.status()} ${safeRoute(response.url())}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== new URL(origin).origin) {
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
        body: JSON.stringify({
          ...payload,
          user: { ...payload.user, themePreference: theme.id, theme_preference: theme.id },
        }),
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

async function verifyCover(browser, theme, viewport, audit) {
  const { context, page } = await createContext(browser, theme, viewport, audit);
  try {
    const response = await page.goto(`${origin}/cover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200, `Cover returned ${response?.status()}`);
    const visibleShell = page.locator(".cover-rebuild-shell:visible").first();
    await visibleShell.waitFor({ state: "visible" });
    await visibleShell.locator(".cover-empty-state:visible").first().waitFor({ state: "visible" });
    await page.waitForTimeout(500);

    const metrics = await visibleShell.evaluate((shell) => {
      const topbar = shell.querySelector(".cover-rebuild-topbar");
      const brand = shell.querySelector(".cover-rebuild-brand");
      const back = shell.querySelector(".cover-rebuild-back");
      const actions = shell.querySelector(".cover-rebuild-actions");
      const setupGrid = shell.querySelector(".cover-setup-grid");
      const setupCards = [...shell.querySelectorAll(".cover-setup-card")];
      const director = shell.querySelector(".cover-director-panel");
      const result = shell.querySelector(".cover-rebuild-stage");
      const resultStage = shell.querySelector(".cover-result-stage");
      const emptyPreview = shell.querySelector(".cover-main-preview.is-idle");
      const input = shell.querySelector('textarea[aria-label="输入文案"]');
      const decomposition = shell.querySelector(".cover-copy-result-editor");
      const brandTitle = brand?.querySelector("strong");
      if (![shell, topbar, brand, brandTitle, back, actions, setupGrid, director, result, resultStage, emptyPreview, input, decomposition]
        .every((element) => element instanceof HTMLElement)) throw new Error("Cover structure is incomplete");
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const visibleTextSizes = [...shell.querySelectorAll("*")]
        .filter((element) => element instanceof HTMLElement && element.childElementCount === 0 && element.textContent?.trim())
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((element) => Number.parseFloat(getComputedStyle(element).fontSize))
        .filter(Number.isFinite);
      const cardBoxes = setupCards.map(box);
      const controlSelectors = [".cover-flagship-models", ".cover-mode-switch", ".cover-source-options", ".cover-ratio-picker"];
      const titleControlGaps = setupCards.map((card, index) => {
        const title = card.querySelector(".cover-card-title");
        const control = card.querySelector(controlSelectors[index]);
        if (!(title instanceof HTMLElement) || !(control instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
        return control.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      });
      const shellStyle = getComputedStyle(shell);
      const topbarStyle = getComputedStyle(topbar);
      const brandStyle = getComputedStyle(brandTitle);
      const resultStyle = getComputedStyle(resultStage);
      return {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        shellOverflowX: shell.scrollWidth - shell.clientWidth,
        topbar: box(topbar),
        brand: box(brand),
        back: box(back),
        actions: box(actions),
        emptyPreview: box(emptyPreview),
        backText: back.textContent?.trim(),
        backHref: back.getAttribute("href"),
        brandText: brand.textContent?.trim(),
        brandChildTagNames: [...brand.children].map((element) => element.tagName),
        brandDecorativeCount: brand.querySelectorAll("small, em, .cover-brand-mark, img, svg").length,
        brandFontSize: Number.parseFloat(brandStyle.fontSize),
        brandColor: brandStyle.color,
        workbenchShortcutCount: shell.querySelectorAll(".cover-workbench-switch").length,
        setupCardCount: setupCards.length,
        setupCardWidths: cardBoxes.map((item) => item.width),
        setupCardTops: cardBoxes.map((item) => item.top),
        setupCardHeights: cardBoxes.map((item) => item.height),
        setupTitleControlGaps: titleControlGaps,
        flagshipModelButtonCount: shell.querySelectorAll(".cover-flagship-models > button").length,
        activeSetupChoiceCount: shell.querySelectorAll(".cover-setup-grid button.is-active").length,
        director: box(director),
        result: box(result),
        input: box(input),
        decomposition: box(decomposition),
        shellBackgroundColor: shellStyle.backgroundColor,
        shellBackgroundImage: shellStyle.backgroundImage,
        topbarBackgroundColor: topbarStyle.backgroundColor,
        topbarBackgroundImage: topbarStyle.backgroundImage,
        resultBackgroundImage: resultStyle.backgroundImage,
        resultBackgroundColor: resultStyle.backgroundColor,
        minVisibleFontSize: Math.min(...visibleTextSizes),
      };
    });

    assert.equal(metrics.theme, theme.id);
    assert.equal(metrics.mode, theme.mode);
    assert.ok(metrics.bodyOverflowX <= 1, `Document horizontal overflow: ${metrics.bodyOverflowX}px`);
    assert.ok(metrics.shellOverflowX <= 1, `Cover shell horizontal overflow: ${metrics.shellOverflowX}px`);
    assert.ok(Math.abs(metrics.topbar.height - 64) <= 1, `Top bar should be 64px, got ${metrics.topbar.height}`);
    assert.equal(metrics.backText, "返回主页");
    assert.equal(metrics.backHref, "/");
    assert.ok(metrics.back.left < metrics.brand.left, "Return-home control must stay on the far left");
    assert.ok(metrics.actions.left > metrics.brand.right, "Theme control must stay to the right of the centered brand");
    assert.ok(Math.abs((metrics.brand.left + metrics.brand.right) / 2 - viewport.width / 2) <= 2, `Cover brand is not centered: ${JSON.stringify(metrics.brand)}`);
    assert.equal(metrics.brandText, "封面制作", "Header must keep only the Chinese product title");
    assert.deepEqual(metrics.brandChildTagNames, ["STRONG"], `Header contains unexpected logo or English copy: ${metrics.brandChildTagNames}`);
    assert.equal(metrics.brandDecorativeCount, 0, "Header must not contain a logo, English eyebrow, subtitle, or decorative icon");
    assert.ok(metrics.brandFontSize >= 20, `Cover title is visually weak: ${metrics.brandFontSize}px`);
    assert.ok(contrastRatio(metrics.brandColor, metrics.topbarBackgroundColor) >= 4.5,
      `Cover title contrast is below 4.5: ${metrics.brandColor} on ${metrics.topbarBackgroundColor}`);
    assert.equal(metrics.workbenchShortcutCount, 0, "Cover page must not repeat cross-workbench shortcuts");
    assert.equal(metrics.setupCardCount, 4);
    assert.ok(Math.max(...metrics.setupCardTops) - Math.min(...metrics.setupCardTops) <= 1.5, `Setup cards do not share a top edge: ${metrics.setupCardTops}`);
    assert.ok(Math.max(...metrics.setupCardHeights) - Math.min(...metrics.setupCardHeights) <= 1.5, `Setup cards are not equal height: ${metrics.setupCardHeights}`);
    assert.ok(Math.max(...metrics.setupCardWidths) - Math.min(...metrics.setupCardWidths) <= 1.5, `Setup cards are not equally divided: ${metrics.setupCardWidths}`);
    assert.ok(metrics.setupCardHeights.every((height) => height >= 110 && height <= 155), `Setup row height is not compact: ${metrics.setupCardHeights}`);
    assert.ok(metrics.setupTitleControlGaps.every((gap) => gap >= 6 && gap <= 20), `Setup controls leave an unnecessary vertical gap: ${metrics.setupTitleControlGaps}`);
    assert.equal(metrics.flagshipModelButtonCount, 3, "Cover Studio must expose exactly the three confirmed flagship models");
    assert.ok(metrics.activeSetupChoiceCount >= 4, `Selected parameter states are incomplete: ${metrics.activeSetupChoiceCount}`);
    assert.ok(metrics.director.left < metrics.result.left, "Editor must remain to the left of the result area");
    assert.ok(metrics.input.height >= 110 && metrics.input.height <= 165, `Input box height is unreasonable: ${metrics.input.height}`);
    assert.ok(metrics.decomposition.height >= 135, `Decomposition editor is too short: ${metrics.decomposition.height}`);
    assert.ok(metrics.minVisibleFontSize >= 10.5, `Visible text is too small: ${metrics.minVisibleFontSize}px`);
    assert.ok(metrics.emptyPreview.width >= 300 && metrics.emptyPreview.width <= 380,
      `Empty preview width is not restrained: ${metrics.emptyPreview.width}`);
    assert.ok(metrics.emptyPreview.height >= 220 && metrics.emptyPreview.height <= 280,
      `Empty preview height is not restrained: ${metrics.emptyPreview.height}`);
    assert.equal(metrics.shellBackgroundImage, "none", `Cover shell still uses a decorative gradient: ${metrics.shellBackgroundImage}`);
    assert.equal(metrics.topbarBackgroundImage, "none", `Cover header still uses a decorative gradient: ${metrics.topbarBackgroundImage}`);
    assert.equal((metrics.resultBackgroundImage.match(/gradient/gu) || []).length, 2,
      `Result stage must keep only the restrained two-line grid: ${metrics.resultBackgroundImage}`);
    if (theme.mode === "light") {
      assert.ok(luminance(metrics.shellBackgroundColor) > 0.72, `Warm-white shell is too dark: ${metrics.shellBackgroundColor}`);
      assert.ok(luminance(metrics.topbarBackgroundColor) > 0.8, `Warm-white header is too dark: ${metrics.topbarBackgroundColor}`);
    } else {
      assert.ok(luminance(metrics.shellBackgroundColor) < 0.2, `${theme.label} shell is not dark: ${metrics.shellBackgroundColor}`);
      assert.ok(luminance(metrics.topbarBackgroundColor) < 0.2, `${theme.label} header is not dark: ${metrics.topbarBackgroundColor}`);
    }

    const screenshot = path.join(outputDir, `cover-${theme.id}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    audit.scenarios.push({ route: "/cover", theme: theme.id, viewport, screenshot, metrics });

    if (theme.id === "lattice" && viewport.width === 1440) {
      await visibleShell.getByRole("button", { name: /参考模板/u }).click();
      await visibleShell.getByRole("button", { name: "浏览模板库", exact: true }).click();
      const library = page.locator('.cover-template-library-dialog[aria-label="选择模板版式"]:visible').first();
      await library.waitFor({ state: "visible" });
      await page.waitForTimeout(250);
      const libraryMetrics = await library.evaluate((dialog) => {
        const grid = dialog.querySelector(".cover-template-library-grid");
        if (!(dialog instanceof HTMLElement) || !(grid instanceof HTMLElement)) throw new Error("Template library structure is incomplete");
        const rect = dialog.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        const itemTops = [...grid.querySelectorAll(".cover-template-library-item")].slice(0, 40).map((item) => Math.round(item.getBoundingClientRect().top));
        return {
          itemCount: grid.querySelectorAll(".cover-template-library-item").length,
          dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
          grid: { width: gridRect.width, height: gridRect.height, scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight },
          visibleRowCount: new Set(itemTops.filter((top) => top < gridRect.bottom)).size,
          footerCount: dialog.querySelectorAll(":scope > footer").length,
        };
      });
      assert.ok(libraryMetrics.itemCount >= 100, `Template library still paginates items: ${libraryMetrics.itemCount}`);
      assert.equal(libraryMetrics.footerCount, 0, "Template library must not keep previous/next pagination");
      assert.ok(libraryMetrics.dialog.width >= viewport.width * 0.8, `Template library does not use the available page width: ${libraryMetrics.dialog.width}`);
      assert.ok(libraryMetrics.dialog.height >= viewport.height * 0.82, `Template library does not use the available page height: ${libraryMetrics.dialog.height}`);
      assert.ok(libraryMetrics.grid.scrollHeight > libraryMetrics.grid.clientHeight, "Full template collection must continue in one scrollable grid");
      assert.ok(libraryMetrics.visibleRowCount >= 2, `Template library does not fill the first view: ${libraryMetrics.visibleRowCount} rows`);
      const libraryScreenshot = path.join(outputDir, "cover-lattice-template-library-1440x900.png");
      await page.screenshot({ path: libraryScreenshot, fullPage: false });

      const firstTemplate = library.locator('.cover-template-library-option[aria-label^="放大预览"]').first();
      const firstTemplateName = (await firstTemplate.getAttribute("aria-label"))?.replace(/^放大预览/u, "") || "";
      await firstTemplate.click();
      const preview = page.locator(".cover-template-preview-dialog:visible").first();
      await preview.waitFor({ state: "visible" });
      const previewImage = preview.locator(".cover-template-preview-image img");
      await previewImage.waitFor({ state: "visible" });
      await previewImage.evaluate((image) => new Promise((resolve, reject) => {
        if (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return resolve(true);
        const timeout = window.setTimeout(() => reject(new Error("Template preview image did not load")), 30_000);
        image.addEventListener("load", () => { window.clearTimeout(timeout); resolve(true); }, { once: true });
        image.addEventListener("error", () => { window.clearTimeout(timeout); reject(new Error("Template preview image failed")); }, { once: true });
      }));
      const previewMetrics = await preview.evaluate((element) => {
        const image = element.querySelector("img");
        const rect = element.getBoundingClientRect();
        const imageRect = image?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          imageWidth: imageRect?.width || 0,
          imageHeight: imageRect?.height || 0,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        };
      });
      assert.ok(previewMetrics.imageWidth >= 300 && previewMetrics.imageHeight >= 380, `Template preview is not meaningfully enlarged: ${JSON.stringify(previewMetrics)}`);
      assert.ok(previewMetrics.naturalWidth > 0 && previewMetrics.naturalHeight > 0, "Template preview image did not load");
      const previewScreenshot = path.join(outputDir, "cover-lattice-template-preview-1440x900.png");
      await page.screenshot({ path: previewScreenshot, fullPage: false });
      await preview.getByRole("button", { name: "使用此模板", exact: true }).click();
      await preview.waitFor({ state: "hidden" });
      await library.waitFor({ state: "hidden" });
      await visibleShell.getByText(firstTemplateName, { exact: true }).first().waitFor({ state: "visible" });
      audit.scenarios.push({
        route: "/cover#template-library",
        theme: theme.id,
        viewport,
        screenshot: libraryScreenshot,
        previewScreenshot,
        libraryMetrics,
        previewMetrics,
        selectedTemplate: firstTemplateName,
        templateWorkflow: true,
      });
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function verifyProgressFixture(browser, audit) {
  const theme = themes[0];
  const viewport = coverViewports[0];
  const { context, page } = await createContext(browser, theme, viewport, audit);
  const activeAttempt = {
    clientIdempotencyKey: "fixture_cover_request_123",
    clientTraceId: "fixture_cover_trace_123",
    state: "dispatched",
    updatedAt: Date.now(),
    canDispatch: false,
    requiresReferenceReupload: false,
    task: {
      id: "fixture-running-cover",
      ratio: "3:4",
      title: "测试封面",
      subtitle: "",
      prompt: "验证封面生成进度视觉",
      source: "生成",
      createdAt: new Date().toISOString(),
      taskNo: 7,
    },
  };
  try {
    let historyFixtureHits = 0;
    await page.route("**/api/cover/history*", (route) => {
      historyFixtureHits += 1;
      return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        records: [],
        activeAttempt,
        activeAttempts: [activeAttempt],
        activeAttemptReady: true,
        nextPage: null,
        failureHistory: { ready: true, message: "" },
      }),
      });
    });
    await page.route("**/api/cover/attempt?*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ activeAttempt }),
    }));

    const response = await page.goto(`${origin}/cover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200, `Progress fixture cover returned ${response?.status()}`);
    const visibleShell = page.locator(".cover-rebuild-shell:visible").first();
    await visibleShell.waitFor({ state: "visible" });
    await visibleShell.getByRole("button", { name: /历史记录/u }).click();
    const historyDrawer = page.getByRole("dialog", { name: "封面历史记录", exact: true });
    await historyDrawer.waitFor({ state: "visible" });
    const taskButton = historyDrawer.getByRole("button", { name: /^任务七/u });
    if (!await taskButton.isVisible().catch(() => false)) {
      const refreshButton = historyDrawer.getByRole("button", { name: "刷新历史", exact: true });
      await Promise.race([
        taskButton.waitFor({ state: "visible", timeout: 15_000 }),
        refreshButton.waitFor({ state: "visible", timeout: 15_000 }),
      ]).catch(() => undefined);
      if (!await taskButton.isVisible().catch(() => false)) {
        if (!await refreshButton.isVisible().catch(() => false)) {
          throw new Error(`Progress fixture history never settled:\n${await historyDrawer.innerText()}`);
        }
        await refreshButton.click();
      }
    }
    await taskButton.waitFor({ state: "visible" });
    assert.ok(historyFixtureHits >= 1, "Progress fixture did not exercise the account history GET path");
    await taskButton.click();
    await historyDrawer.getByRole("button", { name: "关闭历史记录", exact: true }).click();
    const progress = visibleShell.getByRole("progressbar", { name: "封面生成阶段" });
    await progress.waitFor({ state: "visible" });

    const metrics = await visibleShell.evaluate((shell) => {
      const preview = shell.querySelector(".cover-main-preview.is-running");
      const progressBar = shell.querySelector('[role="progressbar"][aria-label="封面生成阶段"]');
      const card = shell.querySelector(".cover-rendering-card");
      if (!(preview instanceof HTMLElement) || !(progressBar instanceof HTMLElement) || !(card instanceof HTMLElement)) {
        throw new Error("Progress fixture did not render the running state");
      }
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return { width: value.width, height: value.height, left: value.left, right: value.right, top: value.top, bottom: value.bottom };
      };
      return {
        preview: rect(preview),
        card: rect(card),
        progressValue: progressBar.getAttribute("aria-valuenow"),
        progressMaximum: progressBar.getAttribute("aria-valuemax"),
        progressText: progressBar.getAttribute("aria-valuetext"),
        stepCount: shell.querySelectorAll(".cover-rendering-steps > li").length,
        activeStepText: shell.querySelector(".cover-rendering-steps > li.is-active")?.textContent?.trim(),
        legacyDecorativeSceneCount: shell.querySelectorAll(".cover-aurora-scene, .cover-render-grid, .cover-meteor").length,
        cancelButtonCount: [...shell.querySelectorAll(".cover-result-actions button")]
          .filter((button) => button.textContent?.includes("终止任务")).length,
      };
    });
    assert.equal(metrics.progressValue, "2", `Dispatched task must show phase 2: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.progressMaximum, "3");
    assert.match(metrics.progressText || "", /模型生成中/u);
    assert.equal(metrics.stepCount, 3, "Generation progress must expose the three truthful platform stages");
    assert.match(metrics.activeStepText || "", /模型生成中/u);
    assert.equal(metrics.legacyDecorativeSceneCount, 0, "Generation state still contains the rejected decorative animation scene");
    assert.equal(metrics.cancelButtonCount, 1, "Running task must expose exactly one toolbar cancel action");
    assert.ok(metrics.preview.width <= 600 && metrics.preview.height <= 380,
      `Running preview is oversized: ${JSON.stringify(metrics.preview)}`);
    assert.ok(metrics.card.width <= metrics.preview.width && metrics.card.height <= metrics.preview.height,
      `Progress card overflows the preview: ${JSON.stringify(metrics)}`);

    const screenshot = path.join(outputDir, "cover-progress-fixture-lattice-1440x900.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    audit.scenarios.push({
      route: "/cover#progress-fixture",
      theme: theme.id,
      viewport,
      screenshot,
      fixtureSource: "READ_ONLY_API_SNAPSHOT",
      providerCalls: 0,
      paidRequests: 0,
      metrics,
    });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function verifyAdjacent(browser, pageCase, audit) {
  const theme = themes[0];
  const viewport = coverViewports[0];
  const { context, page } = await createContext(browser, theme, viewport, audit);
  try {
    const response = await page.goto(`${origin}${pageCase.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200, `${pageCase.route} returned ${response?.status()}`);
    await page.locator(`${pageCase.selector}:visible`).first().waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    const metrics = await page.evaluate((selector) => {
      const rootElement = [...document.querySelectorAll(selector)].find((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      if (!(rootElement instanceof HTMLElement)) throw new Error(`Missing adjacent root ${selector}`);
      const rect = rootElement.getBoundingClientRect();
      return {
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rootOverflowX: rootElement.scrollWidth - rootElement.clientWidth,
        box: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        textLength: rootElement.innerText.trim().length,
        backgroundColor: getComputedStyle(rootElement).backgroundColor,
        backgroundImage: getComputedStyle(rootElement).backgroundImage,
      };
    }, pageCase.selector);
    assert.equal(metrics.theme, "lattice");
    assert.equal(metrics.mode, "dark");
    assert.ok(metrics.documentOverflowX <= 1, `${pageCase.route} document overflow ${metrics.documentOverflowX}px`);
    assert.ok(metrics.rootOverflowX <= 1, `${pageCase.route} root overflow ${metrics.rootOverflowX}px`);
    assert.ok(metrics.box.left >= -1 && metrics.box.right <= viewport.width + 1, `${pageCase.route} root is outside the viewport`);
    assert.ok(metrics.textLength >= 40, `${pageCase.route} did not render enough content`);
    const screenshot = path.join(outputDir, `adjacent-${pageCase.slug}-lattice-1440x900.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    audit.scenarios.push({ route: pageCase.route, theme: "lattice", viewport, screenshot, metrics, adjacentRegression: true });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await mkdir(outputDir, { recursive: true });

  const localBuildId = (await readFile(path.join(root, ".next", "BUILD_ID"), "utf8")).trim();
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.ok(versionResponse.ok, `Local version unavailable: ${versionResponse.status}`);
  const version = await versionResponse.json();
  assert.equal(version.buildId, localBuildId, "Served runtime is not the current local build");

  const audit = {
    passed: false,
    buildId: localBuildId,
    sourceVersion: version.sourceVersion,
    observedAt: new Date().toISOString(),
    source: "LIVE_LOCAL_BROWSER_ZERO_COST",
    scenarios: [],
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    externalRequests: [],
    blockedWrites: [],
    passiveTelemetry: [],
    providerCalls: 0,
    paidRequests: 0,
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of themes) {
      for (const viewport of coverViewports) await verifyCover(browser, theme, viewport, audit);
    }
    await verifyProgressFixture(browser, audit);
    for (const pageCase of adjacentPages) await verifyAdjacent(browser, pageCase, audit);
  } finally {
    await browser.close();
  }

  assert.deepEqual(audit.blockedWrites, [], `Unexpected business writes: ${audit.blockedWrites.join(" | ")}`);
  assert.deepEqual(audit.pageErrors, [], `Page errors: ${audit.pageErrors.join(" | ")}`);
  assert.deepEqual(audit.consoleErrors, [], `Console errors: ${audit.consoleErrors.join(" | ")}`);
  assert.deepEqual(audit.httpErrors, [], `HTTP errors: ${audit.httpErrors.join(" | ")}`);
  audit.passed = true;
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: audit.passed,
    buildId: audit.buildId,
    sourceVersion: audit.sourceVersion,
    scenarios: audit.scenarios.length,
    providerCalls: audit.providerCalls,
    paidRequests: audit.paidRequests,
    report: path.join(outputDir, "report.json"),
  }, null, 2));
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`) {
  await main();
}
