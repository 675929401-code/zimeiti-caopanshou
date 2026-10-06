import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const outputDir = path.resolve(".codex-evidence", "cover-template-workflow");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
fs.mkdirSync(outputDir, { recursive: true });

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[cover-template-workflow] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[cover-template-workflow] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
await context.addInitScript((authToken) => localStorage.setItem("auth_token", authToken), token);
const page = await context.newPage();
const errors = [];
const paidRequests = [];

page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) errors.push(message.text());
});
page.on("request", (request) => {
  const pathname = new URL(request.url()).pathname;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /\/(?:generate|image-generation|video-generation|llm|chat|cover\/attempt|cover\/render)(?:\/|$)/iu.test(pathname)) {
    paidRequests.push(pathname);
  }
});

try {
  const response = await page.goto(`${baseUrl}/cover?workflow-check=1`, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200, "封面工作台应返回 200");
  await page.locator(".cover-rebuild-shell").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: /参考模板/u }).click();
  await page.locator(".cover-reference-dock").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "浏览模板库", exact: true }).click();
  const templateList = page.locator(".cover-template-library-grid");
  await templateList.waitFor({ state: "visible", timeout: 30_000 });
  const templateOptions = templateList.locator(".cover-template-library-option");
  const templateOptionCount = await templateOptions.count();
  assert.ok(templateOptionCount >= 2, "模板列表至少应有两个可选版式");
  await templateOptions.nth(1).click();
  const templatePreview = page.locator(".cover-template-preview-dialog");
  await templatePreview.waitFor({ state: "visible" });
  await templatePreview.getByRole("button", { name: "使用此模板", exact: true }).click();
  await page.locator(".cover-template-library-dialog").waitFor({ state: "hidden" });
  const selectedTemplate = (await page.locator(".cover-reference-dock strong").first().textContent())?.trim() || "";
  assert.ok(selectedTemplate, "选择模板后应显示当前参考摘要");

  const textField = page.getByRole("textbox", { name: "输入文案" });
  await textField.fill("主站模板测试：三秒看懂内容价值");
  const generateButton = page.getByRole("button", { name: "生成封面", exact: true });
  assert.equal(await generateButton.isDisabled(), true, "拆解前不得直接提交生成");
  await page.getByRole("button", { name: "拆解文案", exact: true }).click();
  const decomposition = page.getByRole("textbox", { name: "拆解结果" });
  await decomposition.waitFor({ state: "visible", timeout: 10_000 });
  assert.ok((await decomposition.inputValue()).trim().length >= 6, "拆解结果必须自动填入可编辑文案");
  await decomposition.fill("三秒看懂\n狗狗真实情绪");
  assert.equal(await textField.inputValue(), "主站模板测试：三秒看懂内容价值");
  assert.equal(await decomposition.inputValue(), "三秒看懂\n狗狗真实情绪", "拆解结果必须允许人工修改");
  assert.equal(await generateButton.isEnabled(), true, "人工修改拆解结果后应保持生成就绪");
  assert.equal(await page.getByRole("img", { name: /任务.+封面结果/u }).count(), 0, "零成本模板验收不得伪造生成结果");
  const screenshot = path.join(outputDir, "cover-template-current-workflow.png");
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.deepEqual(errors, [], "封面工作台不应出现页面异常");
  assert.deepEqual(paidRequests, [], "零费用封面验收不得提交生成任务");

  console.log(JSON.stringify({
    ok: true,
    templateOptions: templateOptionCount,
    selectedTemplate,
    editedValue: await textField.inputValue(),
    editedDecomposition: await decomposition.inputValue(),
    generationReady: await generateButton.isEnabled(),
    screenshot,
    paidRequests,
    errors,
  }, null, 2));
} finally {
  await closeWithTimeout(context, "context.close");
  await closeWithTimeout(browser, "browser.close");
}
process.exit(0);
