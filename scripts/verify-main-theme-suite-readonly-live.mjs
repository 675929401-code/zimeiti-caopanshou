#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const themes = [
  { id: "lattice", label: "深空晶", mode: "dark" },
  { id: "soft-white", label: "柔光白", mode: "light" },
  { id: "crystal-aurora", label: "黑曜霓彩", mode: "dark" },
];
const viewport = { width: 1440, height: 900 };
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const outputRoot = path.resolve(process.env.MAIN_THEME_READONLY_OUTPUT_DIR || ".codex-evidence/main-theme-suite-readonly-20260929");
const requestedRunId = process.env.MAIN_THEME_READONLY_EVIDENCE_RUN_ID?.trim();
const runId = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomBytes(4).toString("hex")}`;
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "INVALID_EVIDENCE_RUN_ID");
const outputDir = path.join(outputRoot, runId);

function parseCssColor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const hex = normalized.match(/^#([0-9a-f]{3,8})$/iu)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((character) => `${character}${character}`).join("") : hex;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const functional = normalized.match(/^rgba?\((.+)\)$/iu)?.[1];
  if (functional) {
    const parts = functional.replace("/", " ").split(/[\s,]+/u).filter(Boolean);
    if (parts.length >= 3) {
      return {
        r: Number.parseFloat(parts[0]),
        g: Number.parseFloat(parts[1]),
        b: Number.parseFloat(parts[2]),
        a: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
      };
    }
  }
  throw new Error(`UNSUPPORTED_CSS_COLOR:${value}`);
}

function compositeColor(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: ((foreground.r * foreground.a) + (background.r * background.a * (1 - foreground.a))) / alpha,
    g: ((foreground.g * foreground.a) + (background.g * background.a * (1 - foreground.a))) / alpha,
    b: ((foreground.b * foreground.a) + (background.b * background.a * (1 - foreground.a))) / alpha,
    a: alpha,
  };
}

function relativeLuminance(color) {
  const linear = [color.r, color.g, color.b].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foregroundValue, backgroundValue, pageValue) {
  const page = parseCssColor(pageValue);
  const background = compositeColor(parseCssColor(backgroundValue), page);
  const foreground = compositeColor(parseCssColor(foregroundValue), background);
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
  const configuredToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const fixtureIdentity = !configuredToken;
  const token = configuredToken || "main-theme-readonly-browser-fixture-token";
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  await mkdir(outputRoot, { recursive: true });
  try { await mkdir(outputDir); } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${outputDir}`);
    throw error;
  }

  const [receipt, diskBuildId, currentFingerprint, versionResponse, identityResponse] = await Promise.all([
    readFile(path.resolve(".next/local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
    fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(30_000) }),
    fixtureIdentity
      ? Promise.resolve(new Response(JSON.stringify({
        user: {
          id: "main-theme-readonly-browser-fixture-user",
          username: "main_theme_fixture",
          displayName: "主题验收夹具",
          role: "admin",
          status: "active",
          is_active: true,
          credits: 0,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      : fetch(`${origin}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  assert.equal(identityResponse.ok, true, `AUTH_ME_HTTP_${identityResponse.status}`);
  const servedVersion = await versionResponse.json();
  const identity = await identityResponse.json();
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const servedBuildId = servedVersion?.buildId || servedVersion?.version || "";
  const sourceFingerprintCurrent = receipt?.fingerprint === currentFingerprint.fingerprint
    && receipt?.fileCount === currentFingerprint.fileCount;
  const runningLatest = sourceFingerprintCurrent
    && receipt?.buildId === diskBuildId
    && servedBuildId === diskBuildId;

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    runId,
    outputRoot,
    evidenceDirectory: outputDir,
    origin,
    viewport,
    runtimeIdentity: {
      diskBuildId,
      servedBuildId,
      servedSourceVersion: servedVersion?.sourceVersion || "",
      receiptFingerprint: receipt?.fingerprint || "",
      currentFingerprint: currentFingerprint.fingerprint,
      receiptFileCount: receipt?.fileCount ?? null,
      currentFileCount: currentFingerprint.fileCount,
      sourceFingerprintCurrent,
      runningLatest,
    },
    acceptance: {
      eligible: runningLatest,
      status: runningLatest ? "current-runtime" : "blocked-stale-runtime",
      identitySource: fixtureIdentity ? "browser-fixture" : "verified-local-token",
    },
    themeSwitcher: null,
    themes: {},
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
    requestFailures: [],
    benignAbortedRequests: [],
    blockedMutationAttempts: [],
    reachedServerMutations: [],
    paidRequests: [],
    diagnosticPassed: false,
  };

  const browser = await chromium.launch({ headless: true });

  const watchPage = (page, scope) => {
    page.on("pageerror", (error) => report.pageErrors.push({ scope, message: error.message.slice(0, 500) }));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push({ scope, message: message.text().slice(0, 500) });
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (response.status() >= 500) report.serverErrors.push({ scope, status: response.status(), pathname: url.pathname });
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      const failure = { scope, method: request.method(), pathname: url.pathname, error: request.failure()?.errorText || "" };
      if (failure.method === "GET" && failure.error === "net::ERR_ABORTED") {
        report.benignAbortedRequests.push(failure);
      } else {
        report.requestFailures.push(failure);
      }
    });
  };

  const createContext = async ({ theme, authenticated }) => {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const user = {
      ...identity.user,
      themePreference: theme.id,
      theme_preference: theme.id,
      themeModePreference: theme.mode,
      theme_mode_preference: theme.mode,
    };
    await context.addInitScript(({ selectedTheme, selectedMode, sessionToken, authUser, entered }) => {
      localStorage.setItem("user_theme_preference", selectedTheme);
      localStorage.setItem("user_theme_mode_preference", selectedMode);
      localStorage.setItem("platform_theme", selectedTheme);
      localStorage.setItem("platform_theme_mode", selectedMode);
      localStorage.setItem("app_theme", selectedTheme);
      localStorage.setItem("app_mode", selectedMode);
      if (entered) {
        localStorage.setItem("auth_token", sessionToken);
        localStorage.setItem("auth_user", JSON.stringify(authUser));
        sessionStorage.setItem("entered_app", "1");
      } else {
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        sessionStorage.removeItem("entered_app");
      }
    }, {
      selectedTheme: theme.id,
      selectedMode: theme.mode,
      sessionToken: token,
      authUser: user,
      entered: authenticated,
    });
    if (authenticated) {
      await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    }
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (method === "GET" && url.pathname === "/api/settings") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }),
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/settings/appearance") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }),
        });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/auth/me") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/bots") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ agents: [], navigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"] }),
        });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/member-permissions") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ permission: {
            userId: user.id,
            role: "admin",
            featureNavigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"],
            agentNavigationKeys: [],
            revision: 1,
            checksum: "main-theme-fixture",
            integrityValid: true,
            authorityStatus: "ready",
          } }),
        });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/agent-favorites") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ favorites: [] }) });
        return;
      }
      if (method === "GET" && url.pathname === "/api/settings/ui-preferences") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferences: {} }) });
        return;
      }
      if (method === "GET" && url.pathname === "/api/settings/layout") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ layout: null }) });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/conversations/history") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/extract/history") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], next: null, retryReady: true }) });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/tools/runtime-catalog") {
        const unavailable = (service) => ({ available: false, pricingReady: false, service, unitPrice: null, currency: "CNY", unit: "条" });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: {
            video: unavailable("视频提取"),
            text: unavailable("文案提取"),
            batch: unavailable("批量提取"),
            search: unavailable("搜索提取"),
            formatter: { available: true, service: "文字排版", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
            segmenter: { available: true, service: "智能分段", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
          } }),
        });
        return;
      }
      if (method === "GET" && authenticated && url.pathname === "/api/cash/balance") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 0 }) });
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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ announcements: [], unreadCount: 0, cursor: "empty" }),
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/video/active-tasks") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
        return;
      }
      if (mutatingMethods.has(method)) {
        const body = request.postDataJSON?.() || {};
        const selectedTheme = typeof body?.theme_preference === "string" ? body.theme_preference : user.themePreference;
        const selectedMode = typeof body?.theme_mode_preference === "string"
          ? body.theme_mode_preference
          : user.themeModePreference;
        report.blockedMutationAttempts.push({
          scope: `${theme.id}:${authenticated ? "authenticated" : "public"}`,
          method,
          pathname: url.pathname,
          interceptedBeforeServer: true,
        });
        if (method === "PUT" && url.pathname === "/api/auth/me") {
          user.themePreference = selectedTheme;
          user.theme_preference = selectedTheme;
          user.themeModePreference = selectedMode;
          user.theme_mode_preference = selectedMode;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ user }),
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
        return;
      }
      if (/\/(?:generate|quotes?|payment|billing)(?:\/|$)/u.test(url.pathname)) {
        report.paidRequests.push({ theme: theme.id, method, pathname: url.pathname });
      }
      await route.continue();
    });
    return context;
  };

  try {
    for (const theme of themes) {
      const themeReport = { landing: null, loginDrawer: null, marketplace: null, announcementDialog: null, adjacentPages: [] };
      report.themes[theme.id] = themeReport;

      const publicContext = await createContext({ theme, authenticated: false });
      const publicPage = await publicContext.newPage();
      watchPage(publicPage, `${theme.id}:public`);
      const publicResponse = await publicPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(publicResponse?.status(), 200, `${theme.id}:HOME_HTTP`);
      const home = publicPage.getByTestId("soft-white-premium-home");
      await home.waitFor({ state: "visible", timeout: 30_000 });
      // Public SSR must keep the server-published theme authoritative. For this
      // read-only visual matrix, switch only the browser DOM after hydration;
      // no platform setting or user preference is written to the server.
      await publicPage.evaluate(({ id, mode }) => {
        const root = document.documentElement;
        root.setAttribute("data-theme-selection", id);
        root.setAttribute("data-theme", id);
        root.setAttribute("data-mode-preference", mode);
        root.setAttribute("data-mode", mode);
        root.classList.toggle("dark", mode === "dark");
      }, theme);
      await publicPage.waitForFunction(({ id, mode }) => (
        document.documentElement.dataset.theme === id
        && document.documentElement.dataset.mode === mode
      ), theme, { timeout: 10_000 });
      await publicPage.waitForFunction(() => {
        const hero = document.querySelector(".swh-hero[data-swh-reveal]");
        const copy = hero?.querySelector("h1");
        if (!(hero instanceof HTMLElement) || !(copy instanceof HTMLElement)) return false;
        return hero.classList.contains("is-visible")
          && Number.parseFloat(getComputedStyle(hero).opacity) >= 0.99
          && Number.parseFloat(getComputedStyle(copy).opacity) >= 0.99;
      }, null, { timeout: 10_000 });
      await publicPage.waitForTimeout(400);
      const landing = await home.evaluate((node) => {
        const heading = node.querySelector("h1");
        const style = getComputedStyle(node);
        const readabilitySpec = [
          { id: "hero-title", selector: ".swh-title-line:not(.swh-title-accent)", backdrop: "page", minFontSize: 48 },
          { id: "hero-lead", selector: ".swh-lead", backdrop: "page", minFontSize: 17 },
          { id: "hero-status", selector: ".swh-hero-status span", backdrop: "page", minFontSize: 12 },
          { id: "loop-kicker", selector: ".swh-loop-kicker strong", backdrop: "loop-heading", minFontSize: 12 },
          { id: "loop-counter", selector: ".swh-loop-kicker small", backdrop: "loop-heading", minFontSize: 12 },
          { id: "loop-title", selector: ".swh-loop-heading > strong", backdrop: "loop-heading", minFontSize: 24 },
          { id: "loop-description", selector: ".swh-loop-heading > p", backdrop: "loop-heading", minFontSize: 12 },
          { id: "loop-step-phase", selector: ".swh-example-step-head small", backdrop: "loop-item", minFontSize: 12 },
          { id: "loop-step-title", selector: ".swh-project-example > li > strong", backdrop: "loop-item", minFontSize: 14 },
          { id: "loop-step-copy", selector: ".swh-project-example > li > p", backdrop: "loop-item", minFontSize: 12 },
          { id: "loop-outcome", selector: ".swh-example-outcome", backdrop: "loop-item", minFontSize: 12 },
          { id: "loop-console", selector: ".swh-console-stats strong", backdrop: "loop-item", minFontSize: 12 },
          { id: "section-kicker", selector: ".swh-section-heading > p", backdrop: "page", minFontSize: 12 },
          { id: "section-heading", selector: ".swh-section-heading h2", backdrop: "page", minFontSize: 36 },
          { id: "module-rail", selector: ".swh-module-rail-items span", backdrop: "surface", minFontSize: 12 },
          { id: "value-copy", selector: ".swh-value-grid p", backdrop: "surface", minFontSize: 14 },
          { id: "production-title", selector: ".swh-production-grid h3", backdrop: "surface", minFontSize: 26 },
          { id: "production-label", selector: ".swh-production-grid dt", backdrop: "surface", minFontSize: 12 },
          { id: "production-copy", selector: ".swh-production-grid dd", backdrop: "surface", minFontSize: 14 },
          { id: "production-flow", selector: ".swh-production-flow span", backdrop: "surface", minFontSize: 12 },
          { id: "contact-label", selector: ".swh-contact-list small", backdrop: "surface", minFontSize: 12, optional: true },
          { id: "contact-value", selector: ".swh-contact-list strong", backdrop: "surface", minFontSize: 14, optional: true },
          { id: "contact-placeholder", selector: ".swh-contact-placeholder span", backdrop: "surface", minFontSize: 12, optional: true },
        ];
        const readability = readabilitySpec.map((entry) => {
          const target = node.querySelector(entry.selector);
          if (!(target instanceof HTMLElement)) return { ...entry, exists: false };
          const targetStyle = getComputedStyle(target);
          const rect = target.getBoundingClientRect();
          return {
            ...entry,
            exists: true,
            text: (target.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 120),
            color: targetStyle.color,
            fontSize: Number.parseFloat(targetStyle.fontSize || "0"),
            fontWeight: targetStyle.fontWeight,
            opacity: Number.parseFloat(targetStyle.opacity || "0"),
            visible: targetStyle.display !== "none"
              && targetStyle.visibility !== "hidden"
              && rect.width > 0
              && rect.height > 0,
          };
        });
        const motionSpec = [
          { id: "project-card", selector: ".swh-loop-float-shell" },
          { id: "signal-track", selector: ".swh-loop-signal" },
          { id: "data-beam", selector: ".swh-data-beam-one" },
          { id: "holo-orbit", selector: ".swh-holo-orbit-one" },
          { id: "card-beam", selector: ".swh-card-beam" },
        ];
        const motion = Object.fromEntries(motionSpec.map((entry) => {
          const target = node.querySelector(entry.selector);
          if (!(target instanceof HTMLElement)) return [entry.id, { ...entry, exists: false }];
          const targetStyle = getComputedStyle(target);
          const rect = target.getBoundingClientRect();
          return [entry.id, {
            ...entry,
            exists: true,
            animationName: targetStyle.animationName,
            animationDuration: targetStyle.animationDuration,
            animationPlayState: targetStyle.animationPlayState,
            opacity: Number.parseFloat(targetStyle.opacity || "0"),
            display: targetStyle.display,
            visibility: targetStyle.visibility,
            transform: targetStyle.transform,
            backgroundPosition: targetStyle.backgroundPosition,
            backgroundImage: targetStyle.backgroundImage,
            width: rect.width,
            height: rect.height,
          }];
        }));
        return {
          theme: document.documentElement.dataset.theme || "",
          themeSelection: document.documentElement.dataset.themeSelection || "",
          mode: document.documentElement.dataset.mode || "",
          heading: (heading?.textContent || "").replace(/\s+/gu, " ").trim(),
          background: style.background,
          color: style.color,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          scrollable: node.scrollHeight > node.clientHeight,
          heroOpacity: Number.parseFloat(getComputedStyle(node.querySelector(".swh-hero")).opacity),
          readability: {
            tokens: {
              page: style.getPropertyValue("--oh-page").trim(),
              surface: style.getPropertyValue("--oh-surface").trim(),
              surfaceSolid: style.getPropertyValue("--oh-surface-solid").trim(),
              text: style.getPropertyValue("--oh-text").trim(),
              textSoft: style.getPropertyValue("--oh-text-soft").trim(),
              textFaint: style.getPropertyValue("--oh-text-faint").trim(),
              accent: style.getPropertyValue("--oh-accent").trim(),
              chipText: style.getPropertyValue("--oh-chip-text").trim(),
              loopHeading: style.getPropertyValue("--oh-loop-heading-backdrop").trim(),
              loopItem: style.getPropertyValue("--oh-loop-item-backdrop").trim(),
            },
            items: readability,
          },
          motion: { before: motion },
        };
      });
      await publicPage.waitForTimeout(520);
      landing.motion.after = await home.evaluate((node) => Object.fromEntries([
        ["project-card", ".swh-loop-float-shell"],
        ["signal-track", ".swh-loop-signal"],
        ["data-beam", ".swh-data-beam-one"],
        ["holo-orbit", ".swh-holo-orbit-one"],
        ["card-beam", ".swh-card-beam"],
      ].map(([id, selector]) => {
        const target = node.querySelector(selector);
        if (!(target instanceof HTMLElement)) return [id, { exists: false }];
        const targetStyle = getComputedStyle(target);
        return [id, {
          exists: true,
          transform: targetStyle.transform,
          backgroundPosition: targetStyle.backgroundPosition,
          opacity: Number.parseFloat(targetStyle.opacity || "0"),
        }];
      })));
      assert.equal(landing.theme, theme.id, `${theme.id}:LANDING_THEME_MISMATCH`);
      assert.equal(landing.themeSelection, theme.id, `${theme.id}:LANDING_THEME_SELECTION_MISMATCH`);
      assert.equal(landing.mode, theme.mode, `${theme.id}:LANDING_MODE_MISMATCH`);
      assert.equal(landing.overflowX, 0, `${theme.id}:LANDING_HORIZONTAL_OVERFLOW`);
      assert.equal(landing.heroOpacity, 1, `${theme.id}:LANDING_HERO_NOT_SETTLED`);
      assert.ok(landing.heading.length > 0, `${theme.id}:LANDING_HEADING_MISSING`);
      for (const item of landing.readability.items) {
        if (item.optional && !item.exists) continue;
        assert.equal(item.exists, true, `${theme.id}:LANDING_TEXT_MISSING:${item.id}`);
        assert.equal(item.visible, true, `${theme.id}:LANDING_TEXT_HIDDEN:${item.id}`);
        assert.ok(item.opacity >= 0.99, `${theme.id}:LANDING_TEXT_TOO_FAINT:${item.id}:${item.opacity}`);
        assert.ok(item.fontSize >= item.minFontSize,
          `${theme.id}:LANDING_TEXT_TOO_SMALL:${item.id}:${item.fontSize}<${item.minFontSize}`);
        const backdrop = item.backdrop === "surface"
          ? landing.readability.tokens.surfaceSolid
          : item.backdrop === "loop-heading"
            ? landing.readability.tokens.loopHeading
            : item.backdrop === "loop-item"
              ? landing.readability.tokens.loopItem
              : landing.readability.tokens.page;
        item.contrastRatio = Number(contrastRatio(
          item.color,
          backdrop,
          landing.readability.tokens.page,
        ).toFixed(2));
        assert.ok(item.contrastRatio >= 4.5,
          `${theme.id}:LANDING_TEXT_CONTRAST_LOW:${item.id}:${item.contrastRatio}`);
      }
      const expectedMotion = {
        "project-card": { animation: /swh-project-card-float/u, minOpacity: 0.99 },
        "signal-track": { animation: /swh-loop-signal-track/u, minOpacity: 0.7 },
        "data-beam": { animation: /swh-data-beam-one/u, minOpacity: 0.08 },
        "holo-orbit": { animation: /swh-holo-orbit-clockwise/u, minOpacity: 0.6 },
        "card-beam": { animation: /oh-card-beam/u, minOpacity: 0.99 },
      };
      let progressedMotionCount = 0;
      for (const [motionId, expectation] of Object.entries(expectedMotion)) {
        const before = landing.motion.before[motionId];
        const after = landing.motion.after[motionId];
        assert.equal(before?.exists, true, `${theme.id}:LANDING_MOTION_MISSING:${motionId}`);
        assert.equal(after?.exists, true, `${theme.id}:LANDING_MOTION_AFTER_MISSING:${motionId}`);
        assert.match(before.animationName || "", expectation.animation,
          `${theme.id}:LANDING_MOTION_NAME_MISSING:${motionId}`);
        assert.equal(before.animationPlayState, "running", `${theme.id}:LANDING_MOTION_NOT_RUNNING:${motionId}`);
        assert.ok(before.opacity >= expectation.minOpacity,
          `${theme.id}:LANDING_MOTION_TOO_FAINT:${motionId}:${before.opacity}`);
        assert.ok(before.width > 0 && before.height > 0, `${theme.id}:LANDING_MOTION_NO_AREA:${motionId}`);
        assert.notEqual(before.display, "none", `${theme.id}:LANDING_MOTION_DISPLAY_NONE:${motionId}`);
        assert.notEqual(before.visibility, "hidden", `${theme.id}:LANDING_MOTION_HIDDEN:${motionId}`);
        if (before.transform !== after.transform || before.backgroundPosition !== after.backgroundPosition) {
          progressedMotionCount += 1;
        }
      }
      landing.motion.progressedCount = progressedMotionCount;
      assert.ok(progressedMotionCount >= 4,
        `${theme.id}:LANDING_MOTION_NOT_PROGRESSING:${progressedMotionCount}/5`);
      themeReport.landing = landing;
      await publicPage.screenshot({ path: path.join(outputDir, `${theme.id}-landing-1440x900.png`), fullPage: false });

      const loginTrigger = publicPage.locator(".swh-login-button");
      await loginTrigger.click();
      const drawer = publicPage.locator(".swh-login-drawer");
      await drawer.waitFor({ state: "visible", timeout: 30_000 });
      await publicPage.waitForSelector("#login-password", { state: "visible", timeout: 30_000 });
      const loginDrawer = await drawer.evaluate((node) => {
        const panel = node.querySelector(".login-panel");
        const passwordToggle = node.querySelector(".login-password-toggle");
        const rect = node.getBoundingClientRect();
        const toggleRect = passwordToggle?.getBoundingClientRect();
        const style = getComputedStyle(node);
        const panelStyle = panel ? getComputedStyle(panel) : null;
        return {
          theme: document.documentElement.dataset.theme || "",
          themeSelection: document.documentElement.dataset.themeSelection || "",
          mode: document.documentElement.dataset.mode || "",
          activeInside: node.contains(document.activeElement),
          withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
          width: rect.width,
          height: rect.height,
          background: style.background,
          borderColor: style.borderLeftColor,
          panelBackground: panelStyle?.background || "",
          passwordToggleWidth: toggleRect?.width || 0,
          passwordToggleHeight: toggleRect?.height || 0,
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      });
      assert.equal(loginDrawer.theme, theme.id, `${theme.id}:DRAWER_THEME_MISMATCH`);
      assert.equal(loginDrawer.themeSelection, theme.id, `${theme.id}:DRAWER_THEME_SELECTION_MISMATCH`);
      assert.equal(loginDrawer.withinViewport, true, `${theme.id}:DRAWER_OUTSIDE_VIEWPORT`);
      assert.equal(loginDrawer.activeInside, true, `${theme.id}:DRAWER_FOCUS_MISSING`);
      assert.ok(loginDrawer.passwordToggleWidth >= 36 && loginDrawer.passwordToggleHeight >= 36,
        `${theme.id}:DRAWER_PASSWORD_TARGET_TOO_SMALL`);
      assert.equal(loginDrawer.overflowX, 0, `${theme.id}:DRAWER_HORIZONTAL_OVERFLOW`);
      themeReport.loginDrawer = loginDrawer;
      await publicPage.screenshot({ path: path.join(outputDir, `${theme.id}-login-drawer-1440x900.png`), fullPage: false });
      await publicContext.close();

      const appContext = await createContext({ theme, authenticated: true });
      const appPage = await appContext.newPage();
      watchPage(appPage, `${theme.id}:app`);
      const appResponse = await appPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(appResponse?.status(), 200, `${theme.id}:APP_HTTP`);
      await appPage.waitForSelector(".marketplace-shell", { state: "visible", timeout: 30_000 });
      await appPage.waitForTimeout(600);
      const marketplaceThemeTriggerCount = await appPage.locator('[data-theme-switcher-trigger="true"]:visible').count();
      assert.equal(marketplaceThemeTriggerCount, 1, `${theme.id}:MARKETPLACE_THEME_TRIGGER_MUST_BE_SIDEBAR_ONLY`);
      const marketplace = await appPage.evaluate(() => {
        const shell = document.querySelector(".marketplace-shell");
        const depth = document.querySelector(".marketplace-shell .marketplace-depth");
        const card = document.querySelector(".marketplace-agent-grid .agent-card-hover");
        const nav = document.querySelector('[data-primary-nav-style="plain-tabs"]');
        const activeNav = nav?.querySelector('.nav-pill-active, .nav-pill[aria-current="page"]');
        const indicator = nav?.querySelector(".nav-pill-indicator");
        const root = getComputedStyle(document.documentElement);
        const navStyle = nav ? getComputedStyle(nav) : null;
        const activeNavStyle = activeNav ? getComputedStyle(activeNav) : null;
        const activeNavRect = activeNav?.getBoundingClientRect();
        const indicatorRect = indicator?.getBoundingClientRect();
        const depthBeforeStyle = depth ? getComputedStyle(depth, "::before") : null;
        const iconColors = [...document.querySelectorAll(".marketplace-shell .nav-pill svg")]
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => getComputedStyle(node).color)
          .filter((value, index, values) => value && values.indexOf(value) === index);
        const shortcutIconColors = [...document.querySelectorAll(".sidebar-shortcut-grid .sidebar-shortcut-icon")]
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => getComputedStyle(node).color)
          .filter((value, index, values) => value && values.indexOf(value) === index);
        return {
          theme: document.documentElement.dataset.theme || "",
          themeSelection: document.documentElement.dataset.themeSelection || "",
          mode: document.documentElement.dataset.mode || "",
          primary: root.getPropertyValue("--primary").trim(),
          ring: root.getPropertyValue("--ring").trim(),
          foreground: root.getPropertyValue("--foreground").trim(),
          background: root.getPropertyValue("--background").trim(),
          shellBackground: shell ? getComputedStyle(shell).background : "",
          cardBackground: card ? getComputedStyle(card).backgroundColor : "",
          iconColors,
          shortcutIconColors,
          grid: {
            content: depthBeforeStyle?.content || "",
            opacity: Number.parseFloat(depthBeforeStyle?.opacity || "0"),
            backgroundImage: depthBeforeStyle?.backgroundImage || "",
            backgroundPosition: depthBeforeStyle?.backgroundPosition || "",
            backgroundSize: depthBeforeStyle?.backgroundSize || "",
            transform: depthBeforeStyle?.transform || "",
          },
          primaryNav: {
            style: nav?.getAttribute("data-primary-nav-style") || "",
            fontSize: Number.parseFloat(activeNavStyle?.fontSize || "0"),
            minHeight: Number.parseFloat(activeNavStyle?.minHeight || "0"),
            columnGap: Number.parseFloat(navStyle?.columnGap || "0"),
            backgroundColor: activeNavStyle?.backgroundColor || "",
            backgroundImage: activeNavStyle?.backgroundImage || "",
            borderTopWidth: Number.parseFloat(activeNavStyle?.borderTopWidth || "0"),
            borderRadius: Number.parseFloat(activeNavStyle?.borderTopLeftRadius || "0"),
            boxShadow: activeNavStyle?.boxShadow || "",
            activeWidth: activeNavRect?.width || 0,
            indicatorWidth: indicatorRect?.width || 0,
            indicatorHeight: indicatorRect?.height || 0,
            indicatorDisplay: indicator ? getComputedStyle(indicator).display : "",
            internalOverflowX: nav ? Math.max(0, nav.scrollWidth - nav.clientWidth) : -1,
          },
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        };
      });
      assert.equal(marketplace.theme, theme.id, `${theme.id}:MARKETPLACE_THEME_MISMATCH`);
      assert.equal(marketplace.themeSelection, theme.id, `${theme.id}:MARKETPLACE_THEME_SELECTION_MISMATCH`);
      assert.equal(marketplace.mode, theme.mode, `${theme.id}:MARKETPLACE_MODE_MISMATCH`);
      assert.equal(marketplace.overflowX, 0, `${theme.id}:MARKETPLACE_HORIZONTAL_OVERFLOW`);
      assert.equal(marketplace.primaryNav.style, "plain-tabs", `${theme.id}:PRIMARY_NAV_PLAIN_TABS_MISSING`);
      assert.ok(marketplace.primaryNav.fontSize >= 17, `${theme.id}:PRIMARY_NAV_FONT_TOO_SMALL`);
      assert.ok(marketplace.primaryNav.minHeight >= 42, `${theme.id}:PRIMARY_NAV_TARGET_TOO_SHORT`);
      assert.ok(marketplace.primaryNav.columnGap <= 0.5, `${theme.id}:PRIMARY_NAV_SPACING_NOT_COMPACT`);
      assert.equal(marketplace.primaryNav.backgroundColor, "rgba(0, 0, 0, 0)", `${theme.id}:PRIMARY_NAV_ACTIVE_BACKGROUND_PRESENT`);
      assert.equal(marketplace.primaryNav.backgroundImage, "none", `${theme.id}:PRIMARY_NAV_ACTIVE_GRADIENT_PRESENT`);
      assert.equal(marketplace.primaryNav.borderTopWidth, 0, `${theme.id}:PRIMARY_NAV_ACTIVE_BORDER_PRESENT`);
      assert.equal(marketplace.primaryNav.borderRadius, 0, `${theme.id}:PRIMARY_NAV_ACTIVE_RADIUS_PRESENT`);
      assert.equal(marketplace.primaryNav.boxShadow, "none", `${theme.id}:PRIMARY_NAV_ACTIVE_SHADOW_PRESENT`);
      assert.ok(
        marketplace.primaryNav.indicatorDisplay === "" || marketplace.primaryNav.indicatorDisplay === "none",
        `${theme.id}:PRIMARY_NAV_UNDERLINE_VISIBLE`,
      );
      assert.equal(marketplace.primaryNav.indicatorHeight, 0, `${theme.id}:PRIMARY_NAV_UNDERLINE_HEIGHT`);
      themeReport.marketplace = { ...marketplace, themeTriggerCount: marketplaceThemeTriggerCount };
      const announcementDialog = appPage.locator('[role="dialog"]:visible').filter({
        has: appPage.getByRole("button", { name: "关闭系统公告", exact: true }),
      }).first();
      if (await announcementDialog.isVisible().catch(() => false)) {
        const dialogMetrics = await announcementDialog.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            aspectRatio: rect.width / rect.height,
            withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1
              && rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });
        assert.ok(dialogMetrics.aspectRatio >= 1.25, `${theme.id}:ANNOUNCEMENT_NOT_RECTANGULAR`);
        assert.equal(dialogMetrics.withinViewport, true, `${theme.id}:ANNOUNCEMENT_OUTSIDE_VIEWPORT`);
        assert.equal(dialogMetrics.overflowX, 0, `${theme.id}:ANNOUNCEMENT_HORIZONTAL_OVERFLOW`);
        themeReport.announcementDialog = dialogMetrics;
      }
      await appPage.screenshot({ path: path.join(outputDir, `${theme.id}-marketplace-1440x900.png`), fullPage: false });

      const announcementClose = appPage.getByRole("button", { name: "关闭系统公告", exact: true });
      if (await announcementClose.isVisible().catch(() => false)) {
        await announcementClose.click();
        await announcementClose.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
        themeReport.marketplace.announcementDismissedForReadOnlyNavigation = true;
      } else {
        themeReport.marketplace.announcementDismissedForReadOnlyNavigation = false;
      }

      const trigger = appPage.locator('[data-theme-switcher-trigger="true"]:visible').first();
      await trigger.click();
      const options = await appPage.locator("[data-theme-option]").evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-theme-option"),
        text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
      })));
      if (theme.id === themes[0].id) {
        const modes = await appPage.locator("[data-theme-mode-option]").evaluateAll((nodes) => nodes.map((node) => ({
          id: node.getAttribute("data-theme-mode-option"),
          text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
          disabled: node.hasAttribute("data-disabled") || node.getAttribute("aria-disabled") === "true",
        })));
        report.themeSwitcher = { options, modes };
      }
      assert.deepEqual(options.map((item) => item.id), themes.map((item) => item.id), `${theme.id}:THEME_OPTION_ORDER`);
      await appPage.keyboard.press("Escape");

      for (const pathname of ["/tools", "/video"]) {
        const response = await appPage.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        assert.equal(response?.status(), 200, `${theme.id}:${pathname}:HTTP`);
        await appPage.waitForFunction(() => (document.body?.innerText?.trim().length || 0) > 30, null, { timeout: 30_000 });
        await appPage.waitForTimeout(1_200);
        const adjacentThemeTriggerCount = await appPage.locator('[data-theme-switcher-trigger="true"]:visible').count();
        assert.equal(adjacentThemeTriggerCount, 0, `${theme.id}:${pathname}:SECONDARY_PAGE_THEME_TRIGGER_MUST_BE_REMOVED`);
        const adjacent = await appPage.evaluate(() => ({
          theme: document.documentElement.dataset.theme || "",
          themeSelection: document.documentElement.dataset.themeSelection || "",
          mode: document.documentElement.dataset.mode || "",
          title: document.title,
          heading: (document.querySelector("h1, h2")?.textContent || "").replace(/\s+/gu, " ").trim(),
          overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          bodyCharacters: (document.body?.innerText || "").trim().length,
        }));
        assert.equal(adjacent.theme, theme.id, `${theme.id}:${pathname}:THEME_MISMATCH`);
        assert.equal(adjacent.themeSelection, theme.id, `${theme.id}:${pathname}:THEME_SELECTION_MISMATCH`);
        assert.equal(adjacent.mode, theme.mode, `${theme.id}:${pathname}:MODE_MISMATCH`);
        assert.equal(adjacent.overflowX, 0, `${theme.id}:${pathname}:HORIZONTAL_OVERFLOW`);
        themeReport.adjacentPages.push({ pathname, themeTriggerCount: adjacentThemeTriggerCount, ...adjacent });
        await appPage.screenshot({
          path: path.join(outputDir, `${theme.id}-${pathname.slice(1)}-1440x900.png`),
          fullPage: false,
        });
      }
      await appContext.close();
    }

    const optionLabels = Object.fromEntries(report.themeSwitcher.options.map((item) => [item.id, item.text]));
    for (const theme of themes) assert.match(optionLabels[theme.id] || "", new RegExp(theme.label, "u"), `${theme.id}:LABEL_MISMATCH`);
    assert.deepEqual(report.themeSwitcher.modes.map((item) => item.id), [], "FIXED_THEMES_MUST_NOT_EXPOSE_MODE_OPTIONS");
    assert.equal(new Set(Object.values(report.themes).map((entry) => entry.landing.background)).size, themes.length,
      "LANDING_THEME_SIGNATURES_NOT_DISTINCT");
    assert.equal(new Set(Object.values(report.themes).map((entry) => [
      entry.loginDrawer.background,
      entry.loginDrawer.borderColor,
      entry.loginDrawer.panelBackground,
    ].join("|"))).size, themes.length, "DRAWER_THEME_SIGNATURES_NOT_DISTINCT");
    assert.equal(new Set(Object.values(report.themes).map((entry) => [
      entry.marketplace.primary,
      entry.marketplace.shellBackground,
      entry.marketplace.cardBackground,
    ].join("|"))).size, themes.length, "MARKETPLACE_THEME_SIGNATURES_NOT_DISTINCT");
    const heiYaoNiCai = report.themes["crystal-aurora"];
    assert.equal(heiYaoNiCai.landing.mode, "dark", "HEIYAO_NICAI_HOME_MODE_MISMATCH");
    assert.equal(heiYaoNiCai.marketplace.background.toLowerCase(), "#05070a", "HEIYAO_NICAI_NEAR_BLACK_BASE_MISSING");
    assert.equal(heiYaoNiCai.marketplace.primary.toLowerCase(), "#28d5c0", "HEIYAO_NICAI_CYAN_PRIMARY_MISSING");
    assert.equal(heiYaoNiCai.marketplace.ring.toLowerCase(), "#35d8cd", "HEIYAO_NICAI_RING_MISSING");
    assert.equal(heiYaoNiCai.marketplace.foreground.toLowerCase(), "#f1fefd", "HEIYAO_NICAI_TEXT_MISSING");
    for (const expectedColor of ["rgb(85, 191, 174)", "rgb(210, 163, 92)", "rgb(166, 139, 208)", "rgb(201, 130, 164)", "rgb(215, 138, 98)"]) {
      assert.ok(heiYaoNiCai.marketplace.iconColors.includes(expectedColor), `HEIYAO_NICAI_PRIMARY_ICON_COLOR_MISSING:${expectedColor}`);
    }
    assert.ok(heiYaoNiCai.marketplace.iconColors.length >= 7, "HEIYAO_NICAI_PRIMARY_ICON_COLORS_NOT_RICH_ENOUGH");
    for (const expectedColor of ["rgb(34, 211, 238)", "rgb(167, 139, 250)", "rgb(59, 130, 246)", "rgb(245, 158, 11)", "rgb(16, 185, 129)", "rgb(236, 72, 153)"]) {
      assert.ok(heiYaoNiCai.marketplace.shortcutIconColors.includes(expectedColor), `HEIYAO_NICAI_SHORTCUT_ICON_COLOR_MISSING:${expectedColor}`);
    }
    assert.ok(heiYaoNiCai.marketplace.shortcutIconColors.length >= 8, "HEIYAO_NICAI_SHORTCUT_ICON_COLORS_NOT_RICH_ENOUGH");
    // U07/U23's current desktop contract uses solid surface layers for the
    // marketplace.  The legacy pseudo-element grid is intentionally disabled
    // by the final unified workbench guard; keep this verifier aligned with
    // the rendered contract instead of requiring the retired grid layer.
    assert.equal(heiYaoNiCai.marketplace.grid.content, "none", "HEIYAO_NICAI_GRID_LAYER_MUST_BE_DISABLED");
    assert.equal(heiYaoNiCai.marketplace.grid.transform, "none", "HEIYAO_NICAI_GRID_TRANSFORM_MUST_BE_INACTIVE");
    assert.doesNotMatch(`${heiYaoNiCai.landing.background}|${heiYaoNiCai.marketplace.shellBackground}|${heiYaoNiCai.marketplace.cardBackground}`, /rgb\(0,\s*0,\s*0\)|#000(?:000)?\b/iu, "HEIYAO_NICAI_PURE_BLACK_SURFACE_FORBIDDEN");
    assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
    assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
    assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
    assert.deepEqual(report.requestFailures, [], `REQUEST_FAILURES:${JSON.stringify(report.requestFailures)}`);
    assert.deepEqual(report.reachedServerMutations, [], `SERVER_MUTATIONS:${JSON.stringify(report.reachedServerMutations)}`);
    assert.deepEqual(report.paidRequests, [], `PAID_REQUESTS:${JSON.stringify(report.paidRequests)}`);
    report.diagnosticPassed = true;
    report.productionWrites = 0;
    await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({
      diagnosticPassed: true,
      acceptance: report.acceptance,
      themes: Object.keys(report.themes),
      blockedMutationAttempts: report.blockedMutationAttempts.length,
      productionWrites: 0,
      pageErrors: 0,
      consoleErrors: 0,
      serverErrors: 0,
    }, null, 2));
  } catch (error) {
    report.failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    await writeFile(path.join(outputDir, "failure-report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    throw error;
  } finally {
    await browser.close();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
