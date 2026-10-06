#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.BASE_URL || process.env.NAVIGATION_BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(".codex-evidence", "navigation-route-audit-20260901");

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[primary-navigation] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[primary-navigation] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const primaryEntries = [
  { label: "应用广场", path: "/", readySelector: ".marketplace-category-bar" },
  { label: "效率工具", path: "/tools", readySelector: 'section[aria-label="短视频效率工具工作区"]' },
  { label: "分镜编排", path: "/storyboard-workbench", readySelector: ".sbw-root" },
  { label: "图像生成", path: "/image-workbench", readyHeading: "AI生图工作台" },
  { label: "视频创作", path: "/video", readyHeading: "AI 视频创作台" },
  { label: "声音制作", path: "/voice-studio/workspace", readySelector: ".vs-page-title" },
  { label: "封面设计", path: "/cover", readySelector: '[aria-label="封面制作"]' },
  { label: "漫剧创作", path: "/youcai" },
  { label: "带货创作", path: "/commerce" },
];

const shortcutEntries = [
  { label: "应用广场", path: "/", readySelector: ".marketplace-category-bar" },
  { label: "视频创作", path: "/video", readyHeading: "AI 视频创作台" },
  { label: "漫剧创作", path: "/youcai" },
  { label: "效率工具", path: "/tools", readySelector: 'section[aria-label="短视频效率工具工作区"]' },
  { label: "声音制作", path: "/voice-studio/workspace", readySelector: ".vs-page-title" },
  { label: "分镜编排", path: "/storyboard-workbench", readySelector: ".sbw-root" },
  { label: "封面设计", path: "/cover", readySelector: '[aria-label="封面制作"]' },
  { label: "带货创作", path: "/commerce" },
];

const excludedPaths = new Set(["/youcai", "/commerce"]);
const auditedPrimaryEntries = primaryEntries.filter((entry) => !excludedPaths.has(entry.path));
const auditedShortcutEntries = shortcutEntries.filter((entry) => !excludedPaths.has(entry.path));

const forbiddenPaidPaths = [
  "/api/llm",
  "/api/image/generate",
  "/api/video/generate",
  "/api/voice/generate",
  "/api/payment",
  "/api/recharge",
];
const stateAdvancingGetPaths = [
  /^\/api\/video\/(?:status|poll|stream)$/u,
  /^\/api\/image\/status$/u,
  /^\/api\/voice\/preview$/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)$/u,
  /^\/api\/health$/u,
];

function normalizedPath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function pathMatches(actual, expected) {
  if (expected === "/") return actual === "/";
  return actual === expected || actual.startsWith(`${expected}?`) || actual.startsWith(`${expected}/`);
}

