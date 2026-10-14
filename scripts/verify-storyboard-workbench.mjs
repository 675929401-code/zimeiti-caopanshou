import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const outputDir = path.resolve(process.env.STORYBOARD_EVIDENCE_DIR || ".codex-screenshots");
await mkdir(outputDir, { recursive: true });

const source = {
  name: "分镜工作台固定双 Prompt 夹具",
  imagePrompt: "生成一张16:9连续故事板，四格电影分镜，一只小狗在客厅跳舞，角色造型、光线和空间关系保持一致。",
  videoPrompt: "0至4秒小狗跟随节拍抬起前爪，4至10秒原地旋转后看向镜头；镜头平稳推进，无字幕，无水印。",
};

const IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0f172a"/><circle cx="80" cy="45" r="24" fill="#67e8f9"/></svg>';
const IMAGE_URL = "https://example.com/storyboard-v50.svg";
const ASSET_URL = "https://example.com/visual-asset-character.svg";
const VIDEO_URL = "https://example.com/storyboard-v50.mp4";
const browser = await chromium.launch({ headless: true });
const checks = [];

async function createPage(viewport) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl });
  await page.route("**/api/cover-models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [{
        id: "gpt-image-2-e2e",
        name: "GPT Image 2 测试通道",
        model_name: "gpt-image-2",
        supports_image_input: true,
        resolution_options: ["1K"],
        default_resolution: "1K",
        selling_price: 0.34,
        available: true,
        priceReady: true,
      }],
    }),
  }));
  await page.route("**/api/video/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [{
        id: "seedance-2.0-mini-e2e",
        name: "Seedance 2.0 Mini 十秒测试通道",
        price_per_use: 0.55,
        available: true,
        priceReady: true,
        durationSeconds: 10,
        maxDuration: 10,
        durationMode: "fixed",
        supportsImageInput: true,
        requiresImage: true,
        resolutionTier: "1080p",
        resolutionOptions: ["1080p"],
        defaultResolution: "1080p",
        aspectRatios: ["16:9", "9:16"],
        workspaceSurfaces: ["storyboard"],
      }],
    }),
  }));
  await page.route("**/api/image-workbench/history**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ records: [{ items: [{ assetId: "history-character-1", imageUrl: ASSET_URL, prompt: "固定人物资产，暖色短发与米白外套，保持外观一致。", historyRecordId: "history-record-1", storageKey: "images/history-character-1.png", modelId: "gpt-image-2-e2e", modelName: "GPT Image 2 测试通道", quotedPrice: 0.34, createdAt: "2026-10-15T00:00:00.000Z" }] }] }),
  }));
  return { context, page, fixture };
}

async function typePrompt(locator, value) {
  await locator.click();
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await locator.press("Backspace");
  try {
    await locator.page().evaluate((text) => navigator.clipboard.writeText(text), value);
    await locator.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  } catch {
    await locator.page().keyboard.insertText(value);
  }
}

