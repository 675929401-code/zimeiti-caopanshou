import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const outputDir = ".tmp-e2e";
const runId = "anime-director-full-flow-20260812";
const headed = process.env.CANVAS_DEMO_VISIBLE === "1";
const slowMo = headed ? 180 : 0;
const candidateLandscape = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#172033"/><path d="M155 515 C320 410 430 570 610 455 S930 335 1090 480 S1305 620 1455 445" fill="none" stroke="#ef4444" stroke-width="18" stroke-linecap="round" opacity=".78"/><circle cx="800" cy="450" r="128" fill="#f59e0b" opacity=".9"/><text x="800" y="742" text-anchor="middle" font-size="64" fill="#ffffff" font-family="Arial">16:9 semantic keyframe</text></svg>')}`;

const defaultScript = "小柯基趁主人洗澡时，把客厅新买的抱枕咬开，棉花一路拖到门口。它听见浴室门把手转动，立刻把半截抱枕往沙发底下推，耳朵贴平，尾巴夹住，眼神却忍不住偷瞄地上的白棉絮。它突然想起早上主人刚夸过它乖，心里更虚，后脚一滑又把遥控器碰进棉花堆里。门缝外的水汽和拖鞋声一起逼近，客厅灯光像审问一样照亮所有证据。小柯基胸口像被拧紧一样发抖，周围浮出一圈低饱和红色紧绷线。它想装作什么都没发生，结果一转身，嘴边还挂着一小团棉花。主人蹲下捡起抱枕没有责备，只轻轻叹气。小柯基慢慢把爪子搭到主人手边，紧绷线散开，尾巴小心翼翼地摇了一下。";
const script = process.env.CANVAS_DEMO_SCRIPT?.trim() || defaultScript;

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt?: string;
    outputText?: string;
    visualOrder?: number;
    semanticOrder?: number;
    imageMode?: string;
    assetRole?: string;
    status: string;
    outputUrl?: string;
    selectedCandidateId?: string;
    candidateSelectionRequired?: boolean;
    aspectRatio?: string;
    history?: Array<{ id: string; outputUrl?: string }>;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

type CompileShot = {
  order: number;
  semanticOrder?: number;
  narration?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  effectsPrompt?: string;
  durationSeconds?: number;
};

type CompileResponseSummary = {
  compiler?: "ai" | "deterministic-fallback";
  preset?: { id?: string; name?: string; version?: string };
  analysis?: string;
  shots?: CompileShot[];
  semanticSegments?: Array<{ order: number; narration: string; durationSeconds: number }>;
  characterAssets?: Array<{ id: string; name: string; referencePrompt: string }>;
};

type MediaRequest = {
  type: "image" | "video";
  shot: string;
  prompt: string;
  aspectRatio?: string;
  referenceImageUrls?: string[];
  submittedAt: number;
};

function shotNumber(text: string) {
  const value = text.match(/(?:镜头|分镜)\s*0*(\d+)/u)?.[1] || "";
  return value ? String(Number(value)) : "";
}

function includesSemanticPackaging(text = "") {
  const coreEvidence = /紧绷线|红色|发抖|胸口|心虚|偷瞄|棉花|抱枕|嘴边/u.test(text);
  const decorationEvidence = /非文字|装饰|线条|符号|图形|情绪可视化|语义证据|跳动|散开|收紧|低饱和红/u.test(text);
  return coreEvidence && decorationEvidence;
}

function upstreamTextNodes(graph: Graph, targetId: string) {
  return graph.edges
    .filter((edge) => edge.target === targetId)
    .map((edge) => graph.nodes.find((node) => node.id === edge.source))
    .filter((node): node is GraphNode => Boolean(node && node.data.kind === "text"));
}

async function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

