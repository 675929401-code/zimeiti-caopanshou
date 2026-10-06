import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const reviewId = process.env.CANVAS_REVIEW_ID || "semantic-visual-grammar-v26";
const script = process.env.CANVAS_REVIEW_SCRIPT || [
  "狗狗第一次见面时，明明彼此心动，却可能都不敢先靠近。",
  "幼犬歪着脑袋，往往是不明白对方为什么一直摇尾巴。",
  "异物进入狗狗肠道后，可能逐渐堆积并造成堵塞。",
].join("");

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) throw new Error(session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
    await context.addInitScript((token) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("auth_token", token);
    }, session.token);
    const page = await context.newPage();

    await page.route("**/api/bridge/models", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [{
        id: "gemini-3-1-flash-image-chA",
        name: "Nano Banana 2 · 渠道A",
        model_name: "gemini-3.1-flash-image",
        provider: "channel-a",
        selling_price: 0.2,
        supports_image_input: true,
        sort_order: 1,
        resolution_options: ["1K"],
        default_resolution: "1K",
      }] }),
    }));
    await page.route("**/api/bridge/video-models", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [{
        id: "veo-3-1-fast-chC",
        name: "Veo 3.1 Fast · 8秒 · 图生视频",
        modelName: "veo-3.1-fast",
        provider: "channel-c",
        pricePerUse: 0.3,
        durationSeconds: 8,
        maxDuration: 8,
        resolutionTier: "1080p",
        supportsImageInput: true,
        requiresImage: true,
        successRate: 100,
        durationMode: "fixed",
      }] }),
    }));
    await page.route("**/api/bridge/runtime-config", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ config: { defaults: { imageModelId: "gemini-3-1-flash-image-chA", videoModelId: "veo-3-1-fast-chC" }, health: { disabledImageModelIds: [] } } }),
    }));
    await page.route("**/api/bridge/balance", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ balance: 100 }),
    }));

    await page.goto(`${baseUrl}/free-canvas?run=${reviewId}-prompt-review`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.getByRole("button", { name: /动漫剧情/ }).click();
    await page.getByLabel("原始文案").fill(script);
    await page.locator(".free-script-importer > button:last-child").click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: Array<{ data?: { kind?: string; assetRole?: string } }> } | null;
      const keyframes = graph?.nodes?.filter((node) => node.data?.assetRole === "storyboard-keyframe") || [];
      const videos = graph?.nodes?.filter((node) => node.data?.kind === "video") || [];
      return keyframes.length === 3 && videos.length === 3;
    }, graphKey, { timeout: 360_000 });

    const graph = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), graphKey) as { name?: string; nodes: unknown[]; edges: unknown[] };
    graph.name = reviewId === "semantic-visual-grammar-v26"
      ? "动漫剧情导演 v26 · 语义包装提示词验收（未生成媒体）"
      : "动漫剧情导演 · 口播转故事验收（未生成媒体）";
    const outputDir = `public/demo-assets/${reviewId}`;
    await mkdir(outputDir, { recursive: true });
    await writeFile(`${outputDir}/graph.json`, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ reviewId, nodes: graph.nodes.length, edges: graph.edges.length }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
