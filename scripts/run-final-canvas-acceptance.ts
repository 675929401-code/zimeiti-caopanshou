import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, request as playwrightRequest, type Download, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const reviewId = process.env.CANVAS_REVIEW_ID || "final-full-flow-v1";
const runId = process.env.CANVAS_RUN_ID || "final-acceptance-20260813-1";
const outputDir = process.env.CANVAS_TEST_OUTPUT_DIR || `.tmp-e2e/${runId}`;
const graphPath = `public/demo-assets/${reviewId}/graph.json`;
const graphKey = "ai-creation-studio-graph-v1";

type MediaKind = "image" | "video";
type GraphNode = {
  id: string;
  data: {
    kind: string;
    title: string;
    assetRole?: string;
    visualOrder?: number;
    semanticOrder?: number;
    status?: string;
    outputUrl?: string;
    error?: string;
    taskId?: string;
    modelId?: string;
    durationSeconds?: number;
  };
};
type Graph = { schemaVersion: number; id: string; name: string; nodes: GraphNode[]; edges: unknown[]; updatedAt?: string };
type RequestRecord = {
  kind: MediaKind;
  startedAt: number;
  title: string;
  modelId: string;
  status?: number;
  taskId?: string;
  responseError?: string;
};
type DownloadRecord = { suggestedFilename: string; path: string; failure?: string; size?: number };

function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

function mediaSummary(graph: Graph | null) {
  const media = graph?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
  const summarize = (kind: MediaKind) => {
    const nodes = media.filter((node) => node.data.kind === kind);
    return {
      total: nodes.length,
      succeeded: nodes.filter((node) => Boolean(node.data.outputUrl) && node.data.status === "succeeded").length,
      running: nodes.filter((node) => node.data.status === "running" || node.data.status === "queued").length,
      failed: nodes.filter((node) => node.data.status === "failed").length,
      pending: nodes.filter((node) => !node.data.outputUrl && !["running", "queued", "failed"].includes(node.data.status || "idle")).length,
      failedNodes: nodes.filter((node) => node.data.status === "failed").map((node) => ({ title: node.data.title, error: node.data.error || "" })),
    };
  };
  return { image: summarize("image"), video: summarize("video") };
}

async function waitForQueueToSettle(page: Page, timeoutMs: number) {
  const startedAt = Date.now();
  let observedRunning = false;
  let lastLine = "";
  while (Date.now() - startedAt < timeoutMs) {
    const graph = await readGraph(page);
    const summary = mediaSummary(graph);
    const controls = await page.locator(".free-canvas-actions .batch-control").count();
    const runAllDisabled = await page.locator(".free-canvas-actions .run-all").isDisabled().catch(() => false);
    observedRunning ||= controls > 0 || runAllDisabled || summary.image.running > 0 || summary.video.running > 0;
    const line = `图片 ${summary.image.succeeded}/${summary.image.total}（运行${summary.image.running} 失败${summary.image.failed} 等待${summary.image.pending}）；视频 ${summary.video.succeeded}/${summary.video.total}（运行${summary.video.running} 失败${summary.video.failed} 等待${summary.video.pending}）`;
    if (line !== lastLine) {
      console.log(`[final-acceptance] ${line}`);
      lastLine = line;
    }
    if (observedRunning && controls === 0 && !runAllDisabled && summary.image.running === 0 && summary.video.running === 0) {
      return summary;
    }
    if (!observedRunning && Date.now() - startedAt >= 10_000) return summary;
    await page.waitForTimeout(3_000);
  }
  throw new Error(`生成队列在 ${Math.round(timeoutMs / 60_000)} 分钟内未收口`);
}

