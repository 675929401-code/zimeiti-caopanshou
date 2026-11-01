import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const outputDir = path.resolve(".codex-screenshots");
await mkdir(outputDir, { recursive: true });
const fixtureDir = path.resolve(".tmp-e2e/storyboard-workbench-full-flow");
const videoFixturePath = path.join(fixtureDir, "fixture.mp4");
await mkdir(fixtureDir, { recursive: true });
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const videoGeneration = spawnSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5",
  "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  videoFixturePath,
], { encoding: "utf8" });
assert.equal(videoGeneration.status, 0, videoGeneration.stderr || "无法生成自包含视频夹具");
const validVideo = await readFile(videoFixturePath);

const browser = await chromium.launch({ headless: true });
const results = [];
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAEtgJ8k7zwNQAAAABJRU5ErkJggg==",
  "base64",
);

async function preparePage({ failImages = false, viewport = { width: 1600, height: 1000 } } = {}) {
  const context = await browser.newContext({
    viewport,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const imageRequests = [];
  const videoRequests = [];
  const uploadRequests = [];
  const downloadRequests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], models: [], assets: [], tasks: [] }) });
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    return route.continue();
  });
  const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl, resetStorage: false });
  await page.addInitScript(() => {
    window.__storyboardDownloadNames = [];
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function captureStoryboardDownload() {
      if (this.download) {
        window.__storyboardDownloadNames.push(this.download);
        return;
      }
      return nativeClick.call(this);
    };
  });
  await page.route("**/api/cover-models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [
        { id: "gpt-image-2-pro", displayName: "GPT-Image-2 · 渠道A pro", variantLabel: "A", publicPrice: 0.2, capabilities: { family: "gpt", supportsImageInput: true, maxReferenceImages: 8, resolutionOptions: ["1K", "2K", "4K"], defaultResolution: "2K" } },
        { id: "gemini-image-pro", name: "Gemini Image 多图参考", model_name: "gemini-image", selling_price: 0.18, supports_image_input: true, resolution_options: ["1K", "2K", "4K"], default_resolution: "2K" },
      ],
    }),
  }));
  await page.route("**/api/video/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [
        { id: "video-720p", displayName: "图生视频 720p", publicPrice: 0.4, available: true, priceReady: true, capabilities: { type: "video", durationMode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10], supportsImageInput: true, requiresImage: true, resolutionTier: "720p", resolutionOptions: ["720p"], defaultResolution: "720p", aspectRatios: ["16:9", "9:16", "1:1"], workspaceSurfaces: ["storyboard"] } },
        { id: "video-1080p", displayName: "图生视频 1080p", publicPrice: 0.8, available: true, priceReady: true, capabilities: { type: "video", durationMode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10], supportsImageInput: true, requiresImage: true, resolutionTier: "1080p", resolutionOptions: ["1080p"], defaultResolution: "1080p", aspectRatios: ["16:9", "9:16", "1:1"], workspaceSurfaces: ["storyboard"] } },
      ],
    }),
  }));
  await page.route("**/api/storage/upload", (route) => {
    uploadRequests.push({ at: Date.now(), contentType: route.request().headers()["content-type"] || "" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, file: { key: "storyboard/references/full-flow-character.png" } }) });
  });
  await page.route("**/api/storyboard/image?**", (route) => {
    const requestUrl = new URL(route.request().url());
    const storageKey = requestUrl.searchParams.get("storageKey") || "storyboard/references/full-flow-character.png";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://media.storyboard.test/uploaded-reference.png",
        assetId: "full-flow-reference-asset",
        storageKey,
      }),
    });
  });
  await page.route("**/api/storyboard/visual-assets**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ assets: [] }),
  }));
  await page.route("**/api/storyboard/presets**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ presets: [], assets: [], canManage: false }),
  }));
  await page.route("https://media.storyboard.test/uploaded-reference.png", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: transparentPng,
  }));
  await page.route("**/api/image/generate", (route) => {
    assert.ok(fixture.projectWrites.length > 0, "生图请求前没有先保存账号工程");
    const body = route.request().postDataJSON();
    imageRequests.push({ at: Date.now(), body });
    if (failImages) return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "模拟图片通道失败",
        code: "IMAGE_FIXTURE_REJECTED",
        state: "rejected",
        canResubmit: true,
        sameKeyCanResubmit: false,
        upstreamCalled: false,
        billed: false,
        requestAccepted: false,
      }),
    });
    const recordId = `${"0".repeat(63)}${(imageRequests.length % 16).toString(16)}`;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deliveryMode: "provider_url", recordId, images: [{ url: `https://media.storyboard.test/storyboard-${imageRequests.length}.png`, recordId, deliveryMode: "provider_url", width: 1, height: 1 }] }) });
  });
  await page.route("**/api/image-workbench/persist", async (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: body.url }) });
  });
  await page.route("**/api/video/generate", (route) => {
    assert.ok(fixture.projectWrites.length > 0, "视频请求前没有先保存账号工程");
    const body = route.request().postDataJSON();
    videoRequests.push({ at: Date.now(), body });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      status: "pending",
      task_id: `storyboard-task-${videoRequests.length}`,
      model_id: "video-1080p",
      content_url: `https://media.storyboard.test/poll/storyboard-task-${videoRequests.length}`,
    }) });
  });
  await page.route("**/api/video/stream?**", (route) => {
    const requestUrl = new URL(route.request().url());
    const taskId = requestUrl.searchParams.get("taskId") || "storyboard-task-1";
    const ordinal = Number(taskId.split("-").at(-1)) || 1;
    return route.fulfill({ status: 200, contentType: "text/event-stream; charset=utf-8", body: `event: message\ndata: ${JSON.stringify({ status: "completed", videoUrl: `https://media.storyboard.test/video-${ordinal}.mp4`, progress: 100 })}\n\n` });
  });
  await page.route("**/api/video/status?**", (route) => {
    const requestUrl = new URL(route.request().url());
    const taskId = requestUrl.searchParams.get("taskId") || "storyboard-task-1";
    const ordinal = Number(taskId.split("-").at(-1)) || 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "completed", videoUrl: `https://media.storyboard.test/video-${ordinal}.mp4`, progress: 100 }) });
  });
  await page.route("**/api/video/access-ticket**", (route) => {
    const requestUrl = new URL(route.request().url());
    const taskId = requestUrl.searchParams.get("taskId") || "storyboard-task-1";
    const ordinal = Number(taskId.split("-").at(-1)) || 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: `https://media.storyboard.test/video-${ordinal}.mp4?ticket=${requestUrl.searchParams.get("scope") || "playback"}` }),
    });
  });
  await page.route("**/api/video/proxy-download**", (route) => {
    const requestUrl = new URL(route.request().url());
    const name = requestUrl.searchParams.get("name") || "download.bin";
    downloadRequests.push({
      url: requestUrl.searchParams.get("url"),
      name,
      token: requestUrl.searchParams.get("token"),
    });
    return route.fulfill({
      status: 200,
      contentType: name.endsWith(".mp4") ? "video/mp4" : "image/png",
      headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
      body: Buffer.from("storyboard-download"),
    });
  });
  await page.route("https://media.storyboard.test/storyboard-*.png", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: transparentPng,
  }));
  await page.route("https://media.storyboard.test/video-*.mp4", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp4",
    headers: { "Content-Disposition": "attachment; filename=video.mp4" },
    body: validVideo,
  }));
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  } catch (error) {
    const diagnostics = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      visibleDialogs: await page.locator('[role="dialog"]:visible').allTextContents().catch(() => []),
      bodyText: (await page.locator("body").innerText().catch(() => "")).slice(0, 2_000),
      pageErrors: errors,
    };
    await page.screenshot({ path: path.join(outputDir, "storyboard-workbench-load-failure.png"), fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ storyboardLoadFailure: diagnostics }, null, 2));
    throw error;
  }
  await page.waitForFunction(() => document.querySelectorAll(".sbw-image-model-list > button").length === 2 && document.querySelectorAll(".sbw-video-model-list > button").length === 2, null, { timeout: 30_000 });
  return { context, page, imageRequests, videoRequests, uploadRequests, downloadRequests, errors, fixture };
}

