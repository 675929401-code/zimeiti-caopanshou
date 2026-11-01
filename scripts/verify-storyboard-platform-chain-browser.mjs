#!/usr/bin/env node
// Real Workbench UI, synthetic authenticated account and RAM-only API writes.
// Run only after the coordinator has built and started the current F-drive source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = "http://127.0.0.1:5000";
const output = path.resolve(".codex-evidence/storyboard-platform-chain-20261021/browser");
const recordId = createHash("sha256").update("platform-chain-local-synthetic").digest("hex");
const assetId = "platform-chain-synthetic-owned-image";
const storageKey = "fixture/storyboard/platform-chain.png";
const imageUrl = "https://media.storyboard.test/platform-chain.png";
const videoUrl = "https://media.storyboard.test/platform-chain.mp4";
const require = createRequire(import.meta.url);
let syntheticVideo;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const report = { schema: "storyboard-platform-chain-browser.v1", passed: false, checkedAt: new Date().toISOString(),
  scope: "Real current-build UI with fully synthetic catalogs, authentication, media and in-memory project APIs; no paid provider acceptance",
  forwardedWrites: 0, externalRequestsForwarded: 0, scenarios: [], visuals: [], routeErrors: [], blocked: [] };

async function identity() {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR || ".next";
  assert.ok([".next", ".next-local-acceptance", ".next-local-acceptance-next"].includes(dist));
  const [response, diskRaw, build, receiptRaw] = await Promise.all([
    fetch(`${origin}/api/version`, { redirect: "error", signal: AbortSignal.timeout(15000) }),
    readFile("public/version.json", "utf8"), readFile(path.join(dist, "BUILD_ID"), "utf8"),
    readFile(path.join(dist, "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  assert.ok(response.ok, "VERSION_READ_FAILED");
  const runtime = await response.json();
  const disk = JSON.parse(diskRaw.replace(/^\uFEFF/u, ""));
  const receipt = JSON.parse(receiptRaw.replace(/^\uFEFF/u, ""));
  const current = computeLocalBuildFingerprint(process.cwd());
  assert.ok(runtime.sourceVersion && runtime.buildId, "BUILD_ID_REQUIRED");
  assert.equal(runtime.sourceVersion, disk.sourceVersion);
  assert.equal(runtime.buildId, build.trim());
  assert.equal(receipt.buildId, runtime.buildId);
  assert.equal(receipt.fingerprint, current.fingerprint, "CURRENT_SOURCE_FINGERPRINT_MISMATCH");
  assert.equal(receipt.fileCount, current.fileCount);
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}

const imageModel = { id: "gpt-image-2-pro", displayName: "GPT-Image-2 · 渠道A pro", variantLabel: "A", publicPrice: 0.2,
  capabilities: { family: "gpt", supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ["1K", "2K", "4K"], defaultResolution: "2K" } };
const videoModel = { id: "video-720p", displayName: "图生视频 720p", publicPrice: 0.4,
  capabilities: { type: "video", durationMode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10],
    supportsImageInput: true, requiresImage: true, resolutionTier: "720p", resolutionOptions: ["720p"], defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16", "1:1"], workspaceSurfaces: ["storyboard", "video-page"] } };

function isStatic(url) {
  if (["/storyboard-workbench", "/video", "/tools", "/cover"].includes(url.pathname) || url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return false;
  try { const root = path.resolve("public"); const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`); return file.startsWith(`${root}${path.sep}`) && statSync(file).isFile(); } catch { return false; }
}

let browser;
async function prepare(name, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const state = { name, image: [], video: [], persist: [], dialogs: [], events: [], errors: [], consoleErrors: [], resourceFailures: [], queuedAttempts: [], fixture: null, png: null,
    failPersist: options.failPersist === true, failBinding: options.failBinding === true, failQueued: options.failQueued === true,
    uncertainVideo: options.uncertainVideo === true, acceptVideo: true };
  // Catch-all is registered first: narrower fixture routes run before this guard.
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    if (url.origin === new URL(imageUrl).origin && url.pathname.endsWith(".png")) return route.fulfill({ contentType: "image/png", body: state.png || Buffer.alloc(0) });
    if (url.href === videoUrl) return route.fulfill({ contentType: "video/mp4", body: syntheticVideo });
    if (url.origin !== origin) { report.blocked.push({ kind: "external", method, path: url.pathname }); return route.abort("blockedbyclient"); }
    if (url.pathname.startsWith("/api/")) {
      // Never forward any API read or write, including unrecognized status/media endpoints.
      report.blocked.push({ kind: "api", method, path: url.pathname });
      return json(route, { error: "Unconfigured synthetic fixture endpoint", tasks: [], records: [], models: [], assets: [], projects: [] }, 404);
    }
    if (method === "GET" && isStatic(url)) return route.continue();
    report.blocked.push({ kind: "other", method, path: url.pathname }); return route.abort("blockedbyclient");
  });
  state.fixture = await installStoryboardBrowserFixture(page, { origin });
  await page.route("**/api/cover-models**", route => json(route, { models: [imageModel] }));
  await page.route("**/api/video/models**", route => json(route, { models: [videoModel] }));
  for (const [endpoint, body] of Object.entries({
    "/api/video/history": { tasks: [] }, "/api/image-workbench/failure-history": { records: [], nextPage: null },
    "/api/storyboard/visual-assets": { assets: [], nextOffset: null },
    "/api/cash/balance": { balance: 1000 }, "/api/settings/video-page": { config: {} },
    "/api/video/active-tasks": { activeTasks: [] },
    "/api/extract/history": { history: [] },
    "/api/tools/runtime-catalog": { items: Object.fromEntries([
      ...[["video", "视频提取"], ["text", "文案提取"], ["batch", "批量提取"], ["search", "搜索提取"]].map(([key, service]) => [key, { available: true, pricingReady: true, service, provider: "Synthetic fixture", model: "Synthetic extraction", unitPrice: 0.1, currency: "CNY", unit: "条" }]),
      ["formatter", { available: true, service: "文字排版", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" }],
      ["segmenter", { available: true, service: "智能分段", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" }],
    ]) },
  })) await page.route(`**${endpoint}**`, route => json(route, body));
  if (options.rateLimitQueued) await page.route("**/api/storyboard/projects**", route => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = request.postDataJSON();
    if (!body.document?.cards?.some(card => card.imageAssetId === assetId && card.videoStatus === "queued")) return route.fallback();
    state.queuedAttempts.push({ at: Date.now(), document: structuredClone(body.document) });
    if (state.queuedAttempts.length === 1) {
      state.events.push("queued-save-rate-limited");
      return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "1" }, body: JSON.stringify({ error: "Synthetic project rate limit", code: "RATE_LIMIT_EXCEEDED", retryAfter: 1 }) });
    }
    state.events.push("queued-save-accepted");
    return route.fallback();
  });
  if (state.failBinding || state.failQueued) await page.route("**/api/storyboard/projects**", route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.document?.cards?.some(card => card.imageAssetId === assetId && (state.failBinding || card.videoStatus === "queued"))) {
      state.events.push(state.failQueued ? "queued-save-rejected" : "binding-rejected");
      return json(route, { error: state.failQueued ? "Synthetic queued snapshot rejected" : "Synthetic binding rejected" }, 503);
    }
    return route.fallback();
  });
  await page.route("**/api/image/generate", async route => {
    try {
      const body = route.request().postDataJSON(); state.image.push(body); state.events.push("image");
      const [width, height] = ({ "16:9": [320, 180], "9:16": [180, 320], "1:1": [256, 256] })[body.aspectRatio];
      state.png = await sharp({ create: { width, height, channels: 3, background: "#7054d8" } }).png().toBuffer();
      state.dimensions = { width, height };
      const owned = options.owned === true;
      return json(route, { recordId, state: "completed", cashCharged: 0.2, billed: true,
        ...(owned ? {} : { deliveryMode: "inline_ephemeral" }), images: [{ recordId, ...state.dimensions,
          ...(owned ? { url: imageUrl, assetId, storageKey } : { url: `data:image/png;base64,${state.png.toString("base64")}`, deliveryMode: "inline_ephemeral", ephemeral: true }),
          mediaAvailable: true, canRecover: false, dimensionsVerified: true }] });
    } catch (error) { report.routeErrors.push({ scenario: name, endpoint: "image", message: error.message }); return json(route, { error: "fixture error" }, 500); }
  });
  await page.route("**/api/image-workbench/persist", route => {
    const body = route.request().postDataJSON(); state.persist.push(body); state.events.push("persist");
    assert.equal(body.intent, "user_asset_export");
    assert.equal(body.url, `data:image/png;base64,${state.png.toString("base64")}`, "ORIGINAL_BYTES_CHANGED");
    return state.failPersist ? json(route, { error: "Synthetic original save rejected" }, 503) : json(route, { assetId, key: storageKey });
  });
  await page.route("**/api/storyboard/image**", route => json(route, { assetId, storageKey, url: imageUrl }));
  await page.route("**/api/video/generate", route => {
    const body = route.request().postDataJSON(); state.video.push(body); state.events.push("video");
    assert.ok(state.fixture.projectWrites.some(write => write.document.cards.some(card => card.imageAssetId === assetId)), "OWNED_BINDING_NOT_SAVED");
    assert.equal(body.image_storage_key, storageKey);
    assert.equal(route.request().headers()["idempotency-key"], body.client_request_id);
    return state.uncertainVideo ? json(route, { error: "Synthetic uncertain submission" }, 503)
      : json(route, { status: "completed", task_id: "fixture-video", video_url: videoUrl, price: 0.4, billing_state: "settled" });
  });
  await page.route("**/api/video/request-status**", route => json(route, { found: false, canResubmit: true, sameRequestKeyRequired: true }));
  await page.route("**/api/video/access-ticket**", route => json(route, { url: videoUrl }));
  page.on("pageerror", error => state.errors.push(error.name));
  page.on("response", response => {
    if (response.status() >= 400) state.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  page.on("console", message => { if (message.type() === "error") state.consoleErrors.push(message.text().slice(0, 250)); });
  page.on("dialog", async dialog => { const kind = /生成段落\d+视频/u.test(dialog.message()) ? "video" : "other"; state.dialogs.push(kind); state.events.push(`confirm-${kind}`); await (kind === "video" && !state.acceptVideo ? dialog.dismiss() : dialog.accept()); });
  page.setDefaultTimeout(30000);
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor();
  await page.locator('.sbw-image-model-list button[data-model-selectable="true"]').first().click();
  await page.locator(".sbw-video-model-list button").first().click();
  for (const label of ["图片比例", "视频比例"]) await page.locator(`.sbw-ratio-control[aria-label="${label}"] button`).filter({ hasText: /^16:9$/u }).click();
  const card = page.locator(".sbw-shot-card").first();
  await card.locator('textarea[aria-label$="生图提示词"]').fill("Synthetic fixture: purple board with one subject.");
  await card.locator('textarea[aria-label$="视频提示词"]').fill("The subject gently turns while the camera remains still.");
  await card.locator(".is-image-command").click();
  await card.locator(".sbw-shared-media-frame.has-result img").waitFor({ state: "visible" });
  await card.locator(".sbw-shared-media-frame img").evaluate(image => image.decode());
  return { ...state, context, page, card, state };
}

async function until(test, message) { const end = Date.now() + 20000; while (!test() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(test(), message); }
async function readySameKeyRetry(page, card) {
  await page.waitForFunction(() => /^(?:重试视频|刷新视频)$/u.test(document.querySelector(".sbw-shot-card .is-video-command")?.textContent?.trim() || ""));
  const command = card.locator(".is-video-command");
  if ((await command.innerText()).trim() === "刷新视频") await command.click();
  const retry = card.getByRole("button", { name: "重试视频", exact: true });
  await retry.waitFor();
  return retry;
}
function result(state, extra = {}) {
  assert.deepEqual(state.errors, [], "BROWSER_PAGE_ERRORS");
  const actualConsoleErrors = state.consoleErrors.filter(message => !/^Failed to load resource:/u.test(message));
  const fixtureResourceConsoleErrors = state.consoleErrors.filter(message => /^Failed to load resource:/u.test(message));
  const resourceFailures = state.resourceFailures.map(failure => ({ ...failure, classification:
    report.blocked.some(blocked => blocked.path === failure.path) ? "fixture-api-or-network-guard"
      : [429, 503].includes(failure.status) && ["/api/storyboard/projects", "/api/image-workbench/persist", "/api/video/generate"].includes(failure.path)
        ? "injected-fixture-fault" : "unexpected-resource-error" }));
  assert.deepEqual(actualConsoleErrors, [], "UNEXPECTED_APPLICATION_CONSOLE_ERRORS");
  assert.deepEqual(resourceFailures.filter(failure => failure.classification === "unexpected-resource-error"), [], "UNEXPECTED_RESOURCE_ERRORS");
  report.scenarios.push({ name: state.name, passed: true, imagePosts: state.image.length, persistPosts: state.persist.length,
    videoPosts: state.video.length, confirmations: state.dialogs, events: state.events, pageErrors: state.errors,
    console: { actualApplicationErrors: actualConsoleErrors, fixtureResourceErrors: fixtureResourceConsoleErrors,
      resourceFailures,
      classificationScope: "Resource failures are emitted by the full API guard or explicit synthetic failure routes; application console messages are checked separately." }, ...extra });
}
async function visual(page, route, width) {
  await page.setViewportSize({ width, height: 900 });
  if (new URL(page.url()).pathname !== route) await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
  await page.locator("main").first().waitFor();
  await page.waitForTimeout(500);
  const metrics = await page.evaluate(() => {
    const body = getComputedStyle(document.body); const card = document.querySelector(".sbw-shot-card"); const style = card && getComputedStyle(card);
    return { route: location.pathname, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      bodyColor: body.color, bodyBackground: body.backgroundColor, fontFamily: body.fontFamily,
      card: card ? { width: Math.round(card.getBoundingClientRect().width), color: style.color, background: style.backgroundColor } : null };
  });
  assert.equal(metrics.route, route); assert.ok(metrics.scrollWidth <= width + 2, "PAGE_HORIZONTAL_OVERFLOW");
  await page.screenshot({ path: path.join(output, `${route.slice(1)}-${width}.png`), fullPage: false });
  report.visuals.push(metrics);
}

await mkdir(output, { recursive: true });
try {
  report.runtimeBefore = await identity();
  const renderedVideo = spawnSync(require("ffmpeg-static"), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=purple:s=160x90:r=5", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.equal(renderedVideo.status, 0, "SYNTHETIC_VIDEO_RENDER_FAILED");
  syntheticVideo = renderedVideo.stdout;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  {
    const { page, card, context, state } = await prepare("owned-image-cancel", { owned: true });
    state.acceptVideo = false;
    await card.locator(".is-video-command").click();
    await until(() => state.dialogs.includes("video"), "VIDEO_CONFIRMATION_MISSING");
    await page.waitForTimeout(300);
    assert.equal(state.video.length, 0); assert.equal(state.persist.length, 0);
    result(state);
    await visual(page, "/storyboard-workbench", 1440);
    await visual(page, "/storyboard-workbench", 1880);
    await visual(page, "/video", 1440);
    await visual(page, "/tools", 1440);
    assert.equal(await page.getByText("无法读取通道配置，提交已暂停", { exact: true }).count(), 0, "TOOLS_CATALOG_FIXTURE_FAILED");
    report.neighborConsole = { pageErrors: [...state.errors], consoleErrors: [...state.consoleErrors] };
    assert.deepEqual(state.errors, [], "NEIGHBOR_PAGE_ERRORS");
    await context.close();
  }
  {
    const { page, card, context, state } = await prepare("inline-save-bind-generate-and-switch");
    assert.match(await card.locator(".is-video-command").innerText(), /保存分镜并生成视频/u);
    await card.locator(".is-video-command").click();
    await until(() => state.video.length === 1, "SINGLE_CLICK_DID_NOT_SUBMIT_VIDEO");
    await until(() => state.fixture.latestDocument()?.cards.some(item => item.videoStatus === "done"), "VIDEO_COMPLETION_NOT_SAVED");
    assert.equal(state.persist.length, 1);
    assert.ok(state.events.indexOf("persist") < state.events.indexOf("confirm-video"));
    assert.ok(state.events.indexOf("confirm-video") < state.events.indexOf("video"));
    const counts = [state.image.length, state.video.length, state.persist.length, state.dialogs.length];
    await card.getByRole("button", { name: "查看图片", exact: true }).click();
    await card.getByRole("button", { name: "查看视频", exact: true }).click();
    await page.waitForTimeout(400);
    assert.deepEqual([state.image.length, state.video.length, state.persist.length, state.dialogs.length], counts, "MEDIA_SWITCH_CREATED_REQUEST");
    result(state, { ownedProjectBindingBeforeVideo: true, originalBytesPreserved: true, mediaSwitchZeroGeneration: true });
    await page.screenshot({ path: path.join(output, "inline-saved-video.png"), fullPage: false });
    await context.close();
  }
  for (const failure of ["persist", "binding"]) {
    const { page, card, context, state } = await prepare(`${failure}-failure-blocks-video`, { failPersist: failure === "persist", failBinding: failure === "binding" });
    await card.locator(".is-video-command").click();
    await until(() => state.persist.length === 1, "SAVE_NOT_ATTEMPTED");
    await page.locator(".sbw-notice").filter({ hasText: failure === "persist" ? /Synthetic original save rejected/u : /项目绑定未确认/u }).waitFor();
    assert.equal(state.video.length, 0); assert.equal(state.dialogs.filter(kind => kind === "video").length, 0);
    assert.match(await card.locator(".is-video-command").innerText(), /保存分镜并生成视频/u);
    result(state); await context.close();
  }
  {
    const { page, card, context, state } = await prepare("owned-video-queued-snapshot-save-failure", { owned: true, failQueued: true });
    await card.locator(".is-video-command").click();
    await until(() => state.events.includes("queued-save-rejected"), "QUEUED_SNAPSHOT_SAVE_NOT_ATTEMPTED");
    await page.locator(".sbw-notice").filter({ hasText: /本次未提交/u }).waitFor();
    assert.equal(state.video.length, 0, "VIDEO_DISPATCHED_AFTER_QUEUED_SAVE_FAILURE");
    assert.equal(state.persist.length, 0);
    assert.equal(state.dialogs.filter(kind => kind === "video").length, 1);
    assert.equal(await card.locator(".sbw-shared-media-frame.has-result img").count(), 1, "OWNED_IMAGE_LOST_AFTER_QUEUED_SAVE_FAILURE");
    assert.ok(await card.locator(".is-video-command").isEnabled(), "VIDEO_GATE_NOT_ROLLED_BACK");
    result(state, { queuedSnapshotFailureBeforeDispatch: true, ownedImageRetained: true }); await context.close();
  }
  {
    const { page, card, context, state } = await prepare("project-429-cooldown-and-latest-manual-video", { owned: true, rateLimitQueued: true });
    const command = card.locator(".is-video-command");
    await command.click();
    await until(() => state.queuedAttempts.length === 1, "QUEUED_SNAPSHOT_RATE_LIMIT_NOT_EXERCISED");
    await page.locator(".sbw-notice").filter({ hasText: /本次未提交/u }).waitFor();
    assert.equal(state.video.length, 0, "VIDEO_SUBMITTED_AFTER_PROJECT_429");
    assert.equal(await card.locator(".sbw-shared-media-frame.has-result img").count(), 1, "IMAGE_LOST_AFTER_PROJECT_429");
    assert.ok(Date.now() - state.queuedAttempts[0].at < 1000, "COOLDOWN_ASSERTION_WINDOW_MISSED");
    await command.click();
    await page.locator(".sbw-notice").filter({ hasText: /本次未提交/u }).waitFor();
    assert.equal(state.queuedAttempts.length, 1, "COOLDOWN_MANUAL_CLICK_SENT_ANOTHER_PROJECT_POST");
    assert.equal(state.video.length, 0, "COOLDOWN_MANUAL_CLICK_SENT_VIDEO");
    const latestPrompt = "Latest manual request: the subject slowly walks left as the camera stays still.";
    await card.locator('textarea[aria-label$="视频提示词"]').fill(latestPrompt);
    const remaining = Math.max(0, 1100 - (Date.now() - state.queuedAttempts[0].at));
    await page.waitForTimeout(remaining);
    assert.equal(state.video.length, 0, "COOLDOWN_EXPIRY_AUTOMATICALLY_DISPATCHED_VIDEO");
    await command.click();
    await until(() => state.video.length === 1, "EXPIRED_COOLDOWN_MANUAL_VIDEO_NOT_SUBMITTED");
    assert.equal(state.queuedAttempts.length, 2, "LATEST_MANUAL_QUEUED_SAVE_COUNT_MISMATCH");
    assert.equal(state.video[0].prompt, latestPrompt);
    assert.equal(state.queuedAttempts[1].document.cards[0].videoPrompt, latestPrompt);
    assert.equal(state.image.length, 1, "RATE_LIMIT_REGENERATED_IMAGE");
    result(state, { rateLimitStatus: 429, retryAfterSeconds: 1, queuedSaveAttempts: 2, cooldownClickQueuedPosts: 0,
      automaticVideoPostsAfterExpiry: 0, latestPromptSubmitted: true, imageRetained: true });
    await context.close();
  }
  {
    const { page, card, context, state } = await prepare("same-key-retry-and-edited-payload-block", { owned: true, uncertainVideo: true });
    await card.locator(".is-video-command").click();
    await until(() => state.video.length === 1, "FIRST_VIDEO_MISSING");
    // The first uncertain response can be reconciled automatically or manually.
    const retry = await readySameKeyRetry(page, card);
    await retry.click();
    await until(() => state.video.length === 2, "RETRY_VIDEO_MISSING");
    assert.equal(state.video[0].client_request_id, state.video[1].client_request_id, "SAME_KEY_RETRY_CHANGED_ID");
    await readySameKeyRetry(page, card);
    await card.locator('textarea[aria-label$="视频提示词"]').fill("Changed payload must not reuse an uncertain request key.");
    await retry.click(); await page.waitForTimeout(700);
    assert.equal(state.video.length, 2, "EDITED_PAYLOAD_REPLAYED_UNCERTAIN_REQUEST");
    result(state, { sameRequestId: true, editedPayloadBlocked: true }); await context.close();
  }
  assert.deepEqual(report.routeErrors, []);
  report.runtimeAfter = await identity();
  assert.deepEqual(report.runtimeAfter, report.runtimeBefore, "RUNTIME_CHANGED");
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message.split("\n")[0] };
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.map(item => item.name), failure: report.failure, forwardedWrites: 0 }));
}
