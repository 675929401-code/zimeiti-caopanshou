import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = process.env.LOCAL_APP_URL || "http://127.0.0.1:5000";
const EXISTING_TASK_ID = "vt_fa857f50db21206574825ca6c1955e26160c3045";
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9)
  || new Date().toISOString().replace(/[:.]/gu, "-");
assert.equal(ORIGIN, "http://127.0.0.1:5000", "Only the fixed local preview may be accepted");
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u, "Invalid run id");

const outputDir = path.resolve(".codex-evidence", "video-workbenches-browser-acceptance-20260904", runId);
await fs.mkdir(outputDir, { recursive: true });
const reportPath = path.join(outputDir, "summary.json");

const report = {
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  scope: "AI video page and storyboard workbench; browser/API read-only acceptance",
  realGenerationTask: EXISTING_TASK_ID,
  providerGenerationRequests: 0,
  blockedTelemetry: [],
  unexpectedMutations: [],
  optionalMediaFailures: [],
  browserFailures: [],
  pageErrors: [],
  apiErrors: [],
  stages: [],
  passed: false,
};

function redactedError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    message: String(error?.message || error)
      .replace(/https?:\/\/\S+/gu, "[url]")
      .replace(/\beyJ[A-Za-z0-9._-]+/gu, "[redacted]")
      .slice(0, 500),
  };
}

async function saveReport() {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

async function stage(name, callback) {
  const startedAt = Date.now();
  const result = { name, passed: false };
  try {
    Object.assign(result, await callback());
    result.passed = true;
  } catch (error) {
    result.error = redactedError(error);
  }
  result.elapsedMs = Date.now() - startedAt;
  report.stages.push(result);
  await saveReport();
  console.log(JSON.stringify({ stage: name, passed: result.passed, elapsedMs: result.elapsedMs }));
  return result.passed;
}

async function jsonRequest(route, token) {
  const response = await fetch(new URL(route, ORIGIN), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return body;
}

function capabilities(model) {
  const value = model?.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
  return {
    available: value.available !== false,
    requiresSourceVideo: value.requiresSourceVideo === true,
    supportsSourceVideoInput: value.supportsSourceVideoInput === true,
    requiresFirstFrame: value.requiresFirstFrame === true,
    requiresLastFrame: value.requiresLastFrame === true,
    showFirstFrame: value.showFirstFrame === true,
    showLastFrame: value.showLastFrame === true,
    showReferenceImages: value.showReferenceImages === true,
    supportsAudioInput: value.supportsAudioInput === true,
    supportsPrompt: value.supportsPrompt !== false,
    minReferenceImages: Number(value.minReferenceImages || 0),
    maxReferenceImages: Number(value.maxReferenceImages || 0),
    minReferenceAudios: Number(value.minReferenceAudios || 0),
    maxReferenceAudios: Number(value.maxReferenceAudios || 0),
    billingUnit: String(value.billingUnit || "per_use"),
    defaultDuration: Number(value.defaultDuration || 0),
    defaultResolution: String(value.defaultResolution || ""),
    resolutionOptions: Array.isArray(value.resolutionOptions) ? value.resolutionOptions.map(String) : [],
    workflowInputMode: String(value.workflowInputMode || ""),
    availabilityMessage: String(value.availabilityMessage || ""),
  };
}

async function installReadOnlyBoundary(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.continue(); }
    const method = request.method().toUpperCase();
    const isMutation = url.origin === ORIGIN && !["GET", "HEAD", "OPTIONS"].includes(method);
    if (isMutation) {
      if (["/api/product-usage/events", "/api/operation-events"].includes(url.pathname)) {
        report.blockedTelemetry.push({ method, path: url.pathname, blocked: true });
        return route.abort("blockedbyclient");
      }
      if (url.pathname === "/api/video/generate") report.providerGenerationRequests += 1;
      report.unexpectedMutations.push({ method, path: url.pathname, blocked: true });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

async function makeContext(browser, session, viewport, label) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: "block" });
  await context.addInitScript(({ origin, token, user }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { origin: ORIGIN, token: session.token, user: session.user });
  await installReadOnlyBoundary(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ label, ...redactedError(error) }));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    if (failure.startsWith("net::ERR_BLOCKED_BY_CLIENT") || failure === "net::ERR_ABORTED") return;
    let requestPath = "external";
    try {
      const url = new URL(request.url());
      requestPath = url.origin === ORIGIN ? url.pathname : "external-media";
    } catch {}
    if (requestPath === "external-media" && /ERR_BLOCKED_BY_ORB/u.test(failure)) {
      report.optionalMediaFailures.push({ label, path: requestPath, error: failure.slice(0, 120) });
      return;
    }
    report.browserFailures.push({ label, path: requestPath, error: failure.slice(0, 120) });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    let requestPath = "external";
    try {
      const url = new URL(response.url());
      requestPath = url.origin === ORIGIN ? url.pathname : "external-media";
    } catch {}
    if (status === 404 && requestPath.startsWith("/api/video/thumbnail/")) {
      report.optionalMediaFailures.push({ label, path: requestPath, status });
      return;
    }
    report.apiErrors.push({ label, path: requestPath, status });
  });
  return { context, page };
}

