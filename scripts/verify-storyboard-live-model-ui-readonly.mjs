#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const WORKBENCH_RATIOS = ["16:9", "9:16", "1:1"];
const PUBLIC_QA_TRACE_PATTERN = /配置待验收|待开放|真实生成尚未验收|生成准入/u;

function capabilities(model) {
  return model?.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
}

function publicName(model) {
  return String(model?.displayName || model?.display_name || model?.name || "").trim();
}

function compactVideoName(value) {
  const segments = String(value || "").replace(/\s+/gu, " ").split("·").map((segment) => segment.trim()).filter(Boolean);
  return segments.filter((segment, index) => {
    if (/元\/(?:秒|次)/u.test(segment)) return false;
    if (/(?:企业渠道)?分组\s*\d+/u.test(segment)) return false;
    return !(index === segments.length - 1 && /^\d{1,3}$/u.test(segment));
  }).join(" · ").trim() || "视频模型";
}

function storyboardCandidate(model) {
  const caps = capabilities(model);
  const surfaces = new Set((caps.workspaceSurfaces || []).map((value) => String(value).trim().toLowerCase()));
  const identity = publicName(model).toLowerCase();
  const digitalHuman = surfaces.has("digital-human") || /数字人|口播|口型|对口型|lip[\s_-]*sync|talking[\s_-]*head/u.test(identity);
  return !digitalHuman
    && (surfaces.has("storyboard") || surfaces.has("ai-video"))
    && caps.supportsImageInput === true
    && Number(caps.maxDuration || 0) > 0;
}

function inputModeIssue(model) {
  const caps = capabilities(model);
  if (caps.supportsImageInput !== true) return "不支持故事板图片输入";
  if (caps.requiresSourceVideo === true) return "需要源视频";
  const mode = String(caps.workflowInputMode || caps.referenceInputMode || "").trim().toLowerCase();
  const identity = `${model?.id || ""} ${publicName(model)}`.toLowerCase();
  if (
    caps.requiresLastFrame === true
    || (caps.requiresLastFrame !== false && (mode === "first_last_frame" || mode === "first-last-frame" || /首尾帧|first[\s_-]*last/u.test(identity)))
  ) return "需要首尾帧";
  const requiredAudios = caps.minReferenceAudios ?? (caps.supportsAudioInput ? 1 : 0);
  if (Number(requiredAudios) > 0 || mode === "image_audio_lipsync") return "需要音频输入";
  if (Number(caps.minReferenceImages || 0) > 1) return "需要多张输入图";
  if (Number(caps.maxReferenceImages) === 0) return "不接收故事板图片";
  return "";
}

function modelSelectable(model) {
  const caps = capabilities(model);
  return caps.available !== false && caps.priceReady !== false;
}

function safeModelId(value) {
  const id = String(value || "");
  assert.match(id, /^[A-Za-z0-9_-]+$/u, `Unexpected public model id: ${id}`);
  return id;
}

