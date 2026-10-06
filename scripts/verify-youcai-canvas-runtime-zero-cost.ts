import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const buildIdPath = path.resolve(".next", "BUILD_ID");
const evidenceDir = path.resolve(process.env.VERIFY_EVIDENCE_DIR || ".codex-evidence/delivery-20260826/canvas-runtime");

type RouteProbe = {
  path: string;
  status: number | null;
};

type PreviewProbe = {
  id: string;
  expectedNodes: number;
  expectedEdges: number;
  status: number | null;
  previewShells: number;
  freeCanvasShells: number;
  nodes: number;
  media: {
    videos: number;
    audios: number;
    honestPlaceholders: number;
  };
  singleCopyButton: boolean;
  duplicateFooterButtonCount: number;
  listNodes: number;
  zoomChanged: boolean;
  viewport: {
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
    horizontalScrollChanged: boolean;
    verticalScrollChanged: boolean;
  };
  document: {
    clientHeight: number;
    scrollHeight: number;
    bodyOverflowPixels: number;
  };
  copied: {
    path: string;
    queryShowcase: string | null;
    previewShells: number;
    freeCanvasShells: number;
    importedShowcaseId: string | null;
    renderedNodes: number;
    importNoticeFound: boolean;
    replayHandoffKeys: string[];
    transientModalText: string;
    transientModalDismissed: boolean;
    minimap: { count: number; width: number; height: number; bounded: boolean };
    edgeStroke: { maxPx: number; thickEdgeCount: number; giantDiagonalCount: number };
    interaction: {
      zoomChanged: boolean;
      panChanged: boolean;
      fitRestored: boolean;
      textEdited: boolean;
      nodeDragged: boolean;
    };
    screenshot: string;
  };
  screenshot: string;
  aligned: boolean;
};

