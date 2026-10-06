#!/usr/bin/env node

import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(origin), "LOCAL_ORIGIN_REQUIRED");
assert.ok(token, "ORDINARY_CUSTOMER_TOKEN_REQUIRED");

const headers = { Authorization: `Bearer ${token}` };
const identityResponse = await fetch(`${origin}/api/auth/me`, { headers, signal: AbortSignal.timeout(10_000) });
const identity = await identityResponse.json();
assert.equal(identityResponse.status, 200);
assert.equal(identity?.user?.role, "student");

const catalogResponse = await fetch(`${origin}/api/tools/runtime-catalog`, {
  headers,
  cache: "no-store",
  signal: AbortSignal.timeout(15_000),
});
const catalog = await catalogResponse.json();
assert.equal(catalogResponse.status, 200);
assert.equal(catalogResponse.headers.get("cache-control"), "private, no-store");
assert.doesNotMatch(JSON.stringify(catalog), /api[_-]?key|api[_-]?token|provider|model|adminExempt|workflow[_-]?id/iu);

const paidTools = ["video", "text", "batch", "search"];
for (const key of paidTools) {
  assert.equal(catalog.items?.[key]?.available, true, `${key} is not available`);
  assert.equal(catalog.items?.[key]?.unitPrice, 0.02, `${key} public price is not ¥0.02/item`);
  assert.equal(catalog.items?.[key]?.unit, "条");
}
for (const key of ["formatter", "segmenter"]) {
  assert.equal(catalog.items?.[key]?.available, true);
  assert.equal(catalog.items?.[key]?.unitPrice, 0);
  assert.equal(catalog.items?.[key]?.processingMode, "local_rules");
}

const audit = { nonGet: [], external: [], pageErrors: [], consoleErrors: [] };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      audit.external.push({ method: request.method(), origin: url.origin });
      await route.abort("blockedbyclient");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      audit.nonGet.push({ method: request.method(), path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => audit.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) audit.consoleErrors.push(message.text().slice(0, 300));
  });
  const response = await page.goto(`${origin}/tools?tab=text`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200);
  await page.locator('[data-page="tools"]').waitFor({ state: "visible", timeout: 30_000 });
  let announcementDismissed = false;
  const announcementReader = page.getByTestId("announcement-reader");
  if (await announcementReader.isVisible().catch(() => false)) {
    await announcementReader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
    await announcementReader.waitFor({ state: "hidden", timeout: 10_000 });
    announcementDismissed = true;
  }
  const prices = {};
  for (const tab of ["文案提取", "视频提取"]) {
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    const quote = page.getByRole("status").filter({ hasText: "通道已配置" });
    await quote.waitFor({ state: "visible", timeout: 15_000 });
    const text = await quote.innerText();
    assert.match(text, /计费：\s*¥0\.02\/条/u, `${tab} did not show ¥0.02/item`);
    assert.doesNotMatch(text, /管理员|供应商|模型|工作流|当前通道|通道：/u);
    prices[tab] = "¥0.02/条";
  }
  await page.getByRole("tab", { name: /^文案提取/u }).click();
  await page.getByRole("button", { name: "批量与搜索", exact: true }).click();
  const batchQuote = page.getByRole("status").filter({ hasText: "通道已配置" });
  await batchQuote.waitFor({ state: "visible", timeout: 15_000 });
  const batchText = await batchQuote.innerText();
  assert.match(batchText, /计费：\s*¥0\.02\/条/u, "批量与搜索 did not show ¥0.02/item");
  assert.doesNotMatch(batchText, /管理员|供应商|模型|工作流|当前通道|通道：/u);
  prices["批量与搜索"] = "¥0.02/条";

  await page.getByRole("button", { name: "返回单条", exact: true }).click();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByRole("button", { name: "返回提取", exact: true }).waitFor({ state: "visible", timeout: 15_000 });

  for (const tab of ["文字排版", "智能分段"]) {
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await page.locator('[role="tabpanel"]:visible').waitFor({ state: "visible", timeout: 15_000 });
  }
  const telemetryPaths = new Set(["/api/announcements/events", "/api/product-usage/events"]);
  const businessWrites = audit.nonGet.filter((request) => !telemetryPaths.has(request.path));
  assert.deepEqual(businessWrites, []);
  assert.deepEqual(audit.external, []);
  assert.deepEqual(audit.pageErrors, []);
  assert.deepEqual(audit.consoleErrors, []);
  await context.close();

  console.log(JSON.stringify({
    passed: true,
    role: identity.user.role,
    apiPrices: Object.fromEntries(paidTools.map(key => [key, catalog.items[key].unitPrice])),
    localRules: { formatter: 0, segmenter: 0 },
    renderedPrices: prices,
    announcementDismissed,
    blockedAnnouncementAnalytics: audit.nonGet.filter((request) => request.path === "/api/announcements/events").length,
    blockedProductUsageAnalytics: audit.nonGet.filter((request) => request.path === "/api/product-usage/events").length,
    providerCalls: 0,
    paidCalls: 0,
    databaseWrites: 0,
  }, null, 2));
} finally {
  await browser.close();
}
