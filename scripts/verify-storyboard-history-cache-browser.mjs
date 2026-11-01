import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const evidenceDir = path.resolve(process.env.STORYBOARD_EVIDENCE_DIR || ".codex-evidence/storyboard-history-cache-browser");
await mkdir(evidenceDir, { recursive: true });

// Minimal ISO-BMFF header accepted by the cache contract. The browser never
// sends this fixture to a provider; it only exercises the complete-byte path.
const videoBytes = Buffer.from("000000186674797069736f6d0000020066726565000000086d646174", "hex");
const posterSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0b1220"/><circle cx="160" cy="90" r="38" fill="#54e3d2"/></svg>';
const taskId = "cache-task-001";
const historyTask = {
  id: taskId,
  taskIdExternal: taskId,
  taskLabel: "缓存验收分镜",
  modelName: "Fixture Video",
  status: "completed",
  createdAt: "2026-10-18T03:00:00.000Z",
  completedAt: "2026-10-18T03:00:16.000Z",
  durationSeconds: 16,
  thumbnailUrl: "/fixture-poster.svg",
  videoUrl: "/api/video/proxy?media_ticket=fixture-playback",
  batchId: "fixture-batch",
  batchTopic: "本机副本优先",
  cardIndex: 0,
  billingState: "not_required",
  priceCharged: 0,
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const requests = [];
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => {
  if (request.url().includes("/api/video/")) requests.push({ method: request.method(), url: request.url() });
});
await installStoryboardBrowserFixture(page, { origin: baseUrl, resetStorage: true });
await page.route("**/fixture-poster.svg", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: posterSvg }));
await page.route("**/api/video/history**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [historyTask] }) }));
await page.route("**/api/video/access-ticket**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "/api/video/proxy?media_ticket=fixture-playback" }) }));
await page.route("**/api/video/proxy-download**", route => route.fulfill({ status: 200, contentType: "video/mp4", headers: { "content-length": String(videoBytes.length) }, body: videoBytes }));
await page.route("**/api/video/proxy**", route => route.fulfill({ status: 200, contentType: "video/mp4", headers: { "content-length": String(videoBytes.length) }, body: videoBytes }));

await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
await page.getByRole("button", { name: "历史", exact: true }).click();
await page.locator("[data-video-history-task='cache-task-001']").waitFor({ timeout: 30_000 });
const card = page.locator("[data-video-history-task='cache-task-001']");
assert.match(await card.innerText(), /上游链接可播放/u, "初始历史项没有显示在线可播放状态");
await card.getByRole("button", { name: "保存本机副本", exact: true }).click();
await card.getByText("本机副本可用", { exact: true }).waitFor({ timeout: 30_000 });
assert.equal(await card.getAttribute("data-local-available"), "true", "完整字节校验后未标记本机副本可用");

await card.getByRole("button", { name: /播放本机副本优先/u }).click();
await page.locator(".sbh-video").waitFor({ timeout: 30_000 });
assert.match(await page.locator(".sbh-video").getAttribute("src"), /^blob:/u, "首次预览没有优先使用本机 Blob");
await page.getByRole("button", { name: "关闭视频预览", exact: true }).click();

// Remove online ticket routes. A second preview must still work from the
// account-scoped local copy without asking for a new upstream URL.
await page.unroute("**/api/video/access-ticket**");
await page.unroute("**/api/video/proxy**");
await card.getByRole("button", { name: /播放本机副本优先/u }).click();
await page.locator(".sbh-video").waitFor({ timeout: 30_000 });
assert.match(await page.locator(".sbh-video").getAttribute("src"), /^blob:/u, "上游失效后未从本机副本恢复播放");
assert.equal(errors.length, 0, `浏览器出现 pageerror: ${errors.join("；")}`);

const report = {
  passed: true,
  taskId,
  localAvailable: await card.getAttribute("data-local-available"),
  previewSource: await page.locator(".sbh-video").getAttribute("src"),
  providerCalls: 0,
  businessWrites: 0,
  historyRequests: requests.filter(item => item.url.includes("/api/video/history")).length,
  accessTicketRequests: requests.filter(item => item.url.includes("/api/video/access-ticket")).length,
  errors,
};
await page.screenshot({ path: path.join(evidenceDir, "history-cache-offline-preview.png"), fullPage: true });
await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
await context.close();
await browser.close();
console.log(JSON.stringify(report, null, 2));
