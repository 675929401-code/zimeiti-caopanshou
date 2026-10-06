import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const screenshotPath = path.resolve(".codex-screenshots/secondary-return-marketplace-fixed.png");

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token && session.user, session.error || "本地验收会话不可用");

await mkdir(path.dirname(screenshotPath), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: session.token, user: session.user });

  const page = await context.newPage();
  const paidRequests = [];
  const browserErrors = [];
  const serverErrors = [];
  const rateLimitedResponses = [];
  page.on("request", (request) => {
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/.test(request.url())) {
      paidRequests.push(request.url());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() === 429) rateLimitedResponses.push(response.url());
    if (response.status() >= 500) serverErrors.push({ status: response.status(), url: response.url() });
  });

  const cases = [
    { name: "分镜工作台", route: "/storyboard-workbench?verify=return-marketplace", selector: ".sub-page-back" },
    { name: "工具箱", route: "/tools?verify=return-marketplace", selector: ".sub-page-back" },
    { name: "帮助中心", route: "/help?verify=return-marketplace", selector: 'a[aria-label="返回应用广场"]' },
    { name: "封面制作", route: "/cover?verify=return-marketplace", selector: ".cover-rebuild-back" },
    { name: "自由画布", route: "/free-canvas?verify=return-marketplace", selector: 'a[href="/"]' },
    { name: "媒体历史", route: "/media-history?verify=return-marketplace", selector: ".sub-page-back" },
    { name: "视频制作", route: "/video?verify=return-marketplace", selector: ".sub-page-back" },
  ];

  const results = [];
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 60_000 });
  for (const testCase of cases) {
    await page.evaluate(() => localStorage.setItem("active_view", "chat"));
    await page.goto(`${baseUrl}${testCase.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const returnControl = page.locator(testCase.selector).first();
    await returnControl.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(800);
    await returnControl.click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await page.waitForFunction(() => localStorage.getItem("active_view") === "marketplace", null, { timeout: 30_000 });
    await page.getByText("3D故事导演｜电影叙事", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByText("选择一个智能体开始对话", { exact: false }).count(), 0, `${testCase.name}返回后仍显示对话页`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    results.push({ name: testCase.name, returnedToMarketplace: true });
  }

  await page.evaluate(() => localStorage.setItem("active_view", "chat"));
  await page.goto(`${baseUrl}/announcements?verify=browser-back-marketplace`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await page.waitForFunction(() => localStorage.getItem("active_view") === "marketplace", null, { timeout: 30_000 });
  await page.getByText("3D故事导演｜电影叙事", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  results.push({ name: "浏览器后退", returnedToMarketplace: true });

  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("secondary_page_return_to_marketplace")),
    null,
    "二级页返回标记应在应用广场消费后清除",
  );
  results.push({ name: "返回标记消费", cleared: true });

  await page.evaluate(() => localStorage.setItem("active_view", "chat"));
  await page.goto(`${baseUrl}/storyboard-workbench?verify=return-marketplace-screenshot`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  browserErrors.length = 0;
  serverErrors.length = 0;
  rateLimitedResponses.length = 0;
  await page.locator(".sub-page-back").click();
  await page.waitForFunction(() => localStorage.getItem("active_view") === "marketplace", null, { timeout: 30_000 });
  await page.getByText("3D故事导演｜电影叙事", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.screenshot({ path: screenshotPath, fullPage: false });

  assert.deepEqual(paidRequests, [], "返回回归不得调用生成或对话接口");
  const unexpectedBrowserErrors = browserErrors.filter((message) => !/status of 429 \(Too Many Requests\)/i.test(message));
  assert.deepEqual(unexpectedBrowserErrors, [], `浏览器错误：${unexpectedBrowserErrors.join(" | ")}`);
  assert.deepEqual(serverErrors, [], `页面存在5xx响应：${JSON.stringify(serverErrors)}`);
  console.log(JSON.stringify({
    status: "passed",
    results,
    paidCalls: 0,
    unexpectedBrowserErrors: 0,
    serverErrors: 0,
    rateLimitedResponses: [...new Set(rateLimitedResponses)],
    screenshot: screenshotPath,
  }));
} finally {
  await browser.close();
}
