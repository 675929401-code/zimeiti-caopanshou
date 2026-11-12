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
    imageUrl: "https://media.story.test/input.svg",
    imageWidth: 1600,
    imageHeight: 900,
    imageValidatedAt: now,
    imageRequestSnapshot: {
      runId: `storyboard-submit-binding-${runId}`,
      cardId: `storyboard-card-${runId}`,
      cardOrder: 1,
      prompt: "单幅画面，一只金毛犬站在客厅中央。",
      modelId: "acceptance-image-model",
      aspectRatio: "16:9",
      resolution: "2K",
      referenceImageUrls: [],
      strictSingleSubmit: false,
    },
    videoStatus: "idle",
  }],
};
const captured = [];
const browserErrors = [];
const projectWrites = [];
const expectedInputBlocks = [];
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
    contentType: "image/svg+xml",
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#0f172a"/></svg>'),
  }));
  await context.route("**/api/storyboard/projects**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        assert.equal(id, draft.id);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          project: { id: draft.id, title: draft.title, revision: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), submittedAt: null, cardCount: 1, document: draft },
        }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [], nextOffset: null }) });
    }
    if (request.method() === "POST") {
      const payload = request.postDataJSON();
      assert.equal(payload.document?.id, draft.id);
      projectWrites.push({ at: Date.now(), document: payload.document, expectedRevision: payload.expectedRevision });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project: {
        id: draft.id, title: draft.title, revision: projectWrites.length + 1,
        createdAt: new Date(now).toISOString(), updatedAt: new Date().toISOString(), submittedAt: null, cardCount: 1,
      } }) });
    }
    throw new Error(`Unexpected project mutation: ${request.method()}`);
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
      projectWritesBeforeSubmit: projectWrites.length,
      duration: body.duration,
      resolution: body.resolution_tier,
      aspectRatio: body.aspect_ratio,
      tokenBilling: body.tokenBilling || null,
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
  await page.goto(`${origin}/storyboard-workbench?projectId=${encodeURIComponent(draft.id)}&acceptance=${encodeURIComponent(runId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const rail = page.locator(".sbw-video-model-section");
  await rail.getByRole("button", { name: /^选择视频模型：/u }).first().waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await rail.getByRole("button", { name: /^选择视频模型：/u }).count(), models.length);
  const card = page.locator(".sbw-shot-card").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  for (const model of models) {
    console.log(JSON.stringify({ phase: "model-submit-begin", modelId: model.id, displayName: model.displayName, captured: captured.length }));
    const button = rail.getByRole("button", { name: `选择视频模型：${model.displayName}`, exact: true });
    await button.click();
    await page.waitForFunction((id) => document.querySelector(`[data-model-id="${CSS.escape(id)}"]`)?.classList.contains("is-active"), model.id, { timeout: 10_000 });
    if (model.capabilities?.billingUnit === "token") {
      const budget = page.getByRole("textbox", { name: "每条视频本次最多自动扣款金额", exact: true });
      await budget.waitFor({ state: "visible", timeout: 10_000 });
      await budget.fill("1.00");
    }
    const before = captured.length;
    const generateButton = card.getByRole("button", { name: /生成视频|重试生成/u });
    await generateButton.waitFor({ state: "visible", timeout: 15_000 });
    const handle = await generateButton.elementHandle();
    await page.waitForFunction((element) => !element.disabled, handle, { timeout: 10_000 }).catch(() => {});
    if (await generateButton.isDisabled()) {
      const title = String(await generateButton.getAttribute("title") || "");
      const diagnostic = {
        phase: "model-submit-button-disabled", modelId: model.id, displayName: model.displayName,
        title,
        notices: await page.locator(".sbw-notice").allTextContents(),
        cardStatuses: await card.locator("[role=status]").allTextContents(),
      };
      console.log(JSON.stringify(diagnostic));
      if (/尾帧|至少需要|音频|源视频|无法使用本段分镜图/u.test(title)) {
        expectedInputBlocks.push({ modelId: model.id, displayName: model.displayName, reason: title });
        continue;
      }
      throw new Error(`Generate button disabled for ${model.displayName}: ${title}`);
    }
    await generateButton.click({ trial: true, timeout: 5_000 });
    const responsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/video/generate"
      && response.request().method() === "POST"
    ), { timeout: 15_000 });
    await card.getByRole("button", { name: /生成视频|重试生成/u }).click();
    try {
      await responsePromise;
    } catch (error) {
      console.log(JSON.stringify({
        phase: "model-submit-timeout",
        modelId: model.id,
        displayName: model.displayName,
        notices: await page.locator(".sbw-notice").allTextContents(),
        cardStatuses: await card.locator("[role=status]").allTextContents(),
        cardState: await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").cards?.[0] || null, currentKey),
      }));
      await page.screenshot({ path: path.join(outputDir, `submit-timeout-${model.id}.png`), fullPage: true });
      throw error;
    }
    assert.equal(captured.length, before + 1, `No submission was captured for ${model.displayName}`);
    await card.getByText("提交绑定已核对", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
    const request = captured.at(-1);
    assert.equal(request.modelId, model.id, `Storyboard submitted another model for ${model.displayName}`);
    assert.equal(request.surface, "storyboard-workbench");
    assert.equal(request.batchTopic, draft.title, `History batch title mismatch for ${model.displayName}`);
    assert.equal(request.clientRequestIdPresent, true);
    assert.equal(request.idempotencyMatches, true);
    if (model.capabilities?.billingUnit === "token") {
      assert.deepEqual(request.tokenBilling, {
        maxChargeYuan: 1,
        priceVersion: model.tokenPricing.priceVersion,
      }, `Token billing consent mismatch for ${model.displayName}`);
    } else {
      assert.equal(request.tokenBilling, null, `Unexpected token billing consent for ${model.displayName}`);
    }
    const expectsImage = model.capabilities?.mode !== "text"
      && Number(model.capabilities?.maxReferenceImages ?? (model.capabilities?.supportsImageInput ? 1 : 0)) > 0;
    assert.equal(request.hasImage, expectsImage, `Unexpected storyboard image binding for ${model.displayName}`);
    assert.ok(request.projectWritesBeforeSubmit > 0, `Project was not saved before ${model.displayName}`);
  }
  assert.equal(captured.length + expectedInputBlocks.length, models.length);
  assert.ok(projectWrites.length >= captured.length);
  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: path.join(outputDir, "storyboard-submit-binding.png"), fullPage: true });
  const report = {
    at: new Date().toISOString(),
    buildId: version.buildId,
    passed: true,
    currentStoryboardModels: models.length,
    interceptedUiSubmissions: captured.length,
    expectedInputBlocks,
    fixtureProjectWrites: projectWrites.length,
    providerRequests: 0,
    databaseWrites: 0,
    eachSelectedPublicModelMatchedRequest: true,
    idempotencyHeadersMatched: true,
    saveBeforeSubmitVerified: true,
    records: captured,
    screenshot: path.join(outputDir, "storyboard-submit-binding.png"),
  };
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: true, buildId: report.buildId, currentStoryboardModels: models.length, interceptedUiSubmissions: captured.length, expectedInputBlocks: expectedInputBlocks.length, fixtureProjectWrites: projectWrites.length, providerRequests: 0, databaseWrites: 0, evidence: path.join(outputDir, "report.json") }));
  await context.close();
} finally {
  await browser?.close();
}
