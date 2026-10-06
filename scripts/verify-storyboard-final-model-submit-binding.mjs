import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const expectedBuild = process.argv.find((value) => value.startsWith("--build="))?.slice(8);
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9);
assert.equal(origin, "http://127.0.0.1:5000");
assert.ok(token, "A verified local administrator session is required");
assert.match(expectedBuild || "", /^[A-Za-z0-9_-]{10,100}$/u);
assert.match(runId || "", /^[A-Za-z0-9_-]{8,100}$/u);

const headers = { Authorization: `Bearer ${token}` };
const api = async (pathname) => {
  const response = await fetch(`${origin}${pathname}`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${pathname} returned HTTP ${response.status}`);
  return body;
};
const [version, me, catalog] = await Promise.all([
  api("/api/version"),
  api("/api/auth/me"),
  api("/api/video/models?surface=storyboard-workbench"),
]);
assert.equal(version.buildId, expectedBuild);
assert.equal(me.user?.role, "admin");
const models = Array.isArray(catalog?.models) ? catalog.models : [];
assert.ok(models.length > 0 && models.length <= 100, "Storyboard catalog must contain a bounded public model set");
assert.ok(models.every((model) => model.capabilities?.available === true));

const outputDir = path.resolve(".codex-evidence", "storyboard-final-submit-binding", runId);
await fs.mkdir(outputDir, { recursive: true });
const currentKey = `storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(me.user.id)}`;
const now = Date.now();
const draft = {
  id: `storyboard-submit-binding-${runId}`,
  createdAt: now,
  updatedAt: now,
  ratio: "16:9",
  imageResolution: "2K",
  videoResolution: "720p",
  videoDuration: 10,
  imageModelId: "",
  videoModelId: models[0].id,
  title: "最终视频模型提交绑定验收",
  cards: [{
    id: `storyboard-card-${runId}`,
    order: 1,
    label: "镜头1",
    narration: "",
    imagePrompt: "单幅画面，一只金毛犬站在客厅中央。",
    videoPrompt: "镜头缓慢推进，金毛犬抬头看向镜头，动作自然连贯。",
    referenceImageUrls: [],
    imageStatus: "done",
    imageUrl: "https://media.story.test/input.png",
    imageValidatedAt: now,
    videoStatus: "idle",
  }],
};
const captured = [];
const browserErrors = [];
const unexpectedWrites = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ tokenValue, user, storageKey, payload }) => {
    localStorage.setItem("auth_token", tokenValue);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }, { tokenValue: token, user: me.user, storageKey: currentKey, payload: draft });
  await context.route("https://media.story.test/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n2cAAAAASUVORK5CYII=", "base64"),
  }));
  await context.route("**/api/storyboard/projects**", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [], nextOffset: null }) });
    }
    unexpectedWrites.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: { id: draft.id, revision: 1 } }) });
  });
  await context.route("**/api/video/generate", async (route) => {
    const body = route.request().postDataJSON();
    captured.push({
      modelId: body.model_id,
      surface: body.surface,
      batchTopic: body.batch_topic,
      clientRequestIdPresent: typeof body.client_request_id === "string" && body.client_request_id.length >= 8,
      idempotencyMatches: route.request().headers()["idempotency-key"] === body.client_request_id,
      hasImage: /^https:\/\//u.test(String(body.image_url || "")),
      duration: body.duration,
      resolution: body.resolution_tier,
      aspectRatio: body.aspect_ratio,
    });
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "提交绑定已核对，本次未调用上游服务",
        error_code: "ACCEPTANCE_BINDING_CAPTURED",
        task_submitted: false,
      }),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message.slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource.*422/u.test(message.text())) browserErrors.push(message.text().slice(0, 500));
  });
  await page.goto(`${origin}/storyboard-workbench?acceptance=${encodeURIComponent(runId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const rail = page.locator(".sbw-video-model-section");
  await rail.getByRole("button", { name: /^选择视频模型：/u }).first().waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await rail.getByRole("button", { name: /^选择视频模型：/u }).count(), models.length);
  const card = page.locator(".sbw-shot-card").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  for (const model of models) {
    const button = rail.getByRole("button", { name: `选择视频模型：${model.displayName}`, exact: true });
    await button.click();
    await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key) || "{}").videoModelId === id, { key: currentKey, id: model.id }, { timeout: 10_000 });
    const before = captured.length;
    const responsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/video/generate"
      && response.request().method() === "POST"
    ), { timeout: 15_000 });
    await card.getByRole("button", { name: /生成视频|重试生成/u }).click();
    await responsePromise;
    assert.equal(captured.length, before + 1, `No submission was captured for ${model.displayName}`);
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || "{}").cards?.[0]?.videoStatus === "failed", currentKey, { timeout: 15_000 });
    const request = captured.at(-1);
    assert.equal(request.modelId, model.id, `Storyboard submitted another model for ${model.displayName}`);
    assert.equal(request.surface, "storyboard-workbench");
    assert.equal(request.batchTopic, "storyboard-workbench");
    assert.equal(request.clientRequestIdPresent, true);
    assert.equal(request.idempotencyMatches, true);
    assert.equal(request.hasImage, true);
  }
  assert.equal(captured.length, models.length);
  assert.deepEqual(unexpectedWrites, []);
  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: path.join(outputDir, "storyboard-submit-binding.png"), fullPage: true });
  const report = {
    at: new Date().toISOString(),
    buildId: version.buildId,
    passed: true,
    currentStoryboardModels: models.length,
    interceptedUiSubmissions: captured.length,
    providerRequests: 0,
    databaseWrites: 0,
    eachSelectedPublicModelMatchedRequest: true,
    idempotencyHeadersMatched: true,
    records: captured,
    screenshot: path.join(outputDir, "storyboard-submit-binding.png"),
  };
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: true, buildId: report.buildId, currentStoryboardModels: models.length, interceptedUiSubmissions: captured.length, providerRequests: 0, databaseWrites: 0, evidence: path.join(outputDir, "report.json") }));
  await context.close();
} finally {
  await browser?.close();
}
