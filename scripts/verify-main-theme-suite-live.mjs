#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { verifyLocalBuildFingerprintReceipt } from "./local-build-fingerprint.mjs";

const themes = ["lattice", "soft-white", "crystal-aurora", "stellar-blue"];
const redesignedThemes = [...themes];
const modePreferences = ["system", "light", "dark"];
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];
const landingTitleLines = ["把一个内容想法", "推进到完整成片", "沉淀为可用资产"];
const landingSectionHeadings = [
  "少一点重复开工，多一点持续产出",
  "选对呈现方式，再把每一步做到位",
  "真正有用的 AI，不只回答，还要接住下一步",
  "从持续表达，到用内容经营生意",
];

function defaultModeForTheme(theme) {
  return theme === "soft-white" ? "light" : "dark";
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const outputDir = path.resolve(process.env.MAIN_THEME_OUTPUT_DIR || ".codex-evidence/main-theme-suite-20260928/live");
  const injectSource = process.env.MAIN_THEME_INJECT_SOURCE === "1";
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await mkdir(outputDir, { recursive: true });

  const routeShellSource = await readFile(path.resolve("src/components/app-route-shell.module.css"), "utf8");
  const latticeRouteBlock = routeShellSource.match(/:global\(html\[data-theme="lattice"\]\[data-mode="dark"\]\) \.shell \{([\s\S]*?)\n\}/u)?.[1] || "";
  assert.match(latticeRouteBlock, /--route-bg:\s*#0b0e12;/u, "LATTICE_ROUTE_BG_CONTRACT_CHANGED");
  assert.match(latticeRouteBlock, /--route-panel:\s*rgba\(15,\s*19,\s*23,\s*\.96\);/u, "LATTICE_ROUTE_PANEL_CONTRACT_CHANGED");
  assert.match(latticeRouteBlock, /--route-accent:\s*#d8b96f;/u, "LATTICE_ROUTE_ACCENT_CONTRACT_CHANGED");
  assert.match(latticeRouteBlock, /--route-active:\s*linear-gradient\(108deg,\s*#8a6e31 0%,\s*#d8b96f 100%\);/u, "LATTICE_ROUTE_ACTIVE_CONTRACT_CHANGED");

  const stellarThemeSource = `${await readFile(path.resolve("src/app/theme-stellar-blue.css"), "utf8")}\n${await readFile(path.resolve("src/components/landing/operating-home-v2.css"), "utf8")}\n${await readFile(path.resolve("src/components/landing/landing-login-themes.css"), "utf8")}`;
  assert.doesNotMatch(
    stellarThemeSource,
    /#(?:315fd9|7c4fe0|c04496|7fa6ff|a184ff|f06bcb)|rgba\((?:49,\s*95,\s*217|124,\s*79,\s*224|192,\s*68,\s*150|127,\s*166,\s*255|161,\s*132,\s*255|240,\s*107,\s*203)/iu,
    "STELLAR_LEGACY_PURPLE_PALETTE_REINTRODUCED",
  );
  assert.match(stellarThemeSource, /--oh-page:\s*#06182d;/u, "STELLAR_DEEP_NAVY_HOME_MISSING");
  assert.match(stellarThemeSource, /--oh-accent:\s*#58e0dc;/u, "STELLAR_CYAN_STRUCTURE_LIGHT_MISSING");

  const localBuild = verifyLocalBuildFingerprintReceipt(process.cwd(), ".next/local-source-fingerprint.v1.json");
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const servedVersion = await versionResponse.json();
  assert.equal(servedVersion?.buildId || servedVersion?.version, localBuild.buildId, "RUNTIME_NOT_LATEST_LOCAL_BUILD");

  const me = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(me.ok, true, `AUTH_ME_${me.status}`);
  const identity = await me.json();
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const originalPreference = identity.user.themePreference ?? null;
  const originalModePreference = identity.user.themeModePreference ?? null;
  const initialTheme = themes.includes(originalPreference) ? originalPreference : "lattice";
  const initialModePreference = modePreferences.includes(originalModePreference)
    ? originalModePreference
    : defaultModeForTheme(initialTheme);

  const browser = await chromium.launch({ headless: true });
  const operatingHomeCss = injectSource
    ? await readFile(path.resolve("src/components/landing/operating-home-v2.css"), "utf8")
    : "";
  const sourceCss = injectSource ? {
    lattice: `${await readFile(path.resolve("src/app/theme-lattice.css"), "utf8")}\n${operatingHomeCss}`,
    "crystal-aurora": `${await readFile(path.resolve("src/app/theme-crystal-aurora.css"), "utf8")}\n${operatingHomeCss}`,
    "soft-white": `${await readFile(path.resolve("src/app/theme-soft-white.css"), "utf8")}\n${operatingHomeCss}`,
    "stellar-blue": `${await readFile(path.resolve("src/app/theme-stellar-blue.css"), "utf8")}\n${operatingHomeCss}`,
  } : {};
  const report = {
    ok: false,
    testedAt: new Date().toISOString(),
    origin,
    injectSource,
    runtimeIdentity: {
      runningLatest: true,
      localBuildId: localBuild.buildId,
      localFingerprint: localBuild.fingerprint,
      servedBuildId: servedVersion?.buildId || servedVersion?.version || "",
      servedSourceVersion: servedVersion?.sourceVersion || "",
    },
    themes: {},
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
    paidRequests: [],
    unexpectedWrites: [],
    switching: {
      originalPreference,
      options: [],
      modeOptions: [],
      modeChecks: [],
      selectionOrder: [],
      persistedThemes: [],
      databaseReads: [],
      preferenceWrites: [],
      landingTransitions: [],
      modeVisuals: [],
      restoredOriginalPreference: false,
    },
    landingVisualSignatures: {},
    loginModal: null,
    loginDrawers: {},
    reducedMotion: null,
  };

  try {
    const switchContext = await browser.newContext({ viewport: viewports[0], serviceWorkers: "block" });
    await switchContext.addInitScript(({ sessionToken, user, selectedTheme, selectedMode }) => {
      if (!sessionStorage.getItem("main_theme_switch_initialized")) {
        localStorage.setItem("auth_token", sessionToken);
        localStorage.setItem("auth_user", JSON.stringify(user));
        localStorage.setItem("user_theme_preference", selectedTheme);
        localStorage.setItem("user_theme_mode_preference", selectedMode);
        sessionStorage.setItem("entered_app", "1");
        sessionStorage.setItem("main_theme_switch_initialized", "1");
      }
    }, {
      sessionToken: token,
      user: identity.user,
      selectedTheme: initialTheme,
      selectedMode: initialModePreference,
    });
    const switchPage = await switchContext.newPage();
    switchPage.on("pageerror", (error) => report.pageErrors.push(`switch:${error.message.slice(0, 300)}`));
    switchPage.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(`switch:${message.text().slice(0, 300)}`);
    });
    switchPage.on("response", (response) => {
      if (response.status() >= 500) report.serverErrors.push(`switch:${response.status()} ${new URL(response.url()).pathname}`);
    });
    switchPage.on("request", (request) => {
      const url = new URL(request.url());
      const method = request.method();
      if (method === "PUT" && url.pathname === "/api/auth/me") {
        report.switching.preferenceWrites.push(`${method} ${url.pathname}`);
      } else if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
        && !(method === "POST" && url.pathname === "/api/announcements/events")) {
        report.unexpectedWrites.push(`switch:${method} ${url.pathname}`);
      }
    });

    try {
      await switchPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await switchPage.waitForSelector(".marketplace-shell", { timeout: 30_000 });
      const trigger = switchPage.locator('[data-theme-switcher-trigger="true"]:visible').first();
      const openMenuOption = async (selector, errorLabel) => {
        const option = switchPage.locator(selector);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await trigger.waitFor({ state: "visible", timeout: 30_000 });
          await trigger.click();
          try {
            await option.waitFor({ state: "visible", timeout: 5_000 });
            return option;
          } catch (error) {
            await switchPage.keyboard.press("Escape");
            if (attempt === 3) throw error;
            await switchPage.waitForTimeout(300);
          }
        }
        throw new Error(`THEME_MENU_OPEN_FAILED:${errorLabel}`);
      };
      const activateThemeOption = async (theme) => {
        const option = await openMenuOption(`[data-theme-option="${theme}"]`, theme);
        await option.evaluate((node) => node.click());
      };
      const activateModeOption = async (preference, expectedMode) => {
        const option = await openMenuOption(`[data-theme-mode-option="${preference}"]`, preference);
        const disabled = await option.evaluate((node) => node.hasAttribute("data-disabled") || node.getAttribute("aria-disabled") === "true");
        assert.equal(disabled, false, `MODE_OPTION_DISABLED:${preference}`);
        await option.evaluate((node) => node.click());
        await switchPage.waitForFunction(({ selectedPreference, mode }) => (
          document.documentElement.dataset.modePreference === selectedPreference
          && document.documentElement.dataset.mode === mode
          && localStorage.getItem("user_theme_mode_preference") === selectedPreference
        ), { selectedPreference: preference, mode: expectedMode });
      };
      const captureModeVisual = async (theme, preference, expectedMode) => {
        const visual = await switchPage.evaluate(() => {
          const depth = document.querySelector(".marketplace-depth");
          const card = document.querySelector(".marketplace-agent-grid .agent-card-hover");
          const probe = document.createElement("span");
          probe.style.color = "var(--primary)";
          probe.style.backgroundColor = "var(--background)";
          document.body.append(probe);
          const probeStyle = getComputedStyle(probe);
          const cardStyle = card ? getComputedStyle(card) : null;
          const result = {
            theme: document.documentElement.dataset.theme,
            themeSelection: document.documentElement.dataset.themeSelection,
            preference: document.documentElement.dataset.modePreference,
            mode: document.documentElement.dataset.mode,
            primary: probeStyle.color,
            background: probeStyle.backgroundColor,
            grid: depth ? getComputedStyle(depth, "::before").backgroundImage : "none",
            cardBackground: cardStyle
              ? `${cardStyle.backgroundColor}|${cardStyle.backgroundImage}`
              : "",
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
          probe.remove();
          return result;
        });
        assert.equal(visual.themeSelection, theme, `MODE_VISUAL_THEME_SELECTION_MISMATCH:${theme}:${preference}`);
        assert.equal(visual.theme, expectedMode === "light" ? "soft-white" : theme, `MODE_VISUAL_THEME_MISMATCH:${theme}:${preference}`);
        assert.equal(visual.preference, preference, `MODE_VISUAL_PREFERENCE_MISMATCH:${theme}:${preference}`);
        assert.equal(visual.mode, expectedMode, `MODE_VISUAL_MODE_MISMATCH:${theme}:${preference}`);
        assert.equal(visual.overflowX, 0, `MODE_VISUAL_HORIZONTAL_OVERFLOW:${theme}:${preference}`);
        assert.match(visual.grid, /linear-gradient/iu, `MODE_VISUAL_GRID_MISSING:${theme}:${preference}`);
        report.switching.modeVisuals.push(visual);
        return visual;
      };
      await trigger.click();
      const optionNodes = switchPage.locator("[data-theme-option]");
      assert.equal(await optionNodes.count(), 4, "THEME_OPTION_COUNT_MISMATCH");
      report.switching.options = await optionNodes.evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-theme-option"),
        text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
      })));
      assert.deepEqual(report.switching.options.map((item) => item.id), themes, "THEME_OPTION_ORDER_MISMATCH");
      const expectedLabels = { lattice: "深空金", "crystal-aurora": "黑曜霓彩", "soft-white": "柔光白", "stellar-blue": "极光蓝" };
      for (const theme of themes) {
        const option = report.switching.options.find((item) => item.id === theme);
        assert.ok(option?.text.includes(expectedLabels[theme]), `THEME_LABEL_MISMATCH:${theme}`);
      }
      const modeOptionNodes = switchPage.locator("[data-theme-mode-option]");
      assert.equal(await modeOptionNodes.count(), 3, "MODE_OPTION_COUNT_MISMATCH");
      report.switching.modeOptions = await modeOptionNodes.evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-theme-mode-option"),
        text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
      })));
      assert.deepEqual(report.switching.modeOptions.map((item) => item.id), modePreferences, "MODE_OPTION_ORDER_MISMATCH");
      await switchPage.keyboard.press("Escape");

      const currentTheme = await switchPage.evaluate(() => document.documentElement.dataset.themeSelection || "");
      const selectionOrder = themes.includes(currentTheme)
        ? [...themes.filter((theme) => theme !== currentTheme), currentTheme]
        : [...themes];
      report.switching.selectionOrder = selectionOrder;
      for (const theme of selectionOrder) {
        await activateThemeOption(theme);
        await switchPage.waitForFunction((selectedTheme) => (
          document.documentElement.dataset.themeSelection === selectedTheme
          && localStorage.getItem("user_theme_preference") === selectedTheme
        ), theme);

        await switchPage.emulateMedia({ colorScheme: "dark" });
        await activateModeOption("system", "dark");
        report.switching.modeChecks.push({ theme, preference: "system", colorScheme: "dark", resolvedMode: "dark" });
        await captureModeVisual(theme, "system", "dark");
        await switchPage.emulateMedia({ colorScheme: "light" });
        await switchPage.waitForFunction(() => (
          document.documentElement.dataset.modePreference === "system"
          && document.documentElement.dataset.mode === "light"
        ));
        report.switching.modeChecks.push({ theme, preference: "system", colorScheme: "light", resolvedMode: "light" });
        await captureModeVisual(theme, "system", "light");
        await activateModeOption("light", "light");
        report.switching.modeChecks.push({ theme, preference: "light", resolvedMode: "light" });
        const lightVisual = await captureModeVisual(theme, "light", "light");
        await activateModeOption("dark", "dark");
        report.switching.modeChecks.push({ theme, preference: "dark", resolvedMode: "dark" });
        const darkVisual = await captureModeVisual(theme, "dark", "dark");
        assert.notEqual(lightVisual.background, darkVisual.background, `MODE_VISUAL_BACKGROUND_NOT_DISTINCT:${theme}`);
        assert.notEqual(lightVisual.primary, darkVisual.primary, `MODE_VISUAL_PRIMARY_NOT_DISTINCT:${theme}`);
        assert.notEqual(lightVisual.cardBackground, darkVisual.cardBackground, `MODE_VISUAL_CARD_NOT_DISTINCT:${theme}`);
        const finalModePreference = defaultModeForTheme(theme);
        const expectedMode = finalModePreference;
        if (finalModePreference !== "dark") await activateModeOption(finalModePreference, expectedMode);

        const persistenceDeadline = Date.now() + 30_000;
        let databaseTheme = null;
        let databaseModePreference = null;
        let databaseStatus = 0;
        while (Date.now() < persistenceDeadline) {
          const databaseResponse = await fetch(`${origin}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          databaseStatus = databaseResponse.status;
          if (databaseResponse.ok) {
            const databaseIdentity = await databaseResponse.json();
            databaseTheme = databaseIdentity?.user?.themePreference ?? null;
            databaseModePreference = databaseIdentity?.user?.themeModePreference ?? null;
            if (databaseTheme === theme && databaseModePreference === finalModePreference) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.equal(databaseTheme, theme, `THEME_DATABASE_SAVE_FAILED:${theme}:HTTP_${databaseStatus}`);
        assert.equal(databaseModePreference, finalModePreference, `THEME_MODE_DATABASE_SAVE_FAILED:${theme}:HTTP_${databaseStatus}`);
        report.switching.databaseReads.push({ theme, databaseStatus, databaseTheme, databaseModePreference });

        await switchPage.reload({ waitUntil: "networkidle", timeout: 60_000 });
        await switchPage.waitForSelector(".marketplace-shell", { timeout: 30_000 });
        await switchPage.waitForTimeout(300);
        const persisted = await switchPage.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          themeSelection: document.documentElement.dataset.themeSelection,
          modePreference: document.documentElement.dataset.modePreference,
          mode: document.documentElement.dataset.mode,
          localPreference: localStorage.getItem("user_theme_preference"),
          localModePreference: localStorage.getItem("user_theme_mode_preference"),
        }));
        assert.deepEqual(persisted, {
          theme,
          themeSelection: theme,
          modePreference: finalModePreference,
          mode: expectedMode,
          localPreference: theme,
          localModePreference: finalModePreference,
        }, `THEME_RELOAD_MISMATCH:${theme}`);
        const databaseResponse = await fetch(`${origin}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        assert.equal(databaseResponse.ok, true, `THEME_DATABASE_READ_FAILED:${theme}`);
        const databaseIdentity = await databaseResponse.json();
        assert.equal(databaseIdentity?.user?.themePreference, theme, `THEME_DATABASE_MISMATCH:${theme}`);
        assert.equal(databaseIdentity?.user?.themeModePreference, finalModePreference, `THEME_MODE_DATABASE_MISMATCH:${theme}`);
        report.switching.persistedThemes.push(theme);
      }

      await switchPage.evaluate(() => sessionStorage.removeItem("entered_app"));
      await switchPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await switchPage.waitForSelector('[data-testid="soft-white-premium-home"]', { timeout: 30_000 });
      for (const theme of themes) {
        const expectedMode = defaultModeForTheme(theme);
        const expectedRenderedTheme = expectedMode === "light" ? "soft-white" : theme;
        await activateThemeOption(theme);
        await activateModeOption(expectedMode, expectedMode);
        await switchPage.waitForFunction(({ selectedTheme, renderedTheme, mode }) => {
          const home = document.querySelector('[data-testid="soft-white-premium-home"]');
          return document.documentElement.dataset.themeSelection === selectedTheme
            && document.documentElement.dataset.theme === renderedTheme
            && document.documentElement.dataset.mode === mode
            && home?.getAttribute("data-theme-synced-home") === "true";
        }, { selectedTheme: theme, renderedTheme: expectedRenderedTheme, mode: expectedMode });
        await switchPage.waitForTimeout(500);
        const transition = await switchPage.evaluate(() => {
          const home = document.querySelector('[data-testid="soft-white-premium-home"]');
          return {
            theme: document.documentElement.dataset.theme,
            themeSelection: document.documentElement.dataset.themeSelection,
            mode: document.documentElement.dataset.mode,
            backgroundImage: home ? getComputedStyle(home).backgroundImage : "",
            color: home ? getComputedStyle(home).color : "",
          };
        });
        report.switching.landingTransitions.push(transition);
      }
      assert.equal(new Set(report.switching.landingTransitions.map((item) => item.backgroundImage)).size, themes.length, "LANDING_SWITCH_VISUAL_NOT_UPDATED");
    } finally {
      const restore = await fetch(`${origin}/api/auth/me`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(originalPreference && originalModePreference
          ? { theme_preference: originalPreference, theme_mode_preference: originalModePreference }
          : { theme_preference: null, theme_mode_preference: null }),
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(restore.ok, true, "ORIGINAL_THEME_RESTORE_FAILED");
      const restored = await fetch(`${origin}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      const restoredIdentity = await restored.json();
      assert.equal(restoredIdentity?.user?.themePreference ?? null, originalPreference, "ORIGINAL_THEME_RESTORE_MISMATCH");
      assert.equal(restoredIdentity?.user?.themeModePreference ?? null, originalModePreference, "ORIGINAL_THEME_MODE_RESTORE_MISMATCH");
      report.switching.restoredOriginalPreference = true;
      await switchContext.close();
    }

    const loginContext = await browser.newContext({ viewport: viewports[0], serviceWorkers: "block" });
    await loginContext.addInitScript(() => {
      localStorage.setItem("user_theme_preference", "soft-white");
      localStorage.setItem("user_theme_mode_preference", "light");
      localStorage.setItem("app_theme", "soft-white");
      localStorage.setItem("app_mode", "light");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      sessionStorage.removeItem("entered_app");
    });
    const loginPage = await loginContext.newPage();
    loginPage.on("pageerror", (error) => report.pageErrors.push(`login:${error.message.slice(0, 300)}`));
    loginPage.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(`login:${message.text().slice(0, 300)}`);
    });
    loginPage.on("response", (response) => {
      if (response.status() >= 500) report.serverErrors.push(`login:${response.status()} ${new URL(response.url()).pathname}`);
    });
    loginPage.on("request", (request) => {
      const url = new URL(request.url());
      const method = request.method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
        && !(method === "POST" && url.pathname === "/api/announcements/events")) {
        report.unexpectedWrites.push(`login:${method} ${url.pathname}`);
      }
    });
    await loginPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await loginPage.waitForSelector('[data-testid="soft-white-premium-home"]', { timeout: 30_000 });
    const loginTrigger = loginPage.locator(".swh-login-button");
    await loginTrigger.focus();
    await loginTrigger.click();
    const loginDialog = loginPage.getByRole("dialog", { name: "回到内容工作台" });
    await loginDialog.waitFor({ state: "visible", timeout: 30_000 });
    await loginPage.waitForSelector("#login-password", { state: "visible", timeout: 30_000 });
    await loginPage.waitForFunction(() => document.querySelector(".swh-login-drawer")?.contains(document.activeElement));
    const loginOpenMetrics = await loginPage.evaluate(() => {
      const dialog = document.querySelector(".swh-login-drawer");
      const title = dialog?.querySelector("h2");
      const copy = dialog?.querySelector(".swh-login-intro p");
      const parse = (value) => (String(value || "").match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const [r, g, b] = parse(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const ratio = (front, back) => {
        const [light, dark] = [luminance(front), luminance(back)].sort((left, right) => right - left);
        return (light + .05) / (dark + .05);
      };
      const background = dialog ? getComputedStyle(dialog).backgroundColor : "";
      return {
        activeInside: !!dialog?.contains(document.activeElement),
        backgroundInert: [document.querySelector(".swh-header"), document.querySelector("main"), document.querySelector(".swh-footer")]
          .every((node) => node?.hasAttribute("inert") && node?.getAttribute("aria-hidden") === "true"),
        scrollLocked: document.querySelector('[data-testid="soft-white-premium-home"]')?.style.overflowY === "hidden",
        titleContrast: title ? ratio(getComputedStyle(title).color, background) : 0,
        copyContrast: copy ? ratio(getComputedStyle(copy).color, background) : 0,
        background,
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
      };
    });
    assert.equal(loginOpenMetrics.theme, "soft-white", "LOGIN_DRAWER_THEME_MISMATCH");
    assert.equal(loginOpenMetrics.mode, "light", "LOGIN_DRAWER_MODE_MISMATCH");
    assert.equal(loginOpenMetrics.activeInside, true, "LOGIN_DIALOG_FOCUS_NOT_MOVED");
    assert.equal(loginOpenMetrics.backgroundInert, true, "LOGIN_DIALOG_BACKGROUND_NOT_INERT");
    assert.equal(loginOpenMetrics.scrollLocked, true, "LOGIN_DIALOG_BACKGROUND_SCROLL_NOT_LOCKED");
    assert.ok(loginOpenMetrics.titleContrast >= 4.5, `LOGIN_TITLE_CONTRAST:${loginOpenMetrics.titleContrast}`);
    assert.ok(loginOpenMetrics.copyContrast >= 4.5, `LOGIN_COPY_CONTRAST:${loginOpenMetrics.copyContrast}`);
    const passwordInput = loginPage.locator("#login-password");
    const passwordToggle = loginPage.locator('.login-password-toggle[aria-controls="login-password"]');
    assert.equal(await passwordInput.getAttribute("type"), "password", "LOGIN_PASSWORD_INITIAL_TYPE_MISMATCH");
    assert.equal(await passwordToggle.getAttribute("aria-controls"), "login-password", "LOGIN_PASSWORD_TOGGLE_CONTROL_MISMATCH");
    assert.equal(await passwordToggle.getAttribute("aria-pressed"), "false", "LOGIN_PASSWORD_TOGGLE_INITIAL_STATE_MISMATCH");
    await passwordToggle.click();
    assert.equal(await passwordInput.getAttribute("type"), "text", "LOGIN_PASSWORD_NOT_REVEALED");
    assert.equal(await passwordToggle.getAttribute("aria-label"), "隐藏密码", "LOGIN_PASSWORD_TOGGLE_REVEALED_LABEL_MISMATCH");
    assert.equal(await passwordToggle.getAttribute("aria-pressed"), "true", "LOGIN_PASSWORD_TOGGLE_REVEALED_STATE_MISMATCH");
    await passwordToggle.click();
    assert.equal(await passwordInput.getAttribute("type"), "password", "LOGIN_PASSWORD_NOT_HIDDEN_AGAIN");
    assert.equal(await passwordToggle.getAttribute("aria-label"), "显示密码", "LOGIN_PASSWORD_TOGGLE_HIDDEN_LABEL_MISMATCH");
    await loginDialog.evaluate((dialog) => {
      const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.tabIndex >= 0);
      focusable.at(-1)?.focus();
    });
    await loginPage.keyboard.press("Tab");
    const tabTrapped = await loginDialog.evaluate((dialog) => dialog.contains(document.activeElement));
    assert.equal(tabTrapped, true, "LOGIN_DIALOG_TAB_ESCAPED");
    await loginPage.screenshot({ path: path.join(outputDir, "soft-white-login-modal-1440x900.png"), fullPage: false });
    await loginPage.keyboard.press("Escape");
    await loginPage.waitForSelector(".swh-login-drawer", { state: "detached", timeout: 10_000 });
    const focusRestored = await loginPage.evaluate(() => document.activeElement?.classList.contains("swh-login-button") || false);
    assert.equal(focusRestored, true, "LOGIN_TRIGGER_FOCUS_NOT_RESTORED");
    report.loginModal = {
      ...loginOpenMetrics,
      tabTrapped,
      focusRestored,
      passwordToggle: { controls: "login-password", revealedType: "text", restoredType: "password", ariaLabels: ["显示密码", "隐藏密码"] },
    };
    await loginContext.close();

    const loginDrawerSignatures = [];
    for (const theme of themes) {
      const selectedMode = defaultModeForTheme(theme);
      const drawerContext = await browser.newContext({ viewport: viewports[0], serviceWorkers: "block" });
      await drawerContext.route("**/api/settings", async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ settings: { theme, theme_mode: selectedMode } }),
        });
      });
      await drawerContext.addInitScript(({ selectedTheme, mode }) => {
        localStorage.setItem("user_theme_preference", selectedTheme);
        localStorage.setItem("user_theme_mode_preference", mode);
        localStorage.setItem("app_theme", selectedTheme);
        localStorage.setItem("app_mode", mode);
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        sessionStorage.removeItem("entered_app");
      }, { selectedTheme: theme, mode: selectedMode });
      const drawerPage = await drawerContext.newPage();
      drawerPage.on("pageerror", (error) => report.pageErrors.push(`drawer:${theme}:${error.message.slice(0, 300)}`));
      drawerPage.on("console", (message) => {
        if (message.type() === "error") report.consoleErrors.push(`drawer:${theme}:${message.text().slice(0, 300)}`);
      });
      drawerPage.on("response", (response) => {
        if (response.status() >= 500) report.serverErrors.push(`drawer:${theme}:${response.status()} ${new URL(response.url()).pathname}`);
      });
      drawerPage.on("request", (request) => {
        const url = new URL(request.url());
        const method = request.method();
        if (/\/(generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) {
          report.paidRequests.push(`drawer:${theme}:${method} ${url.pathname}`);
        }
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
          && !(method === "POST" && url.pathname === "/api/announcements/events")) {
          report.unexpectedWrites.push(`drawer:${theme}:${method} ${url.pathname}`);
        }
      });
      await drawerPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await drawerPage.waitForSelector('[data-testid="soft-white-premium-home"]', { timeout: 30_000 });
      await drawerPage.locator(".swh-login-button").click();
      await drawerPage.waitForSelector("#login-password", { state: "visible", timeout: 30_000 });
      const drawerMetrics = await drawerPage.evaluate(() => {
        const drawer = document.querySelector(".swh-login-drawer");
        const panel = drawer?.querySelector(".login-panel");
        const field = drawer?.querySelector("#login-password");
        const toggle = drawer?.querySelector(".login-password-toggle");
        const drawerStyle = drawer ? getComputedStyle(drawer) : null;
        const panelStyle = panel ? getComputedStyle(panel) : null;
        const fieldStyle = field ? getComputedStyle(field) : null;
        const toggleStyle = toggle ? getComputedStyle(toggle) : null;
        const drawerRect = drawer?.getBoundingClientRect();
        const toggleRect = toggle?.getBoundingClientRect();
        return {
          theme: document.documentElement.dataset.theme,
          themeSelection: document.documentElement.dataset.themeSelection,
          mode: document.documentElement.dataset.mode,
          modePreference: document.documentElement.dataset.modePreference,
          drawerBackground: drawerStyle?.background || "",
          drawerBackgroundColor: drawerStyle?.backgroundColor || "",
          drawerBorderColor: drawerStyle?.borderLeftColor || "",
          panelBackground: panelStyle?.background || "",
          fieldBackground: fieldStyle?.backgroundColor || "",
          toggleColor: toggleStyle?.color || "",
          toggleWidth: toggleRect?.width || 0,
          toggleHeight: toggleRect?.height || 0,
          drawerWithinViewport: !!drawerRect && drawerRect.left >= -1 && drawerRect.right <= window.innerWidth + 1,
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      });
      assert.equal(drawerMetrics.theme, theme, `LOGIN_DRAWER_THEME_MISMATCH:${theme}`);
      assert.equal(drawerMetrics.themeSelection, theme, `LOGIN_DRAWER_THEME_SELECTION_MISMATCH:${theme}`);
      assert.equal(drawerMetrics.mode, selectedMode, `LOGIN_DRAWER_MODE_MISMATCH:${theme}`);
      assert.equal(drawerMetrics.modePreference, selectedMode, `LOGIN_DRAWER_MODE_PREFERENCE_MISMATCH:${theme}`);
      assert.match(drawerMetrics.drawerBackground, /gradient/iu, `LOGIN_DRAWER_THEME_BACKGROUND_MISSING:${theme}`);
      assert.ok(drawerMetrics.drawerBorderColor && drawerMetrics.drawerBorderColor !== "rgba(0, 0, 0, 0)", `LOGIN_DRAWER_BORDER_MISSING:${theme}`);
      assert.ok(drawerMetrics.panelBackground, `LOGIN_PANEL_BACKGROUND_MISSING:${theme}`);
      assert.ok(drawerMetrics.fieldBackground, `LOGIN_FIELD_BACKGROUND_MISSING:${theme}`);
      assert.ok(drawerMetrics.toggleWidth >= 36 && drawerMetrics.toggleHeight >= 36, `LOGIN_PASSWORD_TOGGLE_TARGET_TOO_SMALL:${theme}`);
      assert.equal(drawerMetrics.drawerWithinViewport, true, `LOGIN_DRAWER_OUTSIDE_VIEWPORT:${theme}`);
      assert.equal(drawerMetrics.overflowX, 0, `LOGIN_DRAWER_HORIZONTAL_OVERFLOW:${theme}`);
      report.loginDrawers[theme] = drawerMetrics;
      loginDrawerSignatures.push([
        drawerMetrics.drawerBackground,
        drawerMetrics.drawerBorderColor,
        drawerMetrics.panelBackground,
        drawerMetrics.toggleColor,
      ].join("|"));
      await drawerPage.screenshot({ path: path.join(outputDir, `${theme}-login-drawer-1440x900.png`), fullPage: false });
      await drawerContext.close();
    }
    assert.equal(new Set(loginDrawerSignatures).size, themes.length, "LOGIN_DRAWER_THEME_SIGNATURES_NOT_DISTINCT");

    const motionContext = await browser.newContext({ viewport: viewports[0], serviceWorkers: "block" });
    await motionContext.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("user_theme_preference", "lattice");
      localStorage.setItem("user_theme_mode_preference", "dark");
      localStorage.setItem("app_theme", "lattice");
      localStorage.setItem("app_mode", "dark");
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      if (!sessionStorage.getItem("main_theme_motion_initialized")) {
        sessionStorage.removeItem("entered_app");
        sessionStorage.setItem("main_theme_motion_initialized", "1");
      }
    }, { sessionToken: token, user: identity.user });
    const motionPage = await motionContext.newPage();
    motionPage.on("pageerror", (error) => report.pageErrors.push(`motion:${error.message.slice(0, 300)}`));
    motionPage.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(`motion:${message.text().slice(0, 300)}`);
    });
    motionPage.on("response", (response) => {
      if (response.status() >= 500) report.serverErrors.push(`motion:${response.status()} ${new URL(response.url()).pathname}`);
    });
    motionPage.on("request", (request) => {
      const url = new URL(request.url());
      const method = request.method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
        && !(method === "POST" && url.pathname === "/api/announcements/events")) {
        report.unexpectedWrites.push(`motion:${method} ${url.pathname}`);
      }
    });
    await motionPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await motionPage.waitForSelector('[data-testid="soft-white-premium-home"]', { timeout: 30_000 });
    await motionPage.mouse.move(320, 260);
    await motionPage.waitForFunction(() => document.querySelector('[data-testid="soft-white-premium-home"]')?.getAttribute("data-pointer-motion") === "active");
    const pointerBeforeReduce = await motionPage.locator('[data-testid="soft-white-premium-home"]').getAttribute("data-pointer-motion");
    await motionPage.emulateMedia({ reducedMotion: "reduce" });
    await motionPage.waitForFunction(() => !document.querySelector('[data-testid="soft-white-premium-home"]')?.hasAttribute("data-pointer-motion"));
    await motionPage.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      window.__swhScrollBehavior = null;
      Element.prototype.scrollIntoView = function patchedScrollIntoView(options) {
        window.__swhScrollBehavior = typeof options === "object" ? options.behavior || null : null;
        return original.call(this, options);
      };
    });
    await motionPage.getByRole("button", { name: "能力全景", exact: true }).click();
    await motionPage.waitForTimeout(150);
    const reducedMotionMetrics = await motionPage.evaluate(() => {
      const home = document.querySelector('[data-testid="soft-white-premium-home"]');
      const aura = document.querySelector(".swh-aura-one");
      const factory = document.querySelector(".swh-factory-ring-one");
      const network = document.querySelector('[data-testid="swh-pointer-network"]');
      return {
        pointerBeforeReduce: home ? "active" : null,
        pointerAfterReduce: home?.getAttribute("data-pointer-motion") || null,
        scrollBehavior: getComputedStyle(home).scrollBehavior,
        requestedScrollBehavior: window.__swhScrollBehavior || null,
        auraAnimationDuration: aura ? getComputedStyle(aura).animationDuration : "",
        factoryAnimationDuration: factory ? getComputedStyle(factory).animationDuration : "",
        networkState: network?.getAttribute("data-network-state") || null,
        networkPointer: network?.getAttribute("data-network-pointer") || null,
      };
    });
    reducedMotionMetrics.pointerBeforeReduce = pointerBeforeReduce;
    assert.equal(reducedMotionMetrics.pointerBeforeReduce, "active", "POINTER_BASELINE_NOT_ACTIVE");
    assert.equal(reducedMotionMetrics.pointerAfterReduce, null, "POINTER_REDUCED_MOTION_STILL_ACTIVE");
    assert.equal(reducedMotionMetrics.scrollBehavior, "auto", "REDUCED_MOTION_SCROLL_STYLE_NOT_AUTO");
    assert.equal(reducedMotionMetrics.requestedScrollBehavior, "auto", "REDUCED_MOTION_SCROLL_REQUEST_NOT_AUTO");
    assert.equal(reducedMotionMetrics.networkState, "static", "POINTER_NETWORK_REDUCED_MOTION_NOT_STATIC");
    assert.equal(reducedMotionMetrics.networkPointer, null, "POINTER_NETWORK_REDUCED_MOTION_STILL_TRACKING");
    await motionPage.screenshot({ path: path.join(outputDir, "lattice-reduced-motion-1440x900.png"), fullPage: false });
    await motionPage.evaluate(() => sessionStorage.setItem("entered_app", "1"));
    await motionPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await motionPage.waitForSelector(".marketplace-agent-grid .agent-card-hover:not([aria-disabled='true'])", { timeout: 30_000 });
    const reducedCard = motionPage.locator(".marketplace-agent-grid .agent-card-hover:not([aria-disabled='true'])").first();
    const reducedMarketplaceBefore = await reducedCard.evaluate((card) => {
      const layer = document.querySelector(".marketplace-depth");
      const wrapper = card.closest("[data-agent-card-id]");
      const cardStyle = getComputedStyle(card);
      const layerStyle = layer ? getComputedStyle(layer, "::before") : null;
      const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
      return {
        gridAnimationName: layerStyle?.animationName || "",
        cardAnimationName: cardStyle.animationName,
        cardTranslate: cardStyle.translate,
        cardTransform: cardStyle.transform,
        entryAnimationName: wrapperStyle?.animationName || "",
      };
    });
    await reducedCard.hover();
    await motionPage.waitForTimeout(100);
    const reducedMarketplaceAfter = await reducedCard.evaluate((card) => ({
      cardTransform: getComputedStyle(card).transform,
      cardTranslate: getComputedStyle(card).translate,
    }));
    assert.equal(reducedMarketplaceBefore.gridAnimationName, "none", "REDUCED_MOTION_GRID_ANIMATION_ACTIVE");
    assert.equal(reducedMarketplaceBefore.cardAnimationName, "none", "REDUCED_MOTION_CARD_FLOAT_ACTIVE");
    assert.equal(reducedMarketplaceBefore.entryAnimationName, "none", "REDUCED_MOTION_CARD_ENTRY_ACTIVE");
    assert.equal(reducedMarketplaceBefore.cardTranslate, "none", "REDUCED_MOTION_CARD_TRANSLATE_ACTIVE");
    assert.equal(reducedMarketplaceAfter.cardTransform, "none", "REDUCED_MOTION_CARD_HOVER_TRANSFORM_ACTIVE");
    assert.equal(reducedMarketplaceAfter.cardTranslate, "none", "REDUCED_MOTION_CARD_HOVER_TRANSLATE_ACTIVE");
    reducedMotionMetrics.marketplace = {
      before: reducedMarketplaceBefore,
      after: reducedMarketplaceAfter,
    };
    await motionPage.screenshot({ path: path.join(outputDir, "lattice-marketplace-reduced-motion-1440x900.png"), fullPage: false });
    report.reducedMotion = reducedMotionMetrics;
    await motionContext.close();

    for (const viewport of viewports) {
      for (const theme of themes) {
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        const themedIdentity = {
          ...identity.user,
          themePreference: theme,
          theme_preference: theme,
          themeModePreference: defaultModeForTheme(theme),
          theme_mode_preference: defaultModeForTheme(theme),
        };
        await context.addInitScript(({ sessionToken, user, selectedTheme, selectedMode }) => {
          if (!sessionStorage.getItem("main_theme_suite_initialized")) {
            localStorage.setItem("auth_token", sessionToken);
            localStorage.setItem("auth_user", JSON.stringify(user));
            localStorage.setItem("user_theme_preference", selectedTheme);
            localStorage.setItem("user_theme_mode_preference", selectedMode);
            localStorage.setItem("app_theme", selectedTheme);
            localStorage.setItem("app_mode", selectedMode);
            sessionStorage.setItem("entered_app", "1");
            sessionStorage.setItem("main_theme_suite_initialized", "1");
          }
        }, { sessionToken: token, user: themedIdentity, selectedTheme: theme, selectedMode: defaultModeForTheme(theme) });
        await context.route("**/api/auth/me", async (route) => {
          const method = route.request().method();
          if (method === "GET" || method === "PUT") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ user: themedIdentity }),
            });
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => report.pageErrors.push(`${theme}:${viewport.name}:${error.message.slice(0, 300)}`));
        page.on("console", (message) => {
          if (message.type() === "error") report.consoleErrors.push(`${theme}:${viewport.name}:${message.text().slice(0, 300)}`);
        });
        page.on("response", (response) => {
          if (response.status() >= 500) report.serverErrors.push(`${theme}:${viewport.name}:${response.status()} ${new URL(response.url()).pathname}`);
        });
        page.on("request", (request) => {
          const url = new URL(request.url());
          const method = request.method();
          if (/\/(generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) {
            report.paidRequests.push(`${method} ${url.pathname}`);
          }
          if (["POST", "PUT", "PATCH", "DELETE"].includes(method)
            && !(method === "POST" && url.pathname === "/api/announcements/events")) {
            report.unexpectedWrites.push(`${method} ${url.pathname}`);
          }
        });

        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(".marketplace-shell", { timeout: 30_000 });
        if (injectSource) await page.addStyleTag({ content: sourceCss[theme] });
        await page.waitForFunction(({ selectedTheme, selectedMode }) => document.documentElement.dataset.theme === selectedTheme
          && document.documentElement.dataset.mode === selectedMode,
        { selectedTheme: theme, selectedMode: defaultModeForTheme(theme) });
        await page.waitForTimeout(500);
        const metrics = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const shell = document.querySelector(".marketplace-shell");
          const depth = document.querySelector(".marketplace-depth");
          const grid = document.querySelector(".marketplace-agent-grid");
          const card = document.querySelector(".marketplace-agent-grid .agent-card-hover");
          const wrapper = card?.closest("[data-agent-card-id]") || null;
          const trigger = document.querySelector('[data-theme-switcher-trigger="true"]');
          const shellStyle = shell ? getComputedStyle(shell) : null;
          const depthLayerStyle = depth ? getComputedStyle(depth, "::before") : null;
          const gridTemplate = grid ? getComputedStyle(grid).gridTemplateColumns : "none";
          const cardStyle = card ? getComputedStyle(card) : null;
          const primaryProbe = document.createElement("span");
          primaryProbe.style.color = "var(--primary)";
          document.body.append(primaryProbe);
          const resolvedPrimary = getComputedStyle(primaryProbe).color;
          primaryProbe.remove();
          const activeNavIcon = document.querySelector(".nav-pill-active .nav-pill-icon");
          const activeCategoryIcon = document.querySelector(".category-tab-active .cat-tab-icon svg, .category-tab-active .cat-tab-icon");
          const shortcutIcon = document.querySelector(".sidebar-shortcut-icon");
          const cardBorderColors = Array.from(document.querySelectorAll(".marketplace-agent-grid > [data-agent-card-id] .agent-card-hover"))
            .slice(0, 4)
            .map((node) => getComputedStyle(node).borderColor);
          const cardAccentColors = Array.from(document.querySelectorAll(".marketplace-agent-grid > [data-agent-card-id] .agent-card-hover"))
            .slice(0, 4)
            .map((node) => getComputedStyle(node).getPropertyValue("--marketplace-float-edge").trim());
          return {
            theme: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.mode,
            bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
            shellBackgroundImage: shellStyle?.backgroundImage || "",
            gridLayerBackgroundImage: depthLayerStyle?.backgroundImage || "",
            gridLayerAnimationName: depthLayerStyle?.animationName || "",
            gridLayerTransform: depthLayerStyle?.transform || "",
            cardBackground: cardStyle?.background || "",
            cardBorderColor: cardStyle?.borderColor || "",
            cardBorderColors,
            cardAccentColors,
            cardAnimationName: cardStyle?.animationName || "",
            cardTransitionProperty: cardStyle?.transitionProperty || "",
            cardTranslate: cardStyle?.translate || "",
            cardTransform: cardStyle?.transform || "",
            cardShadow: cardStyle?.boxShadow || "",
            cardWrapperOverflow: wrapper ? getComputedStyle(wrapper).overflow : "",
            primary: root.getPropertyValue("--primary").trim().toLowerCase(),
            resolvedPrimary,
            activeNavIconColor: activeNavIcon ? getComputedStyle(activeNavIcon).color : "",
            activeCategoryIconColor: activeCategoryIcon ? getComputedStyle(activeCategoryIcon).color : "",
            shortcutIconColor: shortcutIcon ? getComputedStyle(shortcutIcon).color : "",
            themeTriggerVisible: !!trigger && getComputedStyle(trigger).display !== "none",
            gridColumns: gridTemplate === "none" ? 0 : gridTemplate.split(" ").filter(Boolean).length,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });
        assert.equal(metrics.theme, theme, `THEME_ROOT_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(metrics.mode, defaultModeForTheme(theme), `THEME_MODE_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(metrics.overflowX, 0, `HORIZONTAL_OVERFLOW:${theme}:${viewport.name}`);
        assert.equal(metrics.themeTriggerVisible, true, `THEME_TRIGGER_MISSING:${theme}:${viewport.name}`);
        assert.ok(metrics.gridColumns >= 4, `MARKETPLACE_GRID_TOO_SPARSE:${theme}:${viewport.name}:${metrics.gridColumns}`);
        assert.notEqual(metrics.gridLayerBackgroundImage, "none", `MARKETPLACE_SPACE_GRID_MISSING:${theme}:${viewport.name}`);
        if (theme === "lattice") {
          assert.match(metrics.gridLayerAnimationName, /marketplace-grid-flight/u, `LATTICE_SPACE_GRID_MOTION_MISSING:${viewport.name}:${metrics.gridLayerAnimationName}`);
          assert.notEqual(metrics.gridLayerTransform, "none", `LATTICE_SPACE_GRID_DEPTH_MISSING:${viewport.name}`);
        } else {
          assert.ok(redesignedThemes.includes(theme), `UNKNOWN_REDESIGNED_THEME:${theme}`);
          assert.equal(metrics.gridLayerAnimationName, "none", `REDESIGNED_GRID_ANIMATION_ACTIVE:${theme}:${viewport.name}:${metrics.gridLayerAnimationName}`);
          assert.equal(metrics.gridLayerTransform, "none", `REDESIGNED_GRID_TRANSFORM_ACTIVE:${theme}:${viewport.name}:${metrics.gridLayerTransform}`);
        }
        assert.equal(metrics.cardAnimationName, "none", `MARKETPLACE_CARD_IDLE_MOTION_UNSTABLE:${theme}:${viewport.name}:${metrics.cardAnimationName}`);
        assert.match(metrics.cardTransitionProperty, /transform/u, `MARKETPLACE_CARD_LIFT_TRANSITION_MISSING:${theme}:${viewport.name}:${metrics.cardTransitionProperty}`);
        assert.equal(metrics.cardWrapperOverflow, "visible", `MARKETPLACE_CARD_SHADOW_CLIPPED:${theme}:${viewport.name}:${metrics.cardWrapperOverflow}`);
        if (theme !== "soft-white") {
          assert.ok(new Set(metrics.cardAccentColors).size >= 3, `MARKETPLACE_CARD_ACCENT_DEPTH_MISSING:${theme}:${viewport.name}:${metrics.cardAccentColors.join("|")}`);
        }
        if (theme === "soft-white") {
          assert.notEqual(metrics.shellBackgroundImage, "none", `SOFT_WHITE_MARKETPLACE_GRADIENT_MISSING:${viewport.name}`);
        }
        if (["crystal-aurora", "stellar-blue"].includes(theme)) {
          assert.equal(metrics.activeNavIconColor, metrics.resolvedPrimary, `THEME_NAV_ICON_COLOR_MISMATCH:${theme}:${viewport.name}`);
          assert.equal(metrics.activeCategoryIconColor, metrics.resolvedPrimary, `THEME_CATEGORY_ICON_COLOR_MISMATCH:${theme}:${viewport.name}`);
          assert.equal(metrics.shortcutIconColor, metrics.resolvedPrimary, `THEME_SHORTCUT_ICON_COLOR_MISMATCH:${theme}:${viewport.name}`);
        }
        await page.screenshot({ path: path.join(outputDir, `${theme}-marketplace-${viewport.name}.png`), fullPage: false });
        const interactiveCard = page.locator(".marketplace-agent-grid .agent-card-hover:not([aria-disabled='true'])").first();
        const hoverBefore = await interactiveCard.evaluate((card) => {
          const style = getComputedStyle(card);
          const box = card.getBoundingClientRect();
          return {
            top: box.top,
            transform: style.transform,
            translate: style.translate,
            shadow: style.boxShadow,
            borderColor: style.borderColor,
          };
        });
        await interactiveCard.hover();
        await page.waitForTimeout(420);
        const hoverAfter = await interactiveCard.evaluate((card) => {
          const style = getComputedStyle(card);
          const box = card.getBoundingClientRect();
          return {
            top: box.top,
            transform: style.transform,
            translate: style.translate,
            shadow: style.boxShadow,
            borderColor: style.borderColor,
            hovered: card.matches(":hover"),
          };
        });
        assert.equal(hoverAfter.hovered, true, `MARKETPLACE_CARD_HOVER_NOT_REACHED:${theme}:${viewport.name}`);
        assert.notEqual(hoverAfter.transform, "none", `MARKETPLACE_CARD_HOVER_LIFT_MISSING:${theme}:${viewport.name}`);
        const hoverLift = hoverBefore.top - hoverAfter.top;
        assert.ok(hoverLift >= 1, `MARKETPLACE_CARD_HOVER_TOO_WEAK:${theme}:${viewport.name}:${hoverLift}`);
        assert.ok(hoverLift <= 4.5, `MARKETPLACE_CARD_HOVER_TOO_HIGH:${theme}:${viewport.name}:${hoverLift}`);
        assert.notEqual(hoverAfter.shadow, hoverBefore.shadow, `MARKETPLACE_CARD_HOVER_SHADOW_STATIC:${theme}:${viewport.name}`);
        assert.notEqual(hoverAfter.borderColor, hoverBefore.borderColor, `MARKETPLACE_CARD_HOVER_EDGE_STATIC:${theme}:${viewport.name}`);
        await page.screenshot({ path: path.join(outputDir, `${theme}-marketplace-hover-${viewport.name}.png`), fullPage: false });
        await page.keyboard.press("Tab");
        await interactiveCard.focus();
        await page.waitForTimeout(120);
        const focusMetrics = await interactiveCard.evaluate((card) => ({
          active: document.activeElement === card,
          focusVisible: card.matches(":focus-visible"),
          transform: getComputedStyle(card).transform,
        }));
        assert.equal(focusMetrics.active, true, `MARKETPLACE_CARD_KEYBOARD_FOCUS_MISSING:${theme}:${viewport.name}`);
        assert.equal(focusMetrics.focusVisible, true, `MARKETPLACE_CARD_FOCUS_VISIBLE_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(focusMetrics.transform, "none", `MARKETPLACE_CARD_FOCUS_LIFT_MISSING:${theme}:${viewport.name}`);
        metrics.interaction = { hoverBefore, hoverAfter, focus: focusMetrics };
        report.themes[`${theme}:marketplace:${viewport.name}`] = metrics;

        await page.evaluate(() => sessionStorage.removeItem("entered_app"));
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector('[data-testid="soft-white-premium-home"]', { timeout: 30_000 });
        if (injectSource) await page.addStyleTag({ content: sourceCss[theme] });
        await page.waitForFunction(({ selectedTheme, selectedMode }) => document.documentElement.dataset.theme === selectedTheme
          && document.documentElement.dataset.mode === selectedMode,
        { selectedTheme: theme, selectedMode: defaultModeForTheme(theme) });
        await page.waitForTimeout(350);
        const landingMetrics = await page.evaluate(() => {
          const home = document.querySelector('[data-testid="soft-white-premium-home"]');
          const hero = document.querySelector(".swh-hero");
          const loop = document.querySelector(".swh-loop");
          const header = document.querySelector(".swh-header");
          const atmosphere = document.querySelector('[data-testid="swh-theme-atmosphere"]');
          const aura = document.querySelector(".swh-aura-one");
          const motionGrid = document.querySelector(".swh-motion-grid");
          const dataStream = document.querySelector(".swh-data-stream");
          const particleField = document.querySelector(".swh-particle-field");
          const diagonalSweep = document.querySelector(".swh-light-sweep");
          const pointerNetwork = document.querySelector('[data-testid="swh-pointer-network"]');
          const accent = document.querySelector(".swh-title-accent");
          const factory = document.querySelector('[data-testid="swh-content-factory"]');
          const factoryRing = document.querySelector(".swh-factory-ring-one");
          const homeStyle = home ? getComputedStyle(home) : null;
          const loopStyle = loop ? getComputedStyle(loop) : null;
          const headerStyle = header ? getComputedStyle(header) : null;
          const auraStyle = aura ? getComputedStyle(aura) : null;
          const motionGridStyle = motionGrid ? getComputedStyle(motionGrid) : null;
          const dataStreamStyle = dataStream ? getComputedStyle(dataStream) : null;
          const diagonalSweepStyle = diagonalSweep ? getComputedStyle(diagonalSweep) : null;
          const maxFxAnimationNames = [motionGrid, dataStream, particleField]
            .map((node) => node ? getComputedStyle(node).animationName : "none");
          const accentStyle = accent ? getComputedStyle(accent) : null;
          const factoryStyle = factory ? getComputedStyle(factory) : null;
          const factoryRingStyle = factoryRing ? getComputedStyle(factoryRing) : null;
          const homeRect = home?.getBoundingClientRect();
          const criticalFontSizes = Array.from(document.querySelectorAll(".swh-console-stats small, .swh-console-stats strong, .swh-module-rail-items > span, .swh-production-flow span"))
            .map((node) => Number.parseFloat(getComputedStyle(node).fontSize) || 0);
          const clippedElements = homeRect ? Array.from(document.querySelectorAll(".swh-header, .swh-hero, .swh-loop, .swh-module-rail, .swh-section, .swh-footer"))
            .map((node) => {
              const rect = node.getBoundingClientRect();
              return { className: node.className, left: rect.left, right: rect.right };
            })
            .filter((rect) => rect.left < homeRect.left - 1 || rect.right > homeRect.right + 1)
            : [];
          return {
            theme: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.mode,
            themeSynced: home?.getAttribute("data-theme-synced-home") === "true",
            landingVersion: home?.getAttribute("data-landing-version") || "",
            homeBackgroundImage: homeStyle?.backgroundImage || "",
            homeBackgroundColor: homeStyle?.backgroundColor || "",
            homeColor: homeStyle?.color || "",
            headerBackground: headerStyle?.background || "",
            headerBackgroundColor: headerStyle?.backgroundColor || "",
            headerBrandColor: header ? getComputedStyle(header.querySelector(".swh-brand strong")).color : "",
            loopBackground: loopStyle?.background || "",
            loopBorderRadius: loopStyle?.borderRadius || "",
            accentBackground: accentStyle?.backgroundImage || "",
            auraAnimationName: auraStyle?.animationName || "none",
            maxFxAnimationNames,
            factoryPresent: !!factory && factoryStyle?.display !== "none",
            factoryAnimationName: factoryRingStyle?.animationName || "none",
            factoryTransform: factoryStyle?.transform || "none",
            pointerColor: homeStyle?.getPropertyValue("--swh-pointer-color").trim() || "",
            paletteTokens: homeStyle ? ["--oh-page", "--oh-accent", "--oh-accent-two", "--oh-accent-three"].map((name) => homeStyle.getPropertyValue(name).trim().toLowerCase()) : [],
            staticGridBackground: home ? getComputedStyle(home, "::before").backgroundImage : "",
            motionGridBackground: motionGridStyle?.backgroundImage || "",
            dataStreamBackground: dataStreamStyle?.backgroundImage || "",
            diagonalAnimationName: diagonalSweepStyle?.animationName || "none",
            diagonalTransform: diagonalSweepStyle?.transform || "none",
            motionLayerCount: atmosphere?.children.length || 0,
            pointerNetworkState: pointerNetwork?.getAttribute("data-network-state") || null,
            heroVisible: !!hero && getComputedStyle(hero).display !== "none" && Number.parseFloat(getComputedStyle(hero).opacity) > 0,
            heroRevealVisible: hero?.classList.contains("is-visible") || false,
            titleLines: Array.from(document.querySelectorAll(".swh-title-line")).map((node) => (node.textContent || "").trim()),
            sectionHeadings: Array.from(document.querySelectorAll(".swh-section-heading h2, .swh-heading-row h2")).map((node) => (node.textContent || "").trim()),
            loopSteps: document.querySelectorAll(".swh-loop li").length,
            productionModes: document.querySelectorAll(".swh-production-grid article").length,
            moduleCount: document.querySelectorAll(".swh-module-rail-items > span").length,
            criticalMinimumFontSize: criticalFontSizes.length ? Math.min(...criticalFontSizes) : 0,
            homeOverflowX: home ? Math.max(0, home.scrollWidth - home.clientWidth) : -1,
            clippedElements,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });
        await page.mouse.move(Math.round(viewport.width * 0.18), Math.round(viewport.height * 0.22));
        await page.waitForTimeout(320);
        const pointerStart = await page.locator('[data-testid="soft-white-premium-home"]').evaluate((home) => ({
          x: getComputedStyle(home).getPropertyValue("--swh-pointer-x").trim(),
          y: getComputedStyle(home).getPropertyValue("--swh-pointer-y").trim(),
          factoryTransform: document.querySelector('[data-testid="swh-content-factory"]')
            ? getComputedStyle(document.querySelector('[data-testid="swh-content-factory"]')).transform
            : "none",
          active: home.getAttribute("data-pointer-motion"),
          networkPointer: document.querySelector('[data-testid="swh-pointer-network"]')?.getAttribute("data-network-pointer") || null,
        }));
        await page.mouse.move(Math.round(viewport.width * 0.82), Math.round(viewport.height * 0.68));
        await page.waitForTimeout(320);
        const pointerEnd = await page.locator('[data-testid="soft-white-premium-home"]').evaluate((home) => ({
          x: getComputedStyle(home).getPropertyValue("--swh-pointer-x").trim(),
          y: getComputedStyle(home).getPropertyValue("--swh-pointer-y").trim(),
          factoryTransform: document.querySelector('[data-testid="swh-content-factory"]')
            ? getComputedStyle(document.querySelector('[data-testid="swh-content-factory"]')).transform
            : "none",
          active: home.getAttribute("data-pointer-motion"),
          networkPointer: document.querySelector('[data-testid="swh-pointer-network"]')?.getAttribute("data-network-pointer") || null,
        }));
        landingMetrics.pointerResponse = { start: pointerStart, end: pointerEnd };
        assert.equal(landingMetrics.theme, theme, `LANDING_THEME_ROOT_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.mode, defaultModeForTheme(theme), `LANDING_MODE_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.themeSynced, true, `LANDING_THEME_SYNC_MARKER_MISSING:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.landingVersion, "v2", `LANDING_V2_MARKER_MISSING:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.heroVisible, true, `LANDING_HERO_MISSING:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.heroRevealVisible, true, `LANDING_HERO_REVEAL_INCOMPLETE:${theme}:${viewport.name}`);
        assert.deepEqual(landingMetrics.titleLines, landingTitleLines, `LANDING_TITLE_CHANGED:${theme}:${viewport.name}`);
        assert.deepEqual(landingMetrics.sectionHeadings, landingSectionHeadings, `LANDING_CONTENT_CHANGED:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.loopSteps, 7, `LANDING_LOOP_COUNT_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.productionModes, 3, `LANDING_PRODUCTION_COUNT_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.moduleCount, 7, `LANDING_MODULE_COUNT_MISMATCH:${theme}:${viewport.name}`);
        assert.ok(landingMetrics.criticalMinimumFontSize >= 11, `LANDING_CRITICAL_TEXT_TOO_SMALL:${theme}:${viewport.name}:${landingMetrics.criticalMinimumFontSize}`);
        assert.equal(landingMetrics.motionLayerCount, 10, `LANDING_MOTION_LAYER_MISMATCH:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.pointerNetworkState, "animated", `LANDING_POINTER_NETWORK_NOT_ANIMATED:${theme}:${viewport.name}`);
        assert.ok((landingMetrics.staticGridBackground.match(/linear-gradient/gu) || []).length >= 2 && landingMetrics.staticGridBackground.includes("90deg"), `LANDING_STATIC_ORTHOGONAL_GRID_MISSING:${theme}:${viewport.name}`);
        assert.ok((landingMetrics.motionGridBackground.match(/linear-gradient/gu) || []).length >= 2 && landingMetrics.motionGridBackground.includes("90deg"), `LANDING_DYNAMIC_ORTHOGONAL_GRID_MISSING:${theme}:${viewport.name}`);
        assert.match(landingMetrics.dataStreamBackground, /repeating-linear-gradient\(90deg/iu, `LANDING_DATA_STREAM_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(landingMetrics.diagonalAnimationName, "none", `LANDING_DIAGONAL_SWEEP_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(landingMetrics.diagonalTransform, "none", `LANDING_DIAGONAL_SWEEP_TRANSFORM_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(landingMetrics.auraAnimationName, "none", `LANDING_AMBIENT_MOTION_MISSING:${theme}:${viewport.name}`);
        assert.ok(landingMetrics.maxFxAnimationNames.every((name) => name !== "none"), `LANDING_MAX_TECH_MOTION_MISSING:${theme}:${viewport.name}:${landingMetrics.maxFxAnimationNames.join(",")}`);
        assert.equal(landingMetrics.factoryPresent, true, `LANDING_FACTORY_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(landingMetrics.factoryAnimationName, "none", `LANDING_FACTORY_MOTION_MISSING:${theme}:${viewport.name}`);
        assert.notEqual(landingMetrics.factoryTransform, "none", `LANDING_FACTORY_DEPTH_MISSING:${theme}:${viewport.name}`);
        assert.ok(landingMetrics.pointerColor, `LANDING_POINTER_COLOR_MISSING:${theme}:${viewport.name}`);
        if (theme === "stellar-blue") {
          assert.deepEqual(landingMetrics.paletteTokens, ["#06182d", "#58e0dc", "#43a8bd", "#d2a85f"], `STELLAR_RUNTIME_PALETTE_MISMATCH:${viewport.name}`);
        }
        assert.equal(pointerStart.active, "active", `LANDING_POINTER_TRACKING_INACTIVE:${theme}:${viewport.name}`);
        assert.equal(pointerStart.networkPointer, "active", `LANDING_POINTER_NETWORK_TRACKING_INACTIVE:${theme}:${viewport.name}`);
        assert.notEqual(pointerStart.x, pointerEnd.x, `LANDING_POINTER_X_STATIC:${theme}:${viewport.name}`);
        assert.notEqual(pointerStart.y, pointerEnd.y, `LANDING_POINTER_Y_STATIC:${theme}:${viewport.name}`);
        assert.notEqual(pointerStart.factoryTransform, pointerEnd.factoryTransform, `LANDING_FACTORY_POINTER_RESPONSE_MISSING:${theme}:${viewport.name}`);
        assert.match(landingMetrics.accentBackground, /gradient/iu, `LANDING_TITLE_MATERIAL_MISSING:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.overflowX, 0, `LANDING_HORIZONTAL_OVERFLOW:${theme}:${viewport.name}`);
        assert.equal(landingMetrics.homeOverflowX, 0, `LANDING_ROOT_HORIZONTAL_OVERFLOW:${theme}:${viewport.name}:${landingMetrics.homeOverflowX}`);
        assert.deepEqual(landingMetrics.clippedElements, [], `LANDING_HORIZONTAL_CLIPPING:${theme}:${viewport.name}:${JSON.stringify(landingMetrics.clippedElements)}`);
        await page.screenshot({ path: path.join(outputDir, `${theme}-landing-${viewport.name}.png`), fullPage: false });
        landingMetrics.sectionDiagnostics = {};
        for (const sectionId of ["swh-top", "swh-modules", "swh-value", "swh-production", "swh-capabilities", "swh-business", "swh-footer"]) {
          await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "instant" }), sectionId);
          await page.waitForFunction((id) => {
            const section = document.getElementById(id);
            return section?.classList.contains("is-visible")
              && Number.parseFloat(getComputedStyle(section).opacity) >= 0.98;
          }, sectionId, { timeout: 10_000 });
          await page.waitForTimeout(180);
          const diagnostics = await page.evaluate((id) => {
            const section = document.getElementById(id);
            if (!section) return null;
            const parse = (value) => {
              const match = String(value || "").match(/rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:\s*[,\/]\s*(\d+(?:\.\d+)?))?\)/iu);
              return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])] : null;
            };
            const composite = (front, back) => {
              const alpha = front[3] + back[3] * (1 - front[3]);
              if (alpha <= 0) return [255, 255, 255, 1];
              return [
                (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
                (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
                (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
                alpha,
              ];
            };
            const backgroundFor = (node) => {
              const layers = [];
              let current = node;
              while (current) {
                const parsed = parse(getComputedStyle(current).backgroundColor);
                if (parsed && parsed[3] > 0) layers.push(parsed);
                if (parsed?.[3] === 1 || current === document.documentElement) break;
                current = current.parentElement;
              }
              return layers.reverse().reduce((back, front) => composite(front, back), [255, 255, 255, 1]);
            };
            const channel = (value) => {
              const normalized = value / 255;
              return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
            };
            const luminance = (color) => .2126 * channel(color[0]) + .7152 * channel(color[1]) + .0722 * channel(color[2]);
            const contrast = (front, back) => {
              const light = Math.max(luminance(front), luminance(back));
              const dark = Math.min(luminance(front), luminance(back));
              return (light + .05) / (dark + .05);
            };
            const textNodes = Array.from(section.querySelectorAll("h1, h2, h3, p, dt, dd, li, strong, small, .swh-module-rail-label, .swh-module-rail-items > span, .swh-section-heading > span, .swh-heading-row > span, .swh-capability-title > span, .swh-route-index, .swh-proof-bar span, .swh-production-flow span"))
              .filter((node) => !node.closest("[aria-hidden='true']") && (node.textContent || "").trim());
            const textChecks = textNodes.map((node) => {
              const style = getComputedStyle(node);
              const color = parse(style.color);
              const background = backgroundFor(node);
              const size = Number.parseFloat(style.fontSize) || 0;
              const weight = Number.parseInt(style.fontWeight, 10) || 400;
              const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
              const ratio = color ? contrast(composite(color, background), background) : 0;
              return { tag: node.tagName, text: (node.textContent || "").trim().slice(0, 54), color: style.color, background: `rgb(${background.slice(0, 3).map((part) => Math.round(part)).join(", ")})`, size, weight, ratio: Number(ratio.toFixed(2)), required };
            });
            const failures = textChecks.filter((item) => item.ratio + .01 < item.required);
            const sectionRect = section.getBoundingClientRect();
            const contentOverruns = Array.from(section.querySelectorAll("*"))
              .filter((node) => !node.closest("[aria-hidden='true']"))
              .map((node) => {
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return {
                  tag: node.tagName,
                  className: typeof node.className === "string" ? node.className : "",
                  left: rect.left,
                  right: rect.right,
                  visible: style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0,
                };
              })
              .filter((item) => item.visible && (item.left < sectionRect.left - 1 || item.right > sectionRect.right + 1));
            return {
              visible: section.classList.contains("is-visible") && Number.parseFloat(getComputedStyle(section).opacity) >= .98,
              rawOverflowX: Math.max(0, section.scrollWidth - section.clientWidth),
              visibleContentOverflowX: contentOverruns.length
                ? Math.ceil(Math.max(...contentOverruns.flatMap((item) => [sectionRect.left - item.left, item.right - sectionRect.right, 0])))
                : 0,
              contentOverruns,
              heading: section.querySelector("h1, h2")?.textContent?.trim() || "",
              headingColor: section.querySelector("h1, h2") ? getComputedStyle(section.querySelector("h1, h2")).color : "",
              backgroundColor: getComputedStyle(section).backgroundColor,
              minimumContrast: textChecks.length ? Math.min(...textChecks.map((item) => item.ratio)) : 0,
              failures,
            };
          }, sectionId);
          assert.ok(diagnostics, `LANDING_SECTION_MISSING:${theme}:${viewport.name}:${sectionId}`);
          assert.equal(diagnostics.visible, true, `LANDING_SCROLL_REVEAL_FAILED:${theme}:${viewport.name}:${sectionId}`);
          assert.equal(diagnostics.visibleContentOverflowX, 0, `LANDING_SECTION_CONTENT_OVERFLOW:${theme}:${viewport.name}:${sectionId}:${JSON.stringify(diagnostics.contentOverruns)}`);
          assert.deepEqual(diagnostics.failures, [], `LANDING_TEXT_CONTRAST_FAILED:${theme}:${viewport.name}:${sectionId}:${JSON.stringify(diagnostics.failures)}`);
          landingMetrics.sectionDiagnostics[sectionId] = diagnostics;
          if (sectionId === "swh-production" || viewport.name === "1440x900") {
            await page.screenshot({ path: path.join(outputDir, `${theme}-landing-${sectionId}-${viewport.name}.png`), fullPage: false });
          }
        }
        landingMetrics.scrollRevealVisible = Object.values(landingMetrics.sectionDiagnostics).every((item) => item?.visible);
        report.themes[`${theme}:landing:${viewport.name}`] = landingMetrics;
        report.landingVisualSignatures[`${theme}:${viewport.name}`] = [
          landingMetrics.homeBackgroundImage,
          landingMetrics.headerBackground,
          landingMetrics.loopBackground,
          landingMetrics.loopBorderRadius,
          landingMetrics.accentBackground,
        ].join("|");

        if (viewport.name === "1440x900") {
          await page.evaluate(() => sessionStorage.setItem("entered_app", "1"));
          for (const adjacent of [
            { name: "cover", route: "/cover" },
            { name: "voice-studio", route: "/voice-studio/workspace" },
            { name: "script-tool", route: "/tools/text/general-script" },
          ]) {
            await page.goto(`${origin}${adjacent.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
            await page.waitForSelector("body", { state: "visible", timeout: 30_000 });
            if (injectSource) await page.addStyleTag({ content: sourceCss[theme] });
            await page.waitForFunction(({ selectedTheme, selectedMode }) => document.documentElement.dataset.theme === selectedTheme
              && document.documentElement.dataset.mode === selectedMode,
            { selectedTheme: theme, selectedMode: defaultModeForTheme(theme) });
            await page.waitForTimeout(700);
            const adjacentMetrics = await page.evaluate(() => {
              const routeMain = document.querySelector('[data-testid="app-route-content"]');
              const routeShell = routeMain?.parentElement || null;
              const routeShellStyle = routeShell ? getComputedStyle(routeShell) : null;
              const routeMainStyle = routeMain ? getComputedStyle(routeMain) : null;
              const coverShell = document.querySelector(".cover-rebuild-shell");
              const coverStage = document.querySelector(".cover-rebuild-stage");
              const voiceRoot = document.querySelector(".voice-studio-root");
              const coverStyle = coverShell ? getComputedStyle(coverShell) : null;
              const coverStageStyle = coverStage ? getComputedStyle(coverStage) : null;
              const voiceStyle = voiceRoot ? getComputedStyle(voiceRoot) : null;
              const scriptRoot = document.querySelector('[data-testid="general-script-official"]');
              const scriptSection = document.querySelector('section[aria-label="通用短剧创作基础设置"]');
              const scriptInput = document.querySelector('input[aria-label="通用短剧总集数"]');
              const scriptContent = scriptSection;
              const scriptTitle = scriptRoot?.querySelector("h1") || null;
              const scriptRootRect = scriptRoot?.getBoundingClientRect() || null;
              const scriptSectionRect = scriptSection?.getBoundingClientRect() || null;
              const scriptInputRect = scriptInput?.getBoundingClientRect() || null;
              const tokenProbe = document.createElement("span");
              tokenProbe.style.position = "fixed";
              tokenProbe.style.visibility = "hidden";
              tokenProbe.style.color = "var(--primary)";
              tokenProbe.style.backgroundColor = "var(--background)";
              tokenProbe.style.borderColor = "var(--card)";
              document.body.append(tokenProbe);
              const tokenProbeStyle = getComputedStyle(tokenProbe);
              const resolvedTokens = {
                primary: tokenProbeStyle.color,
                background: tokenProbeStyle.backgroundColor,
                card: tokenProbeStyle.borderColor,
              };
              tokenProbe.remove();
              return {
                theme: document.documentElement.dataset.theme,
                mode: document.documentElement.dataset.mode,
                textLength: (document.body.innerText || "").trim().length,
                primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim().toLowerCase(),
                routeAccent: routeShellStyle?.getPropertyValue("--route-accent").trim().toLowerCase() || "",
                routeBackground: routeShellStyle?.getPropertyValue("--route-bg").trim().toLowerCase() || "",
                routeMainBackgroundColor: routeMainStyle?.backgroundColor || "",
                routeMainBackgroundImage: routeMainStyle?.backgroundImage || "",
                coverBackground: coverStyle?.getPropertyValue("--cover-ui-bg").trim().toLowerCase() || "",
                coverAccent: coverStyle?.getPropertyValue("--cover-ui-accent").trim().toLowerCase() || "",
                coverStageSurface: coverStageStyle?.getPropertyValue("--cover-stage-surface").trim().toLowerCase() || "",
                voiceBackground: voiceStyle?.getPropertyValue("--vs-bg").trim().toLowerCase() || "",
                voicePrimary: voiceStyle?.getPropertyValue("--vs-primary").trim().toLowerCase() || "",
                voiceSecondary: voiceStyle?.getPropertyValue("--vs-secondary").trim().toLowerCase() || "",
                script: scriptRoot && scriptSection && scriptInput && scriptContent && scriptTitle && scriptRootRect && scriptSectionRect && scriptInputRect ? {
                  pageBackground: getComputedStyle(scriptRoot).backgroundColor,
                  contentBackground: getComputedStyle(scriptContent).backgroundColor,
                  titleColor: getComputedStyle(scriptTitle).color,
                  resolvedTokens,
                  inputWidth: scriptInputRect.width,
                  inputRight: scriptInputRect.right,
                  sectionRight: scriptSectionRect.right,
                  rootRight: scriptRootRect.right,
                  viewportRight: document.documentElement.clientWidth,
                } : null,
                overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
              };
            });
            assert.equal(adjacentMetrics.theme, theme, `ADJACENT_THEME_MISMATCH:${adjacent.name}:${theme}`);
            assert.ok(adjacentMetrics.textLength > 100, `ADJACENT_CONTENT_MISSING:${adjacent.name}:${theme}`);
            assert.equal(adjacentMetrics.overflowX, 0, `ADJACENT_HORIZONTAL_OVERFLOW:${adjacent.name}:${theme}`);
            if (adjacent.name === "cover" && theme === "crystal-aurora") {
              assert.equal(adjacentMetrics.coverBackground, "#050d11", "CRYSTAL_COVER_BACKGROUND_MISMATCH");
              assert.equal(adjacentMetrics.coverAccent, "#54e3d2", "CRYSTAL_COVER_ACCENT_MISMATCH");
              assert.equal(adjacentMetrics.coverStageSurface, "#071419", "CRYSTAL_COVER_STAGE_MISMATCH");
            }
            if (adjacent.name === "cover" && theme === "stellar-blue") {
              assert.equal(adjacentMetrics.coverBackground, "#06182d", "STELLAR_COVER_BACKGROUND_MISMATCH");
              assert.equal(adjacentMetrics.coverAccent, "#58e0dc", "STELLAR_COVER_ACCENT_MISMATCH");
              assert.equal(adjacentMetrics.coverStageSurface, "#071f36", "STELLAR_COVER_STAGE_MISMATCH");
            }
            if (adjacent.name === "voice-studio" && theme === "crystal-aurora") {
              assert.equal(adjacentMetrics.voiceBackground, "#050d11", "CRYSTAL_VOICE_BACKGROUND_MISMATCH");
              assert.equal(adjacentMetrics.voicePrimary, "#54e3d2", "CRYSTAL_VOICE_PRIMARY_MISMATCH");
              assert.equal(adjacentMetrics.voiceSecondary, "#5fa8bc", "CRYSTAL_VOICE_SECONDARY_MISMATCH");
            }
            if (adjacent.name === "voice-studio" && theme === "stellar-blue") {
              assert.equal(adjacentMetrics.voiceBackground, "#06182d", "STELLAR_VOICE_BACKGROUND_MISMATCH");
              assert.equal(adjacentMetrics.voicePrimary, "#58e0dc", "STELLAR_VOICE_PRIMARY_MISMATCH");
              assert.equal(adjacentMetrics.voiceSecondary, "#43a8bd", "STELLAR_VOICE_SECONDARY_MISMATCH");
            }
            if (adjacent.name === "script-tool") {
              assert.ok(adjacentMetrics.script, `SCRIPT_TOOL_METRICS_MISSING:${theme}`);
              assert.equal(adjacentMetrics.script.pageBackground, adjacentMetrics.script.resolvedTokens.background, `SCRIPT_PAGE_THEME_BACKGROUND_MISMATCH:${theme}`);
              assert.equal(adjacentMetrics.script.contentBackground, adjacentMetrics.script.resolvedTokens.card, `SCRIPT_CONTENT_THEME_CARD_MISMATCH:${theme}`);
              assert.equal(adjacentMetrics.script.titleColor, adjacentMetrics.script.resolvedTokens.primary, `SCRIPT_TITLE_THEME_PRIMARY_MISMATCH:${theme}`);
              assert.ok(adjacentMetrics.script.inputWidth >= 40, `SCRIPT_TOTAL_EPISODES_INPUT_COLLAPSED:${theme}:${adjacentMetrics.script.inputWidth}`);
              assert.ok(adjacentMetrics.script.inputRight <= adjacentMetrics.script.sectionRight + 1, `SCRIPT_TOTAL_EPISODES_SECTION_OVERFLOW:${theme}:${JSON.stringify(adjacentMetrics.script)}`);
              assert.ok(adjacentMetrics.script.inputRight <= adjacentMetrics.script.rootRight + 1, `SCRIPT_TOTAL_EPISODES_ROOT_OVERFLOW:${theme}:${JSON.stringify(adjacentMetrics.script)}`);
              assert.ok(adjacentMetrics.script.inputRight <= adjacentMetrics.script.viewportRight + 1, `SCRIPT_TOTAL_EPISODES_VIEWPORT_OVERFLOW:${theme}:${JSON.stringify(adjacentMetrics.script)}`);
              const expectedRouteTokens = {
                lattice: { accent: "#d8b96f", background: "#0b0e12" },
                "soft-white": { accent: "#0b7a6b", background: "#f3f4ef" },
                "crystal-aurora": { accent: "#54e3d2", background: "#050d11" },
                "stellar-blue": { accent: "#58e0dc", background: "#06182d" },
              };
              const expectedRouteTheme = expectedRouteTokens[theme];
              assert.ok(expectedRouteTheme, `ROUTE_THEME_EXPECTATION_MISSING:${theme}`);
              assert.equal(adjacentMetrics.routeAccent, expectedRouteTheme.accent, `ROUTE_ACCENT_MISMATCH:${theme}`);
              assert.equal(adjacentMetrics.routeBackground, expectedRouteTheme.background, `ROUTE_BACKGROUND_MISMATCH:${theme}`);
              if (theme === "soft-white") {
                assert.notEqual(adjacentMetrics.routeMainBackgroundImage, "none", "SOFT_WHITE_ROUTE_GRADIENT_MISSING");
              }
            }
            await page.screenshot({ path: path.join(outputDir, `${theme}-${adjacent.name}-${viewport.name}.png`), fullPage: false });
            report.themes[`${theme}:${adjacent.name}:${viewport.name}`] = adjacentMetrics;
          }
        }
        await context.close();
      }
    }

    for (const viewport of viewports) {
      const signatures = themes.map((theme) => report.landingVisualSignatures[`${theme}:${viewport.name}`]);
      assert.equal(new Set(signatures).size, themes.length, `LANDING_THEME_SIGNATURES_NOT_DISTINCT:${viewport.name}`);
    }
    for (const theme of redesignedThemes) {
      for (const preference of ["light", "dark"]) {
        assert.ok(
          report.switching.modeChecks.some((item) => item.theme === theme && item.preference === preference && item.resolvedMode === preference),
          `MODE_MATRIX_MISSING:${theme}:${preference}`,
        );
      }
      for (const [colorScheme, resolvedMode] of [["light", "light"], ["dark", "dark"]]) {
        assert.ok(
          report.switching.modeChecks.some((item) => item.theme === theme
            && item.preference === "system"
            && item.colorScheme === colorScheme
            && item.resolvedMode === resolvedMode),
          `MODE_MATRIX_MISSING:${theme}:system:${colorScheme}`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(report.pageErrors, [], "THEME_PAGE_ERRORS");
  assert.deepEqual(report.consoleErrors, [], "THEME_CONSOLE_ERRORS");
  assert.deepEqual(report.serverErrors, [], "THEME_SERVER_ERRORS");
  assert.deepEqual(report.paidRequests, [], "THEME_PAID_REQUESTS");
  assert.deepEqual(report.unexpectedWrites, [], "THEME_UNEXPECTED_WRITES");
  report.ok = true;
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    const outputDir = path.resolve(process.env.MAIN_THEME_OUTPUT_DIR || ".codex-evidence/main-theme-suite-20260928/live");
    const failure = {
      ok: false,
      failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, "failure-report.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    } catch {}
    console.error(failure.stack || failure.message);
    process.exitCode = 1;
  });
}
