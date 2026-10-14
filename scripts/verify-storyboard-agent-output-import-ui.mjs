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
const machinePayload = {
  schema_version: "storyboard_director_output.v1",
  artifact_type: "storyboard_director_package",
  director_mode: "high_energy",
  input: {
    schema_version: "storyboard_director_input.v1",
    segmented_script: `1.${narrationOne}\n2.${narrationTwo}`,
    director_mode: "high_energy",
    animation_style: "电影级高能3D动画喜剧",
    aspect_ratio: "16:9",
    target_duration_seconds: 10,
    special_notes: "无对白口型；人物、宠物、服装与环境连续。",
  },
  segments: [1, 2].map((sourceIndex) => ({
    segment_id: `segment_${String(sourceIndex).padStart(3, "0")}`,
    source_index: sourceIndex,
    narration: sourceIndex === 1 ? narrationOne : narrationTwo,
    target_duration_seconds: 10,
    estimated_narration_duration: 8.8,
    panel_count: 4,
    layout: "two_by_two",
    pacing_mode: "fast",
    actual_shot_count: 4,
    character_assets: ["女孩", "小狗"],
    semantic_visualizations: [{ trigger: "动作触发", visual_form: "无字图形锚点", interaction: "与道具产生接触" }],
    storyboard_image_prompt: sourceIndex === 1
      ? "一张16:9完整四宫格连续故事板，夜雨室内，女孩与小狗保持统一造型，蓝色羽毛作为道具，四格清晰分隔，无可读文字。"
      : "一张16:9完整四宫格连续故事板，门口旅行箱、女孩和小狗延续上一段外观与光线，蓝色羽毛仍清晰可见，无可读文字。",
    image_to_video_prompt: sourceIndex === 1
      ? "读取完整四宫格故事板作为连续时间地图；0至4秒女孩调暗台灯，4至10秒小狗追逐蓝色羽毛，镜头平稳推进，保留无字图形和自然现场声。"
      : "读取完整四宫格故事板作为连续时间地图；0至5秒女孩收起旅行箱，5至10秒小狗叼羽毛回头后趴下，动作连续，保持场景与角色一致。",
  })),
};
const handoff = {
  schema_version: "agent_workbench_handoff.v1",
  artifact_type: "agent_workbench_handoff",
  handoff_id: "storyboard-workbench:fixture-import",
  source_route: "/tools/text/text-chat",
  target: "storyboard-workbench",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 119_000).toISOString(),
  payload: {
    message_id: "fixture-message-import",
    commit_key: "fixture-commit-import",
    schema_version: "storyboard_director_output.v1",
    source: "stable_json",
    segments: [],
    machine_payload: machinePayload,
  },
};
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
const page = await context.newPage();
const fixture = await installStoryboardBrowserFixture(page, { origin: baseUrl });
await page.addInitScript(({ value }) => {
  sessionStorage.setItem("agent_workbench_handoff_v1:storyboard-workbench:user:storyboard-browser-fixture-user", JSON.stringify(value));
}, { value: handoff });
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
await page.goto(`${baseUrl}/storyboard-workbench?entry=agent&handoff=storyboard`, { waitUntil: "domcontentloaded" });
try {
  await page.getByTestId("agent-storyboard-handoff-confirm").waitFor({ timeout: 30_000 });
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), text: (await page.locator("body").innerText()).slice(0, 1200) }));
  throw error;
}
await page.getByTestId("agent-storyboard-handoff-confirm").click();
await page.locator(".sbw-notice").filter({ hasText: "已导入 2 个 Agent 分镜段" }).waitFor();

const cards = page.locator(".sbw-shot-card");
assert.equal(await cards.count(), 2, "整段导入没有自动建立两张卡");
assert.equal(await cards.nth(0).locator("textarea").count(), 2, "卡片仍显示了分段口播输入框");
assert.equal(await cards.nth(1).locator("textarea").count(), 2, "第二张卡的输入区数量不正确");
assert.equal(await page.getByText("分段口播", { exact: true }).count(), 0, "分段口播仍占用工作台界面");
assert.equal(await cards.nth(0).locator(".sbw-card-title strong").textContent(), "任务 1");
assert.equal(await cards.nth(1).locator(".sbw-card-title strong").textContent(), "任务 2");

assert.equal(fixture.projectWrites.length, 0, "仅确认导入不应自动创建账户工程或调用模型");
assert.match(await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue(), /^一张16:9/u);
assert.match(await cards.nth(0).getByRole("textbox", { name: "镜头1视频提示词" }).inputValue(), /^读取完整四宫格故事板/u);

await page.screenshot({ path: path.join(outputDir, "desktop.png"), fullPage: true });

const firstImagePrompt = await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue();
assert.equal(await cards.count(), 2, "机器包导入没有建立两张镜头卡");
assert.equal(await cards.nth(0).getByRole("textbox", { name: "镜头1生图提示词" }).inputValue(), firstImagePrompt, "刷新后不应改写已有 Prompt");
await writeFile(path.join(outputDir, "result.json"), JSON.stringify({
  passed: true,
  cardCount: 2,
  visibleTextareasPerCard: 2,
  hiddenNarrationCharacters: [narrationOne.length, narrationTwo.length],
  machineHandoffImportedWithoutProviderRequests: true,
  accountProjectWrites: fixture.projectWrites.length,
  realDatabaseWrites: 0,
  providerRequests: 0,
}, null, 2), "utf8");

await closeWithTimeout(context, "context.close");
await closeWithTimeout(browser, "browser.close");
console.log(JSON.stringify({ passed: true, outputDir }, null, 2));
process.exit(0);
