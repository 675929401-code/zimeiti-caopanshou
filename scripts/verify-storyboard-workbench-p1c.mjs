import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const outputDir = path.resolve(".codex-screenshots");
const resultPath = path.resolve(".tmp-e2e/storyboard-workbench-p1c.json");
const validImageUrl = "https://media.storyboard.test/valid.png";
const corruptImageUrl = "https://media.storyboard.test/corrupt.png";
const videoUrl = "https://media.storyboard.test/result.mp4";
const validPng = await readFile(path.resolve("public/storyboard-reviews/storyboard-agent-five-panel-gpt-v32-20260813.png"));
const fixtureDir = path.resolve(".tmp-e2e/storyboard-workbench-p1c");
const videoFixturePath = path.join(fixtureDir, "fixture.mp4");

await mkdir(outputDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });
await mkdir(fixtureDir, { recursive: true });
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const generation = spawnSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10",
  "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  videoFixturePath,
], { encoding: "utf8" });
assert.equal(generation.status, 0, generation.stderr || "无法生成自包含视频夹具");
const validVideo = await readFile(videoFixturePath);

const browser = await chromium.launch({ headless: true });
const results = { layout: [], scroll: [], gates: {}, failure: {}, fixtures: [], batch: {} };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertVideoContract(body, expectedPrompt) {
  assert.equal(body.model_id, "pm_video_veo_a", "视频 DTO 丢失公开模型 ID");
  assert.match(String(body.image_url || ""), /^https:\/\//u, "视频 DTO 未携带公网故事板 URL");
  assert.equal(body.duration, 10, "视频 DTO 时长与固定模型不一致");
  assert.equal(body.aspect_ratio, "16:9", "视频 DTO 比例未沿用工作台设置");
  assert.equal(body.resolution_tier, "1080p", "视频 DTO 清晰度未沿用模型能力");
  assert.equal(body.prompt, expectedPrompt, "视频 DTO 没有原样提交当前卡片的用户 Prompt");
  assert.doesNotMatch(String(body.prompt || ""), /输入参考图是从故事板第一格|视频模型看不到其余故事板格|成片保持正常全屏连续动画|逐格|Frame\s*5|第5格/u, "视频 DTO 偷偷拼入了项目专属执行词");
  assert.equal(body.negative_prompt, undefined, "分镜工作台不应注入项目专属反向词");
}

async function createPage(viewport, options = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  const records = {
    imageRequests: [],
    imageResponses: [],
    imageStatusRequests: [],
    videoRequests: [],
    videoResponses: [],
    videoStatusRequests: [],
    referenceUploads: [],
    pageErrors: [],
  };

  page.on("pageerror", (error) => records.pageErrors.push(error.message));
  const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl });
  records.projectWrites = fixture.projectWrites;

  await page.route("**/api/cover-models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [{
        id: "pm_image_gpt_expensive",
        displayName: "GPT Image premium channel",
        variantLabel: "A",
        avatarUrl: "",
        publicPrice: 0.3,
        capabilities: {
          type: "image",
          family: "gpt",
          supportsImageInput: true,
          resolutionOptions: ["1K", "2K"],
          defaultResolution: "1K",
          supportsReferenceInput: true,
          maxReferenceImages: 8,
        },
      }, {
        id: "pm_image_gpt_tie_basic",
        displayName: "GPT Image basic tie",
        variantLabel: "B",
        avatarUrl: "",
        publicPrice: 0.2,
        capabilities: {
          type: "image",
          family: "gpt",
          supportsImageInput: false,
          resolutionOptions: ["1K"],
          defaultResolution: "1K",
          supportsReferenceInput: false,
          maxReferenceImages: 0,
        },
      }, {
        id: "pm_image_gpt_tie_capable",
        displayName: "GPT Image capable tie",
        variantLabel: "C",
        avatarUrl: "",
        publicPrice: 0.2,
        capabilities: {
          type: "image",
          family: "gpt",
          supportsImageInput: true,
          resolutionOptions: ["1K"],
          defaultResolution: "1K",
          supportsReferenceInput: true,
          maxReferenceImages: 8,
        },
      }, {
        id: "pm_image_gemini_pro",
        displayName: "Gemini Pro Image",
        variantLabel: "D",
        avatarUrl: "",
        publicPrice: 0.05,
        capabilities: {
          type: "image",
          family: "gemini",
          supportsImageInput: false,
          resolutionOptions: ["1K", "2K", "4K"],
          defaultResolution: "2K",
        },
      }, {
        id: "pm_image_gemini_lowest",
        displayName: "Nano Banana lowest",
        variantLabel: "E",
        avatarUrl: "",
        publicPrice: 0.04,
        capabilities: {
          type: "image",
          family: "gemini",
          supportsImageInput: true,
          resolutionOptions: ["1K", "2K", "4K"],
          defaultResolution: "2K",
          supportsReferenceInput: true,
          maxReferenceImages: 8,
        },
      }],
    }),
  }));

  await page.route("**/api/video/models**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      models: [{
        id: "pm_video_veo_a",
        displayName: "Google Veo Fast",
        variantLabel: "A",
        avatarUrl: "",
        publicPrice: 0.8,
        capabilities: {
          type: "video",
          durationMode: "fixed",
          minDuration: 10,
          maxDuration: 10,
          defaultDuration: 10,
          nativeDurations: [10],
          supportsImageInput: true,
          requiresImage: true,
          resolutionTier: "1080p",
          resolutionOptions: ["1080p"],
          defaultResolution: "1080p",
          aspectRatios: ["16:9", "9:16"],
          workspaceSurfaces: ["storyboard"],
        },
      }, {
        id: "pm_video_grok_b",
        displayName: "Grok Imagine 1.5",
        variantLabel: "B",
        avatarUrl: "",
        publicPrice: 0.45,
        capabilities: {
          type: "video",
          durationMode: "range",
          minDuration: 1,
          maxDuration: 15,
          defaultDuration: 8,
          nativeDurations: [],
          supportsImageInput: true,
          requiresImage: true,
          resolutionOptions: ["720p"],
          defaultResolution: "720p",
          aspectRatios: ["16:9", "9:16"],
          workspaceSurfaces: ["storyboard"],
        },
      }],
    }),
  }));

  await page.route("https://media.storyboard.test/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("corrupt.png")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("not-an-image") });
    }
    if (url.endsWith("result.mp4")) {
      return route.fulfill({ status: 200, contentType: "video/mp4", body: validVideo });
    }
    if (options.decodeDelayMs) await sleep(options.decodeDelayMs);
    return route.fulfill({ status: 200, contentType: "image/png", body: validPng });
  });

  await page.route("**/api/image/generate", async (route) => {
    assert.ok(fixture.projectWrites.length > 0, "生图请求前没有先保存账号工程");
    const body = route.request().postDataJSON();
    const record = { at: Date.now(), body };
    records.imageRequests.push(record);
    if (options.imageResponseDelayMs) await sleep(options.imageResponseDelayMs);
    records.imageResponses.push({ at: Date.now(), body });
    const url = String(body.prompt || "").includes("[损坏]") ? corruptImageUrl : validImageUrl;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ images: [{ url }] }),
    });
  });

  await page.route("**/api/image/status?**", async (route) => {
    records.imageStatusRequests.push({ at: Date.now(), url: route.request().url() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "unknown",
        canRecover: false,
        canResubmit: false,
        message: "图片已返回，但文件连续两次无法解码，原请求已保留",
      }),
    });
  });

  await page.route("**/api/image-workbench/persist", async (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: body.url }) });
  });

  await page.route("**/api/storage/upload", async (route) => {
    records.referenceUploads.push({ at: Date.now() });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ file: { url: validImageUrl } }) });
  });

  await page.route("**/api/video/generate", async (route) => {
    assert.ok(fixture.projectWrites.length > 0, "视频请求前没有先保存账号工程");
    const body = route.request().postDataJSON();
    records.videoRequests.push({ at: Date.now(), body });
    if (options.videoResponseDelayMs) await sleep(options.videoResponseDelayMs);
    records.videoResponses.push({ at: Date.now(), body });
    if (options.pendingVideo) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "pending", task_id: "p1c-task", model_id: "pm_video_veo_a" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "completed", video_url: videoUrl }),
    });
  });

  await page.route("**/api/video/status?**", (route) => {
    records.videoStatusRequests.push({ at: Date.now() });
    if (options.videoFailure) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          errorMessage: "上游策略拦截（测试代码 8）",
          retryable: true,
          billingState: "not_charged",
          priceCharged: 0,
        }),
      });
    }
    const completeAfter = options.completeVideoStatusAfter ?? 1;
    const completed = records.videoStatusRequests.length >= completeAfter;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(completed
        ? { status: "completed", videoUrl, progress: 100 }
        : { status: "processing", progress: 31 }),
    });
  });

  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  return { context, page, records, fixture };
}

