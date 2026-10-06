import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium, request as playwrightRequest, type Download, type Page } from "playwright";

const baseUrl = "http://127.0.0.1:5000";
const reviewId = "final-full-flow-v1";
const runId = process.env.CANVAS_RUN_ID || "final-download-20260813-1";
const outputDir = `.tmp-e2e/${runId}`;
const downloadsDir = join(outputDir, "downloads");
const graphKey = "ai-creation-studio-graph-v1";
type Node = { data: { kind: string; title: string; status?: string; outputUrl?: string } };
type Graph = { nodes: Node[] };
type RequestRecord = { method: string; path: string; startedAt: number };
type DownloadRecord = { name: string; path: string; size: number; failure: string | null };

async function readGraph(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null") as Graph | null, graphKey);
}

async function waitUntilIdle(page: Page, timeoutMs = 120_000) {
  await page.waitForFunction(() => {
    const runAll = document.querySelector(".free-canvas-actions .run-all") as HTMLButtonElement | null;
    return Boolean(runAll && !runAll.disabled && !document.querySelector(".free-canvas-actions .batch-control"));
  }, undefined, { timeout: timeoutMs });
}

async function openPanel(page: Page) {
  const toggle = page.getByRole("button", { name: "打开制作面板" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function collectDownloads(page: Page, selector: string, expected: number) {
  const records: Promise<DownloadRecord>[] = [];
  const handler = (download: Download) => records.push((async () => {
    const name = download.suggestedFilename();
    const path = join(downloadsDir, name);
    await download.saveAs(path);
    return { name, path, size: (await stat(path)).size, failure: await download.failure() };
  })());
  page.on("download", handler);
  try {
    const button = page.locator(selector);
    await button.click();
    await page.waitForFunction((css) => !((document.querySelector(css) as HTMLButtonElement | null)?.disabled), selector, { timeout: 30 * 60_000 });
    const startedAt = Date.now();
    while (records.length < expected && Date.now() - startedAt < 90_000) await page.waitForTimeout(250);
    assert.equal(records.length, expected, `下载数量不正确，应为 ${expected}，实际 ${records.length}`);
    return Promise.all(records);
  } finally {
    page.off("download", handler);
  }
}

async function main() {
  await mkdir(downloadsDir, { recursive: true });
  const api = await playwrightRequest.newContext();
  const sessionResponse = await api.get(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await api.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "无法建立验收会话");

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
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/bridge/image/generate" || path === "/api/bridge/video/generate")) {
      requests.push({ method: request.method(), path, startedAt: Date.now() });
    }
  });

  try {
    const url = `${baseUrl}/free-canvas?review=${reviewId}&run=${runId}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as Graph | null;
      const images = graph?.nodes.filter((node) => node.data.kind === "image" && node.data.outputUrl) || [];
      const videos = graph?.nodes.filter((node) => node.data.kind === "video" && node.data.outputUrl) || [];
      return images.length === 10 && videos.length === 8;
    }, graphKey, { timeout: 30_000 });
    await waitUntilIdle(page);

    await page.locator(".free-canvas-actions .run-all").click();
    await waitUntilIdle(page);
    await openPanel(page);
    await page.locator(".free-production-progress button").filter({ hasText: "批量生图" }).first().click();
    await waitUntilIdle(page);
    await openPanel(page);
    await page.locator(".free-production-progress button").filter({ hasText: "批量视频" }).first().click();
    await waitUntilIdle(page);
    assert.equal(requests.length, 0, `完成后重复点击仍产生 ${requests.length} 次生成提交`);

    await page.waitForTimeout(1_000);
    const history = await page.evaluate(({ review, run }) => {
      const records = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<{ id: string; status?: string; nodes?: Node[] }>;
      return records.find((record) => record.id === `test-snapshot:${review}:${run}`) || null;
    }, { review: reviewId, run: runId });
    assert.ok(history, "当前验收画布没有写入生成记录");
    assert.equal(history.nodes?.filter((node) => node.data.kind === "image" && node.data.outputUrl).length, 10, "生成记录缺少图片");
    assert.equal(history.nodes?.filter((node) => node.data.kind === "video" && node.data.outputUrl).length, 8, "生成记录缺少视频");

    const imageFiles = await collectDownloads(page, ".free-canvas-actions .image-download", 10);
    const videoFiles = await collectDownloads(page, ".free-canvas-actions .video-download", 9);
    const allFiles = [...imageFiles, ...videoFiles];
    assert.ok(allFiles.every((file) => !file.failure && file.size > 0), "存在空文件或失败下载");
    assert.equal(new Set(allFiles.map((file) => file.name)).size, 19, "下载文件存在重名覆盖");

    const imageNames = imageFiles.map((file) => file.name);
    const videoNames = videoFiles.map((file) => file.name);
    assert.ok(imageNames.some((name) => name.startsWith("角色01")), "缺少角色01定妆图");
    assert.ok(imageNames.some((name) => name.startsWith("角色02")), "缺少角色02定妆图");
    for (let index = 1; index <= 8; index += 1) {
      const prefix = `分镜${String(index).padStart(2, "0")}`;
      assert.ok(imageNames.includes(`${prefix}-关键帧.png`) || imageNames.some((name) => name.startsWith(`${prefix}-关键帧.`)), `缺少 ${prefix} 参考图`);
      assert.ok(videoNames.some((name) => name.startsWith(`${prefix}-视频.`)), `缺少 ${prefix} 视频`);
    }
    assert.ok(videoNames.includes("分镜口播文案对照.txt"), "缺少分镜口播文案 TXT");
    const manifest = videoFiles.find((file) => file.name === "分镜口播文案对照.txt");
    assert.ok(manifest);
    const text = await readFile(manifest.path, "utf8");
    assert.deepEqual([...text.matchAll(/分镜(\d{2})/gu)].map((match) => match[1]), ["01", "02", "03", "04", "05", "06", "07", "08"]);

    const finalGraph = await readGraph(page);
    assert.ok(finalGraph);
    await page.screenshot({ path: join(outputDir, "final.png"), fullPage: false });
    const report = {
      result: "passed",
      runId,
      url,
      completedAt: new Date().toISOString(),
      duplicateSubmissions: requests.length,
      history: { saved: true, status: history.status, images: 10, videos: 8 },
      imageFiles: imageFiles.map((file) => ({ name: file.name, size: file.size })),
      videoFiles: videoFiles.map((file) => ({ name: file.name, size: file.size })),
      downloadedBytes: allFiles.reduce((total, file) => total + file.size, 0),
      downloadDirectory: basename(downloadsDir),
    };
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(join(outputDir, "failure.json"), `${JSON.stringify({ error: error instanceof Error ? error.stack : String(error), requests }, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
