import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const evidenceDir = path.resolve(process.env.STORYBOARD_EVIDENCE_DIR || ".codex-evidence/storyboard-environment-browser");
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) return route.abort("blockedbyclient");
  if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], projects: [], models: [], assets: [], tasks: [] }) });
  if (request.method() !== "GET") return route.abort("blockedbyclient");
  return route.continue();
});
await installStoryboardBrowserFixture(page, { origin: baseUrl, resetStorage: true });

await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
assert.equal(await page.locator(".sbw-shot-card").count(), 3, "默认应为三张分镜卡");
for (const label of ["普通模式", "角色参考", "添加卡片", "历史"]) {
  assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1, `缺少${label}入口`);
}
assert.equal(await page.getByText("保存项目", { exact: true }).count(), 0, "旧保存项目按钮仍显示");

const toolbarGeometry = await page.evaluate(() => {
  const video = document.querySelector(".sbw-control-group.is-video")?.getBoundingClientRect();
  const mode = document.querySelector(".sbw-mode-group")?.getBoundingClientRect();
  const actions = document.querySelector(".sbw-toolbar-actions")?.getBoundingClientRect();
  const history = document.querySelector(".sbw-history-action")?.getBoundingClientRect();
  const grid = document.querySelector(".sbw-shot-grid");
  return {
    videoRight: video?.right || 0,
    modeLeft: mode?.left || 0,
    actionRight: actions?.right || 0,
    historyRight: history?.right || 0,
    columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
  };
});
assert.ok(toolbarGeometry.modeLeft >= toolbarGeometry.videoRight - 2, "模式切换没有紧跟在视频参数之后");
assert.ok(toolbarGeometry.historyRight >= toolbarGeometry.actionRight - 2, "历史入口没有靠工具栏右侧");
assert.equal(toolbarGeometry.columns, 3, `1440宽屏应保持三列，实际${toolbarGeometry.columns}列`);

await page.getByRole("button", { name: "角色参考", exact: true }).click();
await page.getByRole("heading", { name: "第一步 · 角色参考", exact: true }).waitFor({ timeout: 10_000 });
assert.equal(await page.getByText("先准备人物与宠物身份参考；需要时添加场景 / 道具，并按对应分段使用", { exact: true }).count(), 1);
await page.getByRole("button", { name: "普通模式", exact: true }).click();
await page.locator(".sbw-shot-card").first().waitFor();

await page.screenshot({ path: path.join(evidenceDir, "storyboard-workbench-1440-light.png"), fullPage: true });

await page.setViewportSize({ width: 1880, height: 1000 });
const wideColumns = await page.locator(".sbw-shot-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
assert.equal(wideColumns, 3, `1880宽屏应保持三列，实际${wideColumns}列`);
await page.screenshot({ path: path.join(evidenceDir, "storyboard-workbench-1880-light.png"), fullPage: true });
await page.evaluate(() => {
  document.documentElement.setAttribute("data-theme-selection", "lattice");
  document.documentElement.setAttribute("data-theme", "lattice");
  document.documentElement.setAttribute("data-mode", "dark");
});
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(evidenceDir, "storyboard-workbench-1880-dark.png"), fullPage: true });

for (const route of ["/cover", "/video"]) {
  const adjacent = await context.newPage();
  const adjacentErrors = [];
  adjacent.on("pageerror", (error) => adjacentErrors.push(error.message));
  const response = await adjacent.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, `${route} 未返回200`);
  assert.deepEqual(adjacentErrors, [], `${route} 出现页面错误`);
  await adjacent.close();
}
assert.deepEqual(errors, [], "故事板工作台出现页面错误");
console.log(JSON.stringify({ passed: true, defaultCards: 3, columns: { "1440": 3, "1880": wideColumns }, toolbar: toolbarGeometry, adjacentRoutes: ["/cover", "/video"], pageErrors: 0, providerCalls: 0, screenshots: [path.join(evidenceDir, "storyboard-workbench-1440-light.png"), path.join(evidenceDir, "storyboard-workbench-1880-light.png"), path.join(evidenceDir, "storyboard-workbench-1880-dark.png")] }, null, 2));
await context.close();
await browser.close();
