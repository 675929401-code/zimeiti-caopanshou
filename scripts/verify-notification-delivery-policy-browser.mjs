#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

// Browser acceptance for the account-notification delivery policy. The inbox
// and read receipt are kept in this browser process: no database, provider,
// billing, administrator write, or production endpoint is touched.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const VIEWPORT = { width: 1440, height: 900 };
const TOKEN = "notification-delivery-browser-fixture-token";
const FIXTURE_USER = {
  id: "notification-delivery-browser-fixture-user",
  username: "notification_delivery_fixture",
  displayName: "通知策略浏览器验收",
  email: "notification-delivery@example.invalid",
  role: "admin",
  status: "active",
  is_active: true,
  credits: 0,
  themePreference: "soft-white",
  theme_preference: "soft-white",
  themeModePreference: "light",
  theme_mode_preference: "light",
};
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PAID_PATH = /^\/api\/(?:chat|image\/generate|llm|storyboard\/(?:generate|render)|video\/generate|voice\/tts)(?:\/|$)/u;
const THEME_VISUALS = [
  { id: "soft-white", mode: "light", style: "01-ivory" },
  { id: "crystal-aurora", mode: "dark", style: "02-mist" },
  { id: "lattice", mode: "dark", style: "04-editorial" },
];
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.join(ROOT, ".codex-evidence", "notification-delivery-policy-browser", stamp);
const reportPath = path.join(evidenceDir, "report.json");

function notice(id, title, createdAt) {
  return {
    id,
    type: "system",
    title,
    content: `${title}：这是一条只存在于浏览器内存中的验收消息。`,
    has_cami_code: false,
    is_read: false,
    created_at: createdAt,
    read_at: null,
    metadata: { fixture: true },
  };
}

function announcement(id, title, createdAt) {
  return {
    id,
    title,
    summary: `${title}摘要`,
    content: `${title}：这是一条只存在于浏览器内存中的验收公告。`,
    priority: "normal",
    status: "published",
    is_pinned: false,
    target_audience: "all",
    target_user_ids: [],
    require_ack: true,
    frequency_hours: 24,
    max_impressions: 3,
    link_url: "",
    link_text: "",
    created_at: createdAt,
    updated_at: createdAt,
    published_at: createdAt,
    push_revision: 1,
    is_read: false,
    read_at: null,
  };
}

const offlineNewest = notice("fixture-offline-newest", "离线未读一号", "2026-10-09T01:02:00.000Z");
const offlineOlder = notice("fixture-offline-older", "离线未读二号", "2026-10-09T01:01:00.000Z");
const onlineNewest = notice("fixture-online-newest", "在线新增三号", "2026-10-09T01:03:00.000Z");
let inbox = [offlineNewest, offlineOlder];
const accountReadOutcomes = ["http-failure", "invalid-200", "success"];
const announcementOfflineNewest = announcement("fixture-announcement-offline-newest", "离线公告一号", "2026-10-09T02:02:00.000Z");
const announcementOfflineOlder = announcement("fixture-announcement-offline-older", "离线公告二号", "2026-10-09T02:01:00.000Z");
const announcementOnlineNewest = announcement("fixture-announcement-online-newest", "在线公告三号", "2026-10-09T02:03:00.000Z");
let announcementInbox = [];
const announcementReadOutcomes = ["http-failure", "invalid-200", "success"];
const concurrentAccount = notice("fixture-concurrent-account", "并发账号提醒", "2026-10-09T03:01:00.000Z");
const concurrentAnnouncement = announcement("fixture-concurrent-announcement", "并发公告提醒", "2026-10-09T03:02:00.000Z");

