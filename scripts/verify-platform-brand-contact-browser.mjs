#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(".codex-evidence/platform-brand-contact-browser");
const viewport = { width: 1440, height: 900 };
const themes = [
  { id: "lattice", mode: "dark" },
  { id: "soft-white", mode: "light" },
  { id: "crystal-aurora", mode: "dark" },
];
const token = "brand-contact-browser-fixture-token";
const user = {
  id: "brand-contact-browser-fixture-user",
  username: "brand_contact_fixture",
  displayName: "品牌联系验收夹具",
  role: "admin",
  status: "active",
  is_active: true,
  credits: 0,
};
const wechat = "wx_fixture_2026";
const qrSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/><path fill="#101820" d="M4 4h20v20H4zm36 0h20v20H40zM4 40h20v20H4zm28-8h8v8h-8zm12 0h8v8h-8zm-12 12h8v16h-8zm12 0h16v8H44zm8 12h8v4h-8z"/><rect x="9" y="9" width="10" height="10" fill="#fff"/><rect x="45" y="9" width="10" height="10" fill="#fff"/><rect x="9" y="45" width="10" height="10" fill="#fff"/></svg>`;
const branding = {
  displayScope: "platform",
  hostname: "127.0.0.1",
  source: "published",
  generation: 7,
  revisionId: "brand-contact-browser-fixture-revision",
  revisionVersion: 7,
  publishedAt: "2026-10-10T00:00:00.000+08:00",
  brand: {
    schema: "platform-brand/v1",
    name: "智能体操盘手",
    shortName: "操盘手",
    slogan: "AI 内容经营系统",
    welcomeMessage: "欢迎使用",
    description: "把洞察、创作、生产和经营数据沉淀为可持续复用的内容资产。",
    seo: { title: "智能体操盘手", description: "AI 内容经营系统" },
    colors: { primary: "#168D7A", accent: "#2F80FF" },
    contact: {
      name: "平台服务顾问",
      wechat,
      phone: "010-5550-2026",
      email: "service@example.test",
    },
    assetIds: {
      contact_wechat_qr_primary: "fixture-qr-primary",
      contact_wechat_qr_secondary: "fixture-qr-secondary",
    },
  },
  assets: {
    contact_wechat_qr_primary: {
      id: "fixture-qr-primary",
      purpose: "contact_wechat_qr_primary",
      url: "/api/branding/assets/fixture-qr-primary?revision=brand-contact-browser-fixture-revision",
      mimeType: "image/svg+xml",
      width: 64,
      height: 64,
      bytes: qrSvg.length,
      sha256: "fixture-primary",
    },
    contact_wechat_qr_secondary: {
      id: "fixture-qr-secondary",
      purpose: "contact_wechat_qr_secondary",
      url: "/api/branding/assets/fixture-qr-secondary?revision=brand-contact-browser-fixture-revision",
      mimeType: "image/svg+xml",
      width: 64,
      height: 64,
      bytes: qrSvg.length,
      sha256: "fixture-secondary",
    },
  },
};

async function installFixture(context, theme, authenticated, report, scope) {
  await context.addInitScript(({ selectedTheme, selectedMode, entered, fixtureToken, fixtureUser }) => {
    localStorage.setItem("user_theme_preference", selectedTheme);
    localStorage.setItem("user_theme_mode_preference", selectedMode);
    localStorage.setItem("platform_theme", selectedTheme);
    localStorage.setItem("platform_theme_mode", selectedMode);
    if (entered) {
      localStorage.setItem("auth_token", fixtureToken);
      localStorage.setItem("auth_user", JSON.stringify({
        ...fixtureUser,
        themePreference: selectedTheme,
        theme_preference: selectedTheme,
        themeModePreference: selectedMode,
        theme_mode_preference: selectedMode,
      }));
      sessionStorage.setItem("entered_app", "1");
    } else {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      sessionStorage.removeItem("entered_app");
    }
  }, { selectedTheme: theme.id, selectedMode: theme.mode, entered: authenticated, fixtureToken: token, fixtureUser: user });
  if (authenticated) await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== origin) {
      report.externalRequests.push({ scope, method, url: url.origin + url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (method === "GET" && url.pathname === "/api/branding") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, branding }) });
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/api/branding/assets/fixture-qr-")) {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: qrSvg });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/appearance") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/auth/me") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: {
        ...user,
        themePreference: theme.id,
        theme_preference: theme.id,
        themeModePreference: theme.mode,
        theme_mode_preference: theme.mode,
      } }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/bots") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [], navigationKeys: ["task:文案创作"] }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/member-permissions") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ permission: {
        userId: user.id,
        role: "admin",
        featureNavigationKeys: ["marketplace"],
        agentNavigationKeys: ["task:文案创作"],
        revision: 1,
        checksum: "brand-contact-fixture",
        integrityValid: true,
        authorityStatus: "ready",
      } }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/agent-favorites") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ favorites: [] }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/credits") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 0, cashBalance: 0, transactions: [] }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/notifications/user") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [], unreadCount: 0, nextCursor: null }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/announcements/inbox") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ announcements: [], unreadCount: 0, cursor: "empty" }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/layout") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ layout: null }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/ui-preferences") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferences: {} }) });
      return;
    }
    if (method === "GET" && authenticated && url.pathname === "/api/conversations/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) });
      return;
    }
    if (method === "GET" && authenticated && ["/api/categories", "/api/nav-items", "/api/shortcuts"].includes(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [], navItems: [], shortcuts: [] }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/video/active-tasks") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.interceptedMutations.push({ scope, method, pathname: url.pathname });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      return;
    }
    if (/\/(?:generate|payment|billing|quotes?)(?:\/|$)/u.test(url.pathname)) {
      report.paidRequests.push({ scope, method, pathname: url.pathname });
    }
    await route.continue();
  });
}

async function refreshBranding(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("platform-branding:refresh")));
  await page.waitForFunction((expectedWechat) => document.body?.innerText?.includes(expectedWechat), wechat, { timeout: 15_000 });
}

async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  await mkdir(outputDir, { recursive: true });
  const [receipt, diskBuildId, currentFingerprint, versionResponse] = await Promise.all([
    readFile(path.resolve(".next/local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
    fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const servedVersion = await versionResponse.json();
  const servedBuildId = servedVersion.buildId || servedVersion.version || "";
  const runningLatest = receipt.fingerprint === currentFingerprint.fingerprint
    && receipt.fileCount === currentFingerprint.fileCount
    && receipt.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  assert.equal(runningLatest, true, "RUNNING_LATEST_REQUIRED");

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    origin,
    runtime: { sourceVersion: servedVersion.sourceVersion, diskBuildId, servedBuildId, sourceFingerprintCurrent: true, runningLatest },
    fixture: { source: "published-browser-fixture", generation: branding.generation, contactConfigured: true, qrCount: 2 },
    publicThemes: [],
    appSidebar: [],
    interceptedMutations: [],
    reachedServerMutations: [],
    paidRequests: [],
    externalRequests: [],
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of themes) {
      const publicScope = `${theme.id}:public`;
      const publicContext = await browser.newContext({ viewport, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
      await installFixture(publicContext, theme, false, report, publicScope);
      const publicPage = await publicContext.newPage();
      publicPage.on("pageerror", (error) => report.pageErrors.push({ scope: publicScope, message: error.message.slice(0, 400) }));
      publicPage.on("console", (message) => {
        if (message.type() === "error" && !/favicon|React DevTools/u.test(message.text())) report.consoleErrors.push({ scope: publicScope, message: message.text().slice(0, 400) });
      });
      publicPage.on("response", (response) => {
        const url = new URL(response.url());
        if (url.origin === origin && response.status() >= 500) report.serverErrors.push({ scope: publicScope, status: response.status(), pathname: url.pathname });
      });
      const response = await publicPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(response?.status(), 200, `${publicScope}:HTTP`);
      const home = publicPage.getByTestId("soft-white-premium-home");
      await home.waitFor({ state: "visible", timeout: 30_000 });
      await publicPage.evaluate(({ id, mode }) => {
        const root = document.documentElement;
        root.dataset.themeSelection = id;
        root.dataset.theme = id;
        root.dataset.modePreference = mode;
        root.dataset.mode = mode;
        root.classList.toggle("dark", mode === "dark");
      }, theme);
      await refreshBranding(publicPage);
      const contactSection = publicPage.locator("#swh-contact");
      await contactSection.scrollIntoViewIfNeeded();
      await publicPage.waitForTimeout(350);
      const images = contactSection.locator(".swh-contact-qr-grid img");
      await images.first().waitFor({ state: "visible", timeout: 10_000 });
      await publicPage.waitForFunction(() => [...document.querySelectorAll("#swh-contact .swh-contact-qr-grid img")]
        .every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), null, { timeout: 10_000 });
      const copyButton = contactSection.getByRole("button", { name: "复制微信号", exact: true });
      await copyButton.click();
      await contactSection.getByRole("button", { name: "已复制微信号", exact: true }).waitFor({ state: "visible", timeout: 5_000 });
      const metrics = await contactSection.evaluate((section, expectedWechat) => {
        const box = section.getBoundingClientRect();
        const labels = [...section.querySelectorAll(".swh-contact-list small")].map((node) => node.textContent?.trim() || "");
        const values = [...section.querySelectorAll(".swh-contact-list strong")].map((node) => node.textContent?.trim() || "");
        const qrImages = [...section.querySelectorAll(".swh-contact-qr-grid img")].map((image) => ({
          alt: image.getAttribute("alt") || "",
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        }));
        return {
          theme: document.documentElement.dataset.theme || "",
          mode: document.documentElement.dataset.mode || "",
          labels,
          values,
          qrImages,
          copyConfirmed: section.textContent?.includes("已复制微信号") || false,
          footerUsesWechat: section.querySelector(".swh-footer")?.textContent?.includes(`微信：${expectedWechat}`) || false,
          withinViewportWidth: box.left >= -1 && box.right <= innerWidth + 1,
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      }, wechat);
      assert.equal(metrics.theme, theme.id, `${publicScope}:THEME`);
      assert.equal(metrics.mode, theme.mode, `${publicScope}:MODE`);
      assert.deepEqual(metrics.labels, ["联系人", "微信", "电话", "邮箱"], `${publicScope}:LABELS`);
      assert.deepEqual(metrics.values, ["平台服务顾问", wechat, "010-5550-2026", "service@example.test"], `${publicScope}:VALUES`);
      assert.equal(metrics.qrImages.length, 2, `${publicScope}:QR_COUNT`);
      assert.equal(metrics.qrImages.every((image) => image.naturalWidth > 0 && image.naturalHeight > 0), true, `${publicScope}:QR_BROKEN`);
      assert.equal(metrics.copyConfirmed, true, `${publicScope}:COPY_CONFIRMATION`);
      assert.equal(metrics.footerUsesWechat, true, `${publicScope}:FOOTER_SOURCE_MISMATCH`);
      assert.equal(metrics.withinViewportWidth, true, `${publicScope}:CONTACT_OUTSIDE_VIEWPORT`);
      assert.equal(metrics.overflowX, 0, `${publicScope}:OVERFLOW`);
      report.publicThemes.push({ theme, ...metrics });
      await publicPage.screenshot({ path: path.join(outputDir, `${theme.id}-public-contact-1440x900.png`), fullPage: false });
      await publicContext.close();

      const appScope = `${theme.id}:app`;
      const appContext = await browser.newContext({ viewport, serviceWorkers: "block" });
      await installFixture(appContext, theme, true, report, appScope);
      const appPage = await appContext.newPage();
      appPage.on("pageerror", (error) => report.pageErrors.push({ scope: appScope, message: error.message.slice(0, 400) }));
      appPage.on("console", (message) => {
        if (message.type() === "error" && !/favicon|React DevTools/u.test(message.text())) report.consoleErrors.push({ scope: appScope, message: message.text().slice(0, 400) });
      });
      const appResponse = await appPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(appResponse?.status(), 200, `${appScope}:HTTP`);
      await appPage.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });
      await refreshBranding(appPage);
      const sidebarMetrics = await appPage.evaluate((expectedWechat) => {
        const sidebar = document.querySelector(".sidebar-shell");
        const brand = document.querySelector('[data-testid="sidebar-platform-brand"]');
        const matches = [...(brand?.querySelectorAll("*") || [])]
          .filter((node) => node.children.length === 0 && node.textContent?.trim() === `微信：${expectedWechat}`);
        return {
          theme: document.documentElement.dataset.theme || "",
          mode: document.documentElement.dataset.mode || "",
          matchedSubtitleCount: matches.length,
          sidebarVisible: Boolean(sidebar && sidebar.getClientRects().length),
          brandVisible: Boolean(brand && brand.getClientRects().length),
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      }, wechat);
      assert.equal(sidebarMetrics.theme, theme.id, `${appScope}:THEME`);
      assert.equal(sidebarMetrics.mode, theme.mode, `${appScope}:MODE`);
      assert.equal(sidebarMetrics.sidebarVisible, true, `${appScope}:SIDEBAR_HIDDEN`);
      assert.equal(sidebarMetrics.brandVisible, true, `${appScope}:SIDEBAR_BRAND_HIDDEN`);
      assert.ok(sidebarMetrics.matchedSubtitleCount >= 1, `${appScope}:PUBLISHED_WECHAT_SUBTITLE_MISSING`);
      assert.equal(sidebarMetrics.overflowX, 0, `${appScope}:OVERFLOW`);
      report.appSidebar.push({ theme, ...sidebarMetrics });
      await appPage.screenshot({ path: path.join(outputDir, `${theme.id}-app-sidebar-1440x900.png`), fullPage: false });
      await appContext.close();
    }
    assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
    assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
    assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
    assert.deepEqual(report.reachedServerMutations, [], "SERVER_MUTATIONS");
    assert.deepEqual(report.paidRequests, [], "PAID_REQUESTS");
    assert.deepEqual(report.externalRequests, [], `EXTERNAL_REQUESTS:${JSON.stringify(report.externalRequests)}`);
    report.productionWrites = 0;
    report.businessWrites = 0;
    report.paidCalls = 0;
    report.passed = true;
    await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      passed: true,
      sourceVersion: report.runtime.sourceVersion,
      publicThemes: report.publicThemes.length,
      appSidebars: report.appSidebar.length,
      qrImages: report.publicThemes.reduce((sum, entry) => sum + entry.qrImages.length, 0),
      paidCalls: 0,
      productionWrites: 0,
      reportPath: path.relative(process.cwd(), path.join(outputDir, "report.json")),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "failure.txt"), `${error?.stack || error}\n`, "utf8");
  console.error(error);
  process.exitCode = 1;
});
