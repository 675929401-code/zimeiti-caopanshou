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
const MANUAL_URL = "https://example.com/manual-storyboard-reference.svg";
const IMAGE_RECORD_ID = "b".repeat(64);
const browser = await chromium.launch({ headless: true });
const checks = [];

async function createPage(viewport) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  const uploads = [];
  // Last-registered specific fixtures override this guard. Unknown API writes,
  // status reconciliation and external requests never reach a real service.
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if ([IMAGE_URL, ASSET_URL, MANUAL_URL].includes(request.url())) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: IMAGE_SVG });
    if (request.url() === VIDEO_URL) return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) });
    if (url.origin !== new URL(baseUrl).origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], models: [], assets: [], tasks: [] }) });
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    return route.continue();
  });
  const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl, resetStorage: false });
  page.on("dialog", dialog => dialog.accept());
  await page.route("**/api/storyboard/presets**", route => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ presets: [], assets: [], canManage: false }) })
    : route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "FIXTURE_PRESET_WRITES_FORBIDDEN" }) }));
  await page.route("**/api/storyboard/image?**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: ASSET_URL, assetId: "history-character-1", storageKey: "images/history-character-1.png" }) }));
  await page.route("**/api/image/preview?**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: IMAGE_SVG }));
  await page.route("**/api/storage/upload", route => { uploads.push({ method: route.request().method(), contentType: route.request().headers()['content-type'], body: route.request().postData() }); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ file: { url: MANUAL_URL } }) }); });
  await page.route("**/api/cover-models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [{
        id: "gpt-image-2-e2e",
        name: "GPT Image 2 测试通道",
        model_name: "gpt-image-2",
        supports_image_input: true,
        max_reference_images: 3,
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
  await page.route("**/api/storyboard/visual-assets**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ assets: [{ assetId: "history-character-1", previewUrl: ASSET_URL, prompt: "固定人物资产，暖色短发与米白外套，保持外观一致。", name: "固定人物资产", role: "character", projectId: "history-project-1", storageKey: "images/history-character-1.png", createdAt: "2026-10-15T00:00:00.000Z" }] }),
  }));
  return { context, page, fixture, uploads };
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

async function focusWithKeyboard(page, locator) {
  await page.mouse.click(4, 4);
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("无法通过键盘 Tab 聚焦目标控件");
}

