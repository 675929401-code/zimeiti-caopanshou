#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
const expectedSourceVersion = "R000685-20261002-5e9b89a7";
const expectedBuildId = "j6bTJRjj7oSzsRB8aga_8";
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const evidenceDir = path.resolve(".codex-evidence", "security-dashboard-trust-r685-desktop");
const viewport = { width: 1440, height: 900 };

const pages = [
  { id: "security", url: "/admin?tab=security", heading: "安全中心", selector: "[data-admin-security-center]", securitySurface: true },
  { id: "guard-logs", url: "/admin?tab=guard-logs", heading: "安全预警", securitySurface: true },
  { id: "login-logs", url: "/admin?tab=login-logs", heading: "登录日志", securitySurface: true },
  { id: "dashboard", url: "/admin?tab=dashboard", heading: "平台运营安全指挥中心", selector: '[data-testid="admin-command-center"]' },
  { id: "health", url: "/admin?tab=health", heading: "系统健康" },
  { id: "users", url: "/admin?tab=users", heading: "学员与会员", selector: '[data-testid="admin-member-workspace"]' },
  { id: "general", url: "/admin?tab=general", heading: "品牌与基本设置", selector: '[data-testid="platform-brand-settings"]' },
];

const apiDefinitions = [
  { id: "security", path: "/api/admin/security-events?page=1&pageSize=20" },
  { id: "guard", path: "/api/admin/guard-logs?page=1&pageSize=20" },
  { id: "login", path: "/api/admin/login-logs?page=1&pageSize=20" },
  { id: "command-center", path: "/api/admin/command-center?hours=24" },
  { id: "version", path: "/api/version" },
];

const telemetryPaths = new Set(["/api/operation-events", "/api/client-error-report"]);
const providerPathPattern = /^\/api\/(?:llm(?:\/|$)|chat(?:\/|$)|image\/generate(?:\/|$)|video\/generate(?:\/|$)|voice\/(?:tts|nest)(?:\/|$)|digital-human\/generate(?:\/|$)|admin\/(?:llm-test|[^/]+\/validation\/publish)(?:\/|$))/u;
const mojibakePatterns = [
  /\uFFFD/u,
  /(?:锟斤拷|鐧诲綍|瀹夊叏|绠＄悊|鐢ㄦ埛|鏃堕棿|鎻愮ず|鍏抽棴|鏌ョ湅|鍔犺浇)/u,
  /(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]|â(?:€|€™|€œ|€�)|ï¿½|ðŸ)/u,
];
const barePhonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const ipv4Pattern = /(?<![\d./])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/gu;

const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  viewport,
  expectedRuntime: { sourceVersion: expectedSourceVersion, buildId: expectedBuildId },
  runtime: null,
  pages: [],
  api: [],
  securityContract: null,
  commandCenterContract: null,
  contractViolations: [],
  blockedWrites: [],
  providerRequests: [],
  externalRequests: [],
  externalFontsFiltered: [],
  telemetry: {
    operationEvents: 0,
    clientErrorReport: 0,
    responses: [],
  },
  pageErrors: [],
  consoleErrors: [],
  ignoredExternalFontConsoleErrors: [],
  serverErrors: [],
  apiErrors: [],
  failure: null,
  sideEffects: {
    businessWritesExecuted: 0,
    paidCalls: 0,
    providerCalls: 0,
    productionWrites: 0,
  },
};

let activePageId = "bootstrap";

function absoluteEvidencePath(fileName) {
  return path.join(evidenceDir, fileName);
}

function relativeEvidencePath(fileName) {
  return path.relative(process.cwd(), absoluteEvidencePath(fileName)).replaceAll("\\", "/");
}

function collectKeys(value, target = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (!value || typeof value !== "object") return target;
  for (const [key, child] of Object.entries(value)) {
    target.add(key);
    collectKeys(child, target);
  }
  return target;
}

function isVersionLikeIpv4(text, index) {
  const prefix = text.slice(Math.max(0, index - 48), index);
  return /(?:Chrome|CriOS|Firefox|EdgA?|OPR|Version|Safari|AppleWebKit|Windows NT)[/ ][^\s;()]{0,28}$/iu.test(prefix);
}

function unsafeTextFindings(text) {
  const value = String(text || "");
  const mojibake = mojibakePatterns.flatMap((pattern) => {
    const match = value.match(pattern);
    return match ? [match[0]] : [];
  });
  const phones = [...value.matchAll(barePhonePattern)].map((match) => match[0]);
  const ipv4 = [...value.matchAll(ipv4Pattern)]
    .filter((match) => !isVersionLikeIpv4(value, match.index || 0))
    .map((match) => match[0]);
  return {
    mojibake: [...new Set(mojibake)],
    barePhones: [...new Set(phones)],
    bareIpv4: [...new Set(ipv4)],
  };
}

