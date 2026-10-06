import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Page, type Route } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { compileStoryboard, createDefaultCanvasPromptPresetStore } from "../src/lib/canvas-prompt-presets";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";

async function closeWithTimeout(
  closeable: { close(): Promise<void> },
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closeable.close().catch((error: unknown) => {
      console.error(`[free-canvas-production-ui] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[free-canvas-production-ui] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
const candidateLandscape = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#152033"/><rect x="620" y="90" width="360" height="720" rx="120" fill="#8bd3dd"/><text x="800" y="850" text-anchor="middle" font-size="52" fill="#ffffff">16:9</text></svg>')}`;

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    status: string;
    assetRole?: string;
    imageCount?: number;
    candidateSelectionRequired?: boolean;
    selectedCandidateId?: string;
    outputUrl?: string;
    aspectRatio?: string;
    history?: Array<{ outputUrl?: string }>;
  };
};

type Graph = {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
};

let observedGraph: Graph | null = null;

async function readGraph() {
  assert.ok(observedGraph, "画布尚未向服务端保存可核验文档");
  return structuredClone(observedGraph);
}

async function waitForObservedGraph(page: Page, predicate: (graph: Graph) => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (observedGraph && predicate(observedGraph)) return;
    await page.waitForTimeout(100);
  }
  throw new Error("等待画布服务端文档更新超时");
}

async function waitForCompiledGraph(page: Page) {
  try {
    await waitForObservedGraph(page, (graph) => (
      graph.nodes.length >= 10
      && graph.nodes.some((node) => node.data.assetRole === "character-reference")
      && graph.nodes.some((node) => node.data.kind === "video")
      && graph.edges.length > 0
    ));
    await page.waitForFunction(() => {
      const nodeCount = document.querySelectorAll(".react-flow__node").length;
      return nodeCount >= 10;
    }, undefined, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      notice: document.querySelector(".free-page-notice")?.textContent || "",
      imageModel: (document.querySelector(".free-global-model-grid select") as HTMLSelectElement | null)?.selectedOptions[0]?.textContent || "",
      videoModel: (document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null)?.selectedOptions[0]?.textContent || "",
      nodeCount: document.querySelectorAll(".react-flow__node").length,
      nodeTexts: [...document.querySelectorAll(".react-flow__node")]
        .slice(0, 8)
        .map((node) => (node.textContent || "").slice(0, 160)),
      flowCount: document.querySelector(".flow-count")?.textContent || "",
      flowSurface: document.querySelector(".free-flow-surface")?.textContent?.slice(0, 500) || "",
      bodyTail: document.body.innerText.slice(-1200),
    }));
    console.error(JSON.stringify({
      compileDiagnostics: {
        ...diagnostics,
        savedGraph: observedGraph
          ? { nodes: observedGraph.nodes.length, edges: observedGraph.edges.length }
          : null,
      },
    }, null, 2));
    throw error;
  }
}

