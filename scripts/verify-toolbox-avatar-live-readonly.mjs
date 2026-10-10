#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_PREVIEW_REQUIRED");
assert.ok(token, "RUN_THROUGH_WITH_LOCAL_ADMIN_SESSION");

const evidenceDir = path.resolve(".codex-evidence", "toolbox-avatar-live-readonly");
const reportPath = path.join(evidenceDir, "report.json");
const presetPaths = Array.from(
  { length: 8 },
  (_, index) => `/avatars/profile-generated/profile-avatar-${String(index + 1).padStart(2, "0")}.webp`,
);
const paidPaths = [/^\/api\/(?:llm|image\/generate|video\/generate|payment|recharge)/u];
const report = {
  passed: false,
  origin,
  build: {},
  toolbox: {},
  avatar: {},
  pageErrors: [],
  httpErrors: [],
  blockedWrites: [],
  paidRequests: [],
  productionWrites: 0,
};

const json = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => null);
  return { response, body };
};

const [{ response: versionResponse, body: version }, { response: meResponse, body: me }] = await Promise.all([
  json(`${origin}/api/version`),
  json(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }),
]);
assert.ok(versionResponse.ok && version?.buildId && version?.sourceVersion, "CURRENT_BUILD_IDENTITY_REQUIRED");
assert.ok(meResponse.ok && me?.user?.id && me?.user?.role === "admin", "ACTIVE_LOCAL_ADMIN_REQUIRED");
const diskBuildId = (await fs.readFile(path.resolve(".next", "BUILD_ID"), "utf8")).trim();
assert.equal(version.buildId, diskBuildId, "SERVED_BUILD_MUST_MATCH_DISK");
report.build = { buildId: diskBuildId, sourceVersion: version.sourceVersion, runningLatest: true };

const presetResponses = await Promise.all(presetPaths.map(async presetPath => {
  const response = await fetch(`${origin}${presetPath}`, { signal: AbortSignal.timeout(20_000) });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { path: presetPath, status: response.status, type: response.headers.get("content-type"), bytes };
}));
assert.ok(presetResponses.every(item => item.status === 200 && item.type === "image/webp" && item.bytes > 0), "ALL_PRESET_AVATARS_MUST_BE_SERVABLE");

const avatarUrl = String(me.user.avatarUrl || "");
assert.match(avatarUrl, /^\/api\/avatars\?key=user-profile-avatars/u, "EXISTING_UPLOAD_MUST_USE_STABLE_FIRST_PARTY_PROXY");
assert.match(avatarUrl, /(?:\?|&)provider=(?:coze_s3|tencent_cos|local)(?:&|$)/u, "STABLE_AVATAR_PROXY_MUST_PIN_PROVIDER");
const currentAvatarResponse = await fetch(new URL(avatarUrl, origin), { signal: AbortSignal.timeout(20_000) });
const currentAvatarBytes = (await currentAvatarResponse.arrayBuffer()).byteLength;
assert.ok(currentAvatarResponse.ok && currentAvatarBytes > 0, "CURRENT_UPLOADED_AVATAR_MUST_REMAIN_READABLE");

await fs.mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(({ localToken, user }) => {
  localStorage.setItem("auth_token", localToken);
  localStorage.setItem("auth_user", JSON.stringify(user));
  localStorage.setItem("toolbox_active_tab", "format");
  sessionStorage.setItem("entered_app", "1");
}, { localToken: token, user: me.user });
await context.route("**/*", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (paidPaths.some(pattern => pattern.test(url.pathname))) {
    report.paidRequests.push({ method: request.method(), path: url.pathname });
    return route.abort("blockedbyclient");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
    report.blockedWrites.push({ method: request.method(), path: url.pathname });
    return route.abort("blockedbyclient");
  }
  return route.continue();
});

const page = await context.newPage();
page.on("pageerror", error => report.pageErrors.push(error.message));
page.on("response", response => {
  const url = new URL(response.url());
  if (url.origin === origin && response.status() >= 400) {
    report.httpErrors.push({ status: response.status(), path: url.pathname });
  }
});