async function gotoWorkbench(page, route, readyLocator) {
  const startedAt = Date.now();
  const response = await page.goto(`${ORIGIN}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${route} failed to load`);
  await readyLocator().waitFor({ state: "visible", timeout: 30_000 });
  const readyMs = Date.now() - startedAt;
  const navigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation").at(-1);
    return entry ? { domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd), loadMs: Math.round(entry.loadEventEnd) } : null;
  });
  return { readyMs, navigation };
}

function firstVideoTaskCard(page) {
  return page.locator("[data-video-task-card]").first();
}

async function selectVideoModel(page, model) {
  assert.equal(capabilities(model).available, true, `Unavailable model must not be selected: ${model.displayName}`);
  const button = page.locator('[data-video-model-list] button[data-video-model-id]').filter({
    has: page.locator(`[data-video-model-avatar][data-model-name=${JSON.stringify(String(model.displayName || model.name || ""))}]`),
  });
  const fallback = page.locator(`[data-video-model-list] button[data-video-model-id=${JSON.stringify(String(model.id))}]`);
  const target = await button.count() === 1 ? button : fallback;
  assert.equal(await target.count(), 1, `Model card is missing or duplicated: ${model.displayName}`);
  assert.equal(await target.isEnabled(), true, `Available model card is disabled: ${model.displayName}`);
  await target.click();
  await page.waitForFunction((modelId) => {
    const item = document.querySelector(`[data-video-model-list] button[data-video-model-id="${CSS.escape(modelId)}"]`);
    return item?.className.includes("shadow-[inset_3px_0_var(--primary)]");
  }, String(model.id), { timeout: 10_000 });
  await page.waitForTimeout(180);
  assert.ok((await target.getAttribute("class") || "").includes("shadow-[inset_3px_0_var(--primary)]"), `${model.displayName}: model card did not remain selected`);
  return target;
}

async function visibleCount(locator) {
  let count = 0;
  for (const item of await locator.all()) if (await item.isVisible()) count += 1;
  return count;
}

async function assertVideoInputMapping(page, model) {
  const card = firstVideoTaskCard(page);
  const c = capabilities(model);
  const expectedReference = c.showReferenceImages && c.maxReferenceImages > 0;
  const observed = {
    sourceVideo: await visibleCount(card.getByRole("textbox", { name: "任务1源视频链接", exact: true })),
    firstFrame: await visibleCount(card.getByText(/^首帧(?: \*|（可选）)$/u)),
    lastFrame: await visibleCount(card.getByText(/^尾帧(?: \*|（可选）)$/u)),
    referenceImage: await visibleCount(card.getByText(/^参考图(?: \*|（可选）)$/u)),
    audio: await visibleCount(card.getByText(/^参考音频（最多/u)),
  };
  assert.equal(observed.sourceVideo > 0, c.requiresSourceVideo || c.supportsSourceVideoInput, `${model.displayName}: source video UI mismatch`);
  assert.equal(observed.firstFrame > 0, c.showFirstFrame, `${model.displayName}: first frame UI mismatch`);
  assert.equal(observed.lastFrame > 0, c.showLastFrame, `${model.displayName}: last frame UI mismatch`);
  assert.equal(observed.referenceImage > 0, expectedReference, `${model.displayName}: reference image UI mismatch`);
  assert.equal(observed.audio > 0, c.supportsAudioInput && c.maxReferenceAudios > 0, `${model.displayName}: audio UI mismatch`);
  const failedBeforeStart = await visibleCount(card.getByText("生成失败", { exact: true }));
  assert.equal(failedBeforeStart, 0, `${model.displayName}: selection created a failure before submission`);
  const selectedCard = page.locator(`[data-video-model-list] button[data-video-model-id=${JSON.stringify(String(model.id))}]`);
  assert.equal(await selectedCard.count(), 1, `${model.displayName}: selected model card is missing`);
  assert.ok((await selectedCard.getAttribute("class") || "").includes("shadow-[inset_3px_0_var(--primary)]"), `${model.displayName}: selection changed unexpectedly`);
  return observed;
}