function gaps(records) {
  return records.slice(1).map((record, index) => record.at - records[index].at);
}

{
  const state = await preparePage();
  const { context, page, imageRequests, videoRequests, uploadRequests, downloadRequests, errors, fixture } = state;
  assert.equal(await page.locator(".sbw-image-model-list > button").count(), 2, "图片模型没有在左栏完整显示");
  assert.equal(await page.locator(".sbw-video-model-list > button").count(), 2, "视频模型没有在左栏完整显示");
  assert.equal(await page.locator(".sbw-image-model-list > button:enabled").count(), 2, "图片模型可用槽位不足");
  assert.equal(await page.locator(".sbw-image-model-list > button.is-active").getAttribute("aria-label"), "选择生图模型：GPT-Image-2 · A", "默认生图模型不是当前 GPT-Image-2 · A 渠道");
  assert.equal(await page.getByRole("combobox", { name: "图片分辨率" }).inputValue(), "2K", "GPT-Image-2 · A 没有使用目录声明的默认分辨率");
  await page.locator(".sbw-video-model-list > button").nth(1).click();
  const squareRatioButtons = page.getByRole("button", { name: "1:1", exact: true });
  await squareRatioButtons.nth(0).click();
  await squareRatioButtons.nth(1).click();

  const firstCard = page.locator(".sbw-shot-card").first();
  const referenceModeButton = page.getByRole("button", { name: "角色参考", exact: true });
  assert.equal(await referenceModeButton.isDisabled(), false, "角色参考入口当前不可用");
  await referenceModeButton.click();
  await page.waitForTimeout(1_000);
  const addReferenceCard = page.getByRole("button", { name: "＋添加参考卡", exact: true });
  if (await page.locator(".svad-reference-slot[data-role=\"character\"]").count() === 0) await addReferenceCard.click();
  const characterReference = page.locator('.svad-reference-slot[data-role="character"]');
  await characterReference.waitFor({ state: "visible", timeout: 30_000 });
  await characterReference.locator('input[type="file"][aria-label="上传人物参考图"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: Buffer.from("storybook-reference") });
  await page.getByText(/参考图已添加|参考图已上传为候选/u).waitFor({ timeout: 30_000 });
  const useUploadedReference = characterReference.getByRole("button", { name: "使用这张", exact: true });
  // The current director flow may auto-adopt a first uploaded character
  // reference while the save settles. Accept either that completed state or
  // the explicit button path, and wait through the transient busy flag.
  await page.waitForFunction(() => {
    const slot = document.querySelector('.svad-reference-slot[data-role="character"]');
    if (!slot) return false;
    const explicit = Array.from(slot.querySelectorAll("button")).some(button => button.textContent?.trim() === "使用这张" && !button.disabled);
    return explicit || /已采用|移除引用/u.test(slot.textContent || "");
  }, null, { timeout: 30_000 });
  if (await useUploadedReference.count() && await useUploadedReference.first().isVisible().catch(() => false) && await useUploadedReference.first().isEnabled().catch(() => false)) {
    await useUploadedReference.first().click({ force: true });
    await page.getByText(/已确认项目参考|参考图已添加/u).last().waitFor({ timeout: 30_000 });
  } else {
    assert.match(await characterReference.innerText(), /已采用|移除引用/u, "上传参考图未形成当前项目参考候选");
  }
  assert.equal(uploadRequests.length, 1, "本地参考图没有经过上传接口");

  const cards = page.locator(".sbw-shot-card");
  assert.equal(await cards.first().locator("textarea").count(), 2, "普通模式只应显示生图和视频两个输入框");
  assert.equal(await page.getByRole("textbox", { name: "分段1画面精确文字", exact: true }).count(), 0, "普通模式不应暴露精确文字输入框");
  await firstCard.screenshot({ path: path.join(outputDir, "storyboard-prompt-layout-current.png") });
  for (let index = 0; index < 3; index += 1) {
    const order = index + 1;
    const imagePrompt = cards.nth(index).getByRole("textbox", { name: `分段${order}生图提示词`, exact: true });
    const videoPrompt = cards.nth(index).getByRole("textbox", { name: `分段${order}视频提示词`, exact: true });
    if (index === 0) {
      await page.evaluate(() => navigator.clipboard.writeText("分段1生图提示词"));
      await cards.nth(index).getByRole("button", { name: "粘贴分段1生图提示词" }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="分段1生图提示词"]')?.value === "分段1生图提示词");
      await page.evaluate(() => navigator.clipboard.writeText("分段1视频提示词"));
      await cards.nth(index).getByRole("button", { name: "粘贴分段1视频提示词" }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="分段1视频提示词"]')?.value === "分段1视频提示词");
      assert.equal(await imagePrompt.inputValue(), "分段1生图提示词", "生图 Prompt 粘贴失败");
      assert.equal(await videoPrompt.inputValue(), "分段1视频提示词", "视频 Prompt 粘贴失败");
    } else {
      await imagePrompt.fill(`分段${order}生图提示词`);
      await videoPrompt.fill(`分段${order}视频提示词`);
    }
  }
  assert.equal(await page.getByRole("button", { name: "批量视频", exact: true }).isDisabled(), true, "图片未完成前批量视频没有锁定");
  await page.getByRole("button", { name: "批量生图", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sbw-status-pair [data-status="done"]').length === 3, null, { timeout: 30_000 });
  assert.equal(imageRequests.length, 3, "批量生图没有逐卡提交");
  const imageGaps = gaps(imageRequests);
  assert.ok(imageGaps.every((value) => value >= 4_700), `批量生图提交间隔不足5秒：${imageGaps.join(",")}`);
  assert.ok(imageRequests.every((item) => item.body.modelId === "gpt-image-2-pro"), "批量生图没有使用默认 GPT-Image-2 pro");
  assert.ok(imageRequests.every((item) => item.body.aspectRatio === "1:1"), "批量生图没有使用1:1比例");
  assert.ok(imageRequests.every((item) => item.body.resolution === "2K"), "批量生图没有沿用目录声明的2K默认分辨率");
  assert.deepEqual(imageRequests[0].body.referenceImageUrls, ["https://media.storyboard.test/uploaded-reference.png"], "首卡上传参考图没有进入生图请求");
  assert.ok(imageRequests.every((item) => !Object.hasOwn(item.body, "coverText")), "当前分段生图请求不应携带已移除的高级文字排版字段");

  assert.equal(await page.getByRole("button", { name: "批量视频", exact: true }).isDisabled(), false, "全部图片完成后批量视频没有解锁");
  await page.getByRole("button", { name: "批量视频", exact: true }).click();
  try {
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".sbw-status-pair span")).filter((node) => node.textContent?.includes("视频完成")).length === 3, null, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      statusTexts: Array.from(document.querySelectorAll(".sbw-status-pair span")).map((node) => node.textContent || ""),
      notice: document.querySelector(".sbw-notice")?.textContent || "",
      videoButtons: Array.from(document.querySelectorAll(".sbw-shot-card .is-video-command")).map((button) => ({ disabled: button.disabled, title: button.title, text: button.textContent })),
    }));
    console.error(JSON.stringify({ videoRequests: videoRequests.length, savedProject: fixture.latestDocument(), diagnostics }, null, 2));
    throw error;
  }
  assert.equal(videoRequests.length, 3, "批量视频没有逐卡提交");
  const videoGaps = gaps(videoRequests);
  assert.ok(videoGaps.every((value) => value >= 7_700), `批量视频提交间隔不足8秒：${videoGaps.join(",")}`);
  assert.ok(videoRequests.every((item) => item.body.model_id === "video-1080p"), "批量视频没有使用左栏选择的模型");
  assert.ok(videoRequests.every((item) => item.body.aspect_ratio === "1:1" && item.body.duration === 10), "视频请求没有贯通1:1与10秒参数");
  assert.deepEqual(
    videoRequests.map((item) => item.body.prompt),
    ["分段1视频提示词", "分段2视频提示词", "分段3视频提示词"],
    "视频请求没有逐卡原样提交用户 Prompt",
  );
  assert.ok(videoRequests.every((item) => item.body.negative_prompt === undefined), "分镜工作台不应偷偷注入项目专属反向词");
  assert.deepEqual(
    videoRequests.map((item) => item.body.image_ref),
    imageRequests.map((_, index) => ({ schema: "generated_image_ref.v1", recordId: `${"0".repeat(63)}${((index + 1) % 16).toString(16)}` })),
    "视频没有逐卡使用刚生成的故事板引用",
  );
  assert.ok(videoRequests.every((item) => !Object.hasOwn(item.body, "image_url")), "视频请求不应回退为裸图片 URL");
  assert.equal(await page.getByTitle("下载故事板").count(), 3, "故事板下载入口不完整");
  assert.equal(await page.getByTitle("下载视频").count(), 3, "视频下载入口不完整");
  await page.getByTitle("下载故事板").first().click();
  await page.getByTitle("下载视频").first().click();
  await page.waitForTimeout(100);
  const capturedDownloadNames = await page.evaluate(() => window.__storyboardDownloadNames);
  assert.ok(capturedDownloadNames.length === 0 || JSON.stringify(capturedDownloadNames) === JSON.stringify(["01-故事板.png", "01-视频.mp4"]), "下载文件命名不符合当前工作台合同");
  assert.deepEqual(downloadRequests.map((item) => item.name), [], "同步直返媒体不应误走任务下载代理");

  const savedAccountProject = fixture.projectWrites.at(-1);
  assert.ok(savedAccountProject?.id, "完整结果没有自动保存到账户工程");

  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: "历史", exact: true }).click();
  let historyNavigationFallback = false;
  await page.waitForTimeout(400);
  if (!page.url().includes("/storyboard-workbench/history")) {
    historyNavigationFallback = true;
    await page.goto(`${baseUrl}/storyboard-workbench/history`, { waitUntil: "domcontentloaded" });
  }
  await page.getByRole("button", { name: "返回分镜工作台", exact: true }).click();
  await page.locator(".sbw-shot-card").first().waitFor({ state: "visible", timeout: 30_000 });

  await page.getByRole("button", { name: "添加分镜", exact: true }).click();
  assert.equal(await page.locator(".sbw-shot-card").count(), 4, "添加分镜没有生效");
  await page.getByRole("button", { name: "一键清理", exact: true }).click();
  await page.locator(".sbw-shot-card").first().waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), 3, "一键清理没有恢复三张空分镜卡");
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.waitForTimeout(400);
  if (!page.url().includes("/storyboard-workbench/history")) {
    historyNavigationFallback = true;
    await page.goto(`${baseUrl}/storyboard-workbench/history`, { waitUntil: "domcontentloaded" });
  }
  await page.getByRole("button", { name: "返回分镜工作台", exact: true }).click();
  await page.locator(".sbw-shot-card").first().waitFor({ state: "visible", timeout: 30_000 });

  const emptyCardHeight = await cards.nth(1).evaluate((element) => element.getBoundingClientRect().height);
  await page.screenshot({ path: path.join(outputDir, "storyboard-workbench-v51-full-flow.png"), fullPage: true });
  results.push({
    name: "full-feature-chain",
    imageGaps,
    videoGaps,
    referenceCount: 1,
    ratio: imageRequests[0].body.aspectRatio,
    resolution: imageRequests[0].body.resolution,
    imageModel: imageRequests[0].body.modelId,
    videoModel: videoRequests[0].body.model_id,
    accountProjectWrites: fixture.projectWrites.length,
    restoredFromAccountProject: savedAccountProject.id,
    downloadButtonCount: await page.getByTitle("下载故事板").count() + await page.getByTitle("下载视频").count(),
    emptyCardHeight,
    historyNavigationFallback,
    errors,
  });
  for (const adjacentPath of ["/video", "/cover"]) {
    const response = await page.goto(`${baseUrl}${adjacentPath}`, { waitUntil: "domcontentloaded" });
    await page.locator("body").waitFor();
    await page.getByRole("status").filter({ hasText: /正在打开/u }).waitFor({ state: "hidden", timeout: 30_000 });
    await page.waitForTimeout(500);
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(response?.status(), 200, `${adjacentPath} 没有返回200`);
    assert.ok(horizontalOverflow <= 1, `${adjacentPath} 出现横向溢出：${horizontalOverflow}px`);
    await page.screenshot({
      path: path.join(outputDir, `storyboard-adjacent-${adjacentPath.slice(1)}.png`),
      fullPage: true,
    });
    results.push({ name: `adjacent-${adjacentPath.slice(1)}`, path: adjacentPath, status: response?.status(), horizontalOverflow, errors: [] });
  }
  await context.close();
}

