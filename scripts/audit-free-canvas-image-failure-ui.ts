import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;
const graphKey = "ai-creation-studio-graph-v1";

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    assetRole?: string;
    status: string;
    error?: string;
    selectedCandidateId?: string;
    outputUrl?: string;
    history?: Array<{ outputUrl?: string }>;
  };
};

type Graph = {
  nodes: GraphNode[];
};

async function main() {
  const sessionResponse = phone && password
    ? await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 Free Canvas image failure UI verification",
        },
        body: JSON.stringify({ phone, password }),
      })
    : await fetch(`${baseUrl}/api/auth/dev-session`, {
        headers: { "x-local-workbench": "ai-creation-studio-local" },
      });
  const session = await sessionResponse.json() as {
    token?: string;
    user?: Record<string, unknown>;
    error?: string;
  };
  if (!phone && !password && sessionResponse.status === 404) {
    console.log(JSON.stringify({
      status: "skipped",
      reason: "production-mode-local-server-blocks-dev-session",
      requiredEnvironment: ["CANVAS_TEST_PHONE", "CANVAS_TEST_PASSWORD"],
      paidCalls: 0,
      providerCalls: 0,
    }, null, 2));
    return;
  }
  assert.ok(sessionResponse.ok && session.token && session.user, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
    await context.addInitScript((token) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", token);
    }, session.token);
    const page = await context.newPage();
    let imageRequests = 0;
    const candidateLandscape = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#172033"/></svg>')}`;

    await page.route("**/api/bridge/models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            {
              id: "mock-failing-image",
              name: "Mock Image - 失败模型",
              model_name: "gpt-image-1",
              provider: "mock",
              selling_price: 0.2,
              supports_image_input: true,
              sort_order: 1,
              resolution_options: ["1K", "2K"],
              default_resolution: "1K",
            },
            {
              id: "mock-retry-image",
              name: "Mock Image - 可重试模型",
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
        body: JSON.stringify({ models: [{
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
        }] }),
      });
    });
    await page.route("**/api/bridge/runtime-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: {
            defaults: { imageModelId: "mock-failing-image", videoModelId: "mock-keyframe-video" },
            health: { disabledImageModelIds: [] },
          },
        }),
      });
    });
    await page.route("**/api/bridge/balance", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 100 }) });
    });
    const handleMockImageGenerate = async (route: Parameters<Parameters<typeof page.route>[1]>[0]) => {
      imageRequests += 1;
      const payload = route.request().postDataJSON() as { modelId?: string };
      if (String(payload.modelId || "") !== "mock-retry-image") {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            error: `模拟图片上游 fetch failed；modelId=${payload.modelId || "unknown"}`,
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ images: [{ url: candidateLandscape }] }) });
    };
    await page.route("**/api/bridge/image/generate", handleMockImageGenerate);
    await page.route("**/api/image/generate", handleMockImageGenerate);
    await page.route("**/api/bridge/image/persist", async (route) => {
      const payload = route.request().postDataJSON() as { url?: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: payload.url || candidateLandscape }) });
    });

    await page.goto(`${baseUrl}/free-canvas?run=image-failure-ui`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const panel = page.locator('aside[aria-label="制作面板"]');
    if (await panel.count() === 0) await page.getByRole("button", { name: "打开制作面板" }).click();
    await panel.waitFor({ timeout: 20_000 });
    await panel.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill("一只小狗把雨伞拖进客厅，伞突然弹开，它吓得后退并留下湿脚印。主人回家时，小狗把尾巴藏在窗帘后，胸口浮出浅蓝色心虚颤线。");
    await page.locator(".free-script-importer > button:last-child").click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const runAll = document.querySelector(".free-canvas-actions button.run-all") as HTMLButtonElement | null;
      return !document.body.innerText.includes("正在交给")
        && Boolean(runAll && !runAll.disabled)
        && Boolean(graph?.nodes.some((node) => node.data.assetRole === "character-reference"));
    }, graphKey, { timeout: 180_000 });

    const panelBeforeImages = page.locator('aside[aria-label="制作面板"]');
    if (await panelBeforeImages.count() === 0) await page.getByRole("button", { name: "打开制作面板" }).click();
    await panelBeforeImages.waitFor({ timeout: 20_000 });
    await panelBeforeImages.locator(".free-production-progress button").nth(1).click();
    try {
      await page.waitForFunction((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        const characters = graph?.nodes.filter((node) => node.data.assetRole === "character-reference") || [];
        return characters.length > 0 && characters.every((node) => node.data.status === "failed" && Boolean(node.data.error));
      }, graphKey, { timeout: 120_000 });
    } catch (error) {
      await mkdir(".tmp-e2e", { recursive: true });
      const debugGraph = await page.evaluate((key) => {
        const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
        return {
          notice: document.body.innerText.match(/(?:开始生图|图片|失败|错误|检查未通过)[^\n]{0,120}/gu)?.slice(0, 8) || [],
          imageRequests: (window as unknown as { __imageRequests?: number }).__imageRequests,
          characters: graph?.nodes
            .filter((node) => node.data.assetRole === "character-reference")
            .map((node) => ({ id: node.id, title: node.data.title, status: node.data.status, error: node.data.error, outputUrl: Boolean(node.data.outputUrl) })) || [],
          images: graph?.nodes
            .filter((node) => node.data.kind === "image")
            .map((node) => ({ title: node.data.title, role: node.data.assetRole, status: node.data.status, error: node.data.error, outputUrl: Boolean(node.data.outputUrl) })) || [],
        };
      }, graphKey);
      await writeFile(".tmp-e2e/free-canvas-image-failure-ui-timeout.json", JSON.stringify(debugGraph, null, 2), "utf8");
      await page.screenshot({ path: ".tmp-e2e/free-canvas-image-failure-ui-timeout.png", fullPage: false });
      throw error;
    }

    const graph = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph, graphKey);
    const failedCharacter = graph.nodes.find((node) => node.data.assetRole === "character-reference" && node.data.status === "failed");
    assert.ok(failedCharacter, "角色图失败后应保留失败节点状态");
    assert.match(failedCharacter.data.error || "", /fetch failed|502|模拟图片上游/u, "失败节点应记录真实上游错误");

    await page.getByText(/角色01/u).first().dispatchEvent("click", undefined, { timeout: 20_000 });
    await page.getByText("图片生成失败").waitFor({ timeout: 10_000 });
    const modelSelect = page.locator('select[aria-label="图片生成模型"]').last();
    await modelSelect.waitFor({ timeout: 10_000 });
    assert.equal(await modelSelect.isDisabled(), false, "失败图片卡片必须允许手动换模型");
    await modelSelect.selectOption("mock-retry-image");
    await page.locator(".free-node-compose button", { hasText: /重试生成|生成/u }).last().click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const firstCharacter = graph?.nodes.find((node) => node.data.assetRole === "character-reference" && /角色01/u.test(node.data.title));
      return Boolean(firstCharacter?.data.status === "succeeded" && firstCharacter.data.history?.some((item) => item.outputUrl));
    }, graphKey, { timeout: 60_000 });

    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/free-canvas-image-failure-ui.png", fullPage: false });
    console.log(JSON.stringify({
      imageRequests,
      failedNode: {
        title: failedCharacter.data.title,
        error: failedCharacter.data.error,
      },
      acceptance: "passed",
    }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
