import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
assert.match(baseUrl, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u, "LOCAL_PREVIEW_REQUIRED");
const fixturePath = path.resolve("public/storyboard-reviews/high-energy-default10-v642-pica-gpt-omni-20260815.json");
const screenshotDir = path.resolve(".codex-screenshots/storyboard-video-realtime");
await mkdir(screenshotDir, { recursive: true });

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.ok(fixture.run?.cards?.[0]?.imageUrl, "测试存档没有已验证故事板图片");
const storyboardFixtureImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#0f172a"/></svg>');

// This verifier is intentionally browser-fixture-only.  The old dev-session
// endpoint no longer exists in the production-shaped runtime, so depending on
// it made an otherwise zero-cost UI check fail before reaching the workbench.
const session = {
  token: "storyboard-video-realtime-browser-fixture",
  user: {
    id: "storyboard-video-realtime-fixture-user",
    username: "storyboard_video_fixture",
    displayName: "分镜视频浏览器验收",
    role: "admin",
    status: "active",
    is_active: true,
    credits: 0,
    cashBalance: 0,
  },
};

const browser = await chromium.launch({ headless: true });
const results = [];

function buildRun(scenario) {
  const run = structuredClone(fixture.run);
  run.id = `realtime-${scenario}-${Date.now()}`;
  run.title = `视频实时反馈无费用回归｜${scenario}`;
  run.cards = [run.cards[0]];
  Object.assign(run.cards[0], {
    id: `card-${scenario}`,
    order: 1,
    imagePrompt: "单幅16:9画面，一只金毛犬在客厅看向镜头。",
    videoPrompt: "镜头缓慢推进，金毛犬自然抬头，动作连续。",
    videoStatus: "idle",
    videoUrl: undefined,
    videoError: undefined,
    videoTaskId: undefined,
    videoTaskModelId: undefined,
    videoContentUrl: undefined,
    videoProgress: undefined,
    videoStartedAt: undefined,
    videoLastCheckedAt: undefined,
    videoStatusDetail: undefined,
    videoPollFailures: 0,
    imageUrl: "https://media.storyboard.test/realtime.svg",
    imageWidth: 1600,
    imageHeight: 900,
    imageValidatedAt: Date.now(),
    imageRequestSnapshot: {
      runId: run.id,
      cardId: `card-${scenario}`,
      cardOrder: 1,
      prompt: run.cards[0].imagePrompt,
      modelId: run.imageModelId,
      aspectRatio: "16:9",
      resolution: "1K",
      referenceImageUrls: [],
      strictSingleSubmit: false,
    },
  });
  return run;
}

async function mockModelCatalog(page, run) {
  await page.route(/\/api\/cover-models(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [{
      id: run.imageModelId,
      name: "GPT Image Test",
      model_name: "gpt-image-test",
      supports_image_input: true,
      resolution_options: ["1K"],
      default_resolution: "1K",
    }] }),
  }));
  await page.route(/\/api\/video\/models(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [{
      id: run.videoModelId,
      displayName: "Realtime Video Test",
      publicPrice: 0.4,
      capabilities: {
        type: "video",
        durationMode: "fixed",
        durationSeconds: 10,
        minDuration: 10,
        maxDuration: 10,
        defaultDuration: 10,
        nativeDurations: [10],
        supportsImageInput: true,
        requiresImage: true,
        supportsRemoteCancel: true,
        resolutionOptions: ["1080p"],
        defaultResolution: "1080p",
        aspectRatios: ["16:9"],
        workspaceSurfaces: ["storyboard"],
      },
    }] }),
  }));
}

async function mockPeripheralApis(page) {
  await page.route("https://media.storyboard.test/realtime.svg", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: storyboardFixtureImage,
  }));
  await page.route("**/api/image-workbench/persist", async (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: body.url, width: 1600, height: 900 }),
    });
  });
  await page.route(/\/api\/announcements\/inbox(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ announcements: [], unreadCount: 0, cursor: null }),
  }));
  await page.route(/\/api\/notifications\/user(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, notifications: [], total: 0, unreadCount: 0 }),
  }));
  await page.route(/\/api\/video\/active-tasks(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ activeTasks: [] }),
  }));
}

