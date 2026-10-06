import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const screenshotDir = path.resolve(".codex-screenshots/storyboard-regeneration");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2cAAAAASUVORK5CYII=", "base64");
await mkdir(screenshotDir, { recursive: true });

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

const now = Date.now();
const run = {
  id: `regeneration-${now}`,
  createdAt: now,
  updatedAt: now,
  ratio: "16:9",
  imageResolution: "1K",
  videoResolution: "1080p",
  videoDuration: 10,
  imageModelId: "img-gpt",
  videoModelId: "vid-alpha",
  title: "模型切换与重新生成无费用回归",
  cards: [{
    id: "regeneration-card-1",
    order: 1,
    label: "镜头 #1",
    imagePrompt: "一只金毛犬在客厅发现主人回家，五格故事板。",
    videoPrompt: "金毛先迟疑，再冲向主人，镜头跟拍并在拥抱处停稳。",
    referenceImageUrls: [],
    imageStatus: "done",
    imageUrl: "https://media.story.test/old-image.png",
    imageValidatedAt: now,
    imageModelIdUsed: "img-gpt",
    imageModelNameUsed: "GPT Image A",
    videoStatus: "done",
    videoUrl: "https://media.story.test/old-video.mp4",
    videoProgress: 100,
    videoTaskModelId: "vid-alpha",
    videoStatusDetail: "旧视频已完成",
  }],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const imageBodies = [];
const videoBodies = [];
let imageCall = 0;
let videoCall = 0;

await page.addInitScript(({ token, payload }) => {
  localStorage.clear();
  localStorage.setItem("auth_token", token);
  localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(payload));
}, { token: session.token, payload: run });

await page.route(/\/api\/cover-models(?:\?|$)/u, (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ models: [
    { id: "img-gpt", name: "GPT Image Test", model_name: "gpt-image-test", provider: "openai", publicPrice: 0.1, supports_image_input: true, resolution_options: ["1K"], default_resolution: "1K" },
    { id: "img-gemini", name: "Gemini Image Test", model_name: "gemini-image-test", provider: "google", publicPrice: 0.2, supports_image_input: true, resolution_options: ["1K"], default_resolution: "1K" },
  ] }),
}));
await page.route(/\/api\/video\/models(?:\?|$)/u, (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ models: [
    { id: "vid-alpha", name: "Video Alpha", publicPrice: 0.6, durationSeconds: 10, minDuration: 10, maxDuration: 10, supportsImageInput: true, requiresImage: true, resolutionOptions: ["1080p"], defaultResolution: "1080p", aspectRatios: ["16:9"] },
    { id: "vid-beta", name: "Video Beta", publicPrice: 0.8, durationSeconds: 10, minDuration: 10, maxDuration: 10, supportsImageInput: true, requiresImage: true, resolutionOptions: ["1080p"], defaultResolution: "1080p", aspectRatios: ["16:9"] },
  ] }),
}));
await page.route("https://media.story.test/**", (route) => {
  if (route.request().url().endsWith(".png")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
  return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) });
});
await page.route("**/api/image/generate", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  imageBodies.push(body);
  imageCall += 1;
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (imageCall === 2) {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "图片通道临时不可用，请重试" }) });
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [{ url: `https://media.story.test/regenerated-${imageCall}.png` }] }) });
});
await page.route("**/api/image-workbench/persist", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: body.url }) });
});
await page.route("**/api/video/generate", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  videoBodies.push(body);
  videoCall += 1;
  await new Promise((resolve) => setTimeout(resolve, 250));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ task_id: `regen-task-${videoCall}`, model_id: body.model_id, status: "pending", message: "已接收重新生成任务" }),
  });
});
await page.route(/\/api\/video\/stream(?:\?|$)/u, async (route) => {
  const taskId = new URL(route.request().url()).searchParams.get("taskId");
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (taskId === "regen-task-4") {
    await route.fulfill({ status: 200, contentType: "text/event-stream; charset=utf-8", body: `event: progress\ndata: ${JSON.stringify({ status: "processing", progress: 35, message: "上游正在渲染视频" })}\n\n` });
    return;
  }
  const failed = taskId === "regen-task-2";
  const event = failed
    ? `event: failed\ndata: ${JSON.stringify({ status: "failed", errorMessage: "模型临时不可用，请重试" })}\n\n`
    : `event: completed\ndata: ${JSON.stringify({ status: "completed", videoUrl: `https://media.story.test/${taskId}.mp4`, progress: 100 })}\n\n`;
  await route.fulfill({ status: 200, contentType: "text/event-stream; charset=utf-8", body: event });
});
await page.route(/\/api\/video\/status(?:\?|$)/u, (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: "processing", progress: 50 }),
}));
await page.route("**/api/video/cancel", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ success: true, status: "cancelled", message: "任务已终止" }),
}));

