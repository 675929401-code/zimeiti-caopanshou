import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const evidenceDir = path.resolve(".codex-evidence", "production-readiness-20260823", "final-runtime", "canvas");
const reportPath = path.join(evidenceDir, "canvas-runtime-readonly.json");
const graphKey = "ai-creation-studio-graph-v1";
const scopedGraphKeyPrefix = `${graphKey}:scope:`;

type CanvasGraph = {
  nodes?: Array<{ id?: string; data?: { kind?: string; title?: string } }>;
  edges?: Array<{ id?: string; source?: string; target?: string }>;
};

type ShowcaseResult = {
  id: string;
  previewPath: string;
  previewNodes: number;
  previewEdges: number;
  videoElements: number;
  audioElements: number;
  listViewNodes: number;
  zoomBefore: number;
  zoomAfter: number;
  copiedPath: string;
  copiedNodes: number;
  copiedEdges: number;
  renderedNodes: number;
};

async function installReadonlyGuard(context: BrowserContext, blockedWrites: string[]): Promise<void> {
  await context.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      blockedWrites.push(`${method} ${new URL(request.url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function openPreview(page: Page, showcaseId: string): Promise<void> {
  const previewPath = `/youcai/share/canvas/${encodeURIComponent(showcaseId)}`;
  const response = await page.goto(`${baseUrl}${previewPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, `${previewPath} 应返回 200`);
  assert.equal(new URL(page.url()).pathname, previewPath, `${previewPath} 不应发生跳转`);
  await page.locator('section[aria-label="只读工作流画布"]').waitFor({ state: "visible", timeout: 30_000 });
}

async function copyShowcase(page: Page, expectedNodes: number, expectedEdges: number): Promise<CanvasGraph> {
  await page.getByRole("button", { name: "复制并继续创作" }).click();
  await page.waitForURL((url) => url.pathname === "/youcai/free-canvas", { timeout: 30_000 });
  await page.waitForFunction(
    ({ keyPrefix, nodes, edges }) => {
      const scopedKey = Object.keys(localStorage).find((key) => key.startsWith(keyPrefix));
      const graph = JSON.parse(scopedKey ? localStorage.getItem(scopedKey) || "null" : "null") as CanvasGraph | null;
      return graph?.nodes?.length === nodes && graph?.edges?.length === edges;
    },
    { keyPrefix: scopedGraphKeyPrefix, nodes: expectedNodes, edges: expectedEdges },
    { timeout: 30_000 },
  );
  await page.locator(".free-node-shell").first().waitFor({ state: "attached", timeout: 30_000 });
  return page.evaluate((keyPrefix) => {
    const scopedKey = Object.keys(localStorage).find((key) => key.startsWith(keyPrefix));
    return JSON.parse(scopedKey ? localStorage.getItem(scopedKey) || "null" : "null") as CanvasGraph;
  }, scopedGraphKeyPrefix);
}

async function verifyDesktopShowcase(
  browserContext: BrowserContext,
  showcase: (typeof CANVAS_SHARE_SHOWCASES)[number],
  index: number,
  pageErrors: string[],
): Promise<ShowcaseResult> {
  const page = await browserContext.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${showcase.id}: ${error.message}`));
  await openPreview(page, showcase.id);

  const previewCanvas = page.locator('section[aria-label="只读工作流画布"]');
  const previewNodes = await previewCanvas.locator("article[data-node-id]").count();
  assert.equal(previewNodes, showcase.nodes.length, `${showcase.id} 必须展示全部节点正文`);
  assert.equal(
    await previewCanvas.locator("article[data-node-id] > p").count(),
    showcase.nodes.length,
    `${showcase.id} 每个只读节点都必须展示正文`,
  );
  assert.match(
    await page.locator("aside").filter({ hasText: "条连线" }).innerText(),
    new RegExp(`${showcase.nodes.length} 个节点 · ${showcase.edges.length} 条连线`, "u"),
  );

  const expectedVideos = showcase.nodes.filter((node) => node.kind === "video").length;
  const expectedAudios = showcase.nodes.filter((node) => node.kind === "audio" || node.kind === "music").length;
  const videoElements = await page.locator("video").count();
  const audioElements = await page.locator("audio").count();
  assert.equal(videoElements, expectedVideos, `${showcase.id} 视频节点必须渲染为 video`);
  assert.equal(audioElements, expectedAudios, `${showcase.id} 音频/音乐节点必须渲染为 audio`);

  const zoomLocator = page.locator('section[aria-label="只读工作流画布"] span').filter({ hasText: /^\d+%$/u });
  const zoomBefore = Number.parseInt((await zoomLocator.innerText()).replace("%", ""), 10);
  await page.getByRole("button", { name: "放大" }).click();
  const zoomAfter = Number.parseInt((await zoomLocator.innerText()).replace("%", ""), 10);
  assert.equal(zoomAfter > zoomBefore, true, `${showcase.id} 放大按钮应改变缩放比例`);
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "适配视图" }).click();

  await page.getByRole("button", { name: "列表视图" }).click();
  const list = page.locator('section[aria-label="只读工作流列表"]');
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const listViewNodes = await list.locator("article[data-node-id]").count();
  assert.equal(listViewNodes, showcase.nodes.length, `${showcase.id} 列表视图不得丢节点`);
  assert.equal(
    await list.locator("article[data-node-id] > p").count(),
    showcase.nodes.length,
    `${showcase.id} 列表视图必须保留全部节点正文`,
  );
  await page.getByRole("button", { name: "画布视图" }).click();

  if (index === 0) {
    await page.screenshot({ path: path.join(evidenceDir, "paper-fox-preview.png"), fullPage: false });
  }

  const graph = await copyShowcase(page, showcase.nodes.length, showcase.edges.length);
  const renderedNodes = await page.locator(".free-node-shell").count();
  assert.equal(renderedNodes, showcase.nodes.length, `${showcase.id} 复制后必须渲染全部节点`);
  assert.match(
    await page.locator(".flow-count").innerText(),
    new RegExp(`${showcase.nodes.length} 节点 · ${showcase.edges.length} 连线`, "u"),
  );

  if (index === 0) {
    await page.screenshot({ path: path.join(evidenceDir, "paper-fox-copied-manual-canvas.png"), fullPage: false });
  }

  const result: ShowcaseResult = {
    id: showcase.id,
    previewPath: `/youcai/share/canvas/${showcase.id}`,
    previewNodes,
    previewEdges: showcase.edges.length,
    videoElements,
    audioElements,
    listViewNodes,
    zoomBefore,
    zoomAfter,
    copiedPath: new URL(page.url()).pathname,
    copiedNodes: graph.nodes?.length ?? 0,
    copiedEdges: graph.edges?.length ?? 0,
    renderedNodes,
  };
  await page.close();
  return result;
}

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const blockedWrites: string[] = [];
  const pageErrors: string[] = [];
  const results: ShowcaseResult[] = [];
  let mobileOverflow = -1;

  try {
    for (let index = 0; index < CANVAS_SHARE_SHOWCASES.length; index += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await installReadonlyGuard(context, blockedWrites);
      results.push(await verifyDesktopShowcase(context, CANVAS_SHARE_SHOWCASES[index], index, pageErrors));
      await context.close();
    }

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await installReadonlyGuard(mobileContext, blockedWrites);
    const mobilePage = await mobileContext.newPage();
    mobilePage.on("pageerror", (error) => pageErrors.push(`mobile: ${error.message}`));
    await openPreview(mobilePage, CANVAS_SHARE_SHOWCASES[0].id);
    mobileOverflow = await mobilePage.evaluate(() => Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ));
    assert.equal(mobileOverflow <= 2, true, `手机端文档横向溢出 ${mobileOverflow}px`);
    await mobilePage.getByRole("button", { name: "列表视图" }).click();
    assert.equal(
      await mobilePage.locator('section[aria-label="只读工作流列表"] article[data-node-id]').count(),
      CANVAS_SHARE_SHOWCASES[0].nodes.length,
    );
    await mobilePage.screenshot({ path: path.join(evidenceDir, "paper-fox-mobile-list.png"), fullPage: false });
    await mobileContext.close();

    assert.deepEqual(blockedWrites, [], "只读 Canvas 验收期间页面不得尝试写 API");
    assert.deepEqual(pageErrors, [], "Canvas 预览与复制不得产生页面脚本错误");

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      baseUrl,
      showcaseCount: results.length,
      results,
      mobileOverflow,
      blockedWrites,
      pageErrors,
      providerRequests: 0,
      paidGenerationRequests: 0,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, reportPath, showcaseCount: results.length, mobileOverflow }, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch(async (error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ ok: false, generatedAt: new Date().toISOString(), message }, null, 2)}\n`, "utf8");
  console.error(error);
  process.exitCode = 1;
});
