import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = process.env.LOCAL_APP_URL || "http://127.0.0.1:5000";
assert.equal(ORIGIN, "http://127.0.0.1:5000", "Only the fixed local preview may be accepted");

const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence", "general-model-catalog-ui", runId);
await fs.mkdir(outputDir, { recursive: true });

async function readJson(url, options = {}) {
  const response = await fetch(new URL(url, ORIGIN), {
    ...options,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${url} returned ${response.status}`);
  return body;
}

const session = await readJson("/api/auth/dev-session", {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
assert.equal(session.user?.role, "admin", "Local administrator session is required");

const [imageCatalog, storyboardVideoCatalog, videoPageCatalog] = await Promise.all([
  readJson("/api/cover-models?surface=storyboard-workbench"),
  readJson("/api/video/models?surface=storyboard-workbench"),
  readJson("/api/video/models?surface=video-page"),
]);
const imageModels = Array.isArray(imageCatalog.models) ? imageCatalog.models : [];
const storyboardVideoModels = Array.isArray(storyboardVideoCatalog.models) ? storyboardVideoCatalog.models : [];
const videoPageModels = Array.isArray(videoPageCatalog.models) ? videoPageCatalog.models : [];

assert.equal(imageModels.length, 6, "Storyboard must expose the six selected non-hidden image models");
assert.ok(storyboardVideoModels.length > 0, "Storyboard must expose its explicitly selected image-capable video models");
assert.ok(videoPageModels.length >= storyboardVideoModels.length, "Video page must expose its independently selected video catalog");
assert.ok(storyboardVideoModels.every((model) => Number(model.capabilities?.maxReferenceImages || 0) >= 1),
  "Storyboard must not expose text-only video models");
assert.ok(videoPageModels.some((model) => Number(model.capabilities?.maxReferenceImages || 0) === 0),
  "Video page must keep explicitly selected text-to-video models");
assert.ok(videoPageModels.some((model) => Number(model.capabilities?.maxReferenceImages || 0) >= 1),
  "Video page must keep explicitly selected image-to-video models");
assert.ok(imageModels.slice(0, 3).every((model) => /gpt/iu.test(String(model.displayName || model.name))), "GPT image models must lead the catalog");
assert.match(String(imageModels[3]?.displayName || imageModels[3]?.name), /nano\s*banana/iu, "Nano Banana must follow the GPT group");
assert.equal(imageModels.some((model) => /qwen|glm/iu.test(String(model.displayName || model.name))), false,
  "Qwen and GLM must not appear in the selected image catalog");
assert.equal(imageModels.filter((model) => /seedream/iu.test(String(model.displayName || model.name))).length, 1,
  "Only one Seedream model may appear in the selected image catalog");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1720, height: 1080 }, serviceWorkers: "block" });
await context.addInitScript(({ origin, token, user }) => {
  if (location.origin !== origin) return;
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  sessionStorage.setItem("entered_app", "1");
}, { origin: ORIGIN, token: session.token, user: session.user });

const unexpectedMutations = [];
await context.route("**/*", async (route) => {
  const request = route.request();
  let url;
  try { url = new URL(request.url()); } catch { return route.continue(); }
  if (url.origin === ORIGIN && !["GET", "HEAD", "OPTIONS"].includes(request.method().toUpperCase())) {
    unexpectedMutations.push({ method: request.method(), pathname: url.pathname });
    return route.abort("blockedbyclient");
  }
  return route.continue();
});

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message || error).slice(0, 300)));

const storyboardResponse = await page.goto(`${ORIGIN}/storyboard-workbench?acceptance=full-model-catalog`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
assert.equal(storyboardResponse?.status(), 200, "Storyboard page did not load");
await page.waitForFunction(({ images, videos }) => (
  document.querySelectorAll(".sbw-image-model-list button").length === images
  && document.querySelectorAll(".sbw-video-model-list button").length === videos
), { images: imageModels.length, videos: storyboardVideoModels.length }, { timeout: 60_000 });

const imageButtons = page.locator(".sbw-image-model-list button");
const storyboardVideoButtons = page.locator(".sbw-video-model-list button");
assert.equal(await imageButtons.count(), imageModels.length);
assert.equal(await storyboardVideoButtons.count(), storyboardVideoModels.length);
const imageSectionText = await page.locator(".sbw-model-section").nth(0).locator("header").innerText();
const videoSectionText = await page.locator(".sbw-model-section").nth(1).locator("header").innerText();
const imageSelectable = imageModels.filter((model) => model.capabilities?.available !== false).length;
assert.match(imageSectionText, new RegExp(`${imageSelectable}\\s*可选\\s*\\/\\s*${imageModels.length}\\s*已配置`, "u"));
assert.match(videoSectionText, new RegExp(`\\d+\\s*可选\\s*\\/\\s*${storyboardVideoModels.length}\\s*已配置`, "u"));

const renderedImageNames = await imageButtons.locator(".sbw-model-name").allInnerTexts();
for (const [index, model] of imageModels.entries()) {
  const expected = String(model.displayName || model.name || "").split(" · ")[0];
  assert.ok(renderedImageNames[index]?.includes(expected), `Storyboard image order differs at ${index}: ${expected}`);
}
const storyboardSelectable = await storyboardVideoButtons.evaluateAll((buttons) => buttons.filter((button) => button.dataset.modelSelectable === "true").length);
const storyboardDisabled = storyboardVideoModels.length - storyboardSelectable;
assert.equal(storyboardSelectable, storyboardVideoModels.length, "Storyboard must only show selectable models from its explicit list");
assert.equal(storyboardDisabled, 0, "Storyboard must not render grey unavailable model cards");
await page.screenshot({ path: path.join(outputDir, "storyboard-full-catalog.png"), fullPage: true });

const videoResponse = await page.goto(`${ORIGIN}/video?acceptance=full-model-catalog`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
assert.equal(videoResponse?.status(), 200, "Video page did not load");
await page.waitForFunction((count) => document.querySelectorAll("[data-video-model-list] button[data-video-model-id]").length === count, videoPageModels.length, { timeout: 60_000 });
const videoButtons = page.locator("[data-video-model-list] button[data-video-model-id]");
assert.equal(await videoButtons.count(), videoPageModels.length);
const videoDisabled = await videoButtons.evaluateAll((buttons) => buttons.filter((button) => button.disabled).length);
assert.equal(videoDisabled, videoPageModels.filter((model) => model.capabilities?.available === false).length, "Video page disabled-state count differs from its API catalog");
assert.match(await page.locator("[data-video-model-list]").innerText(), new RegExp(`${videoPageModels.length}\\s*个`, "u"));
await page.screenshot({ path: path.join(outputDir, "video-full-catalog.png"), fullPage: true });

assert.deepEqual(unexpectedMutations, [], "Read-only catalog acceptance attempted a mutation");
assert.deepEqual(pageErrors, [], "Catalog pages emitted browser page errors");

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  administratorUi: true,
  providerGenerationRequests: 0,
  databaseWrites: 0,
  storyboard: {
    imageModels: imageModels.length,
    imageSelectable,
    videoModels: storyboardVideoModels.length,
    videoSelectable: storyboardSelectable,
    videoDisabled: storyboardDisabled,
    imageOrder: imageModels.map((model) => model.displayName || model.name),
  },
  videoPage: {
    models: videoPageModels.length,
    selectable: videoPageModels.length - videoDisabled,
    disabled: videoDisabled,
  },
  screenshots: [
    path.join(outputDir, "storyboard-full-catalog.png"),
    path.join(outputDir, "video-full-catalog.png"),
  ],
};
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await context.close();
await browser.close();
console.log(JSON.stringify(report, null, 2));