function unsafeValuePaths(value, currentPath = "$", findings = { mojibake: [], barePhones: [], bareIpv4: [] }) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => unsafeValuePaths(item, `${currentPath}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      unsafeValuePaths(child, `${currentPath}.${key}`, findings);
    }
    return findings;
  }
  if (typeof value !== "string") return findings;
  const valueFindings = unsafeTextFindings(value);
  if (valueFindings.mojibake.length > 0) findings.mojibake.push(currentPath);
  if (valueFindings.barePhones.length > 0) findings.barePhones.push(currentPath);
  if (valueFindings.bareIpv4.length > 0) findings.bareIpv4.push(currentPath);
  return findings;
}

function assertTrustedText(label, text) {
  const findings = unsafeTextFindings(text);
  assert.equal(findings.mojibake.length, 0, `${label}:MOJIBAKE_COUNT:${findings.mojibake.length}`);
  assert.equal(findings.barePhones.length, 0, `${label}:BARE_PHONE_COUNT:${findings.barePhones.length}`);
  assert.equal(findings.bareIpv4.length, 0, `${label}:BARE_IPV4_COUNT:${findings.bareIpv4.length}`);
  return { mojibake: 0, barePhones: 0, bareIpv4: 0 };
}

function installDiagnostics(page) {
  page.on("pageerror", (error) => {
    report.pageErrors.push({ page: activePageId, url: page.url(), message: String(error?.message || error).slice(0, 1_000) });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const locationUrl = String(message.location()?.url || "");
    if (/fonts\.(?:googleapis|gstatic)\.com/iu.test(`${locationUrl} ${text}`)) {
      report.ignoredExternalFontConsoleErrors.push({ page: activePageId, url: locationUrl, message: text.slice(0, 500) });
      return;
    }
    report.consoleErrors.push({ page: activePageId, url: locationUrl || page.url(), message: text.slice(0, 1_000) });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const status = response.status();
    if (url.origin === origin && status >= 500) {
      report.serverErrors.push({ page: activePageId, status, method: response.request().method(), pathname: url.pathname });
    }
    if (url.origin === origin && url.pathname.startsWith("/api/") && status >= 400) {
      report.apiErrors.push({ page: activePageId, status, method: response.request().method(), pathname: url.pathname });
    }
    if (url.origin === origin && telemetryPaths.has(url.pathname)) {
      report.telemetry.responses.push({ page: activePageId, status, pathname: url.pathname });
    }
  });
}

async function installReadOnlyBoundary(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();

    if (url.origin === origin && telemetryPaths.has(url.pathname) && method === "POST") {
      if (url.pathname === "/api/operation-events") report.telemetry.operationEvents += 1;
      if (url.pathname === "/api/client-error-report") report.telemetry.clientErrorReport += 1;
      await route.continue();
      return;
    }

    if (url.origin === origin && providerPathPattern.test(url.pathname)) {
      report.providerRequests.push({ page: activePageId, method, pathname: url.pathname });
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (url.origin !== origin) {
      const external = { page: activePageId, method, url: `${url.origin}${url.pathname}` };
      if (/^(?:fonts\.googleapis\.com|fonts\.gstatic\.com)$/iu.test(url.hostname)) {
        report.externalFontsFiltered.push(external);
        await route.fulfill({ status: 204, body: "" });
      } else {
        report.externalRequests.push(external);
        await route.abort("blockedbyclient");
      }
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.blockedWrites.push({ page: activePageId, method, pathname: url.pathname });
      await route.fulfill({ status: 204, contentType: "application/json", body: "{}" });
      return;
    }

    await route.continue();
  });
}

async function waitForPageReady(page, definition) {
  if (definition.selector) {
    await page.locator(definition.selector).waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.getByText(definition.heading, { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await page.locator('[data-testid="admin-tab-locked"]').count(), 0, `ADMIN_TAB_LOCKED:${definition.id}`);

  if (definition.id === "security") {
    await page.getByText("隐私：手机号与 IP 默认脱敏", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  }
  if (definition.id === "guard-logs" || definition.id === "login-logs") {
    await page.waitForFunction(() => !document.querySelector("main")?.innerText.includes("加载中..."), undefined, { timeout: 60_000 });
  }
  if (definition.id === "dashboard") {
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-testid^="command-center-headline-"]').length === 3
      && document.querySelectorAll('[data-testid="command-center-sections"] > section[data-section]').length === 7
    ), undefined, { timeout: 90_000 });
  }
  if (definition.id === "health") {
    await page.getByRole("button", { name: "立即检查", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await page.getByText("数据库连接", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  }
  await page.waitForTimeout(350);
}

async function samplePage(page, definition) {
  activePageId = definition.id;
  const response = await page.goto(`${origin}${definition.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `PAGE_UNAVAILABLE:${definition.url}:${response?.status()}`);
  await waitForPageReady(page, definition);

  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main");
    const heading = main?.querySelector("h1,h2,h3");
    const mainStyle = main ? getComputedStyle(main) : null;
    const bodyStyle = getComputedStyle(document.body);
    const headingStyle = heading ? getComputedStyle(heading) : null;
    return {
      title: document.title,
      path: `${location.pathname}${location.search}`,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth,
      mainScrollWidth: main?.scrollWidth ?? null,
      mainClientWidth: main?.clientWidth ?? null,
      mainText: (main?.innerText || "").replace(/\s+/gu, " ").trim(),
      computedStyle: {
        bodyBackgroundColor: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        bodyFontSize: bodyStyle.fontSize,
        mainOverflowX: mainStyle?.overflowX || null,
        headingColor: headingStyle?.color || null,
        headingFontSize: headingStyle?.fontSize || null,
      },
    };
  });

  assert.deepEqual(metrics.viewport, viewport, `DESKTOP_VIEWPORT_DRIFT:${definition.id}`);
  assert.ok(metrics.mainText.length >= 20, `EMPTY_ADMIN_PAGE:${definition.id}`);
  const documentOverflow = Math.max(0, metrics.documentWidth - metrics.documentClientWidth);
  const bodyOverflow = Math.max(0, metrics.bodyWidth - metrics.documentClientWidth);
  const mainOverflow = metrics.mainScrollWidth == null || metrics.mainClientWidth == null
    ? 0
    : Math.max(0, metrics.mainScrollWidth - metrics.mainClientWidth);
  assert.ok(documentOverflow <= 1, `DOCUMENT_HORIZONTAL_OVERFLOW:${definition.id}:${documentOverflow}`);
  assert.ok(bodyOverflow <= 1, `BODY_HORIZONTAL_OVERFLOW:${definition.id}:${bodyOverflow}`);
  assert.ok(mainOverflow <= 1, `MAIN_HORIZONTAL_OVERFLOW:${definition.id}:${mainOverflow}`);

  let trustScan = null;
  if (definition.securitySurface) {
    trustScan = assertTrustedText(`DOM:${definition.id}`, metrics.mainText);
  }

  let dashboard = null;
  if (definition.id === "dashboard") {
    for (const expectedCopy of [
      "平台运营安全指挥中心",
      "只读 · 近实时快照 · 零供应商调用",
      "失败、过期和覆盖不全均原样披露，不用 0 填补未知",
      "15 秒近实时只读轮询 · 非实时流",
      "来源证据与异常聚合",
      "来源异常时间线",
    ]) {
      assert.ok(metrics.mainText.includes(expectedCopy), `COMMAND_CENTER_COPY_MISSING:${expectedCopy}`);
    }
    const surface = page.locator('[data-testid="admin-command-center"]');
    dashboard = {
      headlineCount: await page.locator('[data-testid^="command-center-headline-"]').count(),
      sectionCount: await page.locator('[data-testid="command-center-sections"] > section[data-section]').count(),
      sectionIds: await page.locator('[data-testid="command-center-sections"] > section[data-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
      overallStatus: await surface.getAttribute("data-overall-status"),
      surface: await surface.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          overflowX: style.overflowX,
        };
      }),
    };
    assert.equal(dashboard.headlineCount, 3, "COMMAND_CENTER_HEADLINE_COUNT");
    assert.equal(dashboard.sectionCount, 7, "COMMAND_CENTER_SECTION_COUNT");
    assert.deepEqual(dashboard.sectionIds, ["business", "finance", "tasks", "models", "security", "operations", "governance"], "COMMAND_CENTER_SECTION_ORDER");
    assert.ok(dashboard.surface.width >= 900, `COMMAND_CENTER_SURFACE_TOO_NARROW:${dashboard.surface.width}`);
  }

  const screenshotName = `${definition.id}-1440x900.png`;
  await page.screenshot({ path: absoluteEvidencePath(screenshotName), fullPage: false });
  if (definition.id === "dashboard") {
    await page.screenshot({ path: absoluteEvidencePath("dashboard-full-page.png"), fullPage: true });
  }

  report.pages.push({
    id: definition.id,
    url: `${origin}${definition.url}`,
    heading: definition.heading,
    visibleTextLength: metrics.mainText.length,
    viewport: metrics.viewport,
    horizontalOverflow: { document: documentOverflow, body: bodyOverflow, main: mainOverflow },
    computedStyle: metrics.computedStyle,
    trustScan,
    dashboard,
    screenshot: relativeEvidencePath(screenshotName),
    ...(definition.id === "dashboard" ? { fullPageScreenshot: relativeEvidencePath("dashboard-full-page.png") } : {}),
  });
}