{
  const state = await preparePage({ failImages: true });
  const { context, page, imageRequests, videoRequests, errors } = state;
  while (await page.locator(".sbw-shot-card").count() > 1) {
    await page.locator(".sbw-shot-card").last().getByTitle("删除分段").click();
  }
  await page.getByRole("textbox", { name: "分段1生图提示词", exact: true }).fill("失败门禁生图提示词");
  await page.getByRole("textbox", { name: "分段1视频提示词", exact: true }).fill("失败门禁视频提示词");
  await page.getByRole("button", { name: "批量生图", exact: true }).click();
  await page.getByText("生图失败").waitFor({ timeout: 10_000 });
  await page.getByText(/批量生图结束：成功0个，失败1个/).waitFor({ timeout: 10_000 });
  assert.equal(imageRequests.length, 1, "失败门禁没有提交生图请求");
  assert.equal(videoRequests.length, 0, "故事板失败后全部生成仍越级提交了视频");
  results.push({ name: "image-failure-gate", imageRequests: imageRequests.length, videoRequests: videoRequests.length, errors });
  await context.close();
}

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator("body").waitFor();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(response?.status(), 200, "未修改的首页没有返回200");
  assert.ok(horizontalOverflow <= 1, `未修改的首页出现横向溢出：${horizontalOverflow}px`);
  await page.screenshot({ path: path.join(outputDir, "storyboard-workbench-repair-home-regression.png"), fullPage: true });
  results.push({ name: "unmodified-home-regression", status: response?.status(), horizontalOverflow, errors });
  await context.close();
}

await browser.close();
assert.ok(results.every((item) => !item.errors.length), "页面运行期间出现脚本错误");
await writeFile(".tmp-e2e/storyboard-workbench-v51-full-flow.json", JSON.stringify({ passed: true, results }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, results }, null, 2));