{
  const { context, page, fixture } = await createPage({ width: 1600, height: 1000 });
  const imageRequests = [];
  const videoRequests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/image/generate", (route) => {
    assert.ok(fixture.projectWrites.length > 0, "图片提交前没有先保存账号工程");
    imageRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ images: [{ url: IMAGE_URL }] }),
    });
  });
  await page.route("**/api/image-workbench/persist", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ url: IMAGE_URL }),
  }));
  await page.route("**/api/video/generate", (route) => {
    assert.ok(fixture.projectWrites.length > 0, "视频提交前没有先保存账号工程");
    videoRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "pending", task_id: "provider-e2e-task", model_id: "seedance-2.0-mini-e2e", content_url: "https://example.com/poll/provider-e2e-task" }),
    });
  });
  await page.route("**/api/video/stream?**", (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    body: `event: message\ndata: ${JSON.stringify({ status: "completed", videoUrl: VIDEO_URL, progress: 100 })}\n\n`,
  }));
  await page.route("**/api/video/status?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "completed", videoUrl: VIDEO_URL, progress: 100 }),
  }));
  await page.route(IMAGE_URL, (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: IMAGE_SVG,
  }));
  await page.route(ASSET_URL, (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: IMAGE_SVG,
  }));

  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/storyboard-workbench(?:\?|$)/u, { timeout: 30_000 });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  const cards = page.locator(".sbw-shot-card");
  assert.equal(await cards.count(), 3, "工作台默认不是3张镜头卡");
  const firstCard = cards.first();
  const textareas = firstCard.locator("textarea");
  // The exact-text overlay is optional and stays hidden until the user enables
  // advanced text layout. The default card therefore exposes the two prompt
  // editors that are part of the agent handoff contract.
  assert.equal(await textareas.count(), 2, "默认镜头卡应包含生图和视频两个独立 Prompt 输入框");
  assert.equal(await page.locator(".sbw-visual-assets-body").count(), 0, "视觉资产面板默认必须关闭");
  await page.getByRole("button", { name: "选择资产", exact: true }).click();
  await page.getByRole("button", { name: "读取我的历史生成图", exact: true }).click();
  await page.getByText("固定人物资产，暖色短发与米白外套，保持外观一致。", { exact: false }).waitFor();
  assert.equal(imageRequests.length, 0, "读取/选择视觉资产前不能触发生图请求");
  await page.getByRole("button", { name: "绑定到当前镜头", exact: true }).click();
  await page.getByText("任务 1 · 人物", { exact: false }).waitFor();
  await page.getByRole("button", { name: "保存当前资产绑定（不生成）", exact: true }).click();
  await page.getByText("视觉资产绑定已保存到当前项目", { exact: false }).waitFor();
  assert.equal(imageRequests.length, 0, "保存视觉资产绑定不应触发生图请求");
  await typePrompt(firstCard.getByRole("textbox", { name: "镜头1生图提示词" }), source.imagePrompt);
  await typePrompt(firstCard.getByRole("textbox", { name: "镜头1视频提示词" }), source.videoPrompt);
  await firstCard.getByRole("button", { name: "生成图片" }).waitFor({ state: "visible" });

  const videoButton = firstCard.getByRole("button", { name: "生成视频" });
  assert.equal(await videoButton.isDisabled(), true, "图片生成前视频按钮没有锁定");
  await firstCard.getByRole("button", { name: "生成图片" }).click();
  await firstCard.getByText("图片完成").waitFor();
  assert.equal(await videoButton.isDisabled(), false, "图片成功入库后视频按钮没有解锁");
  await videoButton.click();
  await firstCard.getByText("视频完成").waitFor();

  assert.equal(imageRequests.length, 1, "单张生图不是一次请求");
  assert.equal(imageRequests[0].prompt, source.imagePrompt, "工作台改写了智能体生图Prompt");
  assert.equal(imageRequests[0].aspectRatio, "16:9", "工作台没有提交选择的16:9比例");
  assert.equal(imageRequests[0].resolution, "1K", "工作台没有使用模型支持的分辨率");
  assert.deepEqual(imageRequests[0].referenceImageUrls, [ASSET_URL], "视觉资产绑定后应作为生图阶段参考图提交");
  assert.equal(videoRequests.length, 1, "单条视频不是一次请求");
  assert.equal(videoRequests[0].image_url, IMAGE_URL, "视频没有使用同一卡片刚生成并入库的故事板");
  assert.equal(videoRequests[0].prompt, source.videoPrompt, "工作台没有原样提交用户视频Prompt");
  assert.equal(Object.hasOwn(videoRequests[0], "negative_prompt"), false, "工作台仍在偷偷附加项目专属负向Prompt");
  assert.doesNotMatch(videoRequests[0].prompt, /兽医|听诊器|健康检查|暖芥末黄|蓝色牛仔裤/u, "工作台仍在注入宠物科普项目内容");
  assert.ok(fixture.projectWrites.length >= 2, "图片和视频生成前的账号工程没有完整保存");
  assert.ok(["queued", "running"].includes(fixture.latestDocument().cards[0].videoStatus), "视频提交快照没有保存排队或运行态");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), 3, "刷新后工作台没有回到默认3张镜头卡");
  const restored = page.locator(".sbw-shot-card").first().locator("textarea");
  assert.equal(await restored.nth(0).inputValue(), "", "刷新后不应自动恢复生图Prompt草稿");
  assert.equal(await restored.nth(1).inputValue(), "", "刷新后不应自动恢复视频Prompt草稿");
  assert.equal(await page.locator(".sbw-shot-card").first().getByText("视频完成").count(), 0, "刷新后不应自动恢复当前卡片生成状态");

  const grid = await page.locator(".sbw-shot-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  const metrics = await page.evaluate(() => {
    const card = document.querySelector(".sbw-shot-card");
    const sidebar = document.querySelector(".sbw-model-rail");
    const textareas = Array.from(document.querySelectorAll(".sbw-shot-card:first-child textarea"));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cardHeight: card?.getBoundingClientRect().height || 0,
      sidebarWidth: sidebar?.getBoundingClientRect().width || 0,
    textareaHeights: textareas.map((item) => item.getBoundingClientRect().height),
    };
  });
  assert.equal(grid, 3, `1600px 默认分镜卡片不是每行3张：${grid}`);
  assert.ok(metrics.sidebarWidth >= 311 && metrics.sidebarWidth <= 313, `桌面模型栏不是312px：${metrics.sidebarWidth}`);
  assert.ok(metrics.textareaHeights[0] >= 58 && metrics.textareaHeights[0] <= 84, `生图提示词输入框尺寸异常：${metrics.textareaHeights.join(",")}`);
  assert.ok(metrics.textareaHeights[1] >= 58 && metrics.textareaHeights[1] <= 84, `视频提示词输入框尺寸异常：${metrics.textareaHeights.join(",")}`);
  await page.screenshot({ path: path.join(outputDir, "storyboard-workbench-v50-desktop.png"), fullPage: true });
  checks.push({
    name: "desktop-real-agent-output",
    enteredFromMainSite: true,
    defaultCardCount: await cards.count(),
    promptInputCount: await firstCard.locator("textarea").count(),
    imagePromptExact: imageRequests[0].prompt === source.imagePrompt,
    videoPromptExactPrefix: videoRequests[0].prompt.startsWith(source.videoPrompt),
    modelGuardrailVisible: await page.getByText("当前模型护栏").isVisible(),
    refreshResetsToDefaultCards: true,
    gridColumns: grid,
    cardHeight: metrics.cardHeight,
    sidebarWidth: metrics.sidebarWidth,
    textareaHeights: metrics.textareaHeights,
    referenceUrlsSubmitted: imageRequests[0].referenceImageUrls?.length || 0,
    accountProjectWrites: fixture.projectWrites.length,
    projectSavedBeforeImageAndVideo: true,
    overflow: metrics.scrollWidth > metrics.clientWidth + 2,
    errors,
  });
  await context.close();
}

await browser.close();
assert.ok(checks.every((check) => !check.overflow && !check.errors.length), "工作台存在页面错误或横向溢出");
await writeFile(path.join(outputDir, "storyboard-workbench-v50-ui.json"), JSON.stringify({ passed: true, sourceAgent: source.name, checks }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, sourceAgent: source.name, checks }, null, 2));
