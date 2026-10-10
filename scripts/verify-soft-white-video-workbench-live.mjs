#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.ok(
  ["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(origin),
  "LOCAL_ONLY_ORIGIN_REQUIRED",
);

const evidenceDirectory = path.resolve(".codex-evidence/soft-white-video-r344");
await fs.mkdir(evidenceDirectory, { recursive: true });

const injectedToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
let session;
if (injectedToken) {
  session = { token: injectedToken };
} else {
  const sessionResponse = await fetch(`${origin}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(15_000),
  });
  session = await sessionResponse.json();
  assert.ok(sessionResponse.ok && session.token, session.error || "LOCAL_SESSION_REQUIRED");
}

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${session.token}` },
  signal: AbortSignal.timeout(15_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user, "LOCAL_IDENTITY_REQUIRED");
session.user = identity.user;

const report = {
  observedAt: new Date().toISOString(),
  origin,
  policy: { readOnly: true, paidGenerationRequests: 0, executedBusinessWrites: 0 },
  pages: [],
  stubbedAppearanceWrites: [],
  blocked: [],
  pageErrors: [],
  consoleErrors: [],
};

const stateAdvancingRead = (pathname) => [
  /^\/api\/video\/(?:status|poll|stream)$/u,
  /^\/api\/image\/status$/u,
  /^\/api\/voice\/preview$/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)$/u,
].some((pattern) => pattern.test(pathname));

const compact = (value) => String(value || "")
  .replace(/https?:\/\/\S+/gu, "[url]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]")
  .slice(0, 320);

async function createContext(browser, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const diagnosticPost = method === "POST" && url.origin === origin && url.pathname === "/__nextjs_original-stack-frames";
    if (method === "GET" && url.origin === origin && url.pathname === "/api/auth/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            ...identity.user,
            themePreference: "soft-white",
            theme_preference: "soft-white",
          },
        }),
      });
      return;
    }
    if (method === "PUT" && url.origin === origin && url.pathname === "/api/auth/me") {
      const payload = request.postDataJSON();
      report.stubbedAppearanceWrites.push({
        theme: String(payload?.theme_preference || ""),
        modePreference: String(payload?.theme_mode_preference || ""),
        persisted: false,
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      return;
    }
    if ((method === "GET" && url.origin === origin && stateAdvancingRead(url.pathname)) ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !diagnosticPost)) {
      report.blocked.push({ method, path: url.origin === origin ? url.pathname : "external" });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("user_theme_preference", "soft-white");
    sessionStorage.setItem("entered_app", "1");
  }, { token: session.token, user: identity.user });
  return context;
}

function attachDiagnostics(page, pageId) {
  page.on("pageerror", (error) => report.pageErrors.push({ page: pageId, message: compact(error.message) }));
  page.on("console", (message) => {
    if (message.type() !== "error" || /ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED|React DevTools/u.test(message.text())) return;
    report.consoleErrors.push({ page: pageId, message: compact(message.text()) });
  });
}

async function inspectPage(browser, { id, route, viewport, screenshot, inspectVideo = false }) {
  const context = await createContext(browser, viewport);
  const page = await context.newPage();
  attachDiagnostics(page, id);
  const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200, `${id} HTTP_STATUS`);
  await page.waitForFunction(() => document.body?.innerText?.trim().length > 40, null, { timeout: 30_000 });
  if (inspectVideo) {
    await page.locator("[data-video-model-list]").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("[data-video-model-id]").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("[data-video-task-card]").first().waitFor({ state: "visible", timeout: 30_000 });
  }
  await page.waitForTimeout(1_200);

  const metrics = await page.evaluate(({ inspectVideo: shouldInspectVideo }) => {
    const rgb = (value) => (value.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
    const bodyRgb = rgb(getComputedStyle(document.body).backgroundColor);
    const root = document.documentElement;
    const base = {
      path: location.pathname + location.search,
      theme: root.dataset.theme || "",
      mode: root.dataset.mode || "",
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      softWhiteBackground: bodyRgb.length === 3 && bodyRgb.every((channel) => channel >= 228),
      viewportWidth: innerWidth,
      documentWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
      horizontalOverflow: Math.max(root.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
      brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length,
    };
    if (!shouldInspectVideo) return base;

    const modelList = document.querySelector("[data-video-model-list]");
    const workspace = document.querySelector("[data-video-creator-layout]");
    const taskCards = [...document.querySelectorAll("[data-video-task-card]")];
    const avatarImages = [...document.querySelectorAll("[data-video-model-avatar] img")];
    const visibleCards = taskCards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const firstCard = visibleCards[0];
    const grid = firstCard?.parentElement;
    const tracks = grid
      ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/u).filter((value) => Number.parseFloat(value) > 1)
      : [];
    return {
      ...base,
      modelCount: document.querySelectorAll("[data-video-model-id]").length,
      avatarCount: avatarImages.length,
      brokenAvatars: avatarImages.filter((image) => image.complete && image.naturalWidth === 0).length,
      taskCardCount: visibleCards.length,
      taskColumns: tracks.length,
      taskCardWidth: firstCard ? Math.round(firstCard.getBoundingClientRect().width) : 0,
      modelRailWidth: modelList ? Math.round(modelList.getBoundingClientRect().width) : 0,
      workspaceWidth: workspace ? Math.round(workspace.getBoundingClientRect().width) : 0,
    };
  }, { inspectVideo });

  await page.screenshot({ path: path.join(evidenceDirectory, screenshot), fullPage: false });
  await context.close();
  report.pages.push({ id, route, viewport, ...metrics });
  return metrics;
}