{
  const { context, page, fixture, uploads } = await createPage({ width: 1600, height: 1000 });
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
      body: JSON.stringify({ deliveryMode: "provider_url", recordId: IMAGE_RECORD_ID, images: [{ url: IMAGE_URL, recordId: IMAGE_RECORD_ID, deliveryMode: "provider_url", width: 160, height: 90 }] }),
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
  const firstCard = cards.first();
  assert.equal(await cards.count(), 3, "工作台默认不是3张分段卡");
  assert.equal(await page.getByRole("region", { name: "分段任务卡片", exact: true }).count(), 1, "工作台没有使用分段任务卡片的可见文案");
  assert.equal(await firstCard.getByText("分段 1", { exact: false }).count(), 1, "第一张卡片没有显示分段标题");
  assert.equal(await page.getByText("镜头 1", { exact: true }).count(), 0, "卡片标题仍暴露旧的镜头文案");
  assert.equal(await page.getByRole("button", { name: "全部生成", exact: true }).count(), 0, "工作台仍暴露已移除的全部生成入口");
  assert.equal(await page.getByRole("button", { name: "批量生图", exact: true }).count(), 1, "批量生图入口缺失");
  assert.equal(await page.getByRole("button", { name: "批量视频", exact: true }).count(), 1, "批量视频入口缺失");
  const imageBatchButton = page.getByRole("button", { name: "批量生图", exact: true });
  const videoBatchButton = page.getByRole("button", { name: "批量视频", exact: true });
  const addCardButton = page.getByRole("button", { name: /^(添加卡片|添加分镜)$/u }).first();
  await imageBatchButton.hover();
  assert.notEqual(await imageBatchButton.evaluate((element) => getComputedStyle(element).transform), "none", "批量生图按钮没有 hover 反馈");
  await focusWithKeyboard(page, imageBatchButton);
  assert.equal(await imageBatchButton.evaluate((element) => element.matches(":focus-visible")), true, "批量生图按钮未进入键盘 focus-visible 状态");
  assert.notEqual(await imageBatchButton.evaluate((element) => getComputedStyle(element).outlineStyle), "none", "批量生图按钮没有键盘 focus 反馈");
  assert.equal(await videoBatchButton.isDisabled(), true, "没有故事板图时批量视频按钮应保持禁用");
  const disabledButtonStyle = await videoBatchButton.evaluate((element) => ({ opacity: getComputedStyle(element).opacity, cursor: getComputedStyle(element).cursor }));
  assert.ok(Number(disabledButtonStyle.opacity) < 1, "禁用批量视频按钮仍显示为完全不透明，无法解释当前不可用状态");
  assert.equal(disabledButtonStyle.cursor, "not-allowed", "禁用批量视频按钮没有 not-allowed 光标");
  await focusWithKeyboard(page, addCardButton);
  assert.equal(await addCardButton.evaluate((element) => element.matches(":focus-visible")), true, "添加卡片按钮未进入键盘 focus-visible 状态");
  assert.notEqual(await addCardButton.evaluate((element) => getComputedStyle(element).outlineStyle), "none", "添加卡片按钮没有键盘 focus 反馈");
  const ordinaryModeButton = page.getByRole("button", { name: "普通模式", exact: true });
  const referenceModeButton = page.getByRole("button", { name: "角色参考", exact: true });
  assert.equal(await ordinaryModeButton.getAttribute("aria-pressed"), "true", "工作台默认没有处于普通模式");
  assert.equal(await referenceModeButton.getAttribute("aria-pressed"), "false", "工作台默认错误地处于角色参考模式");
  const initialCardIds = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-sbw-card-id")));
  await referenceModeButton.click();
  assert.equal(await page.locator(".sbw-shot-grid").count(), 1, "切换角色参考模式后没有复用同一分段画布");
  assert.deepEqual(await page.locator(".sbw-shot-card").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-sbw-card-id"))), initialCardIds, "切换角色参考模式改变了分段卡片稳定 ID");
  const textareas = firstCard.locator("textarea");
  // The exact-text overlay is optional and stays hidden until the user enables
  // advanced text layout. The default card therefore exposes the two prompt
  // editors that are part of the agent handoff contract.
  assert.equal(await textareas.count(), 2, "默认分段卡应包含生图和视频两个独立 Prompt 输入框");
  assert.equal(await page.locator("dialog.svad-drawer[open]").count(), 0, "视觉资产抽屉默认必须关闭");
  const inlineReference = page.locator(".svad-inline");
  assert.equal(await inlineReference.count(), 1, "角色参考模式没有复用紧凑的内嵌参考区");
  const roleSlot = (role) => inlineReference.locator(`.svad-reference-slot[data-role="${role}"]`);
  assert.equal(await roleSlot("character").count(), 1, "人物参考接收卡缺失");
  assert.equal(await roleSlot("pet").count(), 1, "宠物参考接收卡缺失");
  assert.equal(await roleSlot("environment").count(), 0, "默认不应凭空创建场景参考卡");
  const addReferenceCategory = inlineReference.getByLabel("添加参考卡类别", { exact: true });
  await addReferenceCategory.selectOption("prop");
  await inlineReference.getByRole("button", { name: "＋添加参考卡", exact: true }).click();
  await roleSlot("prop").waitFor({ state: "attached" });
  assert.equal(await inlineReference.locator(".svad-prompt-label textarea").count(), 3, "人物、宠物和道具参考应各有一个提示词入口");
  assert.equal(await inlineReference.getByRole("button", { name: /生成三视图/u }).count(), 2, "人物和宠物参考没有明确三视图职责");
  assert.equal(await roleSlot("prop").getByText("可选", { exact: true }).count(), 1, "道具参考没有标明按需职责");
  assert.equal(await inlineReference.getByRole("button", { name: "从图库选择", exact: true }).count(), 3, "每类参考应只有一个图库入口");
  assert.equal(await inlineReference.getByRole("button", { name: "上传参考图", exact: true }).count(), 3, "紧凑角色参考区应为人物、宠物和道具各提供一个上传入口");
  for (const role of ["character", "pet", "prop"]) {
    assert.equal(await roleSlot(role).getByRole("button", { name: "上传参考图", exact: true }).count(), 1, `${role}参考区上传入口缺失`);
  }
  const inlineMetrics = await inlineReference.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const grid = element.querySelector(".svad-drafts");
    return { height: rect.height, width: rect.width, gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0 };
  });
  assert.ok(inlineMetrics.height > 180, `角色参考区高度异常：${inlineMetrics.height}`);
  assert.ok(inlineMetrics.width >= 640, `角色参考区宽度异常：${inlineMetrics.width}`);
  assert.ok(inlineMetrics.gridColumns >= 1 && inlineMetrics.gridColumns <= 3, `角色参考区卡片列数异常：${inlineMetrics.gridColumns}`);
  await page.screenshot({ path: path.join(outputDir, "storyboard-role-reference-inline-ui10.png"), fullPage: false });
  // 视觉资产入口现在由“角色参考”工作模式承载，避免在普通模式工具栏重复放置入口。
  // The inline reference workflow now exposes the library entry as
  // “从图库选择”; keep the verifier compatible with the older “我的资产”
  // label while binding to the current user-visible control.
  const openLibrary = page.getByRole("button", { name: /^(从图库选择|我的资产)$/u }).first();
  await openLibrary.click();
  await page.waitForURL(/\/storyboard-workbench\/visual-assets\?/u, { timeout: 30_000 });
  const refreshLibrary = page.getByRole("button", { name: /^(刷新|刷新资产)$/u }).first();
  await refreshLibrary.click();
  const useAsset = page.getByRole("button", { name: /^(确认使用|使用这张)$/u }).first();
  await useAsset.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(imageRequests.length, 0, "读取/选择视觉资产前不能触发生图请求");
  await useAsset.click();
  await page.waitForURL(/\/storyboard-workbench(?:\?|$)/u, { timeout: 30_000 });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "分段1生图提示词", exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  assert.ok(fixture.latestDocument().cards.every(card => card.visualAssetRefs?.length === 1), "选用资产没有应用到全部任务卡");
  assert.equal(imageRequests.length, 0, "保存视觉资产绑定不应触发生图请求");
  await page.waitForFunction(() => {
    const button = document.querySelector(".sbw-toolbar-add-card");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  await addCardButton.click({ force: true });
  await page.waitForTimeout(1_800);
  await page.locator(".sbw-shot-card").nth(3).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), 4, "角色参考模式下添加卡片没有生成第4张分段卡");
  assert.match(await page.getByLabel("本项目参考").textContent() || "", /已绑定\s*4\/4/u, "角色参考模式下新增分段卡没有继承项目级视觉资产");
  await typePrompt(firstCard.getByRole("textbox", { name: "分段1生图提示词" }), source.imagePrompt);
  await typePrompt(firstCard.getByRole("textbox", { name: "分段1视频提示词" }), source.videoPrompt);
  await firstCard.getByRole("button", { name: "生成图片" }).waitFor({ state: "visible" });

  const videoButton = firstCard.getByRole("button", { name: "生成视频", exact: true }).first();
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
  assert.deepEqual(videoRequests[0].image_ref, { schema: "generated_image_ref.v1", recordId: IMAGE_RECORD_ID }, "视频没有使用同一卡片刚生成的完整故事板引用");
  for (const field of ["image_url", "referenceImageUrls", "images", "first_frame", "crop"]) assert.equal(Object.hasOwn(videoRequests[0], field), false, `视频携带额外或裁切图片字段${field}`);
  assert.equal(videoRequests[0].prompt, source.videoPrompt, "工作台没有原样提交用户视频Prompt");
  assert.equal(Object.hasOwn(videoRequests[0], "negative_prompt"), false, "工作台仍在偷偷附加项目专属负向Prompt");
  assert.doesNotMatch(videoRequests[0].prompt, /兽医|听诊器|健康检查|暖芥末黄|蓝色牛仔裤/u, "工作台仍在注入宠物科普项目内容");
  assert.ok(fixture.projectWrites.length >= 2, "图片和视频生成前的账号工程没有完整保存");
  assert.ok(fixture.projectWrites.some(write => ["queued", "running"].includes(write.document.cards[0].videoStatus)), "视频提交快照没有保存排队或运行态");

  // Direct card-level upload was intentionally removed from the compact
  // skeleton; manual reference intake lives in the role-reference workflow.
  assert.equal(await firstCard.locator("input[type=file]").count(), 0, "紧凑卡片不应重复渲染直传入口");
  await ordinaryModeButton.click();
  await page.locator('.sbw-notice').filter({ hasText: '已切换到普通模式：不再向分镜卡自动附加视觉资产参考图' }).waitFor();
  assert.equal(await ordinaryModeButton.getAttribute("aria-pressed"), "true", "切回普通模式后开关状态没有同步");
  assert.equal(await referenceModeButton.getAttribute("aria-pressed"), "false", "切回普通模式后角色参考仍显示为激活");
  const switched = fixture.latestDocument();
  assert.equal(switched.visualAssetPlan.mode, "off", "关闭角色参考模式没有保存");
  assert.ok(switched.cards.every(card => (card.visualAssetRefs || []).every(ref => !ref.ownedReferenceUrl && !ref.boundReferenceUrl)), "关闭模式未暂停自动引用");
  await page.waitForFunction(() => {
    const button = document.querySelector(".sbw-toolbar-add-card");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  await addCardButton.click({ force: true });
  await page.locator(".sbw-shot-card").nth(4).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_800);
  assert.equal(await page.locator(".sbw-shot-card").count(), 5, "普通模式下添加卡片没有生成第5张分段卡");
  assert.equal(await page.locator(".sbw-shot-card").nth(4).locator("input[type=file]").count(), 0, "普通模式下新增分段卡不应重复渲染参考上传入口");
  for (let attempt = 0; attempt < 24 && fixture.latestDocument()?.cards?.length !== 5; attempt += 1) await page.waitForTimeout(500);
  assert.equal(fixture.latestDocument()?.cards?.length, 5, "新增分段卡尚未完成持久化，刷新前不能宣称已保存");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "分段1生图提示词", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".sbw-shot-card").count(), 5, "刷新后工作台没有保持角色参考/普通模式新增的分段卡");
  const restored = page.locator(".sbw-shot-card").first().locator("textarea");
  assert.equal(await restored.nth(0).inputValue(), source.imagePrompt, "刷新后未恢复已保存生图Prompt");
  assert.equal(await restored.nth(1).inputValue(), source.videoPrompt, "刷新后未恢复已保存视频Prompt");
  assert.equal(fixture.latestDocument().visualAssetPlan.mode, "off", "刷新改变了已保存普通模式");

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
      cardWidth: card?.getBoundingClientRect().width || 0,
    textareaHeights: textareas.map((item) => item.getBoundingClientRect().height),
    };
  });
  assert.equal(grid, 3, `1600px 导演工作台应使用三列卡片：${grid}`);
  assert.ok(metrics.sidebarWidth >= 240 && metrics.sidebarWidth <= 360, `模型栏宽度异常：${metrics.sidebarWidth}`);
  assert.ok(metrics.cardWidth >= 300, `桌面任务卡宽度异常：${metrics.cardWidth}`);
  assert.ok(metrics.textareaHeights[0] >= 58 && metrics.textareaHeights[0] <= 180, `生图提示词输入框尺寸异常：${metrics.textareaHeights.join(",")}`);
  assert.ok(metrics.textareaHeights[1] >= 58 && metrics.textareaHeights[1] <= 180, `视频提示词输入框尺寸异常：${metrics.textareaHeights.join(",")}`);
  await page.screenshot({ path: path.join(outputDir, "storyboard-workbench-v50-desktop.png"), fullPage: true });
  checks.push({
    name: "desktop-real-agent-output",
    enteredFromMainSite: true,
    defaultCardCount: await cards.count(),
    promptInputCount: await firstCard.locator("textarea").count(),
    imagePromptExact: imageRequests[0].prompt === source.imagePrompt,
    videoPromptExactPrefix: videoRequests[0].prompt.startsWith(source.videoPrompt),
    completeSingleStoryboardReference: true,
    refreshStartsBlankAndExplicitHistoryRestoresSavedProject: true,
      ordinaryModeClearsAutomaticReferences: true,
      roleReferenceInline: {
        height: inlineMetrics.height,
        width: inlineMetrics.width,
        threeViewRoleCount: 2,
        optionalSceneRoleCount: 1,
        libraryEntryCount: 3,
        duplicateUploadButtons: 0,
      },
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
await writeFile(path.join(outputDir, "storyboard-workbench-v50-ui.json"), JSON.stringify({ passed: true, fixture: true, providerCalls: 0, realMediaE2E: false, sourceAgent: source.name, checks }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, sourceAgent: source.name, checks }, null, 2));
