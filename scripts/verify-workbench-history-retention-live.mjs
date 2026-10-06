#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const RETAINED_NATURAL_DAYS = 3;

function argumentValue(args, prefix, fallback = "") {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function taskTime(task) {
  return Date.parse(String(task?.createdAt || task?.created_at || ""));
}

function taskLabel(task) {
  return String(task?.taskLabel || task?.task_label || "");
}

function retainedHistoryCutoff(now = Date.now()) {
  const shanghaiNow = new Date(now + SHANGHAI_OFFSET_MS);
  return Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate() - (RETAINED_NATURAL_DAYS - 1),
  ) - SHANGHAI_OFFSET_MS;
}

function assertRetained(tasks, label) {
  const cutoff = retainedHistoryCutoff();
  for (const task of tasks) {
    const createdAt = taskTime(task);
    assert.ok(Number.isFinite(createdAt), `${label} returned a task without a valid createdAt`);
    assert.ok(createdAt >= cutoff, `${label} returned a task outside today/yesterday/day-before-yesterday: ${task?.id || "unknown"}`);
    assert.notEqual(String(task?.status || ""), "expired", `${label} exposed an expired history card`);
  }
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

async function readJson(response, label) {
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, `${label} failed with HTTP ${response.status}`);
  assert.ok(payload && typeof payload === "object", `${label} returned invalid JSON`);
  return payload;
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(argumentValue(args, "--origin=", process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000")).replace(/\/+$/u, "");
  const outputFile = path.resolve(argumentValue(args, "--output=", ".codex-evidence/workbench-history-retention-live/report.json"));
  const expectedVideoTaskId = String(argumentValue(args, "--expected-video-task=", "")).trim();
  const customerToken = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
  const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const token = customerToken || adminToken;
  const expectedRole = customerToken ? "student" : "admin";
  assert.equal(origin, "http://127.0.0.1:5000", "The real local main site is required");
  assert.ok(token, "A verified local customer or administrator token is required");
  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const headers = { Authorization: `Bearer ${token}` };
  const [identityResponse, videoHistoryResponse, storyboardHistoryResponse, activeResponse, modelsResponse, retiredHistoryResponse] = await Promise.all([
    fetch(`${origin}/api/auth/me`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    fetch(`${origin}/api/video/history?surface=video-page&limit=200&offset=0`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) }),
    fetch(`${origin}/api/video/history?surface=storyboard-workbench&limit=200&offset=0`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) }),
    fetch(`${origin}/api/video/active-tasks`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) }),
    fetch(`${origin}/api/video/models?surface=video-page`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) }),
    fetch(`${origin}/media-history`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }),
  ]);
  const [identity, videoHistory, storyboardHistory, activePayload, modelsPayload] = await Promise.all([
    readJson(identityResponse, "identity"),
    readJson(videoHistoryResponse, "video history"),
    readJson(storyboardHistoryResponse, "storyboard history"),
    readJson(activeResponse, "active tasks"),
    readJson(modelsResponse, "video models"),
  ]);
  assert.equal(identity.user?.role, expectedRole, "The acceptance actor role is incorrect");
  assert.ok(Array.isArray(videoHistory.tasks), "Video history tasks are missing");
  assert.ok(Array.isArray(storyboardHistory.tasks), "Storyboard history tasks are missing");
  assert.ok(Array.isArray(activePayload.activeTasks), "Active video tasks are missing");
  assert.ok(Array.isArray(modelsPayload.models), "Video models are missing");
  assert.ok([301, 302, 303, 307, 308].includes(retiredHistoryResponse.status), "The retired aggregate history route did not redirect");
  assert.equal(new URL(retiredHistoryResponse.headers.get("location") || "/missing", origin).pathname, "/", "The retired aggregate history route did not return to the main site");

  assertRetained(videoHistory.tasks, "video history");
  assertRetained(storyboardHistory.tasks, "storyboard history");
  assertRetained(activePayload.activeTasks, "active video tasks");
  assert.ok(videoHistory.tasks.every((task) => !taskLabel(task).startsWith("分镜工作台") && !taskLabel(task).startsWith("digital-human:")), "Video history contains another workbench's task");
  assert.ok(storyboardHistory.tasks.every((task) => taskLabel(task).startsWith("分镜工作台")), "Storyboard history contains another workbench's task");
  assert.ok(activePayload.activeTasks.every((task) => !taskLabel(task).startsWith("分镜工作台") && !taskLabel(task).startsWith("digital-human:")), "Active video recovery contains another workbench's task");

  const modelNames = modelsPayload.models.map((model) => String(model.displayName || model.display_name || model.name || ""));
  const miniMaxMulti = modelsPayload.models.find((model) => /MiniMax\s*H3/iu.test(String(model.displayName || model.name || "")) && Number(model.capabilities?.maxReferenceImages || model.maxReferenceImages || 0) > 1);
  const omniTen = modelsPayload.models.find((model) => /Omni\s*Flash/iu.test(String(model.displayName || model.name || "")) && Number(model.capabilities?.maxDuration || model.durationSeconds || model.duration_seconds || 0) >= 10);
  const grok = modelsPayload.models.find((model) => /Grok|xAI/iu.test(String(model.displayName || model.name || "")));
  assert.ok(miniMaxMulti, "MiniMax H3 multi-image model is missing from the AI video catalog");
  assert.ok(omniTen, "Omni Flash 10-second model is missing from the AI video catalog");
  assert.ok(grok, "Grok/xAI video model is missing from the AI video catalog");

  const combinedHistory = [...videoHistory.tasks, ...storyboardHistory.tasks];
  const expectedVideoTask = expectedVideoTaskId
    ? combinedHistory.find((task) => String(task.id || task.taskId || "") === expectedVideoTaskId)
    : null;
  if (expectedVideoTaskId) {
    assert.ok(expectedVideoTask, `Expected completed video task is missing from retained history: ${expectedVideoTaskId}`);
    assert.equal(expectedVideoTask.status, "completed", `Expected video task is not completed: ${expectedVideoTaskId}`);
    assert.ok(String(expectedVideoTask.videoUrl || expectedVideoTask.storageUrl || "").includes("media_ticket="), "Expected video task has no protected playback URL");
    assert.ok(String(expectedVideoTask.thumbnailUrl || "").includes("media_ticket="), "Expected video task has no protected thumbnail URL");
  }
  const completed = expectedVideoTask || combinedHistory.find((task) => task.status === "completed" && task.thumbnailUrl);
  const thumbnailCheck = { attempted: false, status: 0, contentType: "", bytes: 0 };
  if (completed) {
    thumbnailCheck.attempted = true;
    const thumbnailResponse = await fetch(new URL(completed.thumbnailUrl, origin), { cache: "no-store", signal: AbortSignal.timeout(150_000) });
    const thumbnail = Buffer.from(await thumbnailResponse.arrayBuffer());
    thumbnailCheck.status = thumbnailResponse.status;
    thumbnailCheck.contentType = thumbnailResponse.headers.get("content-type") || "";
    thumbnailCheck.bytes = thumbnail.length;
    assert.ok(thumbnailResponse.ok, `Signed thumbnail failed with HTTP ${thumbnailResponse.status}`);
    assert.match(thumbnailCheck.contentType, /^image\//u, "Signed thumbnail is not an image");
    assert.ok(thumbnail.length > 256, "Signed thumbnail is empty");
  }

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    actor: { id: identity.user?.id, role: identity.user?.role },
    mockedResponses: 0,
    paidGenerationRequests: 0,
    attemptedWrites: [],
    api: {
      videoHistory: videoHistory.tasks.length,
      storyboardHistory: storyboardHistory.tasks.length,
      activeVideoTasks: activePayload.activeTasks.length,
      models: modelsPayload.models.length,
      modelNames,
      requiredModels: {
        miniMaxH3MultiImage: miniMaxMulti.id,
        omniFlashTenSeconds: omniTen.id,
        grokOrXai: grok.id,
      },
      thumbnail: thumbnailCheck,
      expectedVideoTask: expectedVideoTask ? {
        id: expectedVideoTaskId,
        status: expectedVideoTask.status,
        modelId: expectedVideoTask.modelId || "",
        resolution: expectedVideoTask.resolution || "",
        aspectRatio: expectedVideoTask.aspectRatio || "",
        durationSeconds: Number(expectedVideoTask.durationSeconds || 0),
        billingState: expectedVideoTask.billingState || "",
        priceCharged: Number(expectedVideoTask.priceCharged || 0),
      } : null,
      retiredAggregateHistoryStatus: retiredHistoryResponse.status,
    },
    browser: {},
    pageErrors: [],
    consoleErrors: [],
    responseFailures: [],
  };

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
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
        if (/^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) report.paidGenerationRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 600)));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 600));
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      if (url.origin === origin) report.responseFailures.push({ status: response.status(), method: response.request().method(), path: url.pathname });
    });

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const navigationCandidates = [
      page.locator('a[href="/video"]'),
      page.getByRole("button", { name: /视频制作/u }),
      page.getByText("视频制作", { exact: true }),
    ];
    let navigated = false;
    for (const candidates of navigationCandidates) {
      const count = await candidates.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.click();
        await page.waitForURL(/\/video(?:\?|$)/u, { timeout: 20_000 }).catch(() => undefined);
        if (/\/video(?:\?|$)/u.test(page.url())) {
          navigated = true;
          report.browser.navigation = "main-site-control";
          break;
        }
      }
      if (navigated) break;
    }
    if (!navigated) {
      await page.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      report.browser.navigation = "main-site-root-then-direct-route";
    }
    const modelRail = page.locator("[data-video-model-list]");
    await modelRail.waitFor({ state: "visible", timeout: 60_000 });
    const modelButtons = modelRail.locator("button[data-video-model-id]");
    await modelButtons.first().waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await modelButtons.count(), modelsPayload.models.length, "Rendered AI video model count differs from the real catalog");
    for (const required of [miniMaxMulti, omniTen, grok]) {
      assert.equal(await modelRail.locator(`button[data-video-model-id="${required.id}"]`).count(), 1, `Required model is missing from the model rail: ${required.id}`);
    }
    assert.equal(await page.locator('select[aria-label="视频模型"]').count(), 0, "The old video model dropdown is still rendered");
    report.browser.modelRailCount = await modelButtons.count();
    await page.screenshot({ path: path.join(path.dirname(outputFile), "video-model-rail.png"), fullPage: true });

    const historyButton = page.getByRole("button", { name: "历史", exact: true }).first();
    await historyButton.click();
    await page.getByText("仅显示本工作台近 3 天记录", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("region", { name: "视频生成历史" }).waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    report.browser.historyCards = await page.locator("[data-video-history-task]").count();
    assert.equal(report.browser.historyCards, videoHistory.tasks.length, "Rendered AI video history differs from its isolated API result");
    if (expectedVideoTaskId) {
      const expectedCard = page.locator(`[data-video-history-task="${expectedVideoTaskId}"]`);
      await expectedCard.waitFor({ state: "visible", timeout: 30_000 });
      const firstFrame = expectedCard.locator('img[alt="视频首帧"]');
      await firstFrame.waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction((taskId) => {
        const image = document.querySelector(`[data-video-history-task="${taskId}"] img[alt="视频首帧"]`);
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }, expectedVideoTaskId, { timeout: 30_000 });
      report.browser.firstFrame = await firstFrame.evaluate((image) => ({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: image.getBoundingClientRect().width,
        renderedHeight: image.getBoundingClientRect().height,
      }));
      await expectedCard.getByRole("button", { name: /^播放 /u }).click();
      const player = expectedCard.locator("video[controls]");
      await player.waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForFunction((taskId) => {
        const video = document.querySelector(`[data-video-history-task="${taskId}"] video[controls]`);
        return video instanceof HTMLVideoElement && video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0;
      }, expectedVideoTaskId, { timeout: 30_000 });
      report.browser.playback = await player.evaluate((video) => ({
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        duration: video.duration,
      }));
    }
    await page.screenshot({ path: path.join(path.dirname(outputFile), "video-history-72h.png"), fullPage: true });

    assert.equal(report.paidGenerationRequests, 0, "Read-only E2E attempted paid generation");
    assert.deepEqual(report.pageErrors, [], `Browser page errors: ${report.pageErrors.join(" | ")}`);
    const criticalFailures = report.responseFailures.filter((failure) => ["/api/video/models", "/api/video/history", "/api/video/active-tasks"].includes(failure.path));
    assert.deepEqual(criticalFailures, [], "A critical video workbench API failed in the browser");
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 1600) };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, api: report.api, browser: report.browser, paidGenerationRequests: report.paidGenerationRequests, output: outputFile, failure: report.failure || null }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
