#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:5000";
const ROUTE = "/demo/popup-styles";
const VIEWPORT = { width: 1440, height: 900 };
const STYLE_IDS = ["ivory", "mist", "sand", "editorial", "coral"];
const STYLE_NAMES = ["象牙纸墨", "雾青玻璃", "暖砂金线", "蓝灰编辑部", "珊瑚提示"];
const MESSAGE_TITLES = ["一份给认真创作者的成长礼包", "连续创作任务奖励已补发", "本月会员加赠权益说明"];
const NOTICE_HEADINGS = ["本次到账内容", "使用范围", "有效期与保留规则", "需要帮助时"];
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BUSINESS_API_PATTERN = /\/api\/(?:admin|billing|chat|credits?|image|llm|media|orders?|payments?|storyboard|video|wallet)(?:\/|$)/iu;
const PAID_API_PATTERN = /\/api\/(?:chat|image\/generate|llm|storyboard\/(?:generate|render)|video\/generate)(?:\/|$)/iu;
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.join(ROOT, ".codex-evidence", "popup-style-lab", runStamp);
const reportPath = path.join(evidenceDir, "report.json");

const relativeToRoot = (target) => path.relative(ROOT, target).split(path.sep).join("/");
const serializeError = (error) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
});

const report = {
  schemaVersion: 1,
  suite: "popup-style-lab-browser-readonly",
  status: "running",
  ok: false,
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  route: ROUTE,
  viewport: VIEWPORT,
  runtime: {
    sourceVersion: null,
    servedBuildId: null,
    diskBuildId: null,
    sourceFingerprint: null,
    sourceFingerprintCurrent: false,
    runningLatest: false,
  },
  styles: [],
  previewCount: 0,
  screenshots: [],
  pageOverflowPx: null,
  ambientDecorationCount: 0,
  ambientOverflowPx: null,
  apiRequests: [],
  externalRequests: [],
  attemptedWriteRequests: [],
  businessApiRequests: [],
  paidApiRequests: [],
  requestFailures: [],
  consoleErrors: [],
  pageErrors: [],
  serverErrors: [],
  browserStorage: null,
  businessWrites: 0,
  productionWrites: 0,
  paidCalls: 0,
  failure: null,
};

await fs.mkdir(evidenceDir, { recursive: true });