async function openPanel(page: Page) {
  const toggle = page.getByRole("button", { name: "打开制作面板" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function clickStage(page: Page, kind: MediaKind) {
  await openPanel(page);
  const label = kind === "image" ? "批量生图" : "批量视频";
  const button = page.locator(".free-production-progress button").filter({ hasText: label }).first();
  assert.equal(await button.isDisabled(), false, `${label}按钮不可用`);
  await button.click();
}

async function saveDownload(download: Download, downloadDir: string): Promise<DownloadRecord> {
  const suggestedFilename = download.suggestedFilename();
  const target = join(downloadDir, suggestedFilename);
  await download.saveAs(target);
  const failure = await download.failure();
  const details = await stat(target).catch(() => null);
  return { suggestedFilename, path: target, failure: failure || undefined, size: details?.size };
}

async function triggerDownloads(page: Page, selector: string, expected: number, downloadDir: string) {
  const captured: Promise<DownloadRecord>[] = [];
  const handler = (download: Download) => captured.push(saveDownload(download, downloadDir));
  page.on("download", handler);
  try {
    const button = page.locator(selector);
    assert.equal(await button.isDisabled(), false, `${selector} 下载按钮不可用`);
    await button.click();
    await page.waitForFunction((css) => {
      const element = document.querySelector(css) as HTMLButtonElement | null;
      return Boolean(element && !element.disabled);
    }, selector, { timeout: 30 * 60_000 });
    const startedAt = Date.now();
    while (captured.length < expected && Date.now() - startedAt < 60_000) await page.waitForTimeout(250);
    assert.equal(captured.length, expected, `${selector} 应触发 ${expected} 个下载，实际 ${captured.length}`);
    return await Promise.all(captured);
  } finally {
    page.off("download", handler);
  }
}

function assertSubmissionIntervals(records: RequestRecord[], minimumMs: number, label: string) {
  for (let index = 1; index < records.length; index += 1) {
    const interval = records[index].startedAt - records[index - 1].startedAt;
    assert.ok(interval >= minimumMs, `${label}第 ${index} 与第 ${index + 1} 次提交仅间隔 ${interval}ms`);
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const downloadDir = join(outputDir, "downloads");
  await mkdir(downloadDir, { recursive: true });

  const auth = await playwrightRequest.newContext();
  const sessionResponse = await auth.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await auth.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "无法建立本地验收会话");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
  const preserveCanvasState = process.env.CANVAS_PRESERVE_STATE === "1";
  await context.addInitScript(({ token, preserve }) => {
    if (!preserve) {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") localStorage.removeItem(key);
      }
    }
    localStorage.setItem("auth_token", token);
  }, { token: session.token, preserve: preserveCanvasState });

  const balanceBeforeResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const balanceBefore = Number(((await balanceBeforeResponse.json()) as { balance?: number }).balance || 0);
  const requests: RequestRecord[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !["/api/bridge/image/generate", "/api/bridge/video/generate"].includes(path)) return;
    let payload: Record<string, unknown> = {};
    try { payload = request.postDataJSON() as Record<string, unknown>; } catch {}
    requests.push({
      kind: path.includes("/image/") ? "image" : "video",
      startedAt: Date.now(),
      title: String(payload.task_label || payload.prompt || "").slice(0, 100),
      modelId: String(payload.model_id || payload.modelId || ""),
    });
  });
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== "POST" || !["/api/bridge/image/generate", "/api/bridge/video/generate"].includes(path)) return;
    const pending = [...requests].reverse().find((record) => record.kind === (path.includes("/image/") ? "image" : "video") && record.status === undefined);
    if (!pending) return;
    pending.status = response.status();
    try {
      const body = await response.json() as { task_id?: string; error?: string };
      pending.taskId = body.task_id;
      pending.responseError = body.error;
    } catch {}
  });

  try {
    const url = `${baseUrl}/free-canvas?review=${encodeURIComponent(reviewId)}&run=${encodeURIComponent(runId)}`;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const media = graph?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
      return media.length === 18 && media.every((node) => node.id.startsWith("final-v1:") && !node.data.outputUrl);
    }, graphKey, { timeout: 30_000 });
    await page.screenshot({ path: join(outputDir, "01-before-generation.png") });

    console.log("[final-acceptance] 点击页面‘全部生成’");
    await page.locator(".free-canvas-actions .run-all").click();
    let summary = await waitForQueueToSettle(page, 60 * 60_000);

    for (let attempt = 1; attempt <= 2 && summary.image.succeeded < summary.image.total; attempt += 1) {
      console.log(`[final-acceptance] 使用页面‘批量生图’续跑未完成图片，第 ${attempt} 次`);
      await clickStage(page, "image");
      summary = await waitForQueueToSettle(page, 30 * 60_000);
    }
    assert.equal(summary.image.succeeded, summary.image.total, `图片未全部成功：${JSON.stringify(summary.image.failedNodes)}`);
    await page.screenshot({ path: join(outputDir, "02-images-complete.png") });

    for (let attempt = 1; attempt <= 4 && summary.video.succeeded < summary.video.total; attempt += 1) {
      console.log(`[final-acceptance] 使用页面‘批量视频’继续查询/续跑，第 ${attempt} 次`);
      await clickStage(page, "video");
      summary = await waitForQueueToSettle(page, 30 * 60_000);
    }
    assert.equal(summary.video.succeeded, summary.video.total, `视频未全部成功：${JSON.stringify(summary.video.failedNodes)}`);

    const completedGraph = await readGraph(page);
    assert.ok(completedGraph, "完成后画布数据不存在");
    const imageRequests = requests.filter((record) => record.kind === "image");
    const videoRequests = requests.filter((record) => record.kind === "video");
    assert.equal(imageRequests.length, 10, `应提交 10 张图片，实际 ${imageRequests.length}`);
    assert.equal(videoRequests.length, 8, `应提交 8 条视频，实际 ${videoRequests.length}`);
    assert.ok(imageRequests.every((record) => record.status && record.status >= 200 && record.status < 300), "存在图片提交 HTTP 失败");
    assert.ok(videoRequests.every((record) => record.status && record.status >= 200 && record.status < 300 && record.taskId), "存在视频提交失败或缺少任务号");
    assertSubmissionIntervals(imageRequests, 4_750, "图片");
    assertSubmissionIntervals(videoRequests, 7_750, "视频");

    const paidRequestCount = requests.length;
    console.log("[final-acceptance] 完成后再次点击全部生成、批量生图、批量视频，检查不会重复提交");
    await page.locator(".free-canvas-actions .run-all").click();
    await waitForQueueToSettle(page, 10 * 60_000);
    await clickStage(page, "image");
    await waitForQueueToSettle(page, 10 * 60_000);
    await clickStage(page, "video");
    await waitForQueueToSettle(page, 10 * 60_000);
    assert.equal(requests.length, paidRequestCount, "已完成节点被重复提交并可能重复扣费");

    const historyRecord = await page.evaluate(({ review, run }) => {
      const history = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<Record<string, unknown>>;
      return history.find((record) => record.id === `test-snapshot:${review}:${run}`) || null;
    }, { review: reviewId, run: runId });
    assert.ok(historyRecord, "最终验收画布没有存入生成记录");
    const historyNodes = (historyRecord.nodes || []) as GraphNode[];
    assert.equal(historyNodes.filter((node) => node.data.kind === "image" && node.data.outputUrl).length, 10, "历史记录未保存全部图片");
    assert.equal(historyNodes.filter((node) => node.data.kind === "video" && node.data.outputUrl).length, 8, "历史记录未保存全部视频");

    console.log("[final-acceptance] 开始真实批量下载并核对文件名");
    const imageDownloads = await triggerDownloads(page, ".free-canvas-actions .image-download", 10, downloadDir);
    const videoDownloads = await triggerDownloads(page, ".free-canvas-actions .video-download", 9, downloadDir);
    assert.ok([...imageDownloads, ...videoDownloads].every((item) => !item.failure && (item.size || 0) > 0), "存在下载失败或空文件");

    const imageNames = imageDownloads.map((item) => item.suggestedFilename);
    const videoNames = videoDownloads.map((item) => item.suggestedFilename);
    for (let order = 1; order <= 8; order += 1) {
      const prefix = `分镜${String(order).padStart(2, "0")}`;
      assert.ok(imageNames.some((name) => name.startsWith(`${prefix}-关键帧.`)), `缺少 ${prefix} 关键帧下载`);
      assert.ok(videoNames.some((name) => name.startsWith(`${prefix}-视频.`)), `缺少 ${prefix} 视频下载`);
    }
    assert.ok(videoNames.includes("分镜口播文案对照.txt"), "缺少分镜口播文案对照 TXT");
    assert.equal(new Set(imageNames).size, imageNames.length, "图片下载文件名重复");
    assert.equal(new Set(videoNames).size, videoNames.length, "视频下载文件名重复");
    const manifestPath = videoDownloads.find((item) => item.suggestedFilename === "分镜口播文案对照.txt")?.path;
    assert.ok(manifestPath, "无法定位口播文案 TXT");
    const manifest = await readFile(manifestPath, "utf8");
    const manifestOrders = [...manifest.matchAll(/分镜(\d{2})/gu)].map((match) => match[1]);
    assert.deepEqual(manifestOrders, ["01", "02", "03", "04", "05", "06", "07", "08"], "TXT 分镜顺序不正确");

    const balanceAfterResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const balanceAfter = Number(((await balanceAfterResponse.json()) as { balance?: number }).balance || 0);
    completedGraph.updatedAt = new Date().toISOString();
    await writeFile(graphPath, `${JSON.stringify(completedGraph, null, 2)}\n`, "utf8");
    await context.storageState({ path: join(outputDir, "storage-state.json") });
    await page.screenshot({ path: join(outputDir, "03-final-complete.png") });

    const report = {
      runId,
      reviewId,
      url,
      completedAt: new Date().toISOString(),
      result: "passed",
      balanceBefore,
      balanceAfter,
      charged: Number((balanceBefore - balanceAfter).toFixed(2)),
      summary,
      requests: requests.map((record) => ({ ...record, startedAt: new Date(record.startedAt).toISOString() })),
      imageSubmissionIntervalsMs: imageRequests.slice(1).map((record, index) => record.startedAt - imageRequests[index].startedAt),
      videoSubmissionIntervalsMs: videoRequests.slice(1).map((record, index) => record.startedAt - videoRequests[index].startedAt),
      downloads: { images: imageDownloads, videosAndTxt: videoDownloads },
      history: { saved: true, images: 10, videos: 8 },
      pageErrors,
      consoleErrors,
      graphPath,
    };
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const graph = await readGraph(page).catch(() => null);
    await writeFile(join(outputDir, "failure.json"), `${JSON.stringify({
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack || error.message : String(error),
      summary: mediaSummary(graph),
      requests,
      pageErrors,
      consoleErrors,
    }, null, 2)}\n`, "utf8");
    await page.screenshot({ path: join(outputDir, "failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