function argumentValue(args, prefix, fallback = "") {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

async function toolbarState(page) {
  return page.evaluate(() => {
    const imageGroup = document.querySelector(".sbw-control-group.is-image");
    const videoGroup = document.querySelector(".sbw-control-group.is-video");
    const imageResolution = imageGroup?.querySelector('select[aria-label="图片分辨率"]')?.value
      || imageGroup?.querySelector(".sbw-fixed-param")?.textContent?.trim()
      || "";
    const videoFixed = [...(videoGroup?.querySelectorAll(".sbw-fixed-param") || [])].map((node) => node.textContent?.trim() || "");
    const videoResolution = videoGroup?.querySelector('select[aria-label="视频分辨率"]')?.value
      || videoFixed.find((value) => !value.startsWith("固定 "))
      || "";
    const durationText = videoGroup?.querySelector('select[aria-label="视频时长"]')?.value
      || videoFixed.find((value) => value.startsWith("固定 "))
      || "";
    return {
      imageResolution,
      videoResolution,
      videoDuration: Number(String(durationText).match(/[\d.]+/u)?.[0] || 0),
      ratio: document.querySelector(".sbw-ratio-control button.is-active")?.textContent?.trim() || "",
      toolbarText: document.querySelector('[aria-label="分镜工作台全局设置"]')?.textContent || "",
    };
  });
}

async function launchBrowser() {
  const bundled = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
  try {
    await fs.access(bundled);
    return chromium.launch({ headless: true, executablePath: bundled });
  } catch {
    return chromium.launch({ headless: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(argumentValue(args, "--origin=", process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000")).replace(/\/+$/u, "");
  const outputFile = path.resolve(argumentValue(args, "--output=", ".codex-evidence/storyboard-live-model-ui-readonly/report.json"));
  const desktopLayoutOnly = args.includes("--desktop-layout-only");
  const customerToken = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
  const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const token = customerToken || adminToken;
  const expectedRole = customerToken ? "student" : "admin";
  assert.equal(origin, "http://127.0.0.1:5000", "The real local main site is required");
  assert.ok(token, "A verified local customer or administrator token is required");
  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const headers = { Authorization: `Bearer ${token}` };
  const [identityResponse, imageResponse, videoResponse, historyResponse] = await Promise.all([
    fetch(`${origin}/api/auth/me`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    fetch(`${origin}/api/cover-models?surface=storyboard-workbench`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    fetch(`${origin}/api/video/models?surface=storyboard-workbench`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    fetch(`${origin}/api/video/history?surface=storyboard-workbench&limit=200&offset=0`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
  ]);
  const [identity, imagePayload, videoPayload, historyPayload] = await Promise.all([
    identityResponse.json(), imageResponse.json(), videoResponse.json(), historyResponse.json(),
  ]);
  assert.ok(identityResponse.ok && identity.user?.role === expectedRole, "Local acceptance identity was not verified");
  assert.ok(imageResponse.ok && Array.isArray(imagePayload.models), "Real image catalog did not load");
  assert.ok(videoResponse.ok && Array.isArray(videoPayload.models), "Real video catalog did not load");
  assert.ok(historyResponse.ok && Array.isArray(historyPayload.tasks), "Real storyboard video history did not load");

  const imageModels = imagePayload.models.filter((model, index, all) => model?.id && all.findIndex((item) => item?.id === model.id) === index);
  const selectableImages = imageModels.filter(modelSelectable);
  const videoCandidates = videoPayload.models.filter(storyboardCandidate);
  const compatibleVideos = videoCandidates.filter((model) => !inputModeIssue(model));
  const selectableVideos = compatibleVideos.filter(modelSelectable);
  const unavailableVideos = compatibleVideos.filter((model) => !modelSelectable(model));
  const specializedVideos = videoCandidates.filter((model) => inputModeIssue(model));
  const historyStatusCounts = historyPayload.tasks.reduce((counts, task) => {
    const status = String(task.status || "unknown");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const completedHistory = historyPayload.tasks.filter((task) => task.status === "completed");
  assert.ok(imageModels.length > 0, "Current storyboard image catalog must expose at least one assigned model");
  assert.ok(selectableImages.length > 0, "Current storyboard image catalog must expose at least one selectable model");
  assert.ok(videoPayload.models.length > 0, "Current storyboard video catalog must expose at least one assigned model");
  assert.equal(videoCandidates.length, videoPayload.models.length, "Storyboard video API leaked a model outside the storyboard surface");
  assert.equal(compatibleVideos.length, videoPayload.models.length, "Storyboard video API leaked an incompatible input contract");
  assert.ok(selectableVideos.length > 0, "Current storyboard video catalog must expose at least one selectable model");
  const reportedSeedanceModels = compatibleVideos.filter((model) => /Seedance 2\.(?:0|5)/iu.test(publicName(model)));
  for (const model of compatibleVideos) {
    assert.equal(Object.hasOwn(capabilities(model), "activationReady"), false, `${publicName(model)} leaked internal activation readiness`);
    assert.equal(Object.hasOwn(capabilities(model), "readinessMessage"), false, `${publicName(model)} leaked internal acceptance copy`);
  }
  assert.doesNotMatch(JSON.stringify(videoPayload.models), PUBLIC_QA_TRACE_PATTERN, "Public video catalog leaked acceptance-stage copy");

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    realCatalogs: true,
    mockedResponses: 0,
    paidGenerationRequests: 0,
    actor: { id: identity.user.id, role: identity.user.role },
    catalog: {
      imageConfigured: imageModels.length,
      videoApiTotal: videoPayload.models.length,
      videoCandidates: videoCandidates.length,
      videoCompatibleConfigured: compatibleVideos.length,
      videoSelectable: selectableVideos.length,
      reportedSeedanceModels: reportedSeedanceModels.map((model) => ({ id: model.id, name: publicName(model) })),
      publicQaTraceCount: 0,
      videoUnavailable: unavailableVideos.map((model) => ({ id: model.id, name: compactVideoName(publicName(model)), reason: capabilities(model).availabilityMessage || "价格尚未配置" })),
      videoSpecializedExcluded: specializedVideos.map((model) => ({ id: model.id, name: publicName(model), reason: inputModeIssue(model) })),
    },
    realHistory: {
      statusCounts: historyStatusCounts,
      distinctModels: [...new Set(historyPayload.tasks.map((task) => String(task.modelName || task.modelId || "unknown")))].length,
      completedModels: [...new Set(completedHistory.map((task) => String(task.modelName || task.modelId || "unknown")))].sort(),
      completedWithPlayableUrl: completedHistory.filter((task) => Boolean(task.videoUrl || task.storageUrl)).length,
    },
    browser: { navigation: "", imageModelsChecked: 0, videoModelsChecked: 0, pairingsChecked: 0, unavailableFeedbackChecked: 0, adminModelIdsChecked: 0, historyTasksExpected: historyPayload.tasks.length, historyTasksRendered: 0, projectVideosRendered: 0, projectPlaybackTicketRequests: 0, viewports: [], adjacentPages: [] },
    acceptanceScope: desktopLayoutOnly ? "desktop-layout-only" : "desktop-full-chain",
    attemptedWrites: [],
    responseFailures: [],
    pageErrors: [],
    consoleErrors: [],
  };

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    if (expectedRole === "admin") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        const url = new URL(request.url());
        report.attemptedWrites.push({ method: request.method(), path: url.pathname });
        if (/^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) {
          report.paidGenerationRequests += 1;
          await route.abort("blockedbyclient");
          return;
        }
        if (request.method() === "POST" && url.pathname === "/api/announcements/events") {
          report.mockedResponses += 1;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
          return;
        }
        if (request.method() === "POST" && url.pathname === "/api/storyboard/projects") {
          const payload = request.postDataJSON();
          const document = payload?.document || {};
          const cards = Array.isArray(document.cards) ? document.cards : [];
          const submittedTimes = [document.lastSubmittedAt, ...cards.flatMap((card) => [card.imageSubmittedAt, card.videoStartedAt])]
            .map(Number)
            .filter((value) => Number.isFinite(value) && value > 0);
          report.mockedResponses += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              project: {
                id: String(document.id || "readonly-storyboard-project"),
                title: String(document.title || "未命名分镜项目"),
                revision: Math.max(1, Number(payload?.expectedRevision || 0) + 1),
                createdAt: new Date(Number(document.createdAt || Date.now())).toISOString(),
                updatedAt: new Date(Number(document.updatedAt || Date.now())).toISOString(),
                submittedAt: submittedTimes.length ? new Date(Math.max(...submittedTimes)).toISOString() : null,
                cardCount: cards.length,
                cards: cards.map((card, index) => ({
                  id: String(card.id || `readonly-card-${index + 1}`),
                  order: Number(card.order || index + 1),
                  imageStatus: String(card.imageStatus || "idle"),
                  videoStatus: String(card.videoStatus || "idle"),
                  imageUrl: String(card.imageUrl || ""),
                  videoUrl: String(card.videoUrl || ""),
                  videoThumbnailUrl: String(card.videoThumbnailUrl || ""),
                })),
              },
            }),
          });
          return;
        }
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const playbackTicketRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/video/access-ticket" && url.searchParams.get("scope") === "playback") {
        playbackTicketRequests.push(url.pathname + url.search);
      }
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 600)));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 600));
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      if (url.origin === origin) report.responseFailures.push({ status: response.status(), method: response.request().method(), path: url.pathname });
    });
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1_500);
    const navigationCandidates = [
      page.locator('a[href="/storyboard-workbench"]'),
      page.getByRole("button", { name: /分镜(?:工作台|编排)/u }),
      page.getByText(/^(?:分镜工作台|分镜编排)$/u),
    ];
    let navigated = false;
    for (const candidates of navigationCandidates) {
      const count = await candidates.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.click();
        await page.waitForURL(/\/storyboard-workbench(?:\?|$)/u, { timeout: 20_000 });
        navigated = true;
        report.browser.navigation = "main-site-control";
        break;
      }
      if (navigated) break;
    }
    assert.ok(navigated, "Main-site navigation did not expose the storyboard workbench entry");

    const imageButtons = page.locator(".sbw-image-model-list button[data-model-id]");
    const videoButtons = page.locator(".sbw-video-model-list button[data-model-id]");
    await imageButtons.first().waitFor({ state: "visible", timeout: 60_000 });
    await videoButtons.first().waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await imageButtons.count(), imageModels.length, "Rendered image model count differs from the real catalog");
    assert.equal(await videoButtons.count(), compatibleVideos.length, "Rendered compatible video model count differs from the real catalog");
    const adminModelIds = page.locator(".sbw-model-id-copy");
    if (expectedRole === "admin") {
      assert.equal(await adminModelIds.count(), imageModels.length + compatibleVideos.length, "Administrator model cards must expose one copyable ID each");
      const firstAdminModelId = await adminModelIds.first().locator("code").innerText();
      const expectedCopiedId = firstAdminModelId.replace(/^ID:\s*/u, "");
      await adminModelIds.first().click();
      await page.waitForFunction((id) => document.querySelector(".sbw-notice")?.textContent?.includes(`模型 ID 已复制：${id}`), expectedCopiedId);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedCopiedId, "Clicking the administrator model ID did not copy the stable ID");
      report.browser.adminModelIdsChecked = await adminModelIds.count();
    } else {
      assert.equal(await adminModelIds.count(), 0, "Customer workbench must not expose administrator model IDs");
    }
    const imageHeader = await page.locator(".sbw-image-model-list").locator("xpath=preceding-sibling::header[1]").innerText();
    const videoHeader = await page.locator(".sbw-video-model-list").locator("xpath=preceding-sibling::header[1]").innerText();
    assert.ok(imageHeader.includes(`${selectableImages.length} 可选 / ${imageModels.length} 已配置`), `Image catalog summary is stale: ${imageHeader}`);
    assert.ok(videoHeader.includes(`${selectableVideos.length} 可选 / ${compatibleVideos.length} 已配置`), `Video catalog summary is stale: ${videoHeader}`);

    for (const model of compatibleVideos) {
      const id = safeModelId(model.id);
      const button = page.locator(`.sbw-video-model-list button[data-model-id="${id}"]`);
      assert.equal(await button.count(), 1, `Configured compatible model is missing: ${publicName(model)}`);
      const expectedDisabled = !modelSelectable(model);
      assert.equal(await button.isDisabled(), expectedDisabled, `Availability gate mismatch: ${publicName(model)}`);
      if (expectedDisabled) {
        const reason = await button.getAttribute("title") || "";
        assert.match(reason, /上游账户异常|上游通道异常|暂不可用/u);
        assert.match(await button.locator(".sbw-model-unavailable").innerText(), /上游账户异常|上游通道异常|暂不可用/u);
        assert.equal(await button.evaluate((element) => getComputedStyle(element).opacity), "1", `Unavailable model was visually hidden: ${publicName(model)}`);
        await button.click({ force: true });
        assert.match(await page.locator(".sbw-notice").innerText(), /上游账户异常|上游通道异常|暂不可用/u, `Unavailable model did not explain its status: ${publicName(model)}`);
        assert.equal(await button.evaluate((element) => element.classList.contains("is-active")), false, `Unavailable model became active: ${publicName(model)}`);
        report.browser.unavailableFeedbackChecked += 1;
      }
      const cleanName = await button.locator(".sbw-model-name").innerText();
      assert.equal(cleanName, compactVideoName(publicName(model)), `Public model name was not normalized: ${publicName(model)}`);
      assert.doesNotMatch(cleanName, /元\/(?:秒|次)|分组\s*\d+/u);
      assert.doesNotMatch(cleanName, /(?:^|·)\s*\d{1,3}\s*$/u);
      assert.doesNotMatch(cleanName, PUBLIC_QA_TRACE_PATTERN);
    }
    for (const model of specializedVideos) {
      const id = safeModelId(model.id);
      assert.equal(await page.locator(`.sbw-video-model-list button[data-model-id="${id}"]`).count(), 0, `Specialized input model leaked into single-image storyboard UI: ${publicName(model)}`);
    }

    for (const imageModel of imageModels) {
      const imageId = safeModelId(imageModel.id);
      const imageButton = page.locator(`.sbw-image-model-list button[data-model-id="${imageId}"]`);
      assert.equal(await imageButton.isDisabled(), !modelSelectable(imageModel), `Image availability gate mismatch: ${publicName(imageModel)}`);
      if (!modelSelectable(imageModel)) {
        assert.match(await imageButton.locator(".sbw-model-unavailable").innerText(), /上游账户异常|上游通道异常|暂不可用/u);
        assert.equal(await imageButton.evaluate((element) => getComputedStyle(element).opacity), "1", `Unavailable image model was visually hidden: ${publicName(imageModel)}`);
        await imageButton.click({ force: true });
        assert.match(await page.locator(".sbw-notice").innerText(), /上游账户异常|上游通道异常|暂不可用/u, `Unavailable image model did not explain its status: ${publicName(imageModel)}`);
        assert.equal(await imageButton.evaluate((element) => element.classList.contains("is-active")), false, `Unavailable image model became active: ${publicName(imageModel)}`);
        report.browser.unavailableFeedbackChecked += 1;
        await imageButton.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(path.dirname(outputFile), "unavailable-model-feedback.png"), fullPage: true });
        continue;
      }
      await imageButton.click();
      await page.waitForFunction((id) => document.querySelector(`.sbw-image-model-list button[data-model-id="${id}"]`)?.classList.contains("is-active"), imageId);
      report.browser.imageModelsChecked += 1;
      const imageCaps = capabilities(imageModel);
      const imageState = await toolbarState(page);
      const imageResolutions = Array.isArray(imageCaps.resolutionOptions) ? imageCaps.resolutionOptions : [];
      assert.ok(imageResolutions.includes(imageState.imageResolution), `${publicName(imageModel)} selected an undeclared image resolution: ${imageState.imageResolution}`);
      const referenceLimit = Math.min(9, Number(imageCaps.maxReferenceImages || 0));
      const referenceButton = page.locator("article.sbw-shot-card").first().locator("button.sbw-reference-toggle");
      await page.waitForFunction((expectedDisabled) => {
        const button = document.querySelector("article.sbw-shot-card button.sbw-reference-toggle");
        return button instanceof HTMLButtonElement && button.disabled === expectedDisabled;
      }, referenceLimit === 0, { timeout: 20_000 }).catch(() => undefined);
      assert.equal(await referenceButton.isDisabled(), referenceLimit === 0, `${publicName(imageModel)} reference upload gate is incorrect`);
      assert.match(await referenceButton.innerText(), referenceLimit ? new RegExp(`最多\\s*${referenceLimit}\\s*张`, "u") : /当前不支持/u);

      for (const videoModel of selectableVideos) {
        const videoId = safeModelId(videoModel.id);
        const videoButton = page.locator(`.sbw-video-model-list button[data-model-id="${videoId}"]`);
        await videoButton.click();
        await page.waitForFunction((id) => document.querySelector(`.sbw-video-model-list button[data-model-id="${id}"]`)?.classList.contains("is-active"), videoId);
        const state = await toolbarState(page);
        const videoCaps = capabilities(videoModel);
        const resolutions = Array.isArray(videoCaps.resolutionOptions) ? videoCaps.resolutionOptions : [];
        if (resolutions.length > 0) assert.ok(resolutions.includes(state.videoResolution), `${publicName(videoModel)} selected an undeclared video resolution: ${state.videoResolution}`);
        else assert.equal(state.videoResolution, "清晰度自动", `${publicName(videoModel)} should use automatic resolution`);
        const nativeDurations = Array.isArray(videoCaps.nativeDurations) ? videoCaps.nativeDurations.map(Number) : [];
        if (nativeDurations.length > 0) assert.ok(nativeDurations.includes(state.videoDuration), `${publicName(videoModel)} selected an undeclared duration: ${state.videoDuration}`);
        else assert.ok(state.videoDuration >= Number(videoCaps.minDuration) && state.videoDuration <= Number(videoCaps.maxDuration), `${publicName(videoModel)} duration is outside its declared range`);
        const videoRatios = Array.isArray(videoCaps.aspectRatios) && videoCaps.aspectRatios.length ? videoCaps.aspectRatios : WORKBENCH_RATIOS;
        const imageRatios = Array.isArray(imageCaps.aspectRatios) && imageCaps.aspectRatios.length ? imageCaps.aspectRatios : WORKBENCH_RATIOS;
        assert.ok(videoRatios.includes(state.ratio) && imageRatios.includes(state.ratio), `${publicName(imageModel)} + ${publicName(videoModel)} has no valid active ratio`);
        assert.doesNotMatch(state.toolbarText, /NaN|undefined/u);
        report.browser.videoModelsChecked += 1;
        report.browser.pairingsChecked += 1;
      }
    }
    assert.equal(report.browser.imageModelsChecked, selectableImages.length);
    assert.equal(report.browser.pairingsChecked, selectableImages.length * selectableVideos.length);
    const storyboardText = await page.locator("body").innerText();
    assert.doesNotMatch(storyboardText, PUBLIC_QA_TRACE_PATTERN, "Storyboard UI leaked acceptance-stage copy");

    await page.screenshot({ path: path.join(path.dirname(outputFile), "model-matrix.png"), fullPage: true });
    for (const viewport of [{ width: 1600, height: 1000, label: "desktop" }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(400);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${viewport.label} storyboard page has horizontal overflow`);
      report.browser.viewports.push({ ...viewport, ...dimensions });
      await page.screenshot({ path: path.join(path.dirname(outputFile), `storyboard-${viewport.label}.png`), fullPage: true });
    }
    if (!desktopLayoutOnly) {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
    const drawer = page.getByRole("complementary", { name: "分镜工作台历史" });
    await drawer.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    report.browser.historyTasksRendered = await drawer.locator("[data-video-history-task]").count();
    report.browser.projectsRendered = await drawer.locator("[data-storyboard-project-id]").count();
    assert.equal(report.browser.historyTasksRendered, historyPayload.tasks.length, "Rendered storyboard video history differs from the real history API page");
    const playButtons = drawer.getByRole("button", { name: /^播放 /u });
    report.browser.playableHistoryResults = await playButtons.count();
    if (report.browser.playableHistoryResults > 0) {
      const historyTicketsBefore = playbackTicketRequests.length;
      await playButtons.first().click();
      const video = drawer.locator("[data-video-history-task] video").first();
      await video.waitFor({ state: "visible", timeout: 30_000 });
      // TicketedVideo intentionally replaces its initial element after the fresh
      // playback ticket arrives. Poll the current DOM element instead of holding
      // the stale pre-ticket node that may already have emitted loadedmetadata.
      await page.waitForFunction(() => {
        const element = document.querySelector("[data-video-history-task] video");
        return element instanceof HTMLVideoElement
          && element.readyState >= 1
          && Number.isFinite(element.duration)
          && element.duration > 0
          && element.videoWidth > 0
          && element.videoHeight > 0;
      }, null, { timeout: 45_000 });
      report.browser.playback = await video.evaluate((element) => ({
        readyState: element.readyState,
        duration: element.duration,
        width: element.videoWidth,
        height: element.videoHeight,
      }));
      report.browser.historyPlaybackTicketRequests = playbackTicketRequests.length - historyTicketsBefore;
      assert.ok(report.browser.historyPlaybackTicketRequests > 0, "Opening real video history did not request a fresh playback ticket");
      assert.ok(report.browser.playback.readyState >= 1 && report.browser.playback.duration > 0, "Real completed video metadata did not load");
      assert.ok(report.browser.playback.width > 0 && report.browser.playback.height > 0, "Real completed video has no decodable frame dimensions");
    }
    const projectVideoButtons = drawer.locator("button[data-storyboard-project-video]");
    report.browser.projectVideosRendered = await projectVideoButtons.count();
    assert.ok(report.browser.projectVideosRendered > 0, "No completed account project video is available for fresh-ticket verification");
    assert.equal(await drawer.locator("[data-storyboard-project-id] video").count(), 0, "Account project cards must not mount video bytes before click");
    const projectVideoButton = projectVideoButtons.first();
    assert.ok(await projectVideoButton.getAttribute("data-video-task-id"), "Account project video is missing its stable owned task id");
    const ticketsBeforeProjectClick = playbackTicketRequests.length;
    await projectVideoButton.click();
    const projectLightbox = page.getByRole("dialog", { name: "视频放大预览" });
    await projectLightbox.waitFor({ state: "visible", timeout: 30_000 });
    let projectVideo = projectLightbox.locator("video");
    await projectVideo.evaluate((element) => new Promise((resolve, reject) => {
      if (element.readyState >= 1 && element.duration > 0) return resolve();
      const timer = window.setTimeout(() => reject(new Error("Timed out loading account project video metadata")), 30_000);
      element.addEventListener("loadedmetadata", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      element.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("Account project video failed to load")); }, { once: true });
    }));
    await projectVideo.evaluate(async (element) => { element.muted = true; await element.play(); });
    await page.waitForFunction(() => (document.querySelector('.sbw-lightbox video')?.currentTime || 0) > 0.05, null, { timeout: 15_000 });
    const firstProjectVideoUrl = await projectVideo.getAttribute("src");
    const ticketsAfterFirstProjectClick = playbackTicketRequests.length;
    assert.ok(ticketsAfterFirstProjectClick > ticketsBeforeProjectClick, "Opening an account project video did not request a fresh playback ticket");
    await projectLightbox.getByRole("button", { name: "关闭预览" }).click();
    await projectLightbox.waitFor({ state: "hidden", timeout: 10_000 });
    await page.waitForTimeout(1_100);
    await projectVideoButton.click();
    await projectLightbox.waitFor({ state: "visible", timeout: 30_000 });
    projectVideo = projectLightbox.locator("video");
    await projectVideo.evaluate((element) => new Promise((resolve, reject) => {
      if (element.readyState >= 1 && element.duration > 0) return resolve();
      const timer = window.setTimeout(() => reject(new Error("Timed out reloading account project video metadata")), 30_000);
      element.addEventListener("loadedmetadata", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      element.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("Account project video failed to reload")); }, { once: true });
    }));
    const secondProjectVideoUrl = await projectVideo.getAttribute("src");
    report.browser.projectPlaybackTicketRequests = playbackTicketRequests.length - ticketsBeforeProjectClick;
    report.browser.projectPlayback = {
      taskId: await projectVideoButton.getAttribute("data-video-task-id"),
      firstReadyState: await projectVideo.evaluate((element) => element.readyState),
      firstAndSecondUrlsDiffer: firstProjectVideoUrl !== secondProjectVideoUrl,
    };
    assert.ok(playbackTicketRequests.length > ticketsAfterFirstProjectClick, "Reopening an account project video did not request another fresh playback ticket");
    assert.notEqual(firstProjectVideoUrl, secondProjectVideoUrl, "Repeated account project playback reused the previous signed URL");
    await projectLightbox.getByRole("button", { name: "关闭预览" }).click();
      await page.screenshot({ path: path.join(path.dirname(outputFile), "history-results.png"), fullPage: true });
    }

    for (const adjacentPath of ["/video", "/cover"]) {
      await page.goto(`${origin}${adjacentPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(800);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${adjacentPath} has horizontal overflow`);
      report.browser.adjacentPages.push({ path: adjacentPath, ...dimensions });
    }

    assert.equal(report.paidGenerationRequests, 0, "Read-only compatibility verification attempted a paid generation");
    assert.deepEqual(report.pageErrors, [], `Browser page errors: ${report.pageErrors.join(" | ")}`);
    const catalogFailures = report.responseFailures.filter((failure) => ["/api/cover-models", "/api/video/models"].includes(failure.path));
    assert.deepEqual(catalogFailures, [], "A real model catalog request failed in the browser");
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 1600) };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, catalog: report.catalog, browser: report.browser, paidGenerationRequests: report.paidGenerationRequests, output: outputFile, failure: report.failure || null }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
