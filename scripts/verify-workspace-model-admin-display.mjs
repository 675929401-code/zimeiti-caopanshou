#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9)
  || new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence/workspace-model-admin-display", runId);

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "RUN_ID_INVALID");
await fs.mkdir(outputDir, { recursive: true });

const sessionResponse = await fetch(`${origin}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
  signal: AbortSignal.timeout(20_000),
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "LOCAL_ADMIN_SESSION_REQUIRED");
const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${session.token}` },
  signal: AbortSignal.timeout(20_000),
});
const identity = await identityResponse.json();
assert.equal(identityResponse.status, 200, identity.error || "ADMIN_IDENTITY_FAILED");
assert.equal(identity.user?.role, "admin", "ADMIN_ROLE_REQUIRED");

const report = {
  checkedAt: new Date().toISOString(),
  origin,
  administratorUi: true,
  mutationRequests: [],
  providerGenerationRequests: 0,
  pageErrors: [],
  consoleErrors: [],
  observed: {},
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1720, height: 1050 }, serviceWorkers: "block" });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: session.token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) report.providerGenerationRequests += 1;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && url.origin === origin) {
      report.mutationRequests.push({ method: request.method(), path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
  });
  const response = await page.goto(`${origin}/admin?tab=workspace-models&project=storyboard`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, "ADMIN_WORKSPACE_PAGE_FAILED");
  await page.locator('[data-workspace-project="storyboard"]').waitFor({ state: "visible", timeout: 45_000 });
  await page.getByText("6 已添加 / 8 资源池", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByText("当前模型配置不存在，请重新加载", { exact: true }).count(), 0,
    "STORYBOARD_IMAGE_CONFIGURATION_MISSING");
  const storyboardButton = page.locator('[data-workspace-project-button="storyboard"]');
  assert.match(await storyboardButton.innerText(), /图6\s*\/\s*视25/u, "STORYBOARD_SIDEBAR_COUNT_MISMATCH");
  report.observed.storyboardImage = {
    sidebar: (await storyboardButton.innerText()).replace(/\s+/gu, " ").trim(),
    panel: "6 已添加 / 8 资源池",
  };
  await page.screenshot({ path: path.join(outputDir, "storyboard-image.png"), fullPage: true });

  await page.getByRole("button", { name: "生视频模型", exact: true }).click();
  await page.getByText("25 已添加 / 48 资源池", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByText("当前模型配置不存在，请重新加载", { exact: true }).count(), 0,
    "STORYBOARD_VIDEO_CONFIGURATION_MISSING");
  report.observed.storyboardVideo = { panel: "25 已添加 / 48 资源池" };
  await page.screenshot({ path: path.join(outputDir, "storyboard-video.png"), fullPage: true });

  const videoButton = page.locator('[data-workspace-project-button="video"]');
  await videoButton.click();
  await page.locator('[data-workspace-project="video"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("25 已添加 / 48 资源池", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await videoButton.innerText(), /25/u, "VIDEO_PAGE_SIDEBAR_COUNT_MISMATCH");
  assert.equal(await page.getByText("当前模型配置不存在，请重新加载", { exact: true }).count(), 0,
    "VIDEO_PAGE_CONFIGURATION_MISSING");
  report.observed.videoPage = {
    sidebar: (await videoButton.innerText()).replace(/\s+/gu, " ").trim(),
    panel: "25 已添加 / 48 资源池",
  };
  await page.screenshot({ path: path.join(outputDir, "video-page.png"), fullPage: true });

  assert.deepEqual(report.mutationRequests, [], "READ_ONLY_ADMIN_CHECK_ATTEMPTED_MUTATION");
  assert.equal(report.providerGenerationRequests, 0, "ADMIN_DISPLAY_CHECK_ATTEMPTED_GENERATION");
  assert.deepEqual(report.pageErrors, [], "ADMIN_DISPLAY_PAGE_ERRORS");
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, outputDir, ...report }, null, 2));
} finally {
  await browser.close();
}