async function runScenario(name, terminalEvent, expectedStatus, expectedText) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const diagnostics = { requests: [], failedRequests: [], consoleErrors: [], pageErrors: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(baseUrl).origin && url.pathname.startsWith("/api/")) {
      diagnostics.requests.push(`${request.method()} ${url.pathname}`);
    }
  });
  page.on("requestfailed", (request) => diagnostics.failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText || "unknown",
  }));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  const run = buildRun(name);
  const projectFixture = await installStoryboardBrowserFixture(page, {
    token: session.token,
    user: session.user,
    resetStorage: false,
    initialProjects: [run],
  });
  await page.addInitScript(({ token, user, payload }) => {
    localStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "storyboard-workbench");
    sessionStorage.setItem("entered_app", "1");
    localStorage.setItem(`storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(user.id)}`, JSON.stringify(payload));
  }, { token: session.token, user: session.user, payload: run });
  await mockPeripheralApis(page);
  await mockModelCatalog(page, run);

  await page.route("**/api/video/generate", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      task_id: `mock-${name}`,
      model_id: run.videoModelId,
      status: "pending",
      message: "任务已提交，正在连接上游实时状态",
    }),
  }));
  await page.route(/\/api\/video\/stream(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: { "cache-control": "no-cache" },
    body: [
      `event: progress\ndata: ${JSON.stringify({ taskId: `mock-${name}`, status: "processing", progress: 0.42, message: "上游正在渲染视频" })}\n\n`,
      `event: ${terminalEvent.event}\ndata: ${JSON.stringify(terminalEvent.data)}\n\n`,
    ].join(""),
  }));
  await page.route(/\/api\/video\/status(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(terminalEvent.data),
  }));

  await page.goto(`${baseUrl}/storyboard-workbench?projectId=${encodeURIComponent(run.id)}`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByText("Realtime Video Test", { exact: false }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    const pageText = await page.locator("body").innerText().catch(() => "body unavailable");
    throw new Error(`${error.message}\nURL=${page.url()}\nDIAGNOSTICS=${JSON.stringify(diagnostics)}\nBODY=${pageText.slice(0, 2400)}`);
  }
  const card = page.locator(".sbw-shot-card").first();
  await card.waitFor({ timeout: 30_000 });
  const generate = card.getByRole("button", { name: "生成视频", exact: true });
  await generate.waitFor({ state: "visible", timeout: 30_000 });
  await generate.click();
  try {
    await card.getByText(expectedText, { exact: false }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    const debugRun = projectFixture.latestDocument();
    const debugText = await card.innerText().catch(() => "card unavailable");
    const notices = await page.locator(".sbw-notice").allTextContents().catch(() => []);
    throw new Error(`${error.message}\nSTATUS=${JSON.stringify(debugRun?.cards?.[0] || null)}\nNOTICES=${JSON.stringify(notices)}\nREQUESTS=${JSON.stringify(diagnostics.requests)}\nFAILED=${JSON.stringify(diagnostics.failedRequests)}\nCARD=${debugText.slice(-1200)}`);
  }
  const saveDeadline = Date.now() + 10_000;
  while (projectFixture.latestDocument()?.cards?.[0]?.videoStatus !== expectedStatus && Date.now() < saveDeadline) {
    await page.waitForTimeout(50);
  }
  const saved = projectFixture.latestDocument();
  assert.ok(saved?.cards?.[0], "账号工程没有保存实时视频状态");
  assert.equal(saved.cards[0].videoStatus, expectedStatus);
  if (expectedStatus === "done") assert.equal(saved.cards[0].videoProgress, 100);
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  results.push({
    name,
    status: saved.cards[0].videoStatus,
    detail: saved.cards[0].videoStatusDetail,
    fixtureProjectWrites: projectFixture.projectWrites.length,
  });
  await context.close();
}

async function runCancelScenario() {
  const name = "cancelled";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const run = buildRun(name);
  const projectFixture = await installStoryboardBrowserFixture(page, {
    token: session.token,
    user: session.user,
    resetStorage: false,
    initialProjects: [run],
  });
  await page.addInitScript(({ token, user, payload }) => {
    localStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "storyboard-workbench");
    sessionStorage.setItem("entered_app", "1");
    localStorage.setItem(`storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(user.id)}`, JSON.stringify(payload));
  }, { token: session.token, user: session.user, payload: run });
  await mockPeripheralApis(page);
  await mockModelCatalog(page, run);
  await page.route("**/api/video/generate", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ task_id: "mock-cancel", model_id: run.videoModelId, status: "pending" }),
  }));
  await page.route(/\/api\/video\/stream(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    body: `event: progress\ndata: ${JSON.stringify({ status: "processing", progress: 0.2, message: "上游正在渲染视频" })}\n\n`,
  }));
  await page.route(/\/api\/video\/status(?:\?|$)/u, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "processing", progress: 0.2, message: "上游正在渲染视频" }),
  }));
  await page.route("**/api/video/cancel", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, status: "cancelled", message: "任务已终止" }),
  }));

  await page.goto(`${baseUrl}/storyboard-workbench?projectId=${encodeURIComponent(run.id)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Realtime Video Test", { exact: false }).first().waitFor({ timeout: 15_000 });
  const card = page.locator(".sbw-shot-card").first();
  await card.getByRole("button", { name: "生成视频", exact: true }).click();
  const stop = card.getByRole("button", { name: "终止生成", exact: true });
  await stop.waitFor({ timeout: 15_000 });
  await stop.click();
  await card.getByText("视频已终止", { exact: false }).first().waitFor({ timeout: 15_000 });
  const saveDeadline = Date.now() + 10_000;
  while (projectFixture.latestDocument()?.cards?.[0]?.videoStatus !== "cancelled" && Date.now() < saveDeadline) {
    await page.waitForTimeout(50);
  }
  const saved = projectFixture.latestDocument();
  assert.ok(saved?.cards?.[0], "账号工程没有保存终止状态");
  assert.equal(saved.cards[0].videoStatus, "cancelled");
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  results.push({
    name,
    status: saved.cards[0].videoStatus,
    detail: saved.cards[0].videoStatusDetail,
    fixtureProjectWrites: projectFixture.projectWrites.length,
  });
  await context.close();
}

try {
  await runScenario("completed", {
    event: "completed",
    data: { status: "completed", videoUrl: "https://cdn.example.test/video.mp4", progress: 100 },
  }, "done", "视频完成");
  await runScenario("failed", {
    event: "failed",
    data: { status: "failed", errorMessage: "内容审核未通过" },
  }, "failed", "内容审核未通过");
  await runScenario("insufficient-balance", {
    event: "failed",
    data: { status: "failed", errorMessage: "余额不足，请充值后重试" },
  }, "failed", "余额不足");
  await runCancelScenario();
  console.log(JSON.stringify({ passed: true, results, paidCalls: 0, screenshotDir }, null, 2));
} finally {
  await browser.close();
}
