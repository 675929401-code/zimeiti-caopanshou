import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const outputDir = ".tmp-e2e";
const runId = "free-canvas-ui-e2e-audit-20260812";
const candidateLandscape = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#102033"/><path d="M170 520 C340 380 480 570 640 450 S970 320 1110 490 S1320 620 1460 440" fill="none" stroke="#38bdf8" stroke-width="18" stroke-linecap="round" opacity=".82"/><circle cx="810" cy="455" r="122" fill="#facc15" opacity=".9"/><text x="800" y="742" text-anchor="middle" font-size="60" fill="#ffffff" font-family="Arial">16:9 E2E media</text></svg>')}`;

const script = "一只拉布拉多趁主人出门取快递，把玄关的雨伞拖到客厅当成玩具。伞骨突然弹开，它吓得后退，爪子又踩到地上的水印，像犯罪现场一样留下一串湿脚印。门锁响起时，它赶紧把伞推到窗帘后面，尾巴却露在外面轻轻发抖。主人进门看见水迹一路通向窗帘，拉布拉多假装睡觉，眼皮却偷偷睁开一条缝。它胸前浮出浅蓝色心虚颤线，脚印旁边冒出几个小感叹号。主人没有责备，只把伞收好。拉布拉多慢慢叼来毛巾，笨拙地把湿脚印擦了两下。";

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt?: string;
    visualOrder?: number;
    assetRole?: string;
    status: string;
    outputUrl?: string;
    modelId?: string;
    selectedCandidateId?: string;
    candidateSelectionRequired?: boolean;
    history?: Array<{ outputUrl?: string }>;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

type MediaRequest = {
  type: "image" | "video";
  shot: string;
  modelId?: string;
  prompt: string;
  aspectRatio?: string;
  submittedAt: number;
  referenceImageUrls?: string[];
};

function shotNumber(text: string) {
  const value = text.match(/(?:镜头|分镜)\s*0*(\d+)/u)?.[1] || "";
  return value ? String(Number(value)) : "";
}

function semanticPackagingHit(text = "") {
  return /心虚|颤线|浅蓝|感叹号|湿脚印|水迹|发抖|证据|窗帘/u.test(text)
    && /非文字|装饰|线条|符号|语义证据|情绪可视化|绑定|浮出|抖动/u.test(text);
}

async function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

async function ensurePanel(page: Page) {
  const panel = page.locator('aside[aria-label="制作面板"]');
  if (await panel.count() === 0) {
    await page.getByRole("button", { name: "打开制作面板" }).click();
  }
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

async function waitForGraphReady(page: Page) {
  await page.waitForFunction((key) => {
    const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
    const keyframes = graph?.nodes.filter((node) => node.data.assetRole === "storyboard-keyframe") || [];
    const videos = graph?.nodes.filter((node) => node.data.kind === "video") || [];
    const characters = graph?.nodes.filter((node) => node.data.assetRole === "character-reference") || [];
    const runAll = document.querySelector(".free-canvas-actions button.run-all") as HTMLButtonElement | null;
    return !document.body.innerText.includes("正在交给")
      && Boolean(runAll && !runAll.disabled)
      && characters.length > 0
      && keyframes.length >= 4
      && keyframes.length === videos.length;
  }, graphKey, { timeout: 180_000 });
  await page.waitForTimeout(1_000);
}

async function waitForMediaDone(page: Page, kinds: Array<"image" | "video">, timeout = 240_000) {
  await page.waitForFunction(({ key, kinds }) => {
    const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
    const media = graph?.nodes.filter((node) => kinds.includes(node.data.kind as "image" | "video")) || [];
    return media.length > 0 && media.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl));
  }, { key: graphKey, kinds }, { timeout });
}