async function verifyThemeSwitching(browser) {
  const context = await createContext(browser, { width: 1440, height: 960 });
  const page = await context.newPage();
  attachDiagnostics(page, "theme-switching");
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const trigger = page.locator(".sidebar-shell [data-theme-switcher-trigger]");
  await trigger.waitFor({ state: "visible", timeout: 30_000 });

  await trigger.click();
  await page.locator('[data-theme-option="lattice"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "lattice" && document.documentElement.dataset.mode === "dark");
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidenceDirectory, "home-default-theme.png"), fullPage: false });
  const restoredDefault = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.mode,
    sidebarBackground: getComputedStyle(document.querySelector(".sidebar-shell")).backgroundColor,
    brandBackground: getComputedStyle(document.querySelector(".sidebar-brand-card")).backgroundColor,
    conversationBackground: getComputedStyle(document.querySelector(".sidebar-conv-item")).backgroundColor,
  }));

  await trigger.click();
  await page.locator('[data-theme-option="soft-white"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "soft-white" && document.documentElement.dataset.mode === "light");
  const restoredSoftWhite = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.mode,
  }));
  await context.close();
  return { restoredDefault, restoredSoftWhite };
}

const browser = await chromium.launch({ headless: true });
try {
  report.themeSwitch = await verifyThemeSwitching(browser);
  await inspectPage(browser, {
    id: "home-desktop", route: "/", viewport: { width: 1440, height: 960 }, screenshot: "home-desktop.png",
  });
  const videoDesktop = await inspectPage(browser, {
    id: "video-desktop", route: "/video", viewport: { width: 1440, height: 960 }, screenshot: "video-desktop.png", inspectVideo: true,
  });
  const videoMedium = await inspectPage(browser, {
    id: "video-medium", route: "/video", viewport: { width: 1280, height: 900 }, screenshot: "video-medium.png", inspectVideo: true,
  });
  const videoWide = await inspectPage(browser, {
    id: "video-wide", route: "/video", viewport: { width: 1920, height: 1080 }, screenshot: "video-wide.png", inspectVideo: true,
  });
  await inspectPage(browser, {
    id: "storyboard-desktop", route: "/storyboard-workbench", viewport: { width: 1440, height: 960 }, screenshot: "storyboard-desktop.png",
  });
  await inspectPage(browser, {
    id: "admin-desktop", route: "/admin", viewport: { width: 1440, height: 960 }, screenshot: "admin-desktop.png",
  });

  for (const page of report.pages) {
    assert.equal(page.theme, "soft-white", `${page.id} THEME_MISMATCH`);
    assert.equal(page.mode, "light", `${page.id} MODE_MISMATCH`);
    assert.ok(page.softWhiteBackground, `${page.id} BACKGROUND_NOT_SOFT_WHITE: ${page.bodyBackground}`);
    assert.equal(page.horizontalOverflow, false, `${page.id} HORIZONTAL_OVERFLOW`);
  }
  assert.ok(videoDesktop.modelCount > 0, "VIDEO_MODELS_MISSING");
  assert.ok(videoDesktop.avatarCount > 0, "VIDEO_MODEL_AVATARS_MISSING");
  assert.equal(videoDesktop.brokenAvatars, 0, "VIDEO_MODEL_AVATARS_BROKEN");
  assert.equal(videoDesktop.taskCardCount, 3, "VIDEO_TASK_CARD_COUNT");
  assert.equal(videoMedium.taskColumns, 2, "VIDEO_MEDIUM_EXPECTED_TWO_COLUMNS");
  assert.ok(videoMedium.taskCardWidth >= 420, `VIDEO_MEDIUM_CARD_TOO_NARROW: ${videoMedium.taskCardWidth}`);
  assert.equal(videoDesktop.taskColumns, 3, "VIDEO_DESKTOP_EXPECTED_THREE_COLUMNS");
  assert.ok(videoDesktop.taskCardWidth >= 330, `VIDEO_DESKTOP_CARD_TOO_NARROW: ${videoDesktop.taskCardWidth}`);
  assert.equal(videoDesktop.modelRailWidth, 312, `VIDEO_MODEL_RAIL_WIDTH: ${videoDesktop.modelRailWidth}`);
  assert.equal(videoWide.taskColumns, 3, "VIDEO_WIDE_EXPECTED_THREE_COLUMNS");
  assert.ok(videoWide.taskCardWidth >= 400, `VIDEO_WIDE_CARD_TOO_NARROW: ${videoWide.taskCardWidth}`);
  assert.deepEqual(report.stubbedAppearanceWrites.map((entry) => entry.theme), ["lattice", "soft-white"],
    "THEME_SWITCH_MUST_USE_READ_ONLY_PERSISTENCE_STUB");
  assert.ok(report.stubbedAppearanceWrites.every((entry) => entry.persisted === false),
    "THEME_ACCEPTANCE_MUST_NOT_PERSIST_USER_DATA");
  assert.equal(report.pageErrors.length, 0, `PAGE_ERRORS: ${JSON.stringify(report.pageErrors)}`);
} finally {
  await browser.close();
  await fs.writeFile(path.join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({
  evidenceDirectory,
  policy: report.policy,
  themeSwitch: report.themeSwitch,
  pages: report.pages,
  pageErrors: report.pageErrors,
  consoleErrors: report.consoleErrors,
}, null, 2));
