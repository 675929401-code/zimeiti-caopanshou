#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9) || "";
const projectId = process.argv.find((value) => value.startsWith("--project-id="))?.slice(13)
  || "storyboard-snapshot-muw0cdrd-phxsmw";
const execute = process.argv.includes("--execute");
const maxPublicPrice = Number(process.argv.find((value) => value.startsWith("--max-public-price="))?.slice(19) || "0");
const expectedImagePromptSha256 = "f0539997ebef1b8d609962ba64c0db9af8d78c9591ea8d0bd6968d14580f49c5";
const sourceEvidenceDir = path.resolve(".codex-evidence/model-chain-audit-20261006/pet-high-energy-platform-ui-e2e/pet-high-energy-ui-execute-r851-20261006a");
const outputDir = path.resolve(".codex-evidence/model-chain-audit-20261006/pet-gpt25-omni-platform-ui-e2e", runId || "invalid");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
assert.match(projectId, /^storyboard-(?:run|snapshot)-[A-Za-z0-9_-]+$/u, "STORYBOARD_PROJECT_ID_REQUIRED");
assert.ok(Number.isFinite(maxPublicPrice) && maxPublicPrice > 0, "POSITIVE_PUBLIC_PRICE_CAP_REQUIRED");

const authHeaders = { Authorization: `Bearer ${token}` };
async function requestJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: authHeaders,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body?.error || `${pathname}:${response.status}`);
  return body;
}

async function assertCurrentRuntime() {
  const version = await requestJson("/api/version");
  const diskBuildId = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
  const source = JSON.parse(await fs.readFile(path.resolve("public/version.json"), "utf8"));
  assert.equal(version.buildId, diskBuildId, "CURRENT_RUNTIME_BUILD_ID_STALE");
  assert.equal(version.sourceVersion, source.sourceVersion, "CURRENT_RUNTIME_SOURCE_VERSION_STALE");
  const fingerprint = spawnSync(process.execPath, ["scripts/local-build-fingerprint.mjs", "verify", process.cwd()], { encoding: "utf8" });
  assert.equal(fingerprint.status, 0, `CURRENT_RUNTIME_SOURCE_FINGERPRINT_STALE:${fingerprint.stderr || fingerprint.stdout}`);
  return { sourceVersion: version.sourceVersion, buildId: version.buildId, runningLatest: true };
}

function extractFirstPlatformVideoPrompt(visibleOutput) {
  const afterHeading = String(visibleOutput).split("视频提示词：")[1] || "";
  const beforeImagePrompt = afterHeading.split("生图提示词：")[0] || "";
  const prompt = beforeImagePrompt
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => !/^(?:TEXT|发送|推送图片)$/u.test(line.trim()))
    .join("\n")
    .trim();
  assert.ok(prompt.length > 300, "PLATFORM_VIDEO_PROMPT_NOT_FOUND");
  assert.match(prompt, /0-2\.2s/u, "PLATFORM_VIDEO_TIMELINE_MISSING");
  assert.match(prompt, /5\.5-8s/u, "PLATFORM_VIDEO_END_BEAT_MISSING");
  return prompt;
}

function priceFromText(text) {
  const match = String(text || "").match(/¥\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*次/u);
  return match ? Number(match[1]) : Number.NaN;
}

async function createAuthenticatedContext(browser, identity) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "storyboard-workbench");
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

