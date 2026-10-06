#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const sourceOnly = process.argv.includes("--source-only");
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const expectedNavigation = ["应用广场", "效率工具", "分镜编排", "图像生成", "视频创作", "声音制作", "封面设计", "漫剧创作", "带货创作"];
const viewports = [
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
];
const themes = [
  { id: "lattice", mode: "dark", name: "深空晶", primary: "#6ee7e0" },
  { id: "soft-white", mode: "light", name: "柔光白", primary: "#17675a" },
];

const read = (relativePath) => fs.readFile(path.resolve(relativePath), "utf8");
const [registry, navigation, marketplace, shellCss, darkCss, lightCss, landing, landingCss, runtimeColors, admin] = await Promise.all([
  read("src/lib/themes.ts"),
  read("src/lib/marketplace-navigation.ts"),
  read("src/components/agent-marketplace.tsx"),
  read("src/app/ui-shell-fixes.css"),
  read("src/app/theme-lattice.css"),
  read("src/app/theme-soft-white.css"),
  read("src/components/landing-page.tsx"),
  read("src/components/landing/soft-white-landing.css"),
  read("src/lib/theme-color-settings.ts"),
  read("src/app/admin/page.tsx"),
]);

const navigationBlock = navigation.match(/export const PRIMARY_NAVIGATION = \[([\s\S]*?)\] as const;/u)?.[1] || "";
const registeredLabels = [...navigationBlock.matchAll(/label: "([^"]+)"/gu)].map((match) => match[1]);
assert.deepEqual(registeredLabels, expectedNavigation, "PRIMARY_NAVIGATION_ORDER_OR_LABEL_MISMATCH");
assert.equal(registeredLabels.every((label) => /^\p{Script=Han}{4}$/u.test(label)), true, "PRIMARY_NAVIGATION_LABEL_NOT_FOUR_HAN_CHARACTERS");
assert.match(marketplace, /return \[\.\.\.PRIMARY_NAVIGATION_ORDER, \.\.\.Array\.from\(new Set\(supplementalKeys\)\)\]/u, "PRIMARY_NAVIGATION_NOT_PINNED_FIRST");
assert.match(marketplace, /\.\.\.customNavItems[\s\S]*?!isPrimaryNavigationKey\(key\)[\s\S]*?!hiddenNavKeys\.includes\(key\)/u, "CUSTOM_NAVIGATION_COMPATIBILITY_LOST");
assert.match(marketplace, /onClick=\{\(\) => setShowAddNav\(true\)\}[\s\S]*?aria-label="管理导航入口"/u, "CUSTOM_NAVIGATION_MANAGEMENT_ENTRY_MISSING");
assert.match(marketplace, /ResizeObserver\(updateIndicator\)/u, "NAVIGATION_INDICATOR_NOT_RESIZE_AWARE");
assert.match(marketplace, /const navigateRoute = useCallback[\s\S]*?setPendingNavKey\(key\)[\s\S]*?router\.push\(href\)/u, "ROUTE_NAVIGATION_TRANSITION_NOT_CONNECTED");
assert.match(marketplace, /aria-busy=\{Boolean\(pendingNavKey\)\}/u, "ROUTE_NAVIGATION_BUSY_STATE_MISSING");
assert.match(marketplace, /aria-label="一级功能导航"/u, "PRIMARY_NAVIGATION_ACCESSIBLE_NAME_MISSING");
assert.match(marketplace, /aria-label="向左浏览功能导航"[\s\S]*?aria-label="向右浏览功能导航"/u, "NAVIGATION_OVERFLOW_CONTROLS_MISSING");
assert.match(marketplace, /scrollPrimaryNavigation[\s\S]*?container\.scrollBy/u, "NAVIGATION_OVERFLOW_CONTROLS_NOT_CONNECTED");
assert.match(shellCss, /font-size: var\(--market-nav-font-size, 15px\)/u, "NAVIGATION_FONT_NOT_STANDARDIZED");
assert.match(shellCss, /width 220ms/u, "NAVIGATION_MOTION_NOT_IN_180_240MS_RANGE");
assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nav-pill-indicator[\s\S]*?transition: none !important/u, "NAVIGATION_REDUCED_MOTION_OVERRIDE_MISSING");
assert.doesNotMatch(shellCss, /mask-image: linear-gradient/u, "NAVIGATION_STILL_USES_EDGE_MASK");
assert.match(shellCss, /mask-image: none !important/u, "NAVIGATION_MASK_RESET_MISSING");
assert.match(shellCss, /\.nav-scroll-control[\s\S]*?width:\s*28px/u, "NAVIGATION_OVERFLOW_CONTROLS_NOT_STYLED");
assert.match(registry, /id: "lattice", label: "深空晶"/u);
assert.match(registry, /id: "soft-white", label: "柔光白"/u);
assert.match(darkCss, /--primary: #68c7b4;/u);
assert.match(lightCss, /--primary: #17675a;/u);
assert.match(runtimeColors, /return \{\} as Record<string, string>;/u, "LEGACY_API_COLORS_CAN_OVERRIDE_STANDARD_THEME");
assert.match(admin, /历史品牌色配置/u);
assert.match(admin, /不会覆盖标准主题/u);
assert.match(landing, /themeId === "soft-white" \|\| themeId === "lattice"/u, "THEMES_DO_NOT_SHARE_BUSINESS_HOMEPAGE");
assert.match(landingCss, /height: 100dvh;[\s\S]*?overflow-y: auto;/u, "HOMEPAGE_SCROLL_ROOT_MISSING");
const protectedFocusExclusion = ':not(:where(.commerce-root *, [data-testid="manju-content"] *))';
const protectedWorkbenchExclusions = [
  protectedFocusExclusion,
  ':not(:where([data-testid="manju-content"] *))',
];
for (const css of [darkCss, lightCss]) {
  assert.ok(css.includes(protectedFocusExclusion), "PROTECTED_WORKBENCH_FOCUS_NOT_EXCLUDED");
  const cssWithoutProtectedWorkbenchExclusions = protectedWorkbenchExclusions.reduce(
    (source, exclusion) => source.replaceAll(exclusion, ""),
    css,
  );
  assert.doesNotMatch(
    cssWithoutProtectedWorkbenchExclusions,
    /(?:commerce-root|manju|youcai)/iu,
    "STANDARD_THEME_REACHES_PROTECTED_WORKBENCH_INTERNALS",
  );
}
assert.match(shellCss, /\.commerce-root select[\s\S]*?color-scheme: light !important/u, "COMMERCE_NATIVE_CONTROLS_NOT_PROTECTED");
assert.doesNotMatch(shellCss, /:is\(\.commerce-root, \[data-testid="manju-content"\]\)[\s\S]*?box-shadow:\s*none !important/u, "PROTECTED_WORKBENCH_FOCUS_WAS_ERASED");

const sourceReport = {
  passed: true,
  sourceOnly,
  expectedNavigation,
  themes: themes.map(({ id, mode, name, primary }) => ({ id, mode, name, primary })),
  desktopViewports: viewports,
};

if (sourceOnly) {
  console.log(JSON.stringify(sourceReport, null, 2));
  process.exit(0);
}

assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
assert.equal(identityResponse.ok, true, `LOCAL_ADMIN_SESSION_INVALID:${identityResponse.status}`);
const identity = await identityResponse.json();
const outputDir = path.resolve(".codex-evidence/unified-desktop-theme-20260926");
await fs.mkdir(outputDir, { recursive: true });
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const report = {
  ...sourceReport,
  checkedAt: new Date().toISOString(),
  homes: [],
  navigation: [],
  routeTransitions: [],
  adjacentPages: [],
  protectedPages: [],
  blockedWrites: [],
  blockedBackgroundWrites: [],
  paidRequests: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
};

const watch = (page, id) => {
  page.on("pageerror", (error) => report.pageErrors.push({ id, message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) report.consoleErrors.push({ id, message: message.text() });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/(?:generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) report.paidRequests.push({ id, method: request.method(), pathname: url.pathname });
  });
  page.on("response", (response) => {
    if (response.status() >= 500) report.serverErrors.push({ id, status: response.status(), pathname: new URL(response.url()).pathname });
  });
};

const nonBusinessWritePaths = new Set(["/api/announcements/events", "/api/diagnostic-logs"]);

const createContext = async (theme, viewport, entered) => {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.addInitScript(({ selectedTheme, shouldEnter, authToken, authUser }) => {
    localStorage.setItem("user_theme_preference", selectedTheme);
    if (shouldEnter) {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authUser));
      localStorage.setItem("active_view", "marketplace");
      sessionStorage.setItem("entered_app", "1");
    } else {
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      sessionStorage.removeItem("entered_app");
    }
  }, { selectedTheme: theme, shouldEnter: entered, authToken: token, authUser: identity.user });
  if (entered) await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (entered && url.pathname === "/api/auth/me" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { ...identity.user, themePreference: theme, theme_preference: theme } }) });
      return;
    }
    if (entered && url.pathname === "/api/video/active-tasks" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
      return;
    }
    if (entered && url.pathname.startsWith("/api/commerce/") && request.method() === "GET") {
      const emptyCommerceState = {
        user: { id: identity.user.id },
        workspaceStorage: { legacyOwner: false },
        jobs: [], conversations: [], assets: [], models: [], directors: [], groups: [],
        canvases: [], workflows: [], voices: [], prompts: [], items: [], sessions: [],
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyCommerceState) });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      const target = nonBusinessWritePaths.has(url.pathname) ? report.blockedBackgroundWrites : report.blockedWrites;
      target.push({ theme, method: request.method(), pathname: url.pathname });
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.continue();
  });
  return context;
};

