import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const candidateLandscape = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#172033"/><text x="800" y="470" text-anchor="middle" font-size="72" fill="#ffffff">16:9</text></svg>')}`;

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt?: string;
    visualOrder?: number;
    imageMode?: string;
    assetRole?: string;
    status: string;
    outputUrl?: string;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

function shotNumber(text: string) {
  const value = text.match(/(?:镜头|分镜)\s*0*(\d+)/u)?.[1] || "";
  return value ? String(Number(value)) : "";
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", "canvas-auto-batch-mock");
    });
    const page = await context.newPage();
    const requestOrder: Array<{
      type: "image" | "video";
      shot: string;
      prompt: string;
      referenceImageUrls?: string[];
      submittedAt: number;
    }> = [];
    const postPaths: string[] = [];
    const pageErrors: string[] = [];
    let videoIndex = 0;

    await page.route("**/api/canvas/compile-script", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers.authorization;
      const response = await route.fetch({ headers });
      const payload = await response.json() as Record<string, unknown>;
      await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify({ ...payload, compiler: "ai" }) });
    });
    await page.route("**/api/bridge/balance", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 100 }) });
    });
    await page.route("**/api/bridge/image/generate", async (route) => {
      const payload = route.request().postDataJSON() as { prompt?: string; referenceImageUrls?: string[] };
      requestOrder.push({
        type: "image",
        shot: shotNumber(payload.prompt || ""),
        prompt: payload.prompt || "",
        referenceImageUrls: payload.referenceImageUrls || [],
        submittedAt: Date.now(),
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [{ url: candidateLandscape }] }) });
    });
    await page.route("**/api/bridge/image/persist", async (route) => {
      const payload = route.request().postDataJSON() as { url?: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: payload.url || candidateLandscape }) });
    });
    await page.route("**/api/bridge/video/generate", async (route) => {
      const payload = route.request().postDataJSON() as { task_label?: string; prompt?: string };
      requestOrder.push({
        type: "video",
        shot: shotNumber(payload.task_label || ""),
        prompt: payload.prompt || "",
        submittedAt: Date.now(),
      });
      videoIndex += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          task_id: `mock-video-${videoIndex}`,
          status: "completed",
          video_url: `${baseUrl}/uploads/videos/generated/2026/08/08/manual-trim-diagnostic.mp4?mock=${videoIndex}`,
        }),
      });
    });
    page.on("request", (request) => {
      if (request.method() === "POST") postPaths.push(new URL(request.url()).pathname);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
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
          models: [
            {
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
            },
            {
              id: "mock-text-video",
              name: "Mock Video · 纯文生视频",
              modelName: "mock-text-video",
              provider: "mock",
              pricePerUse: 0.1,
              durationSeconds: 5,
              maxDuration: 8,
              resolutionTier: "720p",
              supportsImageInput: false,
              requiresImage: false,
              successRate: 100,
              durationMode: "range",
              minDuration: 3,
            },
          ],
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

    await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.waitForFunction(() => {
      const imageSelect = document.querySelector(".free-global-model-grid select") as HTMLSelectElement | null;
      const videoSelect = document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null;
      return Boolean(imageSelect && [...imageSelect.options].some((option) => option.textContent?.includes("支持图像输入")) && videoSelect && videoSelect.options.length > 1);
    }, undefined, { timeout: 20_000 });
    const imageModelSelect = page.getByLabel("自动关键帧 / 视觉探索模型");
    const referenceModelId = await imageModelSelect.locator("option").evaluateAll((options) => (
      (options as HTMLOptionElement[]).find((option) => option.textContent?.includes("支持图像输入"))?.value || ""
    ));
    assert.ok(referenceModelId, "自动批量验收需要支持角色设定图引用的图片模型");
    await imageModelSelect.selectOption(referenceModelId);
    await page.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill("小狗独自在客厅等待，听见钥匙声后立刻抬头跑向门口，最后安心依偎在主人身边。");

    assert.equal(await page.getByLabel("一致性增强").count(), 0, "高级设置默认应收起，主流程不应要求选择已有图片");
    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/free-canvas-auto-input-simple.png", fullPage: false });
    await page.locator(".free-script-importer > button:last-child").click();
    await page.waitForFunction(() => {
      const button = document.querySelector(".free-canvas-actions button.run-all") as HTMLButtonElement | null;
      return Boolean(button && !button.disabled);
    }, undefined, { timeout: 30_000 });

    const draft = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph, graphKey);
    const imageNodes = draft.nodes.filter((node) => node.data.kind === "image");
    const characterReferences = imageNodes.filter((node) => node.data.assetRole === "character-reference");
    const keyframeNodes = imageNodes.filter((node) => /自动关键帧/u.test(node.data.title));
    const videoNodes = draft.nodes.filter((node) => node.data.kind === "video");
    const imagePromptNodes = draft.nodes.filter((node) => node.data.kind === "text" && draft.edges.some((edge) => (
      edge.source === node.id && keyframeNodes.some((keyframe) => keyframe.id === edge.target)
    )));
    const videoPromptNodes = draft.nodes.filter((node) => node.data.kind === "text" && draft.edges.some((edge) => (
      edge.source === node.id && videoNodes.some((video) => video.id === edge.target)
    )));
    assert.ok(characterReferences.length > 0, "默认自动流程必须先创建角色定妆图");
    assert.ok(keyframeNodes.length > 0, "自动拆镜必须创建关键帧节点");
    assert.equal(videoPromptNodes.length, imagePromptNodes.length, "每镜必须有一份独立视频提示词和一份独立参考图提示词");
    assert.equal(imagePromptNodes.length, keyframeNodes.length, "每份生图提示词必须只驱动一张关键帧图片");
    assert.equal(keyframeNodes.length, videoNodes.length, "每个自动关键帧必须对应一个视频节点");
    assert.equal(draft.nodes.some((node) => node.data.kind === "upload"), false, "默认自动流程不得创建上传节点");
    assert.ok(characterReferences.every((node) => node.data.imageMode === "text-to-image"), "角色定妆图必须先由全文角色设定自动生成");
    assert.ok(keyframeNodes.every((node) => node.data.imageMode === "image-to-image"), "逐镜关键帧必须参考角色定妆图生成");
    assert.ok(keyframeNodes.every((node) => node.data.prompt === "{{input.text}}"), "关键帧生成节点必须只读取上游生图提示词");
    assert.ok(videoNodes.every((node) => node.data.prompt === "{{input.text}}"), "视频生成节点必须只读取上游视频提示词");
    for (const imageNode of keyframeNodes) {
      const order = imageNode.data.visualOrder;
      const imagePromptNode = imagePromptNodes.find((node) => node.data.visualOrder === order);
      const videoPromptNode = videoPromptNodes.find((node) => node.data.visualOrder === order);
      const videoNode = videoNodes.find((node) => node.data.visualOrder === order);
      assert.ok(imagePromptNode && videoPromptNode && videoNode, `镜头${order}缺少四层节点`);
      const imageDirectorIds = draft.edges.filter((edge) => edge.target === imagePromptNode.id).map((edge) => edge.source);
      const videoDirectorIds = draft.edges.filter((edge) => edge.target === videoPromptNode.id).map((edge) => edge.source);
      assert.ok(imageDirectorIds.some((id) => videoDirectorIds.includes(id)), `镜头${order}的参考图与视频提示词没有来自同一语义导演卡`);
      assert.ok(draft.edges.some((edge) => edge.source === imagePromptNode.id && edge.target === imageNode.id), `镜头${order}缺少生图提示词到图片生成连线`);
      assert.ok(draft.edges.some((edge) => characterReferences.some((character) => character.id === edge.source) && edge.target === imageNode.id), `镜头${order}缺少角色定妆图到关键帧的身份参考连线`);
      assert.ok(draft.edges.some((edge) => edge.source === videoPromptNode.id && edge.target === videoNode.id), `镜头${order}缺少视频提示词到视频生成连线`);
      assert.ok(draft.edges.some((edge) => edge.source === imageNode.id && edge.target === videoNode.id), `镜头${order}缺少关键帧到视频生成连线`);
    }

    await page.locator(".free-canvas-actions button.run-all").click();
    try {
      await page.waitForFunction((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        const media = graph?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
        return media.length > 0 && media.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl));
      }, graphKey, { timeout: 120_000 });
    } catch (error) {
      const diagnostics = await page.evaluate((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        return {
          notice: document.querySelector(".free-page-notice")?.textContent || "",
          runningText: document.body.innerText.match(/(?:正在|已生成|已自动|暂停|失败|完成)[^\n]{0,80}/gu)?.slice(-12) || [],
          media: graph?.nodes
            .filter((node) => node.data.kind === "image" || node.data.kind === "video")
            .map((node) => ({
              title: node.data.title,
              kind: node.data.kind,
              assetRole: node.data.assetRole || "",
              status: node.data.status,
              hasOutput: Boolean(node.data.outputUrl),
            })) || [],
        };
      }, graphKey);
      console.error(JSON.stringify({ autoBatchTimeout: diagnostics, requestOrder, postPaths, pageErrors }, null, 2));
      throw error;
    }
    const completed = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph, graphKey);
    const completedMedia = completed.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video");
    assert.ok(completedMedia.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl)), "自动关键帧和视频节点必须全部完成");
    const imagePromptByShot = new Map(imagePromptNodes.map((node) => [shotNumber(node.data.title), node.data.prompt || ""]));
    const videoPromptByShot = new Map(videoPromptNodes.map((node) => [shotNumber(node.data.title), node.data.prompt || ""]));
    const keyframeImageRequests = requestOrder.filter((item) => item.type === "image" && [...imagePromptByShot.values()].some((prompt) => (
      Boolean(prompt) && item.prompt.includes(prompt)
    )));
    const videoRequests = requestOrder.filter((item) => item.type === "video");
    assert.equal(keyframeImageRequests.length, keyframeNodes.length, "每张关键帧都必须实际提交一次生图请求");
    assert.ok(videoRequests.every((videoRequest) => (
      keyframeImageRequests.every((imageRequest) => imageRequest.submittedAt < videoRequest.submittedAt)
    )), "全部生成必须先完成所有角色图和关键帧，再开始提交视频");
    for (const request of requestOrder) {
      const matchedImagePrompt = request.type === "image"
        ? [...imagePromptByShot.entries()].find(([, prompt]) => Boolean(prompt) && request.prompt.includes(prompt))
        : undefined;
      if (request.type === "image" && !matchedImagePrompt) {
        assert.match(request.prompt, /角色定妆图/u, "无分镜编号的生图请求必须生成角色定妆图");
        continue;
      }
      const effectiveShot = request.type === "image" ? matchedImagePrompt?.[0] || "" : request.shot;
      const expectedPrompt = request.type === "image" ? matchedImagePrompt?.[1] : videoPromptByShot.get(effectiveShot);
      if (request.type === "image") {
        assert.ok(expectedPrompt && request.prompt.includes(expectedPrompt), `镜头${effectiveShot}的图片请求必须包含独立生图提示词`);
        assert.match(request.prompt, /@参考图\d+[：:][^\n]*定妆图/u, `镜头${effectiveShot}必须附加角色身份绑定规则`);
        assert.ok((request.referenceImageUrls?.length || 0) >= 1, `镜头${effectiveShot}必须提交至少一张角色定妆参考图`);
      } else {
        assert.equal(request.prompt, expectedPrompt, `镜头${effectiveShot}的视频请求使用了错误Prompt来源`);
      }
    }
    for (let index = 1; index < videoRequests.length; index += 1) {
      assert.ok(videoRequests[index].submittedAt - videoRequests[index - 1].submittedAt >= 7_500, "批量视频必须约每8秒错峰提交，不能瞬间打满上游");
    }
    assert.equal(postPaths.some((path) => path.includes("/upload")), false, "默认自动批量生成不得调用上传接口");
    assert.equal(postPaths.filter((path) => path === "/api/bridge/image/generate").length, imageNodes.length, "每个角色定妆图和每个镜头关键帧只调用一次生图");
    assert.equal(postPaths.filter((path) => path === "/api/bridge/video/generate").length, videoNodes.length, "每个镜头只调用一次视频生成");
    assert.deepEqual(pageErrors, [], "自动批量生成不应出现页面错误");

    await page.screenshot({ path: ".tmp-e2e/free-canvas-auto-batch-complete.png", fullPage: false });
    console.log(JSON.stringify({ videoPromptNodes: videoPromptNodes.length, imagePromptNodes: imagePromptNodes.length, characterReferences: characterReferences.map((node) => node.data.title), keyframeNodes: keyframeNodes.length, videoNodes: videoNodes.length, requestOrder: requestOrder.map(({ type, shot, submittedAt }) => ({ type, shot, submittedAt })), postPaths }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
