#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const ORIGIN = process.env.LOCAL_APP_URL || "http://127.0.0.1:5000";
assert.equal(ORIGIN, "http://127.0.0.1:5000", "ONLY_FIXED_LOCAL_APP_ALLOWED");
const outputDir = path.resolve(process.env.LOCAL_CANCELLATION_EVIDENCE_DIR || path.join(".codex-evidence", `video-cancellation-ui-local-${Date.now()}`));
await fs.mkdir(outputDir, { recursive: true });

const user = {
  id: "video-cancel-browser-user",
  username: "video_cancel_fixture",
  displayName: "视频终止验收账号",
  role: "admin",
  status: "active",
  is_active: true,
};
const token = ["video-cancel-browser", "fixture"].join("-");
const model = {
  id: "video-cancel-fixture-model",
  displayName: "终止链验收模型",
  name: "终止链验收模型",
  publicPrice: 0.4,
  supportsRemoteCancel: false,
  capabilities: {
    type: "video",
    available: true,
    supportsPrompt: true,
    supportsImageInput: true,
    requiresImage: false,
    showFirstFrame: true,
    showLastFrame: false,
    showReferenceImages: false,
    maxReferenceImages: 0,
    maxReferenceAudios: 0,
    durationMode: "fixed",
    minDuration: 10,
    maxDuration: 10,
    defaultDuration: 10,
    nativeDurations: [10],
    resolutionTier: "720p",
    resolutionOptions: ["720p"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "1:1"],
    workspaceSurfaces: ["video-page", "storyboard"],
  },
};
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAEtgJ8k7zwNQAAAABJRU5ErkJggg==",
  "base64",
);

const report = {
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  scenarios: [],
  pageErrors: [],
  providerCalls: 0,
  paidCalls: 0,
  realDatabaseWrites: 0,
  passed: false,
};

function routePath(route) {
  return new URL(route.request().url()).pathname;
}

async function installIdentity(page) {
  await page.addInitScript(({ expectedOrigin, fixtureToken, fixtureUser }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem("auth_token", fixtureToken);
    localStorage.setItem("auth_user", JSON.stringify(fixtureUser));
    sessionStorage.setItem("entered_app", "1");
  }, { expectedOrigin: ORIGIN, fixtureToken: token, fixtureUser: user });
  await page.route("**/api/auth/me**", (route) => routePath(route) === "/api/auth/me"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) })
    : route.fallback());
  await page.route("**/api/member-permissions**", (route) => routePath(route) === "/api/member-permissions"
    ? route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ permission: {
          userId: user.id,
          role: user.role,
          featureNavigationKeys: ["marketplace", "storyboard_workbench", "image_workbench", "create", "voice", "cover"],
          agentNavigationKeys: [],
          revision: 1,
          checksum: "video-cancel-browser",
          integrityValid: true,
          authorityStatus: "admin",
        } }),
      })
    : route.fallback());
  await page.route("**/api/credits**", (route) => routePath(route) === "/api/credits"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 1000, cashBalance: 1000 }) })
    : route.fallback());
  await page.route("**/api/cash/balance**", (route) => routePath(route) === "/api/cash/balance"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 1000 }) })
    : route.fallback());
}