function requestGaps(records) {
  return records.slice(1).map((item, index) => item.at - records[index].at);
}

async function cardHeight(card) {
  return card.evaluate((element) => element.getBoundingClientRect().height);
}

{
  const { context, page, records } = await createPage({ width: 1440, height: 900 }, { pendingVideo: true, videoFailure: true });
  const card = page.locator(".sbw-shot-card").first();
  await card.locator("textarea").nth(0).fill("失败状态契约测试故事板");
  await card.locator("textarea").nth(2).fill("按故事板连续演出");
  await card.getByRole("button", { name: "生成图片", exact: true }).click();
  await card.getByText("图片完成").waitFor({ timeout: 10_000 });
  const failureVideoButton = card.getByRole("button", { name: "生成视频", exact: true });
  await page.waitForFunction(() => {
    const button = document.querySelector('.sbw-shot-card button.is-video-command');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 10_000 }).catch(async (error) => {
    const diagnostics = await card.evaluate((element) => ({
      state: element.getAttribute("data-card-state"),
      text: element.innerText,
      videoButton: (() => {
        const button = element.querySelector("button.is-video-command");
        return button instanceof HTMLButtonElement ? { disabled: button.disabled, title: button.title, text: button.innerText } : null;
      })(),
    }));
    throw new Error(`图片完成后视频未解锁：${JSON.stringify(diagnostics)}；${error instanceof Error ? error.message : String(error)}`);
  });
  await failureVideoButton.click();
  await card.getByText("上游策略拦截（测试代码 8）").waitFor({ timeout: 10_000 });
  assert.equal(await card.getAttribute("data-card-state"), "failed", "上游失败没有映射为卡片失败状态");
  assert.equal(await card.locator(".sbw-video-frame").count(), 1, "视频失败后错误舞台被错误收起");
  assert.equal(await card.getByRole("button", { name: /生成视频|重试生成/u }).isDisabled(), false, "视频失败后无法手动重试");
  results.failure = { videoRequests: records.videoRequests.length, statusRequests: records.videoStatusRequests.length, pageErrors: records.pageErrors };
  assert.equal(records.pageErrors.length, 0, "视频失败契约测试出现页面脚本错误");
  await context.close();
}

