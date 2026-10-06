import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentNames = [
  "故事版导演｜高能夸张",
  "故事版导演｜电影叙事",
  "故事版导演｜抒情情感",
];
const expectedStyles = [
  "高能商业3D动画喜剧（皮克斯式）",
  "童话电影3D动画（迪士尼式）",
  "欧美反差3D动画喜剧（梦工厂式）",
  "高饱和萌宠3D动画喜剧（照明娱乐式）",
  "温暖家庭3D动画电影",
  "电影级半写实3D动画",
  "手工黏土定格质感3D动画",
  "Q版玩具模型3D动画",
  "东方国潮3D动画电影",
  "未来科技霓虹3D动画",
];

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const responses = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("response", (response) => {
  if (response.url().includes("/api/bots") || response.url().includes("/api/auth/me") || response.status() >= 400) {
    responses.push({ url: response.url(), status: response.status() });
  }
});

await page.addInitScript(({ token, user }) => {
  localStorage.clear();
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  localStorage.setItem("active_view", "marketplace");
  sessionStorage.setItem("entered_app", "1");
}, { token: session.token, user: session.user });
await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 90_000 });

try {
  for (const name of agentNames) {
    await page.getByText(name, { exact: true }).first().waitFor({ timeout: 45_000 });
  }
} catch (error) {
  await mkdir(".tmp-e2e", { recursive: true });
  await page.screenshot({ path: ".tmp-e2e/storyboard-agent-ui-v50-failed.png", fullPage: true });
  const diagnostic = {
    url: page.url(),
    title: await page.title(),
    bodyText: (await page.locator("body").innerText()).slice(0, 8000),
    storage: await page.evaluate(() => ({
      hasToken: Boolean(localStorage.getItem("auth_token")),
      hasUser: Boolean(localStorage.getItem("auth_user")),
      activeView: localStorage.getItem("active_view"),
    })),
    responses,
    errors,
  };
  await writeFile(".tmp-e2e/storyboard-agent-ui-v50-failed.json", JSON.stringify(diagnostic, null, 2), "utf8");
  console.error(JSON.stringify(diagnostic, null, 2));
  throw error;
}
for (let attempt = 0; attempt < 3; attempt += 1) {
  const openDialog = page.getByRole("dialog").last();
  if (!await openDialog.isVisible().catch(() => false)) break;
  await page.keyboard.press("Escape");
  await openDialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
}
const agentCard = page.locator(".agent-card-hover").filter({ hasText: agentNames[0] }).first();
await agentCard.waitFor({ state: "visible", timeout: 15_000 });
await agentCard.click();

try {
  await page.locator("#preset-storyboard_segmented_copy").waitFor({ timeout: 15_000 });
} catch (error) {
  await mkdir(".tmp-e2e", { recursive: true });
  await page.screenshot({ path: ".tmp-e2e/storyboard-agent-ui-v50-click-failed.png", fullPage: true });
  const diagnostic = {
    url: page.url(),
    cardText: await agentCard.innerText().catch(() => ""),
    agentCards: await page.locator(".agent-card-hover").evaluateAll((elements) => elements.map((element) => element.textContent?.trim()).filter(Boolean)),
    presetIds: await page.locator('[id^="preset-"]').evaluateAll((elements) => elements.map((element) => element.id)),
    bodyText: (await page.locator("body").innerText()).slice(0, 12_000),
    responses,
    errors,
  };
  await writeFile(".tmp-e2e/storyboard-agent-ui-v50-click-failed.json", JSON.stringify(diagnostic, null, 2), "utf8");
  console.error(JSON.stringify(diagnostic, null, 2));
  throw error;
}
const inputIds = await page.locator('[id^="preset-storyboard_"]').evaluateAll((elements) => elements.map((element) => element.id));
const ratioOptions = await page.locator("#preset-storyboard_aspect_ratio option").evaluateAll((options) => options.slice(1).map((option) => option.textContent?.trim()));
const styleOptions = await page.locator("#preset-storyboard_visual_style option").evaluateAll((options) => options.slice(1).map((option) => option.textContent?.trim()));

assert.deepEqual(inputIds.sort(), [
  "preset-storyboard_character_setting",
  "preset-storyboard_segmented_copy",
  "preset-storyboard_special_requirements",
  "preset-storyboard_aspect_ratio",
  "preset-storyboard_visual_style",
].sort(), "主站接收弹窗不是预期的 5 个字段");
assert.deepEqual(ratioOptions, ["16:9 横屏", "9:16 竖屏"], "尺寸下拉框不正确");
assert.deepEqual(styleOptions, expectedStyles, "动画风格下拉框没有完整同步 10 种 3D 风格");

await mkdir(".tmp-e2e", { recursive: true });
await page.screenshot({ path: ".tmp-e2e/storyboard-agent-ui-v50.png", fullPage: true });
const report = {
  passed: true,
  testedAt: new Date().toISOString(),
  agentNames,
  inputIds,
  ratioOptions,
  styleOptions,
  consoleErrors: errors,
  screenshot: ".tmp-e2e/storyboard-agent-ui-v50.png",
};
await writeFile(".tmp-e2e/storyboard-agent-ui-v50.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

await context.close();
await browser.close();
