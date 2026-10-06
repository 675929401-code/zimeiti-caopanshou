import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const phase = process.env.PHASE || "images";
const reviewId = process.env.REVIEW_ID || "three-directors-golden-v53";
const sourceReviewId = process.env.SOURCE_REVIEW_ID || reviewId;
const imageModelId = process.env.IMAGE_MODEL_ID || "gpt-image-2-chA-2";
const videoModelId = process.env.VIDEO_MODEL_ID || "veo-3-1-fast-chC";
const requestedVideoDuration = Number(process.env.VIDEO_DURATION || 0);
const requestedVideoResolution = process.env.VIDEO_RESOLUTION || "";
const requestedImageResolution = process.env.IMAGE_RESOLUTION || "1K";
const requestedImageModelLabel = process.env.IMAGE_MODEL_LABEL || "";
const requestedVideoModelLabel = process.env.VIDEO_MODEL_LABEL || "";
const dryRun = process.env.DRY_RUN === "1";
const preserveSeededImageModel = process.env.PRESERVE_SEEDED_IMAGE_MODEL === "1";
const maxImageSubmissionsPerCard = Number(process.env.MAX_IMAGE_SUBMISSIONS_PER_CARD || 0);
const maxSuiteCards = Number(process.env.MAX_SUITE_CARDS || 3);
const suiteCardLimit = Number(process.env.SUITE_CARD_LIMIT || 0);
const suiteCardOffset = Number(process.env.SUITE_CARD_OFFSET || 0);
const seededFirstImageUrl = process.env.SEED_FIRST_IMAGE_URL || "";
const seededImageUrls = process.env.SEED_IMAGE_URLS_JSON
  ? JSON.parse(process.env.SEED_IMAGE_URLS_JSON)
  : [];
const runTitle = process.env.RUN_TITLE || "三导演同题真实验收｜金毛等待主人";
const suitePath = process.env.SUITE_PATH || ".tmp-e2e/storyboard-agent-suite-v53.json";
const reviewDir = path.resolve("public/storyboard-reviews");
const screenshotDir = path.resolve(".codex-screenshots");
const mediaDir = path.resolve(`.tmp-e2e/${reviewId}-media`);
await Promise.all([
  mkdir(reviewDir, { recursive: true }),
  mkdir(screenshotDir, { recursive: true }),
  mkdir(mediaDir, { recursive: true }),
]);

assert.ok(["images", "videos", "full"].includes(phase), `未知测试阶段：${phase}`);
const suiteSource = JSON.parse(await readFile(suitePath, "utf8"));
const suite = suiteCardLimit > 0 || suiteCardOffset > 0
  ? {
      ...suiteSource,
      agents: suiteSource.agents.slice(
        Math.max(0, suiteCardOffset),
        suiteCardLimit > 0 ? Math.max(0, suiteCardOffset) + suiteCardLimit : undefined,
      ),
    }
  : suiteSource;
assert.ok(
  suite.agents?.length >= 1 && suite.agents.length <= maxSuiteCards,
  `真实智能体输出组数必须为1至${maxSuiteCards}组`,
);

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
  return String(model.displayName || model.display_name || model.name || "通用模型");
}

const [imageModelName, videoModelName] = await Promise.all([
  resolvePublicModelName("/api/cover-models", imageModelId),
  resolvePublicModelName("/api/video/models", videoModelId),
]);

function userVisibleImageModelName(modelId, fallback) {
  if (/^gpt-image/i.test(modelId)) return "GPT Image A";
  if (/^(gemini|nano-banana)/i.test(modelId)) return "Gemini Image A";
  return fallback;
}

const imageModelLabel = requestedImageModelLabel || userVisibleImageModelName(imageModelId, imageModelName);
function userVisibleVideoModelName(value) {
  return String(value)
    .replace(/\s*·\s*渠道[A-Z0-9_-]+\s*$/i, "")
    .replace(/\s*渠道[A-Z0-9_-]+\s*$/i, "")
    .trim();
}

const videoModelLabel = requestedVideoModelLabel || userVisibleVideoModelName(videoModelName);

