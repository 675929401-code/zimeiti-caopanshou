#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const outputRoot = path.resolve(process.env.ADMIN_THEME_PUSH_OUTPUT_DIR || ".codex-evidence/admin-default-theme-push-20260930");

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const identity = await identityResponse.json();
  assert.ok(identityResponse.ok && identity?.user?.role === "admin", "LOCAL_ADMIN_ROLE_REQUIRED");

  const outputDir = path.join(outputRoot, new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(outputDir, { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    adminPushes: [],
    personalPreferenceWrites: [],
    deployCalls: [],
    unexpectedWrites: [],
    pageErrors: [],
    consoleErrors: [],
    screenshots: [],
  };
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", colorScheme: "dark" });
    const localUser = {
      ...identity.user,
      themePreference: "lattice",
      theme_preference: "lattice",
      themeModePreference: "system",
      theme_mode_preference: "system",
    };
    await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      localStorage.setItem("user_theme_preference", "lattice");
      localStorage.setItem("user_theme_mode_preference", "system");
      localStorage.setItem("platform_theme", "lattice");
      localStorage.setItem("platform_theme_mode", "system");
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: localUser });

    let platformTheme = "lattice";
    let platformMode = "dark";
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin !== origin) return route.abort();

      if (method === "GET" && url.pathname === "/api/settings/appearance") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            settings: { theme: platformTheme, theme_mode: platformMode },
            authority: { source: "platform_settings", authoritative: true, publishedAt: "2026-10-03T04:00:00.000Z" },
          }),
        });
      }
      if (method === "GET" && url.pathname === "/api/auth/me") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: localUser }) });
      }
      if (method === "POST" && url.pathname === "/api/settings/admin" && url.searchParams.get("scope") === "brand") {
        const body = request.postDataJSON();
        report.adminPushes.push(body);
        platformTheme = body?.theme || platformTheme;
        platformMode = body?.theme_mode || platformMode;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, settings: { theme: platformTheme, theme_mode: platformMode }, publishedAt: "2026-10-03T04:00:00.000Z" }),
        });
      }
      if (method === "PUT" && url.pathname === "/api/auth/me") {
        const body = request.postDataJSON();
        report.personalPreferenceWrites.push(body);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: {
              ...localUser,
              themePreference: body.theme_preference,
              theme_preference: body.theme_preference,
              themeModePreference: body.theme_mode_preference,
              theme_mode_preference: body.theme_mode_preference,
            },
          }),
        });
      }
      if (url.pathname === "/api/deploy" && method !== "GET") {
        report.deployCalls.push({ method, pathname: url.pathname });
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "BLOCKED_BY_ACCEPTANCE" }) });
      }
      if (method === "POST" && url.pathname === "/api/announcements/events") {
        return route.fulfill({ status: 204, body: "" });
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        report.unexpectedWrites.push({ method, pathname: url.pathname });
        return route.fulfill({ status: 204, body: "" });
      }
      return route.continue();
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("net::ERR_FAILED")) report.consoleErrors.push(message.text());
    });

    const adminResponse = await page.goto(`${origin}/admin?tab=theme`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(adminResponse?.status(), 200, "ADMIN_THEME_HTTP");
    await page.getByRole("heading", { name: "主题风格", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const cards = page.locator('button[aria-pressed]');
    assert.equal(await cards.count(), 3, "ADMIN_THEME_OPTION_COUNT");
    assert.equal(await page.getByText("极光蓝", { exact: true }).count(), 0, "RETIRED_THEME_VISIBLE");

    const pushButton = page.locator('[data-admin-default-theme-push="true"]');
    await pushButton.waitFor({ state: "visible" });
    const softWhiteCard = cards.filter({ has: page.getByText("柔光白", { exact: true }) });
    await page.getByText("待推送", { exact: true }).waitFor({ state: "visible" });
    assert.equal((await pushButton.textContent())?.trim(), "发布到全站", "PENDING_PUSH_LABEL");
    assert.equal(await pushButton.isEnabled(), true, "PENDING_PUSH_DISABLED");
    assert.equal(await page.evaluate(() => localStorage.getItem("user_theme_preference")), "lattice", "ADMIN_PREVIEW_CHANGED_USER_PREFERENCE");

    await pushButton.click();
    await page.getByText("全站已发布", { exact: true }).waitFor({ state: "visible" });
    assert.equal(report.adminPushes.length, 1, "ADMIN_PUSH_REQUEST_COUNT");
    assert.deepEqual(report.adminPushes[0], { theme: "soft-white", theme_mode: "light" }, "ADMIN_PUSH_PAYLOAD");
    assert.equal(report.deployCalls.length, 0, "DEFAULT_THEME_PUSH_TRIGGERED_DEPLOY");
    assert.equal(await page.evaluate(() => localStorage.getItem("user_theme_preference")), "lattice", "ADMIN_PUSH_CHANGED_USER_PREFERENCE");
    const adminScreenshot = path.join(outputDir, "admin-default-theme-pushed.png");
    await page.screenshot({ path: adminScreenshot, fullPage: false });
    report.screenshots.push(adminScreenshot);

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const trigger = page.locator('[data-theme-switcher-trigger="true"]:visible').first();
    await trigger.waitFor({ state: "visible", timeout: 30_000 });
    await trigger.click();
    await page.locator('[data-theme-option="crystal-aurora"]').click();
    await page.waitForFunction(() => localStorage.getItem("user_theme_preference") === "crystal-aurora");
    assert.equal(report.personalPreferenceWrites.length, 1, "PERSONAL_THEME_WRITE_COUNT");
    assert.deepEqual(report.personalPreferenceWrites[0], {
      theme_preference: "crystal-aurora",
      theme_mode_preference: "system",
    }, "PERSONAL_THEME_PAYLOAD");
    assert.equal(report.adminPushes.length, 1, "PERSONAL_THEME_CHANGED_PLATFORM_DEFAULT");
    assert.equal(report.deployCalls.length, 0, "PERSONAL_THEME_TRIGGERED_DEPLOY");

    assert.deepEqual(report.unexpectedWrites, [], "UNEXPECTED_WRITE");
    assert.deepEqual(report.pageErrors, [], "PAGE_ERRORS");
    assert.deepEqual(report.consoleErrors, [], "CONSOLE_ERRORS");
    report.ok = true;
    await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ ok: true, outputDir, adminPushes: report.adminPushes.length, personalWrites: report.personalPreferenceWrites.length }, null, 2));
  } finally {
    await browser.close();
  }
}
