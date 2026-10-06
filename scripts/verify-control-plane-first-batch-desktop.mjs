#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const evidenceDir = path.resolve(".codex-evidence", "control-plane-first-batch-desktop");

const authenticatedPages = [
  { id: "admin-general", url: "/admin?tab=general", expected: "平台品牌中心", selector: '[data-testid="platform-brand-settings"]' },
  { id: "admin-payment", url: "/admin?tab=payment", expected: "支付系统", selector: '[data-testid="payment-system-control-plane"]' },
  { id: "admin-agents", url: "/admin?tab=agents", expected: "智能体管理" },
  { id: "admin-dashboard", url: "/admin?tab=dashboard", expected: "平台指挥中心", selector: '[data-testid="admin-command-center"]' },
  { id: "admin-announcements", url: "/admin?tab=announcements", expected: "公告管理" },
  { id: "admin-security", url: "/admin?tab=security", expected: "安全中心" },
  { id: "admin-health", url: "/admin?tab=health", expected: "系统健康" },
  { id: "admin-backup", url: "/admin?tab=backup", expected: "灾备与恢复证据", selector: '[data-testid="backup-restore-evidence-panel"]' },
  { id: "marketplace", url: "/", expected: "应用广场" },
  { id: "profile-notifications", url: "/profile?tab=notifications", expected: "通知" },
];

const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  viewport: { width: 1440, height: 900 },
  pages: [],
  blockedWrites: [],
  providerRequests: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  externalRequests: [],
  paidCalls: 0,
  productionWrites: 0,
};

function installDiagnostics(page, label) {
  page.on("pageerror", (error) => report.pageErrors.push({ label, message: String(error?.message || error) }));
  page.on("console", (message) => {
    const value = message.text();
    if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT|Failed to load resource.*fonts\.(?:gstatic|googleapis)/iu.test(value)) {
      report.consoleErrors.push({ label, page: page.url(), message: value.slice(0, 800) });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 500) {
      report.serverErrors.push({ label, status: response.status(), pathname: url.pathname });
    }
  });
}

