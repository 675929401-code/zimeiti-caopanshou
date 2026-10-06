import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, request as playwrightRequest, type Download, type Page } from "playwright";

const baseUrl = "http://127.0.0.1:5000";
const reviewId = "final-full-flow-v1";
const runId = process.env.CANVAS_RUN_ID || "final-acceptance-20260813-3";
const outputDir = `.tmp-e2e/${runId}`;
const graphKey = "ai-creation-studio-graph-v1";
type Node = { id: string; data: { kind: string; title: string; status?: string; outputUrl?: string; error?: string; taskId?: string; visualOrder?: number } };
type Graph = { name: string; nodes: Node[]; edges: unknown[]; updatedAt?: string };
type RequestRecord = { startedAt: number; title: string; status?: number; taskId?: string };

async function graph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

function summary(value: Graph | null) {
  const media = value?.nodes.filter((node) => node.data.kind === "image" || node.data.kind === "video") || [];
  return Object.fromEntries(["image", "video"].map((kind) => {
    const nodes = media.filter((node) => node.data.kind === kind);
    return [kind, {
      total: nodes.length,
      succeeded: nodes.filter((node) => node.data.status === "succeeded" && node.data.outputUrl).length,
      running: nodes.filter((node) => node.data.status === "running" || node.data.status === "queued").length,
      failed: nodes.filter((node) => node.data.status === "failed").length,
      failures: nodes.filter((node) => node.data.status === "failed").map((node) => ({ title: node.data.title, error: node.data.error || "" })),
    }];
  })) as Record<"image" | "video", { total: number; succeeded: number; running: number; failed: number; failures: Array<{ title: string; error: string }> }>;
}

async function waitForSettle(page: Page, timeoutMs: number) {
  const started = Date.now();
  let observed = false;
  let previous = "";
  while (Date.now() - started < timeoutMs) {
    const result = summary(await graph(page));
    const controls = await page.locator(".free-canvas-actions .batch-control").count();
    observed ||= controls > 0 || result.video.running > 0;
    const line = `图片 ${result.image.succeeded}/${result.image.total}；视频 ${result.video.succeeded}/${result.video.total}（运行${result.video.running} 失败${result.video.failed}）`;
    if (line !== previous) { console.log(`[resume-acceptance] ${line}`); previous = line; }
    if (observed && controls === 0 && result.video.running === 0) return result;
    await page.waitForTimeout(3_000);
  }
  throw new Error("续跑队列未在 40 分钟内收口");
}