function createInitialRun() {
  const now = Date.now();
  return {
    id: `three-directors-${now.toString(36)}`,
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    imageResolution: requestedImageResolution,
    imageModelId,
    videoModelId,
    title: runTitle,
    ...(requestedVideoDuration > 0 ? { videoDuration: requestedVideoDuration } : {}),
    ...(requestedVideoResolution ? { videoResolution: requestedVideoResolution } : {}),
    cards: suite.agents.map((agent, index) => {
      const seededImageUrl = String(seededImageUrls[index] || (index === 0 ? seededFirstImageUrl : ""));
      const reuseImage = Boolean(seededImageUrl);
      return {
        id: `director-${index + 1}-${now.toString(36)}`,
        order: index + 1,
        label: agent.name,
        imagePrompt: agent.imagePrompt,
        videoPrompt: agent.videoPrompt,
        referenceImageUrls: [],
        imageStatus: reuseImage ? "done" : "idle",
        imageUrl: reuseImage ? seededImageUrl : undefined,
        imageValidatedAt: reuseImage ? now : undefined,
        imageModelIdUsed: reuseImage ? imageModelId : undefined,
        imageModelNameUsed: reuseImage ? imageModelLabel : undefined,
        videoStatus: "idle",
      };
    }),
  };
}

async function loadRun() {
  if ((phase === "images" || phase === "full") && !process.env.RESUME_REVIEW) return createInitialRun();
  const archive = JSON.parse(await readFile(path.join(reviewDir, `${sourceReviewId}.json`), "utf8"));
  assert.ok(archive.run?.cards?.length === suite.agents.length, "历史存档与当前导演卡片数量不一致");
  if (phase === "videos" || phase === "full") {
    assert.ok(archive.run.cards.every((card) => card.imageStatus === "done" && card.imageUrl), "视频阶段没有已完成故事板可复用");
  }
  return {
    ...archive.run,
    updatedAt: Date.now(),
    imageModelId,
    videoModelId,
    ...(requestedVideoDuration > 0 ? { videoDuration: requestedVideoDuration } : {}),
    ...(requestedVideoResolution ? { videoResolution: requestedVideoResolution } : {}),
    cards: archive.run.cards.map((card) => process.env.RESET_VIDEOS === "1"
      ? {
          ...card,
          videoStatus: "idle",
          videoUrl: undefined,
          videoError: undefined,
          videoTaskId: undefined,
          videoTaskModelId: undefined,
          videoContentUrl: undefined,
          videoProgress: undefined,
        }
      : { ...card }),
  };
}

const initialRun = await loadRun();
const expectedImageSubmissions = initialRun.cards.filter((card) => card.imageStatus === "idle" || card.imageStatus === "failed").length;
const expectedVideoSubmissions = initialRun.cards.filter((card) => card.videoStatus === "idle" || card.videoStatus === "failed").length;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1760, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
const imageSubmissions = [];
const videoSubmissions = [];
const generationFailures = [];
const blockedDuplicateImageSubmissions = [];
const startedAt = Date.now();
let currentPhase = "boot";
let currentRun = initialRun;
let selectedPublicImageModelId = imageModelId;
let selectedPublicVideoModelId = videoModelId;