async function fetchAuthenticatedApisInPage(page) {
  activePageId = "dashboard-api-fetch";
  const responses = await page.evaluate(async (definitions) => {
    const sessionToken = localStorage.getItem("auth_token") || "";
    return Promise.all(definitions.map(async (definition) => {
      const response = await fetch(definition.path, {
        method: "GET",
        headers: { Authorization: `Bearer ${sessionToken}` },
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      return {
        id: definition.id,
        path: definition.path,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        cacheControl: response.headers.get("cache-control") || "",
        body: await response.text(),
      };
    }));
  }, apiDefinitions);

  const bodies = new Map();
  for (const response of responses) {
    assert.equal(response.status, 200, `AUTHENTICATED_API_FAILED:${response.id}:${response.status}`);
    let body;
    try {
      body = JSON.parse(response.body);
    } catch {
      assert.fail(`AUTHENTICATED_API_INVALID_JSON:${response.id}`);
    }
    bodies.set(response.id, body);
    const unsafePaths = response.id === "version" ? null : unsafeValuePaths(body);
    report.api.push({
      id: response.id,
      path: response.path,
      status: response.status,
      contentType: response.contentType,
      cacheControl: response.cacheControl,
      topLevelKeys: body && typeof body === "object" ? Object.keys(body).sort() : [],
      rowCounts: {
        events: Array.isArray(body?.events) ? body.events.length : null,
        logs: Array.isArray(body?.logs) ? body.logs.length : null,
        sections: Array.isArray(body?.sections) ? body.sections.length : null,
        sources: Array.isArray(body?.sources) ? body.sources.length : null,
      },
      unsafePaths,
    });
    if (unsafePaths?.mojibake.length) report.contractViolations.push({ api: response.id, type: "mojibake", paths: unsafePaths.mojibake });
    if (unsafePaths?.barePhones.length) report.contractViolations.push({ api: response.id, type: "bare-phone", paths: unsafePaths.barePhones });
    if (unsafePaths?.bareIpv4.length) report.contractViolations.push({ api: response.id, type: "bare-ipv4", paths: unsafePaths.bareIpv4 });
  }

  const security = bodies.get("security");
  const guard = bodies.get("guard");
  const login = bodies.get("login");
  const commandCenter = bodies.get("command-center");
  const version = bodies.get("version");

  const securityKeys = collectKeys(security);
  const guardKeys = collectKeys(guard);
  const loginKeys = collectKeys(login);
  if (securityKeys.has("raw_data")) report.contractViolations.push({ api: "security", type: "forbidden-key", paths: ["raw_data"] });
  if (guardKeys.has("full_message")) report.contractViolations.push({ api: "guard", type: "forbidden-key", paths: ["full_message"] });
  if (loginKeys.has("raw_data")) report.contractViolations.push({ api: "login", type: "forbidden-key", paths: ["raw_data"] });
  if (security?.summary?.dataQuality?.sensitiveFields !== "masked") report.contractViolations.push({ api: "security", type: "masked-declaration-missing", paths: ["$.summary.dataQuality.sensitiveFields"] });
  if (security?.summary?.dataQuality?.historicalValuesPreserved !== true) report.contractViolations.push({ api: "security", type: "historical-preservation-missing", paths: ["$.summary.dataQuality.historicalValuesPreserved"] });
  assert.ok(Array.isArray(security?.events), "SECURITY_API_EVENTS_MISSING");
  assert.ok(Array.isArray(guard?.logs), "GUARD_API_LOGS_MISSING");
  assert.ok(Array.isArray(login?.logs), "LOGIN_API_LOGS_MISSING");
  const securityUnsafePaths = report.api.find((entry) => entry.id === "security")?.unsafePaths
    || { mojibake: [], barePhones: [], bareIpv4: [] };

  report.securityContract = {
    securityRawDataAbsent: true,
    guardFullMessageAbsent: true,
    loginRawDataAbsent: true,
    sensitiveFields: security.summary.dataQuality.sensitiveFields,
    historicalValuesPreserved: security.summary.dataQuality.historicalValuesPreserved,
    securityEventCount: security.events.length,
    guardLogCount: guard.logs.length,
    loginLogCount: login.logs.length,
    mojibakeViolationCount: securityUnsafePaths.mojibake.length,
    barePhoneViolationCount: securityUnsafePaths.barePhones.length,
    bareIpv4ViolationCount: securityUnsafePaths.bareIpv4.length,
  };

  assert.equal(commandCenter?.sections?.length, 7, "COMMAND_CENTER_API_SECTION_COUNT");
  assert.deepEqual(commandCenter.sections.map((section) => section.id), ["business", "finance", "tasks", "models", "security", "operations", "governance"], "COMMAND_CENTER_API_SECTION_ORDER");
  assert.equal(commandCenter?.refresh?.readOnly, true, "COMMAND_CENTER_API_READ_ONLY_DECLARATION");
  assert.equal(commandCenter?.refresh?.providerCalls, 0, "COMMAND_CENTER_API_PROVIDER_CALLS");
  assert.equal(commandCenter?.refresh?.businessWrites, 0, "COMMAND_CENTER_API_BUSINESS_WRITES");
  report.commandCenterContract = {
    schemaVersion: commandCenter.schemaVersion,
    generatedAt: commandCenter.generatedAt,
    overallStatus: commandCenter.overallStatus,
    sectionCount: commandCenter.sections.length,
    sectionIds: commandCenter.sections.map((section) => section.id),
    sourceCount: Array.isArray(commandCenter.sources) ? commandCenter.sources.length : null,
    refresh: commandCenter.refresh,
  };

  assert.equal(version?.sourceVersion, expectedSourceVersion, `SOURCE_VERSION_MISMATCH:${version?.sourceVersion}`);
  assert.equal(version?.buildId, expectedBuildId, `BUILD_ID_MISMATCH:${version?.buildId}`);
  report.runtime = {
    sourceVersion: version.sourceVersion,
    buildId: version.buildId,
    environment: version.env,
    versionEndpoint: `${origin}/api/version`,
  };
}

async function launchBrowser() {
  try {
    await fs.access(bundledChromium);
    return await chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    return chromium.launch({ headless: true });
  }
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_R685_ORIGIN_REQUIRED");
  assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await installReadOnlyBoundary(context);
    await context.addCookies([{
      name: "auth_token",
      value: token,
      url: origin,
      sameSite: "Lax",
    }]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    installDiagnostics(page);
    for (const definition of pages) await samplePage(page, definition);
    await fetchAuthenticatedApisInPage(page);

    assert.deepEqual(report.providerRequests, [], "PROVIDER_OR_PAID_REQUEST_DETECTED");
    assert.deepEqual(report.blockedWrites, [], "UNEXPECTED_BUSINESS_WRITE_ATTEMPTED");
    assert.deepEqual(report.externalRequests, [], "UNEXPECTED_EXTERNAL_REQUEST_DETECTED");
    assert.deepEqual(report.pageErrors, [], "PAGE_ERRORS_DETECTED");
    assert.deepEqual(report.consoleErrors, [], "CONSOLE_ERRORS_DETECTED");
    assert.deepEqual(report.serverErrors, [], "HTTP_5XX_DETECTED");
    assert.deepEqual(report.apiErrors, [], "HTTP_API_ERROR_DETECTED");
    assert.deepEqual(report.contractViolations, [], `SECURITY_TRUST_CONTRACT_VIOLATIONS:${JSON.stringify(report.contractViolations)}`);
    report.passed = true;
    await context.close();
  } catch (error) {
    report.failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? String(error.stack || "").slice(0, 4_000) : "",
      page: activePageId,
    };
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    report.checkedAt = new Date().toISOString();
    await fs.writeFile(absoluteEvidencePath("report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    runtime: report.runtime,
    pages: report.pages.length,
    securityContract: report.securityContract,
    commandCenter: report.commandCenterContract,
    telemetry: report.telemetry,
    blockedWrites: report.blockedWrites.length,
    providerRequests: report.providerRequests.length,
    pageErrors: report.pageErrors.length,
    consoleErrors: report.consoleErrors.length,
    serverErrors: report.serverErrors.length,
    evidence: absoluteEvidencePath("report.json"),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
