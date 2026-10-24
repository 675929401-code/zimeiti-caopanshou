import assert from "node:assert/strict";
import { chromium } from "playwright";
import { compileStoryboard, createDefaultCanvasPromptPresetStore } from "../src/lib/canvas-prompt-presets";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    imageMode?: string;
    imageCount?: number;
    assetRole?: string;
    characterId?: string;
    candidateSelectionRequired?: boolean;
    selectedCandidateId?: string;
    requiresExactDuration?: boolean;
    allowDurationTrim?: boolean;
    modelId?: string;
    outputUrl?: string;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

function nodeCard(page: import("playwright").Page, title: string | RegExp) {
  return page
    .locator(".react-flow__node .workflow-kind > strong")
    .filter({ hasText: title })
    .first()
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')][1]");
}

async function waitForGraph(page: import("playwright").Page) {
  await page.waitForFunction((key) => {
    const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
    return graph?.nodes.some((node) => node.data.assetRole === "character-reference")
      && graph.nodes.some((node) => node.data.kind === "video")
      && graph.nodes.some((node) => node.data.kind === "image" && node.data.title.includes("自动关键帧"));
  }, graphKey, { timeout: 30_000 });
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph, graphKey);
}

async function openAnimeScriptInput(page: import("playwright").Page) {
  const openPanel = page.getByRole("button", { name: "打开制作面板" });
  if (await openPanel.isVisible()) await openPanel.click();
  await page.getByRole("button", { name: /动漫剧情/ }).first().click();
  await page.getByLabel("原始文案").fill("狗狗在温暖客厅醒来，听见主人回家后立刻跑向门口，最后安心依偎在主人身边。");
}

async function splitWithSource(page: import("playwright").Page, source: "auto" | "explore" | "upload") {
  if (await page.getByLabel("一致性增强").count() === 0) {
    await page.getByRole("button", { name: "高级设置（可选）" }).click();
  }
  await page.getByLabel("一致性增强").selectOption(source);
  await page.locator(".free-script-importer > button:last-child").click({ timeout: 30_000 });
}

