#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const DEFAULT_SOURCE_PROJECT_ID = "storyboard-run-mu98sb0e-1kav9y";
const DEFAULT_SOURCE_IMAGE_ASSET_ID = "6a733f04-08e1-4ea8-80f0-b171d52b94c7";
const DEFAULT_VIDEO_MODEL_ID = "pm_UDGvX0Ba6ijpTEZUitj0-C8l";

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
}

function publicVideoModelId(internalId) {
  const secret = String(process.env.JWT_SECRET || "").trim();
  assert.ok(secret.length >= 16, "JWT_SECRET environment variable is required");
  const digest = createHmac("sha256", secret).update(`video:${internalId}`).digest("base64url").slice(0, 24);
  return `pm_${digest}`;
}

async function waitForActiveModel(button, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await button.getAttribute("class"))?.includes("is-active")) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, body?.error || `${new URL(url).pathname} returned ${response.status}`);
  return body;
}

async function billingSnapshot() {
  const [balance, transactions] = await Promise.all([
    jsonRequest(`${origin}/api/cash/balance`),
    jsonRequest(`${origin}/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50`),
  ]);
  const cashRows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  return {
    balance: Number(balance.balance),
    cashRows,
    cashIds: new Set(cashRows.map((row) => String(row.id))),
  };
}

