import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = process.env.REVIEW_ID || "high-energy-pixar-v66-live-20260815-1";
const sourceSuite = process.env.SOURCE_SUITE
  || ".tmp-e2e/high-energy-six-segments-pixar-v66-20260815-1-suite.json";
const sourceIndex = Number(process.env.SOURCE_INDEX || 0);
const imageModelId = process.env.IMAGE_MODEL_ID || "gpt-image-2-chA-2";
const videoModelId = process.env.VIDEO_MODEL_ID || "omni-flash-10s-1080p-ch3";
const videoDuration = String(process.env.VIDEO_DURATION || "10");
const videoPromptOverride = process.env.VIDEO_PROMPT_OVERRIDE?.trim() || "";
const imageOnly = process.env.IMAGE_ONLY === "1";
const resumeFromReview = process.env.RESUME_FROM_REVIEW?.trim() || "";
const screenshotDir = path.resolve(".codex-screenshots");
const reviewDir = path.resolve("public/storyboard-reviews");
const resultFile = path.resolve(".tmp-e2e", `${reviewId}-result.json`);
const screenshotPrefix = reviewId.replace(/[^a-zA-Z0-9_-]/gu, "-");

await mkdir(screenshotDir, { recursive: true });
await mkdir(reviewDir, { recursive: true });
await mkdir(path.dirname(resultFile), { recursive: true });

const suite = JSON.parse(await readFile(sourceSuite, "utf8"));
const sourceItems = Array.isArray(suite.agents) ? suite.agents : suite.cases;
const source = sourceItems?.[sourceIndex];
assert.ok(source?.imagePrompt && source?.videoPrompt, `智能体输出不存在：${sourceSuite}#${sourceIndex}`);
const imageResolution = String(process.env.IMAGE_RESOLUTION || "").trim();
const expectedImageWidth = Number(process.env.EXPECTED_IMAGE_WIDTH || 0);
const expectedImageHeight = Number(process.env.EXPECTED_IMAGE_HEIGHT || 0);

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

async function resolvePublicModel(endpoint, modelId) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const payload = await response.json();
  assert.ok(response.ok, payload.error || `模型列表读取失败：${endpoint}`);
  const model = payload.models?.find((item) => item.id === modelId);
  assert.ok(model, `模型未在公开列表中找到：${modelId}`);
  return {
    id: modelId,
    name: String(model.displayName || model.display_name || model.name || "通用模型"),
  };
}

const imageModel = await resolvePublicModel("/api/cover-models", imageModelId);
const videoModel = imageOnly ? null : await resolvePublicModel("/api/video/models", videoModelId);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
const startedAt = Date.now();
let phase = "boot";
let run = null;
let caughtError = null;
let imageEvidence = null;

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
    path: path.join(screenshotDir, `${screenshotPrefix}-${label}.png`),
    fullPage: true,
  });
}

async function readRun() {
  return page.evaluate(() => {
    const raw = localStorage.getItem("storyboard_prompt_workbench_current_v2");
    return raw ? JSON.parse(raw) : null;
  });
}

async function waitForCardStatus(kind, timeout) {
  await page.waitForFunction(({ statusKey, errorKey }) => {
    const raw = localStorage.getItem("storyboard_prompt_workbench_current_v2");
    if (!raw) return false;
    const card = JSON.parse(raw).cards?.[0];
    if (card?.[errorKey]) throw new Error(card[errorKey]);
    return card?.[statusKey] === "done" || card?.[statusKey] === "failed";
  }, {
    statusKey: `${kind}Status`,
    errorKey: `${kind}Error`,
  }, { timeout });
  const current = await readRun();
  const card = current?.cards?.[0];
  assert.equal(card?.[`${kind}Status`], "done", card?.[`${kind}Error`] || `${kind}生成失败`);
}

async function archive(status, error) {
  run = await readRun().catch(() => run);
  if (run) {
    run.title = suite.runId?.includes("semantic-vnext")
      ? `语义泛化vNext｜${source.kind || source.name || suite.agentName}｜平台智能体真实输出`
      : "皮克斯3D跨图视频风格锁v6.7｜高能夸张｜平台智能体真实输出";
    run.updatedAt = Date.now();
  }
  const archivePayload = {
    reviewId,
    status,
    testedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    sourceAgent: source.name || source.kind || suite.agentName,
    sourceConversationId: suite.conversationId || null,
    sourceReport: sourceSuite,
    imageModelId,
    imageResolution: imageResolution || null,
    videoModelId,
    videoDuration: Number(videoDuration),
    imageOnly,
    resumeFromReview: resumeFromReview || null,
    phase,
    error: error ? String(error.message || error) : null,
    browserErrors,
    consoleErrors,
    imageEvidence,
    run,
  };
  const payload = JSON.stringify(archivePayload, null, 2);
  await writeFile(path.join(reviewDir, `${reviewId}.json`), payload, "utf8");
  await writeFile(resultFile, payload, "utf8");
}