page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("request", (request) => {
  if (request.method() !== "POST") return;
  const record = { at: Date.now(), body: request.postDataJSON?.() || null };
  if (request.url().includes("/api/image/generate")) imageSubmissions.push(record);
  if (request.url().includes("/api/video/generate")) videoSubmissions.push(record);
});
page.on("response", async (response) => {
  const request = response.request();
  if (request.method() !== "POST" || response.ok()) return;
  const kind = request.url().includes("/api/image/generate")
    ? "image"
    : request.url().includes("/api/video/generate")
      ? "video"
      : null;
  if (!kind) return;

  let body = "";
  try {
    body = await response.text();
  } catch (error) {
    body = `响应正文读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
  generationFailures.push({
    at: Date.now(),
    kind,
    status: response.status(),
    url: request.url(),
    body: body.slice(0, 2_000),
  });
});

if (maxImageSubmissionsPerCard > 0) {
  const submissionCounts = new Map();
  await page.route("**/api/image/generate", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataJSON?.() || {};
    const cardKey = String(body.clientNodeId || body.clientTraceId || "unknown-card");
    const nextCount = (submissionCounts.get(cardKey) || 0) + 1;
    submissionCounts.set(cardKey, nextCount);
    if (nextCount <= maxImageSubmissionsPerCard) return route.continue();
    blockedDuplicateImageSubmissions.push({ at: Date.now(), cardKey, attemptedCount: nextCount });
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "验收门禁已阻止同一卡片的自动付费重试" }),
    });
  });
}

await page.addInitScript(({ token, run }) => {
  localStorage.setItem("auth_token", token);
  const seedKey = `storyboard_live_review_seeded:${run.id}`;
  if (sessionStorage.getItem(seedKey) === "1") return;
  localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(run));
  localStorage.setItem("storyboard_prompt_workbench_history_v2", JSON.stringify([run]));
  sessionStorage.setItem(seedKey, "1");
}, { token: session.token, run: initialRun });

async function readRun() {
  return page.evaluate(() => {
    const value = localStorage.getItem("storyboard_prompt_workbench_current_v2");
    return value ? JSON.parse(value) : null;
  });
}

async function archive(status, error = null) {
  currentRun = await readRun().catch(() => currentRun) || currentRun;
  const payload = {
    reviewId,
    status,
    phase: currentPhase,
    testedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    sourceSuite: suitePath,
    sourceText: suite.submittedMessage,
    imageModelId,
    videoModelId,
    selectedPublicImageModelId,
    selectedPublicVideoModelId,
    agentOrder: suite.agents.map((agent, index) => ({ order: index + 1, id: agent.id, name: agent.name })),
    submissions: {
      images: imageSubmissions.map((item) => ({
        at: item.at,
        modelId: item.body?.modelId,
        aspectRatio: item.body?.aspectRatio,
        resolution: item.body?.resolution,
      })),
      videos: videoSubmissions.map((item) => ({ at: item.at, modelId: item.body?.model_id, imageUrl: item.body?.image_url, duration: item.body?.duration })),
    },
    browserErrors,
    consoleErrors,
    generationFailures,
    blockedDuplicateImageSubmissions,
    error: error ? String(error.message || error) : null,
    run: currentRun,
  };
  await writeFile(path.join(reviewDir, `${reviewId}.json`), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(`.tmp-e2e/${reviewId}-result.json`, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function saveScreenshot(label) {
  await page.screenshot({ path: path.join(screenshotDir, `${reviewId}-${label}.png`), fullPage: true });
}

async function waitForCards(kind, timeoutMs) {
  const statusKey = kind === "image" ? "imageStatus" : "videoStatus";
  const errorKey = kind === "image" ? "imageError" : "videoError";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const transportFailure = generationFailures.find((failure) => failure.kind === kind);
    if (transportFailure) {
      throw new Error(
        `${kind === "image" ? "图片" : "视频"}生成接口 ${transportFailure.status}：${transportFailure.body || "未返回错误正文"}`,
      );
    }
    const run = await readRun();
    if (run?.cards?.some((card) => card[statusKey] === "failed")) {
      const failures = run.cards
        .filter((card) => card[statusKey] === "failed")
        .map((card) => `卡片${card.order}：${card[errorKey] || "未知失败"}`)
        .join("；");
      throw new Error(failures);
    }
    if (run?.cards?.length === suite.agents.length && run.cards.every((card) => card[statusKey] === "done")) return run;
    await archive(`${kind}-running`);
    await page.waitForTimeout(8_000);
  }
  throw new Error(`${kind === "image" ? "图片" : "视频"}生成等待超时`);
}

async function downloadMedia(url, filename, taskId = "") {
  const absolute = url.startsWith("object://")
    ? `${baseUrl}/api/video/storage/${encodeURIComponent(taskId)}`
    : url.startsWith("http")
      ? url
      : `${baseUrl}${url}`;
  if (url.startsWith("object://")) {
    assert.ok(taskId, `${filename}缺少长期存储任务ID`);
  }
  let response = await fetch(absolute, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!response.ok) {
    const proxy = new URL("/api/video/proxy-download", baseUrl);
    proxy.searchParams.set("url", absolute);
    proxy.searchParams.set("name", filename);
    proxy.searchParams.set("token", session.token);
    response = await fetch(proxy, { headers: { Authorization: `Bearer ${session.token}` } });
  }
  assert.ok(response.ok, `${filename}下载失败（${response.status}）`);
  await writeFile(path.join(mediaDir, filename), Buffer.from(await response.arrayBuffer()));
}

let caughtError = null;
try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle", timeout: 45_000 });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), suite.agents.length, "工作台没有载入全部导演卡片");
  if (preserveSeededImageModel) {
    const activeImageModel = page.locator(`button[aria-label="选择生图模型：${imageModelLabel}"].is-active`);
    assert.equal(await activeImageModel.count(), 1, `工作台没有按内部ID激活生图模型：${imageModelId}`);
  } else {
    await page.getByRole("button", { name: `选择生图模型：${imageModelLabel}`, exact: true }).first().click();
  }
  if (phase === "videos" || phase === "full") {
    await page.getByRole("button", { name: new RegExp(`^选择视频模型：${videoModelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  }
  if (requestedVideoResolution) {
    const resolutionSelect = page.getByRole("combobox", { name: "视频分辨率" });
    if (await resolutionSelect.count()) await resolutionSelect.selectOption(requestedVideoResolution);
  }
  if (requestedVideoDuration > 0) {
    const durationSelect = page.getByRole("combobox", { name: "视频时长" });
    if (await durationSelect.count()) await durationSelect.selectOption(String(requestedVideoDuration));
  }
  await page.waitForTimeout(250);
  currentRun = await readRun();
  selectedPublicImageModelId = currentRun.imageModelId;
  selectedPublicVideoModelId = currentRun.videoModelId;
  assert.equal(currentRun.videoDuration, requestedVideoDuration || currentRun.videoDuration, "用户端实际视频时长与验收目标不一致");
  assert.equal(currentRun.imageResolution, requestedImageResolution, "用户端实际图片清晰度与验收目标不一致");
  if (requestedVideoResolution) assert.equal(currentRun.videoResolution, requestedVideoResolution, "用户端实际视频清晰度与验收目标不一致");
  await saveScreenshot("prompts-ready");

  if (dryRun) {
    const payload = await archive("ready");
    console.log(JSON.stringify({ passed: true, dryRun: true, reviewId, run: payload.run }, null, 2));
    await browser.close();
    process.exit(0);
  }

  if (phase === "images" || phase === "full") {
    currentPhase = "images";
    await page.getByRole("button", { name: "批量生图", exact: true }).click();
    currentRun = await waitForCards("image", 720_000);
    assert.equal(imageSubmissions.length, expectedImageSubmissions, "真实批量生图提交次数与待生成卡片不一致");
    assert.equal(blockedDuplicateImageSubmissions.length, 0, "检测到同一卡片自动重试，已在付费接口前拦截");
    assert.ok(imageSubmissions.every((item) => item.body?.modelId === selectedPublicImageModelId), "实际生图模型与左栏选择不一致");
    assert.ok(imageSubmissions.every((item) => item.body?.resolution === requestedImageResolution), "实际生图清晰度与验收目标不一致");
    await archive("images-complete");
    await saveScreenshot("images-complete");
    for (const card of currentRun.cards) {
      await downloadMedia(card.imageUrl, `${String(card.order).padStart(2, "0")}-${suite.agents[card.order - 1].name.replaceAll("｜", "-")}.png`);
    }
  }

  if (phase === "videos" || phase === "full") {
    currentPhase = "videos";
    if (expectedVideoSubmissions > 0) {
      const videoButton = page.getByRole("button", { name: "批量视频", exact: true });
      assert.equal(await videoButton.isDisabled(), false, "三张图片完成后批量视频仍未解锁");
      await videoButton.click();
      currentRun = await waitForCards("video", 1_800_000);
    } else {
      currentRun = await readRun();
      assert.ok(currentRun.cards.every((card) => card.videoStatus === "done" && card.videoUrl), "历史成品恢复不完整");
    }
    assert.equal(videoSubmissions.length, expectedVideoSubmissions, "真实批量视频提交次数与待生成卡片不一致");
    assert.ok(videoSubmissions.every((item) => item.body?.model_id === selectedPublicVideoModelId && item.body?.image_url), "视频没有逐卡使用所选模型与刚生成故事板");
    await archive("passed");
    await saveScreenshot("videos-complete");
    for (const card of currentRun.cards) {
      await downloadMedia(
        card.videoUrl,
        `${String(card.order).padStart(2, "0")}-${suite.agents[card.order - 1].name.replaceAll("｜", "-")}.mp4`,
        card.videoTaskId,
      );
    }
  }

  const status = phase === "images" ? "images-complete" : "passed";
  const payload = await archive(status);
  console.log(JSON.stringify({
    passed: true,
    phase,
    status,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    mediaDir,
    elapsedSeconds: payload.elapsedSeconds,
    cards: payload.run.cards.map((card) => ({
      order: card.order,
      imageStatus: card.imageStatus,
      imageUrl: card.imageUrl,
      videoStatus: card.videoStatus,
      videoUrl: card.videoUrl,
    })),
    browserErrors,
    consoleErrors,
  }, null, 2));
} catch (error) {
  caughtError = error;
  await saveScreenshot("failed").catch(() => {});
  await archive("failed", error).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

if (caughtError) throw caughtError;