async function openSavedProject(page) {
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".sbw-image-model-list button[data-model-id]").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
  const drawer = page.getByRole("complementary", { name: "分镜工作台历史" });
  await drawer.waitFor({ state: "visible", timeout: 30_000 });
  const project = drawer.locator(`[data-storyboard-project-id="${projectId}"]`);
  await project.waitFor({ state: "visible", timeout: 45_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await project.getByRole("button", { name: "打开任务", exact: true }).click();
  await drawer.waitFor({ state: "hidden", timeout: 30_000 });
  const cards = page.locator("article.sbw-shot-card");
  await cards.last().waitFor({ state: "visible", timeout: 30_000 });
  return { cards, card: cards.last() };
}

async function inspectGpt25Source(page, card) {
  const image = card.locator(".sbw-image-frame img").first();
  await image.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll("article.sbw-shot-card .sbw-image-frame img")];
    const target = images.at(-1);
    return target instanceof HTMLImageElement && target.complete && target.naturalWidth > 0 && target.naturalHeight > 0;
  }, undefined, { timeout: 60_000 });
  const rendered = await image.evaluate((node) => ({
    complete: node.complete,
    width: node.naturalWidth,
    height: node.naturalHeight,
    srcPresent: Boolean(node.currentSrc || node.src),
  }));
  const selectedImageModel = page.locator(".sbw-image-model-list button.is-active[data-model-id]").first();
  const selectedImageModelText = (await selectedImageModel.innerText()).replace(/\s+/gu, " ").trim();
  assert.match(selectedImageModelText, /GPT-Image-2\.5\s+Sunburst/iu, `EXPECTED_GPT25_SOURCE_IMAGE:${selectedImageModelText}`);
  const imagePrompt = await card.locator('textarea[aria-label$="生图提示词"]').inputValue();
  assert.equal(sha256(imagePrompt), expectedImagePromptSha256, "GPT25_IMAGE_PROMPT_HASH_MISMATCH");
  assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0 && rendered.srcPresent, "GPT25_SOURCE_IMAGE_NOT_RENDERED");
  return {
    selectedImageModelId: await selectedImageModel.getAttribute("data-model-id"),
    selectedImageModelText,
    imagePromptCharacters: imagePrompt.length,
    imagePromptSha256: sha256(imagePrompt),
    rendered,
  };
}

async function waitForTerminalVideoCard(page, card, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const snapshot = await card.evaluate((node) => ({
      text: (node.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 3000),
      state: node.getAttribute("data-card-state") || "",
      hasVideo: Boolean(node.querySelector("video")),
      videoError: node.querySelector(".sbw-error-line")?.textContent?.trim() || "",
    }));
    if (snapshot.hasVideo || /视频已完成|视频完成/u.test(snapshot.text)) return { terminal: "completed", snapshot };
    if (snapshot.videoError || /生成失败|状态待确认|未扣费/u.test(snapshot.text)) return { terminal: "failed", snapshot };
    if (Date.now() - startedAt > timeoutMs) return { terminal: "timeout_unknown", snapshot };
    await page.waitForTimeout(2_000);
  }
}