let browser;
let context;
try {
  const [versionResponse, receipt, diskBuildId, currentFingerprint] = await Promise.all([
    fetch(`${ORIGIN}/api/version`, { signal: AbortSignal.timeout(15_000) }),
    fs.readFile(path.join(ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(ROOT, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(ROOT)),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const version = await versionResponse.json();
  const servedBuildId = version.buildId || version.version || "";
  const sourceFingerprintCurrent = receipt?.fingerprint === currentFingerprint.fingerprint
    && receipt?.fileCount === currentFingerprint.fileCount;
  const runningLatest = sourceFingerprintCurrent
    && receipt?.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  report.runtime = {
    sourceVersion: version.sourceVersion || null,
    servedBuildId: servedBuildId || null,
    diskBuildId: diskBuildId || null,
    sourceFingerprint: currentFingerprint.fingerprint,
    sourceFingerprintCurrent,
    runningLatest,
  };
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "zh-CN",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!READ_ONLY_METHODS.has(request.method())) {
      report.attemptedWriteRequests.push({ method: request.method(), url: request.url() });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin !== ORIGIN) report.externalRequests.push(request.url());
    if (url.pathname.startsWith("/api/")) {
      const entry = { method: request.method(), pathname: url.pathname };
      report.apiRequests.push(entry);
      if (BUSINESS_API_PATTERN.test(url.pathname)) report.businessApiRequests.push(entry);
      if (PAID_API_PATTERN.test(url.pathname)) report.paidApiRequests.push(entry);
    }
  });
  page.on("requestfailed", (request) => {
    report.requestFailures.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText || "unknown",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      report.serverErrors.push({ status: response.status(), url: response.url() });
    }
  });

  const navigation = await page.goto(`${ORIGIN}${ROUTE}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(navigation?.status(), 200, `DEMO_HTTP_${navigation?.status() ?? "NO_RESPONSE"}`);
  const lab = page.getByTestId("popup-style-lab");
  await lab.waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.getByText("已同步到本浏览器", { exact: true }).waitFor({ state: "visible" });
  assert.ok(
    (await page.title()).startsWith("弹窗风格选择 Demo｜自媒体操盘手"),
    `UNEXPECTED_PAGE_TITLE:${await page.title()}`,
  );
  assert.deepEqual(page.viewportSize(), VIEWPORT);

  const options = page.locator("[data-style-option]");
  assert.equal(await options.count(), STYLE_IDS.length, "STYLE_OPTION_COUNT_MISMATCH");
  const observedStyleIds = await options.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-style-option")));
  assert.deepEqual(observedStyleIds, STYLE_IDS, "STYLE_OPTION_ORDER_MISMATCH");
  assert.deepEqual(await options.locator("h2").allTextContents(), STYLE_NAMES, "STYLE_NAME_ORDER_MISMATCH");
  assert.equal(await page.locator('[aria-label="五套弹窗风格方案"]').getAttribute("data-view"), "compare", "DEFAULT_COMPARE_VIEW_REQUIRED");

  const previews = page.locator("[data-popup-preview]");
  assert.equal(await previews.count(), 10, "PREVIEW_COUNT_MISMATCH");
  report.previewCount = await previews.count();
  const previewKinds = await previews.evaluateAll((nodes) => nodes.map((node) => ({
    style: node.getAttribute("data-style"),
    kind: node.getAttribute("data-popup-preview"),
  })));
  for (const styleId of STYLE_IDS) {
    assert.deepEqual(
      previewKinds.filter((preview) => preview.style === styleId).map((preview) => preview.kind).sort(),
      ["compact", "reader"],
      `PREVIEW_PAIR_MISMATCH:${styleId}`,
    );
  }

  const pageGeometry = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const labNode = document.querySelector('[data-testid="popup-style-lab"]');
    const labRect = labNode?.getBoundingClientRect();
    const ambientDecorations = [...document.querySelectorAll("[data-ambient-decoration]")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        overflowLeft: labRect ? Math.max(0, labRect.left - rect.left) : 0,
        overflowRight: labRect ? Math.max(0, rect.right - labRect.right) : 0,
      };
    });
    return {
      rootOverflow: root.scrollWidth - root.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      labOverflow: labNode ? labNode.scrollWidth - labNode.clientWidth : null,
      ambientDecorations,
    };
  });
  report.pageOverflowPx = Math.max(pageGeometry.rootOverflow, pageGeometry.bodyOverflow);
  report.ambientDecorationCount = pageGeometry.ambientDecorations.length;
  report.ambientOverflowPx = Math.max(
    0,
    ...pageGeometry.ambientDecorations.flatMap((item) => [item.overflowLeft, item.overflowRight]),
  );
  assert.equal(report.ambientDecorationCount, 2, "AMBIENT_DECORATION_COUNT_MISMATCH");
  assert.equal(pageGeometry.rootOverflow, 0, `ROOT_HORIZONTAL_OVERFLOW:${JSON.stringify(pageGeometry)}`);
  assert.equal(pageGeometry.bodyOverflow, 0, `BODY_HORIZONTAL_OVERFLOW:${JSON.stringify(pageGeometry)}`);

  for (let index = 0; index < STYLE_IDS.length; index += 1) {
    const styleId = STYLE_IDS[index];
    const styleName = STYLE_NAMES[index];
    const option = page.locator(`[data-style-option="${styleId}"]`);
    assert.equal(await option.count(), 1, `STYLE_OPTION_NOT_UNIQUE:${styleId}`);

    const compactStage = option.locator(`[data-popup-preview="compact"][data-style="${styleId}"]`);
    const readerStage = option.locator(`[data-popup-preview="reader"][data-style="${styleId}"]`);
    const compactCard = compactStage.locator("article");
    const readerWindow = readerStage.locator("article");
    const scrollRegion = readerStage.locator("[data-popup-scroll-region]");
    assert.equal(await compactCard.count(), 1, `COMPACT_CARD_MISSING:${styleId}`);
    assert.equal(await readerWindow.count(), 1, `READER_WINDOW_MISSING:${styleId}`);
    assert.equal(await scrollRegion.count(), 1, `SCROLL_REGION_MISSING:${styleId}`);
    assert.equal(await compactStage.isVisible(), true, `COMPACT_PREVIEW_NOT_VISIBLE:${styleId}`);
    assert.equal(await readerStage.isVisible(), true, `READER_PREVIEW_NOT_VISIBLE:${styleId}`);
    assert.deepEqual(await scrollRegion.locator("h4").allTextContents(), NOTICE_HEADINGS, `NOTICE_CONTENT_MISMATCH:${styleId}`);

    const pageIndicator = readerStage.locator("[data-reader-page-indicator]");
    const unreadCount = readerStage.locator("[data-reader-unread-count]");
    const previousButton = readerStage.locator('[data-reader-action="previous"]');
    const nextButton = readerStage.locator('[data-reader-action="next"]');
    const acknowledgeButton = readerStage.locator('[data-reader-action="acknowledge"]');
    assert.equal(await pageIndicator.textContent(), "01 / 03", `INITIAL_PAGE_INDICATOR_MISMATCH:${styleId}`);
    assert.equal(await unreadCount.textContent(), "3 条未读", `INITIAL_UNREAD_COUNT_MISMATCH:${styleId}`);
    assert.equal(await previousButton.isDisabled(), true, `PREVIOUS_SHOULD_START_DISABLED:${styleId}`);
    assert.equal(await nextButton.isEnabled(), true, `NEXT_SHOULD_START_ENABLED:${styleId}`);
    assert.equal(await acknowledgeButton.isVisible(), true, `ACKNOWLEDGE_ACTION_MISSING:${styleId}`);

    const metrics = await option.evaluate((optionNode) => {
      const compact = optionNode.querySelector('[data-popup-preview="compact"]');
      const reader = optionNode.querySelector('[data-popup-preview="reader"]');
      const readerWindowNode = reader?.querySelector("article");
      const readerHeader = readerWindowNode?.querySelector("header");
      const readerFooter = readerWindowNode?.querySelector("footer");
      const body = readerWindowNode?.querySelector("[data-popup-scroll-region]");
      const lead = body?.querySelector("p");
      const noticeParagraph = body?.querySelector("section p");
      const compactParagraph = compact?.querySelector("article p");
      const nodes = [optionNode, compact, reader, compact?.querySelector("article"), readerWindowNode, body].filter(Boolean);
      const overflow = nodes.map((node) => ({
        node: node.getAttribute("data-popup-preview") || node.tagName.toLowerCase(),
        pixels: node.scrollWidth - node.clientWidth,
      }));
      const bodyStyle = getComputedStyle(body);
      const leadStyle = getComputedStyle(lead);
      const noticeStyle = getComputedStyle(noticeParagraph);
      const compactStyle = getComputedStyle(compactParagraph);
      return {
        overflow,
        content: {
          clientWidth: body.clientWidth,
          clientHeight: body.clientHeight,
          scrollWidth: body.scrollWidth,
          scrollHeight: body.scrollHeight,
          overflowY: bodyStyle.overflowY,
          readerHeight: readerWindowNode.clientHeight,
          headerHeight: readerHeader.clientHeight,
          footerHeight: readerFooter.clientHeight,
          contentHeightShare: Number((body.clientHeight / readerWindowNode.clientHeight).toFixed(3)),
        },
        typography: {
          fontFamily: leadStyle.fontFamily,
          leadFontSize: leadStyle.fontSize,
          leadLineHeight: leadStyle.lineHeight,
          leadColor: leadStyle.color,
          noticeFontSize: noticeStyle.fontSize,
          noticeLineHeight: noticeStyle.lineHeight,
          compactFontSize: compactStyle.fontSize,
          compactLineHeight: compactStyle.lineHeight,
        },
      };
    });

    for (const item of metrics.overflow) {
      assert.ok(item.pixels <= 1, `STYLE_HORIZONTAL_OVERFLOW:${styleId}:${item.node}:${item.pixels}`);
    }
    assert.ok(metrics.content.clientWidth >= 600, `READER_CONTENT_TOO_NARROW:${styleId}:${metrics.content.clientWidth}`);
    assert.ok(metrics.content.clientHeight >= 250, `READER_CONTENT_TOO_SHORT:${styleId}:${metrics.content.clientHeight}`);
    assert.ok(metrics.content.contentHeightShare >= 0.6, `READER_CONTENT_AREA_NOT_PRIMARY:${styleId}:${metrics.content.contentHeightShare}`);
    assert.equal(metrics.content.overflowY, "auto", `READER_SCROLL_STYLE_MISMATCH:${styleId}`);
    assert.ok(metrics.content.scrollHeight > metrics.content.clientHeight + 1, `READER_LONG_TEXT_NOT_SCROLLABLE:${styleId}`);
    assert.equal(metrics.typography.leadFontSize, "17px", `LEAD_FONT_SIZE_MISMATCH:${styleId}`);
    assert.equal(metrics.typography.noticeFontSize, "17px", `NOTICE_FONT_SIZE_MISMATCH:${styleId}`);
    assert.ok(Math.abs(Number.parseFloat(metrics.typography.leadLineHeight) - 29.75) <= 0.1, `LEAD_LINE_HEIGHT_MISMATCH:${styleId}`);
    assert.ok(Math.abs(Number.parseFloat(metrics.typography.noticeLineHeight) - 29.75) <= 0.1, `NOTICE_LINE_HEIGHT_MISMATCH:${styleId}`);
    assert.equal(metrics.typography.compactFontSize, "16px", `COMPACT_FONT_SIZE_MISMATCH:${styleId}`);
    assert.ok(metrics.typography.fontFamily.length > 0, `FONT_FAMILY_MISSING:${styleId}`);
    assert.notEqual(metrics.typography.leadColor, "rgba(0, 0, 0, 0)", `LEAD_TEXT_TRANSPARENT:${styleId}`);

    await scrollRegion.evaluate((node) => { node.scrollTop = 0; });
    await scrollRegion.hover();
    await page.mouse.wheel(0, 420);
    const scrollRegionHandle = await scrollRegion.elementHandle();
    assert.ok(scrollRegionHandle, `SCROLL_REGION_HANDLE_MISSING:${styleId}`);
    await page.waitForFunction((node) => node.scrollTop > 0, scrollRegionHandle, { timeout: 2_000 });
    const wheelTop = await scrollRegion.evaluate((node) => node.scrollTop);
    assert.ok(wheelTop > 0, `READER_WHEEL_SCROLL_FAILED:${styleId}`);

    const scrolled = await scrollRegion.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return { wheelTop: 0, top: node.scrollTop, max: node.scrollHeight - node.clientHeight };
    });
    scrolled.wheelTop = wheelTop;
    assert.ok(scrolled.top > 0 && scrolled.top >= scrolled.max - 1, `READER_SCROLL_INTERACTION_FAILED:${styleId}`);
    await scrollRegion.evaluate((node) => { node.scrollTop = 0; });

    await nextButton.click();
    assert.equal(await pageIndicator.textContent(), "02 / 03", `NEXT_PAGE_INDICATOR_MISMATCH:${styleId}`);
    assert.equal(await readerStage.locator("[data-reader-message-title]").textContent(), MESSAGE_TITLES[1], `NEXT_MESSAGE_TITLE_MISMATCH:${styleId}`);
    assert.equal(await previousButton.isEnabled(), true, `PREVIOUS_SHOULD_ENABLE_AFTER_NEXT:${styleId}`);
    await previousButton.click();
    assert.equal(await pageIndicator.textContent(), "01 / 03", `PREVIOUS_PAGE_INDICATOR_MISMATCH:${styleId}`);
    assert.equal(await readerStage.locator("[data-reader-message-title]").textContent(), MESSAGE_TITLES[0], `PREVIOUS_MESSAGE_TITLE_MISMATCH:${styleId}`);

    const selectButton = option.locator('button[aria-pressed]');
    await selectButton.click();
    assert.equal(await option.getAttribute("data-selected"), "true", `STYLE_SELECTION_FAILED:${styleId}`);
    await page.getByText(`${String(index + 1).padStart(2, "0")} · ${styleName}`, { exact: true }).waitFor({ state: "visible" });

    await option.evaluate((node) => {
      const top = window.scrollY + node.getBoundingClientRect().top - 18;
      window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    });
    const screenshotPath = path.join(evidenceDir, `${String(index + 1).padStart(2, "0")}-${styleId}-1440x900.png`);
    const screenshotBuffer = await page.screenshot({ path: screenshotPath, fullPage: false });
    const screenshotWidth = screenshotBuffer.readUInt32BE(16);
    const screenshotHeight = screenshotBuffer.readUInt32BE(20);
    assert.deepEqual(
      { width: screenshotWidth, height: screenshotHeight },
      VIEWPORT,
      `SCREENSHOT_VIEWPORT_MISMATCH:${styleId}`,
    );
    const screenshotStat = await fs.stat(screenshotPath);
    assert.ok(screenshotStat.size > 0, `SCREENSHOT_EMPTY:${styleId}`);
    report.screenshots.push({
      styleId,
      styleName,
      path: relativeToRoot(screenshotPath),
      bytes: screenshotStat.size,
      width: screenshotWidth,
      height: screenshotHeight,
    });
    await acknowledgeButton.click();
    assert.equal(await unreadCount.textContent(), "2 条未读", `ACKNOWLEDGE_UNREAD_COUNT_MISMATCH:${styleId}`);
    report.styles.push({ styleId, styleName, metrics, scrolled });
  }

  report.browserStorage = await page.evaluate(() => ({
    selection: window.localStorage.getItem("zimeiti.popup-style-lab.selection.v1"),
    keys: Object.keys(window.localStorage).sort(),
  }));
  assert.equal(report.browserStorage.selection, STYLE_IDS.at(-1), "LOCAL_SELECTION_NOT_PERSISTED");

  await page.waitForTimeout(250);
  report.businessWrites = report.attemptedWriteRequests.length;
  report.productionWrites = report.attemptedWriteRequests.length;
  report.paidCalls = report.paidApiRequests.length;
  assert.deepEqual(report.attemptedWriteRequests, [], "BUSINESS_WRITE_REQUEST_ATTEMPTED");
  assert.deepEqual(report.businessApiRequests, [], "BUSINESS_API_REQUEST_DETECTED");
  assert.deepEqual(report.paidApiRequests, [], "PAID_API_REQUEST_DETECTED");
  assert.deepEqual(report.externalRequests, [], "EXTERNAL_REQUEST_DETECTED");
  assert.deepEqual(report.consoleErrors, [], "CONSOLE_ERROR_DETECTED");
  assert.deepEqual(report.pageErrors, [], "PAGE_ERROR_DETECTED");
  assert.deepEqual(report.serverErrors, [], "HTTP_5XX_DETECTED");
  assert.equal(report.screenshots.length, STYLE_IDS.length, "SCREENSHOT_COUNT_MISMATCH");

  report.status = "passed";
  report.ok = true;
} catch (error) {
  report.status = "failed";
  report.failure = serializeError(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    evidenceDir: relativeToRoot(evidenceDir),
    report: relativeToRoot(reportPath),
    runningLatest: report.runtime.runningLatest,
    styles: report.styles.length,
    previews: report.previewCount,
    screenshots: report.screenshots.length,
    businessWrites: report.businessWrites,
    consoleErrors: report.consoleErrors.length,
    serverErrors: report.serverErrors.length,
    failure: report.failure,
  }, null, 2)}\n`);
}
