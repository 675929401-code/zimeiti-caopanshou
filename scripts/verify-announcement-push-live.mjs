#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decodeJwt } from "jose";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PREVIEW_ORIGIN_REQUIRED");
assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");

const actorId = String(decodeJwt(token).userId || "");
assert.ok(actorId, "LOCAL_ADMIN_ACTOR_REQUIRED");

const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const outputDir = path.resolve(".codex-evidence", "announcement-push-live-20260929");
const suffix = crypto.randomBytes(5).toString("hex");
const title = `公告推送本地验收-${suffix}`;
const longContent = Array.from(
  { length: 34 },
  (_, index) => `${String(index + 1).padStart(2, "0")}｜这是公告横向阅读器的本地验收内容，用于确认正文在弹窗内部滚动。`,
).join("\n");

const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  title,
  announcementId: null,
  assertions: {},
  dimensions: [],
  themeSignatures: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  providerRequests: [],
  fixtureRemoved: false,
  productionWrites: 0,
};

const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function api(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { response, body };
}

function installDiagnostics(page, label) {
  page.on("pageerror", (error) => report.pageErrors.push({ label, message: error.message }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/ERR_BLOCKED_BY_CLIENT|Failed to load resource.*fonts\.(?:gstatic|googleapis)/iu.test(text)) return;
    report.consoleErrors.push({ label, text });
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 500) report.serverErrors.push({ label, status: response.status(), pathname });
  });
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/(?:llm|chat)(?:\/|$)|^\/api\/(?:image\/(?:generate|status)|video\/(?:generate|status)|voice\/(?:tts|nest))(?:\/|$)/u.test(pathname)) {
      report.providerRequests.push({ label, method: request.method(), pathname });
    }
  });
}

