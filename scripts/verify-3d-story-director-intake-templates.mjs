import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const evidenceDir = path.resolve(".codex-evidence/story-director-intake-template-20260928");
const movieId = "agent-1786633444187-594spj";
const highId = "agent-1786843330392-emdjv2";

assert.ok(token, "请通过 scripts/with-local-admin-session.mjs 启动本验收脚本");
assert.equal(origin, "http://127.0.0.1:5000", "只允许验收F盘本地5000运行时");

const versionResponse = await fetch(`${origin}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
const servedVersion = await versionResponse.json();
assert.ok(versionResponse.ok && servedVersion.buildId && servedVersion.sourceVersion, "本地版本接口不可用");
const diskBuildId = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
const sourceVersion = JSON.parse(await fs.readFile(path.resolve("public/version.json"), "utf8")).sourceVersion;
assert.equal(servedVersion.buildId, diskBuildId, "5000运行Build ID与磁盘构建不一致");
assert.equal(servedVersion.sourceVersion, sourceVersion, "5000运行sourceVersion与源码不一致");
const fingerprint = spawnSync(process.execPath, ["scripts/local-build-fingerprint.mjs", "verify", process.cwd()], {
  encoding: "utf8",
});
assert.equal(fingerprint.status, 0, `本地构建源码指纹过期：${fingerprint.stderr || fingerprint.stdout}`);

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === "admin", "本地管理员身份不可用");

const botsResponse = await fetch(`${origin}/api/bots?shape=agents&verify=story-intake-${Date.now()}`, {
  headers: { Authorization: `Bearer ${token}` },
  cache: "no-store",
  signal: AbortSignal.timeout(10_000),
});
const botsPayload = await botsResponse.json();
assert.ok(botsResponse.ok && Array.isArray(botsPayload.agents), "智能体目录接口不可用");
const movieConfig = botsPayload.agents.find((agent) => agent.id === movieId);
const highConfig = botsPayload.agents.find((agent) => agent.id === highId);
assert.ok(movieConfig && highConfig, "两张3D故事导演卡片缺失");

const generationModelOptions = [
  "自动通用（分镜工作台再选择模型）",
  "MiniMax H3（官方结构适配）",
  "Omni Flash（官方时序与音轨适配）",
  "Grok Imagine（官方图生视频适配）",
];

const movieFields = movieConfig.preset_fields;
assert.deepEqual(movieFields.map((field) => field.id), [
  "segmented_script",
  "target_duration_seconds",
  "video_model_profile",
  "aspect_ratio",
  "owner_gender",
  "dog_breed",
  "animation_style",
  "special_notes",
]);
assert.deepEqual(movieFields.find((field) => field.id === "target_duration_seconds")?.options, [
  "10秒版：每段3-4个镜头",
  "15秒版：每段4-5个镜头",
]);
assert.equal(movieFields.find((field) => field.id === "target_duration_seconds")?.defaultValue, "10秒版：每段3-4个镜头");
assert.deepEqual(movieFields.find((field) => field.id === "video_model_profile")?.options, generationModelOptions);
assert.equal(movieFields.find((field) => field.id === "video_model_profile")?.label, "生成模型");
assert.deepEqual(movieFields.find((field) => field.id === "aspect_ratio")?.options, ["16:9", "9:16"]);
assert.equal(movieFields.find((field) => field.id === "aspect_ratio")?.defaultValue, "16:9");
assert.equal(movieFields.find((field) => field.id === "animation_style")?.options.length, 10);
assert.deepEqual(movieFields.find((field) => field.id === "owner_gender")?.options, [
  "文案优先，未指定默认女主人",
  "女主人",
  "男主人",
]);
assert.equal(movieFields.find((field) => field.id === "owner_gender")?.defaultValue, "文案优先，未指定默认女主人");
assert.equal(movieFields.find((field) => field.id === "dog_breed")?.required, false);
assert.equal(movieFields.find((field) => field.id === "dog_breed")?.options.length, 20);
assert.equal(movieFields.find((field) => field.id === "dog_breed")?.defaultValue, undefined);

const highGenerationModel = highConfig.preset_fields.find((field) => field.id === "video_model_profile");
assert.equal(highConfig.preset_fields.some((field) => field.id === "storyboard_form"), false);
assert.equal(highGenerationModel?.label, "生成模型");
assert.deepEqual(highGenerationModel?.options, generationModelOptions);
assert.deepEqual(highConfig.preset_fields.find((field) => field.id === "segment_duration")?.options, [
  "8秒版：每段3个镜头",
  "10秒版：每段3-4个镜头",
  "15秒版：每段4-6个镜头",
]);
assert.equal(highConfig.preset_fields.find((field) => field.id === "animation_style")?.options.length, 6);

await fs.mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const paidRequests = [];
const browserErrors = [];
const serverErrors = [];
const ignoredTelemetryErrors = [];
const screenshots = {};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ localToken, user }) => {
    localStorage.setItem("auth_token", localToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { localToken: token, user: identity.user });

  const page = await context.newPage();
  page.on("request", (request) => {
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(request.url())) paidRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/product-usage\/events.*503|503.*product-usage\/events/iu.test(message.text())) {
      ignoredTelemetryErrors.push({ kind: "console", message: message.text() });
      return;
    }
    browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 500) return;
    if (new URL(response.url()).pathname === "/api/product-usage/events") {
      ignoredTelemetryErrors.push({ kind: "response", status: response.status(), url: response.url() });
      return;
    }
    serverErrors.push({ status: response.status(), url: response.url() });
  });

  await page.goto(`${origin}/?verify=story-director-intake`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(`[data-agent-card-id="${movieId}"]`).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(`[data-agent-card-id="${movieId}"]`).click();

  const movieDialog = page.locator(".fixed.inset-0.z-50").filter({ hasText: "3D故事导演｜电影叙事" });
  await movieDialog.waitFor({ state: "visible", timeout: 15_000 });
  await movieDialog.getByText("分段文案", { exact: true }).waitFor();
  await movieDialog.getByText("分段时长", { exact: true }).waitFor();
  await movieDialog.getByText("生成模型", { exact: true }).waitFor();
  await movieDialog.getByText("视频比例", { exact: true }).waitFor();
  await movieDialog.getByText("选择动画风格", { exact: true }).waitFor();
  await movieDialog.getByText("主人性别", { exact: true }).waitFor();
  await movieDialog.getByText("狗狗品种", { exact: true }).waitFor();

  const durationSelect = movieDialog.locator("#preset-target_duration_seconds");
  const modelSelect = movieDialog.locator("#preset-video_model_profile");
  const ratioSelect = movieDialog.locator("#preset-aspect_ratio");
  const ownerSelect = movieDialog.locator("#preset-owner_gender");
  const breedSelect = movieDialog.locator("#preset-dog_breed");
  const breedLabel = movieDialog.locator("label").filter({ hasText: "狗狗品种" });
  assert.equal(await durationSelect.inputValue(), "10秒版：每段3-4个镜头");
  assert.equal(await modelSelect.inputValue(), generationModelOptions[0]);
  assert.equal(await ratioSelect.inputValue(), "16:9");
  assert.equal(await ownerSelect.inputValue(), "文案优先，未指定默认女主人");
  assert.equal(await breedSelect.inputValue(), "");
  assert.equal(await breedSelect.locator('option[value=""]').getAttribute("hidden"), null, "狗狗品种的不选项仍被隐藏");
  assert.equal((await breedSelect.locator('option[value=""]').textContent())?.trim(), "不选：按文案识别犬种");
  assert.equal((await breedLabel.textContent())?.trim(), "狗狗品种", "狗狗品种仍显示为必填项");
  await breedSelect.selectOption({ label: "哈士奇" });
  assert.equal(await breedSelect.inputValue(), "哈士奇", "无法明确选择哈士奇");
  await breedSelect.selectOption("");
  assert.equal(await breedSelect.inputValue(), "", "选择犬种后无法恢复不选状态");
  assert.deepEqual(await durationSelect.locator("option").allTextContents(), [
    "选择每段视频时长",
    "10秒版：每段3-4个镜头",
    "15秒版：每段4-5个镜头",
  ]);

  const geometry = await movieDialog.evaluate((dialog) => {
    const byId = (id) => dialog.querySelector(id)?.getBoundingClientRect();
    const duration = byId("#preset-target_duration_seconds");
    const model = byId("#preset-video_model_profile");
    const ratio = byId("#preset-aspect_ratio");
    const style = byId("#preset-animation_style");
    const owner = byId("#preset-owner_gender");
    const breed = byId("#preset-dog_breed");
    const body = dialog.querySelector(".chat-scroll");
    if (!duration || !model || !ratio || !style || !owner || !breed || !body) throw new Error("接收卡字段或滚动容器缺失");
    return {
      duration: { x: duration.x, y: duration.y, width: duration.width },
      model: { x: model.x, y: model.y, width: model.width },
      ratio: { x: ratio.x, y: ratio.y, width: ratio.width },
      style: { x: style.x, y: style.y, width: style.width },
      owner: { x: owner.x, y: owner.y, width: owner.width },
      breed: { x: breed.x, y: breed.y, width: breed.width },
      horizontalOverflow: body.scrollWidth - body.clientWidth,
      verticalOverflow: body.scrollHeight - body.clientHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  assert.ok(Math.abs(geometry.duration.y - geometry.model.y) <= 2, "分段时长与生成模型未处于同一行");
  assert.ok(Math.abs(geometry.ratio.y - geometry.owner.y) <= 2, "视频比例与主人性别未处于同一行");
  assert.ok(Math.abs(geometry.breed.y - geometry.style.y) <= 2, "狗狗品种与动画风格未处于同一行");
  assert.ok(geometry.horizontalOverflow <= 1, "电影叙事接收卡存在横向溢出");

  screenshots.movie = path.resolve(evidenceDir, "movie-intake-1440x900.png");
  await page.screenshot({ path: screenshots.movie, fullPage: false });
  await movieDialog.locator("button").filter({ has: page.locator("svg") }).first().click().catch(async () => page.keyboard.press("Escape"));
  await movieDialog.waitFor({ state: "hidden", timeout: 10_000 });

  await page.locator(`[data-agent-card-id="${highId}"]`).waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(`[data-agent-card-id="${highId}"]`).click();
  const highDialog = page.locator(".fixed.inset-0.z-50").filter({ hasText: "3D故事导演｜高能版" });
  await highDialog.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await highDialog.locator("#preset-video_model_profile").inputValue(), generationModelOptions[0]);
  assert.deepEqual((await highDialog.locator("#preset-video_model_profile option").allTextContents()).slice(1), generationModelOptions);
  assert.deepEqual((await highDialog.locator("#preset-segment_duration option").allTextContents()).slice(1), [
    "8秒版：每段3个镜头",
    "10秒版：每段3-4个镜头",
    "15秒版：每段4-6个镜头",
  ]);
  assert.equal((await highDialog.locator("#preset-animation_style option").allTextContents()).length, 7);
  screenshots.high = path.resolve(evidenceDir, "high-energy-protected-1440x900.png");
  await page.screenshot({ path: screenshots.high, fullPage: false });
  await page.keyboard.press("Escape");

  const adjacentPages = [];
  for (const route of ["/storyboard-workbench?verify=story-intake-adjacent", "/video?verify=story-intake-adjacent"]) {
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("body").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => ({
      pathname: location.pathname,
      bodyTextLength: document.body.innerText.trim().length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert.ok(metrics.bodyTextLength > 20, `${route}未渲染有效内容`);
    assert.ok(metrics.horizontalOverflow <= 1, `${route}存在横向溢出`);
    adjacentPages.push(metrics);
  }

  assert.deepEqual(paidRequests, [], "零成本验收不应触发对话、图片或视频生成");
  assert.deepEqual(serverErrors, [], `页面存在5xx：${JSON.stringify(serverErrors)}`);
  let telemetryConsoleAllowance = ignoredTelemetryErrors.filter((item) => item.kind === "response").length;
  const unexpectedBrowserErrors = browserErrors.filter((message) => {
    if (/429|favicon|ResizeObserver loop/iu.test(message)) return false;
    if (telemetryConsoleAllowance > 0 && /Failed to load resource: the server responded with a status of 503/iu.test(message)) {
      telemetryConsoleAllowance -= 1;
      return false;
    }
    return true;
  });
  assert.deepEqual(unexpectedBrowserErrors, [], `浏览器错误：${unexpectedBrowserErrors.join(" | ")}`);

  const report = {
    status: "passed",
    origin,
    sourceVersion,
    buildId: diskBuildId,
    sourceFingerprintCurrent: true,
    viewport: "1440x900",
    movieFields: movieFields.map((field) => field.id),
    durationOptions: movieFields.find((field) => field.id === "target_duration_seconds")?.options,
    ratioDefault: movieFields.find((field) => field.id === "aspect_ratio")?.defaultValue,
    ownerGenderDefault: movieFields.find((field) => field.id === "owner_gender")?.defaultValue,
    dogBreedDefault: movieFields.find((field) => field.id === "dog_breed")?.defaultValue ?? null,
    dogBreedOptionalAndClearable: true,
    movieGeometry: geometry,
    generationModelOptions,
    protectedHighDurationOptions: highConfig.preset_fields.find((field) => field.id === "segment_duration")?.options,
    protectedMovieStyleCount: movieFields.find((field) => field.id === "animation_style")?.options.length,
    protectedHighStyleCount: highConfig.preset_fields.find((field) => field.id === "animation_style")?.options.length,
    adjacentPages,
    paidCalls: 0,
    serverErrors: 0,
    unexpectedBrowserErrors: 0,
    ignoredNonCriticalTelemetryErrors: ignoredTelemetryErrors.length,
    screenshots,
  };
  const versionedReport = `verification-${sourceVersion}-${diskBuildId}.json`;
  await fs.writeFile(path.resolve(evidenceDir, versionedReport), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.resolve(evidenceDir, "verification.json"), `${JSON.stringify({ ...report, versionedReport }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
