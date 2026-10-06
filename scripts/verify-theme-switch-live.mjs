#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const outputDir = path.resolve(process.env.THEME_SWITCH_OUTPUT_DIR || ".codex-evidence/theme-accessibility-20260929/live");
const themes = ["lattice", "soft-white", "crystal-aurora", "stellar-blue"];
const validThemes = new Set(themes);
const themeTransitionSettleMs = 380;

async function waitForThemeVisualStability(page) {
  await page.waitForTimeout(themeTransitionSettleMs);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function getThemeCardReadability(card) {
  return card.evaluate((node) => {
    const parseColor = (value) => {
      const match = String(value).match(/rgba?\(([^)]+)\)/iu);
      if (!match) return null;
      const channels = match[1].trim().split(/[\s,/]+/u).filter(Boolean).map(Number);
      if (channels.length < 3 || channels.slice(0, 3).some((channel) => !Number.isFinite(channel))) return null;
      return {
        red: channels[0],
        green: channels[1],
        blue: channels[2],
        alpha: Number.isFinite(channels[3]) ? channels[3] : 1,
      };
    };
    const composite = (foreground, background) => {
      const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
      if (alpha <= 0) return { red: 255, green: 255, blue: 255, alpha: 1 };
      return {
        red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
        green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
        blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
        alpha,
      };
    };
    const effectiveBackground = (element) => {
      const layers = [];
      for (let current = element; current instanceof Element; current = current.parentElement) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.alpha > 0) layers.push(color);
        if (color?.alpha >= 0.999) break;
      }
      let result = { red: 255, green: 255, blue: 255, alpha: 1 };
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        result = composite(layers[index], result);
      }
      return result;
    };
    const luminance = (color) => {
      const normalize = (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * normalize(color.red) + 0.7152 * normalize(color.green) + 0.0722 * normalize(color.blue);
    };
    const contrast = (foreground, background) => {
      const foregroundLuminance = luminance(composite(foreground, background));
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    };
    const label = [...node.querySelectorAll("span")].find((item) => item.textContent?.trim());
    const description = node.querySelector("p");
    assertElement(label, "label");
    assertElement(description, "description");
    const background = effectiveBackground(node);
    const labelColor = parseColor(getComputedStyle(label).color);
    const descriptionColor = parseColor(getComputedStyle(description).color);
    if (!labelColor || !descriptionColor) throw new Error("ADMIN_THEME_CARD_COLOR_PARSE_FAILED");
    return {
      background: getComputedStyle(node).backgroundColor,
      labelColor: getComputedStyle(label).color,
      descriptionColor: getComputedStyle(description).color,
      labelContrast: contrast(labelColor, background),
      descriptionContrast: contrast(descriptionColor, background),
    };

    function assertElement(element, role) {
      if (!(element instanceof Element)) throw new Error(`ADMIN_THEME_CARD_${role.toUpperCase()}_MISSING`);
    }
  });
}

function assertThemeCardReadable(metrics, theme) {
  assert.ok(metrics.labelContrast >= 4.5, `ADMIN_THEME_CARD_LABEL_CONTRAST_LOW:${theme}:${metrics.labelContrast.toFixed(2)}`);
  assert.ok(metrics.descriptionContrast >= 3, `ADMIN_THEME_CARD_DESCRIPTION_CONTRAST_LOW:${theme}:${metrics.descriptionContrast.toFixed(2)}`);
}