async function screenshot(page: Page, name: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const target = path.join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

async function installZeroCostGuard(context: BrowserContext, blockedWrites: string[]): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const method = route.request().method().toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const url = new URL(route.request().url());
      blockedWrites.push(`${method} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function goto(page: Page, pathname: string): Promise<RouteProbe> {
  const response = await page.goto(`${baseUrl}${pathname}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  return { path: new URL(page.url()).pathname, status: response?.status() ?? null };
}

async function textCount(page: Page, exactText: string): Promise<number> {
  return page.getByText(exactText, { exact: true }).count();
}

async function probePreview(page: Page, id: string): Promise<PreviewProbe> {
  const showcase = CANVAS_SHARE_SHOWCASES.find((item) => item.id === id);
  if (!showcase) throw new Error(`Unknown showcase: ${id}`);

  const pathname = `/youcai/share/canvas/${encodeURIComponent(id)}`;
  const navigation = await goto(page, pathname);
  const shell = page.locator('[data-canvas-shell="showcase-preview"]');
  await shell.first().waitFor({ state: "visible", timeout: 30_000 });

  const currentPreviewShell = shell.first();
  const canvas = currentPreviewShell.locator('section[aria-label="只读工作流画布"]');
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  const previewShells = await shell.count();
  const freeCanvasShells = await page.locator('[data-canvas-shell="free-canvas"]').count();
  const nodes = await canvas.locator("[data-node-id]").count();
  const videos = await canvas.locator("video").count();
  const audios = await canvas.locator("audio").count();
  const renderedNodeText = await canvas.locator("[data-node-id]").evaluateAll((elements) => Object.fromEntries(
    elements.map((element) => [element.getAttribute("data-node-id") || "", element.textContent || ""]),
  ));
  const placeholderNodes = showcase.nodes.filter((node) => {
    const missingImage = node.kind === "image" && !node.imagePath;
    const missingPlayable = ["video", "video-plan", "audio", "music", "audio-plan"].includes(node.kind)
      && !node.mediaPath;
    return missingImage || missingPlayable;
  });
  const honestPlaceholders = placeholderNodes.filter((node) => (
    renderedNodeText[node.id]?.includes(node.toolLabel || "创作方案")
  )).length;
  const singleCopyButton = (await page.getByRole("button", { name: "复制并继续创作" }).count()) === 1;
  const duplicateFooterButtonCount = await textCount(page, "进入创作画布");

  const viewport = await canvas.evaluate((element) => {
    const beforeLeft = element.scrollLeft;
    const beforeTop = element.scrollTop;
    element.scrollTo({ left: Math.min(240, Math.max(0, element.scrollWidth - element.clientWidth)), top: Math.min(240, Math.max(0, element.scrollHeight - element.clientHeight)), behavior: "auto" });
    const result = {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      horizontalScrollChanged: element.scrollLeft !== beforeLeft,
      verticalScrollChanged: element.scrollTop !== beforeTop,
    };
    element.scrollTo({ left: beforeLeft, top: beforeTop, behavior: "auto" });
    return result;
  });

  const documentProbe = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    bodyOverflowPixels: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
  }));

  const zoom = canvas.locator("span").filter({ hasText: /^\d+%$/u });
  const zoomBefore = await zoom.first().innerText();
  await page.getByRole("button", { name: "放大" }).click();
  const zoomAfter = await zoom.first().innerText();
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "适配视图" }).click();

  await page.getByRole("button", { name: "列表视图" }).click();
  const list = page.locator('section[aria-label="只读工作流列表"]');
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const listNodes = await list.locator("article[data-node-id]").count();
  await page.getByRole("button", { name: "画布视图" }).click();
  await canvas.waitFor({ state: "visible", timeout: 10_000 });
  const previewScreenshot = await screenshot(page, `02-preview-${id}`);

  await page.getByRole("button", { name: "复制并继续创作" }).click();
  await page.waitForURL((url) => url.pathname === "/youcai/free-canvas", { timeout: 30_000 });
  const freeShell = page.locator('[data-canvas-shell="free-canvas"]');
  await freeShell.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1_200);
  const copiedUrl = new URL(page.url());
  const importNotice = `已导入 ${showcase.nodes.length} 个可编辑节点和 ${showcase.edges.length} 条连线，本次未触发生成或扣费；登录后可保存到账号`;
  const importNoticeFound = (await page.getByText(importNotice, { exact: true }).count()) === 1;
  const replayHandoffKeys = await page.evaluate(() => Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith("official_inspiration_canvas_reference_v1:showcase:"))
    .sort());
  const modalBackdrop = page.locator(".modal-backdrop:visible").first();
  const transientModalText = await modalBackdrop.count() ? (await modalBackdrop.innerText()).trim() : "";
  // Compatibility field: the verifier never closes or hides the modal. A true
  // value means no blocking modal appeared in the anonymous editing flow.
  const transientModalDismissed = (await page.locator(".modal-backdrop:visible").count()) === 0;
  const flow = page.locator(".react-flow").first();
  await flow.waitFor({ state: "visible", timeout: 15_000 });
  const flowBox = await flow.boundingBox();
  const minimapBox = await page.locator(".react-flow__minimap").first().boundingBox();
  const minimap = {
    count: await page.locator(".react-flow__minimap").count(),
    width: Math.round(minimapBox?.width || 0),
    height: Math.round(minimapBox?.height || 0),
    bounded: Boolean(minimapBox && minimapBox.width <= 260 && minimapBox.height <= 180),
  };
  const edgeStroke = await page.locator(".react-flow__edge-path").evaluateAll((elements, flowRect) => {
    const strokes = elements.map((element) => Number.parseFloat(getComputedStyle(element).strokeWidth || "0") || 0);
    const giantDiagonalCount = elements.filter((element) => {
      if (!flowRect) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > flowRect.width * 1.25 || rect.height > flowRect.height * 1.25;
    }).length;
    return {
      maxPx: Math.max(0, ...strokes),
      thickEdgeCount: strokes.filter((stroke) => stroke > 2).length,
      giantDiagonalCount,
    };
  }, flowBox);
  let textEdited = false;
  let nodeDragged = false;
  if (transientModalDismissed) {
    const promptEditor = flow.locator(".free-node-shell textarea").first();
    if (await promptEditor.count()) {
      const marker = "[zero-cost-local-edit]";
      const original = await promptEditor.inputValue();
      await promptEditor.fill(`${original}\n${marker}`.trim());
      textEdited = (await promptEditor.inputValue()).includes(marker);
    }
    const firstNode = flow.locator(".react-flow__node").first();
    const dragHandle = firstNode.locator(".workflow-node-head").first();
    const dragBox = await dragHandle.boundingBox();
    const nodeTransformBefore = await firstNode.getAttribute("style");
    if (dragBox) {
      const startX = dragBox.x + Math.min(80, dragBox.width / 2);
      const startY = dragBox.y + dragBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 56, startY + 32, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(220);
      nodeDragged = (await firstNode.getAttribute("style")) !== nodeTransformBefore;
    }
  }
  const viewportTransform = page.locator(".react-flow__viewport").first();
  const fitButton = page.locator('.react-flow__controls-button[title="fit view"], .react-flow__controls-fitview').first();
  const zoomInButton = page.locator('.react-flow__controls-button[title="zoom in"], .react-flow__controls-zoomin').first();
  const transformBefore = await viewportTransform.getAttribute("style");
  if (await zoomInButton.count()) await zoomInButton.click();
  await page.waitForTimeout(220);
  const transformAfterZoom = await viewportTransform.getAttribute("style");
  if (await fitButton.count()) await fitButton.click();
  await page.waitForTimeout(260);
  const transformAfterFit = await viewportTransform.getAttribute("style");
  let panChanged = false;
  const paneBox = await page.locator(".react-flow__pane").first().boundingBox();
  if (paneBox) {
    const startX = paneBox.x + paneBox.width * 0.82;
    const startY = paneBox.y + paneBox.height * 0.78;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 72, startY - 48, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(220);
    panChanged = (await viewportTransform.getAttribute("style")) !== transformAfterFit;
  }
  if (await fitButton.count()) await fitButton.click();
  await page.waitForTimeout(260);
  const transformRestored = await viewportTransform.getAttribute("style");
  const interaction = {
    zoomChanged: transformAfterZoom !== transformBefore,
    panChanged,
    fitRestored: Boolean(transformRestored && transformRestored !== transformAfterZoom),
    textEdited,
    nodeDragged,
  };
  const copiedScreenshot = await screenshot(page, `03-free-canvas-${id}`);
  const copied = {
    path: copiedUrl.pathname,
    queryShowcase: copiedUrl.searchParams.get("showcase"),
    previewShells: await page.locator('[data-canvas-shell="showcase-preview"]').count(),
    freeCanvasShells: await freeShell.count(),
    importedShowcaseId: await freeShell.getAttribute("data-imported-showcase-id"),
    renderedNodes: await page.locator(".free-node-shell").count(),
    importNoticeFound,
    replayHandoffKeys,
    transientModalText,
    transientModalDismissed,
    minimap,
    edgeStroke,
    interaction,
    screenshot: copiedScreenshot,
  };

  const expectedVideoCount = showcase.nodes.filter((node) => node.kind === "video" && Boolean(node.mediaPath)).length;
  const expectedAudioCount = showcase.nodes.filter((node) => (
    (node.kind === "audio" || node.kind === "music") && Boolean(node.mediaPath)
  )).length;
  const aligned = navigation.status === 200
    && navigation.path === pathname
    && previewShells === 1
    && freeCanvasShells === 0
    && nodes === showcase.nodes.length
    && videos === expectedVideoCount
    && audios === expectedAudioCount
    && honestPlaceholders === placeholderNodes.length
    && singleCopyButton
    && duplicateFooterButtonCount === 0
    && listNodes === showcase.nodes.length
    && zoomBefore !== zoomAfter
    && copied.path === "/youcai/free-canvas"
    && copied.queryShowcase === id
    && copied.previewShells === 0
    && copied.freeCanvasShells === 1
    && copied.importedShowcaseId === id
    && copied.renderedNodes === showcase.nodes.length
    && copied.importNoticeFound
    && copied.replayHandoffKeys.includes(`official_inspiration_canvas_reference_v1:showcase:${encodeURIComponent(id)}`)
    && copied.transientModalDismissed
    && copied.transientModalText === ""
    && copied.minimap.count === 1
    && copied.minimap.bounded
    && copied.edgeStroke.thickEdgeCount === 0
    && copied.edgeStroke.giantDiagonalCount === 0
    && copied.interaction.zoomChanged
    && copied.interaction.panChanged
    && copied.interaction.fitRestored
    && copied.interaction.textEdited
    && copied.interaction.nodeDragged;

  return {
    id,
    expectedNodes: showcase.nodes.length,
    expectedEdges: showcase.edges.length,
    status: navigation.status,
    previewShells,
    freeCanvasShells,
    nodes,
    media: { videos, audios, honestPlaceholders },
    singleCopyButton,
    duplicateFooterButtonCount,
    listNodes,
    zoomChanged: zoomBefore !== zoomAfter,
    viewport,
    document: documentProbe,
    copied,
    screenshot: previewScreenshot,
    aligned,
  };
}