try {
  for (const theme of themes) {
    for (const viewport of viewports) {
      const homeId = `${theme.id}-${viewport.name}-home`;
      const homeContext = await createContext(theme.id, viewport, false);
      const homePage = await homeContext.newPage();
      watch(homePage, homeId);
      const homeResponse = await homePage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(homeResponse?.status(), 200);
      const home = homePage.getByTestId("soft-white-premium-home");
      await home.waitFor({ state: "visible", timeout: 30_000 });
      await homePage.getByRole("heading", { name: /把内容生产/u }).waitFor({ state: "visible" });
      const homeState = await home.evaluate((element) => {
        const rootStyle = getComputedStyle(document.documentElement);
        const before = element.scrollTop;
        const previousScrollBehavior = element.style.scrollBehavior;
        element.style.scrollBehavior = "auto";
        element.scrollTop = Math.min(260, element.scrollHeight - element.clientHeight);
        const after = element.scrollTop;
        element.style.scrollBehavior = previousScrollBehavior;
        return {
          theme: document.documentElement.dataset.theme,
          mode: document.documentElement.dataset.mode,
          primary: rootStyle.getPropertyValue("--primary").trim().toLowerCase(),
          inlinePrimary: document.documentElement.style.getPropertyValue("--primary"),
          before,
          after,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.deepEqual({ theme: homeState.theme, mode: homeState.mode }, { theme: theme.id, mode: theme.mode });
      assert.equal(homeState.primary, theme.primary);
      assert.equal(homeState.inlinePrimary, "");
      assert.ok(homeState.scrollHeight > homeState.clientHeight && homeState.after > homeState.before, `${homeId}:HOME_NOT_SCROLLABLE`);
      assert.ok(homeState.overflow <= 1, `${homeId}:HORIZONTAL_OVERFLOW:${homeState.overflow}`);
      report.homes.push({ id: homeId, ...viewport, ...homeState });
      const homeInitialBounds = await home.evaluate((element) => {
        const previousScrollBehavior = element.style.scrollBehavior;
        element.style.scrollBehavior = "auto";
        element.scrollTop = 0;
        const header = element.querySelector(".swh-header")?.getBoundingClientRect();
        const heading = element.querySelector(".swh-hero h1")?.getBoundingClientRect();
        const result = {
          scrollTop: element.scrollTop,
          headerBottom: header?.bottom || 0,
          headingTop: heading?.top || 0,
        };
        element.style.scrollBehavior = previousScrollBehavior;
        return result;
      });
      assert.equal(homeInitialBounds.scrollTop, 0, `${homeId}:HOME_DID_NOT_RETURN_TO_INITIAL_POSITION`);
      assert.ok(homeInitialBounds.headingTop >= homeInitialBounds.headerBottom - 1,
        `${homeId}:HOME_HEADING_OBSCURED_BY_HEADER:${JSON.stringify(homeInitialBounds)}`);
      await homePage.screenshot({ path: path.join(outputDir, `${homeId}.png`), fullPage: false });
      await homeContext.close();

      const navId = `${theme.id}-${viewport.name}-navigation`;
      const navContext = await createContext(theme.id, viewport, true);
      const navPage = await navContext.newPage();
      watch(navPage, navId);
      const navResponse = await navPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(navResponse?.status(), 200);
      const nav = navPage.locator(".nav-bar-container");
      await nav.waitFor({ state: "visible", timeout: 30_000 });
      await navPage.waitForTimeout(700);
      const navState = await nav.evaluate((element) => {
        const buttons = [...element.querySelectorAll(".nav-pill")].slice(0, 9);
        const containerRect = element.getBoundingClientRect();
        const firstRect = buttons[0]?.getBoundingClientRect();
        const lastRect = buttons.at(-1)?.getBoundingClientRect();
        const indicator = element.querySelector(".nav-pill-indicator");
        const indicatorStyle = indicator ? getComputedStyle(indicator) : null;
        const style = getComputedStyle(element);
        const rail = element.closest(".primary-nav-rail");
        const leftControl = rail?.querySelector(".nav-scroll-control-left");
        const rightControl = rail?.querySelector(".nav-scroll-control-right");
        return {
          labels: buttons.map((button) => (button.textContent || "").replace(/\s+/gu, "").trim()),
          fontSizes: buttons.map((button) => Number.parseFloat(getComputedStyle(button).fontSize)),
          labelOverflow: buttons.map((button) => button.scrollWidth - button.clientWidth),
          scrollOverflow: element.scrollWidth - element.clientWidth,
          firstBoundsVisible: Boolean(firstRect)
            && firstRect.left >= containerRect.left - 1
            && firstRect.right <= containerRect.right + 1,
          lastBoundsVisible: Boolean(lastRect)
            && lastRect.left >= containerRect.left - 1
            && lastRect.right <= containerRect.right + 1,
          primaryBoundsVisible: Boolean(firstRect && lastRect)
            && firstRect.left >= containerRect.left - 1
            && lastRect.right <= containerRect.right + 1,
          maskImage: style.maskImage,
          webkitMaskImage: style.webkitMaskImage,
          indicatorWidth: indicator?.getBoundingClientRect().width || 0,
          indicatorColor: indicatorStyle?.backgroundColor || "",
          indicatorDurations: (indicatorStyle?.transitionDuration || "").split(",").map((value) => Number.parseFloat(value)),
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          railOverflowState: rail?.getAttribute("data-nav-overflow") || null,
          leftControlWidth: leftControl?.getBoundingClientRect().width || 0,
          rightControlWidth: rightControl?.getBoundingClientRect().width || 0,
          rightControlDisabled: Boolean(rightControl?.disabled),
        };
      });
      assert.deepEqual(navState.labels, expectedNavigation, `${navId}:PRIMARY_LABELS_OR_ORDER_MISMATCH`);
      assert.ok(navState.fontSizes.every((size) => size >= 14.5 && size <= 16.5), `${navId}:NAV_FONT_SIZE_MISMATCH`);
      assert.ok(navState.labelOverflow.every((value) => value <= 1), `${navId}:NAV_LABEL_CLIPPED`);
      assert.equal(navState.maskImage, "none", `${navId}:MASK_IMAGE_ACTIVE`);
      assert.equal(navState.webkitMaskImage, "none", `${navId}:WEBKIT_MASK_IMAGE_ACTIVE`);
      assert.ok(navState.indicatorWidth > 0, `${navId}:INDICATOR_HIDDEN`);
      assert.ok(navState.indicatorDurations.every((seconds) => seconds >= 0.18 && seconds <= 0.24), `${navId}:INDICATOR_DURATION_OUT_OF_RANGE`);
      assert.ok(navState.pageOverflow <= 1, `${navId}:PAGE_OVERFLOW:${navState.pageOverflow}`);
      assert.equal(navState.firstBoundsVisible, true, `${navId}:FIRST_PRIMARY_NAV_ITEM_NOT_VISIBLE_AT_INITIAL_POSITION`);
      await navPage.screenshot({ path: path.join(outputDir, `${navId}.png`), fullPage: false });
      if (navState.scrollOverflow > 2) {
        assert.equal(navState.railOverflowState, "true", `${navId}:OVERFLOW_STATE_NOT_EXPOSED`);
        assert.ok(navState.leftControlWidth >= 27 && navState.rightControlWidth >= 27, `${navId}:OVERFLOW_CONTROLS_NOT_VISIBLE`);
        assert.equal(navState.rightControlDisabled, false, `${navId}:RIGHT_OVERFLOW_CONTROL_DISABLED_AT_START`);
        await navPage.getByRole("button", { name: "向右浏览功能导航" }).click();
        await navPage.waitForTimeout(260);
        const scrolled = await nav.evaluate((element) => element.scrollLeft);
        assert.ok(scrolled > 20, `${navId}:RIGHT_OVERFLOW_CONTROL_DID_NOT_SCROLL`);
      }
      let primaryReachable = navState.primaryBoundsVisible;
      if (!primaryReachable) {
        await nav.locator(".nav-pill").nth(8).focus();
        primaryReachable = await nav.evaluate((element) => {
          const last = element.querySelectorAll(".nav-pill")[8]?.getBoundingClientRect();
          const container = element.getBoundingClientRect();
          return Boolean(last) && last.left >= container.left - 1 && last.right <= container.right + 1;
        });
      }
      assert.equal(primaryReachable, true, `${navId}:PRIMARY_NAV_LAST_ITEM_NOT_KEYBOARD_REACHABLE`);
      navState.primaryReachable = primaryReachable;
      report.navigation.push({ id: navId, ...viewport, ...navState });

      if (theme.id === "lattice" && viewport.width === 1440) {
        await navPage.evaluate(() => { window.__navigationClientMarker = "route-transition-preserved"; });
        await navPage.getByLabel("一级功能导航").getByRole("button", { name: "打开效率工具" }).click({ noWaitAfter: true });
        await navPage.waitForFunction(() => {
          const container = document.querySelector(".nav-bar-container");
          const target = document.querySelector('.nav-pill[data-nav-pending="true"]');
          return container?.getAttribute("aria-busy") === "true"
            && container?.getAttribute("data-nav-pending") === "toolbox"
            && target?.getAttribute("aria-current") === "page";
        }, null, { timeout: 2_000 });
        const pendingState = await navPage.evaluate(() => ({
          containerPending: document.querySelector(".nav-bar-container")?.getAttribute("data-nav-pending"),
          targetPending: document.querySelector('.nav-pill[data-nav-pending="true"]')?.getAttribute("data-nav-pending"),
        }));
        await navPage.waitForURL((url) => url.pathname === "/tools", { timeout: 30_000 });
        const clientMarker = await navPage.evaluate(() => window.__navigationClientMarker);
        assert.deepEqual(pendingState, { containerPending: "toolbox", targetPending: "true" }, `${navId}:PENDING_NAVIGATION_STATE_MISSING`);
        assert.equal(clientMarker, "route-transition-preserved", `${navId}:NAVIGATION_WAS_NOT_CLIENT_SIDE`);
        report.routeTransitions.push({ id: navId, destination: "/tools", pendingState, clientMarker });
      }
      await navContext.close();
    }
  }

  for (const theme of themes) {
    const regressionContext = await createContext(theme.id, { width: 1440, height: 900 }, true);
    const regressionPage = await regressionContext.newPage();
    watch(regressionPage, `adjacent-${theme.id}`);
    for (const pathname of ["/video", "/storyboard-workbench", "/tools"]) {
      const response = await regressionPage.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await regressionPage.waitForFunction(() => (document.body?.innerText?.trim().length || 0) > 30, null, { timeout: 30_000 });
      const state = await regressionPage.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.deepEqual({ theme: state.theme, mode: state.mode }, { theme: theme.id, mode: theme.mode }, `${pathname}:THEME_NOT_APPLIED`);
      assert.ok(state.overflow <= 1, `${pathname}:HORIZONTAL_OVERFLOW:${state.overflow}`);
      report.adjacentPages.push({ theme: theme.id, pathname, ...state });
    }
    await regressionContext.close();
  }

  for (const theme of themes) {
    const regressionContext = await createContext(theme.id, { width: 1440, height: 900 }, true);
    const regressionPage = await regressionContext.newPage();
    watch(regressionPage, `protected-workbenches-${theme.id}`);
    for (const { pathname, selector } of [
      { pathname: "/youcai", selector: '[data-testid="manju-content"]' },
      { pathname: "/commerce", selector: ".commerce-root" },
    ]) {
      const response = await regressionPage.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(response?.status(), 200);
      const root = regressionPage.locator(selector);
      await root.waitFor({ state: "visible", timeout: 30_000 });
      const state = await root.evaluate((element) => {
      const style = getComputedStyle(element);
      const select = element.querySelector("select");
      const focusable = element.querySelector("button, a[href], input, textarea, select");
      if (focusable instanceof HTMLElement) focusable.focus();
      const protectedFocusBoxShadow = focusable ? getComputedStyle(focusable).boxShadow : null;
      const probe = document.createElement("button");
      probe.textContent = "focus-probe";
      probe.style.position = "fixed";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);
      probe.focus();
      const globalFocusBoxShadow = getComputedStyle(probe).boxShadow;
      probe.remove();
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        selectColorScheme: select ? getComputedStyle(select).colorScheme : null,
        protectedFocusBoxShadow,
        globalFocusBoxShadow,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
      });
      assert.notEqual(state.backgroundColor, "rgba(0, 0, 0, 0)", `${theme.id}:${pathname}:PROTECTED_ROOT_BECAME_TRANSPARENT`);
      if (pathname === "/commerce" && state.selectColorScheme !== null) {
        assert.equal(state.selectColorScheme, "light", `${theme.id}:${pathname}:PROTECTED_SELECT_THEME_OVERRIDDEN`);
      }
      if (state.protectedFocusBoxShadow !== null) assert.notEqual(state.protectedFocusBoxShadow, state.globalFocusBoxShadow, `${theme.id}:${pathname}:PROTECTED_FOCUS_SHADOW_OVERRIDDEN`);
      assert.ok(state.overflow <= 1, `${theme.id}:${pathname}:HORIZONTAL_OVERFLOW:${state.overflow}`);
      report.protectedPages.push({ theme: theme.id, pathname, selector, ...state });
    }
    await regressionContext.close();
  }
} finally {
  await browser.close();
}

assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
assert.deepEqual(report.paidRequests, [], `PAID_REQUESTS:${JSON.stringify(report.paidRequests)}`);
assert.deepEqual(report.blockedWrites, [], `UNEXPECTED_WRITE_ATTEMPTS:${JSON.stringify(report.blockedWrites)}`);
report.attemptedBlockedWrites = report.blockedWrites.length;
report.productionWrites = 0;
report.paidGenerationRequests = 0;
await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: true, homes: report.homes.length, navigation: report.navigation.length, routeTransitions: report.routeTransitions.length, adjacentPages: report.adjacentPages.length, protectedPages: report.protectedPages.length }));
