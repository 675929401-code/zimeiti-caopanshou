import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, request as playwrightRequest, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const reviewId = "semantic-visual-grammar-v26";
const runId = "live-media-v27-20260813-1";
const graphKey = "ai-creation-studio-graph-v1";
const graphPath = `public/demo-assets/${reviewId}/graph.json`;
const outputDir = `.tmp-e2e/${runId}`;

type NodeData = {
  kind: string;
  title: string;
  assetRole?: string;
  status?: string;
  outputUrl?: string;
  error?: string;
  taskId?: string;
  modelId?: string;
  visualOrder?: number;
};
type Graph = { name: string; nodes: Array<{ id: string; data: NodeData }>; edges: unknown[]; updatedAt?: string };

function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

function summary(graph: Graph | null) {
  const media = graph?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
  const group = (kind: "image" | "video") => {
    const nodes = media.filter((node) => node.data.kind === kind);
    return {
      total: nodes.length,
      succeeded: nodes.filter((node) => node.data.status === "succeeded" && node.data.outputUrl).length,
      running: nodes.filter((node) => node.data.status === "running" || node.data.status === "queued").length,
      failed: nodes.filter((node) => node.data.status === "failed").length,
      pending: nodes.filter((node) => !node.data.outputUrl && !["running", "queued", "failed"].includes(node.data.status || "idle")).length,
      failures: nodes.filter((node) => node.data.status === "failed").map((node) => ({ title: node.data.title, error: node.data.error || "" })),
    };
  };
  return { image: group("image"), video: group("video") };
}

async function waitForSettle(page: Page, timeoutMs: number) {
  const startedAt = Date.now();
  let observedRunning = false;
  let last = "";
  while (Date.now() - startedAt < timeoutMs) {
    const current = summary(await readGraph(page));
    const controls = await page.locator(".free-canvas-actions .batch-control").count();
    const running = current.image.running + current.video.running;
    observedRunning ||= controls > 0 || running > 0;
    const line = `图片 ${current.image.succeeded}/${current.image.total}（运行${current.image.running} 失败${current.image.failed} 等待${current.image.pending}）；视频 ${current.video.succeeded}/${current.video.total}（运行${current.video.running} 失败${current.video.failed} 等待${current.video.pending}）`;
    if (line !== last) {
      console.log(`[anime-v27-live] ${line}`);
      last = line;
    }
    if (observedRunning && controls === 0 && running === 0) return current;
    await page.waitForTimeout(3_000);
  }
  throw new Error(`生成队列在 ${Math.round(timeoutMs / 60_000)} 分钟内未收口`);
}

async function clickStage(page: Page, label: "批量生图" | "批量视频") {
  const panel = page.locator(".free-pro-panel");
  if (!(await panel.isVisible().catch(() => false))) await page.getByRole("button", { name: "打开制作面板" }).click();
  const button = page.locator(".free-production-progress button").filter({ hasText: label }).first();
  await button.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await button.isDisabled(), false, `${label}按钮不可用`);
  await button.click();
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const auth = await playwrightRequest.newContext();
  const sessionResponse = await auth.get(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await auth.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地会话不可用");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  await context.addInitScript((token) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") localStorage.removeItem(key);
    }
    localStorage.setItem("auth_token", token);
  }, session.token);
  const page = await context.newPage();
  const requests: Array<{ kind: "image" | "video"; at: number; status?: number; modelId?: string }> = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !["/api/bridge/image/generate", "/api/bridge/video/generate"].includes(path)) return;
    let body: Record<string, unknown> = {};
    try { body = request.postDataJSON() as Record<string, unknown>; } catch {}
    requests.push({ kind: path.includes("/image/") ? "image" : "video", at: Date.now(), modelId: String(body.modelId || body.model_id || "") });
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== "POST" || !["/api/bridge/image/generate", "/api/bridge/video/generate"].includes(path)) return;
    const kind = path.includes("/image/") ? "image" : "video";
    const record = [...requests].reverse().find((item) => item.kind === kind && item.status === undefined);
    if (record) record.status = response.status();
  });

  try {
    const url = `${baseUrl}/free-canvas?review=${reviewId}&run=${runId}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(response?.ok(), `画布返回 ${response?.status()}`);
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const images = graph?.nodes.filter((node) => node.data.kind === "image") || [];
      const videos = graph?.nodes.filter((node) => node.data.kind === "video") || [];
      return images.length === 5 && videos.length === 3;
    }, graphKey, { timeout: 30_000 });
    await page.screenshot({ path: join(outputDir, "01-before.png") });

    await page.locator(".free-canvas-actions .run-all").click();
    let current = await waitForSettle(page, 60 * 60_000);
    for (let attempt = 1; attempt <= 2 && current.image.succeeded < current.image.total; attempt += 1) {
      console.log(`[anime-v27-live] 继续补跑图片，第 ${attempt} 次`);
      await clickStage(page, "批量生图");
      current = await waitForSettle(page, 30 * 60_000);
    }
    assert.equal(current.image.succeeded, 5, `图片未全部成功：${JSON.stringify(current.image.failures)}`);
    await page.screenshot({ path: join(outputDir, "02-images.png") });

    for (let attempt = 1; attempt <= 4 && current.video.succeeded < current.video.total; attempt += 1) {
      console.log(`[anime-v27-live] 继续生成或查询视频，第 ${attempt} 次`);
      await clickStage(page, "批量视频");
      current = await waitForSettle(page, 30 * 60_000);
    }
    assert.equal(current.video.succeeded, 3, `视频未全部成功：${JSON.stringify(current.video.failures)}`);

    const graph = await readGraph(page);
    assert.ok(graph, "完成后画布不存在");
    graph.updatedAt = new Date().toISOString();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await context.storageState({ path: join(outputDir, "storage-state.json") });
    await page.screenshot({ path: join(outputDir, "03-complete.png") });
    const imageRequests = requests.filter((item) => item.kind === "image");
    const videoRequests = requests.filter((item) => item.kind === "video");
    const report = {
      url,
      result: "generated",
      summary: current,
      requests,
      imageIntervalsMs: imageRequests.slice(1).map((item, index) => item.at - imageRequests[index].at),
      videoIntervalsMs: videoRequests.slice(1).map((item, index) => item.at - videoRequests[index].at),
      media: graph.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video").map((node) => ({
        title: node.data.title,
        kind: node.data.kind,
        role: node.data.assetRole,
        modelId: node.data.modelId,
        status: node.data.status,
        outputUrl: node.data.outputUrl,
        taskId: node.data.taskId,
      })),
    };
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