async function installReadOnlyBoundary(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const providerPath = /^\/api\/(?:llm|chat|image\/generate|video\/generate|voice\/(?:tts|nest)|digital-human\/generate)(?:\/|$)/u.test(url.pathname);
    if (providerPath) {
      report.providerRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.origin !== origin) {
      report.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    const nextDiagnostic = request.method() === "POST" && url.pathname === "/__nextjs_original-stack-frames";
    if (request.method() !== "GET" && !nextDiagnostic) {
      report.blockedWrites.push(`${request.method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function samplePage(page, definition) {
  const response = await page.goto(`${origin}${definition.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `PAGE_UNAVAILABLE:${definition.url}:${response?.status()}`);
  await page.locator("body").waitFor({ state: "visible", timeout: 30_000 });
  if (definition.selector) await page.locator(definition.selector).waitFor({ state: "visible", timeout: 40_000 });
  await page.getByText(definition.expected, { exact: false }).first().waitFor({ state: "visible", timeout: 40_000 });
  await page.waitForTimeout(500);
  let componentEvidence = null;
  if (definition.selector) {
    componentEvidence = await page.locator(definition.selector).evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        color: style.color,
        borderRadius: style.borderRadius,
        overflowX: style.overflowX,
      };
    });
  }

  if (definition.id === "admin-dashboard") {
    const primaryNavigationCount = await page.locator('[data-testid^="admin-primary-nav-"]').count();
    assert.equal(primaryNavigationCount, 13, `ADMIN_PRIMARY_NAV_COUNT:${primaryNavigationCount}`);
    const headlineCount = await page.locator('[data-testid^="command-center-headline-"]').count();
    assert.equal(headlineCount, 3, `COMMAND_CENTER_HEADLINE_COUNT:${headlineCount}`);
    const sectionCount = await page.locator('[data-testid="command-center-sections"] > section').count();
    assert.equal(sectionCount, 7, `COMMAND_CENTER_SECTION_COUNT:${sectionCount}`);
    assert.notEqual(componentEvidence?.backgroundImage, "none", "COMMAND_CENTER_VISUAL_BACKGROUND_REQUIRED");
    assert.ok((componentEvidence?.width || 0) >= 900, `COMMAND_CENTER_WIDTH:${componentEvidence?.width}`);

    const pollToggle = page.locator('[data-testid="command-center-poll-toggle"]');
    await pollToggle.click();
    await pollToggle.getByText("恢复轮询", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    await pollToggle.click();
    await pollToggle.getByText("暂停轮询", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });

    const refreshButton = page.locator('[data-testid="command-center-refresh"]');
    await refreshButton.click();
    await refreshButton.getByText("立即刷新", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  }

  if (definition.id === "admin-payment") {
    await page.locator('[data-testid="payment-key-step-up-required"]').waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await page.locator('[data-testid="payment-config-ready"]').count(), 0, "PAYMENT_SECRET_STATE_EXPOSED_WHILE_LOCKED");
    const paymentSecretInputs = page.locator('[data-testid="payment-system-control-plane"] input[type="password"]');
    assert.equal(await paymentSecretInputs.count(), 2, "PAYMENT_SECRET_INPUT_COUNT");
    for (let index = 0; index < await paymentSecretInputs.count(); index += 1) {
      assert.equal(await paymentSecretInputs.nth(index).isDisabled(), true, `PAYMENT_SECRET_INPUT_MUST_BE_LOCKED:${index}`);
    }
    assert.equal(await page.locator('option[value="custom"]').count(), 0, "UNSUPPORTED_CUSTOM_PAYMENT_PROVIDER_VISIBLE");
    const billingSurfaceCount = await page.locator('[data-testid="payment-order-ledger"], [data-testid="payment-orders-permission-required"]').count();
    assert.equal(billingSurfaceCount, 1, `PAYMENT_BILLING_PERMISSION_STATE:${billingSurfaceCount}`);
  }

  if (definition.id === "admin-backup") {
    const backupText = await page.locator("main").innerText();
    assert.doesNotMatch(backupText, /一键恢复|恢复令牌/u, "RETIRED_RESTORE_CONTROL_VISIBLE");
    assert.equal(await page.locator('main input[type="file"]').count(), 0, "BROWSER_BACKUP_UPLOAD_MUST_BE_REMOVED");
  }

  if (definition.id === "admin-general") {
    const generalText = await page.locator("main").innerText();
    assert.doesNotMatch(generalText, /一键恢复|恢复令牌/u, "RETIRED_RESTORE_SETTING_VISIBLE");
  }
  const metrics = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const main = document.querySelector("main");
    const mainRect = main?.getBoundingClientRect();
    return {
      title: document.title,
      path: `${location.pathname}${location.search}`,
      visibleTextLength: (main?.textContent || document.body.textContent || "").replace(/\s+/gu, " ").trim().length,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      fontSize: bodyStyle.fontSize,
      mainWidth: mainRect ? Math.round(mainRect.width) : null,
      visibleDialogCount: [...document.querySelectorAll('[role="dialog"]')].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length,
    };
  });
  assert.ok(metrics.visibleTextLength >= 20, `EMPTY_PAGE:${definition.url}`);
  assert.ok(metrics.overflowX <= 1, `HORIZONTAL_OVERFLOW:${definition.url}:${metrics.overflowX}`);
  const screenshotPath = path.join(evidenceDir, `${definition.id}-1440x900.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  report.pages.push({
    ...definition,
    ...metrics,
    componentEvidence,
    screenshot: path.relative(process.cwd(), screenshotPath).replaceAll("\\", "/"),
  });
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_PREVIEW_ORIGIN_REQUIRED");
  assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });

  let browser;
  try {
    try {
      await fs.access(bundledChromium);
      browser = await chromium.launch({ headless: true, executablePath: bundledChromium });
    } catch {
      browser = await chromium.launch({ headless: true });
    }

    const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    await installReadOnlyBoundary(context);
    // The admin document is protected by the server-side page gate before
    // client localStorage exists. Mirror the verified short-lived session into
    // the same auth cookie used by real browser navigation.
    await context.addCookies([{
      name: "auth_token",
      value: token,
      url: origin,
      sameSite: "Lax",
    }]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    installDiagnostics(page, "authenticated");
    for (const definition of authenticatedPages) await samplePage(page, definition);
    await context.close();

    const publicContext = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    await installReadOnlyBoundary(publicContext);
    const loginPage = await publicContext.newPage();
    installDiagnostics(loginPage, "login");
    await samplePage(loginPage, { id: "login", url: "/login", expected: "登录" });
    await publicContext.close();

    assert.equal(report.providerRequests.length, 0, "PROVIDER_REQUEST_DETECTED");
    assert.equal(report.pageErrors.length, 0, "PAGE_ERRORS_DETECTED");
    assert.equal(report.consoleErrors.length, 0, "CONSOLE_ERRORS_DETECTED");
    assert.equal(report.serverErrors.length, 0, "SERVER_ERRORS_DETECTED");
    report.passed = true;
  } finally {
    await browser?.close().catch(() => undefined);
    report.checkedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
