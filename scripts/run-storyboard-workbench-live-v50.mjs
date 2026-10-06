import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = process.env.REVIEW_ID || "storyboard-v50-live";
const imageModelId = process.env.IMAGE_MODEL_ID || "gpt-image-2-chA-2";
const videoModelId = process.env.VIDEO_MODEL_ID || "omni-flash-10s-1080p-ch3";
const resumeFromReview = process.env.RESUME_FROM_REVIEW?.trim() || "";
const screenshotDir = path.resolve(".codex-screenshots");
const reviewDir = path.resolve("public/storyboard-reviews");
await mkdir(screenshotDir, { recursive: true });
await mkdir(reviewDir, { recursive: true });

const suite = JSON.parse(await readFile(".tmp-e2e/storyboard-agent-suite-v50.json", "utf8"));
const source = suite.agents.find((agent) => agent.name === "故事版导演｜高能夸张");
assert.ok(source?.imagePrompt && source?.videoPrompt, "没有找到高能夸张智能体的真实双Prompt输出");

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

async function resolvePublicModelName(endpoint, modelId) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const payload = await response.json();
  assert.ok(response.ok, payload.error || `模型列表读取失败：${endpoint}`);
  const model = payload.models?.find((item) => item.id === modelId);
  assert.ok(model, `模型未在公开列表中找到：${modelId}`);
  return String(model.display_name || model.name || "通用模型");
}

const [imageModelName, videoModelName] = await Promise.all([
  resolvePublicModelName("/api/cover-models", imageModelId),
  resolvePublicModelName("/api/video/models", videoModelId),
]);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
const startedAt = Date.now();
let phase = "boot";
let run = null;
let caughtError = null;

page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
let resumeRun = null;
if (resumeFromReview) {
  const previous = JSON.parse(await readFile(path.join(reviewDir, `${resumeFromReview}.json`), "utf8"));
  resumeRun = previous.run || null;
  assert.ok(resumeRun?.cards?.[0]?.imageUrl, `存档${resumeFromReview}没有可复用的故事板图片`);
  resumeRun.id = `storyboard-run-resume-${Date.now().toString(36)}`;
  resumeRun.title = "三卡一核v5.0｜零食与离别信号｜视频链路修复复测";
  resumeRun.videoModelId = videoModelId;
  resumeRun.updatedAt = Date.now();
  resumeRun.cards = resumeRun.cards.map((card, index) => index === 0 ? {
    ...card,
    videoStatus: "idle",
    videoUrl: undefined,
    videoError: undefined,
    videoTaskId: undefined,
    videoTaskModelId: undefined,
    videoContentUrl: undefined,
    videoProgress: undefined,
  } : card);
}

await page.addInitScript(({ token, resume }) => {
  localStorage.clear();
  localStorage.setItem("auth_token", token);
  if (resume) localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(resume));
}, { token: session.token, resume: resumeRun });

async function saveSnapshot(label) {
  await page.screenshot({
    path: path.join(screenshotDir, `storyboard-v50-live-${label}.png`),
    fullPage: true,
  });
}

async function readRun() {
  return page.evaluate(() => {
    const raw = localStorage.getItem("storyboard_prompt_workbench_current_v2");
    return raw ? JSON.parse(raw) : null;
  });
}

async function archive(status, error) {
  run = await readRun().catch(() => run);
  if (run) {
    run.title = "三卡一核v5.0｜零食与离别信号｜高能夸张实片";
    run.updatedAt = Date.now();
  }
  const archivePayload = {
    reviewId,
    status,
    testedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    sourceAgent: source.name,
    sourceReport: ".tmp-e2e/storyboard-agent-suite-v50.json",
    imageModelId,
    videoModelId,
    phase,
    error: error ? String(error.message || error) : null,
    browserErrors,
    consoleErrors,
    run,
  };
  await writeFile(
    path.join(reviewDir, `${reviewId}.json`),
    JSON.stringify(archivePayload, null, 2),
    "utf8",
  );
  await writeFile(
    ".tmp-e2e/storyboard-v50-live-result.json",
    JSON.stringify(archivePayload, null, 2),
    "utf8",
  );
}

try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  const firstCard = page.locator(".sbw-shot-card").first();
  const textareas = firstCard.locator("textarea");
  if (!resumeRun) {
    await textareas.nth(0).fill(source.imagePrompt);
    await textareas.nth(1).fill(source.videoPrompt);
  }
  await page.getByRole("button", { name: `选择生图模型：${imageModelName}`, exact: true }).click();
  await page.getByRole("button", { name: `选择视频模型：${videoModelName}`, exact: true }).click();
  await saveSnapshot("prompts-ready");

  if (!resumeRun) {
    phase = "image-running";
    await firstCard.getByRole("button", { name: "生成图片" }).click();
    await Promise.race([
      firstCard.getByText("图 已完成").waitFor({ timeout: 360_000 }),
      firstCard.getByText("图 失败").waitFor({ timeout: 360_000 }).then(async () => {
        const error = await firstCard.locator(".sbw-error-line").first().innerText().catch(() => "故事板图片生成失败");
        throw new Error(error);
      }),
    ]);
    phase = "image-done";
    await saveSnapshot("image-done");
  } else {
    phase = "image-reused";
  }

  const imageUrl = await firstCard.locator(".sbw-image-frame img").getAttribute("src");
  assert.ok(imageUrl && /^https?:\/\//u.test(imageUrl), "故事板没有得到公网图片URL");
  const videoButton = firstCard.getByRole("button", { name: "生成视频" });
  assert.equal(await videoButton.isDisabled(), false, "图片完成后视频按钮仍未解锁");

  phase = "video-running";
  await videoButton.click();
  await Promise.race([
    firstCard.getByText("视频 已完成").waitFor({ timeout: 960_000 }),
    firstCard.getByText("视频 失败").waitFor({ timeout: 960_000 }).then(async () => {
      const error = await firstCard.locator(".sbw-error-line").last().innerText().catch(() => "视频生成失败");
      throw new Error(error);
    }),
  ]);
  phase = "video-done";
  await saveSnapshot("video-done");

  const videoUrl = await firstCard.locator("video").getAttribute("src");
  assert.ok(videoUrl && (/^https?:\/\//u.test(videoUrl) || /^\/api\/video\//u.test(videoUrl)), "视频没有得到可播放结果URL");
  run = await readRun();
  await archive("passed", null);
  console.log(JSON.stringify({
    passed: true,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    imageUrl,
    videoUrl,
    imageModelId,
    videoModelId,
    browserErrors,
    consoleErrors,
  }, null, 2));
} catch (error) {
  caughtError = error;
  await saveSnapshot("failed").catch(() => {});
  await archive("failed", error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

if (caughtError) throw caughtError;
