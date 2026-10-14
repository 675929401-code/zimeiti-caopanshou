import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
const user = JSON.parse(String(process.env.LOCAL_NAV_READONLY_CUSTOMER || "{}"));
assert.ok(token && user?.id, "LOCAL_CUSTOMER_SESSION_REQUIRED");

const diskReceipt = JSON.parse(fs.readFileSync(".next/local-source-fingerprint.v1.json", "utf8"));
const diskVersion = JSON.parse(fs.readFileSync("public/version.json", "utf8"));
const buildId = fs.readFileSync(".next/BUILD_ID", "utf8").trim();
const currentFingerprint = computeLocalBuildFingerprint(process.cwd());
const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) });
assert.ok(versionResponse.ok, "VERSION_GET_FAILED");
const servedVersion = await versionResponse.json();
assert.equal(diskReceipt.fingerprint, currentFingerprint.fingerprint, "CURRENT_SOURCE_NOT_BUILT");
assert.equal(diskReceipt.buildId, servedVersion.buildId, "CURRENT_BUILD_NOT_RUNNING");
assert.equal(buildId, servedVersion.buildId, "BUILD_ID_MISMATCH");
assert.equal(diskVersion.sourceVersion, servedVersion.sourceVersion, "SOURCE_VERSION_MISMATCH");

const botsResponse = await fetch(`${origin}/api/bots`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
});
assert.ok(botsResponse.ok, "BOTS_GET_FAILED");
const botsPayload = await botsResponse.json();
const bot = (Array.isArray(botsPayload?.bots) ? botsPayload.bots : []).find((value) => value?.id);
assert.ok(bot?.id, "LOCAL_BOT_REQUIRED");

const conversation = {
  id: "corner-fixture-conversation",
  agent_id: bot.id,
  title: "贴角删除视觉验收",
  last_message: "只读历史夹具",
  created_at: "2026-10-14T10:00:00.000Z",
  updated_at: "2026-10-14T10:05:00.000Z",
};
const detail = {
  conversation: {
    ...conversation,
    messages: [
      { id: "corner-message-1", role: "user", content: "历史夹具", created_at: conversation.created_at },
      { id: "corner-message-2", role: "assistant", content: "只读历史响应", created_at: conversation.updated_at },
    ],
  },
};
const blockedWrites = [];
const passiveTelemetry = [];
const passiveTelemetryPaths = new Set(["/api/product-usage/events", "/api/announcements/events"]);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(({ token: sessionToken, user: sessionUser }) => {
  localStorage.setItem("auth_token", sessionToken);
  localStorage.setItem("auth_user", JSON.stringify({ ...sessionUser, themePreference: "soft-white", themeModePreference: "light" }));
  localStorage.setItem("user_theme_preference", "soft-white");
  localStorage.setItem("user_theme_mode_preference", "light");
  localStorage.setItem("active_view", "marketplace");
  sessionStorage.setItem("entered_app", "1");
}, { token, user });
const page = await context.newPage();
await page.route("**/api/conversations/history**", async (route) => {
  const request = route.request();
  if (request.method() !== "GET") {
    blockedWrites.push({ method: request.method(), url: request.url() });
    return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "READ_ONLY_BROWSER_CHECK" }) });
  }
  const url = new URL(request.url());
  if (url.searchParams.has("id")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [conversation] }) });
});
await page.route("**/api/**", async (route) => {
  const request = route.request();
  if (request.method() === "GET") return route.fallback();
  const pathname = new URL(request.url()).pathname;
  const target = passiveTelemetryPaths.has(pathname) ? passiveTelemetry : blockedWrites;
  target.push({ method: request.method(), url: request.url() });
  return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "READ_ONLY_BROWSER_CHECK" }) });
});

try {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".sidebar-conv-item").first().waitFor({ state: "visible", timeout: 30_000 });
  const activeTheme = await page.locator("html").getAttribute("data-theme");
  assert.ok(["lattice", "soft-white", "crystal-aurora"].includes(activeTheme), "THEME_NOT_ACTIVE");
  assert.equal(await page.getByText("对话历史", { exact: true }).count(), 1, "HISTORY_HEADING_MISSING");
  assert.equal(await page.getByTitle("对话历史设置（仅管理员）").count(), 0, "LEGACY_T_SETTINGS_TRIGGER_PRESENT");

  const row = page.locator(".sidebar-conv-item").first();
  const deleteButton = row.locator(".sidebar-conv-delete");
  assert.equal(await deleteButton.count(), 1, "DELETE_BUTTON_MISSING");
  assert.match(await deleteButton.getAttribute("aria-label"), /删除对话/u);
  const baseStyle = await deleteButton.evaluate((element) => {
    const style = getComputedStyle(element);
    const pseudo = getComputedStyle(element, "::before");
    return {
      width: style.width,
      height: style.height,
      top: style.top,
      right: style.right,
      opacity: style.opacity,
      beforeClipPath: pseudo.clipPath,
    };
  });
  assert.equal(baseStyle.width, "34px");
  assert.equal(baseStyle.height, "34px");
  assert.equal(baseStyle.top, "3px");
  assert.equal(baseStyle.right, "3px");
  assert.match(baseStyle.beforeClipPath, /polygon/iu);
  // The local acceptance database may surface an announcement/first-entry
  // dialog before the sidebar can receive pointer events. Dismiss that
  // presentation layer; the history row itself remains read-only.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await row.hover();
  await page.waitForTimeout(220);
  assert.equal(await deleteButton.evaluate((element) => getComputedStyle(element).opacity), "1", "DELETE_BUTTON_NOT_REVEALED_ON_HOVER");
  await deleteButton.focus();
  assert.match(await deleteButton.evaluate((element) => getComputedStyle(element).outlineStyle), /solid/iu, "DELETE_BUTTON_FOCUS_NOT_VISIBLE");
  const historyBox = await page.getByText("对话历史", { exact: true }).boundingBox();
  const newChat = await page.getByRole("button", { name: /新建对话/u }).boundingBox();
  assert.ok(historyBox && newChat && historyBox.y - (newChat.y + newChat.height) < 56, "HISTORY_GAP_NOT_COMPACT");
  assert.deepEqual(blockedWrites, [], "READ_ONLY_BROWSER_EMITTED_WRITES");
  const outputDir = path.resolve(".codex-evidence/sidebar-history-delete-corner-live");
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `${activeTheme || "theme"}-light-1440x900.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    passed: true,
    runningLatest: true,
    theme: activeTheme,
    deleteCorner: baseStyle,
    hoverOpacity: "1",
    focusVisible: true,
    historyGapPx: historyBox.y - (newChat.y + newChat.height),
    blockedWrites: 0,
    passiveTelemetry: passiveTelemetry.length,
    screenshot: screenshotPath,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