async function authenticatedResponse(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function authenticatedJson(pathname, options = {}) {
  const { response, body } = await authenticatedResponse(pathname, options);
  assert.ok(response.ok, body?.error || `${pathname}:${response.status}`);
  return body;
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await mkdir(outputDir, { recursive: true });

  const identity = await authenticatedJson("/api/auth/me");
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const originalPreference = identity.user.themePreference ?? null;
  const originalModePreference = identity.user.themeModePreference ?? null;
  const originalTheme = validThemes.has(originalPreference) ? originalPreference : "lattice";
  const originalPlatform = await authenticatedJson("/api/settings");
  const originalPlatformTheme = validThemes.has(originalPlatform?.settings?.theme)
    ? originalPlatform.settings.theme
    : "lattice";
  const originalPlatformMode = ["system", "light", "dark"].includes(originalPlatform?.settings?.theme_mode)
    ? originalPlatform.settings.theme_mode
    : "system";
  const targetTheme = originalTheme === "stellar-blue" ? "crystal-aurora" : "stellar-blue";
  const targetMode = "dark";
  const pageErrors = [];
  const consoleErrors = [];
  const serverErrors = [];
  const paidRequests = [];
  const unexpectedWrites = [];
  const browser = await chromium.launch({ headless: true });
  let restored = false;
  let platformSaveReadback = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user, theme }) => {
      if (!sessionStorage.getItem("theme_switch_test_initialized")) {
        localStorage.setItem("auth_token", sessionToken);
        localStorage.setItem("auth_user", JSON.stringify(user));
        localStorage.setItem("user_theme_preference", theme);
        sessionStorage.setItem("entered_app", "1");
        sessionStorage.setItem("theme_switch_test_initialized", "1");
      }
    }, { sessionToken: token, user: identity.user, theme: originalTheme });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      const method = request.method();
      if (/\/(generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) paidRequests.push(`${method} ${url.pathname}`);
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
        && !(method === "PUT" && url.pathname === "/api/auth/me")
        && !(method === "PUT" && url.pathname === "/api/settings")
        && !(method === "POST" && url.pathname === "/api/announcements/events")) {
        unexpectedWrites.push(`${method} ${url.pathname}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    const trigger = page.locator('[data-theme-switcher-trigger="true"]').last();
    await trigger.waitFor({ state: "visible", timeout: 30_000 });
    await trigger.click();
    const option = page.locator(`[data-theme-option="${targetTheme}"]`);
    await option.waitFor({ state: "visible", timeout: 10_000 });
    const [switchResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PUT"
        && new URL(response.url()).pathname === "/api/auth/me", { timeout: 30_000 }),
      option.click(),
    ]);
    assert.equal(switchResponse.status(), 200, "THEME_PREFERENCE_SAVE_FAILED");
    await option.waitFor({ state: "hidden", timeout: 10_000 });
    await page.waitForFunction((theme) => document.documentElement.dataset.themeSelection === theme
      && localStorage.getItem("user_theme_preference") === theme, targetTheme);
    await trigger.click();
    const modeOption = page.locator(`[data-theme-mode-option="${targetMode}"]`);
    await modeOption.waitFor({ state: "visible", timeout: 10_000 });
    const [modeResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PUT"
        && new URL(response.url()).pathname === "/api/auth/me", { timeout: 30_000 }),
      modeOption.click(),
    ]);
    assert.equal(modeResponse.status(), 200, "THEME_MODE_PREFERENCE_SAVE_FAILED");
    await page.waitForFunction(({ theme, mode }) => document.documentElement.dataset.themeSelection === theme
      && document.documentElement.dataset.theme === theme
      && document.documentElement.dataset.mode === mode
      && localStorage.getItem("user_theme_preference") === theme
      && localStorage.getItem("user_theme_mode_preference") === mode, { theme: targetTheme, mode: targetMode });
    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    const persisted = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      themeSelection: document.documentElement.dataset.themeSelection,
      mode: document.documentElement.dataset.mode,
      localPreference: localStorage.getItem("user_theme_preference"),
      localModePreference: localStorage.getItem("user_theme_mode_preference"),
      background: getComputedStyle(document.body).backgroundColor,
      primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim().toLowerCase(),
      inlinePrimary: document.documentElement.style.getPropertyValue("--primary"),
    }));
    assert.equal(persisted.theme, targetTheme, "THEME_NOT_RESTORED_AFTER_RELOAD");
    assert.equal(persisted.themeSelection, targetTheme, "THEME_SELECTION_NOT_RESTORED_AFTER_RELOAD");
    assert.equal(persisted.mode, targetMode, "THEME_MODE_NOT_RESTORED_AFTER_RELOAD");
    assert.equal(persisted.localPreference, targetTheme, "LOCAL_THEME_PREFERENCE_NOT_RESTORED");
    assert.equal(persisted.localModePreference, targetMode, "LOCAL_THEME_MODE_PREFERENCE_NOT_RESTORED");
    assert.equal(persisted.primary, targetTheme === "stellar-blue" ? "#58e0dc" : "#54e3d2", "THEME_SEMANTIC_PRIMARY_MISMATCH");
    assert.equal(persisted.inlinePrimary, "", "LEGACY_SETTINGS_OVERRIDDEN_THEME_PRIMARY");
    const databaseAfterSwitch = await authenticatedJson("/api/auth/me");
    assert.equal(databaseAfterSwitch.user.themePreference, targetTheme, "DATABASE_THEME_PREFERENCE_NOT_SAVED");

    const invalidThemeAttempt = await authenticatedResponse("/api/auth/me", {
      method: "PUT",
      body: JSON.stringify({ theme_preference: "not-a-registered-theme" }),
    });
    assert.equal(invalidThemeAttempt.response.status, 400, "INVALID_THEME_WAS_NOT_REJECTED");
    const databaseAfterInvalidAttempt = await authenticatedJson("/api/auth/me");
    assert.equal(databaseAfterInvalidAttempt.user.themePreference, targetTheme, "INVALID_THEME_CHANGED_DATABASE");

    const invalidPlatformThemeAttempt = await authenticatedResponse("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { theme: "not-a-registered-theme" } }),
    });
    assert.equal(invalidPlatformThemeAttempt.response.status, 400, "INVALID_PLATFORM_THEME_WAS_NOT_REJECTED");
    const invalidPlatformModeAttempt = await authenticatedResponse("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { theme_mode: "sepia" } }),
    });
    assert.equal(invalidPlatformModeAttempt.response.status, 400, "INVALID_PLATFORM_MODE_WAS_NOT_REJECTED");

    const userPreferenceBeforeAdminPreview = await page.evaluate(() => ({
      theme: localStorage.getItem("user_theme_preference"),
      mode: localStorage.getItem("user_theme_mode_preference"),
    }));
    const adminSettingsLoaded = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname === "/api/settings/admin"
        && response.request().method() === "GET"
        && response.ok();
    }, { timeout: 30_000 });
    await page.goto(`${origin}/admin?tab=theme`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await adminSettingsLoaded;
    await page.getByRole("heading", { name: "主题风格", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const adminThemeCard = (name) => page.locator('button[aria-pressed]').filter({
      has: page.getByText(name, { exact: true }),
    });
    const adminThemeCards = ["深空晶", "柔光白", "暗夜黑", "极光蓝"];
    for (const name of adminThemeCards) {
      assert.equal(await adminThemeCard(name).count(), 1, `ADMIN_THEME_CARD_MISSING:${name}`);
    }
    assert.equal(await page.getByText("默认明暗模式", { exact: true }).count(), 1, "ADMIN_DEFAULT_MODE_CONTROL_MISSING");
    assert.equal(await page.getByRole("button", { name: "保存设置", exact: true }).count() > 0, true, "ADMIN_THEME_SAVE_ACTION_MISSING");

    await adminThemeCard("深空晶").click();
    await page.getByRole("button", { name: /^深色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeSelection === "lattice"
      && document.documentElement.dataset.theme === "lattice"
      && document.documentElement.dataset.mode === "dark"
      && document.documentElement.dataset.modePreference === "dark");
    assert.equal(await page.getByRole("button", { name: /^自动/u }).isEnabled(), true, "LATTICE_AUTO_MODE_DISABLED");
    assert.equal(await page.getByRole("button", { name: /^浅色/u }).isEnabled(), true, "LATTICE_LIGHT_MODE_DISABLED");
    await page.getByRole("button", { name: /^浅色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeSelection === "lattice"
      && document.documentElement.dataset.theme === "soft-white"
      && document.documentElement.dataset.mode === "light"
      && document.documentElement.dataset.modePreference === "light");
    await page.getByRole("button", { name: /^深色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeSelection === "lattice"
      && document.documentElement.dataset.theme === "lattice"
      && document.documentElement.dataset.mode === "dark");
    const latticeAdminPalette = await page.locator(".admin-light-shell").evaluate((node) => ({
      backgroundColor: getComputedStyle(node).backgroundColor,
      primary: getComputedStyle(node).getPropertyValue("--primary").trim().toLowerCase(),
    }));
    assert.equal(latticeAdminPalette.backgroundColor, "rgb(243, 244, 239)", "LATTICE_PREVIEW_CHANGED_FIXED_ADMIN_BACKGROUND");
    assert.equal(latticeAdminPalette.primary, "#0b7466", "LATTICE_PREVIEW_CHANGED_FIXED_ADMIN_PRIMARY");

    await adminThemeCard("柔光白").click();
    await page.getByRole("button", { name: /^浅色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "soft-white"
      && document.documentElement.dataset.mode === "light"
      && document.documentElement.dataset.modePreference === "light");
    const softWhiteAdminPalette = await page.locator(".admin-light-shell").evaluate((node) => ({
      backgroundColor: getComputedStyle(node).backgroundColor,
      primary: getComputedStyle(node).getPropertyValue("--primary").trim().toLowerCase(),
    }));
    assert.equal(softWhiteAdminPalette.backgroundColor, "rgb(243, 244, 239)", "SOFT_WHITE_ADMIN_BACKGROUND_MISMATCH");
    assert.equal(softWhiteAdminPalette.primary, "#0b7466", "SOFT_WHITE_ADMIN_PRIMARY_MISMATCH");

    await adminThemeCard("暗夜黑").click();
    await adminThemeCard("暗夜黑").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent?.includes("暗夜黑"));
    await page.getByRole("button", { name: /^深色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeSelection === "crystal-aurora"
      && document.documentElement.dataset.theme === "crystal-aurora"
      && document.documentElement.dataset.mode === "dark"
      && document.documentElement.dataset.modePreference === "dark");
    await waitForThemeVisualStability(page);
    const crystalAdminGrid = await page.locator(".admin-light-shell").evaluate((node) => ({
      backgroundImage: getComputedStyle(node).backgroundImage,
      backgroundColor: getComputedStyle(node).backgroundColor,
      primary: getComputedStyle(node).getPropertyValue("--primary").trim().toLowerCase(),
      gridLine: getComputedStyle(node).getPropertyValue("--admin-grid-line").trim(),
    }));
    assert.ok((crystalAdminGrid.backgroundImage.match(/linear-gradient/gu) || []).length >= 2, "CRYSTAL_ADMIN_ORTHOGONAL_GRID_MISSING");
    assert.ok(crystalAdminGrid.gridLine, "CRYSTAL_ADMIN_GRID_LINE_MISSING");
    assert.equal(crystalAdminGrid.backgroundColor, "rgb(243, 244, 239)", "CRYSTAL_LIGHT_ADMIN_BACKGROUND_MISMATCH");
    assert.equal(crystalAdminGrid.primary, "#0b7466", "CRYSTAL_LIGHT_ADMIN_PRIMARY_MISMATCH");
    const crystalCardReadability = await getThemeCardReadability(adminThemeCard("暗夜黑"));
    assertThemeCardReadable(crystalCardReadability, "crystal-aurora-dark");
    await page.screenshot({ path: path.join(outputDir, "admin-crystal-aurora-dark.png"), fullPage: false });

    await adminThemeCard("极光蓝").click();
    await page.getByRole("button", { name: /^深色/u }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeSelection === "stellar-blue"
      && document.documentElement.dataset.theme === "stellar-blue"
      && document.documentElement.dataset.mode === "dark"
      && document.documentElement.dataset.modePreference === "dark");
    await waitForThemeVisualStability(page);
    const stellarAdminGrid = await page.locator(".admin-light-shell").evaluate((node) => ({
      backgroundImage: getComputedStyle(node).backgroundImage,
      backgroundColor: getComputedStyle(node).backgroundColor,
      primary: getComputedStyle(node).getPropertyValue("--primary").trim().toLowerCase(),
      gridLine: getComputedStyle(node).getPropertyValue("--admin-grid-line").trim(),
    }));
    assert.ok((stellarAdminGrid.backgroundImage.match(/linear-gradient/gu) || []).length >= 2, "STELLAR_ADMIN_ORTHOGONAL_GRID_MISSING");
    assert.ok(stellarAdminGrid.gridLine, "STELLAR_ADMIN_GRID_LINE_MISSING");
    assert.equal(stellarAdminGrid.backgroundColor, "rgb(243, 244, 239)", "STELLAR_PREVIEW_CHANGED_FIXED_ADMIN_BACKGROUND");
    assert.equal(stellarAdminGrid.primary, "#0b7466", "STELLAR_PREVIEW_CHANGED_FIXED_ADMIN_PRIMARY");
    const stellarCardReadability = await getThemeCardReadability(adminThemeCard("极光蓝"));
    assertThemeCardReadable(stellarCardReadability, "stellar-blue-dark");
    await page.screenshot({ path: path.join(outputDir, "admin-stellar-blue-dark.png"), fullPage: false });

    const userPreferenceAfterAdminPreview = await page.evaluate(() => ({
      theme: localStorage.getItem("user_theme_preference"),
      mode: localStorage.getItem("user_theme_mode_preference"),
    }));
    assert.deepEqual(userPreferenceAfterAdminPreview, userPreferenceBeforeAdminPreview, "ADMIN_PREVIEW_OVERWROTE_USER_PREFERENCE");
    const platformSaveResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings"
    ), { timeout: 30_000 });
    await page.getByRole("button", { name: "保存设置", exact: true }).last().click();
    const platformSave = await platformSaveResponse;
    const platformSaveBody = await platformSave.json().catch(() => ({}));
    assert.equal(
      platformSave.status(),
      200,
      `ADMIN_PLATFORM_THEME_SAVE_FAILED:${platformSaveBody?.code || "UNKNOWN"}:${platformSaveBody?.setting_key || platformSaveBody?.error || "NO_DETAIL"}`,
    );
    await page.waitForFunction(() => document.documentElement.dataset.theme === "stellar-blue" && document.documentElement.dataset.mode === "dark");
    await waitForThemeVisualStability(page);
    platformSaveReadback = await authenticatedJson("/api/settings");
    assert.equal(platformSaveReadback?.settings?.theme, "stellar-blue", "ADMIN_PLATFORM_THEME_READBACK_MISMATCH");
    assert.equal(platformSaveReadback?.settings?.theme_mode, "dark", "ADMIN_PLATFORM_MODE_READBACK_MISMATCH");

    await page.screenshot({ path: path.join(outputDir, `${targetTheme}.png`), fullPage: false });
    await authenticatedJson("/api/auth/me", {
      method: "PUT",
      body: JSON.stringify(originalPreference && originalModePreference
        ? { theme_preference: originalPreference, theme_mode_preference: originalModePreference }
        : { theme_preference: null, theme_mode_preference: null }),
    });
    const databaseAfterRestore = await authenticatedJson("/api/auth/me");
    assert.equal(databaseAfterRestore.user.themePreference ?? null, originalPreference, "ORIGINAL_THEME_PREFERENCE_NOT_RESTORED");
    restored = true;

    assert.deepEqual(pageErrors, [], "THEME_PAGE_ERRORS");
    assert.deepEqual(consoleErrors, [], "THEME_CONSOLE_ERRORS");
    assert.deepEqual(serverErrors, [], "THEME_SERVER_ERRORS");
    assert.deepEqual(paidRequests, [], "THEME_PAID_REQUESTS");
    assert.deepEqual(unexpectedWrites, [], "THEME_UNEXPECTED_WRITES");

    const report = {
      ok: true,
      testedAt: new Date().toISOString(),
      originalPreference,
      testedTheme: targetTheme,
      testedMode: targetMode,
      triggerVisible: true,
      userSwitchPersistedAcrossReload: true,
      databaseReadbackMatched: true,
      invalidThemeRejected: true,
      invalidPlatformThemeRejected: true,
      invalidPlatformModeRejected: true,
      adminThemeCards: themes,
      adminModeOptions: ["system", "light", "dark"],
      adminPreviewPreservedUserPreference: true,
      adminPreviewGrid: {
        lattice: latticeAdminPalette,
        softWhite: softWhiteAdminPalette,
        crystal: crystalAdminGrid,
        stellar: stellarAdminGrid,
      },
      adminThemeCardReadability: {
        crystal: crystalCardReadability,
        stellar: stellarCardReadability,
      },
      platformSaveReadback: {
        theme: platformSaveReadback?.settings?.theme,
        themeMode: platformSaveReadback?.settings?.theme_mode,
      },
      adminSaveActionPresent: true,
      restoredOriginalPreference: true,
      persisted,
      pageErrors,
      consoleErrors,
      serverErrors,
      paidRequests,
      unexpectedWrites,
      providerCalls: 0,
      paidCalls: 0,
    };
    await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await authenticatedJson("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: { theme: originalPlatformTheme, theme_mode: originalPlatformMode } }),
    }).catch(() => {});
    if (!restored) {
      await authenticatedJson("/api/auth/me", {
        method: "PUT",
        body: JSON.stringify(originalPreference && originalModePreference
          ? { theme_preference: originalPreference, theme_mode_preference: originalModePreference }
          : { theme_preference: null, theme_mode_preference: null }),
      }).catch(() => {});
    }
    await browser.close();
  }
}
