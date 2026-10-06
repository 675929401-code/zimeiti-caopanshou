#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const outputDir = path.resolve(".codex-evidence/admin-health-monitor-live-20260920");

async function localApi(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, body.error || `${pathname} returned ${response.status}`);
  return body;
}

export async function main(args = []) {
  const readOnly = args.includes("--read-only");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await fs.mkdir(outputDir, { recursive: true });

  const identity = await localApi("/api/auth/me");
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");

  const health = await localApi("/api/health");
  assert.ok(Array.isArray(health.checks) && health.checks.length >= 7, "REAL_HEALTH_CHECKS_MISSING");
  assert.ok(health.checks.every(check => typeof check.name === "string" && check.name.length > 0), "HEALTH_CHECK_NAME_MISSING");
  assert.equal(health.monitoring?.automaticRepairEnabled, false, "AUTOMATIC_REPAIR_MUST_BE_DISABLED");
  assert.equal(health.monitoring?.scheduleMode, "external", "SCHEDULE_MODE_MUST_BE_EXTERNAL");
  assert.ok(Number.isFinite(Date.parse(health.timestamp)), "HEALTH_TIMESTAMP_MISSING");

  const querySecretResponse = await fetch(`${origin}/api/health/cron?secret=must-not-authorize`, {
    signal: AbortSignal.timeout(15_000),
  });
  const querySecretBody = await querySecretResponse.json().catch(() => ({}));
  assert.notEqual(querySecretResponse.status, 200, "QUERY_STRING_SECRET_MUST_NOT_AUTHORIZE");
  assert.ok(["HEALTH_MONITOR_NOT_CONFIGURED", "HEALTH_MONITOR_FORBIDDEN"].includes(querySecretBody.code), "CRON_MUST_FAIL_CLOSED");

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    checkNames: health.checks.map(check => check.name),
    checks: health.checks.map(check => ({
      name: check.name,
      status: check.status,
      message: check.message,
      details: check.details || null,
    })),
    overallStatus: health.status,
    internalTriggerConfigured: health.monitoring?.internalTriggerConfigured === true,
    cronQueryRejected: true,
    maintenanceRequests: 0,
    paidGenerationRequests: 0,
    browserExternalRequests: 0,
    pageErrors: [],
    consoleErrors: [],
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push(error.message.slice(0, 500)));
    page.on("console", message => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
    });
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) report.paidGenerationRequests += 1;
      if (url.origin !== origin) report.browserExternalRequests += 1;
    });

    await page.goto(`${origin}/admin?tab=health`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "立即检查", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await page.getByText("数据库连接", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.getByText(/每天自动执行 2-3 次健康检查/u).count(), 0, "FALSE_SCHEDULE_COPY_REMAINS");
    await page.getByText(/内部触发鉴权:/u).waitFor({ state: "visible" });

    if (!readOnly) {
      const maintenanceResponse = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/health", { timeout: 90_000 });
      await page.getByRole("button", { name: "执行安全维护", exact: true }).click();
      const response = await maintenanceResponse;
      assert.equal(response.status(), 200, "HEALTH_MAINTENANCE_FAILED");
      const requestBody = response.request().postDataJSON();
      assert.equal(requestBody.action, "fix", "HEALTH_MAINTENANCE_ACTION_MISMATCH");
      const maintenance = await response.json();
      assert.ok(Array.isArray(maintenance.checks), "HEALTH_MAINTENANCE_CHECKS_MISSING");
      assert.equal(maintenance.monitoring?.automaticRepairEnabled, false, "MAINTENANCE_RESPONSE_OVERSTATED_AUTOMATION");
      report.maintenanceRequests += 1;
    }
    await page.screenshot({ path: path.join(outputDir, "health-desktop.png"), fullPage: true });

    await page.getByRole("navigation", { name: "管理后台功能导航" }).getByRole("button", { name: "模型资源池", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("tab") === "models");
    await page.getByText("视频通道监测", { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await page.getByText(/供应商余额：当前渠道未接入受支持的只读余额接口/u).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "刷新状态", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    const summary = await page.locator("[data-video-channel-health-summary]").innerText();
    assert.match(summary, /启用通道/u);
    assert.match(summary, /已验证正常/u);
    assert.match(summary, /阻断待处理/u);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outputDir, "models-mobile.png"), fullPage: true });
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(viewport.scrollWidth <= viewport.width + 1, `ADMIN_HEALTH_HORIZONTAL_OVERFLOW:${JSON.stringify(viewport)}`);
    assert.equal(report.paidGenerationRequests, 0, "HEALTH_ACCEPTANCE_ATTEMPTED_PAID_GENERATION");
    assert.deepEqual(report.pageErrors, [], "HEALTH_ADMIN_PAGE_ERRORS");
  } finally {
    await browser.close();
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(JSON.stringify({ passed: true, ...report, outputDir }, null, 2));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