try {
  await page.goto(`${origin}/tools`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("tab", { name: /文案提取/u, selected: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => new URL(location.href).searchParams.get("tab") === "text");
  assert.equal(await page.evaluate(() => localStorage.getItem("toolbox_active_tab")), "format", "STALE_TAB_MUST_NOT_BE_READ_OR_REWRITTEN");
  const directUrl = page.url();

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const primaryToolbox = page.locator('button[data-nav-key="toolbox"]');
  await primaryToolbox.waitFor({ state: "visible", timeout: 30_000 });
  await primaryToolbox.click();
  await page.waitForURL(url => url.pathname === "/tools" && url.searchParams.get("tab") === "text", { timeout: 30_000 });
  await page.getByRole("tab", { name: /文案提取/u, selected: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").waitFor({ state: "visible", timeout: 30_000 });
  const navigationUrl = page.url();
  await page.screenshot({ path: path.join(evidenceDir, "tools-default-text.png"), fullPage: false });

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const sidebarToolbox = page.locator("button.toolbox-trigger-sidebar");
  await sidebarToolbox.waitFor({ state: "visible", timeout: 30_000 });
  await sidebarToolbox.click();
  await page.waitForURL(url => url.pathname === "/tools" && url.searchParams.get("tab") === "text", { timeout: 30_000 });
  await page.getByRole("tab", { name: /文案提取/u, selected: true }).waitFor({ state: "visible", timeout: 30_000 });
  const sidebarUrl = page.url();

  await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByTestId("profile-open-avatar-settings").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("profile-open-avatar-settings").click();
  await page.getByTestId("profile-avatar-settings-dialog").waitFor({ state: "visible", timeout: 30_000 });
  const presetImages = page.getByTestId("profile-avatar-preset").locator("img");
  await presetImages.first().waitFor({ state: "visible", timeout: 30_000 });
  await presetImages.evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => undefined))));
  const presets = await presetImages.evaluateAll(images => images.map(image => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  })));
  report.avatar = { presetResponses, decodedPresets: presets };
  await page.screenshot({ path: path.join(evidenceDir, "profile-avatar-dialog.png"), fullPage: false });
  assert.equal(presets.length, 8, "PROFILE_DIALOG_MUST_SHOW_EIGHT_PRESETS");
  assert.ok(
    presets.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
    `PRESET_IMAGES_MUST_DECODE_IN_BROWSER: ${JSON.stringify(presets)}`,
  );
  const currentAvatar = await page.getByAltText("当前个人头像").evaluate(image => ({
    src: image.currentSrc || image.src,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  assert.ok(currentAvatar.src.includes("/api/avatars?key=user-profile-avatars"), "PROFILE_MUST_RENDER_STABLE_AVATAR_PROXY");
  assert.ok(currentAvatar.complete && currentAvatar.naturalWidth > 0 && currentAvatar.naturalHeight > 0, "CURRENT_AVATAR_MUST_DECODE_IN_BROWSER");

  report.toolbox = {
    directUrl,
    navigationUrl,
    sidebarUrl,
    selectedTab: "text",
    staleStoredTab: "format",
    staleTabIgnored: true,
  };
  report.avatar = {
    presetResponses,
    decodedPresetCount: presets.length,
    currentAvatarProxy: new URL(currentAvatar.src).pathname,
    currentAvatarProviderPinned: new URL(currentAvatar.src).searchParams.has("provider"),
    currentAvatarStatus: currentAvatarResponse.status,
    currentAvatarBytes,
  };
  assert.deepEqual(report.paidRequests, [], "READONLY_ACCEPTANCE_MUST_NOT_REACH_PAID_ROUTES");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS_FORBIDDEN");
  assert.deepEqual(report.httpErrors, [], "SAME_ORIGIN_HTTP_ERRORS_FORBIDDEN");
  report.passed = true;
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({
  passed: report.passed,
  build: report.build,
  toolbox: report.toolbox,
  avatar: {
    decodedPresetCount: report.avatar.decodedPresetCount,
    currentAvatarStatus: report.avatar.currentAvatarStatus,
    currentAvatarBytes: report.avatar.currentAvatarBytes,
  },
  blockedWrites: report.blockedWrites,
  paidRequests: report.paidRequests,
  evidence: reportPath,
}, null, 2));
