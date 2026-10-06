import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";
import { OFFICIAL_INSPIRATION_ITEMS } from "../src/features/official-inspiration/inspiration-data";
import { getOfficialToolAlias } from "../src/features/official-tool-aliases/official-tool-alias-map";
import { TOOL_CATEGORIES } from "../src/features/official-tool-directory/tool-directory-data";

const baseUrl = process.env.YOUCAI_BASE_URL || "http://127.0.0.1:5000";
const outputDir = join(process.cwd(), ".codex-artifacts", "20260824-youcai-benchmark");
const showcaseId = "canvas-showcase-78f7a4a9ce11-paper-fox-adventure";
const showcaseContracts = [
  { id: showcaseId, nodes: 13, edges: 17, images: 3, videos: 3, audios: 2, plannedVideos: 0 },
  { id: "cmsyrsury01e3caezkqyg5l5l", nodes: 78, edges: 71, images: 67, videos: 2, audios: 1, plannedVideos: 0 },
  { id: "cmsyrvsqh01jgcaez3xadrsob", nodes: 139, edges: 148, images: 106, videos: 11, audios: 3, plannedVideos: 0 },
  { id: "cmt37buny005u85fyne9adfac", nodes: 85, edges: 14, images: 28, videos: 0, audios: 0, plannedVideos: 54 },
] as const;

async function open(page: Page, pathname: string) {
  const response = await page.goto(`${baseUrl}${pathname}`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, `${pathname} should return HTTP 200`);
  await page.waitForTimeout(450);
}