async function clickFirstCharacterAndGenerateWithManualModel(page: Page) {
  await page.getByText(/角色01/u).first().dispatchEvent("click", undefined, { timeout: 20_000 });
  const modelSelect = page.locator('select[aria-label="图片生成模型"]').last();
  await modelSelect.waitFor({ timeout: 10_000 });
  await modelSelect.selectOption("mock-alt-image");
  await page.locator(".free-node-compose button", { hasText: /^生成$/u }).last().click();
  await page.waitForFunction((key) => {
    const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
    const firstCharacter = graph?.nodes.find((node) => node.data.assetRole === "character-reference" && /角色01/u.test(node.data.title));
    return Boolean(firstCharacter?.data.history?.some((item) => item.outputUrl) || firstCharacter?.data.outputUrl);
  }, graphKey, { timeout: 60_000 });
}

async function runAudit() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
    await context.addInitScript((token) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", token);
    }, session.token);
    const page = await context.newPage();
    const requestOrder: MediaRequest[] = [];
    const pageErrors: string[] = [];
    let videoIndex = 0;

    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/bridge/models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            {
              id: "mock-reference-image",
              name: "Mock Image - 默认多角色",
              model_name: "gpt-image-1",
              provider: "mock",
              selling_price: 0.2,
              supports_image_input: true,
              sort_order: 1,
              resolution_options: ["1K", "2K"],
              default_resolution: "1K",
            },
            {
              id: "mock-alt-image",
              name: "Mock Image - 手动卡片模型",
              model_name: "gpt-image-2",
              provider: "mock",
              selling_price: 0.3,
              supports_image_input: true,
              sort_order: 2,
              resolution_options: ["1K", "2K", "4K"],
              default_resolution: "2K",
            },
          ],
        }),
      });
    });
    await page.route("**/api/bridge/video-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [{
            id: "mock-keyframe-video",
            name: "Mock Video - 关键帧驱动",
            modelName: "mock-video",
            provider: "mock",
            pricePerUse: 0.3,
            durationSeconds: 5,
            maxDuration: 8,
            resolutionTier: "1080p",
            supportsImageInput: true,
            requiresImage: true,
            successRate: 100,
            durationMode: "range",
            minDuration: 3,
          }],
        }),
      });
    });
    await page.route("**/api/bridge/runtime-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: {
            defaults: { imageModelId: "mock-reference-image", videoModelId: "mock-keyframe-video" },
            health: { disabledImageModelIds: [] },
          },
        }),
      });
    });
    await page.route("**/api/bridge/balance", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 100 }) });
    });
    await page.route("**/api/bridge/image/generate", async (route) => {
      const payload = route.request().postDataJSON() as {
        prompt?: string;
        modelId?: string;
        aspectRatio?: string;
        referenceImageUrls?: string[];
      };
      requestOrder.push({
        type: "image",
        shot: shotNumber(payload.prompt || ""),
        modelId: payload.modelId,
        prompt: payload.prompt || "",
        aspectRatio: payload.aspectRatio,
        referenceImageUrls: payload.referenceImageUrls || [],
        submittedAt: Date.now(),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ images: [{ url: candidateLandscape }] }),
      });
    });
    await page.route("**/api/bridge/image/persist", async (route) => {
      const payload = route.request().postDataJSON() as { url?: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: payload.url || candidateLandscape }) });
    });
    await page.route("**/api/bridge/video/generate", async (route) => {
      const payload = route.request().postDataJSON() as {
        task_label?: string;
        prompt?: string;
        modelId?: string;
        aspect_ratio?: string;
        image_url?: string;
        first_frame_url?: string;
      };
      requestOrder.push({
        type: "video",
        shot: shotNumber(payload.task_label || ""),
        modelId: payload.modelId,
        prompt: payload.prompt || "",
        aspectRatio: payload.aspect_ratio,
        referenceImageUrls: [payload.image_url, payload.first_frame_url].filter(Boolean) as string[],
        submittedAt: Date.now(),
      });
      videoIndex += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          task_id: `mock-video-${videoIndex}`,
          status: "completed",
          video_url: `${baseUrl}/uploads/videos/generated/2026/08/08/manual-trim-diagnostic.mp4?uiE2e=${videoIndex}`,
        }),
      });
    });

    await page.goto(`${baseUrl}/free-canvas?run=${runId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const panel = await ensurePanel(page);
    await page.waitForFunction(() => {
      const imageSelect = document.querySelector(".free-global-model-grid select") as HTMLSelectElement | null;
      const videoSelect = document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null;
      return Boolean(imageSelect && imageSelect.options.length >= 2 && videoSelect && videoSelect.options.length > 0);
    }, undefined, { timeout: 20_000 });

    await panel.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill(script);
    await page.locator("select").filter({ has: page.locator("option", { hasText: "16:9" }) }).first().selectOption("16:9");
    await page.locator(".free-script-importer > button:last-child").click();
    await waitForGraphReady(page);
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: `${outputDir}/free-canvas-ui-e2e-after-split.png`, fullPage: false });

    const splitGraph = await readGraph(page);
    assert.ok(splitGraph, "导演拆解后没有画布图数据");
    const splitCharacters = splitGraph.nodes.filter((node) => node.data.assetRole === "character-reference");
    const splitKeyframes = splitGraph.nodes.filter((node) => node.data.assetRole === "storyboard-keyframe");
    const splitVideos = splitGraph.nodes.filter((node) => node.data.kind === "video");
    const splitVideoPrompts = splitGraph.nodes.filter((node) => node.data.kind === "text" && /视频提示词/u.test(node.data.title));
    const splitImagePrompts = splitGraph.nodes.filter((node) => node.data.kind === "text" && /参考图提示词/u.test(node.data.title));
    assert.ok(splitCharacters.length >= 1, "导演拆解后应生成角色定妆图节点");
    assert.ok(splitKeyframes.length >= 4, "导演拆解后应生成多张分镜参考图节点");
    assert.equal(splitKeyframes.length, splitVideos.length, "参考图和视频节点必须一一对应");
    assert.equal(splitVideoPrompts.length, splitVideos.length, "视频提示词卡片和视频执行节点必须一一对应");
    assert.equal(splitImagePrompts.length, splitKeyframes.length, "参考图提示词卡片和图片执行节点必须一一对应");
    assert.ok(splitGraph.nodes.filter((node) => node.data.kind === "text" && semanticPackagingHit(node.data.prompt)).length >= 1, "导演拆解没有生成语义包装提示词");
    await writeFile(`${outputDir}/free-canvas-ui-e2e-split-graph.json`, JSON.stringify(splitGraph, null, 2), "utf8");
    assert.ok(splitVideoPrompts.every((node) => !/(?:上游|节点|自动开关键|系统(?:自动)?生成|不得绕过|执行层|生成协议|首帧与风格|视频提示词[：:]\s*分镜)/u.test(node.data.prompt || "")), "视频卡片仍混入系统说明书");
    assert.ok(splitVideoPrompts.every((node) => /(?:镜头|机位|跟拍|跟随|推进|推近|拉远|平移|摇摄|环绕|俯拍|仰拍|低机位|主观视角|固定景别)/u.test(node.data.prompt || "")), "视频卡片缺少明确运镜");
    assert.ok(splitVideoPrompts.every((node) => /(?:最后|结尾|落幅|停在|停住|停稳|稳定停留|收住动作|定格|收束)/u.test(node.data.prompt || "")), "视频卡片缺少稳定落幅");
    assert.ok(splitImagePrompts.every((node) => !/(?:上游|节点|自动开关键|系统(?:自动)?生成|生成协议|让模型选择)/u.test(node.data.prompt || "")), "生图卡片仍混入系统说明书");

    const beforeManualRequests = requestOrder.length;
    await clickFirstCharacterAndGenerateWithManualModel(page);
    const manualRequest = requestOrder.slice(beforeManualRequests).find((request) => request.type === "image");
    assert.ok(manualRequest, "手动点击卡片生成没有提交图片请求");
    assert.equal(manualRequest.modelId, "mock-alt-image", "卡片手动切换模型没有进入生图请求");
    assert.equal(manualRequest.aspectRatio, "16:9", "卡片手动生成没有继承16:9");
    const manualDiagnostics = await page.evaluate(() => JSON.parse(
      localStorage.getItem("ai-creation-studio-free-canvas-diagnostics-v1") || "[]",
    ) as Array<{ trigger?: string; phase?: string; status?: string }>);
    assert.ok(
      manualDiagnostics.some((entry) => entry.trigger === "manual" && entry.phase === "node-total" && entry.status === "succeeded"),
      "手动单张生成没有写入可定位的运行日志",
    );

    const panelAfterManual = await ensurePanel(page);
    await panelAfterManual.locator(".free-production-progress button").nth(1).click();
    await waitForMediaDone(page, ["image"], 240_000);
    const afterImages = await readGraph(page);
    assert.ok(afterImages?.nodes.filter((node) => node.data.kind === "image").every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl)), "批量生图后仍有图片节点未完成");
    await page.screenshot({ path: `${outputDir}/free-canvas-ui-e2e-after-images.png`, fullPage: false });

    const videoRequestsBefore = requestOrder.filter((request) => request.type === "video").length;
    const panelAfterImages = await ensurePanel(page);
    await panelAfterImages.locator(".free-production-progress button").nth(2).click();
    await waitForMediaDone(page, ["video"], 240_000);
    const afterVideos = await readGraph(page);
    assert.ok(afterVideos?.nodes.filter((node) => node.data.kind === "video").every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl)), "批量视频后仍有视频节点未完成");
    assert.ok(requestOrder.filter((request) => request.type === "video").length > videoRequestsBefore, "批量视频按钮没有提交视频请求");
    await page.screenshot({ path: `${outputDir}/free-canvas-ui-e2e-after-videos.png`, fullPage: false });

    const imageRequests = requestOrder.filter((request) => request.type === "image");
    const storyboardImageRequests = imageRequests.filter((request) => request.shot);
    const videoRequests = requestOrder.filter((request) => request.type === "video");
    assert.ok(imageRequests.every((request) => request.aspectRatio === "16:9"), "所有图片请求必须是16:9");
    assert.ok(videoRequests.every((request) => request.aspectRatio === "16:9"), "所有视频请求必须是16:9");
    assert.ok(videoRequests.every((request) => (request.referenceImageUrls?.length || 0) >= 1), "批量视频必须携带参考图");
    for (let index = 1; index < storyboardImageRequests.length; index += 1) {
      assert.ok(storyboardImageRequests[index].submittedAt - storyboardImageRequests[index - 1].submittedAt >= 4_500, "批量参考图必须约5秒错峰提交");
    }
    for (let index = 1; index < videoRequests.length; index += 1) {
      assert.ok(videoRequests[index].submittedAt - videoRequests[index - 1].submittedAt >= 7_500, "批量视频必须约8秒错峰提交");
    }
    assert.deepEqual(pageErrors, [], "页面不应出现运行时错误");

    const report = {
      runId,
      script,
      split: {
        characterReferences: splitCharacters.length,
        keyframes: splitKeyframes.length,
        videos: splitVideos.length,
      },
      requests: requestOrder.map(({ type, shot, modelId, aspectRatio, submittedAt }) => ({ type, shot, modelId, aspectRatio, submittedAt })),
      manualModelRequest: manualRequest,
      screenshots: {
        afterSplit: `${outputDir}/free-canvas-ui-e2e-after-split.png`,
        afterImages: `${outputDir}/free-canvas-ui-e2e-after-images.png`,
        afterVideos: `${outputDir}/free-canvas-ui-e2e-after-videos.png`,
      },
      acceptance: "passed",
    };
    await writeFile(`${outputDir}/free-canvas-ui-e2e-audit.json`, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

void runAudit().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
