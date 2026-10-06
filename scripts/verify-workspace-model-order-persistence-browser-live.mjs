#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence/model-chain-audit-20261006/workspace-order-browser", runId);
const headers = {
  Authorization: `Bearer ${token}`,
  "x-admin-step-up": stepUpToken,
  "Content-Type": "application/json",
};

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token && stepUpToken && identity?.user?.id, "LOCAL_ADMIN_STEP_UP_BROWSER_CONTEXT_REQUIRED");

async function api(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}:HTTP_${response.status}:${body.code || "UNKNOWN"}:${body.error || "unknown"}`);
  return body;
}

function assignedIds(catalog, surfaceId) {
  const surface = catalog.surfaces?.find((entry) => entry.id === surfaceId);
  assert.ok(surface, `SURFACE_REQUIRED:${surfaceId}`);
  return surface.models.filter((model) => model.assigned).map((model) => String(model.id));
}

async function publishOrder(surfaceId, kind, modelIds) {
  const staged = await api("/api/admin/workspace-models", {
    method: "POST",
    body: JSON.stringify({ action: "reorder", kind, surface: surfaceId, modelIds }),
  });
  const releaseId = String(staged.result?.release?.id || "");
  assert.ok(releaseId, "WORKSPACE_ORDER_RELEASE_ID_REQUIRED");
  await api("/api/admin/workspace-model-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  });
  const preview = await api(`/api/admin/workspace-model-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "WORKSPACE_ORDER_PREVIEW_SHA_REQUIRED");
  await api("/api/admin/workspace-model-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
}

async function pageState(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const text = String(document.body?.innerText || "").replace(/\s+/gu, " ").trim();
    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
      textLength: text.length,
      replacementCharacters: (text.match(/\uFFFD/gu) || []).length,
    };
  });
}

const initialCatalog = await api("/api/admin/workspace-models");
const targetSurface = "storyboard-video";
const originalOrder = assignedIds(initialCatalog, targetSurface);
const protectedImageOrder = assignedIds(initialCatalog, "storyboard-image");
const protectedVideoPageOrder = assignedIds(initialCatalog, "video-page");
assert.ok(originalOrder.length >= 2, "TWO_STORYBOARD_VIDEO_MODELS_REQUIRED");
const targetFirstId = originalOrder[1];

const report = {
  schemaVersion: 1,
  passed: false,
  checkedAt: "",
  origin,
  runtime: await api("/api/version"),
  surface: targetSurface,
  originalFirstId: originalOrder[0],
  targetFirstId,
  changedFirstId: null,
  refreshedFirstId: null,
  independentSurfacesUnchanged: false,
  workspaceMutationRequestsBeforeSave: 0,
  workspaceMutationRequestsAfterSave: 0,
  paidGenerationRequests: 0,
  externalRequests: 0,
  pageErrors: [],
  consoleErrors: [],
  failedResponses: [],
  pages: [],
  screenshots: [],
  cleanup: { restored: false },
};

