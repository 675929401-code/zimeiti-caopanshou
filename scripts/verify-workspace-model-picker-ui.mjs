import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence", "workspace-model-picker-ui", runId);
await fs.mkdir(outputDir, { recursive: true });

const sessionResponse = await fetch(`${ORIGIN}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
  signal: AbortSignal.timeout(20_000),
});
assert.equal(sessionResponse.ok, true, "local administrator session is unavailable");
const session = await sessionResponse.json();
assert.equal(session.user?.role, "admin");

const catalogResponse = await fetch(`${ORIGIN}/api/admin/workspace-models`, {
  headers: { Authorization: `Bearer ${session.token}` },
  signal: AbortSignal.timeout(20_000),
  cache: "no-store",
});
assert.equal(catalogResponse.ok, true, "workspace catalog is unavailable");
const catalog = await catalogResponse.json();
const surface = (id) => catalog.surfaces.find((entry) => entry.id === id);

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
const response = await page.goto(`${ORIGIN}/admin?tab=workspace-models&project=storyboard`, { waitUntil: "domcontentloaded", timeout: 60_000 });
assert.equal(response?.status(), 200);
await page.locator('[data-workspace-project="storyboard"]').waitFor({ state: "visible", timeout: 60_000 });
await page.locator('[data-workspace-project="storyboard"]:visible').getByRole("button", { name: "生图模型", exact: true }).waitFor({ state: "visible", timeout: 60_000 });

const selectedRows = () => page.locator('[data-workspace-project]:visible [data-model-row]');
const picker = () => page.getByRole("dialog", { name: /从模型池添加/u });

await page.locator('[data-workspace-project="storyboard"]:visible').getByRole("button", { name: "生视频模型", exact: true }).click();
await page.waitForFunction((count) => Array.from(document.querySelectorAll('[data-workspace-project="storyboard"]')).filter((element) => element.getClientRects().length > 0).flatMap((element) => Array.from(element.querySelectorAll('[data-model-row]'))).length === count,
  surface("storyboard-video").models.filter((model) => model.assigned).length);
assert.equal(await selectedRows().count(), surface("storyboard-video").models.filter((model) => model.assigned).length);
await page.locator('[data-workspace-project="storyboard"]:visible').getByRole("button", { name: "从模型池添加" }).click();
await picker().waitFor({ state: "visible" });
assert.equal(await picker().locator("article").count(), surface("storyboard-video").models.filter((model) => !model.assigned).length);
assert.doesNotMatch(await picker().innerText(), /文生视频（AutoDL 在线）/u, "text-only models must not be offered to storyboard");
await page.screenshot({ path: path.join(outputDir, "storyboard-picker.png"), fullPage: true });
await picker().getByRole("button", { name: "关闭模型选择器" }).click();

await page.locator('[data-workspace-project-button="video"]:visible').click();
await page.locator('[data-workspace-project="video"]').waitFor({ state: "visible" });
await page.waitForFunction((count) => Array.from(document.querySelectorAll('[data-workspace-project="video"]')).filter((element) => element.getClientRects().length > 0).flatMap((element) => Array.from(element.querySelectorAll('[data-model-row]'))).length === count,
  surface("video-page").models.filter((model) => model.assigned).length);
assert.equal(await selectedRows().count(), surface("video-page").models.filter((model) => model.assigned).length);
await page.locator('[data-workspace-project="video"]:visible').getByRole("button", { name: "从模型池添加" }).click();
await picker().waitFor({ state: "visible" });
assert.equal(await picker().locator("article").count(), surface("video-page").models.filter((model) => !model.assigned).length);
await page.screenshot({ path: path.join(outputDir, "video-picker.png"), fullPage: true });

assert.deepEqual(unexpectedMutations, [], "read-only UI acceptance attempted a mutation");
assert.deepEqual(pageErrors, [], "workspace model UI emitted browser errors");

const report = {
  passed: true,
  origin: ORIGIN,
  providerGenerationRequests: 0,
  databaseWrites: 0,
  storyboardVideo: {
    selected: surface("storyboard-video").models.filter((model) => model.assigned).length,
    candidates: surface("storyboard-video").models.filter((model) => !model.assigned).length,
    textOnlyCandidates: 0,
  },
  videoPage: {
    selected: surface("video-page").models.filter((model) => model.assigned).length,
    candidates: surface("video-page").models.filter((model) => !model.assigned).length,
  },
  screenshots: [path.join(outputDir, "storyboard-picker.png"), path.join(outputDir, "video-picker.png")],
};
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await context.close();
await browser.close();
console.log(JSON.stringify(report, null, 2));