for (const scenario of [
  { width: 1920, height: 1080, columns: 3 },
  { width: 1440, height: 900, columns: 3 },
  { width: 1280, height: 800, columns: 3 },
]) {
  const { context, page, records } = await createPage(scenario);
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "添加镜头", exact: true }).first().click();
  }
  const cards = page.locator(".sbw-shot-card");
  assert.equal(await cards.count(), 6, `${scenario.width}px 未成功建立两行验收卡片`);
  const metrics = await page.evaluate(() => {
    const cardRects = Array.from(document.querySelectorAll(".sbw-shot-card"), (element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    const columns = getComputedStyle(document.querySelector(".sbw-shot-grid")).gridTemplateColumns.split(" ").length;
    const flowOrder = Array.from(document.querySelectorAll(".sbw-shot-card"), (card) => {
      const image = card.querySelector(".sbw-image-flow")?.getBoundingClientRect();
      const video = card.querySelector(".sbw-video-flow")?.getBoundingClientRect();
      return { imageTop: image?.top || 0, imageBottom: image?.bottom || 0, videoTop: video?.top || 0 };
    });
    const mediaStages = Array.from(document.querySelectorAll(".sbw-shot-card"), (card) => {
      const imageFlow = card.querySelector(".sbw-image-flow")?.getBoundingClientRect();
      const image = card.querySelector(".sbw-image-frame")?.getBoundingClientRect();
      const video = card.querySelector(".sbw-video-frame")?.getBoundingClientRect();
      const videoCompact = card.querySelector(".sbw-video-compact")?.getBoundingClientRect();
      return {
        imageWidth: image?.width || 0,
        imageHeight: image?.height || 0,
        imageFlowWidth: imageFlow?.width || 0,
        videoWidth: video?.width || 0,
        videoHeight: video?.height || 0,
        videoCompactHeight: videoCompact?.height || 0,
      };
    });
    const promptHeights = Array.from(document.querySelectorAll(".sbw-flow-prompt > textarea"), (element) => element.getBoundingClientRect().height);
    const exactTextHeights = Array.from(document.querySelectorAll(".sbw-exact-text-field textarea"), (element) => element.getBoundingClientRect().height);
    const fontSize = (selector) => {
      const element = document.querySelector(selector);
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0;
    };
    return {
      columns,
      railWidth: document.querySelector(".sbw-model-rail")?.getBoundingClientRect().width || 0,
      cardRects,
      flowOrder,
      mediaStages,
      promptHeights,
      exactTextHeights,
      fontSizes: {
        prompt: fontSize(".sbw-flow-prompt textarea"),
        cardTitle: fontSize(".sbw-card-title strong"),
        modelName: fontSize(".sbw-model-name"),
        price: fontSize(".sbw-model-inline-meta"),
        status: fontSize(".sbw-status-pair span"),
        auxiliary: fontSize(".sbw-reference-toggle span"),
      },
      browserScale: window.visualViewport?.scale || 1,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });
  assert.equal(metrics.columns, scenario.columns, `${scenario.width}px 列数错误`);
  assert.ok(metrics.railWidth >= 311 && metrics.railWidth <= 313, `${scenario.width}px 模型栏不是312px：${metrics.railWidth}`);
  assert.ok(Math.max(...metrics.cardRects.map((item) => item.height)) - Math.min(...metrics.cardRects.map((item) => item.height)) <= 1, `${scenario.width}px 卡片不等高`);
  assert.ok(metrics.cardRects.every((item) => item.scrollWidth <= item.clientWidth + 1), `${scenario.width}px 卡片内部横向溢出`);
  assert.ok(metrics.documentScrollWidth <= metrics.documentClientWidth + 1, `${scenario.width}px 页面横向溢出`);
  assert.ok(metrics.flowOrder.every((item) => item.imageTop < item.videoTop && item.imageBottom <= item.videoTop), `${scenario.width}px 未按上图下视频纵向排列`);
  assert.ok(metrics.mediaStages.every((item) => item.imageWidth >= item.imageFlowWidth * 0.95), `${scenario.width}px 图片舞台没有横向铺满工作区`);
  assert.ok(metrics.mediaStages.every((item) => item.imageHeight >= 76 && item.imageHeight <= 100), `${scenario.width}px 空图片占位高度不够紧凑`);
  assert.ok(metrics.mediaStages.every((item) => item.videoWidth === 0 && item.videoHeight === 0 && item.videoCompactHeight >= 32 && item.videoCompactHeight <= 48), `${scenario.width}px 未生成视频仍预占大舞台`);
  assert.ok(metrics.promptHeights.every((height) => height >= 58 && height <= 64), `${scenario.width}px Prompt 默认高度没有保持在60px紧凑规格：${metrics.promptHeights.join(",")}`);
  assert.ok(metrics.exactTextHeights.every((height) => height >= 44 && height <= 48), `${scenario.width}px 精确文字输入框未保持紧凑规格：${metrics.exactTextHeights.join(",")}`);
  assert.equal(metrics.browserScale, 1, `${scenario.width}px 浏览器不是100%缩放`);
  assert.ok(metrics.fontSizes.prompt >= 13, `${scenario.width}px Prompt 正文字号小于13px`);
  assert.ok(metrics.fontSizes.cardTitle >= 14, `${scenario.width}px 卡片标题字号小于14px`);
  assert.ok(metrics.fontSizes.modelName >= 14, `${scenario.width}px 模型名称字号小于14px`);
  assert.ok(metrics.fontSizes.price >= 12, `${scenario.width}px 价格字号小于12px：${metrics.fontSizes.price}px`);
  assert.ok(metrics.fontSizes.status >= 12, `${scenario.width}px 状态字号小于12px`);
  assert.ok(metrics.fontSizes.auxiliary >= 12, `${scenario.width}px 辅助文字字号小于12px`);
  assert.equal(await page.locator(".sbw-reference-controls, .sbw-reference-list").count(), 0, `${scenario.width}px 参考图仍展开了控制区或缩略图`);
  const referenceToggleHeight = await page.locator(".sbw-reference-toggle").first().evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(referenceToggleHeight >= 32 && referenceToggleHeight <= 40, `${scenario.width}px 外部参考资产折叠行高度错误`);
  const avatarSources = await page.locator(".sbw-model-icon img").evaluateAll((images) => images.map((image) => image.getAttribute("src") || ""));
  const visibleModelCount = await page.locator(".sbw-image-model-list > button, .sbw-video-model-list > button").count();
  const badgeMetrics = await page.locator("[data-model-badge]").evaluateAll((badges) => badges.map((badge) => {
    const box = badge.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      source: badge.getAttribute("data-model-badge-source"),
      selected: badge.getAttribute("data-selected"),
      availability: badge.getAttribute("data-availability"),
    };
  }));
  assert.equal(badgeMetrics.length, visibleModelCount, `${scenario.width}px 模型徽章数量与可见模型数量不一致`);
  assert.ok(badgeMetrics.every((badge) => badge.width >= 42 && badge.width <= 44 && badge.height >= 42 && badge.height <= 44), `${scenario.width}px 模型徽章没有保持42-44px视觉面积`);
  assert.ok(badgeMetrics.every((badge) => ["avatar", "brand", "initial"].includes(badge.source)), `${scenario.width}px 模型徽章缺少可审计的来源回退`);
  assert.ok(badgeMetrics.every((badge) => ["true", "false"].includes(badge.selected) && ["ready", "unavailable"].includes(badge.availability)), `${scenario.width}px 模型徽章缺少选中态或可用态`);
  assert.equal(avatarSources.length, visibleModelCount, `${scenario.width}px 模型头像数量与可见模型数量不一致`);
  assert.ok(avatarSources.every((source) => source.startsWith("/model-brands/") && source.endsWith(".svg")), `${scenario.width}px 模型头像不是稳定本地资产`);
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".sbw-model-icon img")).every((image) => image.complete && image.naturalWidth > 0));
  const renderedDom = await page.locator("body").innerText();
  const renderedHtml = await page.content();
  const internalValues = ["secret-provider-channel", "internal-image-p1c-id", "internal-video-p1c-id", "internal-gpt-image-2"];
  assert.ok(internalValues.every((value) => !renderedDom.includes(value) && !renderedHtml.includes(value)), `${scenario.width}px DOM 暴露内部模型字段`);
  if (scenario.width >= 1440) {
    const firstRow = metrics.cardRects.slice(0, scenario.columns);
    const secondRowTop = metrics.cardRects[scenario.columns].top;
    assert.ok(Math.max(...firstRow.map((item) => item.bottom)) <= scenario.height, `${scenario.width}px 第一行未完整显示`);
    assert.ok(scenario.height - secondRowTop >= 48, `${scenario.width}px 第二行露出不足48px`);
  }
  if (scenario.width === 1440) {
    const firstCard = cards.first();
    assert.equal(await page.locator(".sbw-image-model-list button:not(:disabled)").count(), 5, "已配置且可用的生图模型没有全部保持可见");
    const imageModelText = await page.locator(".sbw-image-model-list").innerText();
    assert.match(imageModelText, /GPT Image premium channel[\s\S]*¥0\.30\/\u5f20/u, "GPT premium 模型或价格未显示");
    assert.match(imageModelText, /Nano Banana lowest[\s\S]*¥0\.04\/\u5f20/u, "Nano Banana 模型或价格未显示");
    assert.equal(await page.locator(".sbw-video-model-list button").count(), 2, "公开 DTO 视频模型被错误过滤");
    await page.getByRole("button", { name: "选择生图模型：Nano Banana lowest · E", exact: true }).click();
    const imageResolution = page.getByRole("combobox", { name: "图片分辨率", exact: true });
    assert.equal(await imageResolution.inputValue(), "2K", "切换生图模型后没有使用后台声明的默认分辨率");
    assert.deepEqual(await imageResolution.locator("option").allTextContents(), ["1K", "2K", "4K"], "生图分辨率没有按模型能力收窄");
    await page.getByRole("button", { name: "选择生图模型：GPT Image premium channel · A", exact: true }).click();

    await page.getByRole("button", { name: "选择视频模型：Grok Imagine 1.5", exact: true }).click();
    const videoDuration = page.getByRole("combobox", { name: "视频时长", exact: true });
    assert.equal(await videoDuration.locator("option").last().textContent(), "15 秒", "视频时长上限没有按模型能力显示");
    await videoDuration.selectOption("15");
    assert.equal(await videoDuration.inputValue(), "15", "用户选择的视频时长没有保存");
    assert.ok((await page.locator(".sbw-control-group.is-video").innerText()).includes("720p"), "视频分辨率没有随模型自动匹配");
    await page.getByRole("button", { name: "选择视频模型：Google Veo Fast", exact: true }).click();
    assert.ok((await page.locator(".sbw-control-group.is-video").innerText()).includes("固定 10 秒"), "固定时长模型没有恢复原生时长");

    await page.evaluate(() => navigator.clipboard.writeText("剪贴板直达生图提示词"));
    await firstCard.getByRole("button", { name: "粘贴镜头1生图提示词", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".sbw-shot-card textarea")?.value === "剪贴板直达生图提示词");
    assert.equal(await firstCard.locator("textarea").nth(0).inputValue(), "剪贴板直达生图提示词", "生图提示词粘贴按钮没有写入对应输入框");
    await context.clearPermissions();
    await firstCard.getByRole("button", { name: "粘贴镜头1视频提示词", exact: true }).click();
    await page.locator(".sbw-notice").filter({ hasText: "Ctrl+V" }).waitFor();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    assert.equal(await page.locator(".sbw-root").getAttribute("data-ratio"), "16:9", "默认媒体模式不是16:9");
    await page.getByRole("button", { name: "9:16", exact: true }).click();
    assert.equal(await page.locator(".sbw-root").getAttribute("data-ratio"), "9:16", "9:16模式没有切换媒体比例");
    const portraitStage = await firstCard.locator(".sbw-image-frame").evaluate((element) => ({ width: element.getBoundingClientRect().width, parentWidth: element.parentElement?.getBoundingClientRect().width || 0 }));
    assert.ok(portraitStage.width >= portraitStage.parentWidth * 0.95, "竖版图片舞台没有铺满卡片内容区");
    await page.getByRole("button", { name: "16:9", exact: true }).click();
  }
  await page.screenshot({ path: path.join(outputDir, `storyboard-p1c-${scenario.width}.png`), fullPage: false });
  results.layout.push({ viewport: scenario, metrics, referenceToggleHeight, avatarSources, badgeMetrics, pageErrors: records.pageErrors });
  assert.equal(records.pageErrors.length, 0, `${scenario.width}px 页面存在脚本错误`);
  await context.close();
}