async function main() {
  const preset = createDefaultCanvasPromptPresetStore().presets.find((item) => item.id === "anime_story");
  assert.ok(preset, "缺少动漫剧情提示词方案");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      localStorage.removeItem("ai-creation-studio-graph-v1");
      localStorage.removeItem("ai-creation-studio-free-canvas-sessions-v1");
      localStorage.removeItem("ai-creation-studio-free-canvas-run-history-v1");
      sessionStorage.clear();
    });
    const page = await context.newPage();
    const postRequests: string[] = [];
    const compileRequestBodies: Array<{ allowDurationTrim?: boolean; videoModelDurationMode?: string; videoModelDurationSeconds?: number }> = [];
    const imageRequestBodies: Array<{ modelId?: string; referenceImageUrls?: string[] }> = [];
    const pageErrors: string[] = [];
    const candidatePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await page.route("**/api/canvas/compile-script", async (route) => {
      const body = route.request().postDataJSON() as {
        script: string;
        style?: string;
        ratio: string;
        productionMode?: "anime-story" | "real-story" | "ten-second" | "product-video";
        referenceMode?: "single" | "first-last";
        keyframeStrategy?: "action-start" | "visual-anchor";
        effectsLevel?: "none" | "light" | "rich";
        assistantInstruction?: string;
        allowDurationTrim?: boolean;
        videoModelDurationMode?: string;
        videoModelDurationSeconds?: number;
      };
      compileRequestBodies.push(body);
      const compiled = compileStoryboard({
        script: body.script,
        style: body.style || "电影级3D卡通动画",
        ratio: body.ratio,
        productionMode: body.productionMode,
        referenceMode: body.referenceMode,
        keyframeStrategy: body.keyframeStrategy,
        effectsLevel: body.effectsLevel,
        assistantInstruction: body.assistantInstruction,
        preset,
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...compiled, compiler: "ai", compilerDiagnostics: [] }) });
    });
    await page.route("**/api/bridge/image/generate", async (route) => {
      imageRequestBodies.push(route.request().postDataJSON() as { modelId?: string; referenceImageUrls?: string[] });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [{ url: candidatePixel }] }) });
    });
    await page.route("**/api/bridge/image/persist", async (route) => {
      const payload = route.request().postDataJSON() as { url?: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: payload.url || candidatePixel }) });
    });
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(new URL(request.url()).pathname);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await openAnimeScriptInput(page);
    await page.waitForFunction(() => (document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null)?.options.length && (document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement).options.length > 1, undefined, { timeout: 15_000 });
    const videoModelOptions = await page.getByLabel("全局视频生成模型").locator("option").evaluateAll((options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      disabled: (option as HTMLOptionElement).disabled,
    })));
    const imageModelSelect = page.getByLabel("自动关键帧 / 视觉探索模型");
    const referenceModelId = await imageModelSelect.locator("option").evaluateAll((options) => (
      (options as HTMLOptionElement[]).find((option) => !option.textContent?.includes("仅文本生图"))?.value || ""
    ));
    assert.ok(referenceModelId, "一致性验收需要至少一个支持角色参考的图片模型");
    await imageModelSelect.selectOption(referenceModelId);
    const selectedImageModel = { value: referenceModelId, supportsReference: true };
    const fixedDurationOptions = videoModelOptions.filter((option) => /(?:omni-flash|veo-3-1-fast|image-pro-10s)/.test(option.value));
    const exactDurationOptions = videoModelOptions.filter((option) => /grok-imagine-(?:1\.5|video-1-5)/.test(option.value));
    assert.equal(await page.getByLabel("下载时精确裁剪").isChecked(), true, "剧情画布必须默认开启下载时裁剪");
    assert.ok(fixedDurationOptions.length > 0 && fixedDurationOptions.every((option) => !option.disabled), "开启下载时裁剪后固定时长关键帧模型必须可选");
    assert.ok(exactDurationOptions.some((option) => !option.disabled), "动漫剧情必须保留可覆盖逐镜目标时长的图生视频模型");
    await splitWithSource(page, "explore");
    const exploreGraph = await waitForGraph(page);
    const exploration = exploreGraph.nodes.find((node) => node.data.kind === "image" && node.data.assetRole === "character-reference");
    const exploreKeyframes = exploreGraph.nodes.filter((node) => node.data.kind === "image" && /自动关键帧/.test(node.data.title));
    assert.ok(exploration?.data.candidateSelectionRequired, "视觉探索必须要求4选1");
    assert.equal(exploration?.data.imageCount, 4, "每个角色探索节点必须生成4个候选");
    assert.equal(exploreGraph.nodes.filter((node) => node.data.kind === "upload").length, 0, "视觉探索不应强制上传图片");
    assert.ok(exploreKeyframes.length > 0 && exploreKeyframes.every((node) => node.data.imageMode === "image-to-image"), "选定探索图后每镜关键帧必须走参考图生成");
    assert.ok(exploreKeyframes.every((node) => exploreGraph.edges.some((edge) => edge.source === exploration?.id && edge.target === node.id)), "探索锚点必须连接每个关键帧节点");
    await page.evaluate(() => localStorage.setItem("auth_token", "canvas-consistency-ui-mock"));
    const explorationCard = nodeCard(page, /角色\d+ · .*定妆图（先确认）/u);
    await explorationCard.click();
    await explorationCard.getByTitle("生成图片").evaluate((button: HTMLButtonElement) => button.click());
    try {
      await page.getByLabel("选择角色候选 1").waitFor({ timeout: 20_000 });
    } catch (error) {
      const diagnostics = await page.evaluate((key) => ({
        graph: JSON.parse(localStorage.getItem(key) || "null") as Graph | null,
        notice: document.body.innerText.slice(0, 2500),
      }), graphKey);
      console.error(JSON.stringify({ diagnostics, postRequests, pageErrors }, null, 2));
      throw error;
    }
    assert.equal(await page.getByLabel(/选择角色候选/).count(), 4, "视觉探索必须返回4个可独立选择的候选");
    await page.screenshot({ path: ".tmp-e2e/free-canvas-consistency-candidates.png", fullPage: false });
    await page.getByLabel("选择角色候选 2").click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      return graph?.nodes.some((node) => node.data.candidateSelectionRequired && Boolean(node.data.selectedCandidateId));
    }, graphKey, { timeout: 10_000 });
    await page.evaluate(() => localStorage.removeItem("auth_token"));

    await openAnimeScriptInput(page);
    await splitWithSource(page, "upload");
    const uploadGraph = await waitForGraph(page);
    const upload = uploadGraph.nodes.find((node) => node.data.kind === "upload" && node.data.assetRole === "character-reference");
    const uploadKeyframes = uploadGraph.nodes.filter((node) => node.data.kind === "image" && /自动关键帧/.test(node.data.title));
    assert.equal(uploadGraph.nodes.filter((node) => node.data.kind === "upload").length, 1, "手动增强模式必须且只能创建一个已有角色图节点");
    assert.ok(uploadKeyframes.every((node) => uploadGraph.edges.some((edge) => edge.source === upload?.id && edge.target === node.id)), "已有角色图必须连接每个关键帧节点");

    await openAnimeScriptInput(page);
    await splitWithSource(page, "auto");
    const autoGraph = await waitForGraph(page);
    const autoAnchors = autoGraph.nodes.filter((node) => node.data.kind === "image" && node.data.assetRole === "character-reference");
    const autoKeyframes = autoGraph.nodes.filter((node) => node.data.kind === "image" && /自动关键帧/.test(node.data.title));
    const autoVideos = autoGraph.nodes.filter((node) => node.data.kind === "video");
    assert.equal(autoGraph.nodes.filter((node) => node.data.kind === "upload").length, 0, "自动模式不得创建上传节点");
    assert.ok(autoAnchors.length >= 1, "自动模式必须按角色分别创建定妆图节点");
    assert.ok(autoAnchors.every((node) => node.data.imageCount === 1 && node.data.candidateSelectionRequired), "自动角色图必须各生成1张并等待确认");
    assert.ok(autoKeyframes.length > 0 && autoKeyframes.every((node) => node.data.imageMode === "image-to-image"), "关键帧必须参考本镜出场角色图");
    assert.ok(autoKeyframes.every((node) => autoGraph.edges.some((edge) => autoAnchors.some((anchor) => anchor.id === edge.source) && edge.target === node.id)), "每个关键帧必须连接本镜角色节点");
    assert.ok(autoVideos.length > 0 && autoVideos.every((node) => node.data.requiresExactDuration), "动漫剧情视频节点必须锁定目标镜头时长");
    assert.ok(autoVideos.every((node) => !("allowDurationTrim" in node.data)), "新视频节点不得写入已移除的自动裁剪字段");
    assert.ok(compileRequestBodies.every((body) => !("allowDurationTrim" in body)), "拆镜请求不得发送已移除的自动裁剪开关");

    await page.evaluate(() => localStorage.setItem("auth_token", "canvas-consistency-ui-mock"));
    const anchorCard = nodeCard(page, /角色\d+ · .*定妆图（先确认）/u);
    await anchorCard.click();
    await anchorCard.getByTitle("生成图片").evaluate((button: HTMLButtonElement) => button.click());
    await page.getByLabel("选择角色候选 1").waitFor({ timeout: 20_000 });
    await page.getByLabel("选择角色候选 1").click();
    const firstKeyframeTitle = autoKeyframes[0]?.data.title;
    assert.ok(firstKeyframeTitle, "自动模式缺少关键帧节点");
    const reopenProductionPanel = page.getByRole("button", { name: "打开制作面板" });
    if (await reopenProductionPanel.isVisible()) await reopenProductionPanel.click();
    await page.getByRole("button", { name: "试生成 1 张" }).click();
    try {
      await page.waitForFunction(({ key, title }) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        return Boolean(graph?.nodes.find((node) => node.data.title === title)?.data.outputUrl);
      }, { key: graphKey, title: firstKeyframeTitle }, { timeout: 20_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(({ key, title }) => ({
        node: (JSON.parse(localStorage.getItem(key) || "null") as Graph | null)?.nodes.find((item) => item.data.title === title),
        notice: document.body.innerText.slice(0, 3000),
      }), { key: graphKey, title: firstKeyframeTitle });
      console.error(JSON.stringify({ diagnostics, imageRequestBodies, postRequests, pageErrors }, null, 2));
      throw error;
    }
    const autoKeyframeRequest = imageRequestBodies.at(-1);
    if (selectedImageModel.supportsReference) {
      const autoAnchorRequest = imageRequestBodies.at(-2);
      assert.equal(autoAnchorRequest?.referenceImageUrls?.length || 0, 0, "自动锚点必须从全文设定文生图");
      assert.deepEqual(autoKeyframeRequest?.referenceImageUrls, [candidatePixel], "关键帧请求必须真实携带自动锚点图片");
      assert.equal(autoAnchorRequest?.modelId, autoKeyframeRequest?.modelId, "支持图像输入时必须始终使用用户选定的同一模型");
    } else {
      assert.equal(autoKeyframeRequest?.referenceImageUrls?.length || 0, 0, "文本生图模型的关键帧不得伪造参考图输入");
      assert.equal(autoKeyframeRequest?.modelId, selectedImageModel.value, "文本生图模式不得暗中切换图片模型");
    }
    await page.evaluate(() => localStorage.removeItem("auth_token"));

    assert.equal(postRequests.filter((path) => path === "/api/canvas/compile-script").length, 3, "三种一致性来源各执行一次拆镜");
    const expectedImageRequests = selectedImageModel.supportsReference ? 6 : 5;
    assert.equal(postRequests.filter((path) => path === "/api/bridge/image/generate").length, expectedImageRequests, "图片调用次数必须匹配当前一致性策略");
    assert.equal(postRequests.filter((path) => path === "/api/bridge/image/persist").length, expectedImageRequests, "所有模拟图片都应登记为可复用结果");
    assert.equal(postRequests.some((path) => path.includes("/video/") || path.includes("voice") || path.includes("subtitle")), false, "一致性验证不得触发视频、配音或字幕生成");
    assert.deepEqual(pageErrors, [], "一致性来源切换不应产生页面错误");
    console.log(JSON.stringify({ exploreKeyframes: exploreKeyframes.length, uploadKeyframes: uploadKeyframes.length, autoKeyframes: autoKeyframes.length, postRequests }, null, 2));
  } finally {
    for (const context of browser.contexts()) {
      await context.unrouteAll({ behavior: "ignoreErrors" });
    }
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