let browser;
let orderChanged = false;
try {
  await fs.mkdir(evidenceDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    extraHTTPHeaders: headers,
  });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { await route.continue(); return; }
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      report.externalRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (request.method() === "POST" && /^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) report.paidGenerationRequests += 1;
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error?.message || error).slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) report.consoleErrors.push(message.text().slice(0, 500));
  });
  let workspaceMutationRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/admin/workspace-models") workspaceMutationRequests += 1;
  });
  page.on("response", (response) => {
    if (response.status() >= 400) report.failedResponses.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname });
  });

  const response = await page.goto(`${origin}/admin?tab=workspace-models&view=overview&project=storyboard`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200, "WORKSPACE_PAGE_HTTP_200_REQUIRED");
  const initialSaveBar = page.locator('[data-testid="workspace-model-order-save-bar"]:visible').first();
  await initialSaveBar.waitFor({ state: "visible" });
  const workspaceProject = initialSaveBar.locator('xpath=ancestor::div[@data-workspace-project][1]');
  const modelTypeSwitch = workspaceProject.locator('[aria-label="模型类型"]:visible').first();
  await modelTypeSwitch.locator(":scope > button").filter({ hasText: /^生视频模型$/u }).click();
  const saveBar = page.locator('[data-testid="workspace-model-order-save-bar"][data-surface-id="storyboard-video"]');
  await saveBar.waitFor({ state: "visible" });
  assert.equal(await saveBar.getAttribute("data-save-state"), "idle", "INITIAL_ORDER_STATE_MUST_BE_IDLE");

  const targetRow = page.locator(`[data-model-row="${targetFirstId}"]`);
  await targetRow.getByTitle("置顶", { exact: true }).click();
  await page.locator('[data-testid="workspace-model-order-save-bar"][data-save-state="dirty"]').waitFor({ state: "visible" });
  report.workspaceMutationRequestsBeforeSave = workspaceMutationRequests;
  assert.equal(workspaceMutationRequests, 0, "REORDER_MUST_REMAIN_LOCAL_BEFORE_SAVE");
  assert.equal(await page.locator("tbody tr[data-model-row]").first().getAttribute("data-model-row"), targetFirstId, "DRAFT_ORDER_NOT_RENDERED");

  await modelTypeSwitch.locator(":scope > button").filter({ hasText: /^生图模型$/u }).click();
  assert.equal(await page.locator('[data-testid="workspace-model-order-save-bar"]').getAttribute("data-surface-id"), "storyboard-image", "SURFACE_SWITCH_FAILED");
  assert.equal(await page.locator('[data-testid="workspace-model-order-save-bar"]').getAttribute("data-save-state"), "idle", "OTHER_SURFACE_MUST_KEEP_INDEPENDENT_STATE");
  await modelTypeSwitch.locator(":scope > button").filter({ hasText: /^生视频模型$/u }).click();
  assert.equal(await page.locator('[data-testid="workspace-model-order-save-bar"]').getAttribute("data-save-state"), "dirty", "VIDEO_SURFACE_DRAFT_MUST_SURVIVE_TAB_SWITCH");

  const dirtyScreenshot = path.join(evidenceDir, "storyboard-video-order-dirty.png");
  await page.screenshot({ path: dirtyScreenshot, fullPage: true });
  report.screenshots.push(path.relative(process.cwd(), dirtyScreenshot));
  await page.locator('[data-testid="workspace-model-order-save"]').click();
  orderChanged = true;
  await page.getByText(/排序已保存并发布，刷新页面仍会保持/u).waitFor({ state: "visible", timeout: 30_000 });
  report.workspaceMutationRequestsAfterSave = workspaceMutationRequests;
  assert.equal(workspaceMutationRequests, 1, "EXPLICIT_SAVE_MUST_STAGE_EXACTLY_ONE_ORDER_MUTATION");

  const changedCatalog = await api("/api/admin/workspace-models");
  report.changedFirstId = assignedIds(changedCatalog, targetSurface)[0] || null;
  assert.equal(report.changedFirstId, targetFirstId, "PUBLISHED_ORDER_READBACK_FAILED");
  assert.deepEqual(assignedIds(changedCatalog, "storyboard-image"), protectedImageOrder, "STORYBOARD_IMAGE_ORDER_MUST_NOT_CHANGE");
  assert.deepEqual(assignedIds(changedCatalog, "video-page"), protectedVideoPageOrder, "VIDEO_PAGE_ORDER_MUST_NOT_CHANGE");
  report.independentSurfacesUnchanged = true;

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedInitialSaveBar = page.locator('[data-testid="workspace-model-order-save-bar"]:visible').first();
  await reloadedInitialSaveBar.waitFor({ state: "visible" });
  const reloadedWorkspaceProject = reloadedInitialSaveBar.locator('xpath=ancestor::div[@data-workspace-project][1]');
  await reloadedWorkspaceProject.locator('[aria-label="模型类型"]:visible').first().locator(":scope > button").filter({ hasText: /^生视频模型$/u }).click();
  report.refreshedFirstId = await page.locator("tbody tr[data-model-row]").first().getAttribute("data-model-row");
  assert.equal(report.refreshedFirstId, targetFirstId, "ORDER_REFRESH_PERSISTENCE_FAILED");
  const persistedScreenshot = path.join(evidenceDir, "storyboard-video-order-after-refresh.png");
  await page.screenshot({ path: persistedScreenshot, fullPage: true });
  report.screenshots.push(path.relative(process.cwd(), persistedScreenshot));

  for (const pathname of ["/storyboard-workbench", "/video"]) {
    const adjacentResponse = await page.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(adjacentResponse?.status(), 200, `${pathname}:HTTP_200_REQUIRED`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const state = await pageState(page);
    assert.equal(state.viewport.width, 1440, `${pathname}:DESKTOP_WIDTH_REQUIRED`);
    assert.equal(state.horizontalOverflowPx, 0, `${pathname}:HORIZONTAL_OVERFLOW`);
    assert.equal(state.replacementCharacters, 0, `${pathname}:REPLACEMENT_CHARACTER_FORBIDDEN`);
    assert.ok(state.textLength > 100, `${pathname}:VISIBLE_CONTENT_REQUIRED`);
    report.pages.push(state);
    const screenshot = path.join(evidenceDir, `${pathname.slice(1)}-regression.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), screenshot));
  }

  assert.equal(report.paidGenerationRequests, 0, "PAID_GENERATION_FORBIDDEN_IN_ORDER_TEST");
  assert.equal(report.externalRequests, 0, "EXTERNAL_REQUEST_FORBIDDEN_IN_ORDER_TEST");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS_FORBIDDEN");
  const expectedProductUsageFailures = report.failedResponses.filter((entry) => entry.status === 503 && entry.path === "/api/product-usage/events");
  const unexpectedFailedResponses = report.failedResponses.filter((entry) => !(entry.status === 503 && entry.path === "/api/product-usage/events"));
  const unexpectedConsoleErrors = report.consoleErrors.filter((entry) => !(
    expectedProductUsageFailures.length > 0
      && /Failed to load resource: the server responded with a status of 503/u.test(entry)
  ));
  assert.deepEqual(unexpectedConsoleErrors, [], "BROWSER_CONSOLE_ERRORS_FORBIDDEN");
  assert.deepEqual(unexpectedFailedResponses, [], "FAILED_SAME_ORIGIN_RESPONSES_FORBIDDEN");
  report.passed = true;
} finally {
  try {
    const current = await api("/api/admin/workspace-models").catch(() => null);
    if (current && (orderChanged || JSON.stringify(assignedIds(current, targetSurface)) !== JSON.stringify(originalOrder))) {
      await publishOrder(targetSurface, "video", originalOrder);
    }
    const restored = await api("/api/admin/workspace-models").catch(() => null);
    report.cleanup.restored = Boolean(restored) && JSON.stringify(assignedIds(restored, targetSurface)) === JSON.stringify(originalOrder)
      && JSON.stringify(assignedIds(restored, "storyboard-image")) === JSON.stringify(protectedImageOrder)
      && JSON.stringify(assignedIds(restored, "video-page")) === JSON.stringify(protectedVideoPageOrder);
  } finally {
    await browser?.close().catch(() => undefined);
    report.checkedAt = new Date().toISOString();
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}

assert.equal(report.cleanup.restored, true, "WORKSPACE_ORDER_CLEANUP_REQUIRED");
assert.equal(report.passed, true, "WORKSPACE_ORDER_BROWSER_ACCEPTANCE_NOT_PASSED");
console.log(JSON.stringify(report, null, 2));
