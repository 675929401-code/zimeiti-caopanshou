#!/usr/bin/env node

import { chromium } from "playwright";

const baseUrl = (process.env.BASE_URL
  || process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length)
  || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const shouldWaitForNetworkIdle = process.argv.includes("--network-idle");
const settleMs = Number(
  process.argv.find((arg) => arg.startsWith("--settle-ms="))?.slice("--settle-ms=".length)
  || "500",
);
const gotoTimeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--goto-timeout-ms="))?.slice("--goto-timeout-ms=".length)
  || "12_000".replace("_", ""),
);
const loadTimeoutMs = Number(
  process.argv.find((arg) => arg.startsWith("--load-timeout-ms="))?.slice("--load-timeout-ms=".length)
  || "1_500".replace("_", ""),
);

const routes = [
  { path: "/youcai", label: "漫剧工作台首页" },
  { path: "/youcai/assets", label: "个人资产" },
  { path: "/youcai/skills", label: "Skill 专家" },
  { path: "/youcai/tools", label: "工具箱" },
  { path: "/youcai/tools/text/text-chat?command=%2Fvideo-deconstruct-analyzer%20", label: "Skill 命令落地页" },
  { path: "/youcai/tools/canvas", label: "漫剧画布" },
  { path: "/youcai/inspiration", label: "灵感广场" },
  { path: "/youcai/youcai-tv", label: "漫剧 TV" },
  { path: "/youcai/articles", label: "帮助文章" },
  { path: "/youcai/recharge", label: "积分充值" },
  { path: "/youcai/referral", label: "推荐计划" },
  { path: "/admin?tab=manju-workbench", label: "漫剧后台入口", allowLoginWall: true },
];

const fatalPatterns = [
  /Application error/iu,
  /Unhandled Runtime Error/iu,
  /This page could not be found/iu,
  /404\s*This page/iu,
  /TypeError:/iu,
  /ReferenceError:/iu,
];

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          console.error(`[youcai-navigation-live] ${label} timed out after ${timeoutMs}ms; continuing with collected results`);
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function inspectPage(page, route) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 240));
  };
  const onPageError = (error) => pageErrors.push(error.message.slice(0, 240));
  const onRequestFailed = (request) => {
    const failure = request.failure();
    const url = request.url();
    if (/\.(?:png|jpe?g|webp|gif|svg|mp4|webm|mp3|wav)(?:[?#]|$)/iu.test(url)) {
      failedRequests.push({ url: url.slice(0, 220), error: failure?.errorText || "request failed" });
    }
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  const startedAt = Date.now();
  let status = 0;
  let gotoError = "";
  try {
    const response = await page.goto(new URL(route.path, baseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: Number.isFinite(gotoTimeoutMs) ? Math.max(1_000, gotoTimeoutMs) : 12_000,
    });
    status = response?.status() || 0;
    if (shouldWaitForNetworkIdle) {
      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
    } else {
      await page.waitForLoadState("load", {
        timeout: Number.isFinite(loadTimeoutMs) ? Math.max(500, loadTimeoutMs) : 1_500,
      }).catch(() => undefined);
    }
    await page.waitForTimeout(Number.isFinite(settleMs) ? Math.max(0, settleMs) : 500);
  } catch (error) {
    gotoError = error instanceof Error ? error.message : String(error);
  }

  const inspected = await page.evaluate((fatalSource) => {
    const bodyText = document.body?.innerText || "";
    const brokenImages = Array.from(document.images)
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src)
      .slice(0, 20);
    const navLabels = [
      "返回主页",
      "个人资产",
      "Skill 专家",
      "创作中心",
      "创作 Agent",
      "影视工坊",
      "漫剧画布",
      "灵感广场",
      "漫剧TV",
      "帮助中心",
      "积分充值",
      "推荐计划",
    ];
    const fatalMatches = fatalSource
      .map((source) => new RegExp(source, "iu"))
      .filter((pattern) => pattern.test(bodyText))
      .map((pattern) => String(pattern));
    const navigationEntry = performance.getEntriesByType("navigation")[0];
    const timing = navigationEntry
      ? {
          domContentLoadedMs: Math.round(navigationEntry.domContentLoadedEventEnd),
          loadMs: Math.round(navigationEntry.loadEventEnd),
          transferSize: Math.round(navigationEntry.transferSize || 0),
        }
      : null;
    return {
      title: document.title,
      textLength: bodyText.length,
      fatalMatches,
      brokenImages,
      navigationLabelsFound: navLabels.filter((label) => bodyText.includes(label)).length,
      loginWall: /登录|管理员登录|请先登录/iu.test(bodyText),
      configWarning: /CONFIG_STORE_CORRUPT|MIGRATION_NOT_READY|配置中心暂时不可用/iu.test(bodyText),
      timing,
    };
  }, fatalPatterns.map((pattern) => pattern.source));

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("requestfailed", onRequestFailed);

  const hardFailure = Boolean(
    gotoError
      || status >= 500
      || inspected.fatalMatches.length > 0
      || pageErrors.length > 0
      || inspected.brokenImages.length > 5
      || (!route.allowLoginWall && inspected.textLength < 300)
  );

  return {
    label: route.label,
    path: route.path,
    status,
    ok: !hardFailure,
    elapsedMs: Date.now() - startedAt,
    title: inspected.title,
    textLength: inspected.textLength,
    timing: inspected.timing,
    navigationLabelsFound: inspected.navigationLabelsFound,
    configWarning: inspected.configWarning,
    loginWall: inspected.loginWall,
    brokenImages: inspected.brokenImages,
    failedMediaRequests: failedRequests,
    consoleErrors,
    pageErrors,
    gotoError,
  };
}

async function main() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const results = [];
  try {
    const page = await context.newPage();
    for (const route of routes) {
      console.error(`[youcai-navigation-live] checking ${route.label} ${route.path}`);
      const result = await inspectPage(page, route);
      console.error(`[youcai-navigation-live] ${result.ok ? "PASS" : "FAIL"} ${route.label} ${result.elapsedMs}ms`);
      results.push(result);
    }
  } finally {
    await withTimeout(context.close(), 3_000, "context.close");
    await withTimeout(browser.close(), 3_000, "browser.close");
  }
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({
    verifier: "youcai-navigation-live",
    baseUrl,
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      configWarnings: results.filter((result) => result.configWarning).length,
      loginWalls: results.filter((result) => result.loginWall).length,
    },
    results,
    failed,
  }, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(JSON.stringify({
    verifier: "youcai-navigation-live",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(2);
});
