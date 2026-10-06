import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const script = "小狗把新买的毛绒玩具咬坏了，客厅地上全是棉花。它听见主人脚步声，立刻僵在沙发旁，耳朵往后贴，尾巴夹住，眼神偷偷往门口瞟。玩具残片还挂在嘴边，它越想藏越慌，身体开始发抖，周围像有一圈红色紧绷线在跳。主人走近时，它慢慢把玩具推到脚边，低下头不敢看人，生怕下一秒被责备。可主人没有吼它，只蹲下来捡起玩具，小狗这才抬眼，紧绷线一点点散开，尾巴轻轻摇了一下。";

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt: string;
    assetRole?: string;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

type CompileResponseSummary = {
  compiler?: "ai" | "deterministic-fallback";
  shots?: Array<{
    order: number;
    narration?: string;
    imagePrompt?: string;
    videoPrompt?: string;
    effectsPrompt?: string;
  }>;
  semanticSegments?: Array<{ order: number; narration: string; durationSeconds: number }>;
};

async function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

async function waitForCompileSummary(getSummary: () => CompileResponseSummary | null): Promise<CompileResponseSummary> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const summary = getSummary();
    if (summary && (summary.shots?.length || 0) > 0) return summary;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待AI拆镜响应超时");
}

async function main() {
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
    let compileResponseSummary: CompileResponseSummary | null = null;
    page.on("response", async (response) => {
      if (!response.url().includes("/api/canvas/compile-script") || response.request().method() !== "POST") return;
      try {
        const data = await response.json() as CompileResponseSummary;
        compileResponseSummary = {
          compiler: data.compiler,
          shots: (data.shots || []).map((shot) => ({
            order: shot.order,
            narration: shot.narration,
            imagePrompt: shot.imagePrompt,
            videoPrompt: shot.videoPrompt,
            effectsPrompt: shot.effectsPrompt,
          })),
          semanticSegments: data.semanticSegments,
        };
      } catch {
        compileResponseSummary = {};
      }
    });
    await page.route("**/api/bridge/models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [{
            id: "mock-reference-image",
            name: "Mock Image · 支持图像输入",
            model_name: "gpt-image-1",
            provider: "mock",
            selling_price: 0.2,
            supports_image_input: true,
            sort_order: 1,
            resolution_options: ["1K", "2K"],
            default_resolution: "1K",
          }],
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
            name: "Mock Video · 关键帧驱动",
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
        body: JSON.stringify({ config: { defaults: { imageModelId: "mock-reference-image", videoModelId: "mock-keyframe-video" }, health: { disabledImageModelIds: [] } } }),
      });
    });
    await page.route("**/api/bridge/balance", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 100 }) });
    });

    await page.goto(`${baseUrl}/free-canvas?revision=dog-toy-semantic-packaging`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const panel = page.locator('aside[aria-label="制作面板"]');
    if (await panel.count() === 0) {
      await page.getByRole("button", { name: "打开制作面板" }).click();
    }
    await panel.waitFor({ timeout: 20_000 });
    await panel.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill(script);
    await panel.getByRole("button", { name: "补充要求" }).click();
    await page.getByLabel("用大白话补充要求").fill("测试语义包装：封面/参考图提示词必须由同镜视频动作方案反推；狗狗发抖、心里紧绷时，参考图必须出现与视频动作呼应的红色紧绷线或类似非文字装饰。");
    await page.locator('select').filter({ has: page.locator('option', { hasText: "16:9" }) }).first().selectOption("16:9");

    await page.locator(".free-script-importer > button:last-child").click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      return Boolean(
        graph?.nodes.some((node) => node.data.assetRole === "storyboard-keyframe")
        && graph.nodes.some((node) => node.data.kind === "video")
        && document.body.innerText.includes("分镜"),
      );
    }, graphKey, { timeout: 180_000 });
    const compileSummary = await waitForCompileSummary(() => compileResponseSummary);
    const expectedShotCount = compileSummary.shots?.length || 0;
    await page.waitForFunction(({ key, expected }) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      if (!graph) return false;
      const imagePromptCount = graph.nodes.filter((node) => node.data.kind === "text" && /(?:参考图|生图)提示词/u.test(node.data.title)).length;
      const videoPromptCount = graph.nodes.filter((node) => node.data.kind === "text" && /视频提示词/u.test(node.data.title)).length;
      const keyframeCount = graph.nodes.filter((node) => node.data.assetRole === "storyboard-keyframe").length;
      const videoCount = graph.nodes.filter((node) => node.data.kind === "video").length;
      return imagePromptCount >= expected && videoPromptCount >= expected && keyframeCount >= expected && videoCount >= expected;
    }, { key: graphKey, expected: expectedShotCount }, { timeout: 30_000 });

    const graph = await readGraph(page);
    assert.ok(graph, "画布未写入图数据");
    const keyframes = graph.nodes.filter((node) => node.data.assetRole === "storyboard-keyframe");
    const imagePromptNodes = graph.nodes.filter((node) => (
      node.data.kind === "text"
      && /(?:参考图|生图)提示词/u.test(node.data.title)
    ));
    const videos = graph.nodes.filter((node) => node.data.kind === "video");
    const videoPromptNodes = graph.nodes.filter((node) => (
      node.data.kind === "text"
      && /视频提示词/u.test(node.data.title)
    ));
    const semanticPattern = /(?:红[\s\S]{0,120}紧绷线|紧绷线[\s\S]{0,120}红|发抖[\s\S]{0,120}紧绷线|颤抖[\s\S]{0,120}紧绷线)/u;
    const matchedKeyframe = imagePromptNodes.find((node) => semanticPattern.test(node.data.prompt));
    const matchedVideo = videoPromptNodes.find((node) => semanticPattern.test(node.data.prompt));
    assert.ok(matchedKeyframe, `未找到包含红色紧绷线/发抖语义的参考图提示词；候选数 ${imagePromptNodes.length}`);
    assert.ok(matchedVideo, "未找到包含红色紧绷线/发抖语义的视频提示词");
    assert.ok((compileSummary.shots?.length || 0) >= 4, "AI拆镜应返回多个镜头");
    assert.equal(imagePromptNodes.length, compileSummary.shots?.length, "画布生图提示词节点应与AI拆镜数量一致");
    assert.equal(videoPromptNodes.length, compileSummary.shots?.length, "画布视频提示词节点应与AI拆镜数量一致");

    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/dog-toy-canvas-visual-demo.png", fullPage: false });
    await writeFile(".tmp-e2e/dog-toy-canvas-output.json", JSON.stringify({
      script,
      compile: compileSummary,
      nodes: graph.nodes.length,
      allNodes: graph.nodes.map((node) => ({
        title: node.data.title,
        kind: node.data.kind,
        assetRole: node.data.assetRole || "",
        hasSemantic: semanticPattern.test(node.data.prompt),
      })),
      keyframes: keyframes.length,
      imagePromptNodes: imagePromptNodes.length,
      videos: videos.length,
      videoPromptNodes: videoPromptNodes.length,
      matchedKeyframe: {
        title: matchedKeyframe.data.title,
        prompt: matchedKeyframe.data.prompt,
      },
      matchedVideo: {
        title: matchedVideo.data.title,
        prompt: matchedVideo.data.prompt,
      },
    }, null, 2), "utf8");

    console.log(JSON.stringify({
      nodes: graph.nodes.length,
      compiler: compileSummary.compiler,
      compiledShots: compileSummary.shots?.length,
      semanticNodes: graph.nodes
        .filter((node) => semanticPattern.test(node.data.prompt))
        .map((node) => `${node.data.kind}:${node.data.title}`),
      keyframes: keyframes.length,
      imagePromptNodes: imagePromptNodes.length,
      videos: videos.length,
      videoPromptNodes: videoPromptNodes.length,
      matchedKeyframe: matchedKeyframe.data.title,
      matchedVideo: matchedVideo.data.title,
      screenshot: ".tmp-e2e/dog-toy-canvas-visual-demo.png",
      output: ".tmp-e2e/dog-toy-canvas-output.json",
    }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
