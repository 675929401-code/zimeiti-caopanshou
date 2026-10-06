#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const targetAgentName = "3D故事导演｜高能版";
const outputDir = path.resolve(".codex-evidence/agent-network-dialog-zero-cost-20261004");

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
await fs.mkdir(outputDir, { recursive: true });

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === "admin", "ACTIVE_LOCAL_ADMIN_REQUIRED");

const browser = await chromium.launch({ headless: true });
let llmPosts = 0;
let blockedExternalRequests = 0;
let blockedBusinessWrites = 0;
const consoleErrors = [];
const pageErrors = [];

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: "block",
  });
  await context.addInitScript(({ localToken, user }) => {
    localStorage.setItem("auth_token", localToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { localToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.hostname.match(/^(?:127\.0\.0\.1|localhost)$/u)) {
      blockedExternalRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/llm") {
      llmPosts += 1;
      if (llmPosts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json; charset=utf-8",
          headers: { "Retry-After": "5", "Cache-Control": "no-store" },
          body: JSON.stringify({
            error: "本地版本正在更新，当前未调用模型或扣费。请等待更新完成后再发送。",
            code: "LOCAL_BUILD_DRAINING",
            retryable: true,
            retry_safe: true,
            provider_call_started: false,
            charged: false,
          }),
        });
      } else {
        await route.abort("connectionreset");
      }
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      blockedBusinessWrites += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const targetCard = page.getByRole("button", { name: `打开智能体：${targetAgentName}`, exact: true });
  await targetCard.waitFor({ state: "visible", timeout: 30_000 });
  await targetCard.scrollIntoViewIfNeeded();
  await targetCard.click();
  const skipButton = page.getByRole("button", { name: "跳过", exact: true });
  if (await skipButton.isVisible().catch(() => false)) await skipButton.click();

  const composer = page.getByRole("textbox", { name: /向 .* 发送消息/u });
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.fill("零费用网络故障验收：请勿实际调用模型。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();

  const status = page.getByTestId("chat-message-status").last();
  await status.waitFor({ state: "visible", timeout: 15_000 });
  const safeRetryText = await status.innerText();
  assert.match(safeRetryText, /未调用模型或扣费/u);
  assert.match(safeRetryText, /可安全重新发送/u);
  assert.doesNotMatch(safeRetryText, /网络连接异常/u);
  assert.equal(await status.getByRole("button", { name: "重新发送", exact: true }).count(), 1);
  await page.screenshot({ path: path.join(outputDir, "build-drain-safe-retry.png"), fullPage: true });

  await status.getByRole("button", { name: "重新发送", exact: true }).click();
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('[data-testid="chat-message-status"]')];
    return nodes.some((node) => node.getAttribute("data-state") === "unknown");
  }, undefined, { timeout: 15_000 });
  const unknownStatus = page.locator('[data-testid="chat-message-status"][data-state="unknown"]').last();
  const unknownText = await unknownStatus.innerText();
  assert.match(unknownText, /结果待确认，请勿重复发送/u);
  assert.doesNotMatch(unknownText, /网络连接异常/u);
  assert.equal(await unknownStatus.getByRole("button", { name: "重新发送", exact: true }).count(), 0);
  assert.equal(await unknownStatus.getByRole("button", { name: "刷新状态", exact: true }).count(), 1);
  await page.screenshot({ path: path.join(outputDir, "ambiguous-network-no-duplicate.png"), fullPage: true });

  for (const routePath of ["/profile", "/media-history"]) {
    await page.goto(`${origin}${routePath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${routePath} overflow`);
  }

  const report = {
    sourceVersion: null,
    buildId: null,
    targetAgentName,
    llmPosts,
    providerCalls: 0,
    paidCalls: 0,
    databaseWrites: 0,
    blockedBusinessWrites,
    blockedExternalRequests,
    externalRequestsReached: 0,
    safeBuildDrainMessage: true,
    ambiguousNetworkBlocksDuplicate: true,
    adjacentRoutes: ["/profile", "/media-history"],
    consoleErrors,
    pageErrors,
  };
  const versionResponse = await context.request.get(`${origin}/api/version`);
  const version = await versionResponse.json();
  report.sourceVersion = version.sourceVersion;
  report.buildId = version.buildId;
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(llmPosts, 2);
  assert.equal(pageErrors.length, 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