async function assertNoDocumentOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.content <= dimensions.viewport + 2,
    `${label} document overflow: ${dimensions.content}px > ${dimensions.viewport}px`,
  );
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const adminToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || "";
  assert.ok(adminToken, "local administrator session is required");
  const authResponse = await fetch(baseUrl + "/api/auth/me", {
    headers: { Authorization: "Bearer " + adminToken },
    signal: AbortSignal.timeout(10_000),
  });
  const auth = await authResponse.json();
  assert.ok(authResponse.ok && auth.user?.role === "admin", "local administrator session must be readable");

  const availableToolPaths = Object.values(TOOL_CATEGORIES)
    .flatMap((category) => category.tools)
    .filter((tool) => tool.availability === "available" && tool.officialPath)
    .map((tool) => tool.officialPath!);
  assert.ok(availableToolPaths.length >= 30, `public available tool routes regressed below the verified 30-route baseline: ${availableToolPaths.length}`);
  const toolResponses = await Promise.all(availableToolPaths.map(async (officialPath) => {
    const [, category, tool] = officialPath.split("/").slice(1);
    const directPage = existsSync(join(process.cwd(), "src", "app", "youcai", officialPath, "page.tsx"));
    assert.ok(directPage || getOfficialToolAlias(category, tool), `${officialPath} has no independent route definition`);
    const response = await fetch(`${baseUrl}/youcai${officialPath}`);
    const html = await response.text();
    return { officialPath, status: response.status, bytes: Buffer.byteLength(html) };
  }));
  assert.deepEqual(toolResponses.filter((result) => result.status !== 200), []);
  assert.deepEqual(toolResponses.filter((result) => result.bytes < 10_000), []);

  assert.equal(CANVAS_SHARE_SHOWCASES.length, 4);
  for (const [index, showcase] of CANVAS_SHARE_SHOWCASES.entries()) {
    const contract = showcaseContracts[index];
    assert.equal(showcase.id, contract.id);
    assert.equal(showcase.nodes.length, contract.nodes, `${showcase.id} node count drifted from the official snapshot`);
    assert.equal(showcase.edges.length, contract.edges, `${showcase.id} edge count drifted from the official snapshot`);
    assert.equal(showcase.nodes.filter((node) => node.kind === "image").length, contract.images);
    assert.equal(showcase.nodes.filter((node) => node.kind === "video" && node.mediaPath).length, contract.videos);
    assert.equal(showcase.nodes.filter((node) => (node.kind === "audio" || node.kind === "music") && node.mediaPath).length, contract.audios);
    assert.equal(showcase.nodes.filter((node) => node.kind === "video-plan" && !node.mediaPath).length, contract.plannedVideos);
    for (const node of showcase.nodes) {
      for (const mediaPath of [node.imagePath, node.mediaPath, node.posterPath].filter(Boolean) as string[]) {
        assert.ok(existsSync(join(process.cwd(), "public", mediaPath)), `${mediaPath} is missing`);
      }
    }
    const response = await fetch(`${baseUrl}/youcai/tools/canvas/workspace/${encodeURIComponent(showcase.id)}`);
    assert.equal(response.status, 200);
  }

  const completeInspirationItems = OFFICIAL_INSPIRATION_ITEMS.filter((item) => (
    item.availability !== "planned" && (item.mediaType === "图片" || Boolean(item.mediaPath))
  ));
  assert.ok(completeInspirationItems.length >= 36, "the complete inspiration catalog should not regress below the original 36 items");
  for (const item of completeInspirationItems) {
    assert.ok(existsSync(join(process.cwd(), "public", item.imagePath)), `${item.imagePath} is missing`);
    if (item.mediaPath) assert.ok(existsSync(join(process.cwd(), "public", item.mediaPath)), `${item.mediaPath} is missing`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await context.addCookies([{ name: "auth_token", value: adminToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
    }, { token: adminToken, user: auth.user });
    await context.route("**/*", async (route) => {
      if (["GET", "HEAD"].includes(route.request().method())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const desktop = await context.newPage();

    await open(desktop, "/youcai/tools");
    assert.equal(await desktop.getByRole("heading", { name: "创作中心" }).count(), 1);
    await assertNoDocumentOverflow(desktop, "creation center desktop");

    await open(desktop, "/youcai/tools/video");
    assert.equal(
      await desktop.locator('a[href="/youcai/tools/video/kling-video"]').count(),
      1,
      "Kling card must stay inside the independent creation center route",
    );
    assert.equal(
      await desktop.locator("article h3").first().evaluate((element) => getComputedStyle(element).color),
      "rgb(23, 32, 51)",
      "tool card titles need dark readable text on white cards",
    );
    await assertNoDocumentOverflow(desktop, "video creation center desktop");
    await desktop.screenshot({ path: join(outputDir, "01-tools-desktop.png"), fullPage: false });

    await open(desktop, "/youcai/tools/video/kling-video");
    assert.equal(await desktop.getByTestId("youcai-independent-tool-workspace").count(), 1);
    assert.equal(await desktop.getByText("独立工作区", { exact: true }).count(), 1);
    await assertNoDocumentOverflow(desktop, "independent video tool desktop");
    await desktop.screenshot({ path: join(outputDir, "01b-video-tool-desktop.png"), fullPage: false });

    await open(desktop, "/youcai/tools/film-studio");
    const dramaHref = await desktop.getByTestId("film-entry-drama-script").getAttribute("href");
    assert.equal(dramaHref, "/youcai/tools/film-studio/create/drama-script");
    assert.equal(
      await desktop.getByTestId("film-entry-general-script").getAttribute("href"),
      "/youcai/tools/film-studio/create/general-script",
    );
    assert.equal(
      await desktop.getByTestId("film-entry-upload-script").getAttribute("href"),
      "/youcai/tools/film-studio/create/upload-script",
    );
    await assertNoDocumentOverflow(desktop, "film studio desktop");
    await desktop.screenshot({ path: join(outputDir, "02-film-studio-desktop.png"), fullPage: false });

    await open(desktop, "/youcai/tools/film-studio/create/drama-script");
    assert.equal(await desktop.getByTestId("film-studio-sidebar").count(), 1, "drama creation page must have one route shell");
    assert.equal(await desktop.getByTestId("youcai-drama-script-wizard").count(), 1);
    const dramaStylePicker = desktop.getByTestId("video-style-picker");
    assert.equal(await dramaStylePicker.count(), 1);
    assert.equal(await dramaStylePicker.locator("optgroup").count(), 3);
    assert.equal(await dramaStylePicker.locator("optgroup option").count(), 39);
    await desktop.getByTestId("youcai-drama-script-next").waitFor();
    await desktop.screenshot({ path: join(outputDir, "02c-drama-create-first-step-desktop.png"), fullPage: false });

    await open(desktop, "/youcai/tools/film-studio/create/general-script");
    assert.equal(await desktop.getByTestId("film-studio-sidebar").count(), 1, "general script page must have one route shell");
    await desktop.getByTestId("youcai-general-script").waitFor();
    assert.equal(await desktop.getByTestId("youcai-general-script").count(), 1);
    assert.equal(await desktop.getByTestId("video-style-picker").locator("optgroup option").count(), 39);

    await open(desktop, "/youcai/tools/film-studio/create/upload-script");
    assert.equal(await desktop.getByTestId("film-studio-sidebar").count(), 1, "upload script page must have one route shell");
    await desktop.getByTestId("youcai-upload-script").waitFor();
    assert.equal(await desktop.getByTestId("youcai-upload-script").count(), 1);
    assert.equal(await desktop.getByTestId("video-style-picker").locator("optgroup option").count(), 39);

    const canvasContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await canvasContext.route("**/*", async (route) => {
      if (["GET", "HEAD"].includes(route.request().method())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const canvasPage = await canvasContext.newPage();

    await open(canvasPage, "/youcai/tools/canvas");
    await canvasPage.locator("a[data-showcase-id]").first().waitFor();
    assert.equal(await canvasPage.locator("a[data-showcase-id]").count(), showcaseContracts.length);
    for (const contract of showcaseContracts) {
      const card = canvasPage.locator('a[data-showcase-id="' + contract.id + '"]');
      assert.equal(await card.count(), 1, contract.id + " must have exactly one showcase card");
      assert.equal(await card.getAttribute("data-cover-media-type"), "image");
      assert.equal(await card.locator("img").count(), 1, contract.id + " must render its current official image cover type");
    }
    await canvasPage.screenshot({ path: join(outputDir, "02b-canvas-cards-desktop.png"), fullPage: false });

    for (const [index, contract] of showcaseContracts.entries()) {
      await open(canvasPage, "/youcai/share/canvas/" + contract.id);
      await canvasPage.locator('[data-canvas-shell="showcase-preview"]').waitFor();
      assert.equal(
        await canvasPage.locator("[data-node-id]").count(),
        contract.nodes,
        contract.id + " should expose every public preview node",
      );
      assert.equal(await canvasPage.getByText("AI 自由画布", { exact: true }).count(), 0);
      assert.equal(await canvasPage.getByText("只读预览 · 复制后可编辑", { exact: true }).count(), 1);
      const zoomText = (await canvasPage.getByRole("button", { name: "缩小" }).locator("..").locator("span").first().textContent()) || "";
      assert.match(zoomText, /^\d+%$/u);
      assert.ok(Number.parseInt(zoomText, 10) >= 5 && Number.parseInt(zoomText, 10) <= 125);
      await canvasPage.getByRole("button", { name: "复制并继续创作" }).click();
      await canvasPage.waitForURL(new RegExp("/youcai/free-canvas\\?showcase=" + contract.id + "$", "u"));
      const importedShell = canvasPage.locator('main[data-canvas-shell="free-canvas"][data-imported-showcase-id="' + contract.id + '"]');
      await importedShell.waitFor();
      await canvasPage.locator(".react-flow__node").first().waitFor({ timeout: 10_000 });
      assert.equal(await canvasPage.locator("[data-canvas-shell]").count(), 1, "copy flow must replace the preview shell instead of nesting another canvas");
      assert.equal(await canvasPage.locator(".react-flow__node").count(), contract.nodes, contract.id + " must import exactly one complete node graph");
      assert.match((await importedShell.getAttribute("data-storage-scope")) || "", /^anonymous-/u);
      await canvasPage.getByText(/登录后可保存到账号|当前画布可在本地编辑/u).first().waitFor();
      await canvasPage.screenshot({ path: join(outputDir, "03-" + (index + 1) + "-canvas-workspace-desktop.png"), fullPage: false });
    }
    await canvasContext.close();
    await open(desktop, "/youcai/inspiration");
    const inspirationSelector = 'section[aria-label="灵感作品列表"] article';
    const inspirationCards = desktop.locator(inspirationSelector);
    await inspirationCards.first().waitFor();
    assert.equal(await inspirationCards.count(), Math.min(36, completeInspirationItems.length), "gallery should keep the first render bounded");
    for (let attempt = 0; attempt < 10 && await inspirationCards.count() < completeInspirationItems.length; attempt += 1) {
      const before = await inspirationCards.count();
      const loadMore = desktop.getByRole("button", { name: /继续加载瀑布流/u });
      await loadMore.click();
      await desktop.waitForFunction(
        ({ selector, previous }) => document.querySelectorAll(selector).length > previous,
        { selector: inspirationSelector, previous: before },
      );
    }
    assert.equal(await inspirationCards.count(), completeInspirationItems.length, "gallery should expose every complete item after progressive loading");
    assert.equal(await desktop.locator('[data-planned="true"]').count(), 0);
    await assertNoDocumentOverflow(desktop, "inspiration desktop");
    await desktop.screenshot({ path: join(outputDir, "04-inspiration-desktop.png"), fullPage: false });

    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await open(mobile, "/youcai/tools");
    await assertNoDocumentOverflow(mobile, "creation center mobile");
    await mobile.screenshot({ path: join(outputDir, "05-tools-mobile.png"), fullPage: false });

    await open(mobile, `/youcai/share/canvas/${showcaseId}`);
    assert.equal(await mobile.locator("[data-node-id]").count(), 13);
    assert.equal(await mobile.locator("[data-canvas-shell]").count(), 1);
    await assertNoDocumentOverflow(mobile, "canvas preview mobile");
    await mobile.screenshot({ path: join(outputDir, "06-canvas-workspace-mobile.png"), fullPage: false });

    console.log(JSON.stringify({
      ok: true,
      outputDir,
      checks: {
        creationCenterIndependentRoute: true,
        filmStudioSourceAwareEntries: true,
        isolatedAnonymousCanvasCopyHandoff: true,
        copiedShowcaseNodes: showcaseContracts.map((contract) => contract.nodes),
        completeInspirationItems: completeInspirationItems.length,
        availableCreationTools: toolResponses.length,
        completeCanvasShowcases: CANVAS_SHARE_SHOWCASES.length,
        desktopAndMobileOverflow: "passed",
      },
    }, null, 2));
  } finally {
    await browser.close();
  }
}

void main();
