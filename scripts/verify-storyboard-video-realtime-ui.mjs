import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const fixturePath = path.resolve("public/storyboard-reviews/high-energy-default10-v642-pica-gpt-omni-20260815.json");
const screenshotDir = path.resolve(".codex-screenshots/storyboard-video-realtime");
await mkdir(screenshotDir, { recursive: true });

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.ok(fixture.run?.cards?.[0]?.imageUrl, "测试存档没有已验证故事板图片");

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

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
      name: "Realtime Video Test",
      durationSeconds: 10,
      minDuration: 10,
      maxDuration: 10,
      supportsImageInput: true,
      requiresImage: true,
      resolutionOptions: ["1080p"],
      defaultResolution: "1080p",
      aspectRatios: ["16:9"],
    }] }),
  }));
}

async function runScenario(name, terminalEvent, expectedStatus, expectedText) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const run = buildRun(name);
  await page.addInitScript(({ token, payload }) => {
    localStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(payload));
  }, { token: session.token, payload: run });
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

  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.getByText("Realtime Video Test", { exact: false }).first().waitFor({ timeout: 15_000 });
  const card = page.locator(".sbw-shot-card").first();
  await card.waitFor({ timeout: 30_000 });
  const generate = card.getByRole("button", { name: "生成视频", exact: true });
  await generate.waitFor({ state: "visible", timeout: 30_000 });
  await generate.click();
  try {
    await card.getByText(expectedText, { exact: false }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    const debugRun = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
    const debugText = await card.innerText().catch(() => "card unavailable");
    throw new Error(`${error.message}\nSTATUS=${JSON.stringify(debugRun?.cards?.[0] || null)}\nCARD=${debugText.slice(-1200)}`);
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  assert.equal(saved.cards[0].videoStatus, expectedStatus);
  if (expectedStatus === "done") assert.equal(saved.cards[0].videoProgress, 100);
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  results.push({ name, status: saved.cards[0].videoStatus, detail: saved.cards[0].videoStatusDetail });
  await context.close();
}

async function runCancelScenario() {
  const name = "cancelled";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const run = buildRun(name);
  await page.addInitScript(({ token, payload }) => {
    localStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(payload));
  }, { token: session.token, payload: run });
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

  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.getByText("Realtime Video Test", { exact: false }).first().waitFor({ timeout: 15_000 });
  const card = page.locator(".sbw-shot-card").first();
  await card.getByRole("button", { name: "生成视频", exact: true }).click();
  const stop = card.getByRole("button", { name: "终止生成", exact: true });
  await stop.waitFor({ timeout: 15_000 });
  await stop.click();
  await card.getByText("视频已终止", { exact: false }).first().waitFor({ timeout: 15_000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  assert.equal(saved.cards[0].videoStatus, "cancelled");
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  results.push({ name, status: saved.cards[0].videoStatus, detail: saved.cards[0].videoStatusDetail });
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