function assertDesktopLayout(layout, label) {
  assert.ok(layout.bodyWidth <= layout.viewportWidth + 1, `${label}: BODY_HORIZONTAL_OVERFLOW`);
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${label}: DOCUMENT_HORIZONTAL_OVERFLOW`);
  assert.ok(layout.buttonWidth >= 76 && layout.buttonHeight >= 30, `${label}: TERMINATE_CONTROL_TOO_SMALL`);
  assert.ok(layout.buttonFontSize >= 12, `${label}: TERMINATE_CONTROL_TEXT_TOO_SMALL`);
}

async function browserLayout(page, button) {
  return page.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      viewportWidth: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonWidth: Math.round(rect.width),
      buttonHeight: Math.round(rect.height),
      buttonFontSize: Number.parseFloat(style.fontSize),
      buttonVisible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0,
    };
  }, await button.elementHandle());
}

async function runVideoPageScenario(browser, { viewport, mode }) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.route("**/api/**", (route) => route.abort("blockedbyclient"));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ surface: "video", mode, message: error.message }));
  await installIdentity(page);
  const cancelRequests = [];
  const taskId = `video-active-${mode}`;
  await page.route("**/api/video/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [model] }),
  }));
  await page.route("**/api/video/active-tasks**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ activeTasks: [{
      id: taskId,
      taskId,
      modelId: model.id,
      status: "queued",
      prompt: "终止链浏览器验收",
      cardIndex: 1,
      durationSeconds: 10,
      aspectRatio: "16:9",
      resolution: "720p",
      providerStatusMessage: "等待上游处理",
      createdAt: new Date().toISOString(),
    }] }),
  }));
  await page.route("**/api/video/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "processing", progress: 42, taskId }),
  }));
  await page.route("**/api/video/stream**", (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ status: "processing", progress: 42, taskId })}\n\n`,
  }));
  await page.route("**/api/video/history**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ tasks: [], nextOffset: null }),
  }));
  await page.route("**/api/video/cancel**", async (route) => {
    cancelRequests.push(route.request().postDataJSON());
    if (mode === "confirmed") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          status: "cancelled",
          taskId,
          message: "上游已确认终止，本地任务与费用预留已同步释放",
          upstreamCancellationRequested: true,
          upstreamDispatchDetected: true,
        }),
      });
    }
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        status: "processing",
        taskId,
        error: "该视频渠道未提供可核验的上游终止接口；系统不会只改本地状态，原任务会继续追踪",
        upstreamCancellationRequested: false,
      }),
    });
  });

  const response = await page.goto(`${ORIGIN}/video?acceptance=cancellation-${mode}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `video ${mode}: page failed`);
  const button = page.getByRole("button", { name: "终止生成", exact: true }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  const title = await button.getAttribute("title");
  assert.match(title || "", /已投递任务须获上游终止确认/u, `video ${mode}: honest upstream tooltip missing`);
  const layout = await browserLayout(page, button);
  assert.equal(layout.buttonVisible, true, `video ${mode}: terminate control hidden`);
  assertDesktopLayout(layout, `video ${mode}`);
  await button.click();
  await page.waitForTimeout(350);
  assert.equal(cancelRequests.length, 1, `video ${mode}: cancellation request count`);
  assert.equal(cancelRequests[0].taskId, taskId, `video ${mode}: wrong task id`);
  if (mode === "confirmed") {
    await page.getByText("已终止生成", { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "终止生成", exact: true }).count(), 0, "confirmed video task remained active");
  } else {
    await page.getByText(/系统不会只改本地状态/u).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "终止生成", exact: true }).count(), 1, "unsupported video task lost active tracking");
  }
  const screenshot = path.join(outputDir, `video-${mode}-${viewport.width}x${viewport.height}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  report.scenarios.push({ surface: "video", mode, viewport, taskId, cancelRequests: cancelRequests.length, layout, screenshot });
}

function storyboardProject(mode) {
  const now = Date.now();
  const taskId = `storyboard-active-${mode}`;
  const clientRequestId = `storyboard-${mode}-request-12345678`;
  return {
    id: `storyboard-cancel-project-${mode}`,
    createdAt: now - 60_000,
    updatedAt: now,
    lastSubmittedAt: now,
    ratio: "16:9",
    imageResolution: "2K",
    videoResolution: "720p",
    videoDuration: 10,
    imageModelId: "image-fixture-model",
    videoModelId: model.id,
    videoContract: { modelId: model.id, resolution: "720p", duration: 10, ratio: "16:9" },
    title: `分镜终止验收-${mode}`,
    cards: [{
      id: `shot-${mode}`,
      order: 1,
      narration: "终止任务验收",
      imagePrompt: "终止任务验收画面",
      imageExactText: "",
      videoPrompt: "终止任务验收视频",
      referenceImageUrls: [],
      imageStatus: "done",
      imageUrl: "https://media.storyboard.test/cancel-fixture.png",
      imageValidatedAt: now - 30_000,
      videoStatus: "queued",
      videoTaskId: taskId,
      videoClientRequestId: clientRequestId,
      videoClientRequestFingerprint: "a".repeat(64),
      videoTaskModelId: model.id,
      videoTaskModelName: model.displayName,
      videoTaskDuration: 10,
      // The unsupported response simulates an upstream rejection after a channel declared remote cancellation.
      videoSupportsRemoteCancel: mode !== "stop-wait",
      videoStartedAt: now - 20_000,
      videoStatusDetail: "等待上游处理",
      videoBillingState: "provider_submitted",
      videoPriceCharged: 0,
    }],
  };
}