async function main(): Promise<void> {
  const buildId = (await readFile(buildIdPath, "utf8")).trim();
  const browser = await chromium.launch({ headless: true });
  const blockedWrites: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installZeroCostGuard(context, blockedWrites);

  const observePage = (page: Page) => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        const request = response.request();
        const url = new URL(response.url());
        failedResponses.push(`${request.method()} ${url.pathname}${url.search} -> ${response.status()}`);
      }
    });
  };

  try {
    const landingPage = await context.newPage();
    observePage(landingPage);
    await goto(landingPage, "/youcai/tools/canvas");
    await landingPage.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    const landing = await goto(landingPage, "/youcai/tools/canvas");
    const cardLinks: Record<string, number> = Object.fromEntries(await Promise.all(
      CANVAS_SHARE_SHOWCASES.map(async (showcase) => [
        showcase.id,
        await landingPage.locator(`a[href="/youcai/share/canvas/${showcase.id}"]`).count(),
      ] as const),
    ));
    const landingProbe = {
      ...landing,
      bannerVideos: await landingPage.locator('[aria-label="无限画布工作流动态演示"] video').count(),
      eagerBannerSources: await landingPage.locator('[aria-label="无限画布工作流动态演示"] video source').count(),
      bannerPlayControls: await landingPage.getByRole("button", { name: "播放画布创作演示" }).count(),
      exactPublicCopy: (await textCount(landingPage, "查看完整创作流程，复制后即可继续编辑和创作。")) === 1,
      cardLinks,
      screenshot: await screenshot(landingPage, "01-canvas-landing"),
    };
    await landingPage.close();

    const previews: PreviewProbe[] = [];
    for (const showcase of CANVAS_SHARE_SHOWCASES) {
      const previewPage = await context.newPage();
      observePage(previewPage);
      try {
        previews.push(await probePreview(previewPage, showcase.id));
      } finally {
        await previewPage.close();
      }
    }

    const landingAligned = landingProbe.status === 200
      && landingProbe.path === "/youcai/tools/canvas"
      && landingProbe.bannerVideos === 1
      && landingProbe.eagerBannerSources === 0
      && landingProbe.bannerPlayControls === 1
      && landingProbe.exactPublicCopy
      && Object.values(landingProbe.cardLinks).every((count) => count >= 1);
    const sourceActivated = landingAligned
      && previews.every((probe) => probe.aligned)
      && blockedWrites.length === 0
      && pageErrors.length === 0
      && failedResponses.length === 0;

    const report = {
      ok: sourceActivated,
      testMode: "fresh no-login browser; GET/HEAD/OPTIONS only; all writes blocked",
      generatedAt: new Date().toISOString(),
      baseUrl,
      buildId,
      landing: landingProbe,
      previews,
      blockedWrites,
      pageErrors,
      consoleErrors,
      failedResponses,
      modelRequests: 0,
      mediaGenerationRequests: 0,
      paidGenerationRequests: 0,
      sourceActivated,
    };
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "canvas-runtime-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!sourceActivated) process.exitCode = 2;
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