function groupDuplicateApis(requests) {
  const counts = new Map();
  for (const request of requests) {
    if (request.method !== "GET" || !request.path.startsWith("/api/")) continue;
    counts.set(request.path, (counts.get(request.path) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([requestPath, count]) => ({ path: requestPath, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
}

function verifySourceContracts() {
  const source = (relativePath) => fs.readFileSync(path.resolve(relativePath), "utf8");
  const marketplace = source("src/components/agent-marketplace.tsx");
  const sidebar = source("src/components/app-sidebar.tsx");
  const routeState = source("src/components/secondary-route-state.tsx");
  const boundaryFiles = [
    "src/app/tools/loading.tsx",
    "src/app/tools/error.tsx",
    "src/app/video/loading.tsx",
    "src/app/video/error.tsx",
    "src/app/storyboard-workbench/loading.tsx",
    "src/app/storyboard-workbench/error.tsx",
    "src/app/image-workbench/loading.tsx",
    "src/app/image-workbench/error.tsx",
    "src/app/voice-studio/loading.tsx",
    "src/app/voice-studio/error.tsx",
    "src/app/cover/loading.tsx",
    "src/app/cover/error.tsx",
  ];

  assert.doesNotMatch(marketplace, /MARKETPLACE_PREFETCH_ROUTES/u, "marketplace must not eagerly prefetch every heavy route");
  assert.doesNotMatch(marketplace, /router\.prefetch/u, "primary navigation must avoid cold-route prefetch/push races");
  assert.doesNotMatch(sidebar, /fetch\("\/api\/settings"\)/u, "sidebar must not duplicate the shared settings request");
  assert.doesNotMatch(sidebar, /router\.prefetch/u, "shortcut navigation must avoid cold-route prefetch/push races");
  assert.match(routeState, /role="status"/u);
  assert.match(routeState, /aria-live="polite"/u);
  assert.match(routeState, /aria-busy="true"/u);
  assert.match(routeState, /role="alert"/u);
  assert.match(routeState, /onClick=\{reset\}/u);
  assert.match(routeState, /href="\/"/u);
  assert.doesNotMatch(routeState, /本次失败没有创建生成任务，也不会扣费/u, "generic error boundary must not make an unverified billing claim");
  assert.match(routeState, /状态不明时不要重复提交/u, "generic error boundary must direct users to reconcile before retrying");
  for (const boundaryFile of boundaryFiles) {
    assert.ok(fs.existsSync(path.resolve(boundaryFile)), `missing route boundary: ${boundaryFile}`);
  }
  return { boundaryFiles, eagerPrefetchRemoved: true, sidebarSettingsDeduplicated: true, intentPrefetchEnabled: true };
}

async function waitForMarketplace(page) {
  await page.locator(".nav-bar-container").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".sidebar-shell").waitFor({ state: "visible", timeout: 15_000 });
  // Navigation/shortcut definitions are replaced once their read-only API data
  // arrives. Let that single hydration pass settle before locating a trigger.
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape").catch(() => undefined);
}

async function inspectPage(page) {
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const brokenImages = Array.from(document.images)
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src)
      .slice(0, 20);
    return {
      title: document.title,
      bodyTextLength: bodyText.length,
      heading: document.querySelector("h1, h2")?.textContent?.trim() || "",
      brokenImages,
      applicationError: /Application error|Unhandled Runtime Error|This page could not be found|404\s*This page/iu.test(bodyText),
      shellCounts: {
        primarySidebar: document.querySelectorAll(".sidebar-shell").length,
        routeSidebar: document.querySelectorAll('[data-testid="film-studio-sidebar"]').length,
        marketplaceNavigation: document.querySelectorAll(".nav-bar-container").length,
      },
    };
  });
}

async function clickEntry({ page, scope, entry, stepErrors, requestLog, step }) {
  const beforeCount = requestLog.length;
  const startedAt = performance.now();
  const container = page.locator(scope);
  const trigger = container.locator("button").filter({ hasText: entry.label }).first();
  await trigger.waitFor({ state: "visible", timeout: 12_000 });
  const triggerReadyAt = performance.now();

  if (entry.path === "/") {
    await trigger.click();
  } else {
    await Promise.all([
      page.waitForURL((url) => pathMatches(`${url.pathname}${url.search}`, entry.path), { timeout: 15_000 }),
      trigger.click(),
    ]);
  }
  const urlReadyAt = performance.now();

  // Next.js updates the URL before the destination segment necessarily replaces
  // its loading boundary.  A route-specific landmark closes that race without
  // weakening the audit to an arbitrary body-text threshold.
  const readyLocator = entry.readyHeading
    ? page.getByRole("heading", { name: entry.readyHeading, exact: true })
    : page.locator(entry.readySelector).first();
  await readyLocator.waitFor({ state: "visible", timeout: 20_000 }).catch((error) => {
    throw new Error(`${step} destination landmark did not render: ${error instanceof Error ? error.message : String(error)}`);
  });
  const landmarkReadyAt = performance.now();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(
    () => (document.body?.innerText?.trim().length ?? 0) >= 20,
    undefined,
    { timeout: 12_000 },
  ).catch((error) => {
    throw new Error(`${step} did not render meaningful route content: ${error instanceof Error ? error.message : String(error)}`);
  });
  const contentReadyAt = performance.now();

  const navigationMs = Math.round(performance.now() - startedAt);
  const actualPath = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
  assert.ok(pathMatches(actualPath, entry.path), `${step} landed on ${actualPath}, expected ${entry.path}`);
  const pageState = await inspectPage(page);
  assert.equal(pageState.applicationError, false, `${step} rendered an application error`);
  assert.ok(pageState.bodyTextLength >= 20, `${step} rendered too little content (${pageState.bodyTextLength})`);
  assert.deepEqual(pageState.brokenImages, [], `${step} rendered broken images`);
  const stepRequests = requestLog.slice(beforeCount).filter((item) => item.step === step);
  const stageMs = {
    trigger: Math.round(triggerReadyAt - startedAt),
    url: Math.round(urlReadyAt - triggerReadyAt),
    landmark: Math.round(landmarkReadyAt - urlReadyAt),
    content: Math.round(contentReadyAt - landmarkReadyAt),
  };
  if (navigationMs >= 4_000) {
    const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name.replace(location.origin, ""),
      initiatorType: entry.initiatorType,
      startTime: Math.round(entry.startTime),
      duration: Math.round(entry.duration),
      responseEnd: Math.round(entry.responseEnd),
      transferSize: "transferSize" in entry ? entry.transferSize : 0,
    })).filter((entry) => entry.duration >= 1_000 || /storyboard-workbench/u.test(entry.name)).slice(-60));
    console.error(`[primary-navigation] slow step ${JSON.stringify({ step, navigationMs, stageMs, requests: stepRequests.slice(-40), resources })}`);
  }
  return {
    step,
    expectedPath: entry.path,
    actualPath,
    navigationMs,
    withinNavigationBudget: navigationMs < 4_000,
    stageMs,
    ...pageState,
    requestCount: stepRequests.length,
    duplicateApis: groupDuplicateApis(stepRequests),
    consoleErrors: stepErrors.console.filter((item) => item.step === step).map((item) => item.message),
    pageErrors: stepErrors.page.filter((item) => item.step === step).map((item) => item.message),
  };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceChecks = verifySourceContracts();
  const suppliedToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let suppliedUser = null;
  if (suppliedToken) {
    const identity = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${suppliedToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await identity.json();
    assert.ok(identity.ok && body.user, "authenticated navigation session is unavailable");
    suppliedUser = body.user;
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ token, user }) => {
    sessionStorage.setItem("entered_app", "1");
    if (token && user) {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
    }
  }, { token: suppliedToken || "", user: suppliedUser });

  const blockedWrites = [];
  const blockedAdvancingReads = [];
  const paidRequests = [];
  const telemetryRequests = [];
  const requestLog = [];
  const stepErrors = { console: [], page: [] };
  let activeStep = "initial";

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const requestPath = normalizedPath(request.url());
    const pathname = new URL(request.url()).pathname;
    if (method === "GET" && stateAdvancingGetPaths.some((pattern) => pattern.test(pathname))) {
      blockedAdvancingReads.push({ step: activeStep, method, path: pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (forbiddenPaidPaths.some((prefix) => requestPath.startsWith(prefix))) {
      paidRequests.push({ step: activeStep, method, path: requestPath });
      await route.abort("blockedbyclient");
      return;
    }
    if (method === "POST" && ["/api/product-usage/events", "/api/operation-events"].includes(pathname)) {
      const body = request.postData() || "";
      telemetryRequests.push({
        step: activeStep,
        method,
        path: pathname,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        containsCredential: /authorization|bearer\s|api[_-]?key|secret|password|token/iu.test(body),
        containsProviderUrl: /xunhupay|dpweixin|openai\.com|volces\.com/iu.test(body),
      });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, accepted: true }),
      });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      blockedWrites.push({ step: activeStep, method, path: requestPath });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("request", (request) => {
    requestLog.push({
      step: activeStep,
      method: request.method().toUpperCase(),
      path: normalizedPath(request.url()),
      type: request.resourceType(),
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") stepErrors.console.push({ step: activeStep, message: message.text().slice(0, 500) });
  });
  page.on("pageerror", (error) => {
    stepErrors.page.push({ step: activeStep, message: error.message.slice(0, 500) });
  });

  try {
    activeStep = "initial";
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await waitForMarketplace(page);
    await page.waitForTimeout(2_000);

    const labels = await page.evaluate(() => ({
      primary: Array.from(document.querySelectorAll(".nav-bar-container button"))
        .map((node) => node.textContent?.trim() || "")
        .filter(Boolean),
      shortcuts: Array.from(document.querySelectorAll(".sidebar-shell .sidebar-tool-card"))
        .map((node) => node.textContent?.trim() || "")
        .filter(Boolean),
    }));
    for (const entry of auditedPrimaryEntries) {
      assert.ok(labels.primary.includes(entry.label), `primary navigation is missing ${entry.label}`);
    }
    for (const entry of auditedShortcutEntries) {
      assert.ok(labels.shortcuts.includes(entry.label), `shortcut navigation is missing ${entry.label}`);
    }
    assert.equal(labels.shortcuts.includes("AI生图工作台"), false, "AI生图工作台 must stay removed from shortcut navigation");

    const initialRequests = requestLog.filter((item) => item.step === "initial");
    const initialPrefetches = initialRequests.filter((item) => (
      primaryEntries.some((entry) => entry.path !== "/" && item.path.startsWith(entry.path))
      && item.path.includes("_rsc=")
    ));
    const results = [];

    for (const entry of auditedPrimaryEntries) {
      activeStep = `primary:${entry.label}`;
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await waitForMarketplace(page);
      results.push(await clickEntry({
        page,
        scope: ".nav-bar-container",
        entry,
        stepErrors,
        requestLog,
        step: activeStep,
      }));
    }

    for (const entry of auditedShortcutEntries) {
      activeStep = `shortcut:${entry.label}`;
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await waitForMarketplace(page);
      results.push(await clickEntry({
        page,
        scope: ".sidebar-shell",
        entry,
        stepErrors,
        requestLog,
        step: activeStep,
      }));
    }

    assert.deepEqual(paidRequests, [], "navigation audit must never reach a paid/model generation endpoint");
    assert.deepEqual(
      telemetryRequests.filter((request) => request.containsCredential || request.containsProviderUrl),
      [],
      "navigation telemetry must not contain credentials or provider URLs",
    );
    const expectedBlockedWrites = new Set(["/api/announcements/events", "/api/diagnostic-logs"]);
    const unexpectedWrites = blockedWrites.filter((request) => !expectedBlockedWrites.has(request.path));
    assert.deepEqual(unexpectedWrites, [], "navigation audit encountered an unexpected write request");
    assert.deepEqual(stepErrors.page, [], "navigation audit encountered page errors");
    const unexpectedConsoleErrors = stepErrors.console.filter((item) => !/ERR_BLOCKED_BY_CLIENT/iu.test(item.message));
    assert.deepEqual(unexpectedConsoleErrors, [], "navigation audit encountered unexpected console errors");

    const overBudget = results.filter((result) => !result.withinNavigationBudget)
      .map(({ step, navigationMs, stageMs }) => ({ step, navigationMs, stageMs }));

    const report = {
      ok: true,
      checkedAt: new Date().toISOString(),
      baseUrl,
      scope: "primary navigation and shortcut navigation; GET/HEAD/OPTIONS only; paid endpoints blocked",
      excludedRoutes: ["/youcai", "/commerce"],
      sourceChecks,
      labels,
      initial: {
        requestCount: initialRequests.length,
        duplicateApis: groupDuplicateApis(initialRequests),
        routePrefetchCount: initialPrefetches.length,
        routePrefetches: initialPrefetches.map((item) => item.path),
      },
      paidRequests,
      telemetryRequests,
      blockedWrites,
      unexpectedWrites,
      unexpectedConsoleErrors,
      results,
      overBudget,
    };
    const evidencePath = path.join(outputDir, "primary-navigation-zero-cost.json");
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      entries: results.length,
      primaryEntries: auditedPrimaryEntries.length,
      shortcutEntries: auditedShortcutEntries.length,
      excludedEntries: primaryEntries.length + shortcutEntries.length - results.length,
      slowest: [...results].sort((left, right) => right.navigationMs - left.navigationMs).slice(0, 5)
        .map(({ step, navigationMs, actualPath }) => ({ step, navigationMs, actualPath })),
      initialDuplicateApis: report.initial.duplicateApis,
      initialRoutePrefetchCount: report.initial.routePrefetchCount,
      consoleErrors: unexpectedConsoleErrors.length,
      pageErrors: stepErrors.page.length,
      brokenImages: results.reduce((total, result) => total + result.brokenImages.length, 0),
      blockedWrites: blockedWrites.length,
      blockedAdvancingReads: blockedAdvancingReads.length,
      paidRequests: paidRequests.length,
      telemetryRequests: telemetryRequests.length,
      evidence: evidencePath,
    }, null, 2));
    assert.deepEqual(overBudget, [], `navigation budget exceeded: ${JSON.stringify(overBudget)}`);
  } finally {
    await closeWithTimeout(context, "context.close");
    await closeWithTimeout(browser, "browser.close");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