async function runStoryboardScenario(browser, { viewport, mode }) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.route("**/api/**", (route) => route.abort("blockedbyclient"));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ surface: "storyboard", mode, message: error.message }));
  const project = storyboardProject(mode);
  const fixture = await installStoryboardBrowserFixture(page, { origin: ORIGIN, token, user, initialProjects: [project] });
  const cancelRequests = [];
  await page.route("**/api/cover-models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [{
      id: "image-fixture-model",
      displayName: "终止链图片夹具",
      publicPrice: 0.2,
      capabilities: { family: "gpt", supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ["2K"], defaultResolution: "2K" },
    }] }),
  }));
  await page.route("**/api/video/models**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ ...model, supportsRemoteCancel: mode !== "stop-wait" }] }) }));
  await page.route("https://media.storyboard.test/cancel-fixture.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: transparentPng }));
  await page.route("**/api/video/history**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [], nextOffset: null }) }));
  await page.route("**/api/video/status**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "processing", progress: 35, taskId: project.cards[0].videoTaskId }),
  }));
  await page.route("**/api/video/cancel**", async (route) => {
    cancelRequests.push(route.request().postDataJSON());
    if (mode === "confirmed") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          status: "cancelled",
          taskId: project.cards[0].videoTaskId,
          message: "上游已确认终止，本地任务与费用预留已同步释放",
          upstreamDispatchDetected: true,
        }),
      });
    }
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        status: "processing",
        error: "该视频渠道未提供可核验的上游终止接口；系统不会只改本地状态，原任务会继续追踪",
      }),
    });
  });

  const response = await page.goto(`${ORIGIN}/storyboard-workbench?acceptance=cancellation-${mode}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `storyboard ${mode}: page failed`);
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const projectRow = page.locator(`[data-storyboard-project-id="${project.id}"]`);
  await projectRow.waitFor({ state: "visible", timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await projectRow.getByRole("button", { name: "打开任务", exact: true }).click();
  const button = page.getByRole("button", { name: mode === "stop-wait" ? "停止等待" : "终止生成", exact: true }).first();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  const title = await button.getAttribute("title");
  assert.match(title || "", mode === "stop-wait" ? /上游任务与后台查询不受影响/u : /终止本次任务并同步上游/u, `storyboard ${mode}: honest upstream tooltip missing`);
  const layout = await browserLayout(page, button);
  assert.equal(layout.buttonVisible, true, `storyboard ${mode}: terminate control hidden`);
  assertDesktopLayout(layout, `storyboard ${mode}`);
  await button.click();
  await page.waitForTimeout(350);
  assert.equal(cancelRequests.length, mode === "stop-wait" ? 0 : 1, `storyboard ${mode}: cancellation request count`);
  if (mode !== "stop-wait") {
    assert.equal(cancelRequests[0].taskId, project.cards[0].videoTaskId, `storyboard ${mode}: wrong task id`);
    assert.equal(cancelRequests[0].clientRequestId, project.cards[0].videoClientRequestId, `storyboard ${mode}: stable request id missing`);
  }
  if (mode === "stop-wait") {
    const resume = page.getByRole("button", { name: "继续查询", exact: true }).first();
    await resume.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText(/上游任务未取消/u).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("视频已终止", { exact: true }).count(), 0, "stop-wait must not fabricate upstream cancellation");
    for (let attempt = 0; attempt < 20 && !fixture.projects.get(project.id)?.document?.cards?.[0]?.videoMonitoringPaused; attempt++) {
      await page.waitForTimeout(50);
    }
    const stored = fixture.projects.get(project.id)?.document?.cards?.[0];
    assert.equal(stored?.videoTaskId, project.cards[0].videoTaskId, "stop-wait lost original task identity");
    assert.ok(["queued", "running"].includes(stored?.videoStatus), "stop-wait changed task to a terminal state");
    assert.equal(stored?.videoMonitoringPaused, true, "stop-wait state was not saved in the isolated project fixture");
  } else if (mode === "confirmed") {
    await page.getByText("视频已终止", { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "终止生成", exact: true }).count(), 0, "confirmed storyboard task remained active");
  } else {
    await page.getByText(/系统不会只改本地状态/u).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "终止生成", exact: true }).count(), 1, "unsupported storyboard task lost active tracking");
  }
  const screenshot = path.join(outputDir, `storyboard-${mode}-${viewport.width}x${viewport.height}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  report.scenarios.push({
    surface: "storyboard",
    mode,
    viewport,
    taskId: project.cards[0].videoTaskId,
    clientRequestId: project.cards[0].videoClientRequestId,
    cancelRequests: cancelRequests.length,
    projectWrites: fixture.projectWrites.length,
    layout,
    screenshot,
  });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  await runVideoPageScenario(browser, { viewport: { width: 1440, height: 900 }, mode: "confirmed" });
  await runVideoPageScenario(browser, { viewport: { width: 1920, height: 1080 }, mode: "unsupported" });
  await runStoryboardScenario(browser, { viewport: { width: 1440, height: 900 }, mode: "confirmed" });
  await runStoryboardScenario(browser, { viewport: { width: 1920, height: 1080 }, mode: "unsupported" });
  await runStoryboardScenario(browser, { viewport: { width: 1440, height: 900 }, mode: "stop-wait" });
  assert.equal(report.pageErrors.length, 0, `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
  assert.equal(report.scenarios.length, 5, "ALL_DESKTOP_SCENARIOS_REQUIRED");
  report.passed = true;
} finally {
  await browser?.close();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({
  passed: report.passed,
  scenarios: report.scenarios.map(({ surface, mode, viewport, cancelRequests }) => ({ surface, mode, viewport, cancelRequests })),
  pageErrors: report.pageErrors.length,
  providerCalls: report.providerCalls,
  paidCalls: report.paidCalls,
  realDatabaseWrites: report.realDatabaseWrites,
  report: path.join(outputDir, "report.json"),
}, null, 2));
