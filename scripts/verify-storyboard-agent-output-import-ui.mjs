import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[storyboard-agent-output-import] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[storyboard-agent-output-import] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const baseUrl = process.env.STORYBOARD_BASE_URL || "http://127.0.0.1:5000";
const outputDir = path.resolve(".tmp-e2e/storyboard-agent-output-import");
const narrationOne = "夜雨落在窗沿，女孩把最后一盏灯调暗，安静看着小狗追逐蓝色羽毛，房间只留下温暖呼吸与雨声。";
const narrationTwo = "镜头转向门口，女孩轻轻收起旅行箱，小狗叼着羽毛回头确认她还在，于是慢慢趴下，等待清晨一起出发。";
const source = `
原文案内容段落 1：【${narrationOne}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9电影感故事板，夜雨室内，女孩与小狗保持统一造型，蓝色羽毛作为语义道具。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从故事板第一格裁出的16:9画面开始，0至4秒女孩调暗台灯，4至10秒小狗追逐羽毛；无字幕，无对白口型。
\`\`\`

原文案内容段落 2：【${narrationTwo}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9连续故事板，门口旅行箱、女孩和小狗延续上一段外观与光线，蓝色羽毛仍清晰可见。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从第一格16:9画面开始，0至5秒女孩收起旅行箱，5至10秒小狗叼羽毛回头后趴下；保持场景连续。
\`\`\`
`;
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
const page = await context.newPage();
const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl });
await page.route("**/api/cover-models**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ models: [] }),
}));
await page.route("**/api/video/models**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ models: [] }),
}));
await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: "导入智能体输出", exact: true }).waitFor({ timeout: 30_000 });

await page.evaluate((value) => navigator.clipboard.writeText(value), source);
await page.getByRole("button", { name: "导入智能体输出", exact: true }).click();
await page.locator(".sbw-notice").filter({ hasText: "已自动导入 2 段" }).waitFor();

const cards = page.locator(".sbw-shot-card");
assert.equal(await cards.count(), 2, "整段导入没有自动建立两张卡");
assert.equal(await cards.nth(0).locator("textarea").count(), 2, "卡片仍显示了分段口播输入框");
assert.equal(await cards.nth(1).locator("textarea").count(), 2, "第二张卡的输入区数量不正确");
assert.equal(await page.getByText("分段口播", { exact: true }).count(), 0, "分段口播仍占用工作台界面");
assert.equal(await cards.nth(0).locator(".sbw-card-title strong").textContent(), "镜头 1");
assert.equal(await cards.nth(1).locator(".sbw-card-title strong").textContent(), "镜头 2");

await page.getByRole("button", { name: "保存工程", exact: true }).click();
const saveDeadline = Date.now() + 10_000;
while (!fixture.projectWrites.length && Date.now() < saveDeadline) await page.waitForTimeout(50);
assert.equal(fixture.projectWrites.length, 1, "导入后的工程没有明确保存到账户夹具");
const saved = fixture.latestDocument();
assert.deepEqual(
  saved.cards.map((card) => card.narration.length),
  [narrationOne.length, narrationTwo.length],
  "隐藏口播元数据没有写入工作台历史",
);
assert.match(await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue(), /^生成一张16:9/u);
assert.match(await cards.nth(0).getByRole("textbox", { name: "镜头1视频提示词" }).inputValue(), /^从故事板第一格裁出的16:9/u);

await page.screenshot({ path: path.join(outputDir, "desktop.png"), fullPage: true });

const firstImagePrompt = await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue();
await page.evaluate(() => navigator.clipboard.writeText("这不是完整的智能体输出"));
await page.getByRole("button", { name: "导入智能体输出", exact: true }).click();
await page.locator(".sbw-notice").filter({ hasText: "没有识别到" }).waitFor();
assert.equal(await cards.count(), 2, "错误格式覆盖了当前镜头卡");
assert.equal(await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue(), firstImagePrompt, "错误格式改写了已有 Prompt");
await writeFile(path.join(outputDir, "result.json"), JSON.stringify({
  passed: true,
  cardCount: 2,
  visibleTextareasPerCard: 2,
  hiddenNarrationCharacters: saved.cards.map((card) => card.narration.length),
  malformedImportPreservedCards: true,
  accountProjectWrites: fixture.projectWrites.length,
  realDatabaseWrites: 0,
  providerRequests: 0,
}, null, 2), "utf8");

await closeWithTimeout(context, "context.close");
await closeWithTimeout(browser, "browser.close");
console.log(JSON.stringify({ passed: true, outputDir }, null, 2));
process.exit(0);