async function main() {
  const preset = createDefaultCanvasPromptPresetStore().presets.find((item) => item.id === "anime_story");
  assert.ok(preset, "缺少动漫剧情提示词方案");

  let token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  if (!token) {
    const db = getSupabaseClient();
    const { data: user, error: userError } = await db
      .from("users")
      .select("id, username, display_name")
      .eq("role", "student")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    assert(!userError && user, userError?.message || "FREE_CANVAS_ACTIVE_USER_MISSING");
    token = await createToken({
      userId: String(user.id),
      username: String(user.username),
      role: "student",
      displayName: String(user.display_name || "画布验收用户"),
      sessionId: `free-canvas-${randomUUID()}`,
    });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ authToken }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", authToken);
    }, { authToken: token });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    let imageRequests = 0;
    let imageInFlight = 0;
    let maxImageInFlight = 0;
    const imageRequestBodies: Array<{ aspectRatio?: string; resolution?: string; modelId?: string; referenceImageUrls?: string[] }> = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/cover-models?surface=free-canvas", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            {
              id: "mock-reference-image",
              displayName: "Mock Image · 支持图像输入",
              variantLabel: "A",
              avatarUrl: "",
              publicPrice: 0.2,
              capabilities: {
                type: "image",
                family: "gemini-3.1-flash-image",
                supportsImageInput: true,
                supportsReferenceInput: true,
                referenceInputMode: "multi",
                identityReferenceLevel: "multi-subject",
                maxReferenceImages: 8,
                maxCharacterReferences: 4,
                referenceCapabilityLabel: "多角色参考（最多4个角色）",
                resolutionOptions: ["1K", "2K"],
                defaultResolution: "1K",
              },
            },
          ],
        }),
      });
    });
    await page.route("**/api/video/models?surface=free-canvas", async (route) => {
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
      };
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
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...compiled, compiler: "ai", compilerDiagnostics: [] }),
      });
    });
    await page.route("**/api/bridge/balance", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 100 }) });
    });
    await page.route("**/api/bridge/image/generate", async (route) => {
      const body = route.request().postDataJSON() as { aspectRatio?: string; resolution?: string; modelId?: string; referenceImageUrls?: string[] };
      imageRequestBodies.push(body);
      imageRequests += 1;
      imageInFlight += 1;
      maxImageInFlight = Math.max(maxImageInFlight, imageInFlight);
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      imageInFlight -= 1;
      const operationId = `mock-image-operation-${imageRequests}`;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          images: [{
            url: candidateLandscape,
            width: 1600,
            height: 900,
            assetId: `mock-image-asset-${imageRequests}`,
            storageKey: `mock/canvas/image-${imageRequests}.jpg`,
          }],
          taskId: `mock-image-task-${imageRequests}`,
          operationId,
          billingReferenceId: `image:${operationId}`,
          cashCharged: 0,
          modelUsed: "Mock Image · 支持图像输入",
        }),
      });
    });
    let persistedImageCount = 0;
    const fulfillPersistedImage = async (route: Route) => {
      const body = route.request().postDataJSON() as { url?: string; assetId?: string; storageKey?: string };
      persistedImageCount += 1;
      const suffix = String(persistedImageCount).padStart(2, "0");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: body.url || candidateLandscape,
          assetId: body.assetId || `mock-persisted-asset-${suffix}`,
          storageKey: body.storageKey || `mock/canvas/persisted-image-${suffix}.jpg`,
          historyRecordId: `mock-image-history-${suffix}`,
          createdAt: new Date().toISOString(),
        }),
      });
    };
    await page.route("**/api/bridge/image/persist", fulfillPersistedImage);
    await page.route("**/api/image-workbench/persist", fulfillPersistedImage);
    let canvasRevision = 0;
    await page.route(/\/api\/canvas(?:\?.*)?$/u, async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ canvases: [], pagination: { offset: 0, limit: 50, total: 0, nextOffset: null } }),
        });
        return;
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON() as {
          action?: string;
          canvasId?: string;
          document?: { session?: { id?: string; name?: string; nodes?: GraphNode[]; edges?: Graph["edges"] } };
        };
        if (body.action === "save" && body.document?.session) {
          observedGraph = {
            nodes: structuredClone(body.document.session.nodes || []),
            edges: structuredClone(body.document.session.edges || []),
          };
          canvasRevision += 1;
          const now = new Date().toISOString();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              canvas: {
                id: body.canvasId || body.document.session.id,
                name: body.document.session.name || "验收画布",
                revision: canvasRevision,
                createdAt: now,
                updatedAt: now,
              },
              idempotentReplay: false,
            }),
          });
          return;
        }
      }
      if (request.method() === "DELETE") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
        return;
      }
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unexpected canvas verifier request" }) });
    });

    await page.goto(`${baseUrl}/free-canvas?revision=anime-performance-v2`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const panel = page.locator('aside[aria-label="制作面板"]');
    await panel.waitFor({ timeout: 20_000 });
    const imageModelSelect = page.locator(".free-global-model-grid select").first();
    await page.waitForFunction(() => {
      const select = document.querySelector(".free-global-model-grid select") as HTMLSelectElement | null;
      const videoSelect = document.querySelector('select[aria-label="全局视频生成模型"]') as HTMLSelectElement | null;
      return Boolean(select && [...select.options].some((option) => option.textContent?.includes("支持图像输入")) && videoSelect && videoSelect.options.length >= 1);
    }, undefined, { timeout: 20_000 });
    const referenceModelId = await imageModelSelect.locator("option").evaluateAll((options) => (
      (options as HTMLOptionElement[]).find((option) => option.textContent?.includes("支持图像输入"))?.value || ""
    ));
    assert.ok(referenceModelId, "验收需要至少一个支持角色设定图引用的图片模型");
    await imageModelSelect.selectOption(referenceModelId);
    await panel.getByRole("button", { name: /故事版提示词/ }).click();
    await page.locator('select').filter({ has: page.locator('option', { hasText: '16:9' }) }).first().selectOption("16:9");
    await page.getByLabel(/分段文案|原始文案/).fill(
      "小狗安静守在熟睡的女主人床边，听见门外响动后先竖起耳朵确认安全。清晨的光从窗帘缝里落进来，它一直没有离开，只把身体伏得更低。主人翻身时，它轻轻靠近床沿观察呼吸，又回头确认门口没有异常。等主人睁眼，它才快速摇尾巴凑近，却在碰到被角前主动减速。主人伸手摸了摸它的额头，小狗放松耳朵，把下巴放在床边安心陪伴。原来它不是刚刚睡醒，而是整晚都在用自己的方式守护最重要的人。",
    );

    assert.ok(await panel.getByRole("button", { name: /导演拆解|镜头拆分/ }).count() >= 1, "制作进度必须直接显示导演拆解/镜头拆分入口");
    assert.ok(await panel.getByRole("button", { name: /批量视频/ }).count() >= 1, "制作进度必须直接显示批量视频入口");
    assert.equal(await panel.getByRole("button", { name: "试生成 1 张" }).count(), 1, "必须提供低成本单张预览入口");
    assert.equal(await panel.getByRole("button", { name: "试生成 1 条" }).count(), 1, "必须提供单条视频预览入口");
    assert.equal(await panel.getByRole("button", { name: "下载参考图" }).count(), 1, "参考图下载必须独立显示");
    assert.equal(await panel.getByRole("button", { name: "下载视频 + 文案TXT" }).count(), 1, "视频下载必须明确附带文案TXT");

    await page.locator(".free-script-importer > button:last-child").click();
    await waitForCompiledGraph(page);

    await page.getByRole("button", { name: "打开制作面板" }).click();
    await panel.waitFor({ state: "visible", timeout: 10_000 });
    await panel.getByRole("button", { name: "试生成 1 张" }).click();
    await waitForObservedGraph(page, (graph) => Boolean(
      graph.nodes.find((node) => node.data.assetRole === "character-reference")?.data.history?.some((item) => item.outputUrl),
    ), 20_000);
    const draft = await readGraph();
    const characterReferences = draft.nodes.filter((node) => node.data.kind === "image" && node.data.assetRole === "character-reference");
    const keyframes = draft.nodes.filter((node) => node.data.kind === "image" && /自动关键帧|故事板参考图/u.test(node.data.title));
    const videos = draft.nodes.filter((node) => node.data.kind === "video");
    assert.ok(characterReferences.length >= 1, "自动模式必须先按角色创建独立定妆图");
    assert.ok(draft.nodes.every((node) => node.data.aspectRatio === "16:9"), "16:9 拆镜后所有画布节点都必须保持横屏比例");
    assert.ok(characterReferences.every((node) => node.data.imageCount === 1 && node.data.candidateSelectionRequired), "自动角色图必须逐个生成并等待确认");
    assert.equal(keyframes.length, videos.length, "每个分镜必须严格对应一张关键帧和一个视频");
    assert.ok(keyframes.length >= 4, "并发验收至少需要4个分镜");
    assert.equal(imageRequests, 1, "试生成1张只能提交一个角色定妆任务");
    assert.equal(imageRequestBodies[0]?.aspectRatio, "16:9", "角色定妆图请求必须把 16:9 原样提交到生图接口");
    const firstCandidateButton = page.locator(".free-node-preview-candidates button").first();
    await firstCandidateButton.waitFor({ state: "attached", timeout: 10_000 });
    await firstCandidateButton.evaluate((button: HTMLButtonElement) => button.click());
    await waitForObservedGraph(page, (graph) => Boolean(
      graph.nodes.find((node) => node.id === characterReferences[0]?.id)?.data.selectedCandidateId,
    ), 10_000);

    for (const character of characterReferences.slice(1)) {
      await panel.getByRole("button", { name: "试生成 1 张" }).click();
      await waitForObservedGraph(page, (graph) => Boolean(
        graph.nodes.find((node) => node.id === character.id)?.data.history?.some((item) => item.outputUrl),
      ), 20_000);
      const candidateButton = page.locator(".react-flow__node")
        .filter({ hasText: character.data.title })
        .locator(".free-node-preview-candidates button")
        .first();
      await candidateButton.waitFor({ state: "attached", timeout: 10_000 });
      await candidateButton.evaluate((button: HTMLButtonElement) => button.click());
      await waitForObservedGraph(page, (graph) => Boolean(
        graph.nodes.find((node) => node.id === character.id)?.data.selectedCandidateId,
      ), 10_000);
    }
    assert.equal(imageRequests, characterReferences.length, "进入关键帧阶段前，每个角色必须且只能完成一次定妆生成");

    const batchButton = panel.getByRole("button", { name: /批量生图/ });
    await batchButton.click();
    try {
      await page.waitForFunction(() => document.body.innerText.includes("暂停队列"), undefined, { timeout: 10_000 });
    } catch (error) {
      console.error(JSON.stringify({
        batchStartDiagnostics: {
          notice: await page.locator(".free-page-notice").textContent().catch(() => ""),
          imageRequests,
          graph: observedGraph ? {
            nodes: observedGraph.nodes.length,
            edges: observedGraph.edges.length,
            pendingCandidates: observedGraph.nodes
              .filter((node) => node.data.candidateSelectionRequired && !node.data.selectedCandidateId)
              .map((node) => node.data.title),
          } : null,
        },
      }, null, 2));
      throw error;
    }
    const firstKeyframeRequestTarget = characterReferences.length + 1;
    const concurrencyDeadline = Date.now() + 60_000;
    while (imageRequests < firstKeyframeRequestTarget && Date.now() < concurrencyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(imageRequests >= firstKeyframeRequestTarget, `批量阶段必须越过 ${characterReferences.length} 张角色定妆图并继续提交关键帧，当前请求数 ${imageRequests}`);
    assert.ok(imageRequestBodies.every((body) => body.aspectRatio === "16:9"), "批量生图的每个请求都必须保持 16:9");
    await panel.getByRole("button", { name: "暂停队列" }).click();
    await panel.getByText(/队列已暂停/).waitFor({ timeout: 10_000 });
    assert.equal(await panel.getByRole("button", { name: "继续队列" }).count(), 1, "暂停后必须提供明确继续入口");
    await panel.getByRole("button", { name: "继续队列" }).click();
    await page.getByText("图片生成阶段已完成，请预览关键帧，确认后再开始生成视频", { exact: true }).waitFor({ timeout: 120_000 });
    await waitForObservedGraph(page, (graph) => {
      const images = graph.nodes.filter((node) => node.data.kind === "image");
      return images.length > 0
        && images.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl));
    }, 20_000);

    const completed = await readGraph();
    const completedImages = completed.nodes.filter((node) => node.data.kind === "image");
    const incompleteImages = completedImages
      .filter((node) => node.data.status !== "succeeded" || !node.data.outputUrl)
      .map((node) => ({
        title: node.data.title,
        status: node.data.status,
        hasOutput: Boolean(node.data.outputUrl),
        historyCount: node.data.history?.length || 0,
        selectedCandidateId: node.data.selectedCandidateId || "",
      }));
    if (incompleteImages.length > 0) {
      console.error(JSON.stringify({ incompleteImages }, null, 2));
    }
    assert.ok(completedImages.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl)), "批量生图必须完成全部图片节点");
    assert.equal(imageRequests, completedImages.length, "每张图片只能提交一次生成请求");
    assert.ok(maxImageInFlight >= 2, "批量图片必须是错峰提交、并发等待结果，不能等待上一张完全结束才提交下一张");
    assert.equal(await panel.getByRole("button", { name: "下载参考图" }).isEnabled(), true, "完成生图后必须立即允许下载参考图");
    assert.equal(await panel.getByRole("button", { name: "下载视频 + 文案TXT" }).isDisabled(), true, "视频未生成时不得伪装为可下载");
    assert.match(await panel.locator(".free-production-command-help").innerText(), /图片每 5 秒提交 1 张；视频每 8 秒提交 1 条/u, "抽屉必须向用户说明当前错峰策略");
    assert.deepEqual(pageErrors, [], "制作抽屉与批量队列不应产生页面错误");

    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/free-canvas-production-drawer.png", fullPage: false });
    await panel.getByRole("button", { name: /检查与工具/ }).click();
    page.once("dialog", async (dialog) => {
      assert.match(dialog.message(), /清空当前画布/u, "清空画布必须先给出不可逆范围确认");
      await dialog.accept();
    });
    await panel.getByRole("button", { name: "清空画布" }).click();
    await waitForObservedGraph(page, (graph) => graph.nodes.length === 0 && graph.edges.length === 0, 10_000);

    console.log(JSON.stringify({ shots: keyframes.length, imageRequests, maxImageInFlight, controls: ["导演拆解", "批量生图", "批量视频", "暂停/继续", "分开下载", "清空画布"] }, null, 2));
  } finally {
    await closeWithTimeout(browser, "browser.close");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