export async function main() {
  const runId = argument("run-id");
  const selectedVideoModelId = argument("model-id") || DEFAULT_VIDEO_MODEL_ID;
  const sourceProjectId = argument("source-project-id") || DEFAULT_SOURCE_PROJECT_ID;
  const sourceImageAssetId = argument("source-image-asset-id") || DEFAULT_SOURCE_IMAGE_ASSET_ID;
  const requestedDuration = Number(argument("duration") || "4");
  const requestedResolution = argument("resolution") || "720p";
  const completionTimeoutMs = Number(argument("completion-timeout-ms") || "900000");
  const execute = process.argv.includes("--execute");
  const healthOnly = process.argv.includes("--health-only");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
  assert.match(selectedVideoModelId, /^pm_[A-Za-z0-9_-]+$/u, "PUBLIC_VIDEO_MODEL_ID_REQUIRED");
  assert.ok(Number.isInteger(requestedDuration) && requestedDuration >= 1 && requestedDuration <= 60, "VIDEO_DURATION_INVALID");
  assert.match(requestedResolution, /^(?:480p|720p|768p|1080p|2K|4K|lite)$/u, "VIDEO_RESOLUTION_INVALID");
  assert.ok(Number.isFinite(completionTimeoutMs) && completionTimeoutMs >= 60_000 && completionTimeoutMs <= 1_800_000, "COMPLETION_TIMEOUT_INVALID");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

  if (healthOnly) {
    const [publicCatalog, adminCatalog, channelHealth] = await Promise.all([
      jsonRequest(`${origin}/api/video/models?surface=storyboard-workbench`),
      jsonRequest(`${origin}/api/admin/video-models`),
      jsonRequest(`${origin}/api/video/channel-health`),
    ]);
    const internalByPublicId = new Map((adminCatalog.models || []).map((model) => [publicVideoModelId(String(model.id)), model]));
    const healthByInternalId = new Map((channelHealth.channels || []).map((channel) => [String(channel.channelId), channel]));
    const candidates = (publicCatalog.models || []).filter((model) => model?.capabilities?.supportsImageInput === true).map((model) => {
      const internal = internalByPublicId.get(String(model.id));
      const health = internal ? healthByInternalId.get(String(internal.id)) : null;
      return {
        publicId: model.id,
        name: model.displayName,
        publicPrice: model.publicPrice,
        billingUnit: model.capabilities?.billingUnit,
        durations: model.capabilities?.nativeDurations || [],
        resolutions: model.capabilities?.resolutionOptions || [],
        credentialConfigured: internal?.api_key_configured === true,
        circuitState: health?.circuitState || "unverified",
        productionBlocked: health?.productionBlocked === true,
        consecutiveFailures: Number(health?.consecutiveFailures || 0),
        lastSuccessAt: health?.lastSuccessAt || null,
        lastFailAt: health?.lastFailAt || null,
        lastErrorCode: health?.lastErrorCode || "NONE",
      };
    }).sort((left, right) => Number(left.productionBlocked) - Number(right.productionBlocked)
      || Number(right.circuitState === "healthy") - Number(left.circuitState === "healthy")
      || String(right.lastSuccessAt || "").localeCompare(String(left.lastSuccessAt || "")));
    console.log(JSON.stringify({ mode: "health-only", providerPosts: 0, databaseWrites: 0, candidates }, null, 2));
    return;
  }

  const outputDir = path.resolve(".codex-evidence/storyboard-video-platform-fix-20260920", runId);
  await fs.mkdir(outputDir, { recursive: true });
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerPostLimit: 1, imageGenerationPosts: 0, outputDir }));
    return;
  }

  const identity = await jsonRequest(`${origin}/api/auth/me`);
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const [catalog, adminCatalog, channelHealth] = await Promise.all([
    jsonRequest(`${origin}/api/video/models?surface=storyboard-workbench`),
    jsonRequest(`${origin}/api/admin/video-models`),
    jsonRequest(`${origin}/api/video/channel-health`),
  ]);
  const selectedModel = catalog.models?.find((model) => model.id === selectedVideoModelId);
  assert.ok(selectedModel?.capabilities?.available, "KNOWN_GOOD_STORYBOARD_VIDEO_MODEL_UNAVAILABLE");
  assert.equal(selectedModel.capabilities.supportsImageInput, true, "VIDEO_MODEL_IMAGE_INPUT_REQUIRED");
  assert.ok(selectedModel.capabilities.nativeDurations?.includes(requestedDuration), `VIDEO_MODEL_DURATION_REQUIRED:${requestedDuration}`);
  assert.ok(selectedModel.capabilities.resolutionOptions?.includes(requestedResolution), `VIDEO_MODEL_RESOLUTION_REQUIRED:${requestedResolution}`);
  const selectedInternalModel = (adminCatalog.models || []).find((model) => publicVideoModelId(String(model.id)) === selectedVideoModelId);
  assert.ok(selectedInternalModel, "STORYBOARD_VIDEO_INTERNAL_MODEL_MAPPING_MISSING");
  assert.equal(selectedInternalModel.api_key_configured, true, "STORYBOARD_VIDEO_CREDENTIAL_NOT_CONFIGURED");
  const selectedHealth = (channelHealth.channels || []).find((channel) => channel.channelId === selectedInternalModel.id);
  assert.notEqual(selectedHealth?.productionBlocked, true,
    `STORYBOARD_VIDEO_CHANNEL_BLOCKED:${selectedHealth?.circuitState || "unknown"}:${selectedHealth?.lastErrorCode || "NONE"}`);

  const billingBefore = await billingSnapshot();
  assert.ok(Number.isFinite(billingBefore.balance), "BILLING_BALANCE_BEFORE_INVALID");

  const source = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(sourceProjectId)}`);
  const ownedImage = await jsonRequest(`${origin}/api/storyboard/image?assetId=${encodeURIComponent(sourceImageAssetId)}`);
  assert.equal(ownedImage.assetId, sourceImageAssetId, "STORYBOARD_IMAGE_OWNERSHIP_MISMATCH");
  assert.ok(ownedImage.url && ownedImage.storageKey, "STORYBOARD_IMAGE_NOT_RESTORABLE");

  const now = Date.now();
  const projectId = `sbw-video-${runId}`;
  const projectTitle = `分镜视频验收 ${runId}`;
  const marker = `SBW_VIDEO_FIX_${runId}_${randomUUID()}`;
  const document = structuredClone(source.project.document);
  document.id = projectId;
  document.title = projectTitle;
  document.createdAt = now;
  document.updatedAt = now;
  document.lastSubmittedAt = now;
  document.ratio = "16:9";
  document.videoModelId = selectedVideoModelId;
  document.videoResolution = requestedResolution;
  document.videoDuration = requestedDuration;
  document.cards = [document.cards[0]];
  Object.assign(document.cards[0], {
    id: `sbw-video-card-${runId}`,
    order: 1,
    imageStatus: "done",
    imageUrl: ownedImage.url,
    imageAssetId: ownedImage.assetId,
    imageStorageKey: ownedImage.storageKey,
    imageValidatedAt: now,
    imageError: undefined,
    videoPrompt: `金毛幼犬在明亮客厅木地板上轻快跳跃，镜头平稳缓慢前推，暖色自然光，保持角色和环境一致，无文字无水印。验收标记 ${marker} 仅用于任务核对，不得出现在画面。`,
    videoStatus: "idle",
    videoUrl: undefined,
    videoError: undefined,
    videoTaskId: undefined,
    videoTaskModelId: undefined,
    videoContentUrl: undefined,
    videoClientRequestId: undefined,
    videoClientRequestFingerprint: undefined,
    videoRetryable: undefined,
    videoBillingState: undefined,
    videoPriceCharged: undefined,
  });
  const saved = await jsonRequest(`${origin}/api/storyboard/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, expectedRevision: 0 }),
  });
  assert.equal(saved.project?.id, projectId, "STORYBOARD_CANARY_PROJECT_SAVE_FAILED");

  const dispatchPath = path.join(outputDir, "dispatch.json");
  await fs.writeFile(dispatchPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    runId,
    marker,
    projectId,
    sourceImageAssetId,
    selectedModelId: selectedVideoModelId,
    selectedModel: selectedModel.displayName,
    duration: requestedDuration,
    resolution: requestedResolution,
    balanceBefore: billingBefore.balance,
    providerPostLimit: 1,
  }, null, 2)}\n`, { flag: "wx" });

  const browser = await chromium.launch({ headless: true });
  let generationPosts = 0;
  let imageGenerationPosts = 0;
  let requestBody = null;
  let responseBody = null;
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 400)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 400));
    });
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && pathname === "/api/video/generate") {
        generationPosts += 1;
        requestBody = request.postDataJSON();
      }
      if (request.method() === "POST" && pathname === "/api/image/generate") imageGenerationPosts += 1;
    });

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
    const project = page.locator(`[data-storyboard-project-id="${projectId}"]`);
    await project.waitFor({ state: "visible", timeout: 45_000 });
    await project.getByRole("button", { name: "打开任务", exact: true }).click();

    let card = page.locator("article.sbw-shot-card").first();
    const image = card.getByRole("img", { name: "任务1故事板" });
    await image.waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector("article.sbw-shot-card img[alt='任务1故事板']");
      return element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0;
    }, undefined, { timeout: 45_000 });
    const selectedButton = page.locator(`.sbw-video-model-list button[data-model-id="${selectedVideoModelId}"]`).first();
    await selectedButton.waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await waitForActiveModel(selectedButton), true, "VIDEO_MODEL_SELECTION_NOT_RESTORED");

    const generate = card.getByRole("button", { name: "生成视频", exact: true });
    await generate.waitFor({ state: "visible", timeout: 30_000 });
    let generateEnabled = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      generateEnabled = await generate.isEnabled();
      if (generateEnabled) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!generateEnabled) {
      const imageDimensions = await image.evaluate((element) => ({
        width: element.naturalWidth,
        height: element.naturalHeight,
        complete: element.complete,
      }));
      const disabledReason = await generate.getAttribute("title");
      const cardState = await card.getAttribute("data-card-state");
      throw new Error(`STORYBOARD_VIDEO_BUTTON_DISABLED:${disabledReason || "NO_TITLE"}:${cardState || "NO_STATE"}:${imageDimensions.width}x${imageDimensions.height}`);
    }
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/video/generate", { timeout: 120_000 });
    await generate.click();
    const generationResponse = await responsePromise;
    responseBody = await generationResponse.json().catch(() => null);
    assert.ok(generationResponse.status() < 500, responseBody?.error || responseBody?.message || "STORYBOARD_VIDEO_SUBMISSION_FAILED");
    assert.equal(generationPosts, 1, "STORYBOARD_VIDEO_POST_COUNT_INVALID");
    assert.equal(imageGenerationPosts, 0, "UNEXPECTED_IMAGE_GENERATION_POST");
    assert.equal(requestBody?.surface, "storyboard-workbench");
    assert.equal(requestBody?.batch_topic, "storyboard-workbench");
    assert.equal(requestBody?.model_id, selectedVideoModelId);
    assert.equal(requestBody?.duration, requestedDuration);
    assert.equal(requestBody?.resolution_tier, requestedResolution);
    assert.ok(requestBody?.image_url, "STORYBOARD_VIDEO_IMAGE_NOT_BOUND");
    const taskId = responseBody?.business_task_id || responseBody?.task_id;
    assert.ok(taskId, "STORYBOARD_VIDEO_TASK_ID_MISSING");
    const submittedAt = Date.now();

    let submittedProject = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      submittedProject = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(projectId)}`);
      if (submittedProject?.project?.document?.cards?.[0]?.videoTaskId === taskId) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(submittedProject?.project?.document?.cards?.[0]?.videoTaskId, taskId, "STORYBOARD_VIDEO_SUBMISSION_NOT_PERSISTED");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
    const projectAfterReload = page.locator(`[data-storyboard-project-id="${projectId}"]`);
    await projectAfterReload.waitFor({ state: "visible", timeout: 45_000 });
    await projectAfterReload.getByRole("button", { name: "打开任务", exact: true }).click();
    card = page.locator("article.sbw-shot-card").first();
    await card.waitFor({ state: "visible", timeout: 45_000 });
    const selectedAfterReload = page.locator(`.sbw-video-model-list button[data-model-id="${selectedVideoModelId}"]`).first();
    await selectedAfterReload.waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await waitForActiveModel(selectedAfterReload), true, "VIDEO_MODEL_SELECTION_LOST_AFTER_RELOAD");
    assert.equal(generationPosts, 1, "PAGE_RELOAD_REPOSTED_VIDEO_TASK");

    await card.locator('[data-status="done"]').filter({ hasText: "视频完成" }).waitFor({ state: "visible", timeout: completionTimeoutMs });
    const completedAt = Date.now();
    const video = card.locator("video").first();
    await video.waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector("article.sbw-shot-card video");
      return element instanceof HTMLVideoElement && element.readyState >= 1 && element.videoWidth > 0 && element.videoHeight > 0;
    }, undefined, { timeout: 120_000 });
    const rendered = await video.evaluate((element) => ({
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
      readyState: element.readyState,
    }));

    let restoredProject = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      restoredProject = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(projectId)}`);
      if (restoredProject?.project?.document?.cards?.[0]?.videoStatus === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const persistedCard = restoredProject?.project?.document?.cards?.[0];
    assert.equal(persistedCard?.videoStatus, "done", "STORYBOARD_VIDEO_COMPLETION_NOT_PERSISTED");
    assert.equal(persistedCard?.videoTaskId, taskId, "STORYBOARD_VIDEO_TASK_NOT_PERSISTED");

    const history = await jsonRequest(`${origin}/api/video/history?surface=storyboard-workbench&limit=200`);
    const historyTask = history.tasks?.find((task) => task.id === taskId);
    assert.ok(historyTask, "STORYBOARD_VIDEO_HISTORY_MISSING");
    assert.equal(historyTask.status, "completed", "STORYBOARD_VIDEO_HISTORY_NOT_COMPLETED");
    assert.equal(historyTask.modelId, selectedVideoModelId, "STORYBOARD_VIDEO_HISTORY_MODEL_MISMATCH");

    const expectedCharge = Number(historyTask.priceCharged || 0);
    assert.ok(Number.isFinite(expectedCharge) && expectedCharge > 0, "ADMIN_VIDEO_MUST_USE_NORMAL_BILLING");
    let billingAfter = await billingSnapshot();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
      if (newCashRows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      billingAfter = await billingSnapshot();
    }
    const balanceDelta = Number((billingBefore.balance - billingAfter.balance).toFixed(6));
    assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001,
      `VIDEO_BILLING_BALANCE_DELTA_MISMATCH:${balanceDelta}:${expectedCharge}`);
    const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
    assert.equal(newCashRows.length, 1, `VIDEO_BILLING_TRANSACTION_COUNT_MISMATCH:${newCashRows.length}`);
    assert.match(String(newCashRows[0].referenceId || ""), /^video-terminal:/u, "VIDEO_BILLING_REFERENCE_MISSING");
    assert.ok(Math.abs(Math.abs(Number(newCashRows[0].amount)) - expectedCharge) <= 0.000001,
      "VIDEO_BILLING_TRANSACTION_AMOUNT_MISMATCH");

    const ticket = await jsonRequest(`${origin}/api/video/access-ticket?${new URLSearchParams({ taskId, scope: "download", name: `${runId}.mp4` })}`);
    assert.ok(ticket.url, "STORYBOARD_VIDEO_DOWNLOAD_TICKET_MISSING");
    const mediaResponse = await context.request.get(new URL(ticket.url, origin).toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    const mediaBytes = Buffer.from(await mediaResponse.body());
    assert.ok(mediaResponse.ok() && mediaBytes.length > 1_024, "STORYBOARD_VIDEO_MEDIA_INVALID");
    assert.equal(mediaBytes.subarray(4, 8).toString("ascii"), "ftyp", "STORYBOARD_VIDEO_MP4_HEADER_INVALID");
    await fs.writeFile(path.join(outputDir, "generated-video.mp4"), mediaBytes, { flag: "wx" });
    await page.screenshot({ path: path.join(outputDir, "storyboard-video-success.png"), fullPage: true });

    const version = await (await context.request.get(`${origin}/api/version`)).json();
    const report = {
      runId,
      checkedAt: new Date().toISOString(),
      sourceVersion: version.sourceVersion,
      projectId,
      selectedModel: selectedModel.displayName,
      selectedModelId: selectedVideoModelId,
      generationPosts,
      imageGenerationPosts,
      request: {
        surface: requestBody.surface,
        batchTopic: requestBody.batch_topic,
        duration: requestBody.duration,
        resolution: requestBody.resolution_tier,
        hasImageUrl: Boolean(requestBody.image_url),
        clientRequestId: requestBody.client_request_id,
      },
      response: {
        http: generationResponse.status(),
        taskId,
        status: responseBody?.status,
        taskSubmitted: responseBody?.task_submitted,
        billingState: responseBody?.billing_state,
        price: responseBody?.price,
      },
      history: {
        status: historyTask.status,
        billingState: historyTask.billingState,
        priceCharged: expectedCharge,
      },
      refreshRecovery: {
        taskPersistedBeforeReload: true,
        modelSelectionRestored: true,
        generationPostsAfterReload: generationPosts,
      },
      timing: {
        submittedAt: new Date(submittedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        elapsedSeconds: Number(((completedAt - submittedAt) / 1_000).toFixed(3)),
      },
      billing: {
        balanceBefore: billingBefore.balance,
        balanceAfter: billingAfter.balance,
        balanceDelta,
        newTransactionCount: newCashRows.length,
        referenceId: newCashRows[0].referenceId,
        amount: Number(newCashRows[0].amount),
      },
      persisted: { videoStatus: persistedCard.videoStatus, videoTaskId: persistedCard.videoTaskId },
      rendered,
      media: {
        bytes: mediaBytes.length,
        contentType: mediaResponse.headers()["content-type"] || "",
        sha256: createHash("sha256").update(mediaBytes).digest("hex"),
        file: "generated-video.mp4",
      },
      consoleErrors,
      pageErrors,
      tokenPersisted: false,
    };
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ success: true, runId, generationPosts, imageGenerationPosts, taskId, status: historyTask.status,
      priceCharged: Number(historyTask.priceCharged || 0), report: path.join(outputDir, "report.json") }));
  } catch (error) {
    const failure = {
      runId,
      failedAt: new Date().toISOString(),
      generationPosts,
      imageGenerationPosts,
      taskId: responseBody?.business_task_id || responseBody?.task_id || null,
      responseStatus: responseBody?.status || null,
      message: error instanceof Error ? error.message.slice(0, 1_200) : String(error).slice(0, 1_200),
    };
    await fs.writeFile(path.join(outputDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { flag: "wx" }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