async function findScrollable(page, preferredSelector) {
  return page.evaluate(async (selector) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const proveScroll = async (element, selectorLabel) => {
      const priorBehavior = element.style.scrollBehavior;
      element.style.scrollBehavior = "auto";
      const maximum = element.scrollHeight - element.clientHeight;
      element.scrollTop = 0;
      await frame();
      const start = element.scrollTop;
      element.scrollTop = maximum;
      await frame();
      const end = element.scrollTop;
      element.style.scrollBehavior = priorBehavior;
      return {
        selector: selectorLabel,
        before: start,
        after: end,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    };
    const preferred = selector ? Array.from(document.querySelectorAll(selector)) : [];
    const all = [...preferred, ...Array.from(document.querySelectorAll("main,section,div"))];
    const seen = new Set();
    for (const element of all) {
      if (seen.has(element)) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      if (element.scrollHeight > element.clientHeight + 40 && /(auto|scroll)/u.test(style.overflowY)) {
        return proveScroll(element, element.tagName.toLowerCase() + (element.className ? "." + String(element.className).trim().split(/\s+/u).slice(0, 3).join(".") : ""));
      }
    }
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight + 40) {
      return proveScroll(root, "document.scrollingElement");
    }
    return null;
  }, preferredSelector);
}

let browser;
try {
  const injectedToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let session;
  if (injectedToken) {
    const identity = await jsonRequest("/api/auth/me", injectedToken);
    session = { token: injectedToken, user: identity.user };
  } else {
    const sessionResponse = await fetch(`${ORIGIN}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
      signal: AbortSignal.timeout(20_000),
    });
    session = await sessionResponse.json();
    assert.ok(sessionResponse.ok, "Local administrator dev session unavailable");
  }
  assert.ok(session.token && session.user?.role === "admin", "Local administrator session unavailable");

  const [videoCatalogBody, storyboardCatalogBody, historyBody, balanceBody] = await Promise.all([
    jsonRequest("/api/video/models?surface=video-page", session.token),
    jsonRequest("/api/video/models?surface=storyboard-workbench", session.token),
    jsonRequest("/api/video/history?surface=video-page&limit=100&offset=0", session.token),
    jsonRequest("/api/cash/balance", session.token),
  ]);
  const videoModels = Array.isArray(videoCatalogBody.models) ? videoCatalogBody.models : [];
  const storyboardModels = Array.isArray(storyboardCatalogBody.models) ? storyboardCatalogBody.models : [];
  const history = Array.isArray(historyBody.tasks) ? historyBody.tasks : [];
  const existingTask = history.find((task) => task.id === EXISTING_TASK_ID);
  const playbackTask = history.find((task) => task.status === "completed" && task.videoUrl && task.prompt);
  report.realGenerationTask = playbackTask?.id || null;
  const availableVideoModels = videoModels.filter((model) => capabilities(model).available);
  const availableStoryboardModels = storyboardModels.filter((model) => capabilities(model).available);

  await stage("public model catalogs and existing real task contract", async () => {
    assert.ok(videoModels.length > 0, "AI video page must expose current public models");
    assert.ok(storyboardModels.length > 0, "Storyboard workbench must expose compatible models");
    assert.equal(new Set(videoModels.map((model) => model.id)).size, videoModels.length, "AI video model ids must be unique");
    assert.equal(new Set(storyboardModels.map((model) => model.id)).size, storyboardModels.length, "Storyboard model ids must be unique");
    assert.ok(availableVideoModels.length > 0, "AI video page must expose at least one available model");
    assert.ok(availableStoryboardModels.length > 0, "Storyboard workbench must expose at least one available model");
    for (const model of [...videoModels, ...storyboardModels]) {
      const c = capabilities(model);
      if (!c.available) assert.ok(c.availabilityMessage.trim(), `${model.displayName}: unavailable model must expose a reason`);
    }
    if (existingTask) {
      assert.equal(existingTask.status, "completed", "Existing Omni task is not terminal completed");
      assert.equal(existingTask.modelId, existingTask.publicModelId, "Video history must not expose or fall back to an internal model ID");
      assert.ok(existingTask.videoUrl && existingTask.prompt, "Existing task is missing playback or prompt data");
      assert.equal(Number(existingTask.priceCharged || 0), 0, "Administrator canary should remain exempt");
    }
    return {
      videoModels: videoModels.length,
      storyboardModels: storyboardModels.length,
      availableVideoModels: availableVideoModels.length,
      availableStoryboardModels: availableStoryboardModels.length,
      sourceVideoModels: videoModels.filter((model) => capabilities(model).requiresSourceVideo).length,
      firstLastFrameModels: videoModels.filter((model) => capabilities(model).requiresLastFrame).length,
      audioModels: videoModels.filter((model) => capabilities(model).supportsAudioInput).length,
      existingTask: existingTask
        ? { id: existingTask.id, status: existingTask.status, publicModelId: existingTask.publicModelId, durationSeconds: existingTask.durationSeconds, adminPriceCharged: Number(existingTask.priceCharged || 0), inCurrentCatalog: videoModels.some((model) => model.id === existingTask.publicModelId) }
        : { id: EXISTING_TASK_ID, status: "not_present", historicalSnapshotAccepted: true },
    };
  });

  browser = await chromium.launch({ headless: true });
  const desktop = await makeContext(browser, session, { width: 1440, height: 1000 }, "desktop");
  const { context, page } = desktop;

  await stage("desktop AI video page renders and maps every current model input", async () => {
    const timing = await gotoWorkbench(page, "/video?acceptance=all-model-inputs", () => page.locator("[data-video-model-list]"));
    const modelCards = page.locator("[data-video-model-list] button[data-video-model-id]");
    await page.waitForFunction((count) => document.querySelectorAll('[data-video-model-list] button[data-video-model-id]').length === count, videoModels.length, { timeout: 30_000 });
    assert.equal(await modelCards.count(), videoModels.length, "Model rail does not show all current public models");
    for (const model of videoModels) {
      const card = page.locator(`[data-video-model-list] button[data-video-model-id=${JSON.stringify(String(model.id))}]`);
      assert.equal(await card.count(), 1, `Video model card missing: ${model.displayName}`);
      assert.equal(await card.isEnabled(), capabilities(model).available, `${model.displayName}: card enabled state differs from generation availability`);
    }
    const mapping = [];
    for (const model of availableVideoModels) {
      await selectVideoModel(page, model);
      mapping.push({ id: model.id, displayName: model.displayName, capabilities: capabilities(model), observed: await assertVideoInputMapping(page, model) });
    }
    const scroll = await findScrollable(page, "main");
    assert.ok(scroll && scroll.after !== scroll.before, "AI video desktop workbench cannot scroll");
    await page.screenshot({ path: path.join(outputDir, "video-desktop.png"), fullPage: true });
    return { ...timing, mapping, scroll };
  });

  const sourceModel = availableVideoModels.find((model) => capabilities(model).requiresSourceVideo);
  await stage("source-video preflight is informative and does not create a failed task", async () => {
    if (!sourceModel) return { notApplicable: "No current available model requires a source video" };
    await selectVideoModel(page, sourceModel);
    const card = firstVideoTaskCard(page);
    await card.getByRole("textbox", { name: "任务1提示词", exact: true }).fill("保持人物动作和镜头，仅校验源视频输入提示");
    const sourceInput = card.getByRole("textbox", { name: "任务1源视频链接", exact: true });
    await sourceInput.fill("");
    const beforeRequests = report.providerGenerationRequests;
    await card.getByRole("button", { name: "生成视频", exact: true }).click();
    await page.waitForTimeout(350);
    assert.equal(report.providerGenerationRequests, beforeRequests, "Client preflight unexpectedly submitted a provider request");
    assert.equal(await visibleCount(card.getByText("生成失败", { exact: true })), 0, "Missing source URL was presented as a generated-task failure");
    assert.equal(await visibleCount(card.getByRole("button", { name: "生成视频", exact: true })), 1, "Preflight did not keep the task editable");
    assert.ok((await page.locator("body").innerText()).includes("源视频"), "Missing-source guidance is absent");
    const selectedCard = page.locator(`[data-video-model-list] button[data-video-model-id=${JSON.stringify(String(sourceModel.id))}]`);
    assert.ok((await selectedCard.getAttribute("class") || "").includes("shadow-[inset_3px_0_var(--primary)]"), "Preflight switched the selected model");
    return { providerRequests: 0, remainedEditable: true, selectedModelStable: true };
  });

  await stage("AI video selection survives refresh and route return", async () => {
    if (!sourceModel) return { notApplicable: "No current available source-video model" };
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const selectedCard = page.locator(`[data-video-model-list] button[data-video-model-id=${JSON.stringify(String(sourceModel.id))}]`);
    await selectedCard.waitFor({ timeout: 30_000 });
    await page.waitForFunction((modelId) => document.querySelector(`[data-video-model-list] button[data-video-model-id="${CSS.escape(modelId)}"]`)?.className.includes("shadow-[inset_3px_0_var(--primary)]"), String(sourceModel.id), { timeout: 30_000 });
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.goto(`${ORIGIN}/video?acceptance=return`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await selectedCard.waitFor({ timeout: 30_000 });
    await page.waitForFunction((modelId) => document.querySelector(`[data-video-model-list] button[data-video-model-id="${CSS.escape(modelId)}"]`)?.className.includes("shadow-[inset_3px_0_var(--primary)]"), String(sourceModel.id), { timeout: 30_000 });
    return { refreshRetained: true, routeReturnRetained: true };
  });

  await stage("recent completed task history playback and browser download", async () => {
    if (!playbackTask) return { notApplicable: "No completed video-page task with a playable URL is currently retained" };
    await page.getByRole("button", { name: "历史", exact: true }).click();
    const row = page.locator(`[data-video-history-task=${JSON.stringify(String(playbackTask.id))}]`);
    await row.waitFor({ state: "visible", timeout: 30_000 });
    assert.ok((await row.innerText()).trim(), "History row lost its historical model snapshot");
    await row.locator('button[aria-label^="播放 "]').click();
    const video = row.locator("video");
    await video.waitFor({ state: "visible", timeout: 30_000 });
    await video.evaluate((element) => { element.muted = true; });
    await page.waitForFunction(() => {
      const media = Array.from(document.querySelectorAll("video")).find((item) => item.offsetParent !== null);
      return media && media.readyState >= 2 && media.videoWidth > 0;
    }, null, { timeout: 45_000 });
    await video.evaluate((element) => element.play());
    await page.waitForFunction(() => Array.from(document.querySelectorAll("video")).some((item) => item.offsetParent !== null && item.currentTime > 0.2), null, { timeout: 20_000 });
    const playback = await video.evaluate((element) => ({ duration: element.duration, currentTime: element.currentTime, width: element.videoWidth, height: element.videoHeight, readyState: element.readyState }));
    await video.evaluate((element) => element.pause());
    assert.ok(Number.isFinite(playback.duration) && playback.duration > 0.2 && playback.width > 0 && playback.height > 0, "Existing task is not actually playable");
    const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
    await row.getByRole("button", { name: "下载到电脑", exact: true }).click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null, "Browser download failed");
    const destination = path.join(outputDir, "existing-omni-video.mp4");
    await download.saveAs(destination);
    const bytes = await fs.readFile(destination);
    assert.ok(bytes.length > 100_000, "Downloaded video is unexpectedly small");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    return { playback, download: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, refreshed: true };
  });

  await stage("storyboard shows every compatible model and keeps selection", async () => {
    const timing = await gotoWorkbench(page, "/storyboard-workbench?acceptance=model-contract", () => page.locator(".sbw-video-model-list"));
    await page.waitForFunction((count) => document.querySelectorAll(".sbw-video-model-list button").length === count, storyboardModels.length, { timeout: 30_000 });
    const buttons = page.locator(".sbw-video-model-list button");
    assert.equal(await buttons.count(), storyboardModels.length, "Storyboard UI model count differs from compatible API catalog");
    const modelResults = [];
    for (const model of storyboardModels) {
      const button = page.locator(`.sbw-video-model-list button[data-model-id=${JSON.stringify(String(model.id))}]`);
      assert.equal(await button.count(), 1, `Storyboard model card missing: ${model.displayName}`);
      const selectable = capabilities(model).available;
      assert.equal(await button.getAttribute("data-model-selectable"), selectable ? "true" : "false", `${model.displayName}: storyboard generation availability is not explicit`);
      assert.equal(await button.getAttribute("aria-disabled"), selectable ? "false" : "true", `${model.displayName}: storyboard disabled semantics mismatch`);
      if (selectable) {
        await button.click();
        await page.waitForTimeout(120);
        assert.ok((await button.getAttribute("class") || "").includes("is-active"), `Storyboard model did not remain selected: ${model.displayName}`);
      }
      const text = await button.innerText();
      assert.ok(text.includes(String(model.displayName).split(" · ")[0]), `Storyboard model label lost identity: ${model.displayName}`);
      modelResults.push({ id: model.id, displayName: model.displayName, available: selectable, buttonText: text.replace(/\s+/gu, " ").trim() });
    }
    const chosen = availableStoryboardModels.find((model) => /Omni Flash/u.test(String(model.displayName))) || availableStoryboardModels[0];
    assert.ok(chosen, "Storyboard has no available model to persist");
    const chosenButton = page.locator(`.sbw-video-model-list button[data-model-id=${JSON.stringify(String(chosen.id))}]`);
    await chosenButton.click();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".sbw-video-model-list").waitFor({ state: "visible", timeout: 30_000 });
    const restored = page.locator(`.sbw-video-model-list button[data-model-id=${JSON.stringify(String(chosen.id))}]`);
    assert.ok((await restored.getAttribute("class") || "").includes("is-active"), "Storyboard model selection did not survive refresh");
    const bodyText = await page.locator("body").innerText();
    assert.equal(/生成失败|提交失败|必须上传源视频/u.test(bodyText), false, "Storyboard displayed a failure before generation");
    assert.equal(/signal is aborted|AbortError/iu.test(bodyText), false, "Storyboard exposed an internal request-abort message");
    assert.ok(await page.locator(".sbw-shot-card").count() >= 1, "Storyboard has no editable shot cards");
    let scroll = await findScrollable(page, ".sbw-shell");
    let cardsAddedForOverflow = 0;
    while ((!scroll || scroll.after === scroll.before) && cardsAddedForOverflow < 2) {
      const beforeCards = await page.locator(".sbw-shot-card").count();
      await page.getByRole("button", { name: "添加镜头", exact: true }).click();
      await page.waitForFunction((expected) => document.querySelectorAll(".sbw-shot-card").length === expected, beforeCards + 1);
      cardsAddedForOverflow += 1;
      scroll = await findScrollable(page, ".sbw-shell");
    }
    assert.ok(scroll && scroll.after !== scroll.before, "Storyboard desktop workbench cannot scroll");
    await page.screenshot({ path: path.join(outputDir, "storyboard-desktop.png"), fullPage: true });
    return { ...timing, models: modelResults, selectedAfterRefresh: chosen.displayName, cardsAddedForOverflow, scroll };
  });

  await stage("storyboard idle draft stays session-only without generation", async () => {
    const input = page.getByRole("textbox", { name: "镜头1视频提示词", exact: true });
    const marker = `只读验收草稿-${runId}`;
    const unexpectedBefore = report.unexpectedMutations.length;
    await input.fill(marker);
    assert.equal(await input.inputValue(), marker);
    await page.waitForTimeout(1_500);
    assert.equal(report.unexpectedMutations.length, unexpectedBefore, "Typing an idle draft attempted a server mutation");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const restored = page.getByRole("textbox", { name: "镜头1视频提示词", exact: true });
    await restored.waitFor({ timeout: 30_000 });
    assert.notEqual(await restored.inputValue(), marker, "Idle draft unexpectedly survived refresh without an explicit save or submission");
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.goto(`${ORIGIN}/storyboard-workbench?acceptance=return`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await restored.waitFor({ timeout: 30_000 });
    assert.notEqual(await restored.inputValue(), marker, "Idle draft unexpectedly survived route return without an explicit save or submission");
    assert.equal(report.providerGenerationRequests, 0, "Draft persistence submitted a generation request");
    return { refreshCleared: true, routeReturnCleared: true, providerRequests: 0 };
  });

  await context.close();

  report.catalog = {
    videoModelIds: videoModels.map((model) => model.id),
    storyboardModelIds: storyboardModels.map((model) => model.id),
  };
  report.balance = { apiBalance: Number(balanceBody.balance || 0), administratorExempt: true };
  report.passed = report.stages.every((item) => item.passed)
    && report.providerGenerationRequests === 0
    && report.unexpectedMutations.length === 0
    && report.pageErrors.length === 0
    && report.browserFailures.length === 0
    && report.apiErrors.filter((item) => item.path !== "external-media").length === 0;
} catch (error) {
  report.failure = redactedError(error);
} finally {
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(JSON.stringify({ reportPath, passed: report.passed, providerGenerationRequests: report.providerGenerationRequests, stages: report.stages.map(({ name, passed }) => ({ name, passed })) }, null, 2));
}

if (!report.passed) process.exitCode = 1;
