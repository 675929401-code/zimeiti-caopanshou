#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const output = path.resolve(".codex-evidence/text-model-admin-simple-live-20260930");

function sanitize(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/giu, "<redacted-key>")
    .slice(0, 500);
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(output, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];
  const consoleErrors = [];
  const blockedWrites = [];
  const externalRequests = [];
  let capturedPayload = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (request.method() === "POST" && url.pathname === "/api/admin/models") {
        capturedPayload = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, model: { id: "ui-capture-only" } }) });
        return;
      }
      const diagnosticReadPost = request.method() === "POST" && url.pathname === "/__nextjs_original-stack-frames";
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !diagnosticReadPost) {
        blockedWrites.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(sanitize(error.message)));
    page.on("console", message => {
      if (message.type() !== "error" || /ERR_BLOCKED_BY_CLIENT/u.test(message.text())) return;
      consoleErrors.push(sanitize(message.text()));
    });
    page.on("dialog", dialog => dialog.dismiss());

    await page.goto(`${origin}/admin?tab=models`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByRole("heading", { name: "模型资源池", exact: true }).waitFor({ timeout: 30_000 });
    const announcement = page.getByTestId("announcement-reader");
    if (await announcement.isVisible().catch(() => false)) {
      await announcement.getByRole("button", { name: "关闭系统公告", exact: true }).click();
    }
    await page.getByRole("button", { name: /对话模型/u }).first().click();
    await page.getByRole("button", { name: "添加对话模型", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新增模型" });
    await dialog.waitFor({ state: "visible", timeout: 20_000 });

    const visibleLabels = await dialog.locator("label").allTextContents();
    for (const required of ["中转站接口", "API 基础地址", "API 密钥", "模型名称", "输入成本", "输出成本", "缓存成本", "利润率(%)", "上下文长度(Token)", "深度思考"]) {
      assert.ok(visibleLabels.some(label => label.includes(required)), `REQUIRED_FIELD_MISSING:${required}`);
    }
    for (const removed of ["模型类型选择", "模型显示名称", "模型简介", "模型图标", "模型排序", "模型调用频率", "账号关联模型", "单次扣除金额", "基础费用", "联网搜索", "图片解析", "文件解析", "管理员备注"]) {
      assert.equal(visibleLabels.some(label => label.includes(removed)), false, `REMOVED_FIELD_VISIBLE:${removed}`);
    }
    assert.equal(await dialog.getByRole("button", { name: "测试连接", exact: true }).count(), 0, "NEW_MODEL_PAID_TEST_ACTION_VISIBLE");

    await dialog.getByLabel("中转站接口", { exact: true }).selectOption("secure_skill");
    assert.equal(await dialog.getByLabel("接入站点 API 地址", { exact: true }).inputValue(), "https://token.secure-skill.com/v1");
    assert.equal(await dialog.getByLabel("接入站点 API 地址", { exact: true }).isEditable(), false);
    await dialog.getByLabel("API 密钥", { exact: true }).fill("test-only-not-a-real-secret");
    await dialog.getByLabel("模型名称", { exact: true }).fill("gpt-6-sol-ui-contract");
    await dialog.getByLabel("输入成本", { exact: true }).fill("0.6");
    await dialog.getByLabel("输出成本", { exact: true }).fill("3");
    await dialog.getByLabel("缓存成本", { exact: true }).fill("0.06");
    await dialog.getByLabel("利润率", { exact: true }).fill("9.090909");
    await dialog.getByLabel("上下文长度", { exact: true }).fill("64000");
    await dialog.getByRole("button", { name: "自带思考", exact: true }).click();

    await dialog.screenshot({ path: path.join(output, "text-model-simple-form-1440x900.png") });
    const layout = await dialog.evaluate(element => ({
      right: element.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      documentOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }));
    assert.ok(layout.right <= layout.viewportWidth + 1, "DIALOG_OVERFLOWS_VIEWPORT");
    assert.ok(layout.documentOverflow <= 1, `PAGE_HORIZONTAL_OVERFLOW:${layout.documentOverflow}`);

    await dialog.getByRole("button", { name: "确认新增", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-labelledby="model-dialog-title"]'), undefined, { timeout: 10_000 });
    assert.ok(capturedPayload, "MODEL_SAVE_PAYLOAD_NOT_CAPTURED");
    assert.equal(capturedPayload.model_type, "text");
    assert.equal(capturedPayload.billing_mode, "token");
    assert.equal(capturedPayload.token_billing_enabled, true);
    assert.equal(capturedPayload.api_endpoint, "https://token.secure-skill.com/v1");
    assert.equal(capturedPayload.proxy_url, "https://token.secure-skill.com/v1");
    assert.equal(capturedPayload.model_name, "gpt-6-sol-ui-contract");
    assert.equal(capturedPayload.input_cost_per_million, 0.6);
    assert.equal(capturedPayload.output_cost_per_million, 3);
    assert.equal(capturedPayload.cached_cost_per_million, 0.06);
    assert.equal(capturedPayload.profit_margin, 9.090909);
    assert.equal(capturedPayload.max_context_tokens, 64000);
    assert.equal(capturedPayload.deep_thinking_type, 2);
    assert.equal(capturedPayload.cost_per_use, 0);
    assert.equal(capturedPayload.cost_price, 0);
    assert.equal(capturedPayload.enable_web_search, false);
    assert.equal(capturedPayload.image_parsing, "none");
    assert.equal(capturedPayload.file_parsing, "none");
    assert.equal(capturedPayload.max_context_rounds, 0);

    const report = {
      passed: true,
      observedAt: new Date().toISOString(),
      route: "/admin?tab=models",
      requiredFields: 10,
      removedFields: 13,
      presetEndpoint: capturedPayload.api_endpoint,
      tokenBilling: true,
      nativeThinking: true,
      simulatedSaveCaptured: true,
      modelWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      databaseWrites: 0,
      blockedWrites,
      externalRequests,
      pageErrors,
      consoleErrors,
    };
    assert.deepEqual(blockedWrites, [], "UNEXPECTED_LOCAL_WRITE");
    assert.deepEqual(externalRequests, [], "UNEXPECTED_EXTERNAL_REQUEST");
    assert.deepEqual(pageErrors, [], "PAGE_ERRORS");
    assert.deepEqual(consoleErrors, [], "CONSOLE_ERRORS");
    await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