async function openPanel(page: Page) {
  const toggle = page.getByRole("button", { name: "打开制作面板" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function downloadAll(page: Page, selector: string, expected: number, dir: string) {
  const records: Promise<{ name: string; path: string; size: number; failure: string | null }>[] = [];
  const handler = (download: Download) => records.push((async () => {
    const name = download.suggestedFilename();
    const path = join(dir, name);
    await download.saveAs(path);
    return { name, path, size: (await stat(path)).size, failure: await download.failure() };
  })());
  page.on("download", handler);
  try {
    await page.locator(selector).click();
    await page.waitForFunction((css) => !((document.querySelector(css) as HTMLButtonElement | null)?.disabled), selector, { timeout: 30 * 60_000 });
    const started = Date.now();
    while (records.length < expected && Date.now() - started < 60_000) await page.waitForTimeout(250);
    assert.equal(records.length, expected, `下载数量错误：应为 ${expected}，实际 ${records.length}`);
    return Promise.all(records);
  } finally { page.off("download", handler); }
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const downloadsDir = join(outputDir, "downloads");
  await mkdir(downloadsDir, { recursive: true });
  const auth = await playwrightRequest.newContext();
  const sessionResponse = await auth.get(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await auth.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "无法建立本地验收会话");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
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
    const body = request.postDataJSON() as { task_label?: string };
    requests.push({ startedAt: Date.now(), title: body.task_label || "" });
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
      const value = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const videos = value?.nodes.filter((node) => node.data.kind === "video") || [];
      return videos.length === 8 && videos.filter((node) => node.data.outputUrl).length === 4;
    }, graphKey, { timeout: 30_000 });
    let current = summary(await graph(page));
    assert.equal(current.image.succeeded, 8, "恢复样本应包含 8 张分镜参考图");
    assert.equal(current.video.succeeded, 4, "恢复样本应包含 4 条成功视频");
    await openPanel(page);
    const button = page.locator(".free-production-progress button").filter({ hasText: "批量视频" }).first();
    await button.click();
    current = await waitForSettle(page, 40 * 60_000);
    assert.equal(current.video.succeeded, 8, `续跑后仍未全部成功：${JSON.stringify(current.video.failures)}`);
    assert.equal(requests.length, 4, `应只重试 4 条失败视频，实际提交 ${requests.length}`);
    for (let index = 1; index < requests.length; index += 1) assert.ok(requests[index].startedAt - requests[index - 1].startedAt >= 7_750, "视频重试未保持 8 秒提交间隔");

    const beforeNoop = requests.length;
    await page.locator(".free-canvas-actions .run-all").click();
    await waitForSettle(page, 10 * 60_000);
    await openPanel(page);
    await page.locator(".free-production-progress button").filter({ hasText: "批量生图" }).first().click();
    await waitForSettle(page, 10 * 60_000);
    await openPanel(page);
    await page.locator(".free-production-progress button").filter({ hasText: "批量视频" }).first().click();
    await waitForSettle(page, 10 * 60_000);
    assert.equal(requests.length, beforeNoop, "完成后再次点击产生了重复视频提交");

    await page.waitForTimeout(1_000);
    const history = await page.evaluate(({ review, run }) => {
      const records = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<{ id: string; nodes?: Node[] }>;
      return records.find((record) => record.id === `test-snapshot:${review}:${run}`) || null;
    }, { review: reviewId, run: runId });
    assert.ok(history, "验收画布未写入历史记录");
    assert.equal(history.nodes?.filter((node) => node.data.kind === "video" && node.data.outputUrl).length, 8, "历史记录缺少视频结果");

    const imageFiles = await downloadAll(page, ".free-canvas-actions .image-download", 8, downloadsDir);
    const videoFiles = await downloadAll(page, ".free-canvas-actions .video-download", 9, downloadsDir);
    assert.ok([...imageFiles, ...videoFiles].every((file) => !file.failure && file.size > 0), "下载存在空文件或失败");
    const imageNames = imageFiles.map((file) => file.name);
    const videoNames = videoFiles.map((file) => file.name);
    for (let index = 1; index <= 8; index += 1) {
      const prefix = `分镜${String(index).padStart(2, "0")}`;
      assert.ok(imageNames.some((name) => name.startsWith(`${prefix}-关键帧.`)), `缺少 ${prefix} 关键帧`);
      assert.ok(videoNames.some((name) => name.startsWith(`${prefix}-视频.`)), `缺少 ${prefix} 视频`);
    }
    assert.ok(videoNames.includes("分镜口播文案对照.txt"), "缺少口播文案 TXT");
    const txtPath = videoFiles.find((file) => file.name === "分镜口播文案对照.txt")?.path;
    assert.ok(txtPath);
    const txt = await readFile(txtPath, "utf8");
    assert.deepEqual([...txt.matchAll(/分镜(\d{2})/gu)].map((match) => match[1]), ["01", "02", "03", "04", "05", "06", "07", "08"]);

    const finalGraph = await graph(page);
    assert.ok(finalGraph);
    finalGraph.updatedAt = new Date().toISOString();
    await writeFile(`public/demo-assets/${reviewId}/graph.json`, `${JSON.stringify(finalGraph, null, 2)}\n`, "utf8");
    await context.storageState({ path: join(outputDir, "storage-state.json") });
    await page.screenshot({ path: join(outputDir, "final.png") });
    const report = { runId, url, result: "passed", completedAt: new Date().toISOString(), summary: current, requests, imageFiles, videoFiles, historySaved: true };
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(join(outputDir, "failure.json"), `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error), summary: summary(await graph(page)), requests }, null, 2)}\n`, "utf8");
    throw error;
  } finally { await context.close(); await browser.close(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
