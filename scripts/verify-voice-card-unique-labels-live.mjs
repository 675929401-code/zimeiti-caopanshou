#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"]);
assert.ok(ALLOWED_ORIGINS.has(ORIGIN), "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(TOKEN, "LOCAL_ADMIN_SESSION_REQUIRED");

const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const outputDirectory = path.resolve(".codex-evidence/voice-card-unique-labels-live-20261006", runId);
const routes = [
  { id: "voices", path: "/voice-studio/voices" },
  { id: "workspace", path: "/voice-studio/workspace" },
  { id: "imitate", path: "/voice-studio/imitate" },
];
const report = {
  observedAt: new Date().toISOString(),
  origin: ORIGIN,
  viewport: { width: 1440, height: 900 },
  policy: { readOnly: true, generationRequests: 0, businessWrites: 0 },
  routes: [],
  blockedTelemetry: [],
  blockedBusinessWrites: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};
let activeRoute = "";

const compact = (value) => String(value || "")
  .replace(/https?:\/\/\S+/gu, "[url]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]")
  .slice(0, 300);

function isTelemetry(pathname) {
  return pathname === "/api/product-usage/events" || pathname === "/api/operation-events";
}

async function inspect(page, route) {
  activeRoute = route.path;
  const beganAt = Date.now();
  const response = await page.goto(`${ORIGIN}${route.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.ok(response && response.status() < 400, `${route.path}: navigation failed`);
  await page.waitForFunction(() => (document.body?.innerText || "").trim().length > 80, null, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const metrics = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id).filter(Boolean);
    const duplicateIds = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
    const brokenLabelledBy = [...document.querySelectorAll("[aria-labelledby]")]
      .filter(visible)
      .map((element) => ({
        tag: element.tagName,
        labelledBy: element.getAttribute("aria-labelledby") || "",
        missing: (element.getAttribute("aria-labelledby") || "").split(/\s+/u).filter((id) => id && !document.getElementById(id)),
      }))
      .filter((entry) => entry.missing.length > 0);
    const images = [...document.images].filter(visible);
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    return {
      title: document.title,
      bodyTextLength: document.body.innerText.length,
      duplicateIds,
      brokenLabelledBy,
      brokenImages: images.filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.getAttribute("alt") || "unnamed"),
      horizontalOverflowPx: Math.max(0, Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth),
      computedStyles: {
        rootBackground: rootStyle.backgroundColor,
        rootColor: rootStyle.color,
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        bodyFontFamily: bodyStyle.fontFamily,
      },
      visibleControls: [...document.querySelectorAll("button,a[href],input,textarea,select")].filter(visible).length,
      voiceCards: document.querySelectorAll("[data-voice-card], [data-featured-voice-card]").length,
    };
  });
  const screenshot = path.join(outputDirectory, `${route.id}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const result = { ...route, status: response.status(), elapsedMs: Date.now() - beganAt, screenshot, ...metrics };
  assert.deepEqual(result.duplicateIds, [], `${route.path}: duplicate DOM ids detected`);
  assert.deepEqual(result.brokenLabelledBy, [], `${route.path}: broken aria-labelledby detected`);
  assert.deepEqual(result.brokenImages, [], `${route.path}: broken visible images detected`);
  assert.equal(result.horizontalOverflowPx, 0, `${route.path}: desktop horizontal overflow detected`);
  return result;
}

await fs.mkdir(outputDirectory, { recursive: true });
const authResponse = await fetch(`${ORIGIN}/api/auth/me`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
  signal: AbortSignal.timeout(10_000),
});
const authBody = await authResponse.json();
assert.ok(authResponse.ok && authBody.user?.role === "admin", "ACTIVE_LOCAL_ADMIN_REQUIRED");

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (url.origin === ORIGIN && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      const record = { route: activeRoute, method, path: url.pathname };
      if (isTelemetry(url.pathname)) report.blockedTelemetry.push(record);
      else report.blockedBusinessWrites.push(record);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: TOKEN, user: authBody.user });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const value = compact(message.text());
    if (/ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED|React DevTools/u.test(value)) return;
    report.consoleErrors.push({ route: activeRoute, message: value });
  });
  page.on("pageerror", (error) => report.pageErrors.push({ route: activeRoute, message: compact(error.message) }));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    if (failure.startsWith("net::ERR_BLOCKED_BY_CLIENT") || failure === "net::ERR_ABORTED") return;
    let pathname = "external";
    try {
      const url = new URL(request.url());
      pathname = url.origin === ORIGIN ? url.pathname : "external";
    } catch {}
    report.requestFailures.push({ route: activeRoute, path: pathname, error: compact(failure) });
  });
  for (const route of routes) report.routes.push(await inspect(page, route));
  await context.close();
  report.policy.businessWrites = report.blockedBusinessWrites.length;
  report.summary = {
    passed: report.consoleErrors.length === 0 && report.pageErrors.length === 0 && report.requestFailures.length === 0 && report.blockedBusinessWrites.length === 0,
    routes: report.routes.length,
    duplicateIds: report.routes.reduce((sum, row) => sum + row.duplicateIds.length, 0),
    brokenLabelledBy: report.routes.reduce((sum, row) => sum + row.brokenLabelledBy.length, 0),
    brokenImages: report.routes.reduce((sum, row) => sum + row.brokenImages.length, 0),
    horizontalOverflowRoutes: report.routes.filter((row) => row.horizontalOverflowPx > 0).length,
    consoleErrors: report.consoleErrors.length,
    pageErrors: report.pageErrors.length,
    requestFailures: report.requestFailures.length,
    blockedBusinessWrites: report.blockedBusinessWrites.length,
  };
  assert.equal(report.summary.passed, true, "VOICE_LIVE_ACCEPTANCE_FAILED");
} finally {
  await browser.close();
  await fs.writeFile(path.join(outputDirectory, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({ outputDirectory, summary: report.summary }, null, 2));
