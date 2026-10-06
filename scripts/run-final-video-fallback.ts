import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest, type Page } from "playwright";

const baseUrl = "http://127.0.0.1:5000";
const reviewId = "final-full-flow-v1";
const runId = process.env.CANVAS_RUN_ID || "final-fallback-20260813-1";
const outputDir = `.tmp-e2e/${runId}`;
const graphKey = "ai-creation-studio-graph-v1";
type Node = { data: { kind: string; title: string; status?: string; outputUrl?: string; error?: string; modelId?: string } };
type Graph = { nodes: Node[]; edges: unknown[]; updatedAt?: string };
type RequestRecord = { startedAt: number; title: string; modelId: string; status?: number; taskId?: string };

async function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

function videoSummary(graph: Graph | null) {
  const videos = graph?.nodes.filter((node) => node.data.kind === "video") || [];
  return {
    total: videos.length,
    succeeded: videos.filter((node) => node.data.status === "succeeded" && node.data.outputUrl).length,
    running: videos.filter((node) => node.data.status === "running" || node.data.status === "queued").length,
    failed: videos.filter((node) => node.data.status === "failed").map((node) => ({ title: node.data.title, error: node.data.error || "" })),
  };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const api = await playwrightRequest.newContext();
  const sessionResponse = await api.get(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await api.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "无法建立验收会话");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  await context.addInitScript((token) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") localStorage.removeItem(key);
    }
    localStorage.setItem("auth_token", token);
  }, session.token);
  const page = await context.newPage();
  const requests: RequestRecord[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/bridge/video/generate") return;
    const body = request.postDataJSON() as { task_label?: string; model_id?: string };
    requests.push({ startedAt: Date.now(), title: body.task_label || "", modelId: body.model_id || "" });
  });
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/bridge/video/generate") return;
    const pending = [...requests].reverse().find((request) => request.status === undefined);
    if (!pending) return;
    pending.status = response.status();
    const body = await response.json().catch(() => ({})) as { task_id?: string };
    pending.taskId = body.task_id;
  });

  try {
    const url = `${baseUrl}/free-canvas?review=${reviewId}&run=${runId}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const videos = graph?.nodes.filter((node) => node.data.kind === "video") || [];
      return videos.length === 8 && videos.filter((node) => node.data.outputUrl).length === 5;
    }, graphKey, { timeout: 30_000 });
    const toggle = page.getByRole("button", { name: "打开制作面板" });
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    const batchButton = page.locator(".free-production-progress button").filter({ hasText: "批量视频" }).first();
    await batchButton.click();

    const startedAt = Date.now();
    let previous = "";
    let final = videoSummary(await readGraph(page));
    while (Date.now() - startedAt < 45 * 60_000) {
      final = videoSummary(await readGraph(page));
      const line = `视频 ${final.succeeded}/${final.total}（运行 ${final.running}，失败 ${final.failed.length}）`;
      if (line !== previous) console.log(`[fallback] ${line}`);
      previous = line;
      const controls = await page.locator(".free-canvas-actions .batch-control").count();
      if (controls === 0 && final.running === 0 && (final.succeeded === 8 || final.failed.length > 0)) break;
      await page.waitForTimeout(5_000);
    }

    assert.equal(requests.length, 3, `备用模型应只提交 3 条，实际 ${requests.length}`);
    assert.ok(requests.every((request) => request.modelId === "grok-imagine-video-1-5-preview-chA"), "失败镜头未全部使用备用模型");
    for (let index = 1; index < requests.length; index += 1) {
      assert.ok(requests[index].startedAt - requests[index - 1].startedAt >= 7_750, "备用视频提交未保持 8 秒间隔");
    }
    assert.equal(final.succeeded, 8, `仍有视频失败：${JSON.stringify(final.failed)}`);

    const finalGraph = await readGraph(page);
    assert.ok(finalGraph);
    finalGraph.updatedAt = new Date().toISOString();
    await writeFile(`public/demo-assets/${reviewId}/graph.json`, `${JSON.stringify(finalGraph, null, 2)}\n`, "utf8");
    await page.screenshot({ path: `${outputDir}/final.png`, fullPage: false });
    const report = { result: "passed", runId, url, completedAt: new Date().toISOString(), final, requests };
    await writeFile(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const failure = { error: error instanceof Error ? error.stack : String(error), final: videoSummary(await readGraph(page)), requests };
    await writeFile(`${outputDir}/failure.json`, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