async function ensureProductionPanel(page: Page) {
  const panel = page.locator('aside[aria-label="制作面板"]');
  if (await panel.count() === 0) {
    await page.getByRole("button", { name: "打开制作面板" }).click();
  }
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

async function waitForCompileSummary(getSummary: () => CompileResponseSummary | null) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const summary = getSummary();
    if (summary && (summary.shots?.length || 0) > 0) return summary;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("等待动漫剧情导演拆解响应超时");
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: !headed, slowMo });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
    await context.addInitScript((token) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", token);
    }, session.token);

    const page = await context.newPage();
    const requestOrder: MediaRequest[] = [];
    const postPaths: string[] = [];
    const pageErrors: string[] = [];
    let videoIndex = 0;
    let compileResponseSummary: CompileResponseSummary | null = null;

    page.on("request", (request) => {
      if (request.method() === "POST") postPaths.push(new URL(request.url()).pathname);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", async (response) => {
      if (!response.url().includes("/api/canvas/compile-script") || response.request().method() !== "POST") return;
      try {
        const data = await response.json() as CompileResponseSummary;
        compileResponseSummary = {
          compiler: data.compiler,
          preset: data.preset,
          analysis: data.analysis,
          shots: (data.shots || []).map((shot) => ({
            order: shot.order,
            semanticOrder: shot.semanticOrder,
            narration: shot.narration,
            imagePrompt: shot.imagePrompt,
            videoPrompt: shot.videoPrompt,
            effectsPrompt: shot.effectsPrompt,
            durationSeconds: shot.durationSeconds,
          })),
          semanticSegments: data.semanticSegments,
          characterAssets: data.characterAssets,
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
            name: "Mock Image - 支持图像输入",
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
        aspectRatio?: string;
        referenceImageUrls?: string[];
      };
      requestOrder.push({
        type: "image",
        shot: shotNumber(payload.prompt || ""),
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
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: payload.url || candidateLandscape }),
      });
    });
    await page.route("**/api/bridge/video/generate", async (route) => {
      const payload = route.request().postDataJSON() as {
        task_label?: string;
        prompt?: string;
        aspect_ratio?: string;
        image_url?: string;
        first_frame_url?: string;
      };
      requestOrder.push({
        type: "video",
        shot: shotNumber(payload.task_label || ""),
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
          video_url: `${baseUrl}/uploads/videos/generated/2026/08/08/manual-trim-diagnostic.mp4?acceptance=${videoIndex}`,
        }),
      });
    });

    await page.goto(`${baseUrl}/free-canvas?run=${runId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const panel = await ensureProductionPanel(page);
    await page.waitForFunction(() => {
      const imageSelect = document.querySelector(".free-global-model-grid select") as HTMLSelectElement | null;
      const videoSelect = document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null;
      return Boolean(imageSelect && [...imageSelect.options].some((option) => option.textContent?.includes("支持图像输入")) && videoSelect && videoSelect.options.length > 0);
    }, undefined, { timeout: 20_000 });

    const imageModelSelect = page.getByLabel("自动关键帧 / 视觉探索模型");
    const referenceModelId = await imageModelSelect.locator("option").evaluateAll((options) => (
      (options as HTMLOptionElement[]).find((option) => option.textContent?.includes("支持图像输入"))?.value || ""
    ));
    assert.ok(referenceModelId, "验收需要选择支持图像输入的生图模型");
    await imageModelSelect.selectOption(referenceModelId);
    await panel.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill(script);
    await panel.getByRole("button", { name: "补充要求" }).click();
    await page.getByLabel("用大白话补充要求").fill("验收标准：先从剧情行为反推参考图包装，再由参考图服务视频。心虚、发抖、被发现、棉花证据必须落成可见的非文字装饰，比如低饱和红色紧绷线、颤抖线、视线指向线；视频提示词只能动画化参考图中已经出现的装饰和动作证据。");
    await page.locator("select").filter({ has: page.locator("option", { hasText: "16:9" }) }).first().selectOption("16:9");

    await page.locator(".free-script-importer > button:last-child").click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      return Boolean(
        graph?.nodes.some((node) => node.data.assetRole === "character-reference")
        && graph.nodes.some((node) => node.data.assetRole === "storyboard-keyframe")
        && graph.nodes.some((node) => node.data.kind === "video"),
      );
    }, graphKey, { timeout: 180_000 });

    const compileSummary = await waitForCompileSummary(() => compileResponseSummary);
    const expectedShotCount = compileSummary.shots?.length || 0;
    await page.waitForFunction(({ key, expected }) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      if (!graph || expected <= 0) return false;
      const keyframes = graph.nodes.filter((node) => node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe");
      const videos = graph.nodes.filter((node) => node.data.kind === "video");
      const keyframesWithText = keyframes.filter((node) => graph.edges.some((edge) => (
        edge.target === node.id
        && graph.nodes.some((source) => source.id === edge.source && source.data.kind === "text")
      )));
      const videosWithText = videos.filter((node) => graph.edges.some((edge) => (
        edge.target === node.id
        && graph.nodes.some((source) => source.id === edge.source && source.data.kind === "text")
      )));
      return keyframes.length === expected
        && videos.length === expected
        && keyframesWithText.length === expected
        && videosWithText.length === expected;
    }, { key: graphKey, expected: expectedShotCount }, { timeout: 60_000 });
    await mkdir(outputDir, { recursive: true });
    await page.screenshot({ path: `${outputDir}/anime-director-full-flow-compiled.png`, fullPage: false });

    const draft = await readGraph(page);
    assert.ok(draft, "画布未写入图数据");
    assert.equal(compileSummary.compiler, "ai", "动漫剧情导演必须走 AI 编译，不应退回基础预览");
    assert.ok((compileSummary.shots?.length || 0) >= 4, "300 字代表文案应拆成多个连续镜头");
    assert.ok((compileSummary.characterAssets?.length || 0) >= 1, "动漫剧情导演应先输出角色定妆资产");

    const characterReferences = draft.nodes.filter((node) => node.data.kind === "image" && node.data.assetRole === "character-reference");
    const keyframeNodes = draft.nodes.filter((node) => node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe");
    const videoNodes = draft.nodes.filter((node) => node.data.kind === "video");
    const imagePromptNodes = keyframeNodes
      .map((node) => upstreamTextNodes(draft, node.id)[0])
      .filter((node): node is GraphNode => Boolean(node));
    const videoPromptNodes = videoNodes
      .map((node) => upstreamTextNodes(draft, node.id)[0])
      .filter((node): node is GraphNode => Boolean(node));
    const shotCount = compileSummary.shots?.length || 0;

    assert.equal(imagePromptNodes.length, shotCount, "每个镜头必须有一条由视频动作反推的生图提示词");
    assert.equal(videoPromptNodes.length, shotCount, "每个镜头必须有一条视频提示词");
    assert.equal(keyframeNodes.length, shotCount, "每个镜头必须有一张参考图 / 自动关键帧节点");
    assert.equal(videoNodes.length, shotCount, "每个镜头必须有一个视频节点");
    assert.ok(characterReferences.every((node) => node.data.aspectRatio === "16:9"), "角色定妆图节点必须继承 16:9");
    assert.ok(keyframeNodes.every((node) => node.data.aspectRatio === "16:9"), "参考图节点必须继承 16:9");
    assert.ok(videoNodes.every((node) => node.data.aspectRatio === "16:9"), "视频节点必须继承 16:9");

    const decoratedImagePrompts = imagePromptNodes.filter((node) => includesSemanticPackaging(node.data.prompt));
    const decoratedVideoPrompts = videoPromptNodes.filter((node) => includesSemanticPackaging(node.data.prompt));
    const forbiddenVagueText = [...imagePromptNodes, ...videoPromptNodes]
      .filter((node) => /根据语义选择|自行选择|可以加入|例如|可加入/u.test(node.data.prompt || ""))
      .map((node) => node.data.title);
    assert.ok(decoratedImagePrompts.length >= 1, "生图提示词没有命中剧情语义包装：心虚/发抖/紧绷线/证据物应可见");
    assert.ok(decoratedVideoPrompts.length >= 1, "视频提示词没有和参考图语义包装呼应");
    assert.deepEqual(forbiddenVagueText, [], "提示词不应把语义包装责任丢给模型自由发挥");

    for (const keyframe of keyframeNodes) {
      const order = keyframe.data.visualOrder;
      const imagePrompt = imagePromptNodes.find((node) => node.data.visualOrder === order);
      const videoPrompt = videoPromptNodes.find((node) => node.data.visualOrder === order);
      const video = videoNodes.find((node) => node.data.visualOrder === order);
      assert.ok(imagePrompt && videoPrompt && video, `镜头 ${order} 缺少图文视频链路节点`);
      assert.ok(draft.edges.some((edge) => edge.source === videoPrompt.id && edge.target === imagePrompt.id), `镜头 ${order} 缺少视频提示词到生图提示词连线`);
      assert.ok(draft.edges.some((edge) => edge.source === imagePrompt.id && edge.target === keyframe.id), `镜头 ${order} 缺少生图提示词到参考图连线`);
      assert.ok(draft.edges.some((edge) => edge.source === keyframe.id && edge.target === video.id), `镜头 ${order} 缺少参考图到视频连线`);
    }

    await page.locator(".free-canvas-actions button.run-all").click();
    const mediaTimeout = Math.max(360_000, 60_000 + (characterReferences.length + keyframeNodes.length) * 8_000 + videoNodes.length * 12_000);
    try {
      await page.waitForFunction((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        const media = graph?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
        return media.length > 0 && media.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl));
      }, graphKey, { timeout: mediaTimeout });
    } catch (error) {
      const diagnostics = await page.evaluate((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        return {
          notice: document.querySelector(".free-page-notice")?.textContent || "",
          runningText: document.body.innerText.match(/(?:正在|已生成|已自动|暂停|失败|完成|未开始|生成中)[^\n]{0,100}/gu)?.slice(-20) || [],
          media: graph?.nodes
            .filter((node) => node.data.kind === "image" || node.data.kind === "video")
            .map((node) => ({
              title: node.data.title,
              kind: node.data.kind,
              assetRole: node.data.assetRole || "",
              status: node.data.status,
              hasOutput: Boolean(node.data.outputUrl),
              selectedCandidateId: node.data.selectedCandidateId,
              candidateSelectionRequired: node.data.candidateSelectionRequired,
              historyOutputs: node.data.history?.filter((item) => Boolean(item.outputUrl)).length || 0,
            })) || [],
        };
      }, graphKey);
      await page.screenshot({ path: `${outputDir}/anime-director-full-flow-timeout.png`, fullPage: false });
      await writeFile(`${outputDir}/anime-director-full-flow-timeout.json`, JSON.stringify({
        diagnostics,
        requestOrder: requestOrder.map(({ type, shot, aspectRatio, submittedAt }) => ({ type, shot, aspectRatio, submittedAt })),
        postPaths,
        pageErrors,
      }, null, 2), "utf8");
      console.error(JSON.stringify({ diagnostics, requestOrder, postPaths, pageErrors }, null, 2));
      throw error;
    }

    const completed = await readGraph(page);
    assert.ok(completed, "生成完成后画布数据丢失");
    await page.screenshot({ path: `${outputDir}/anime-director-full-flow-complete.png`, fullPage: false });

    const imageRequests = requestOrder.filter((item) => item.type === "image");
    const videoRequests = requestOrder.filter((item) => item.type === "video");
    assert.equal(imageRequests.length, characterReferences.length + keyframeNodes.length, "角色图和参考图应各只提交一次");
    assert.equal(videoRequests.length, videoNodes.length, "每个视频节点应只提交一次");
    assert.ok(imageRequests.every((request) => request.aspectRatio === "16:9"), "所有生图请求必须提交 16:9");
    assert.ok(videoRequests.every((request) => request.aspectRatio === "16:9"), "所有视频请求必须提交 16:9");
    assert.ok(videoRequests.every((request) => (request.referenceImageUrls?.length || 0) >= 1), "批量视频必须使用已生成参考图");

    const firstVideoIndex = requestOrder.findIndex((item) => item.type === "video");
    const lastImageIndex = requestOrder.map((item) => item.type).lastIndexOf("image");
    assert.ok(firstVideoIndex > lastImageIndex, "全部生成必须先完成角色图和参考图，再提交视频");

    for (let index = 1; index < imageRequests.length; index += 1) {
      assert.ok(imageRequests[index].submittedAt - imageRequests[index - 1].submittedAt >= 4_500, "批量生图必须约每 5 秒错峰提交 1 个任务");
    }
    for (let index = 1; index < videoRequests.length; index += 1) {
      assert.ok(videoRequests[index].submittedAt - videoRequests[index - 1].submittedAt >= 7_500, "批量视频必须约每 8 秒错峰提交 1 个任务");
    }

    const imagePromptByShot = new Map(imagePromptNodes.map((node) => [shotNumber(node.data.title), node.data.prompt || ""]));
    const videoPromptByShot = new Map(videoPromptNodes.map((node) => [shotNumber(node.data.title), node.data.prompt || ""]));
    for (const request of requestOrder) {
      if (request.type === "image" && !request.shot) {
        assert.match(request.prompt, /角色定妆图/u, "无镜头编号的生图请求必须是角色定妆图");
        continue;
      }
      if (request.type === "image") {
        const expectedPrompt = imagePromptByShot.get(request.shot);
        assert.ok(expectedPrompt && request.prompt.includes(expectedPrompt), `镜头 ${request.shot} 的生图请求没有使用独立生图提示词`);
        assert.match(request.prompt, /@参考图\d+[：:][^\n]*定妆图/u, `镜头 ${request.shot} 的生图请求缺少角色定妆参考绑定`);
        assert.ok((request.referenceImageUrls?.length || 0) >= 1, `镜头 ${request.shot} 的生图请求没有携带角色定妆图`);
      } else {
        const expectedPrompt = videoPromptByShot.get(request.shot);
        assert.equal(request.prompt, expectedPrompt, `镜头 ${request.shot} 的视频请求没有直接使用对应视频提示词`);
      }
    }

    assert.deepEqual(pageErrors, [], "页面运行时不应出现 JS 错误");
    assert.equal(postPaths.some((path) => path.includes("/upload")), false, "默认全流程不应调用上传接口");

    const finalGraph = await readGraph(page);
    const report = {
      runId,
      script,
      scriptLength: script.length,
      compiler: compileSummary.compiler,
      preset: compileSummary.preset,
      shotCount,
      characterReferences: characterReferences.map((node) => node.data.title),
      nodeCounts: {
        total: finalGraph?.nodes.length || 0,
        characterReferences: characterReferences.length,
        imagePrompts: imagePromptNodes.length,
        keyframes: keyframeNodes.length,
        videoPrompts: videoPromptNodes.length,
        videos: videoNodes.length,
      },
      semanticPackaging: {
        decoratedImagePrompts: decoratedImagePrompts.map((node) => node.data.title),
        decoratedVideoPrompts: decoratedVideoPrompts.map((node) => node.data.title),
      },
      requestOrder: requestOrder.map(({ type, shot, aspectRatio, submittedAt }) => ({ type, shot, aspectRatio, submittedAt })),
      postPaths,
      screenshots: {
        compiled: `${outputDir}/anime-director-full-flow-compiled.png`,
        complete: `${outputDir}/anime-director-full-flow-complete.png`,
      },
      acceptance: "passed",
    };
    await writeFile(`${outputDir}/anime-director-full-flow-acceptance.json`, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (headed) {
      console.log("Visible demo complete. Browser will stay open for 15 seconds.");
      await page.waitForTimeout(15_000);
    }
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