await fs.mkdir(path.dirname(outputDir), { recursive: true });
await fs.mkdir(outputDir, { recursive: false });
const runtime = await assertCurrentRuntime();
const identity = await requestJson("/api/auth/me");
assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");
const platformOutput = await fs.readFile(path.join(sourceEvidenceDir, "platform-high-energy-visible-output.txt"), "utf8");
const videoPrompt = extractFirstPlatformVideoPrompt(platformOutput);
const report = {
  schemaVersion: 1,
  runId,
  mode: execute ? "execute" : "plan",
  status: "running",
  startedAt: new Date().toISOString(),
  runtime,
  projectId,
  source: {
    kind: "saved-platform-agent-output",
    file: path.relative(process.cwd(), path.join(sourceEvidenceDir, "platform-high-energy-visible-output.txt")),
    videoPromptCharacters: videoPrompt.length,
    videoPromptSha256: sha256(videoPrompt),
    authoredByHarness: false,
  },
  directGenerationApiCallsByHarness: 0,
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await createAuthenticatedContext(browser, identity);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500)); });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 500)));
  const opened = await openSavedProject(page);
  assert.equal(await opened.cards.count(), 4, "SAVED_PLATFORM_PROJECT_CARD_COUNT_MISMATCH");
  const sourceImage = await inspectGpt25Source(page, opened.card);
  const omniButton = page.locator(".sbw-video-model-list button[data-model-id]").filter({ hasText: "Omni Flash" });
  assert.equal(await omniButton.count(), 1, "OMNI_FLASH_MODEL_NOT_UNIQUE");
  const omniText = (await omniButton.innerText()).replace(/\s+/gu, " ").trim();
  const omniModelId = String(await omniButton.getAttribute("data-model-id") || "");
  const publicPrice = priceFromText(omniText);
  assert.equal(await omniButton.getAttribute("data-model-selectable"), "true", "OMNI_FLASH_NOT_SELECTABLE");
  assert.match(omniText, /10秒/u, "OMNI_FLASH_10_SECONDS_REQUIRED");
  assert.match(omniText, /720P\/1080P/iu, "OMNI_FLASH_1080P_REQUIRED");
  assert.ok(Number.isFinite(publicPrice) && publicPrice > 0 && publicPrice <= maxPublicPrice + 0.000001, `OMNI_PUBLIC_PRICE_EXCEEDS_CAP:${publicPrice}`);
  report.plan = {
    cardCount: 4,
    sourceImage,
    videoModel: { id: omniModelId, text: omniText, publicPrice },
    target: { resolution: "1080p", duration: 10, ratio: "16:9" },
    generationWrites: execute ? { videoUiPosts: 1, imageUiPosts: 0 } : { videoUiPosts: 0, imageUiPosts: 0 },
  };
  await page.screenshot({ path: path.join(outputDir, "01-project-readback-gpt25.png"), fullPage: true });

  if (!execute) {
    report.status = "planned-zero-generation";
  } else {
    const cashBefore = await requestJson("/api/cash/balance");
    let videoUiPosts = 0;
    let imageUiPosts = 0;
    let projectUiPosts = 0;
    let requestBody = null;
    const requestHandler = (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && pathname === "/api/video/generate") {
        videoUiPosts += 1;
        requestBody = request.postDataJSON();
      }
      if (request.method() === "POST" && pathname === "/api/image/generate") imageUiPosts += 1;
      if (request.method() === "POST" && pathname === "/api/storyboard/projects") projectUiPosts += 1;
    };
    page.on("request", requestHandler);
    await omniButton.click();
    await page.waitForFunction((modelId) => document.querySelector(`.sbw-video-model-list button[data-model-id="${modelId}"]`)?.classList.contains("is-active"), omniModelId);
    const resolution = page.getByLabel("视频分辨率", { exact: true });
    await resolution.waitFor({ state: "visible", timeout: 30_000 });
    await resolution.selectOption("1080p");
    assert.equal(await resolution.inputValue(), "1080p", "OMNI_1080P_UI_SELECTION_FAILED");
    const durationSelect = page.getByLabel("视频时长", { exact: true });
    if (await durationSelect.count()) {
      await durationSelect.selectOption("10");
      assert.equal(await durationSelect.inputValue(), "10", "OMNI_10S_UI_SELECTION_FAILED");
    } else {
      assert.match(await page.locator(".sbw-control-group.is-video").innerText(), /固定\s*10\s*秒/u, "OMNI_FIXED_10S_UI_MISSING");
    }
    await opened.card.locator('textarea[aria-label$="视频提示词"]').fill(videoPrompt);
    assert.equal(await opened.card.locator('textarea[aria-label$="视频提示词"]').inputValue(), videoPrompt, "PLATFORM_VIDEO_PROMPT_UI_FILL_MISMATCH");
    await page.waitForFunction(() => document.querySelector("[data-storyboard-save-status]")?.textContent?.includes("任务已保存"), undefined, { timeout: 45_000 });
    await page.screenshot({ path: path.join(outputDir, "02-omni-ready-before-submit.png"), fullPage: true });
    const generate = opened.card.locator("button.is-video-command").filter({ hasText: "生成视频" }).first();
    await generate.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await generate.isEnabled(), true, `OMNI_GENERATE_BUTTON_DISABLED:${await generate.getAttribute("title")}`);
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/video/generate", { timeout: 420_000 });
    await generate.click();
    const response = await responsePromise;
    const responseBody = await response.json().catch(() => ({}));
    assert.equal(videoUiPosts, 1, `VIDEO_UI_POST_COUNT_INVALID:${videoUiPosts}`);
    assert.equal(imageUiPosts, 0, `UNEXPECTED_IMAGE_UI_POSTS:${imageUiPosts}`);
    assert.equal(requestBody?.surface, "storyboard-workbench", "VIDEO_SURFACE_MISMATCH");
    assert.equal(requestBody?.model_id, omniModelId, "VIDEO_MODEL_MISMATCH");
    assert.equal(requestBody?.resolution_tier, "1080p", "VIDEO_RESOLUTION_MISMATCH");
    assert.equal(Number(requestBody?.duration), 10, "VIDEO_DURATION_MISMATCH");
    assert.ok(requestBody?.image_url, "VIDEO_SOURCE_IMAGE_MISSING");
    assert.ok(String(requestBody?.prompt || "").includes(videoPrompt.slice(0, 80)), "VIDEO_PROMPT_NOT_DERIVED_FROM_PLATFORM_OUTPUT");
    const taskId = String(responseBody?.business_task_id || responseBody?.task_id || "");
    report.submission = {
      uiVideoPosts: videoUiPosts,
      uiImagePosts: imageUiPosts,
      uiProjectSavePosts: projectUiPosts,
      httpStatus: response.status(),
      ok: response.ok(),
      taskIdPresent: Boolean(taskId),
      taskId,
      request: {
        surface: requestBody?.surface || null,
        modelId: requestBody?.model_id || null,
        resolution: requestBody?.resolution_tier || null,
        duration: requestBody?.duration ?? null,
        hasImageUrl: Boolean(requestBody?.image_url),
        promptSha256: sha256(String(requestBody?.prompt || "")),
        containsExactPlatformPromptOpening: String(requestBody?.prompt || "").includes(videoPrompt.slice(0, 80)),
      },
      response: {
        status: responseBody?.status || responseBody?.state || null,
        code: responseBody?.code || null,
        error: responseBody?.error || responseBody?.message || null,
      },
    };
    assert.ok(response.ok() && taskId, `OMNI_UI_SUBMISSION_FAILED:${response.status()}:${report.submission.response.error || "unknown"}`);
    const terminal = await waitForTerminalVideoCard(page, opened.card, 1_200_000);
    report.terminal = terminal;
    await opened.card.screenshot({ path: path.join(outputDir, "03-omni-terminal-card.png") });
    if (terminal.terminal === "completed") {
      const video = opened.card.locator("video").first();
      await video.waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction(() => {
        const videos = [...document.querySelectorAll("article.sbw-shot-card video")];
        const target = videos.at(-1);
        return target instanceof HTMLVideoElement && target.readyState >= 1 && target.videoWidth > 0 && target.videoHeight > 0;
      }, undefined, { timeout: 120_000 });
      report.renderedVideo = await video.evaluate((node) => ({
        width: node.videoWidth,
        height: node.videoHeight,
        duration: node.duration,
        readyState: node.readyState,
      }));
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const reopened = await openSavedProject(page);
    const reopenedPrompt = await reopened.card.locator('textarea[aria-label$="视频提示词"]').inputValue();
    assert.equal(reopenedPrompt, videoPrompt, "VIDEO_PROMPT_HISTORY_READBACK_MISMATCH");
    report.historyReadback = {
      projectId,
      cardCount: await reopened.cards.count(),
      videoPromptSha256: sha256(reopenedPrompt),
      cardText: (await reopened.card.innerText()).replace(/\s+/gu, " ").trim().slice(0, 2000),
      hasRenderedVideo: await reopened.card.locator("video").count() > 0,
    };
    await page.screenshot({ path: path.join(outputDir, "04-history-reopened.png"), fullPage: true });
    const cashAfter = await requestJson("/api/cash/balance");
    report.billing = {
      cashBefore: Number(cashBefore.balance),
      cashAfter: Number(cashAfter.balance),
      cashDelta: Number((Number(cashBefore.balance) - Number(cashAfter.balance)).toFixed(6)),
      expectedPublicPrice: publicPrice,
    };
    report.status = terminal.terminal === "completed" ? "passed" : `submitted-${terminal.terminal}`;
    page.off("request", requestHandler);
  }
  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.completedAt = new Date().toISOString();
  await context.close();
} catch (error) {
  report.status = "failed-stopped-no-retry";
  report.failedAt = new Date().toISOString();
  report.error = error instanceof Error ? error.message.slice(0, 1500) : String(error).slice(0, 1500);
  throw error;
} finally {
  await browser.close();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

console.log(JSON.stringify({
  success: report.status === "passed" || report.status === "planned-zero-generation",
  status: report.status,
  runtime: report.runtime,
  plan: report.plan,
  submission: report.submission || null,
  terminal: report.terminal?.terminal || null,
  billing: report.billing || null,
  report: path.join(outputDir, "report.json"),
}, null, 2));
