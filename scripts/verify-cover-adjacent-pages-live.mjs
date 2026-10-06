import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const baseUrl = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const baseOrigin = new URL(baseUrl).origin;
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const evidenceDir = path.join(root, ".codex-evidence", "cover-p0-multitask-20260927", "browser");
const themes = [
  { id: "lattice", mode: "dark" },
  { id: "soft-white", mode: "light" },
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const pages = [
  { id: "tools-video", url: "/tools?tab=video", root: '[data-page="tools"]', marker: "视频提取" },
  { id: "voice-workspace", url: "/voice-studio/workspace", root: ".voice-studio-root", marker: "语音合成工作台" },
];

export async function main() {
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const localBuildId = fs.readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim();
  const versionResponse = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.ok(versionResponse.ok, `local version unavailable: ${versionResponse.status}`);
  const version = await versionResponse.json();
  assert.equal(version.buildId, localBuildId, "served runtime is not the current local build");

  const browser = await chromium.launch({ headless: true });
  const scenarios = [];
  const pageErrors = [];
  const httpErrors = [];
  const externalRequests = [];
  const blockedWrites = [];
  const passiveTelemetry = [];

  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        for (const pageCase of pages) {
          const context = await browser.newContext({ viewport, serviceWorkers: "block" });
          await context.addInitScript(({ themeId, authToken }) => {
            localStorage.setItem("app_theme", themeId);
            localStorage.setItem("user_theme_preference", themeId);
            localStorage.setItem("auth_token", authToken);
          }, { themeId: theme.id, authToken: token });
          const page = await context.newPage();
          page.on("pageerror", (error) => pageErrors.push(`${pageCase.id}/${theme.id}/${viewport.width}: ${error.message}`));
          page.on("console", (message) => {
            if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) {
              pageErrors.push(`${pageCase.id}/${theme.id}/${viewport.width}: ${message.text()}`);
            }
          });
          page.on("response", (response) => {
            if (response.status() >= 400) httpErrors.push(`${pageCase.id}/${theme.id}/${viewport.width}: ${response.status()} ${new URL(response.url()).pathname}`);
          });
          await page.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (!["http:", "https:"].includes(url.protocol)) return route.continue();
            if (url.origin !== baseOrigin) {
              externalRequests.push(`${request.method()} ${request.url()}`);
              return route.abort("blockedbyclient");
            }
            if (request.method() === "GET" && url.pathname === "/api/auth/me") {
              const identity = await route.fetch();
              assert.ok(identity.ok(), `local administrator identity unavailable: ${identity.status()}`);
              const payload = await identity.json();
              assert.ok(payload?.user?.id, "local administrator identity is incomplete");
              return route.fulfill({
                response: identity,
                contentType: "application/json; charset=utf-8",
                body: JSON.stringify({ ...payload, user: { ...payload.user, themePreference: theme.id, theme_preference: theme.id } }),
              });
            }
            if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
              const label = `${request.method()} ${url.pathname}`;
              if (["/api/diagnostic-logs", "/api/announcements/events"].includes(url.pathname)) {
                passiveTelemetry.push(`${pageCase.id}/${theme.id}/${viewport.width}: ${label}`);
                return route.fulfill({ status: 204, body: "" });
              }
              blockedWrites.push(`${pageCase.id}/${theme.id}/${viewport.width}: ${label}`);
              return route.abort("blockedbyclient");
            }
            return route.continue();
          });

          try {
            const response = await page.goto(`${baseUrl}${pageCase.url}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
            assert.equal(response?.status(), 200, `${pageCase.url} must return 200`);
            const pageRoot = page.locator(pageCase.root);
            await pageRoot.waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText(pageCase.marker, { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 });
            const metrics = await page.evaluate((selector) => {
              const rootElement = document.querySelector(selector);
              if (!(rootElement instanceof HTMLElement)) throw new Error(`adjacent page root missing: ${selector}`);
              const rect = rootElement.getBoundingClientRect();
              return {
                theme: document.documentElement.getAttribute("data-theme"),
                mode: document.documentElement.getAttribute("data-mode"),
                documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                rootOverflowX: rootElement.scrollWidth - rootElement.clientWidth,
                rootBox: { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height },
                visibleTextLength: (rootElement.innerText || "").trim().length,
              };
            }, pageCase.root);
            assert.equal(metrics.theme, theme.id);
            assert.equal(metrics.mode, theme.mode);
            assert.ok(metrics.documentOverflowX <= 1, `${pageCase.url} document x overflow ${metrics.documentOverflowX}`);
            assert.ok(metrics.rootOverflowX <= 1, `${pageCase.url} root x overflow ${metrics.rootOverflowX}`);
            assert.ok(metrics.rootBox.left >= -1 && metrics.rootBox.right <= viewport.width + 1, `${pageCase.url} root outside viewport`);
            assert.ok(metrics.visibleTextLength >= 80, `${pageCase.url} rendered content is incomplete`);
            const screenshot = path.join(evidenceDir, `adjacent-${pageCase.id}-${theme.id}-${viewport.width}x${viewport.height}.png`);
            await page.screenshot({ path: screenshot, fullPage: false });
            scenarios.push({ page: pageCase.url, theme: theme.id, viewport, screenshot, metrics });
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(externalRequests, [], `external requests: ${externalRequests.join(" | ")}`);
  assert.deepEqual(blockedWrites, [], `business writes: ${blockedWrites.join(" | ")}`);
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(httpErrors, [], `http errors: ${httpErrors.join(" | ")}`);
  const report = {
    passed: true,
    buildId: localBuildId,
    scenarios,
    providerCalls: 0,
    paidRequests: 0,
    businessWrites: 0,
    passiveTelemetry,
    externalRequests: 0,
    pageErrors: 0,
    httpErrors: 0,
  };
  const reportPath = path.join(evidenceDir, "adjacent-pages-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  return report;
}
