#!/usr/bin/env node
/** Real compiled desktop UI; synthetic RAM APIs/media only. No supplier/storage acceptance claim. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = new URL(process.env.BASE_URL || "http://127.0.0.1:5000").origin;
assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_PREVIEW_REQUIRED");
const outputRoot = path.resolve(process.env.STORYBOARD_REFINEMENT_BROWSER_OUTPUT || ".codex-evidence/storyboard-history-gallery-20261023/browser-contract");
const requestedRunId = process.env.STORYBOARD_REFINEMENT_BROWSER_RUN_ID?.trim();
const runId = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "INVALID_EVIDENCE_RUN_ID");
const output = path.join(outputRoot, runId);
const report = { schema: "storyboard-history-gallery-browser.v1", passed: false,
  scope: "Compiled UI with synthetic account, history and media; API mutations and file writes remain RAM. No supplier, real cloud or database verification.",
  checkedAt: new Date().toISOString(), runId, outputRoot, evidenceDirectory: output, viewport: { width: 1440, height: 900 }, checks: [], screenshots: [], pageErrors: [],
  generationPosts: [], interceptedWrites: [], blockedRequests: [], mediaRequests: [], forwardedWrites: 0, forwardedExternalRequests: 0 };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function identity() {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR || ".next";
  assert.ok([".next", ".next-local-acceptance", ".next-local-acceptance-next"].includes(dist));
  const [response, versionRaw, buildRaw, receiptRaw] = await Promise.all([
    fetch(origin + "/api/version", { redirect: "error", signal: AbortSignal.timeout(15000) }),
    readFile("public/version.json", "utf8"), readFile(path.join(dist, "BUILD_ID"), "utf8"),
    readFile(path.join(dist, "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  assert.ok(response.ok, "CURRENT_VERSION_REQUIRED");
  const runtime = await response.json(), version = JSON.parse(versionRaw.replace(/^\uFEFF/u, ""));
  const receipt = JSON.parse(receiptRaw.replace(/^\uFEFF/u, "")), current = computeLocalBuildFingerprint(process.cwd());
  assert.ok(runtime.sourceVersion && runtime.buildId);
  assert.equal(runtime.sourceVersion, version.sourceVersion);
  assert.equal(runtime.buildId, buildRaw.trim());
  assert.equal(receipt.buildId, runtime.buildId);
  assert.equal(receipt.fingerprint, current.fingerprint, "CURRENT_SOURCE_BUILD_IDENTITY_REQUIRED");
  assert.equal(receipt.fileCount, current.fileCount);
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}
function staticPath(url) {
  if (["/storyboard-workbench", "/storyboard-workbench/history", "/storyboard-workbench/visual-assets", "/video"].includes(url.pathname)) return true;
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return false;
  try {
    const root = path.resolve("public"), file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    return file.startsWith(root + path.sep) && statSync(file).isFile();
  } catch { return false; }
}
async function until(predicate, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!await predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await predicate(), message);
}
async function screenshot(page, name) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, route: location.pathname }));
  assert.ok(metrics.scrollWidth <= metrics.width + 2, "DESKTOP_HORIZONTAL_OVERFLOW");
  await page.screenshot({ path: path.join(output, name + ".png"), fullPage: false });
  report.screenshots.push({ file: name + ".png", ...metrics });
}
const batchId = "refinement-fixture-batch", projectId = "refinement-fixture-project";
const names = { old1: "refinement-segment-1-attempt-1", new1: "refinement-segment-1-attempt-2",
  old2: "refinement-segment-2-attempt-1", new2: "refinement-segment-2-attempt-2",
  expired3: "refinement-segment-3-attempt-1", saving4: "refinement-segment-4-attempt-1",
  saved5: "refinement-segment-5-attempt-1", failed6: "refinement-segment-6-attempt-1", unavailable7: "refinement-segment-7-attempt-1" };
const videoModel = { id: "refinement-video-model", displayName: "Fixture Video 720p", publicPrice: 0.4,
  capabilities: { type: "video", durationMode: "fixed", minDuration: 8, maxDuration: 8, defaultDuration: 8, nativeDurations: [8],
    supportsImageInput: true, requiresImage: true, resolutionTier: "720p", resolutionOptions: ["720p"], defaultResolution: "720p", aspectRatios: ["16:9"], workspaceSurfaces: ["storyboard", "video-page"] } };
const imageModel = { id: "gpt-image-2-pro", displayName: "Fixture GPT Image", publicPrice: 0.2,
  capabilities: { family: "gpt", supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ["1K", "2K"], defaultResolution: "2K", aspectRatios: ["16:9"] } };
function fixtureRecords() {
  const base = Date.now() - 120000;
  const configs = [
    [names.old1, 1, "completed", true, "saved"], [names.new1, 1, "failed", false, "failed"],
    [names.old2, 2, "completed", true, "saved"], [names.new2, 2, "processing", false, "saving"],
    [names.expired3, 3, "completed", false, "expired"], [names.saving4, 4, "completed", true, "saving"],
    [names.saved5, 5, "completed", true, "saved"], [names.failed6, 6, "failed", false, "failed"],
    [names.unavailable7, 7, "completed", false, "saving"],
  ];
  return configs.map(([id, cardIndex, status, mediaAvailable, deliveryState], index) => ({
    id, taskIdExternal: id, batchId, batchTopic: "历史体验验收 · 七段九次生成", cardIndex, status, mediaAvailable, deliveryState,
    taskLabel: "分镜工作台 · 验收", modelName: videoModel.displayName, modelId: videoModel.id, publicModelId: videoModel.id,
    createdAt: new Date(base + index * 5000).toISOString(), completedAt: status === "processing" ? undefined : new Date(base + index * 5000 + 1000).toISOString(),
    retainedUntil: new Date(deliveryState === "expired" ? Date.now() - 60000 : Date.now() + (index + 1) * 3600000).toISOString(),
    prompt: `仅属于 ${id} 的提示词`, resolution: index % 2 ? "1080p" : "720p", aspectRatio: "16:9", durationSeconds: 8,
    priceCharged: (index + 1) * 0.37, billingState: status === "processing" ? "pending" : "settled", progress: status === "processing" ? 31 : undefined,
    errorMessage: status === "failed" ? `验收失败说明 ${id}` : undefined,
    videoUrl: mediaAvailable ? `/api/video/proxy?taskId=${id}&media_ticket=fixture` : undefined,
    thumbnailUrl: mediaAvailable ? `/api/video/thumbnail/${id}?media_ticket=fixture` : undefined,
  }));
}
async function fixtures(page) {
  let records = fixtureRecords();
  const clip = await readFile(".codex-evidence/storyboard-history-20261023/cloud-fixture-0.5s.mp4");
  const poster = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#184d62"/><circle cx="160" cy="90" r="40" fill="#7bdfca"/></svg>';
  await page.route("**/*", route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { report.blockedRequests.push({ method, path: url.pathname, kind: "external" }); return route.abort("blockedbyclient"); }
    if (url.pathname.startsWith("/api/")) return json(route, { error: "Unconfigured RAM fixture endpoint", tasks: [], records: [], models: [], assets: [], projects: [] }, 404);
    if (method === "GET" && staticPath(url)) return route.continue();
    report.blockedRequests.push({ method, path: url.pathname, kind: "unapproved-local" }); return route.abort("blockedbyclient");
  });
  const now = Date.now();
  const document = { id: projectId, title: "历史体验验收", createdAt: now, updatedAt: now, ratio: "16:9", imageRatio: "16:9", imageResolution: "2K",
    videoResolution: "720p", videoDuration: 8, imageModelId: imageModel.id, videoModelId: videoModel.id,
    cards: [{ id: "refinement-fixture-editable-card", order: 1, label: "验收空白分镜", narration: "", imagePrompt: "", videoPrompt: "",
      referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle" }], visualAssetWorkspace: { drafts: [], candidates: [] } };
  const fixture = await installStoryboardBrowserFixture(page, { origin, resetStorage: false, initialProjects: [document],
    user: { themePreference: "lattice", themeModePreference: "dark", themePreferenceExpiresAt: new Date(now + 7 * 86400000).toISOString() } });
  for (const [endpoint, body] of Object.entries({ "/api/cover-models": { models: [imageModel] }, "/api/video/models": { models: [videoModel] },
    "/api/storyboard/presets": { presets: [], nextOffset: null }, "/api/image-workbench/failure-history": { records: [], nextPage: null },
    "/api/storyboard/visual-assets": { assets: [], nextOffset: null }, "/api/cash/balance": { balance: 1000 },
    "/api/settings/video-page": { config: {} }, "/api/video/active-tasks": { activeTasks: [] },
    "/api/settings/appearance": { settings: { theme: "lattice", theme_mode: "dark" } },
  })) await page.route("**" + endpoint + "**", route => json(route, body));
  await page.route("**/api/video/history**", route => json(route, { tasks: records, nextOffset: null, hiddenTaskIds: [], serverTime: new Date().toISOString() }));
  await page.route("**/api/video/access-ticket**", route => {
    const query = new URL(route.request().url()).searchParams, taskId = query.get("taskId"), scope = query.get("scope");
    report.mediaRequests.push({ kind: "ticket", taskId, scope });
    if (!records.some(item => item.id === taskId && item.mediaAvailable)) return json(route, { error: "Fixture media unavailable" }, 410);
    const target = scope === "thumbnail" ? `/api/video/thumbnail/${taskId}` : scope === "download" ? "/api/video/proxy-download" : "/api/video/proxy";
    return json(route, { url: `${target}?taskId=${taskId}&media_ticket=fixture` });
  });
  await page.route("**/api/video/thumbnail/**", route => route.fulfill({ contentType: "image/svg+xml", body: poster }));
  for (const endpoint of ["/api/video/proxy", "/api/video/proxy-download"]) await page.route("**" + endpoint + "?**", route => {
    const request = route.request(), taskId = new URL(request.url()).searchParams.get("taskId");
    report.mediaRequests.push({ kind: endpoint.endsWith("download") ? "download" : "playback", taskId });
    if (!records.some(item => item.id === taskId && item.mediaAvailable)) return json(route, { error: "Fixture media unavailable" }, 410);
    const range = request.headers().range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
      if (!match) return route.fulfill({ status: 416, headers: { "Content-Range": `bytes */${clip.length}` } });
      const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : clip.length - 1, clip.length - 1);
      return route.fulfill({ status: 206, contentType: "video/mp4", headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${clip.length}` }, body: clip.subarray(start, end + 1) });
    }
    return route.fulfill({ contentType: "video/mp4", headers: { "Accept-Ranges": "bytes" }, body: clip });
  });
  for (const endpoint of ["/api/video/generate", "/api/image/generate"]) await page.route("**" + endpoint + "**", route => {
    report.generationPosts.push({ method: route.request().method(), path: endpoint });
    return json(route, { error: "Paid generation forbidden in browser fixture", upstreamCalled: false }, 409);
  });
  await page.addInitScript(() => {
    window.__refinementFiles = [];
    const handle = name => ({ createWritable: async () => ({ write: async data => { window.__refinementFiles.push({ name, bytes: data.size }); }, close: async () => {} }) });
    window.showDirectoryPicker = async () => ({ getFileHandle: async name => handle(name) });
    window.showSaveFilePicker = async options => handle(options.suggestedName);
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) report.interceptedWrites.push({ method: request.method(), path: url.pathname });
  });
  return { fixture, records: () => records, expireFour: () => { records = records.map(item => item.id === names.saving4
    ? { ...item, mediaAvailable: false, deliveryState: "expired", videoUrl: undefined, thumbnailUrl: undefined } : item); },
  restoreFour: () => { records = records.map(item => item.id === names.saving4 ? { ...item, mediaAvailable: true, deliveryState: "saving", videoUrl: `/api/video/proxy?taskId=${item.id}&media_ticket=fixture`, thumbnailUrl: `/api/video/thumbnail/${item.id}?media_ticket=fixture` } : item); } };
}
const selectedCard = (page, id) => page.locator(`.sbh-storyboard-card[data-task-id="${id}"]`);
const cardDownload = (page, id) => selectedCard(page, id).getByRole("button", { name: /^下载第\s*\d+\s*段视频$/u });
async function ramFiles(page, expected) {
  await until(async () => await page.evaluate(() => window.__refinementFiles.length) === expected.length, "DOWNLOAD_COUNT_MISMATCH");
  const files = await page.evaluate(() => window.__refinementFiles);
  assert.equal(new Set(files.map(file => file.name)).size, files.length);
  for (const id of expected) assert.equal(files.filter(file => file.name.includes(id)).length, 1, "TASK_ID_MISSING_FROM_FILENAME");
  assert.ok(files.every(file => file.bytes === 1735));
  report.ramDownloads ||= []; report.ramDownloads.push(files); return files;
}
async function downloadOne(page, id) {
  await page.evaluate(() => { window.__refinementFiles = []; });
  const before = report.mediaRequests.length;
  await cardDownload(page, id).click();
  const files = await ramFiles(page, [id]);
  await until(() => cardDownload(page, id).isEnabled(), "SINGLE_DOWNLOAD_NOT_FINISHED");
  assert.ok(report.mediaRequests.slice(before).some(request => request.kind === "download" && request.taskId === id));
  return files[0];
}
async function downloadBatch(page, expected) {
  await page.evaluate(() => { window.__refinementFiles = []; });
  const button = page.getByRole("button", { name: "下载本批次", exact: true });
  await button.click(); const files = await ramFiles(page, expected);
  await until(() => button.isEnabled(), "BATCH_DOWNLOAD_NOT_FINISHED"); return files;
}
async function simpleGallery(page, count) {
  const root = page.locator(".sbh-storyboard-page");
  assert.equal(await root.locator(".sbh-storyboard-card").count(), count);
  assert.equal(await root.locator("details, summary, input[type=checkbox], select, [role=combobox]").count(), 0);
  assert.equal(await root.locator(".sbh-storyboard-filters, .sbh-storyboard-versions, .sbh-record-details, .sbh-storyboard-recovery").count(), 0);
  const text = await root.innerText();
  for (const hidden of [videoModel.displayName, "720p", "1080p", "参数与详情", "未完成项目与参数恢复", "31%", "仅属于", "¥", ...Object.values(names)]) assert.equal(text.includes(hidden), false, "INTERNAL_CONTENT_VISIBLE:" + hidden);
}
async function playFixture(page, id) {
  const before = report.mediaRequests.length;
  await selectedCard(page, id).locator(".sbh-card-play").click();
  const player = page.getByRole("dialog", { name: "视频预览", exact: true }); await player.waitFor();
  const video = player.locator("video");
  await video.evaluate(async element => {
    if (element.readyState >= 2) return;
    await new Promise((resolve, reject) => {
      element.addEventListener("loadeddata", resolve, { once: true });
      element.addEventListener("error", () => reject(Error("Fixture playback failed")), { once: true });
    });
  });
  await video.evaluate(element => element.play());
  await until(async () => await video.evaluate(element => element.currentTime > 0.1 && element.videoWidth > 0 && !element.error), "FIXTURE_VIDEO_NOT_PLAYING");
  assert.ok(report.mediaRequests.slice(before).some(request => request.kind === "playback" && request.taskId === id));
  report.fixturePlayback ||= []; report.fixturePlayback.push({ taskId: id, ...(await video.evaluate(element => ({ width: element.videoWidth, duration: element.duration, currentTime: element.currentTime, readyState: element.readyState }))) });
  await screenshot(page, id === names.old1 ? "gallery-first-attempt-playback" : "gallery-second-attempt-playback");
  await player.getByRole("button", { name: "关闭视频预览", exact: true }).click();
}
async function run(page) {
  const fixture = await fixtures(page);
  await page.goto(origin + "/storyboard-workbench/history", { waitUntil: "domcontentloaded" });
  await selectedCard(page, names.old1).waitFor();
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "lattice"
    && document.documentElement.getAttribute("data-mode") === "dark");
  report.fixtureAppearance = { theme: "lattice", mode: "dark", source: "RAM user appearance preference and platform appearance API" };
  const root = page.locator(".sbh-storyboard-page"), header = root.locator("header.sbh-storyboard-heading");
  await header.getByRole("button", { name: "返回分镜工作台", exact: true }).waitFor();
  await header.getByRole("heading", { name: "分镜历史", exact: true }).waitFor();
  assert.equal(await page.locator(".sbw-history-page-navigation").count(), 0);
  assert.equal(await root.getByRole("button", { name: "关闭历史", exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  const style = await header.evaluate(element => ({ image: getComputedStyle(element).backgroundImage, top: element.getBoundingClientRect().top, parentTop: element.parentElement.getBoundingClientRect().top }));
  assert.equal(style.image, "none"); assert.ok(Math.abs(style.top - style.parentTop) <= 2);
  await simpleGallery(page, 6);
  for (const id of [names.new1, names.new2, names.failed6]) assert.equal(await selectedCard(page, id).count(), 0);
  for (const [id, index] of [[names.old1, 0], [names.old2, 1], [names.expired3, 2], [names.saving4, 3], [names.saved5, 4], [names.unavailable7, 6]]) {
    assert.equal(await selectedCard(page, id).getAttribute("data-card-index"), String(index)); await cardDownload(page, id).waitFor();
  }
  assert.equal(await root.getByText("第8段", { exact: true }).count(), 0);
  for (const id of [names.expired3, names.unavailable7]) {
    assert.equal(await selectedCard(page, id).locator(".sbh-card-play:enabled").count(), 0); assert.equal(await cardDownload(page, id).isDisabled(), true);
  }
  report.checks.push("single same-theme title and return row", "six completed videos with correct one-based segment numbering", "failed and processing records hidden without deleting task fixtures", "unavailable media disables playback and download", "no details, versions, filters, checkboxes, models, parameters, prompts, fees or task IDs shown");
  await screenshot(page, "gallery-1440"); await page.setViewportSize({ width: 1920, height: 1080 }); await screenshot(page, "gallery-1920"); await page.setViewportSize(report.viewport);
  report.checks.push("1440 and 1920 desktop widths without horizontal overflow");
  const expected = [names.old1, names.old2, names.saving4, names.saved5];
  const firstFile = await downloadOne(page, names.old1); await downloadBatch(page, expected); await playFixture(page, names.old1);
  report.checks.push("single-card download and playback use its exact task", "batch downloads playable completed videos only");
  const second = fixture.records().find(item => item.id === names.new1);
  Object.assign(second, { status: "completed", mediaAvailable: true, deliveryState: "saved", videoUrl: `/api/video/proxy?taskId=${names.new1}&media_ticket=fixture`, thumbnailUrl: `/api/video/thumbnail/${names.new1}?media_ticket=fixture` });
  await header.getByRole("button", { name: "刷新", exact: true }).click(); await selectedCard(page, names.new1).waitFor(); await simpleGallery(page, 7);
  assert.equal(await root.locator('.sbh-storyboard-card[data-card-index="0"]').count(), 2);
  const secondFile = await downloadOne(page, names.new1); assert.notEqual(firstFile.name, secondFile.name);
  await playFixture(page, names.new1); await downloadBatch(page, [...expected, names.new1]);
  report.checks.push("same-segment completed attempts render as independent flat cards", "same-segment cards use distinct playback/download tasks and filenames");
  const fifth = fixture.records().find(item => item.id === names.saved5); fifth.billingState = "billing_review";
  await header.getByRole("button", { name: "刷新", exact: true }).click(); await until(() => cardDownload(page, names.saved5).isDisabled(), "UNRESOLVED_BILLING_DOWNLOAD_ENABLED");
  assert.equal(await selectedCard(page, names.saved5).locator(".sbh-card-play:enabled").count(), 0);
  fifth.billingState = "settled"; await header.getByRole("button", { name: "刷新", exact: true }).click(); await until(() => cardDownload(page, names.saved5).isEnabled(), "RESTORED_BILLING_NOT_REFRESHED");
  const ids = await root.locator(".sbh-storyboard-card").evaluateAll(cards => cards.map(card => card.dataset.taskId).sort());
  await page.reload({ waitUntil: "domcontentloaded" }); await selectedCard(page, names.new1).waitFor(); await simpleGallery(page, 7);
  assert.deepEqual(await root.locator(".sbh-storyboard-card").evaluateAll(cards => cards.map(card => card.dataset.taskId).sort()), ids);
  assert.equal(fixture.records().length, 9);
  report.checks.push("unknown billing never loosens media eligibility", "data refresh and page reload preserve all completed videos"); await screenshot(page, "gallery-two-completed-same-segment");
  await header.getByRole("button", { name: "返回分镜工作台", exact: true }).click(); await page.waitForURL("**/storyboard-workbench");
  await page.goto(origin + "/storyboard-workbench/visual-assets?projectId=" + projectId, { waitUntil: "domcontentloaded" });
  await page.locator(".sbw-assets-page .svad-page").first().waitFor();
  assert.ok(fixture.fixture.projectReads.some(read => read.id === projectId), "VISUAL_ASSETS_DID_NOT_READ_OWNED_FIXTURE_PROJECT");
  assert.equal(await page.getByText("项目不存在", { exact: true }).count(), 0);
  await screenshot(page, "adjacent-visual-assets");
  await page.goto(origin + "/video", { waitUntil: "domcontentloaded" }); await page.locator("[data-video-model-list]").first().waitFor(); await page.getByRole("button", { name: "历史", exact: true }).click();
  const generic = page.locator('.sbh-card[data-task-id="' + names.old1 + '"]'); await generic.waitFor();
  assert.equal(await page.locator(".sbh-storyboard-page").count(), 0); assert.equal(await generic.getAttribute("data-card-index"), "0");
  assert.equal(await generic.getByRole("button", { name: "播放第1段", exact: true }).count(), 1);
  await page.locator(".sbh-filters").getByRole("button", { name: /^已完成/u }).click(); assert.equal(await page.locator(".sbh-card").count(), 7); assert.ok(await generic.locator("details").count() > 0);
  await screenshot(page, "adjacent-video-generic-history"); report.checks.push("return to workbench", "visual-assets adjacent desktop regression", "video page retains generic history, details, completed filter and single index conversion");
  assert.equal(report.generationPosts.length, 0); report.checks.push("zero generation calls and no forwarded API writes or external requests");
}
let browser, context, page, stage = "current-build-identity";
await mkdir(outputRoot, { recursive: true });
try { await mkdir(output); } catch (error) {
  if (error?.code === "EEXIST") throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${output}`);
  throw error;
}
try {
  report.runtimeBefore = await identity();
  browser = await chromium.launch({ channel: process.env.STORYBOARD_BROWSER_CHANNEL || "msedge", headless: true });
  context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on("pageerror", error => report.pageErrors.push(error.message.replace(/https?:\/\/[^\s]+/gu, "[url]")));
  stage = "history-gallery-fixture-contract"; await run(page);
  assert.deepEqual(report.pageErrors, [], "BROWSER_APPLICATION_ERRORS");
  stage = "unchanged-runtime-identity"; report.runtimeAfter = await identity();
  assert.deepEqual(report.runtimeAfter, report.runtimeBefore); report.passed = true;
} catch (error) {
  report.failure = { stage, name: error?.name === "AssertionError" ? "AssertionError" : "ExecutionError", message: String(error?.message || "unknown").replace(/https?:\/\/[^\s]+/gu, "[url]").slice(0, 650) };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: false }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (context) await context.close(); if (browser) await browser.close();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
