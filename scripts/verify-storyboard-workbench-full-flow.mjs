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
  const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl });
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
        { id: "video-720p", displayName: "图生视频 720p", publicPrice: 0.4, capabilities: { type: "video", durationMode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10], supportsImageInput: true, requiresImage: true, resolutionTier: "720p", resolutionOptions: ["720p"], defaultResolution: "720p", aspectRatios: ["16:9", "9:16", "1:1"], workspaceSurfaces: ["storyboard"] } },
        { id: "video-1080p", displayName: "图生视频 1080p", publicPrice: 0.8, capabilities: { type: "video", durationMode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10], supportsImageInput: true, requiresImage: true, resolutionTier: "1080p", resolutionOptions: ["1080p"], defaultResolution: "1080p", aspectRatios: ["16:9", "9:16", "1:1"], workspaceSurfaces: ["storyboard"] } },
      ],
    }),
  }));
  await page.route("**/api/storage/upload", (route) => {
    uploadRequests.push({ at: Date.now(), contentType: route.request().headers()["content-type"] || "" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ file: { url: "https://example.com/uploaded-reference.png" } }) });
  });
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
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [{ url: `https://media.storyboard.test/storyboard-${imageRequests.length}.png` }] }) });
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
      status: "completed",
      task_id: `storyboard-task-${videoRequests.length}`,
      video_url: `https://media.storyboard.test/video-${videoRequests.length}.mp4`,
    }) });
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
  await page.getByRole("button", { name: "1:1", exact: true }).click();

  const firstCard = page.locator(".sbw-shot-card").first();
  await firstCard.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: Buffer.from("storybook-reference") });
  await firstCard.getByText(/已上传 1(?:\/\d+)? 张/u).waitFor();
  assert.equal(uploadRequests.length, 1, "本地参考图没有经过上传接口");

  const cards = page.locator(".sbw-shot-card");
  assert.equal(await cards.first().locator("textarea").count(), 2, "普通模式只应显示生图和视频两个输入框");
  assert.equal(await page.getByRole("textbox", { name: "镜头1画面精确文字", exact: true }).count(), 0, "普通模式不应暴露精确文字输入框");
  assert.equal(await page.locator(".sbw-text-layout-toggle input:checked").count(), 0, "高级文字排版不应默认开启");
  await firstCard.screenshot({ path: path.join(outputDir, "storyboard-text-layout-default-off.png") });
  await firstCard.locator(".sbw-text-layout-toggle input").check();
  await page.getByRole("textbox", { name: "镜头1画面精确文字", exact: true }).fill("主标题\n副标题");
  assert.equal(await cards.first().locator("textarea").count(), 3, "开启高级文字排版后应显示精确文字输入框");
  assert.equal(await cards.nth(1).locator("textarea").count(), 2, "单卡开启高级文字排版不应污染相邻镜头");
  await firstCard.screenshot({ path: path.join(outputDir, "storyboard-text-layout-advanced-on.png") });
  for (let index = 0; index < 3; index += 1) {
    const order = index + 1;
    const imagePrompt = cards.nth(index).getByRole("textbox", { name: `镜头${order}生图提示词`, exact: true });
    const videoPrompt = cards.nth(index).getByRole("textbox", { name: `镜头${order}视频提示词`, exact: true });
    if (index === 0) {
      await page.evaluate(() => navigator.clipboard.writeText("镜头1生图提示词"));
      await cards.nth(index).getByRole("button", { name: "粘贴镜头1生图提示词" }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="镜头1生图提示词"]')?.value === "镜头1生图提示词");
      await page.evaluate(() => navigator.clipboard.writeText("镜头1视频提示词"));
      await cards.nth(index).getByRole("button", { name: "粘贴镜头1视频提示词" }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="镜头1视频提示词"]')?.value === "镜头1视频提示词");
      assert.equal(await imagePrompt.inputValue(), "镜头1生图提示词", "生图 Prompt 粘贴失败");
      assert.equal(await videoPrompt.inputValue(), "镜头1视频提示词", "视频 Prompt 粘贴失败");
    } else {
      await imagePrompt.fill(`镜头${order}生图提示词`);
      await videoPrompt.fill(`镜头${order}视频提示词`);
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
  assert.deepEqual(imageRequests[0].body.referenceImageUrls, ["https://example.com/uploaded-reference.png"], "首卡上传参考图没有进入生图请求");
  assert.equal(imageRequests[0].body.coverText, "主标题\n副标题", "高级文字排版没有把用户精确文字交给平台后置排版");
  assert.ok(imageRequests.slice(1).every((item) => !Object.hasOwn(item.body, "coverText")), "普通镜头的生图请求不应携带文字字段");

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
    ["镜头1视频提示词", "镜头2视频提示词", "镜头3视频提示词"],
    "视频请求没有逐卡原样提交用户 Prompt",
  );
  assert.ok(videoRequests.every((item) => item.body.negative_prompt === undefined), "分镜工作台不应偷偷注入项目专属反向词");
  assert.deepEqual(videoRequests.map((item) => item.body.image_url), imageRequests.map((_, index) => `https://media.storyboard.test/storyboard-${index + 1}.png`), "视频没有逐卡使用刚生成的故事板");
  assert.equal(await page.getByTitle("下载故事板").count(), 3, "故事板下载入口不完整");
  assert.equal(await page.getByTitle("下载视频").count(), 3, "视频下载入口不完整");
  await page.getByTitle("下载故事板").first().click();
  await page.getByTitle("下载视频").first().click();
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.__storyboardDownloadNames), ["01-故事板.png", "01-视频.mp4"], "下载文件没有按镜头顺序命名");
  assert.deepEqual(downloadRequests.map((item) => item.name), [], "同步直返媒体不应误走任务下载代理");

  await firstCard.locator(".sbw-text-layout-toggle input").uncheck();
  assert.equal(await page.getByRole("textbox", { name: "镜头1画面精确文字", exact: true }).count(), 0, "关闭高级文字排版后没有收起并清空输入");
  await page.locator(".sbw-shot-card").first().getByRole("button", { name: "重新生图", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sbw-status-pair [data-status="done"]').length === 3 && document.querySelectorAll('.sbw-image-frame img').length === 3);
  assert.equal(imageRequests.length, 4, "重新生图没有发起单次图片请求");
  assert.equal(Object.hasOwn(imageRequests[3].body, "coverText"), false, "关闭高级文字排版后仍污染后续生图请求");
  const snapshotSaveDeadline = Date.now() + 10_000;
  while (!fixture.projectWrites.some((write) => String(write.document?.title || "").includes("镜头1重新生图前")) && Date.now() < snapshotSaveDeadline) {
    await page.waitForTimeout(50);
  }
  const snapshotWrite = fixture.projectWrites.find((write) => String(write.document?.title || "").includes("镜头1重新生图前"));
  assert.ok(snapshotWrite?.id, "重新生图前的完整快照没有保存到账户工程");
  assert.equal(snapshotWrite.document.cards.filter((card) => card.videoStatus === "done").length, 3, "重新生图前快照没有保留三条视频结果");
  await page.getByRole("button", { name: "最近任务", exact: true }).click();
  const preRegenerateSnapshot = page.locator(`[data-storyboard-project-id="${snapshotWrite.id}"]`);
  await preRegenerateSnapshot.waitFor({ timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await preRegenerateSnapshot.getByRole("button", { name: "打开任务", exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".sbw-status-pair span")).filter((node) => node.textContent?.includes("视频完成")).length === 3, null, { timeout: 10_000 });
  assert.equal(await page.locator('.sbw-status-pair span').filter({ hasText: "视频完成" }).count(), 3, "历史快照没有恢复三段视频结果");

  const savedAccountProject = snapshotWrite;
  assert.ok(savedAccountProject?.id, "完整结果没有自动保存到账户工程");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), 3, "刷新后默认卡片数量异常");
  assert.equal(await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).inputValue(), "", "刷新后错误自动恢复了旧生图 Prompt");
  assert.equal(await page.locator(".sbw-image-frame img").count(), 0, "刷新后错误自动恢复了旧故事板结果");
  await page.getByRole("button", { name: "最近任务", exact: true }).click();
  const accountProject = page.locator(`[data-storyboard-project-id="${savedAccountProject.id}"]`);
  await accountProject.waitFor({ timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await accountProject.getByRole("button", { name: "打开任务", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".sbw-image-frame img").length === 3, null, { timeout: 10_000 });
  assert.equal(await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).inputValue(), "镜头1生图提示词", "账号工程恢复后生图 Prompt 不正确");
  assert.equal(await page.getByRole("textbox", { name: "镜头1视频提示词", exact: true }).inputValue(), "镜头1视频提示词", "账号工程恢复后视频 Prompt 不正确");
  assert.equal(await page.locator(".sbw-image-frame img").count(), 3, "账号工程没有恢复三张故事板图片");
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".sbw-status-pair span")).filter((node) => node.textContent?.includes("视频完成")).length === 3, null, { timeout: 10_000 });
  for (let order = 1; order <= 3; order += 1) {
    const expandButton = page.getByRole("button", { name: `展开镜头${order}视频区域`, exact: true });
    if (await expandButton.count()) await expandButton.click();
  }
  await page.waitForFunction(() => document.querySelectorAll(".sbw-video-frame video").length === 3, null, { timeout: 10_000 });
  assert.equal(await page.locator(".sbw-video-frame video").count(), 3, "账号工程没有恢复三条同步完成视频");
  assert.equal(await page.getByTitle("下载视频").count(), 3, "账号工程恢复后视频下载入口不完整");

  await page.getByRole("button", { name: "添加镜头", exact: true }).first().click();
  assert.equal(await page.locator(".sbw-shot-card").count(), 4, "添加镜头没有生效");
  await page.getByRole("button", { name: "清理空卡", exact: true }).click();
  assert.equal(await page.locator(".sbw-shot-card").count(), 3, "清理空卡没有移除新增空镜头");
  await page.getByRole("button", { name: "最近任务", exact: true }).click();
  assert.ok(await page.locator(".sbw-history-list article").count() >= 1, "当前工作台没有写入历史记录");
  await page.locator(".sbw-drawer header button").click();

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
    await page.locator(".sbw-shot-card").last().getByTitle("删除镜头").click();
  }
  await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).fill("失败门禁生图提示词");
  await page.getByRole("textbox", { name: "镜头1视频提示词", exact: true }).fill("失败门禁视频提示词");
  await page.getByRole("button", { name: "全部生成", exact: true }).click();
  await page.getByText("生图失败").waitFor({ timeout: 10_000 });
  await page.getByText(/部分故事板失败/).waitFor({ timeout: 10_000 });
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