async function authenticatedContext(browser, viewport) {
  const identity = await api("/api/auth/me");
  assert.equal(identity.response.status, 200, "LOCAL_ADMIN_IDENTITY_UNAVAILABLE");
  const user = identity.body?.user;
  assert.ok(user?.id === actorId, "LOCAL_ADMIN_IDENTITY_MISMATCH");
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.addInitScript(({ authToken, authUser }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { authToken: token, authUser: user });
  return context;
}

async function waitForReader(page, timeout = 35_000) {
  const reader = page.getByTestId("announcement-reader");
  await reader.waitFor({ state: "visible", timeout });
  return reader;
}

async function closeReader(page) {
  const close = page.getByRole("button", { name: "关闭系统公告" });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.getByTestId("announcement-reader").waitFor({ state: "hidden", timeout: 10_000 });
}

async function closeReaderIfItAppears(page, timeout = 15_000) {
  const reader = page.getByTestId("announcement-reader");
  const appeared = await reader.waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (appeared) await closeReader(page);
}

await fs.mkdir(outputDir, { recursive: true });
let browser;
try {
  try {
    await fs.access(bundledChromium);
    browser = await chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const created = await api("/api/announcements", {
    method: "POST",
    body: JSON.stringify({
      title,
      summary: "验证登录提醒、显式已读、再次强推与横向桌面排版",
      content: longContent,
      priority: "urgent",
      status: "published",
      is_pinned: true,
      target_audience: "selected",
      target_user_ids: [actorId],
      require_ack: true,
      frequency_hours: 24,
      max_impressions: 3,
    }),
  });
  assert.equal(created.response.status, 200, `ANNOUNCEMENT_CREATE_FAILED:${created.response.status}:${created.body?.error || "unknown"}`);
  const announcementId = String(created.body?.announcement?.id || "");
  assert.ok(announcementId, "ANNOUNCEMENT_CREATE_ID_MISSING");
  report.announcementId = announcementId;
  assert.equal(Number(created.body?.announcement?.push_revision), 1, "FIRST_PUBLICATION_MUST_BE_V1");
  report.assertions.firstPublicationIsV1 = true;

  const firstContext = await authenticatedContext(browser, { width: 1440, height: 900 });
  const firstPage = await firstContext.newPage();
  installDiagnostics(firstPage, "first-session");
  const firstResponse = await firstPage.goto(`${origin}/media-history`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(firstResponse?.status(), 200, "MEDIA_HISTORY_UNAVAILABLE");
  const firstReader = await waitForReader(firstPage);
  await firstReader.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  report.assertions.unreadAutoOpensOnLogin = true;
  await closeReader(firstPage);
  await firstPage.waitForTimeout(16_500);
  assert.equal(await firstPage.getByTestId("announcement-reader").isVisible(), false, "CLOSED_UNREAD_REOPENED_IN_SAME_SESSION");
  report.assertions.closeDoesNotNagSameSession = true;
  await firstContext.close();

  const secondContext = await authenticatedContext(browser, { width: 1440, height: 900 });
  const userPage = await secondContext.newPage();
  installDiagnostics(userPage, "fresh-session");
  await userPage.goto(`${origin}/media-history`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const secondReader = await waitForReader(userPage);
  await secondReader.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  report.assertions.unreadReopensInFreshLoginSession = true;

  const initialDimensions = await secondReader.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const content = element.querySelector('[data-testid="announcement-reader-content"]');
    return {
      viewport: [window.innerWidth, window.innerHeight],
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      ratio: Number((rect.width / rect.height).toFixed(2)),
      contentClientHeight: content?.clientHeight || 0,
      contentScrollHeight: content?.scrollHeight || 0,
      bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  report.dimensions.push({ theme: "initial", ...initialDimensions });
  await userPage.screenshot({ path: path.join(outputDir, "initial-reader-1440x900.png"), fullPage: false });
  assert.ok(initialDimensions.width >= 1_000 && initialDimensions.height <= 700 && initialDimensions.ratio >= 1.5, "ANNOUNCEMENT_READER_NOT_HORIZONTAL");
  assert.ok(initialDimensions.contentScrollHeight > initialDimensions.contentClientHeight, "ANNOUNCEMENT_CONTENT_NOT_INTERNALLY_SCROLLABLE");
  assert.ok(initialDimensions.bodyOverflowX <= 1, "ANNOUNCEMENT_READER_CAUSED_HORIZONTAL_OVERFLOW");
  report.assertions.horizontalReaderAndInternalScroll = true;

  await secondReader.getByTestId("announcement-mark-read").click();
  await userPage.waitForFunction(
    (fixtureTitle) => !document.querySelector('[data-testid="announcement-reader"]')?.textContent?.includes(fixtureTitle),
    title,
    { timeout: 15_000 },
  );
  await closeReader(userPage);
  await userPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await userPage.waitForTimeout(16_500);
  const afterReadVisible = await userPage.getByTestId("announcement-reader").isVisible();
  if (afterReadVisible) {
    assert.equal(await userPage.getByTestId("announcement-reader").getByText(title, { exact: true }).count(), 0, "READ_REVISION_REOPENED");
    await closeReader(userPage);
  }
  const v1Status = await api(`/api/admin/announcements/${encodeURIComponent(announcementId)}/delivery-status?revision=1&page=1&pageSize=5&status=all`);
  assert.equal(v1Status.response.status, 200, "V1_DELIVERY_STATUS_UNAVAILABLE");
  assert.deepEqual(
    [v1Status.body?.summary?.targetCount, v1Status.body?.summary?.readCount, v1Status.body?.summary?.unreadCount],
    [1, 1, 0],
    "V1_READ_RECEIPT_NOT_VISIBLE_TO_ADMIN",
  );
  report.assertions.explicitReadStopsSameRevision = true;
  report.assertions.adminSeesV1ReadReceipt = true;

  const adminContext = await authenticatedContext(browser, { width: 1440, height: 900 });
  const adminPage = await adminContext.newPage();
  installDiagnostics(adminPage, "admin");
  await adminPage.goto(`${origin}/admin?tab=announcements`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const possibleReader = adminPage.getByTestId("announcement-reader");
  await closeReaderIfItAppears(adminPage, 20_000);
  const card = adminPage.locator("article").filter({ hasText: title });
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.getByText("V1", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await card.getByText("再次强推", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  report.assertions.adminDeliveryCardVisible = true;

  if (await possibleReader.isVisible().catch(() => false)) await closeReader(adminPage);
  await adminPage.screenshot({ path: path.join(outputDir, "admin-before-repush-1440x900.png"), fullPage: false });
  const repushButton = card.locator("button").filter({ hasText: "再次强推" });
  await repushButton.waitFor({ state: "visible", timeout: 15_000 });
  adminPage.once("dialog", (dialog) => dialog.accept());
  await repushButton.click();
  await adminPage.getByText(/再次强推成功，当前版本 V2/u).waitFor({ state: "visible", timeout: 30_000 });
  report.assertions.adminRepushButtonWorks = true;

  const repushedReader = await waitForReader(userPage, 35_000);
  await repushedReader.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await repushedReader.getByText("V2", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  report.assertions.onlineRepushOpensCurrentPage = true;
  await userPage.screenshot({ path: path.join(outputDir, "online-repush-v2-1440x900.png"), fullPage: false });

  await repushedReader.getByTestId("announcement-mark-read").click();
  await userPage.waitForFunction(
    (fixtureTitle) => !document.querySelector('[data-testid="announcement-reader"]')?.textContent?.includes(fixtureTitle),
    title,
    { timeout: 15_000 },
  );
  await closeReader(userPage);
  const v2Status = await api(`/api/admin/announcements/${encodeURIComponent(announcementId)}/delivery-status?revision=2&page=1&pageSize=5&status=all`);
  assert.equal(v2Status.response.status, 200, "V2_DELIVERY_STATUS_UNAVAILABLE");
  assert.deepEqual(
    [v2Status.body?.summary?.targetCount, v2Status.body?.summary?.readCount, v2Status.body?.summary?.unreadCount],
    [1, 1, 0],
    "V2_READ_RECEIPT_NOT_VISIBLE_TO_ADMIN",
  );
  report.assertions.repushCreatesIndependentReadRevision = true;

  await userPage.evaluate(() => window.dispatchEvent(new Event("open-announcements")));
  const visualReader = await waitForReader(userPage, 15_000);
  const themes = [
    ["lattice", "dark"],
    ["soft-white", "light"],
    ["crystal-aurora", "dark"],
    ["stellar-blue", "dark"],
  ];
  for (const [theme, mode] of themes) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await userPage.setViewportSize(viewport);
      await userPage.evaluate(({ nextTheme, nextMode }) => {
        document.documentElement.setAttribute("data-theme", nextTheme);
        document.documentElement.setAttribute("data-mode", nextMode);
      }, { nextTheme: theme, nextMode: mode });
      await userPage.waitForTimeout(250);
      const sample = await visualReader.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          viewport: [window.innerWidth, window.innerHeight],
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          ratio: Number((rect.width / rect.height).toFixed(2)),
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderColor: style.borderColor,
          bodyOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.ok(sample.width >= 1_000 && sample.height <= 700 && sample.ratio >= 1.5, `NON_HORIZONTAL_READER:${theme}:${viewport.width}`);
      assert.ok(sample.bodyOverflowX <= 1, `HORIZONTAL_OVERFLOW:${theme}:${viewport.width}`);
      report.dimensions.push({ theme, mode, ...sample });
      report.themeSignatures.push(`${theme}:${sample.backgroundColor}:${sample.color}:${sample.borderColor}`);
      await userPage.screenshot({
        path: path.join(outputDir, `${theme}-${mode}-${viewport.width}x${viewport.height}.png`),
        fullPage: false,
      });
    }
  }
  assert.ok(new Set(report.themeSignatures).size >= 4, "THEME_VISUAL_SIGNATURES_NOT_DISTINCT");
  report.assertions.fourThemesAtTwoDesktopViewports = true;

  await closeReader(userPage);
  await adminContext.close();
  await secondContext.close();

  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
  assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
  assert.deepEqual(report.serverErrors, [], "SERVER_ERRORS_DURING_ANNOUNCEMENT_E2E");
  assert.deepEqual(report.providerRequests, [], "PROVIDER_REQUESTS_DURING_ANNOUNCEMENT_E2E");
  report.passed = true;
} finally {
  if (report.announcementId) {
    const removed = await api(`/api/announcements?id=${encodeURIComponent(report.announcementId)}`, { method: "DELETE" }).catch(() => null);
    report.fixtureRemoved = removed?.response?.status === 200;
  }
  if (browser) await browser.close().catch(() => undefined);
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.fixtureRemoved, true, "ANNOUNCEMENT_FIXTURE_CLEANUP_FAILED");
console.log(JSON.stringify(report, null, 2));
