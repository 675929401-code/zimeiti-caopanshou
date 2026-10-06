#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const outputDir = path.resolve(".codex-evidence/model-protocol-isolation-20261006/live-ui");

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token && stepUpToken && identity?.user?.id, "LOCAL_ADMIN_STEP_UP_SESSION_REQUIRED");

await fs.mkdir(outputDir, { recursive: true });

const report = {
  schema: "model_protocol_ui_live.v1",
  checkedAt: "",
  origin,
  viewport: { width: 1600, height: 1000 },
  pages: [],
  dialogs: [],
  paidGenerationRequests: 0,
  externalRequestsBlocked: 0,
  telemetryEventsSuppressed: 0,
  pageErrors: [],
  consoleErrors: [],
  failedResponses: [],
  ignoredFailurePaths: ["/api/product-usage/events"],
  passed: false,
};

function pageSnapshot(page, route) {
  return page.evaluate((expectedRoute) => {
    const root = document.documentElement;
    const text = String(document.body?.innerText || "").replace(/\s+/gu, " ").trim();
    return {
      route: expectedRoute,
      url: location.href,
      title: document.title,
      textLength: text.length,
      horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
      replacementCharacters: (text.match(/\uFFFD/gu) || []).length,
    };
  }, route);
}

async function openAndCheck(page, route, screenshotName) {
  const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${route}:HTTP_200_REQUIRED`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const snapshot = await pageSnapshot(page, route);
  assert.ok(snapshot.textLength > 100, `${route}:VISIBLE_CONTENT_REQUIRED`);
  assert.equal(snapshot.horizontalOverflowPx, 0, `${route}:HORIZONTAL_OVERFLOW`);
  assert.equal(snapshot.replacementCharacters, 0, `${route}:REPLACEMENT_CHARACTER_FORBIDDEN`);
  report.pages.push(snapshot);
  await page.screenshot({ path: path.join(outputDir, screenshotName), fullPage: true });
}

async function inspectAddDialog(page, typeLabel, addButtonName, expectations) {
  await page.getByRole("button", { name: new RegExp(typeLabel, "u") }).first().click();
  await page.getByRole("button", { name: addButtonName, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await dialog.getByRole("heading", { name: "新增模型", exact: true }).count(), 1, `${typeLabel}:ADD_DIALOG_REQUIRED`);
  for (const expectation of expectations) {
    if (expectation.kind === "aria") {
      assert.equal(await dialog.locator(`[aria-label="${expectation.value}"]`).count(), 1, `${typeLabel}:${expectation.value}:CONTROL_REQUIRED`);
    } else if (expectation.kind === "label") {
      assert.ok(await dialog.locator("label").filter({ hasText: expectation.value }).count() >= 1, `${typeLabel}:${expectation.value}:LABEL_REQUIRED`);
    } else {
      assert.ok(await dialog.getByText(expectation.value, { exact: true }).count() >= 1, `${typeLabel}:${expectation.value}:LABEL_REQUIRED`);
    }
  }
  report.dialogs.push({ type: typeLabel, expectations });
  await dialog.screenshot({ path: path.join(outputDir, `${typeLabel}.png`) });
  await dialog.getByRole("button", { name: "关闭模型设置", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: report.viewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUpToken },
  });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { await route.continue(); return; }
    if (url.origin === origin && url.pathname === "/api/product-usage/events") {
      report.telemetryEventsSuppressed += 1;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      report.externalRequestsBlocked += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (request.method() === "POST" && ["/api/image/generate", "/api/video/generate", "/api/llm"].includes(url.pathname)) {
      report.paidGenerationRequests += 1;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error?.message || error).slice(0, 600)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) report.consoleErrors.push(message.text().slice(0, 600));
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === origin) {
      report.failedResponses.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname });
    }
  });

  await openAndCheck(page, "/admin?tab=models&view=overview", "admin-models.png");
  await page.getByRole("heading", { name: "模型资源池", exact: true }).waitFor({ state: "visible" });
  await inspectAddDialog(page, "对话模型", "添加对话模型", [
    { kind: "aria", value: "对话模型接口协议" },
  ]);
  await inspectAddDialog(page, "绘图模型", "添加绘图模型", [
    { kind: "label", value: "接口协议" },
    { kind: "aria", value: "接入站点 API 地址" },
  ]);
  await inspectAddDialog(page, "视频模型", "添加视频模型", [
    { kind: "label", value: "渠道标识" },
    { kind: "label", value: "接口协议" },
  ]);

  await openAndCheck(page, "/admin?tab=agents&view=overview", "admin-agents.png");
  await openAndCheck(page, "/storyboard-workbench", "storyboard-workbench.png");

  assert.equal(report.paidGenerationRequests, 0, "READ_ONLY_QA_MUST_NOT_GENERATE");
  assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${report.pageErrors.join(" | ")}`);
  assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${report.consoleErrors.join(" | ")}`);
  const relevantFailures = report.failedResponses.filter((entry) => ![401, 403].includes(entry.status)
    && !report.ignoredFailurePaths.includes(entry.path));
  assert.deepEqual(relevantFailures, [], `FAILED_RESPONSES:${JSON.stringify(relevantFailures)}`);
  report.passed = true;
} finally {
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await browser.close();
}

console.log(JSON.stringify({ passed: report.passed, pages: report.pages, dialogs: report.dialogs.length, paidGenerationRequests: report.paidGenerationRequests, outputDir }));
