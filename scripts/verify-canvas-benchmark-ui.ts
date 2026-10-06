import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const screenshotDirectory = ".tmp-e2e";
const sampleScript = [
  "\u7b2c\u56db\u5929\uff0c\u4e3b\u4eba\u7ec8\u4e8e\u56de\u5230\u5bb6\u3002",
  "\u72d7\u72d7\u5148\u6123\u5728\u95e8\u8fb9\uff0c\u968f\u540e\u51b2\u8fc7\u53bb\u62b1\u4f4f\u4ed6\uff0c\u5c3e\u5df4\u4e0d\u505c\u6447\u52a8\u3002",
  "\u5b83\u6ca1\u6709\u5f00\u53e3\uff0c\u5374\u628a\u56db\u5929\u7684\u7b49\u5f85\u90fd\u5199\u5728\u773c\u795e\u91cc\u3002",
].join("");

function watchPage(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  return { pageErrors, consoleErrors };
}

async function openProPanel(page: Page) {
  const toggle = page.locator(".free-canvas-actions button[aria-pressed]");
  await toggle.waitFor({ state: "visible" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function assertViewportFits(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `page overflows horizontally: ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`,
  );
}

async function main() {
  await mkdir(screenshotDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") {
          localStorage.removeItem(key);
        }
      }
    });
    const page = await context.newPage();
    const diagnostics = watchPage(page);
    const response = await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `free canvas returned ${response?.status()}`);
    await page.locator(".free-canvas-workspace").waitFor({ state: "visible" });
    await openProPanel(page);

    const modelSelects = page.locator(".free-global-models select");
    assert.equal(await modelSelects.count(), 3, "global image, resolution, and video controls must be present");
    const imageModelText = await modelSelects.nth(0).locator("option:checked").innerText();
    const videoOption = modelSelects.nth(2).locator("option:checked");
    const videoModelText = await videoOption.innerText();
    assert.match(imageModelText, /gpt/i, "the highest-quality GPT image model must be selected by default");
    assert.equal(await videoOption.isDisabled(), false, "the selected video model must support the reference-image workflow");

    const productionGrid = page.locator(".free-pro-section .free-template-grid").first();
    await productionGrid.locator("button").first().click();
    const importer = page.locator(".free-script-importer");
    await importer.waitFor({ state: "visible" });
    await importer.locator("textarea").first().fill(sampleScript);
    const compileButton = importer.locator(":scope > button").last();
    const compileResponsePromise = page.waitForResponse((candidate) => (
      candidate.url().endsWith("/api/canvas/compile-script") && candidate.request().method() === "POST"
    ));
    await compileButton.click();
    const compileResponse = await compileResponsePromise;
    const compiled = await compileResponse.json() as {
      compiler: "ai" | "deterministic-fallback";
      semanticSegments: Array<{ visualShotCount: number }>;
      shots: Array<{ visualOrder: number }>;
    };

    const expectedNodeCount = 4 + compiled.semanticSegments.length + compiled.shots.length * 3;
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".react-flow__node").length >= expected,
      expectedNodeCount,
      { timeout: 30_000 },
    );
    await page.waitForFunction(() => /规则预览|完成AI语义拆镜/u.test(document.querySelector(".free-page-notice")?.textContent || ""));
    const noticeClass = await page.locator(".free-page-notice").getAttribute("class") || "";
    assert.equal(
      compiled.compiler === "ai" ? noticeClass.includes("is-positive") : noticeClass.includes("is-warning"),
      true,
      "AI completion must be positive and deterministic fallback must be a warning",
    );
    const nodeTexts = await page.locator(".react-flow__node").allTextContents();
    const narrationCount = nodeTexts.filter((text) => /\u53e3\u64ad\u6bb5\d+\s*\u00b7\s*\d+\u4e2a\u89c6\u89c9\u955c\u5934/u.test(text)).length;
    const imageCount = nodeTexts.filter((text) => /\u955c\u5934\d{2}\s*\u00b7\s*\u81ea\u52a8\u5173\u952e\u5e27/u.test(text)).length;
    const videoNodeTexts = nodeTexts.filter((text) => /\u955c\u5934\d{2}\s*\u00b7\s*\u5173\u952e\u5e27\u751f\u6210\u89c6\u9891/u.test(text));
    const videoCount = videoNodeTexts.length;
    const visualOrders = new Set(nodeTexts.flatMap((text) => [...text.matchAll(/\u955c\u5934(\d{2})/gu)].map((match) => match[1])));
    await openProPanel(page);
    const statTexts = await page.locator(".free-stat-grid span").allTextContents();
    const readStat = (label: string) => {
      const text = statTexts.find((value) => value.includes(label));
      assert.ok(text, `missing ${label} stat`);
      return Number(text.match(/\d+/)?.[0] || 0);
    };
    const semanticSegments = readStat("\u53e3\u64ad\u6bb5");
    const visualShots = readStat("\u89c6\u89c9\u955c\u5934");
    assert.equal(semanticSegments, compiled.semanticSegments.length, "canvas narration stats must match the compiler response");
    assert.equal(visualShots, compiled.shots.length, "canvas visual-shot stats must match the compiler response");
    assert.ok(narrationCount >= 1, "at least one semantic narration node must be visible");
    assert.ok(semanticSegments >= 2, "the script must compile into multiple semantic narration segments");
    assert.ok(visualShots > semanticSegments, "at least one narration segment must expand into multiple visual shots");
    assert.ok(imageCount >= visualOrders.size, "every visual shot must have a reference-image node");
    assert.ok(videoCount >= visualOrders.size, "every visual shot must have a video node");

    const stats = await page.locator(".free-stat-grid").innerText();
    assert.match(stats, /\u53e3\u64ad\u6bb5/u);
    assert.match(stats, /\u89c6\u89c9\u955c\u5934/u);
    const history = await page.locator(".free-run-history-list").innerText();
    assert.match(history, /\d{1,2}\.\d{1,2} \d{2}:\d{2}/, "history must use compact M.D HH:mm timestamps");
    assert.doesNotMatch(history, /\d{4}[/-]\d{1,2}[/-]\d{1,2}/, "history must not show a full year timestamp");

    await page.locator(".free-canvas-actions button[aria-pressed]").click();
    const firstVideoNode = page.locator(".react-flow__node").filter({ hasText: /\u955c\u593401\s*\u00b7\s*\u5173\u952e\u5e27\u751f\u6210\u89c6\u9891/u }).first();
    await firstVideoNode.locator(".workflow-node-head").dispatchEvent("click");
    await firstVideoNode.locator(".free-node-shell.selected").waitFor({ state: "attached" });
    await firstVideoNode.locator(".free-protocol-note").last().waitFor({ state: "visible" });
    const expandedVideoText = await firstVideoNode.textContent() || "";
    assert.match(expandedVideoText, /\u76ee\u6807\s*\d+(?:\.\d+)?s/u, "the video node must show its target edit duration");
    assert.match(expandedVideoText, /\u6a21\u578b\u751f\u6210\s*\d+(?:\.\d+)?s/u, "the video node must show its submitted model duration");
    assert.doesNotMatch(expandedVideoText, /\u5f53\u524d\u6a21\u578b\u6700\u591a/u, "the default model must support the planned shot duration");
    assert.doesNotMatch(expandedVideoText, /\u989d\u5916\u65f6\u957f\u4f1a\u589e\u52a0\u6d88\u8017/u, "the default storyboard model must not require paid-duration trimming");
    await openProPanel(page);

    await assertViewportFits(page);
    await page.screenshot({ path: `${screenshotDirectory}/free-canvas-benchmark-desktop.png`, fullPage: true });
    assert.deepEqual(diagnostics.pageErrors, [], `desktop page errors: ${diagnostics.pageErrors.join(" | ")}`);

    const regressionPage = await context.newPage();
    const regressionDiagnostics = watchPage(regressionPage);
    for (const pathname of ["/video", "/voice-studio/workspace"]) {
      const check = await regressionPage.goto(`${baseUrl}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.ok(check?.ok(), `${pathname} returned ${check?.status()}`);
      await regressionPage.waitForTimeout(500);
      assert.ok((await regressionPage.locator("body").innerText()).trim().length > 20, `${pathname} rendered an empty page`);
      await assertViewportFits(regressionPage);
      await regressionPage.screenshot({ path: `${screenshotDirectory}/regression-${pathname.replaceAll("/", "-").replace(/^-/, "")}.png`, fullPage: true });
    }
    assert.deepEqual(regressionDiagnostics.pageErrors, [], `regression page errors: ${regressionDiagnostics.pageErrors.join(" | ")}`);
    await regressionPage.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const mobilePage = await mobileContext.newPage();
    const mobileDiagnostics = watchPage(mobilePage);
    await mobilePage.goto(`${baseUrl}/free-canvas`, { waitUntil: "networkidle", timeout: 60_000 });
    await openProPanel(mobilePage);
    await assertViewportFits(mobilePage);
    assert.equal(await mobilePage.locator(".free-canvas-actions .script-entry span").isHidden(), true, "the long split label must collapse to an icon on mobile");
    const panelBox = await mobilePage.locator(".free-pro-panel").boundingBox();
    assert.ok(panelBox && panelBox.x >= 0 && panelBox.width <= 390, "the Pro panel must fit the mobile viewport");
    await mobilePage.screenshot({ path: `${screenshotDirectory}/free-canvas-benchmark-mobile.png`, fullPage: true });
    assert.deepEqual(mobileDiagnostics.pageErrors, [], `mobile page errors: ${mobileDiagnostics.pageErrors.join(" | ")}`);
    await mobileContext.close();

    console.log(JSON.stringify({
      narrationCount: semanticSegments,
      visualShots,
      imageCount,
      videoCount,
      imageModelText,
      videoModelText,
      consoleErrors: diagnostics.consoleErrors,
      regressionConsoleErrors: regressionDiagnostics.consoleErrors,
    }, null, 2));
    console.log("Canvas benchmark UI verification passed.");
  } finally {
    await browser.close();
  }
}

void main();