try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  const firstCard = page.locator(".sbw-shot-card").first();
  const textareas = firstCard.locator("textarea");
  await textareas.nth(0).fill(source.imagePrompt);
  await textareas.nth(1).fill(videoPromptOverride || source.videoPrompt);
  const imageModelButton = page.getByRole("button", { name: `选择生图模型：${imageModel.name}`, exact: true });
  const isOmniFlash = videoModelId.includes("omni-flash-10s") || /Omni Flash/u.test(videoModel?.name || "");
  const omniResolution = videoModelId.includes("720p") || /720p/u.test(videoModel?.name || "") ? "720p" : "1080p";
  let videoModelButton = isOmniFlash
    ? page.locator(".sbw-video-model-list button").filter({ hasText: new RegExp(`Omni Flash.*10秒.*${omniResolution}`, "u") }).first()
    : page.getByRole("button", { name: `选择视频模型：${videoModel?.name || ""}`, exact: true });
  if (videoModelId === "grok-imagine-video-1-5-preview-chA") {
    videoModelButton = page.locator(".sbw-video-model-list button").filter({ hasText: /Grok Imagine Video 1\.5 Preview/u }).first();
  }
  if (videoModelId === "grok-imagine-video-1-5-fast-chA") {
    videoModelButton = page.locator(".sbw-video-model-list button").filter({ hasText: /Grok Imagine Video 1\.5 Fast/u }).first();
  }
  if (videoModelId === "grok-imagine-image-pro-10s-ch4") {
    videoModelButton = page.locator(".sbw-video-model-list button").filter({ hasText: /Grok Imagine Image Pro/u }).first();
  }
  if (videoModelId === "minimax-h3-chA") {
    videoModelButton = page.locator(".sbw-video-model-list button").filter({ hasText: /MiniMax H3/u }).first();
  }
  if (videoModelId === "veo-3-1-fast-chC") {
    videoModelButton = page.locator(".sbw-video-model-list button").filter({ hasText: /Veo 3\.1 Fast/u }).first();
  }
  await imageModelButton.click();
  if (!imageOnly) await videoModelButton.click();

  const imageResolutionSelect = page.locator('select[aria-label="图片分辨率"]');
  if (imageResolution) {
    assert.equal(await imageResolutionSelect.count(), 1, "目标生图模型没有暴露图片分辨率选择器");
    await imageResolutionSelect.selectOption(imageResolution);
    assert.equal(await imageResolutionSelect.inputValue(), imageResolution, "图片分辨率未锁定到指定值");
  }

  const durationSelect = page.locator('select[aria-label="视频时长"]');
  if (await durationSelect.count()) {
    await durationSelect.selectOption(videoDuration);
  }
  await saveSnapshot("prompts-ready");

  if (!resumeRun) {
    phase = "image-running";
    await firstCard.getByRole("button", { name: "生成图片" }).click();
    await waitForCardStatus("image", 420_000);
    phase = "image-done";
    await saveSnapshot("image-done");
  } else {
    phase = "image-reused";
  }

  const imageUrl = await firstCard.locator(".sbw-image-frame img").getAttribute("src");
  assert.ok(imageUrl && /^https?:\/\//u.test(imageUrl), "故事板没有得到公网图片URL");
  const imageResponse = await fetch(imageUrl);
  assert.ok(imageResponse.ok, `故事板图片下载失败：HTTP ${imageResponse.status}`);
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  let actualWidth = null;
  let actualHeight = null;
  if (imageBuffer.length >= 24 && imageBuffer.subarray(1, 4).toString("ascii") === "PNG") {
    actualWidth = imageBuffer.readUInt32BE(16);
    actualHeight = imageBuffer.readUInt32BE(20);
  }
  if (expectedImageWidth > 0) assert.equal(actualWidth, expectedImageWidth, "真实图片宽度不符合验收基线");
  if (expectedImageHeight > 0) assert.equal(actualHeight, expectedImageHeight, "真实图片高度不符合验收基线");
  const imageEvidencePath = path.resolve(".tmp-e2e", `${reviewId}-image.png`);
  await writeFile(imageEvidencePath, imageBuffer);
  imageEvidence = {
    localPath: path.relative(process.cwd(), imageEvidencePath).replaceAll("\\", "/"),
    contentType: imageResponse.headers.get("content-type") || null,
    bytes: imageBuffer.length,
    width: actualWidth,
    height: actualHeight,
  };
  if (imageOnly) {
    phase = "image-reviewed";
    await archive("image-passed", null);
    console.log(JSON.stringify({
      passed: true,
      imageOnly: true,
      reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      imageUrl,
      imageModelId,
      imageResolution: imageResolution || null,
      imageEvidence,
      browserErrors,
      consoleErrors,
    }, null, 2));
  } else {
    const videoButton = firstCard.getByRole("button", { name: "生成视频" });
    assert.equal(await videoButton.isDisabled(), false, "图片完成后视频按钮仍未解锁");
    if (await durationSelect.count()) {
      await durationSelect.selectOption(videoDuration);
    }
    phase = "video-running";
    await videoButton.click();
    await waitForCardStatus("video", 1_200_000);
    phase = "video-done";
    await saveSnapshot("video-done");

    const videoUrl = await firstCard.locator("video").getAttribute("src");
    assert.ok(videoUrl && (/^https?:\/\//u.test(videoUrl) || /^\/api\/video\//u.test(videoUrl)), "视频没有得到可播放结果URL");
    await archive("passed", null);
    console.log(JSON.stringify({
      passed: true,
      reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      imageUrl,
      videoUrl,
      imageModelId,
      videoModelId,
      videoDuration: Number(videoDuration),
      browserErrors,
      consoleErrors,
    }, null, 2));
  }
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