const report = {
  schemaVersion: 1,
  suite: "notification-delivery-policy-browser-fixture",
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  viewport: VIEWPORT,
  runtime: {},
  assertions: {},
  inboxReads: 0,
  announcementInboxReads: 0,
  readAttempts: [],
  announcementReadAttempts: [],
  fixtureMutations: [],
  escapedMutations: [],
  paidRequests: [],
  externalRequests: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  screenshots: [],
  themeVisuals: [],
  databaseWrites: 0,
  businessWrites: 0,
  productionWrites: 0,
  paidCalls: 0,
  expectedContracts: [
    "HTTP 200 with success:false must not mutate local read state",
    "account and announcement toasts must be mutually exclusive without dropping the suppressed item",
  ],
  passed: false,
  failure: null,
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function unreadCount() {
  return inbox.filter((item) => !item.is_read).length;
}

function announcementUnreadCount() {
  return announcementInbox.filter((item) => !item.is_read).length;
}

async function assertTitle(surface, title, code) {
  await surface.getByText(title, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await surface.getByText(title, { exact: true }).count(), 1, code);
}

async function captureThemeSurface(page, surface, kind, theme) {
  await page.evaluate(({ id, mode }) => {
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.mode = mode;
  }, theme);
  await page.waitForTimeout(120);
  const metrics = await surface.evaluate((element, surfaceKind) => {
    const text = element.querySelector(surfaceKind === "reader" ? ".announcement-reader-body p" : ".announcement-toast-body p")
      || element.querySelector("p")
      || element;
    const backdrop = element.querySelector(surfaceKind === "reader" ? ".announcement-reader-body" : ".announcement-toast-body")
      || element;
    const parseRgb = (value) => {
      const channels = String(value).match(/[\d.]+/gu)?.slice(0, 3).map(Number) || [];
      return channels.length === 3 ? channels : null;
    };
    const luminance = (channels) => {
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const foreground = getComputedStyle(text).color;
    const background = getComputedStyle(backdrop).backgroundColor;
    const fg = parseRgb(foreground);
    const bg = parseRgb(background);
    const contrast = fg && bg
      ? (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05)
      : 0;
    const rect = element.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme || "",
      mode: document.documentElement.dataset.mode || "",
      foreground,
      background,
      contrast,
      box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  }, kind);
  assert.equal(metrics.theme, theme.id, `THEME_NOT_APPLIED:${kind}:${theme.id}`);
  assert.ok(metrics.contrast >= 4.5, `TEXT_CONTRAST_BELOW_4_5:${kind}:${theme.id}:${metrics.contrast}`);
  assert.ok(metrics.box.left >= 0 && metrics.box.top >= 0, `SURFACE_CLIPPED_START:${kind}:${theme.id}`);
  assert.ok(metrics.box.right <= metrics.viewport.width + 1 && metrics.box.bottom <= metrics.viewport.height + 1, `SURFACE_CLIPPED_END:${kind}:${theme.id}`);
  assert.ok(metrics.horizontalOverflow <= 1, `PAGE_HORIZONTAL_OVERFLOW:${kind}:${theme.id}:${metrics.horizontalOverflow}`);
  const screenshot = path.join(evidenceDir, `theme-${theme.id}-${kind}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  const relativeScreenshot = path.relative(ROOT, screenshot).split(path.sep).join("/");
  report.screenshots.push(relativeScreenshot);
  report.themeVisuals.push({ kind, style: theme.style, ...metrics, screenshot: relativeScreenshot });
}

await fs.mkdir(evidenceDir, { recursive: true });
let browser;
let context;
try {
  assert.equal(ORIGIN, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  const [versionResponse, receiptText, diskBuildId, sourceFingerprint] = await Promise.all([
    fetch(`${ORIGIN}/api/version`, { signal: AbortSignal.timeout(15_000) }),
    fs.readFile(path.join(ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8"),
    fs.readFile(path.join(ROOT, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(ROOT)),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const version = await versionResponse.json();
  const receipt = JSON.parse(receiptText);
  const servedBuildId = String(version.buildId || version.version || "");
  const sourceFingerprintCurrent = receipt.fingerprint === sourceFingerprint.fingerprint
    && receipt.fileCount === sourceFingerprint.fileCount;
  const runningLatest = sourceFingerprintCurrent
    && receipt.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  report.runtime = {
    sourceVersion: version.sourceVersion || null,
    servedBuildId,
    diskBuildId,
    sourceFingerprint: sourceFingerprint.fingerprint,
    sourceFingerprintCurrent,
    runningLatest,
  };
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");

  const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
  browser = await fs.access(bundledChromium)
    .then(() => chromium.launch({ headless: true, executablePath: bundledChromium }))
    .catch(() => chromium.launch({ headless: true }));
  context = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });

  await context.addInitScript(({ origin, token, user }) => {
    if (location.origin !== origin) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { origin: ORIGIN, token: TOKEN, user: FIXTURE_USER });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (!["http:", "https:"].includes(url.protocol)) return route.continue();
    if (url.origin !== ORIGIN) {
      report.externalRequests.push({ method, url: request.url() });
      return route.abort("blockedbyclient");
    }
    if (PAID_PATH.test(url.pathname)) {
      report.paidRequests.push({ method, pathname: url.pathname });
      return json(route, { error: "PAID_REQUEST_BLOCKED_BY_FIXTURE" }, 409);
    }

    if (method === "GET" && url.pathname === "/api/auth/me") return json(route, { user: FIXTURE_USER });
    if (method === "GET" && url.pathname === "/api/notifications/user") {
      report.inboxReads += 1;
      return json(route, { success: true, notifications: inbox, total: inbox.length, unreadCount: unreadCount() });
    }
    if (method === "PUT" && url.pathname === "/api/notifications/user") {
      const body = request.postDataJSON();
      const id = String(body?.notificationId || "");
      const outcome = accountReadOutcomes.shift() || "success";
      const attempt = { id, outcome };
      report.readAttempts.push(attempt);
      report.fixtureMutations.push({ method, pathname: url.pathname, body, interceptedBeforeServer: true });
      if (outcome === "http-failure") {
        return json(route, { error: "验收夹具模拟保存失败" }, 503);
      }
      if (outcome === "invalid-200") {
        return json(route, { success: false, error: "验收夹具模拟无效业务回执" }, 200);
      }
      inbox = inbox.map((item) => item.id === id
        ? { ...item, is_read: true, read_at: "2026-10-09T01:04:00.000Z" }
        : item);
      return json(route, {
        success: true,
        status: "read",
        notificationId: id,
        readAt: "2026-10-09T01:04:00.000Z",
      });
    }
    if (method === "GET" && url.pathname === "/api/announcements/inbox") {
      report.announcementInboxReads += 1;
      return json(route, {
        announcements: announcementInbox,
        unreadCount: announcementUnreadCount(),
        cursor: `fixture-${report.announcementInboxReads}`,
      });
    }
    if (method === "POST" && /^\/api\/announcements\/[^/]+\/read$/u.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2) || "");
      const body = request.postDataJSON();
      const outcome = announcementReadOutcomes.shift() || "success";
      const attempt = { id, revision: Number(body?.revision || 0), outcome };
      report.announcementReadAttempts.push(attempt);
      report.fixtureMutations.push({ method, pathname: url.pathname, body, interceptedBeforeServer: true });
      if (outcome === "http-failure") {
        return json(route, { error: "验收夹具模拟公告保存失败" }, 503);
      }
      if (outcome === "invalid-200") {
        return json(route, { success: false, error: "验收夹具模拟公告无效业务回执" }, 200);
      }
      announcementInbox = announcementInbox.map((item) => item.id === id
        ? { ...item, is_read: true, read_at: "2026-10-09T02:04:00.000Z" }
        : item);
      return json(route, {
        success: true,
        announcementId: id,
        revision: Number(body?.revision || 0),
        readAt: "2026-10-09T02:04:00.000Z",
        alreadyRead: false,
        status: "read",
      });
    }
    if (method === "POST" && url.pathname === "/api/announcements/events") {
      report.fixtureMutations.push({ method, pathname: url.pathname, body: request.postDataJSON(), interceptedBeforeServer: true, analytics: true });
      return json(route, { accepted: true }, 202);
    }
    if (method === "GET" && url.pathname === "/api/settings") {
      return json(route, { settings: { theme: "soft-white", theme_mode: "light" } });
    }
    if (method === "GET" && url.pathname === "/api/settings/appearance") {
      return json(route, { settings: { theme: "soft-white", theme_mode: "light" } });
    }
    if (method === "GET" && url.pathname === "/api/settings/layout") return json(route, { layout: null });
    if (method === "GET" && url.pathname === "/api/settings/ui-preferences") return json(route, { preferences: {} });
    if (method === "GET" && url.pathname === "/api/bots") {
      return json(route, { agents: [], navigationKeys: [] });
    }
    if (method === "GET" && url.pathname === "/api/credits") {
      return json(route, { credits: 0, cashBalance: 0, transactions: [] });
    }
    if (method === "GET" && url.pathname === "/api/member-permissions") {
      return json(route, {
        permission: {
          userId: FIXTURE_USER.id,
          role: "admin",
          featureNavigationKeys: ["marketplace", "toolbox"],
          agentNavigationKeys: [],
          revision: 1,
          checksum: "notification-delivery-browser-fixture",
          integrityValid: true,
          authorityStatus: "admin",
        },
      });
    }
    if (method === "GET" && url.pathname === "/api/video/active-tasks") return json(route, { activeTasks: [] });
    if (method === "POST" && url.pathname === "/api/product-usage/events") {
      report.fixtureMutations.push({ method, pathname: url.pathname, interceptedBeforeServer: true, telemetry: true });
      return json(route, { accepted: true }, 202);
    }
    if (method === "POST" && url.pathname === "/api/operation-events") {
      report.fixtureMutations.push({ method, pathname: url.pathname, interceptedBeforeServer: true, telemetry: true });
      return json(route, { accepted: true }, 202);
    }
    if (MUTATING_METHODS.has(method)) {
      report.escapedMutations.push({ method, pathname: url.pathname });
      return json(route, { error: "UNEXPECTED_MUTATION_BLOCKED_BY_FIXTURE" }, 409);
    }
    return route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/ERR_BLOCKED_BY_CLIENT|Failed to load resource/iu.test(text)) return;
    report.consoleErrors.push(text);
  });
  page.on("response", (response) => {
    if (response.status() >= 500 && new URL(response.url()).pathname !== "/api/notifications/user") {
      report.serverErrors.push({ status: response.status(), pathname: new URL(response.url()).pathname });
    }
  });

  const navigation = await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(navigation?.status(), 200, `HOME_HTTP_${navigation?.status() ?? "NO_RESPONSE"}`);
  await page.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });

  const dialog = page.getByTestId("account-notification-dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await assertTitle(dialog, offlineNewest.title, "FIRST_BACKLOG_ITEM_NOT_SELECTED");
  await dialog.getByText("2 条未读", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("account-notification-toast").isVisible(), false, "BACKLOG_MUST_NOT_START_AS_TOAST");
  report.assertions.firstOfflineUnreadOpensReader = true;

  const previous = dialog.getByRole("button", { name: "上一条", exact: true });
  const next = dialog.getByRole("button", { name: "下一条", exact: true });
  assert.equal(await previous.isEnabled(), true, "PREVIOUS_ITEM_SHOULD_BE_AVAILABLE");
  assert.equal(await next.isDisabled(), true, "NEXT_ITEM_SHOULD_START_DISABLED");
  await previous.click();
  await assertTitle(dialog, offlineOlder.title, "PREVIOUS_ITEM_DID_NOT_NAVIGATE");
  assert.equal(await next.isEnabled(), true, "NEXT_ITEM_SHOULD_ENABLE_AFTER_PREVIOUS");
  await next.click();
  await assertTitle(dialog, offlineNewest.title, "NEXT_ITEM_DID_NOT_RETURN");
  report.assertions.previousAndNextNavigateMultipleItems = true;

  await dialog.getByRole("button", { name: "关闭账号消息", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  const toast = page.getByTestId("account-notification-toast");
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(toast, offlineNewest.title, "CLOSE_DID_NOT_PRESERVE_UNREAD_TOAST");
  assert.equal(report.readAttempts.length, 0, "CLOSE_MUST_NOT_WRITE_READ_RECEIPT");
  report.assertions.closeKeepsUnreadAndCompactReminder = true;

  await toast.getByRole("button", { name: "详情", exact: true }).click();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(dialog, offlineNewest.title, "DETAIL_DID_NOT_REOPEN_SAME_ITEM");
  report.assertions.detailsReturnToSameItem = true;

  await dialog.getByRole("button", { name: "关闭账号消息", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  inbox = [onlineNewest, ...inbox];
  await page.evaluate(() => window.dispatchEvent(new Event("refresh-account-notifications")));
  await toast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(toast, onlineNewest.title, "ONLINE_ITEM_DID_NOT_USE_TOAST");
  assert.equal(await dialog.isVisible(), false, "ONLINE_ITEM_MUST_NOT_AUTO_OPEN_READER");
  report.assertions.onlineArrivalOnlyShowsCompactReminder = true;

  await toast.getByRole("button", { name: "详情", exact: true }).click();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(dialog, onlineNewest.title, "ONLINE_DETAIL_LOST_SELECTED_ID");
  await dialog.getByRole("button", { name: "知道了", exact: true }).click();
  await dialog.getByRole("alert").getByText(/保存失败/u).waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByText("3 条未读", { exact: true }).waitFor({ state: "visible" });
  await assertTitle(dialog, onlineNewest.title, "FAILED_ACK_ADVANCED_SELECTION");
  assert.equal(inbox.find((item) => item.id === onlineNewest.id)?.is_read, false, "FAILED_ACK_MUTATED_FIXTURE_STATE");
  report.assertions.failedAcknowledgementKeepsUnreadAndSelection = true;

  await dialog.getByRole("button", { name: "知道了", exact: true }).click();
  await dialog.getByRole("alert").getByText(/无效业务回执/u).waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByText("3 条未读", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(dialog, onlineNewest.title, "INVALID_200_ACK_ADVANCED_SELECTION");
  assert.equal(inbox.find((item) => item.id === onlineNewest.id)?.is_read, false, "INVALID_200_ACK_MUTATED_FIXTURE_STATE");
  report.assertions.invalid200AcknowledgementKeepsUnreadAndSelection = true;

  await dialog.getByRole("button", { name: "知道了", exact: true }).click();
  await dialog.getByText("2 条未读", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(dialog, offlineNewest.title, "SUCCESSFUL_ACK_DID_NOT_ADVANCE_TO_NEXT_UNREAD");
  assert.equal(inbox.find((item) => item.id === onlineNewest.id)?.is_read, true, "SUCCESSFUL_ACK_DID_NOT_MARK_FIXTURE_READ");
  assert.deepEqual(report.readAttempts.slice(0, 3), [
    { id: onlineNewest.id, outcome: "http-failure" },
    { id: onlineNewest.id, outcome: "invalid-200" },
    { id: onlineNewest.id, outcome: "success" },
  ], "ACK_RETRY_SEQUENCE_MISMATCH");
  report.assertions.successfulAcknowledgementDecrementsAndAdvances = true;

  const accountScreenshot = path.join(evidenceDir, "account-notification-policy-after-success.png");
  await page.screenshot({ path: accountScreenshot, fullPage: false });
  report.screenshots.push(path.relative(ROOT, accountScreenshot).split(path.sep).join("/"));

  // Run the same delivery contract through the platform-announcement surface
  // in a fresh tab session. Account fixtures are now read so the P1 account
  // dialog cannot mask the P3 announcement reader.
  await page.close();
  inbox = inbox.map((item) => ({ ...item, is_read: true, read_at: "2026-10-09T01:05:00.000Z" }));
  announcementInbox = [announcementOfflineNewest, announcementOfflineOlder];
  const announcementPage = await context.newPage();
  announcementPage.on("pageerror", (error) => report.pageErrors.push(error.message));
  announcementPage.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/ERR_BLOCKED_BY_CLIENT|Failed to load resource/iu.test(text)) return;
    report.consoleErrors.push(text);
  });
  announcementPage.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 500 && !/^\/api\/announcements\/[^/]+\/read$/u.test(pathname)) {
      report.serverErrors.push({ status: response.status(), pathname });
    }
  });
  const announcementNavigation = await announcementPage.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(announcementNavigation?.status(), 200, `ANNOUNCEMENT_HOME_HTTP_${announcementNavigation?.status() ?? "NO_RESPONSE"}`);
  await announcementPage.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });

  const reader = announcementPage.getByTestId("announcement-reader");
  await reader.waitFor({ state: "visible", timeout: 30_000 });
  await assertTitle(reader, announcementOfflineNewest.title, "ANNOUNCEMENT_FIRST_BACKLOG_ITEM_NOT_SELECTED");
  await reader.getByText("2 条未读", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await announcementPage.getByTestId("announcement-online-toast").isVisible(), false, "ANNOUNCEMENT_BACKLOG_MUST_NOT_START_AS_TOAST");
  report.assertions.announcementFirstOfflineUnreadOpensReader = true;
  for (const theme of THEME_VISUALS) await captureThemeSurface(announcementPage, reader, "reader", theme);

  const announcementPrevious = reader.getByTestId("announcement-previous");
  const announcementNext = reader.getByTestId("announcement-next");
  assert.equal(await announcementPrevious.isEnabled(), true, "ANNOUNCEMENT_PREVIOUS_SHOULD_BE_AVAILABLE");
  assert.equal(await announcementNext.isDisabled(), true, "ANNOUNCEMENT_NEXT_SHOULD_START_DISABLED");
  await announcementPrevious.click();
  await assertTitle(reader, announcementOfflineOlder.title, "ANNOUNCEMENT_PREVIOUS_DID_NOT_NAVIGATE");
  await announcementNext.click();
  await assertTitle(reader, announcementOfflineNewest.title, "ANNOUNCEMENT_NEXT_DID_NOT_RETURN");
  report.assertions.announcementPreviousAndNextNavigateMultipleItems = true;

  await reader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
  await reader.waitFor({ state: "hidden", timeout: 10_000 });
  const announcementToast = announcementPage.getByTestId("announcement-online-toast");
  await announcementToast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(announcementToast, announcementOfflineNewest.title, "ANNOUNCEMENT_CLOSE_DID_NOT_KEEP_TOAST");
  assert.equal(report.announcementReadAttempts.length, 0, "ANNOUNCEMENT_CLOSE_MUST_NOT_WRITE_READ_RECEIPT");
  report.assertions.announcementCloseKeepsUnreadAndCompactReminder = true;

  await announcementToast.getByRole("button", { name: "详情", exact: true }).click();
  await reader.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(reader, announcementOfflineNewest.title, "ANNOUNCEMENT_DETAIL_DID_NOT_REOPEN_SAME_ITEM");
  report.assertions.announcementDetailsReturnToSameItem = true;

  await reader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
  await reader.waitFor({ state: "hidden", timeout: 10_000 });
  announcementInbox = [announcementOnlineNewest, ...announcementInbox];
  await announcementPage.evaluate(() => window.dispatchEvent(new Event("refresh-announcements")));
  await announcementToast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(announcementToast, announcementOnlineNewest.title, "ONLINE_ANNOUNCEMENT_DID_NOT_USE_TOAST");
  assert.equal(await reader.isVisible(), false, "ONLINE_ANNOUNCEMENT_MUST_NOT_AUTO_OPEN_READER");
  report.assertions.announcementOnlineArrivalOnlyShowsCompactReminder = true;

  await announcementToast.getByRole("button", { name: "详情", exact: true }).click();
  await reader.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(reader, announcementOnlineNewest.title, "ONLINE_ANNOUNCEMENT_DETAIL_LOST_ID");
  await reader.getByTestId("announcement-mark-read").click();
  await reader.getByRole("alert").getByText("验收夹具模拟公告保存失败", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await reader.getByText("3 条未读", { exact: true }).waitFor({ state: "visible" });
  await assertTitle(reader, announcementOnlineNewest.title, "FAILED_ANNOUNCEMENT_ACK_ADVANCED_SELECTION");
  report.assertions.announcementFailedAcknowledgementKeepsUnreadAndSelection = true;

  await reader.getByTestId("announcement-mark-read").click();
  await reader.getByRole("alert").getByText(/无效业务回执/u).waitFor({ state: "visible", timeout: 10_000 });
  await reader.getByText("3 条未读", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(reader, announcementOnlineNewest.title, "INVALID_200_ANNOUNCEMENT_ACK_ADVANCED_SELECTION");
  assert.equal(announcementInbox.find((item) => item.id === announcementOnlineNewest.id)?.is_read, false, "INVALID_200_ANNOUNCEMENT_ACK_MUTATED_FIXTURE_STATE");
  report.assertions.announcementInvalid200AcknowledgementKeepsUnreadAndSelection = true;

  await reader.getByTestId("announcement-mark-read").click();
  await reader.getByText("2 条未读", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(reader, announcementOfflineNewest.title, "SUCCESSFUL_ANNOUNCEMENT_ACK_DID_NOT_ADVANCE");
  assert.equal(announcementInbox.find((item) => item.id === announcementOnlineNewest.id)?.is_read, true, "SUCCESSFUL_ANNOUNCEMENT_ACK_DID_NOT_MARK_FIXTURE_READ");
  assert.deepEqual(report.announcementReadAttempts.slice(0, 3), [
    { id: announcementOnlineNewest.id, revision: 1, outcome: "http-failure" },
    { id: announcementOnlineNewest.id, revision: 1, outcome: "invalid-200" },
    { id: announcementOnlineNewest.id, revision: 1, outcome: "success" },
  ], "ANNOUNCEMENT_ACK_RETRY_SEQUENCE_MISMATCH");
  report.assertions.announcementSuccessfulAcknowledgementDecrementsAndAdvances = true;

  // Concurrent delivery must arbitrate to one compact surface and then resume
  // the suppressed item after the visible winner is acknowledged. A later
  // claim may hide a toast, but it must never discard the underlying unread.
  await reader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
  await reader.waitFor({ state: "hidden", timeout: 10_000 });
  announcementInbox = announcementInbox.map((item) => ({ ...item, is_read: true, read_at: "2026-10-09T02:05:00.000Z" }));
  inbox = [concurrentAccount, ...inbox];
  await announcementPage.evaluate(() => window.dispatchEvent(new Event("refresh-account-notifications")));
  const accountToast = announcementPage.getByTestId("account-notification-toast");
  await accountToast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(accountToast, concurrentAccount.title, "CONCURRENT_ACCOUNT_TOAST_NOT_READY");

  announcementInbox = [concurrentAnnouncement, ...announcementInbox];
  await announcementPage.evaluate(() => window.dispatchEvent(new Event("refresh-announcements")));
  await announcementPage.waitForTimeout(250);
  await assertTitle(accountToast, concurrentAccount.title, "ACCOUNT_PRIORITY_TOAST_WAS_PREMATURELY_REPLACED");
  assert.equal(await announcementToast.isVisible(), false, "ACCOUNT_AND_ANNOUNCEMENT_TOASTS_OVERLAPPED");
  assert.equal(
    await announcementPage.locator('[data-testid="account-notification-toast"]:visible, [data-testid="announcement-online-toast"]:visible').count(),
    1,
    "CONCURRENT_DELIVERY_MUST_HAVE_EXACTLY_ONE_VISIBLE_TOAST",
  );
  report.assertions.concurrentDeliveryHasSingleVisibleToast = true;

  await accountToast.getByRole("button", { name: "知道了", exact: true }).click();
  await announcementToast.waitFor({ state: "visible", timeout: 10_000 });
  await assertTitle(announcementToast, concurrentAnnouncement.title, "SUPPRESSED_ANNOUNCEMENT_TOAST_WAS_DROPPED");
  assert.equal(await accountToast.isVisible(), false, "ACKNOWLEDGED_ACCOUNT_TOAST_REMAINED_VISIBLE");
  report.assertions.concurrentDeliveryResumesSuppressedToast = true;
  for (const theme of THEME_VISUALS) await captureThemeSurface(announcementPage, announcementToast, "toast", theme);

  const announcementScreenshot = path.join(evidenceDir, "announcement-policy-after-success.png");
  await announcementPage.screenshot({ path: announcementScreenshot, fullPage: false });
  report.screenshots.push(path.relative(ROOT, announcementScreenshot).split(path.sep).join("/"));
  assert.deepEqual(report.escapedMutations, [], "UNEXPECTED_BROWSER_MUTATIONS");
  assert.deepEqual(report.paidRequests, [], "PAID_REQUESTS_DURING_NOTIFICATION_FIXTURE");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
  assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
  assert.deepEqual(report.serverErrors, [], "UNEXPECTED_SERVER_ERRORS");
  report.passed = true;
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  throw error;
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath: path.relative(ROOT, reportPath).split(path.sep).join("/") }, null, 2));
}