for (const scenario of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  const { context, page, records } = await createPage(scenario);
  for (let index = 3; index < 12; index += 1) {
    await page.getByRole("button", { name: "添加镜头", exact: true }).first().click();
  }
  assert.equal(await page.locator(".sbw-shot-card").count(), 12, `${scenario.width}px 未建立12张滚动验收卡片`);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const workspace = document.querySelector(".sbw-workspace");
    if (workspace) workspace.scrollTop = 0;
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const workspace = document.querySelector(".sbw-workspace");
    if (workspace instanceof HTMLElement) {
      workspace.tabIndex = -1;
      workspace.focus();
    }
  });
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(120);
  const pageDownY = await page.evaluate(() => {
    const workspace = document.querySelector(".sbw-workspace");
    const internal = workspace && getComputedStyle(workspace).overflowY !== "visible" && workspace.scrollHeight > workspace.clientHeight;
    return internal ? workspace.scrollTop : window.scrollY;
  });
  const scrollDiagnostics = await page.evaluate(() => ({
    windowY: window.scrollY,
    scrollingElement: document.scrollingElement?.tagName,
    documentHeight: document.documentElement.scrollHeight,
    documentClientHeight: document.documentElement.clientHeight,
    bodyHeight: document.body.scrollHeight,
    bodyClientHeight: document.body.clientHeight,
    activeElement: document.activeElement?.tagName,
    ancestors: Array.from(document.querySelector(".sbw-workspace")?.parentElement ? [document.querySelector(".sbw-workspace"), document.querySelector(".sbw-workspace")?.parentElement, document.querySelector(".sbw-root"), document.body, document.documentElement] : []).filter(Boolean).map((element) => ({
      tag: element.tagName,
      className: element.className,
      overflowY: getComputedStyle(element).overflowY,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    })),
  }));
  assert.ok(pageDownY > 0, `${scenario.width}px PageDown 无法滚动工作台：${JSON.stringify(scrollDiagnostics)}`);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const workspace = document.querySelector(".sbw-workspace");
    if (workspace instanceof HTMLElement) {
      workspace.tabIndex = -1;
      workspace.focus();
    }
  });
  await page.keyboard.press("End");
  await page.waitForTimeout(160);
  const bottom = await page.evaluate(() => {
    const workspace = document.querySelector(".sbw-workspace");
    const workspaceRect = workspace?.getBoundingClientRect();
    const internal = workspace && getComputedStyle(workspace).overflowY !== "visible" && workspace.scrollHeight > workspace.clientHeight;
    const cards = document.querySelectorAll(".sbw-shot-card");
    const lastCard = cards[cards.length - 1]?.getBoundingClientRect();
    const addButton = document.querySelector(".sbw-add-card")?.getBoundingClientRect();
    const toolbar = document.querySelector(".sbw-toolbar")?.getBoundingClientRect();
    return {
      scrollY: internal ? workspace.scrollTop : window.scrollY,
      maxScrollY: internal
        ? Math.max(0, workspace.scrollHeight - workspace.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      lastCard: lastCard ? { top: lastCard.top, bottom: lastCard.bottom } : null,
      addButton: addButton ? { top: addButton.top, bottom: addButton.bottom } : null,
      toolbarBottom: toolbar?.bottom || 0,
      viewportBottom: internal ? workspaceRect?.bottom || window.innerHeight : window.innerHeight,
      innerHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });
  assert.ok(bottom.scrollY >= bottom.maxScrollY - 2, `${scenario.width}px End 没有滚到页面底部`);
  const lastCardVisibleRatio = bottom.lastCard
    ? Math.max(0, Math.min(bottom.lastCard.bottom, bottom.viewportBottom) - Math.max(bottom.lastCard.top, bottom.toolbarBottom))
      / Math.max(1, bottom.lastCard.bottom - bottom.lastCard.top)
    : 0;
  assert.ok(lastCardVisibleRatio >= 0.85, `${scenario.width}px 最后一张卡片主体可见比例不足：${lastCardVisibleRatio.toFixed(3)} ${JSON.stringify(bottom)}`);
  assert.ok(bottom.addButton && bottom.addButton.top >= 0 && bottom.addButton.bottom <= bottom.viewportBottom + 1, `${scenario.width}px 底部添加镜头按钮不可达`);
  assert.ok(bottom.documentScrollWidth <= bottom.documentClientWidth + 1, `${scenario.width}px 12卡状态产生横向溢出`);
  results.scroll.push({ viewport: scenario, pageDownY, bottom, lastCardVisibleRatio, pageErrors: records.pageErrors });
  assert.equal(records.pageErrors.length, 0, `${scenario.width}px 滚动测试存在页面脚本错误`);
  await context.close();
}

for (const scenario of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  const { context, page, records } = await createPage(scenario);
  const card = page.locator(".sbw-shot-card").first();
  await card.locator("textarea").nth(0).fill("生成4–5格3D动画故事板，根据语义自适应为2×2或四格加底部全宽锨点，角色与场景一致，16:9");
  await card.locator("textarea").nth(2).fill("把故事板作为视觉素材库，依据语义选择2–3个核心镜头，强化动作、表情与环境反馈");
  await card.getByRole("button", { name: "生成图片", exact: true }).click();
  await card.getByText("图片完成").waitFor({ timeout: 10_000 });
  await card.getByRole("button", { name: "生成视频", exact: true }).click();
  await card.locator("video").waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => (document.querySelector(".sbw-shot-card video")?.readyState || 0) >= 1);
  await card.scrollIntoViewIfNeeded();
  const metrics = await card.evaluate((element) => {
    const imageFlow = element.querySelector(".sbw-image-flow")?.getBoundingClientRect();
    const imageStage = element.querySelector(".sbw-image-frame")?.getBoundingClientRect();
    const videoFlow = element.querySelector(".sbw-video-flow")?.getBoundingClientRect();
    const videoStage = element.querySelector(".sbw-video-frame")?.getBoundingClientRect();
    const prompts = Array.from(element.querySelectorAll(".sbw-flow-prompt > textarea"), (textarea) => textarea.getBoundingClientRect().height);
    const promptGaps = Array.from(element.querySelectorAll(".sbw-flow-section"), (flow) => {
      const textarea = flow.querySelector("textarea")?.getBoundingClientRect();
      const zoneTitle = flow.querySelector(":scope > .sbw-zone-title")?.getBoundingClientRect();
      return textarea && zoneTitle ? zoneTitle.top - textarea.bottom : 999;
    });
    const video = element.querySelector("video");
    return {
      cardHeight: element.getBoundingClientRect().height,
      imageStageRatio: (imageStage?.width || 0) / Math.max(1, imageFlow?.width || 0),
      videoStageRatio: (videoStage?.width || 0) / Math.max(1, videoFlow?.width || 0),
      promptHeights: prompts,
      promptGaps,
      videoReadyState: video?.readyState || 0,
      videoDuration: Number.isFinite(video?.duration) ? video.duration : 0,
    };
  });
  assert.ok(metrics.imageStageRatio >= 0.95 && metrics.videoStageRatio >= 0.95, `${scenario.width}px 完成态媒体舞台没有占满卡片内容区`);
  assert.ok(metrics.promptHeights.every((height) => height >= 58 && height <= 64), `${scenario.width}px 完成态 Prompt 输入框未保持60px稳定高度：${metrics.promptHeights.join(",")}`);
  assert.ok(metrics.promptGaps.every((gap) => gap >= 7), `${scenario.width}px 完成态 Prompt 与媒体标题发生覆盖：${metrics.promptGaps.join(",")}`);
  assert.ok(metrics.videoReadyState >= 1 && metrics.videoDuration > 0, `${scenario.width}px 完成态视频不可播放`);
  assert.equal(records.pageErrors.length, 0, `${scenario.width}px 完成态存在页面脚本错误`);
  await page.screenshot({ path: path.join(outputDir, `storyboard-p1c-done-${scenario.width}.png`), fullPage: false });
  results.fixtures.push({ viewport: scenario, metrics, pageErrors: records.pageErrors });
  await context.close();
}

