import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const screenshotPath = path.resolve(".codex-screenshots/storyboard-video-edit-filter-fixed.png");

const modelsResponse = await fetch(`${baseUrl}/api/video/models?verify=storyboard-video-filter`);
const modelsPayload = await modelsResponse.json();
assert.ok(modelsResponse.ok && Array.isArray(modelsPayload.models), "视频模型接口不可用");
const sourceVideoModel = modelsPayload.models.find((model) => /Omni Video Edit/i.test(String(model.displayName)));
assert.ok(sourceVideoModel, "公开模型接口应保留 Omni Video Edit 供视频编辑页使用");
assert.equal(sourceVideoModel.capabilities?.requiresSourceVideo, true);

const storyboardModelsResponse = await fetch(`${baseUrl}/api/video/models?surface=storyboard-workbench`);
const storyboardModelsPayload = await storyboardModelsResponse.json();
assert.ok(storyboardModelsResponse.ok && Array.isArray(storyboardModelsPayload.models), "分镜工作台模型接口不可用");
assert.equal(
  storyboardModelsPayload.models.some((model) => model.capabilities?.requiresSourceVideo === true),
  false,
  "分镜工作台接口不得返回必须源视频的模型",
);
assert.equal(
  storyboardModelsPayload.models.some((model) => /数字人|口播|口型|对口型|lip[\s_-]*sync|talking[\s_-]*head/i.test(String(model.displayName || ""))),
  false,
  "分镜工作台接口不得返回数字人/口型类模型",
);

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
if (!(sessionResponse.ok && session.token && session.user)) {
  if (sessionResponse.status === 404 && /not found/i.test(String(session.error || ""))) {
    console.log(JSON.stringify({
      status: "passed",
      storyboardHidesSourceVideoModel: true,
      videoPageKeepsSourceVideoModel: true,
      paidCalls: 0,
      uiSkipped: true,
      uiSkippedReason: "本地服务以 next start/production 运行，/api/auth/dev-session 按安全规则关闭；已完成接口级无费用验证。",
    }));
    process.exit(0);
  }
  assert.fail(session.error || "本地验收会话不可用");
}

await mkdir(path.dirname(screenshotPath), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
  }, { token: session.token, user: session.user });

  const page = await context.newPage();
  let phase = "storyboard";
  const browserErrors = [];
  const failedResponses = [];
  const paidRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push({ phase, status: response.status(), url: response.url() });
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/video/generate")) paidRequests.push(request.url());
  });

  await page.goto(`${baseUrl}/storyboard-workbench?verify=storyboard-video-filter`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.getByText("图生视频模型", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByRole("button", { name: /选择视频模型：Omni Video Edit/i }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /选择视频模型：Omni Flash/i }).count(), 1);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const storyboardBrowserErrors = [...browserErrors];
  const storyboardFailedResponses = failedResponses.filter((response) => response.phase === "storyboard");
  phase = "video";
  await page.goto(`${baseUrl}/video?verify=storyboard-video-filter`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  const modelField = page.locator("label:visible").filter({ hasText: "视频模型" }).locator("..");
  await modelField.locator("button").first().click({ force: true });
  assert.equal(await page.getByRole("option", { name: /Omni Video Edit/i }).count(), 1);
  await page.keyboard.press("Escape");

  assert.deepEqual(storyboardBrowserErrors, [], `分镜工作台存在浏览器错误：${storyboardBrowserErrors.join(" | ")}`);
  assert.deepEqual(storyboardFailedResponses, [], `分镜工作台存在失败请求：${JSON.stringify(storyboardFailedResponses)}`);
  assert.deepEqual(paidRequests, [], "无费用回归不得提交视频生成请求");
  console.log(JSON.stringify({
    status: "passed",
    storyboardHidesSourceVideoModel: true,
    videoPageKeepsSourceVideoModel: true,
    paidCalls: 0,
    storyboardBrowserErrorCount: 0,
    storyboardFailedResponseCount: 0,
    crossCheckDiagnostics: {
      browserErrors,
      failedResponses,
    },
    screenshot: screenshotPath,
  }));
} finally {
  await browser.close();
}