try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "选择生图模型：Gemini Image A" }).waitFor({ timeout: 20_000 });
  const card = page.locator(".sbw-shot-card").first();

  await page.getByRole("button", { name: "选择生图模型：Gemini Image A" }).click();
  await card.getByRole("button", { name: "重新生图", exact: true }).click();
  await card.getByText("生成中", { exact: false }).first().waitFor({ timeout: 5_000 });
  assert.equal(await card.locator("video").count(), 0, "重新生图后不应继续显示旧视频");
  await card.getByText("图片完成", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(imageBodies.length, 1);
  assert.equal(imageBodies[0].modelId, "img-gemini", "重新生图没有使用新选择的模型");

  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  assert.equal(saved.cards[0].imageModelIdUsed, "img-gemini");
  assert.equal(saved.cards[0].videoStatus, "idle", "重新生图后旧视频状态没有失效");
  assert.equal(saved.cards[0].videoUrl, undefined, "重新生图后旧视频地址没有清空");
  const historyAfterImage = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]"));
  assert.ok(historyAfterImage.some((item) => item.title.includes("重新生图前") && item.cards[0].videoUrl?.includes("old-video")), "重新生图前快照未写入历史");

  await page.getByRole("button", { name: "选择生图模型：GPT Image A" }).click();
  await card.getByRole("button", { name: "重新生图", exact: true }).click();
  await card.getByText("图片通道临时不可用", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(imageBodies[1].modelId, "img-gpt", "生图失败分支没有使用新选择的模型");
  await page.getByRole("button", { name: "选择生图模型：Gemini Image A" }).click();
  await card.getByRole("button", { name: "重试生图", exact: true }).click();
  await card.getByText("图片完成", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(imageBodies[2].modelId, "img-gemini", "生图失败重试没有使用最新选择的模型");

  await page.getByRole("button", { name: "选择视频模型：Video Beta" }).click();
  await card.getByRole("button", { name: "生成视频", exact: true }).click();
  await card.getByText("排队中", { exact: false }).first().waitFor({ timeout: 5_000 });
  await card.getByText("视频完成", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(videoBodies[0].model_id, "vid-beta", "视频生成没有使用新选择的模型");

  await page.getByRole("button", { name: "选择视频模型：Video Alpha" }).click();
  await card.getByRole("button", { name: "重新生成", exact: true }).click();
  await card.getByText("排队中", { exact: false }).first().waitFor({ timeout: 5_000 });
  assert.equal(await card.locator("video").count(), 0, "视频重新生成时仍在播放旧结果");
  await card.getByText("模型临时不可用", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(videoBodies[1].model_id, "vid-alpha");

  await page.getByRole("button", { name: "选择视频模型：Video Beta" }).click();
  await card.getByRole("button", { name: "重试生成", exact: true }).click();
  await card.getByText("视频完成", { exact: false }).first().waitFor({ timeout: 15_000 });
  assert.equal(videoBodies[2].model_id, "vid-beta", "失败重试没有使用最新选择的视频模型");

  saved = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  assert.equal(saved.cards[0].videoStatus, "done");
  assert.ok(saved.cards[0].videoUrl.includes("regen-task-3"));
  const finalHistory = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]"));
  assert.ok(finalHistory.some((item) => item.title.includes("重新生成视频前")), "视频重新生成前快照未写入历史");

  await page.screenshot({ path: path.join(screenshotDir, "model-switch-regenerate-retry.png"), fullPage: true });

  await page.getByRole("button", { name: "选择视频模型：Video Alpha" }).click();
  await card.getByRole("button", { name: "重新生成", exact: true }).click();
  await card.getByRole("button", { name: "终止生成", exact: true }).waitFor({ timeout: 5_000 });
  await card.getByRole("button", { name: "重新生图", exact: true }).click();
  await page.getByText("请先终止视频任务再重新生图", { exact: false }).waitFor({ timeout: 5_000 });
  assert.equal(imageBodies.length, 3, "视频运行时不应允许重新生图破坏引用链");
  await card.getByRole("button", { name: "终止生成", exact: true }).click();
  await card.getByText("视频已终止", { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: path.join(screenshotDir, "active-video-blocks-image-regeneration.png"), fullPage: true });

  console.log(JSON.stringify({
    passed: true,
    imageRequests: imageBodies.map((body) => body.modelId),
    videoRequests: videoBodies.map((body) => body.model_id),
    finalStatus: saved.cards[0].videoStatus,
    historySnapshots: finalHistory.filter((item) => item.id.includes("storyboard-snapshot")).length,
    activeVideoImageGuard: "passed",
    paidCalls: 0,
    screenshotDir,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