{
  const { context, page, records, fixture } = await createPage({ width: 1440, height: 900 }, {
    decodeDelayMs: 650,
    pendingVideo: true,
    completeVideoStatusAfter: 2,
  });
  const cards = page.locator(".sbw-shot-card");
  const firstCard = cards.nth(0);
  const secondCard = cards.nth(1);
  const initialHeight = await cardHeight(firstCard);

  await firstCard.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: validPng });
  await firstCard.getByText(/已上传 1\/\d+ 张/u).waitFor();
  assert.equal(records.referenceUploads.length, 1, "参考图按钮没有完成上传");
  assert.equal(await firstCard.locator(".sbw-reference-list img").count(), 0, "上传后的参考图仍在卡片中展开显示");
  await firstCard.locator("textarea").nth(0).fill("有效图片门禁测试");
  await firstCard.locator("textarea").nth(2).fill("狗狗快速跑向主人，镜头平稳跟拍");
  const imageButton = firstCard.getByRole("button", { name: "生成图片", exact: true });
  await imageButton.evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelectorAll('[data-card-state="running"], [data-card-state="queued"]').length > 0);
  const runningHeight = await cardHeight(firstCard);
  assert.equal(records.imageRequests.length, 1, "双击生图产生了重复提交");
  assert.deepEqual(records.imageRequests[0].body.referenceImageUrls, [validImageUrl], "已上传参考图没有随生图任务提交");
  assert.equal(await firstCard.getByRole("button", { name: "生成视频", exact: true }).isDisabled(), true, "图片尚未完成浏览器解码时视频提前解锁");
  await firstCard.getByText("图片完成").waitFor({ timeout: 10_000 });
  const doneHeight = await cardHeight(firstCard);
  const completedImageMetrics = await firstCard.evaluate((card) => {
    const flow = card.querySelector(".sbw-image-flow")?.getBoundingClientRect();
    const stage = card.querySelector(".sbw-image-frame")?.getBoundingClientRect();
    const image = card.querySelector(".sbw-image-frame img");
    return {
      flowWidth: flow?.width || 0,
      stageWidth: stage?.width || 0,
      stageHeight: stage?.height || 0,
      imageNaturalWidth: image?.naturalWidth || 0,
      imageNaturalHeight: image?.naturalHeight || 0,
    };
  });
  assert.ok(completedImageMetrics.stageWidth >= completedImageMetrics.flowWidth * 0.95, "完成态故事板没有铺满图片区");
  assert.ok(completedImageMetrics.stageHeight >= 76, `完成态故事板舞台发生塌陷：${completedImageMetrics.stageHeight}px`);
  assert.equal(await firstCard.getByRole("button", { name: "生成视频", exact: true }).isDisabled(), false, "有效图片解码完成后视频没有解锁");
  assert.equal(await firstCard.locator(".sbw-video-frame").count(), 0, "未点击生成视频前仍预占视频舞台");
  await firstCard.locator(".sbw-image-frame > button").click();
  const originalPreview = page.locator(".sbw-lightbox img");
  await originalPreview.waitFor();
  const originalSize = await originalPreview.evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  assert.deepEqual(originalSize, { width: 1280, height: 720 }, "点击故事板没有打开可辨认原图");
  await page.locator(".sbw-lightbox > button").click();

  await firstCard.locator("textarea").nth(0).fill("长提示词".repeat(1200));
  const promptMetrics = await firstCard.locator("textarea").nth(0).evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(promptMetrics.scrollHeight > promptMetrics.clientHeight, "长提示词没有在输入框内部滚动");
  const longPromptCardHeight = await cardHeight(firstCard);
  const longPromptGeometry = await firstCard.evaluate((card) => ({
    rows: Array.from(card.children, (element) => ({ className: element.className, height: element.getBoundingClientRect().height })),
    prompts: Array.from(card.querySelectorAll("textarea"), (element) => {
      const style = getComputedStyle(element);
      return {
        exactText: Boolean(element.closest(".sbw-exact-text-field")),
        height: element.getBoundingClientRect().height,
        cssHeight: style.height,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        fieldSizing: style.getPropertyValue("field-sizing"),
        overflowY: style.overflowY,
      };
    }),
  }));
  assert.ok(longPromptGeometry.prompts.every((prompt) => (prompt.exactText
    ? prompt.height >= 44 && prompt.height <= 48
    : prompt.height >= 58 && prompt.height <= 64)
    && prompt.fieldSizing === "fixed" && prompt.overflowY === "auto"), `长提示词没有保持固定高度内部滚动：${JSON.stringify(longPromptGeometry)}`);
  assert.ok(Math.abs(longPromptCardHeight - doneHeight) <= 64, `长提示词触发了不可控卡片增高：${doneHeight}px -> ${longPromptCardHeight}px ${JSON.stringify(longPromptGeometry)}`);

  await secondCard.locator("textarea").nth(0).fill("[损坏] 图片文件验证");
  await secondCard.locator("textarea").nth(2).fill("该视频不应提交");
  await secondCard.getByRole("button", { name: "生成图片", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sbw-shot-card')[1]?.getAttribute('data-card-state') === "failed", null, { timeout: 15_000 });
  await secondCard.getByText("图片结果待确认", { exact: true }).waitFor({ timeout: 10_000 });
  await secondCard.getByText(/文件连续两次无法解码/u).waitFor({ timeout: 10_000 });
  assert.equal(await secondCard.getByRole("button", { name: "生成视频", exact: true }).isDisabled(), true, "损坏图片错误解锁了视频");
  const corruptRequests = records.imageRequests.filter((item) => String(item.body.prompt).includes("[损坏]"));
  assert.equal(corruptRequests.length, 2, "损坏图片没有执行一次受控读取重试");
  assert.equal(new Set(corruptRequests.map((item) => item.body.clientIdempotencyKey)).size, 1, "损坏图片读取重试更换了幂等键，存在重复计费风险");
  assert.ok(records.imageStatusRequests.length >= 1, "损坏图片失败后没有核对原任务状态");
  assert.equal(await secondCard.getByRole("button", { name: "结果待确认", exact: true }).isDisabled(), true, "结果未确认时仍允许重复提交生图");
  const corruptFailureHeight = await cardHeight(secondCard);
  assert.ok(Math.abs(corruptFailureHeight - initialHeight) <= 80, `生图失败状态产生了不可控高度跳变：${initialHeight}px -> ${corruptFailureHeight}px`);

  await firstCard.getByRole("button", { name: "生成视频", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.sbw-shot-card')?.getAttribute('data-card-state') === "running");
  await page.waitForFunction(() => document.querySelectorAll("video").length === 0
    && /实时连接暂不可用|正在查询任务状态/u.test(document.body.textContent || ""));
  assert.equal(records.videoRequests.length, 1, "视频产生了重复提交");
  assertVideoContract(records.videoRequests[0].body, "狗狗快速跑向主人，镜头平稳跟拍");
  const runningPromptGap = await firstCard.evaluate((element) => {
    const textarea = element.querySelector(".sbw-video-flow textarea")?.getBoundingClientRect();
    const zoneTitle = element.querySelector(".sbw-video-flow > .sbw-zone-title")?.getBoundingClientRect();
    return textarea && zoneTitle ? zoneTitle.top - textarea.bottom : -1;
  });
  assert.ok(runningPromptGap >= 7, `视频生成中 Prompt 与标题发生覆盖：${runningPromptGap}`);
  const expandedRunningHeight = await cardHeight(firstCard);
  assert.ok(expandedRunningHeight > doneHeight + 120, "视频提交后没有自动展开加载舞台");
  const projectSaveDeadline = Date.now() + 10_000;
  while (!fixture.latestDocument()?.cards?.[0]?.videoTaskId && Date.now() < projectSaveDeadline) {
    await page.waitForTimeout(100);
  }
  const savedProject = fixture.latestDocument();
  assert.ok(savedProject?.cards?.[0]?.videoTaskId, "视频任务 ID 没有同步到账号工程，无法验证刷新恢复");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "最近任务", exact: true }).click();
  const projectRecord = page.locator(`[data-storyboard-project-id="${savedProject.id}"]`);
  await projectRecord.waitFor({ timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await projectRecord.getByRole("button", { name: "打开任务", exact: true }).click();
  await page.locator(".sbw-shot-card").first().getByText("视频完成").waitFor({ timeout: 10_000 });
  assert.equal(records.videoRequests.length, 1, "刷新续跑时重复创建了视频任务");
  assert.ok(records.videoStatusRequests.length >= 2, "刷新后没有恢复视频轮询");
  const completedCard = page.locator(".sbw-shot-card").first();
  const completedVideo = completedCard.locator("video");
  await completedVideo.waitFor();
  await page.waitForFunction(() => (document.querySelector(".sbw-shot-card video")?.readyState || 0) >= 1);
  const videoMetrics = await completedCard.evaluate((card) => {
    const flow = card.querySelector(".sbw-video-flow")?.getBoundingClientRect();
    const stage = card.querySelector(".sbw-video-frame")?.getBoundingClientRect();
    const video = card.querySelector("video");
    return {
      flowWidth: flow?.width || 0,
      stageWidth: stage?.width || 0,
      stageHeight: stage?.height || 0,
      readyState: video?.readyState || 0,
      duration: Number.isFinite(video?.duration) ? video.duration : 0,
    };
  });
  assert.ok(videoMetrics.stageWidth >= videoMetrics.flowWidth * 0.95, "完成态视频舞台没有铺满视频区");
  assert.ok(videoMetrics.readyState >= 1 && videoMetrics.duration > 0, "视频 fixture 不可播放");
  await completedCard.getByRole("button", { name: "收起镜头1视频区域", exact: true }).click();
  assert.equal(await completedCard.locator(".sbw-video-frame").count(), 0, "完成态视频无法手动收起");
  const collapsedVideoHeight = await completedCard.locator(".sbw-video-compact").evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(collapsedVideoHeight <= 48, "收起后视频状态栏仍然过高");
  await completedCard.getByRole("button", { name: "展开镜头1视频区域", exact: true }).click();
  await completedCard.locator("video").waitFor();
  await page.screenshot({ path: path.join(outputDir, "storyboard-p1c-gates.png"), fullPage: false });
  results.gates = {
    initialHeight,
    runningHeight,
    doneHeight,
    completedImageMetrics,
    expandedRunningHeight,
    runningPromptGap,
    videoMetrics,
    collapsedVideoHeight,
    promptMetrics,
    imageRequests: records.imageRequests.length,
    videoRequests: records.videoRequests.length,
    videoStatusRequests: records.videoStatusRequests.length,
    pageErrors: records.pageErrors,
  };
  assert.equal(records.pageErrors.length, 0, "门禁测试期间存在页面脚本错误");
  await context.close();
}

{
  const { context, page, records } = await createPage({ width: 1440, height: 900 }, {
    imageResponseDelayMs: 11_000,
    videoResponseDelayMs: 17_000,
  });
  const cards = page.locator(".sbw-shot-card");
  for (let index = 0; index < 3; index += 1) {
    await cards.nth(index).locator("textarea").nth(0).fill(`批量图片 ${index + 1}`);
    await cards.nth(index).locator("textarea").nth(2).fill(`批量视频 ${index + 1}`);
  }
  await page.getByRole("button", { name: "批量生图", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-card-state="done"]').length === 3, null, { timeout: 30_000 });
  const imageGaps = requestGaps(records.imageRequests);
  assert.ok(imageGaps.every((gap) => gap >= 4_700 && gap <= 5_700), `批量生图提交间隔错误：${imageGaps.join(",")}`);
  assert.ok(records.imageRequests[2].at < records.imageResponses[0].at, "批量生图仍在等待上一任务完成，没有并发提交");
  assert.equal(await page.getByRole("button", { name: "批量视频", exact: true }).isDisabled(), false, "全部图片解码后批量视频未解锁");

  await page.getByRole("button", { name: "批量视频", exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-card-state="done"]')).length === 3, null, { timeout: 40_000 });
  const videoGaps = requestGaps(records.videoRequests);
  records.videoRequests.forEach((request, index) => assertVideoContract(request.body, `批量视频 ${index + 1}`));
  assert.ok(videoGaps.every((gap) => gap >= 7_700 && gap <= 8_700), `批量视频提交间隔错误：${videoGaps.join(",")}`);
  assert.ok(records.videoRequests[2].at < records.videoResponses[0].at, "批量视频仍在等待上一任务完成，没有并发提交");
  results.batch = {
    imageGaps,
    videoGaps,
    imageConcurrent: records.imageRequests[2].at < records.imageResponses[0].at,
    videoConcurrent: records.videoRequests[2].at < records.videoResponses[0].at,
    pageErrors: records.pageErrors,
  };
  assert.equal(records.pageErrors.length, 0, "批量测试期间存在页面脚本错误");
  await context.close();
}

await browser.close();
await writeFile(resultPath, JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), results }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, resultPath, results }, null, 2));
