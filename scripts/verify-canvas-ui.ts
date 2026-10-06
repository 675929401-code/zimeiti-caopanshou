import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;
const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

assert.ok(phone && password, "请通过环境变量提供画布UI测试账号");

async function main() {
  const browser = await chromium.launch({ headless: true, ...(existsSync(edgePath) ? { executablePath: edgePath } : {}) });
  try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const loginResponse = await context.request.post(`${baseUrl}/api/auth/login`, {
    headers: { "User-Agent": "Mozilla/5.0 Canvas UI verification" },
    data: { phone, password },
  });
  const login = await loginResponse.json() as { token?: string; error?: string };
  assert.ok(loginResponse.ok() && login.token, login.error || "UI测试账号登录失败");
  await context.addInitScript((token) => localStorage.setItem("auth_token", token), login.token);

  const page = await context.newPage();
  await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByRole("button", { name: "打开制作面板" }).click();
  await page.getByRole("button", { name: /动漫剧情/ }).click();
  await page.getByRole("button", { name: "高级设置（可选）" }).click();

  await page.getByText("自动关键帧位置", { exact: true }).waitFor();
  await page.getByText("画面修饰强度", { exact: true }).waitFor();
  await page.getByText(/每个视觉镜头由系统生成一张关键帧和一个视频节点/).waitFor();
  await page.getByLabel("动画风格").selectOption("cinematic-cartoon-realism-3d");
  await page.getByLabel("自动关键帧位置").selectOption("visual-anchor");
  await page.getByLabel("画面修饰强度").selectOption("rich");
  assert.equal(await page.getByLabel("动画风格").inputValue(), "cinematic-cartoon-realism-3d");
  assert.equal(await page.getByLabel("风格细节 / 主角要求").count(), 0, "动漫风格提示词应内置，不显示为可编辑输入框");
  assert.equal(await page.getByLabel("自动关键帧位置").inputValue(), "visual-anchor");
  assert.equal(await page.getByLabel("画面修饰强度").inputValue(), "rich");
  assert.equal(await page.locator(".free-pro-panel").isVisible(), true, "专业画布面板应保持可见");

  await page.screenshot({ path: ".tmp-e2e/free-canvas-animation-styles.png", fullPage: true });
  console.log("Canvas UI verification passed.");
  } finally {
  await browser.close();
  }
}

void main();
