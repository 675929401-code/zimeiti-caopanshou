#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identityText = String(process.env.LOCAL_NAV_READONLY_IDENTITY || "").trim();

const primaryNavigation = [
  { root: "dashboard", title: "平台指挥中心", tabs: [["指挥中心", "dashboard"]] },
  { root: "users", title: "会员管理", tabs: [["会员档案", "users"], ["邀请关系", "invitations"]] },
  { root: "benefit-packages", title: "权益与卡密", tabs: [["权益与礼包", "benefit-packages"], ["卡密管理", "cami"]] },
  { root: "credits", title: "财务与账单", tabs: [["资金账户", "credits"], ["线下收款", "offline-payments"], ["计费审计", "billing-audit"]] },
  { root: "payment", title: "支付系统", tabs: [["支付配置", "payment"]] },
  { root: "announcements", title: "公告与通知", tabs: [["公告管理", "announcements"]] },
  { root: "agents", title: "智能体管理", tabs: [["智能体管理", "agents"], ["智能体导入", "aiweb-import"], ["回收站", "trash"]] },
  { root: "models", title: "模型与服务", tabs: [["模型资源池", "models"], ["外部服务", "connection"]] },
  { root: "workspace-models", title: "工作台配置", tabs: [["工作台配置", "workspace-models"]] },
  { root: "general", title: "品牌与界面", tabs: [["基本设置", "general"], ["界面设置", "theme"], ["卡片布局", "layout"]] },
  { root: "white-label", title: "域名与贴牌", tabs: [["域名与贴牌", "white-label"]] },
  { root: "security", title: "安全审计", tabs: [["安全总览", "security"], ["提示词拦截", "guard-logs"], ["登录日志", "login-logs"]] },
  { root: "health", title: "系统运维", tabs: [["系统健康", "health"], ["数据同步", "sync"], ["灾备证据", "backup"]] },
  { root: "super-admin", title: "权限管理", tabs: [["权限管理", "super-admin"]] },
];

const commandCenterViews = [
  ["总览", "overview"],
  ["会员增长", "members"],
  ["充值营收", "revenue"],
  ["生产交付", "production"],
  ["安全风险", "security"],
  ["系统运行", "system"],
  ["数据证据", "evidence"],
];

const mappedTabs = primaryNavigation.flatMap((module) =>
  module.tabs.map(([label, tab]) => ({ label, tab, moduleRoot: module.root, moduleTitle: module.title, moduleSize: module.tabs.length })),
);
const forbiddenLabels = ["带货 Agent", "漫剧工作台", "漫剧后台", "部署到线上"];
const forbiddenPaths = [
  /^\/api\/commerce(?:\/|$)/u,
  /^\/api\/admin\/manju(?:-|\/|$)/u,
  /^\/commerce(?:\/|$)/u,
  /^\/youcai(?:\/|$)/u,
];
const paidOrMutationPaths = [
  /^\/api\/(?:chat|generate)(?:\/|$)/u,
  /^\/api\/(?:image|video|voice)(?:-generation)?\/(?:generate|submit|train|clone)(?:\/|$)/u,
  /^\/api\/(?:extract|canvas)\/(?:generate|run|submit|persist)(?:\/|$)/u,
  /^\/api\/admin\/(?:deploy|publish|video-test|video-models\/test)(?:\/|$)/u,
  /^\/api\/payment\/(?:create|notify)(?:\/|$)/u,
];
const lockedSensitiveReadPaths = new Set([
  "/api/settings/admin",
  "/api/admin/payment-methods",
  "/api/admin/shortcuts",
]);
const benignNavigationAbortPaths = new Set([
  "/",
  "/login",
  "/help",
  "/admin",
  "/admin/extraction-reconciliation",
  "/api/announcements/inbox",
]);
const viewport = { width: 1440, height: 900 };
const screenshotTabs = new Set(["users", "workspace-models", "white-label", "super-admin"]);
const screenshotViews = new Set(["overview", "evidence"]);

function argumentValue(prefix) {
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function sanitizeRunId(value) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function redact(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{80,}/gu, "[redacted-long-token]")
    .slice(0, 800);
}

function safeNetworkUrl(value) {
  try {
    const url = new URL(value);
    const safeParameters = new URLSearchParams();
    for (const key of ["tab", "view", "hours", "refresh", "limit", "offset", "page", "pageSize", "category", "kind", "includeTotal"]) {
      if (url.searchParams.has(key)) safeParameters.set(key, redact(url.searchParams.get(key)));
    }
    const query = safeParameters.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return redact(value);
  }
}

function isBenignNavigationAbort(entry) {
  if (
    entry.sameOrigin !== true
    || entry.method !== "GET"
    || entry.error !== "net::ERR_ABORTED"
  ) return false;
  try {
    const pathname = new URL(entry.url, origin).pathname;
    if (entry.resourceType === "fetch") return benignNavigationAbortPaths.has(pathname);
    return entry.resourceType === "image" && /^\/api\/branding\/assets\/[0-9a-f-]+$/iu.test(pathname);
  } catch {
    return false;
  }
}

function uniqueEntries(entries, key) {
  const seen = new Set();
  return entries.filter((entry) => {
    const identity = key(entry);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function readRuntimeIdentity(stage) {
  const root = process.cwd();
  const [publicVersionText, diskBuildIdText, fingerprintReceiptText] = await Promise.all([
    fs.readFile(path.join(root, "public", "version.json"), "utf8"),
    fs.readFile(path.join(root, ".next", "BUILD_ID"), "utf8"),
    fs.readFile(path.join(root, ".next", "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  const publicVersion = JSON.parse(publicVersionText);
  const diskBuildId = diskBuildIdText.trim();
  const fingerprintReceipt = JSON.parse(fingerprintReceiptText);
  const currentSourceFingerprint = computeLocalBuildFingerprint(root);
  const response = await fetch(`${origin}/api/version`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const runtimeVersion = await response.json().catch(() => ({}));
  const identity = {
    stage,
    checkedAt: new Date().toISOString(),
    files: {
      publicVersion: "public/version.json",
      diskBuildId: ".next/BUILD_ID",
      fingerprintReceipt: ".next/local-source-fingerprint.v1.json",
    },
    publicVersion: {
      schemaVersion: publicVersion?.schemaVersion ?? null,
      sourceVersion: publicVersion?.sourceVersion || publicVersion?.version || null,
      sourceDigest: publicVersion?.sourceDigest || null,
    },
    diskBuildId,
    fingerprintReceipt: {
      schemaVersion: fingerprintReceipt?.schemaVersion ?? null,
      kind: fingerprintReceipt?.kind || null,
      buildId: fingerprintReceipt?.buildId || null,
      fingerprint: fingerprintReceipt?.fingerprint || null,
      fileCount: fingerprintReceipt?.fileCount ?? null,
      capturedAt: fingerprintReceipt?.capturedAt || null,
    },
    currentSourceFingerprint,
    runtimeVersion: {
      status: response.status,
      sourceVersion: runtimeVersion?.sourceVersion || runtimeVersion?.version || null,
      buildId: runtimeVersion?.buildId || runtimeVersion?.build || null,
    },
    runningLatest: false,
  };
  identity.runningLatest = response.ok
    && identity.publicVersion.schemaVersion === 1
    && Boolean(identity.publicVersion.sourceVersion)
    && Boolean(identity.diskBuildId)
    && identity.fingerprintReceipt.schemaVersion === 1
    && identity.fingerprintReceipt.kind === "local-production-preview-source-fingerprint"
    && identity.fingerprintReceipt.buildId === identity.diskBuildId
    && identity.fingerprintReceipt.fingerprint === identity.currentSourceFingerprint.fingerprint
    && identity.fingerprintReceipt.fileCount === identity.currentSourceFingerprint.fileCount
    && identity.runtimeVersion.sourceVersion === identity.publicVersion.sourceVersion
    && identity.runtimeVersion.buildId === identity.diskBuildId;
  return identity;
}

function runtimeIdentityBinding(identity) {
  return {
    publicVersion: identity?.publicVersion || null,
    diskBuildId: identity?.diskBuildId || null,
    fingerprintReceipt: identity?.fingerprintReceipt || null,
    currentSourceFingerprint: identity?.currentSourceFingerprint || null,
    runtimeVersion: identity?.runtimeVersion || null,
    runningLatest: identity?.runningLatest === true,
  };
}

async function pageMetrics(page) {
  await page.waitForFunction(() => document.readyState === "complete", undefined, { timeout: 20_000 }).catch(() => undefined);
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main") || document.body;
    const rootStyle = getComputedStyle(root);
    const mainStyle = getComputedStyle(main);
    const mainRect = main.getBoundingClientRect();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0
        && rect.width > 1
        && rect.height > 1
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < innerHeight
        && rect.left < innerWidth;
    };
    const readable = [...main.querySelectorAll("h1,h2,h3,p,label,button,a,input,select,textarea,td,th,span")]
      .filter((element) => visible(element) && String(element.textContent || element.getAttribute("aria-label") || "").trim())
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          text: String(element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/gu, " ").trim().slice(0, 80),
          fontSize: Number.parseFloat(style.fontSize),
          color: style.color,
          visibility: style.visibility,
          opacity: Number(style.opacity || "1"),
        };
      });
    const unreadable = readable.filter((entry) => !Number.isFinite(entry.fontSize) || entry.fontSize < 8 || entry.visibility !== "visible" || entry.opacity <= 0.05);
    const bodyText = String(main.innerText || "").replace(/\s+/gu, " ").trim();
    return {
      readyState: document.readyState,
      title: document.title,
      mainPresent: Boolean(main),
      mainTextLength: bodyText.length,
      mainTextSample: bodyText.slice(0, 240),
      replacementCharacterCount: (bodyText.match(/\uFFFD/gu) || []).length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
        clientHeight: root.clientHeight,
        scrollHeight: root.scrollHeight,
      },
      main: {
        display: mainStyle.display,
        visibility: mainStyle.visibility,
        opacity: Number(mainStyle.opacity || "1"),
        color: mainStyle.color,
        backgroundColor: mainStyle.backgroundColor,
        fontSize: mainStyle.fontSize,
        lineHeight: mainStyle.lineHeight,
        rect: { left: mainRect.left, top: mainRect.top, width: mainRect.width, height: mainRect.height },
      },
      root: {
        color: rootStyle.color,
        backgroundColor: rootStyle.backgroundColor,
        fontSize: rootStyle.fontSize,
      },
      readability: {
        inspectedVisibleTextElements: readable.length,
        minimumVisibleFontPx: readable.length ? Math.min(...readable.map((entry) => entry.fontSize).filter(Number.isFinite)) : null,
        unreadableCount: unreadable.length,
        unreadableSamples: unreadable.slice(0, 10),
      },
      loadingIndicators: [...main.querySelectorAll('[aria-busy="true"], [role="progressbar"]')]
        .filter(visible)
        .map((element) => element.getAttribute("data-testid") || element.getAttribute("aria-label") || element.tagName.toLowerCase())
        .slice(0, 20),
    };
  });
}

function metricIssues(metrics) {
  const issues = [];
  if (metrics.readyState !== "complete") issues.push(`DOM_READY_STATE_${String(metrics.readyState).toUpperCase()}`);
  if (!metrics.mainPresent || metrics.mainTextLength < 8) issues.push("DOM_MAIN_EMPTY");
  if (metrics.document.horizontalOverflowPx > 1) issues.push(`HORIZONTAL_OVERFLOW_${metrics.document.horizontalOverflowPx}px`);
  if (metrics.main.display === "none" || metrics.main.visibility !== "visible" || metrics.main.opacity <= 0.05) issues.push("MAIN_NOT_VISIBLE");
  if (metrics.replacementCharacterCount > 0) issues.push(`REPLACEMENT_CHARACTERS_${metrics.replacementCharacterCount}`);
  if (metrics.readability.unreadableCount > 0) issues.push(`UNREADABLE_VISIBLE_TEXT_${metrics.readability.unreadableCount}`);
  return issues;
}

async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
  assert.ok(token, "WITH_LOCAL_ADMIN_SESSION_TOKEN_REQUIRED");
  assert.ok(identityText, "WITH_LOCAL_ADMIN_SESSION_IDENTITY_REQUIRED");
  const identity = JSON.parse(identityText);
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  assert.equal(primaryNavigation.length, 14, "ADMIN_PRIMARY_NAVIGATION_EXPECTED_14_MODULES");
  assert.equal(mappedTabs.length, 27, "ADMIN_NAVIGATION_EXPECTED_27_TABS");
  assert.equal(new Set(mappedTabs.map((entry) => entry.tab)).size, 27, "ADMIN_NAVIGATION_DUPLICATE_TAB_MAPPING");
  assert.equal(commandCenterViews.length, 7, "COMMAND_CENTER_EXPECTED_7_VIEWS");

  const runId = sanitizeRunId(argumentValue("--run="));
  const evidenceDir = path.resolve(argumentValue("--output=") || path.join(".codex-evidence", "admin-readonly-sweep-20261003", runId));
  const screenshotDir = path.join(evidenceDir, "screenshots");
  const reportPath = path.join(evidenceDir, "report.json");
  await fs.mkdir(screenshotDir, { recursive: true });

  const report = {
    schemaVersion: 1,
    runId,
    checkedAt: new Date().toISOString(),
    origin,
    viewport,
    authorization: {
      launcher: "scripts/with-local-admin-session.mjs",
      bearerInjectedInMemory: true,
      tokenPersistedToEvidence: false,
      tokenPrinted: false,
      role: identity.user.role,
      expectedUsernameMatchedByLauncher: Boolean(process.env.READONLY_UI_EXPECTED_USERNAME),
    },
    expected: { primaryModules: 14, adminTabs: 27, commandCenterViews: 7, adminHelpPages: 1 },
    runtimeVersion: null,
    runtimeIdentity: {
      before: null,
      after: null,
      unchanged: false,
    },
    navigationContract: null,
    adminTabs: [],
    commandCenterViews: [],
    adminHelp: null,
    screenshots: [],
    blockedDiagnostics: [],
    blockedWrites: [],
    blockedPaidRequests: [],
    blockedExternalRequests: [],
    excludedRequests: [],
    lockedSensitiveReadAttempts: [],
    lockedSensitive428Responses: [],
    lockedSensitiveConsole428: [],
    failedResponses: [],
    pageErrors: [],
    consoleErrors: [],
    networkErrors: [],
    benignNavigationAborts: [],
    issues: [],
    safety: {
      allowedMethods: ["GET", "HEAD"],
      allowedOrigin: origin,
      serviceWorkers: "blocked",
      commerceAndManjuExcluded: true,
      businessWritesAllowed: 0,
      productionWritesAllowed: 0,
      paidSubmissionsAllowed: 0,
      externalRequestsAllowed: 0,
    },
    passed: false,
  };
  const issueKeys = new Set();
  const addIssue = (code, scope, detail = "") => {
    const issue = { code, scope, detail: redact(detail) };
    const key = JSON.stringify(issue);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      report.issues.push(issue);
    }
  };

  try {
    report.runtimeIdentity.before = await readRuntimeIdentity("before-browser-sweep");
    report.runtimeVersion = report.runtimeIdentity.before.runtimeVersion;
    if (!report.runtimeIdentity.before.runningLatest) {
      addIssue("RUNTIME_NOT_LATEST", "preflight", JSON.stringify(runtimeIdentityBinding(report.runtimeIdentity.before)));
    }
  } catch (error) {
    report.runtimeVersion = { error: redact(error?.message || error) };
    addIssue("RUNTIME_IDENTITY_UNAVAILABLE", "preflight", error?.message || error);
  }

  const browser = await chromium.launch({ headless: true });
  const intentionallyBlocked = new WeakSet();
  let authorizationInjectionCount = 0;
  try {
    const context = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      reducedMotion: "reduce",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      let url;
      try {
        url = new URL(request.url());
      } catch {
        await route.continue();
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        await route.continue();
        return;
      }
      const event = { method, url: safeNetworkUrl(url.href), resourceType: request.resourceType() };
      if (url.origin !== origin) {
        intentionallyBlocked.add(request);
        report.blockedExternalRequests.push({ ...event, origin: url.origin });
        await route.abort("blockedbyclient");
        return;
      }
      if (forbiddenPaths.some((pattern) => pattern.test(url.pathname))) {
        intentionallyBlocked.add(request);
        report.excludedRequests.push(event);
        await route.abort("blockedbyclient");
        return;
      }
      if (!["GET", "HEAD"].includes(method)) {
        intentionallyBlocked.add(request);
        const diagnostic = ["/__nextjs_original-stack-frames", "/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname);
        const destination = diagnostic
          ? report.blockedDiagnostics
          : paidOrMutationPaths.some((pattern) => pattern.test(url.pathname))
            ? report.blockedPaidRequests
            : report.blockedWrites;
        destination.push(event);
        await route.abort("blockedbyclient");
        return;
      }
      if (paidOrMutationPaths.some((pattern) => pattern.test(url.pathname))) {
        intentionallyBlocked.add(request);
        report.blockedPaidRequests.push(event);
        await route.abort("blockedbyclient");
        return;
      }
      if (method === "GET" && lockedSensitiveReadPaths.has(url.pathname)) {
        report.lockedSensitiveReadAttempts.push(event);
      }
      authorizationInjectionCount += 1;
      await route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => {
      report.pageErrors.push({ at: new Date().toISOString(), url: safeNetworkUrl(page.url()), message: redact(error?.message || error) });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const event = { at: new Date().toISOString(), url: safeNetworkUrl(page.url()), message: redact(message.text()) };
        report.consoleErrors.push(event);
        if (/\b428\b/u.test(event.message)) report.lockedSensitiveConsole428.push(event);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        const event = { status: response.status(), method: response.request().method(), url: safeNetworkUrl(response.url()) };
        report.failedResponses.push(event);
        const pathname = new URL(response.url()).pathname;
        if (response.status() === 428 && lockedSensitiveReadPaths.has(pathname)) {
          report.lockedSensitive428Responses.push(event);
        }
      }
    });
    page.on("requestfailed", (request) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(request.url()).origin === origin;
      } catch {
        sameOrigin = false;
      }
      report.networkErrors.push({
        method: request.method(),
        url: safeNetworkUrl(request.url()),
        resourceType: request.resourceType(),
        error: redact(request.failure()?.errorText || "REQUEST_FAILED"),
        blockedByPolicy: intentionallyBlocked.has(request),
        sameOrigin,
      });
    });

    const eventOffsets = () => ({
      failedResponses: report.failedResponses.length,
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      networkErrors: report.networkErrors.length,
      blockedDiagnostics: report.blockedDiagnostics.length,
      blockedWrites: report.blockedWrites.length,
      blockedPaidRequests: report.blockedPaidRequests.length,
      blockedExternalRequests: report.blockedExternalRequests.length,
      excludedRequests: report.excludedRequests.length,
    });
    const eventSlice = (offsets) => Object.fromEntries(Object.entries(offsets).map(([key, offset]) => [key, report[key].slice(offset)]));

    const captureScreenshot = async (name) => {
      const file = path.join(screenshotDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
      report.screenshots.push(path.relative(process.cwd(), file).replace(/\\/gu, "/"));
    };

    const bootstrapOffsets = eventOffsets();
    try {
      const response = await page.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.getByRole("navigation", { name: "管理后台一级导航" }).waitFor({ state: "visible", timeout: 30_000 });
      const nav = page.getByRole("navigation", { name: "管理后台一级导航" });
      const labels = await nav.locator('[data-testid^="admin-primary-nav-"] span.truncate').allTextContents();
      const testIds = await nav.locator('[data-testid^="admin-primary-nav-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
      const expectedLabels = primaryNavigation.map((module) => module.title);
      const expectedTestIds = primaryNavigation.map((module) => `admin-primary-nav-${module.root}`);
      const forbiddenVisible = [];
      for (const label of forbiddenLabels) {
        if (await page.getByRole("button", { name: label, exact: true }).count()) forbiddenVisible.push(label);
      }
      report.navigationContract = {
        requestedUrl: `${origin}/admin?tab=users`,
        finalUrl: page.url(),
        httpStatus: response?.status() || null,
        primaryCount: testIds.length,
        primaryLabels: labels.map((label) => label.trim()),
        primaryTestIds: testIds,
        expectedPrimaryLabels: expectedLabels,
        expectedPrimaryTestIds: expectedTestIds,
        forbiddenVisible,
        events: eventSlice(bootstrapOffsets),
      };
      if (response?.status() !== 200) addIssue("ADMIN_NAVIGATION_HTTP_STATUS", "navigation", String(response?.status() || null));
      if (testIds.length !== 14) addIssue("ADMIN_PRIMARY_NAV_COUNT_MISMATCH", "navigation", `${testIds.length}/14`);
      if (JSON.stringify(testIds) !== JSON.stringify(expectedTestIds)) {
        addIssue("ADMIN_PRIMARY_NAV_IDENTITY_MISMATCH", "navigation", JSON.stringify({ expectedTestIds, actual: testIds }));
      }
      if (JSON.stringify(labels.map((label) => label.trim())) !== JSON.stringify(expectedLabels)) {
        addIssue("ADMIN_PRIMARY_NAV_LABEL_MISMATCH", "navigation", JSON.stringify({ expectedLabels, actual: labels }));
      }
      if (forbiddenVisible.length) addIssue("EXCLUDED_NAV_VISIBLE", "navigation", forbiddenVisible.join(","));
    } catch (error) {
      report.navigationContract = { requestedUrl: `${origin}/admin?tab=users`, error: redact(error?.message || error), events: eventSlice(bootstrapOffsets) };
      addIssue("ADMIN_NAVIGATION_BOOTSTRAP_FAILED", "navigation", error?.message || error);
    }

    for (const definition of mappedTabs) {
      const requestedUrl = `${origin}/admin?tab=${encodeURIComponent(definition.tab)}`;
      const offsets = eventOffsets();
      const result = {
        ...definition,
        requestedUrl,
        startedAt: new Date().toISOString(),
        finalUrl: null,
        httpStatus: null,
        domReady: false,
        metrics: null,
        selectedState: null,
        events: null,
        error: null,
      };
      try {
        const response = await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        result.httpStatus = response?.status() || null;
        await page.waitForURL((url) => url.pathname === "/admin" && url.searchParams.get("tab") === definition.tab, { timeout: 20_000 });
        const nav = page.getByRole("navigation", { name: "管理后台一级导航" });
        await nav.waitFor({ state: "visible", timeout: 20_000 });
        await page.locator("main").waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
        await page.waitForTimeout(350);
        result.finalUrl = page.url();
        result.metrics = await pageMetrics(page);
        result.domReady = result.metrics.readyState === "complete" && result.metrics.mainTextLength >= 8;
        const primary = nav.getByTestId(`admin-primary-nav-${definition.moduleRoot}`);
        const secondary = definition.moduleSize > 1
          ? page.getByTestId(`admin-module-${definition.moduleRoot}`).getByRole("button", { name: new RegExp(`^${definition.label}(?: · 锁定)?$`, "u") })
          : null;
        result.selectedState = {
          primaryCount: await primary.count(),
          primaryAriaCurrent: await primary.getAttribute("aria-current").catch(() => null),
          secondaryCount: secondary ? await secondary.count() : 0,
          secondaryAriaCurrent: secondary ? await secondary.getAttribute("aria-current").catch(() => null) : null,
        };
        if (result.httpStatus !== 200) addIssue("ADMIN_TAB_HTTP_STATUS", definition.tab, String(result.httpStatus));
        if (!result.domReady) addIssue("ADMIN_TAB_DOM_NOT_READY", definition.tab, result.metrics.mainTextSample);
        for (const issue of metricIssues(result.metrics)) addIssue(issue, definition.tab);
        if (result.selectedState.primaryCount !== 1 || result.selectedState.primaryAriaCurrent !== "page") {
          addIssue("ADMIN_PRIMARY_SELECTION_INVALID", definition.tab, JSON.stringify(result.selectedState));
        }
        if (definition.moduleSize > 1 && (result.selectedState.secondaryCount !== 1 || result.selectedState.secondaryAriaCurrent !== "page")) {
          addIssue("ADMIN_SECONDARY_SELECTION_INVALID", definition.tab, JSON.stringify(result.selectedState));
        }
        if (screenshotTabs.has(definition.tab)) await captureScreenshot(`admin-tab-${definition.tab}-1440x900`);
      } catch (error) {
        result.finalUrl = page.url();
        result.error = redact(error?.message || error);
        addIssue("ADMIN_TAB_VISIT_FAILED", definition.tab, error?.message || error);
      } finally {
        result.events = eventSlice(offsets);
        result.finishedAt = new Date().toISOString();
        report.adminTabs.push(result);
      }
    }

    for (const [label, view] of commandCenterViews) {
      const requestedUrl = `${origin}/admin?tab=dashboard&view=${encodeURIComponent(view)}`;
      const offsets = eventOffsets();
      const result = {
        label,
        view,
        requestedUrl,
        startedAt: new Date().toISOString(),
        finalUrl: null,
        httpStatus: null,
        domReady: false,
        metrics: null,
        viewState: null,
        events: null,
        error: null,
      };
      try {
        const response = await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
        result.httpStatus = response?.status() || null;
        await page.waitForURL((url) => url.pathname === "/admin" && url.searchParams.get("tab") === "dashboard" && url.searchParams.get("view") === view, { timeout: 20_000 });
        const surface = page.getByTestId("admin-command-center");
        await surface.waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction((expectedView) => {
          const node = document.querySelector('[data-testid="admin-command-center"]');
          return node?.getAttribute("data-view") === expectedView && node?.getAttribute("aria-busy") === "false";
        }, view, { timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(250);
        result.finalUrl = page.url();
        result.metrics = await pageMetrics(page);
        result.domReady = result.metrics.readyState === "complete" && result.metrics.mainTextLength >= 8;
        const navigation = page.getByTestId("command-center-goal-navigation");
        const button = page.getByTestId(`command-center-view-${view}`);
        result.viewState = {
          navigationCount: await navigation.count(),
          visibleViewCount: await navigation.getByRole("button").count().catch(() => 0),
          selectedAriaCurrent: await button.getAttribute("aria-current").catch(() => null),
          surfaceView: await surface.getAttribute("data-view"),
          ariaBusy: await surface.getAttribute("aria-busy"),
          loadErrorCount: await page.getByTestId("command-center-load-error").count(),
          sectionIds: await page.locator('[data-testid="command-center-sections"] > section[data-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
        };
        if (result.httpStatus !== 200) addIssue("COMMAND_CENTER_HTTP_STATUS", view, String(result.httpStatus));
        if (!result.domReady) addIssue("COMMAND_CENTER_DOM_NOT_READY", view, result.metrics.mainTextSample);
        for (const issue of metricIssues(result.metrics)) addIssue(issue, `dashboard:${view}`);
        if (result.viewState.navigationCount !== 1 || result.viewState.visibleViewCount !== 7) {
          addIssue("COMMAND_CENTER_VIEW_COUNT_MISMATCH", view, JSON.stringify(result.viewState));
        }
        if (result.viewState.selectedAriaCurrent !== "page" || result.viewState.surfaceView !== view) {
          addIssue("COMMAND_CENTER_VIEW_SELECTION_INVALID", view, JSON.stringify(result.viewState));
        }
        if (result.viewState.ariaBusy !== "false" || result.viewState.loadErrorCount !== 0) {
          addIssue("COMMAND_CENTER_NOT_READY", view, JSON.stringify(result.viewState));
        }
        if (screenshotViews.has(view)) await captureScreenshot(`admin-dashboard-${view}-1440x900`);
      } catch (error) {
        result.finalUrl = page.url();
        result.error = redact(error?.message || error);
        addIssue("COMMAND_CENTER_VIEW_VISIT_FAILED", view, error?.message || error);
      } finally {
        result.events = eventSlice(offsets);
        result.finishedAt = new Date().toISOString();
        report.commandCenterViews.push(result);
      }
    }

    const helpOffsets = eventOffsets();
    const helpResult = {
      requestedUrl: `${origin}/admin/help`,
      startedAt: new Date().toISOString(),
      finalUrl: null,
      httpStatus: null,
      domReady: false,
      metrics: null,
      controls: null,
      events: null,
      error: null,
    };
    try {
      const response = await page.goto(helpResult.requestedUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      helpResult.httpStatus = response?.status() || null;
      await page.waitForURL((url) => url.pathname === "/admin/help", { timeout: 20_000 });
      await page.getByText("学习中心管理", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      await page.locator("main").waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(350);
      helpResult.finalUrl = page.url();
      helpResult.metrics = await pageMetrics(page);
      helpResult.domReady = helpResult.metrics.readyState === "complete" && helpResult.metrics.mainTextLength >= 8;
      helpResult.controls = {
        saveButtons: await page.getByRole("button", { name: "保存", exact: true }).count(),
        previewLinks: await page.getByRole("link", { name: "前台预览", exact: true }).count(),
        backLinks: await page.getByRole("link", { name: "后台首页", exact: true }).count(),
      };
      if (helpResult.httpStatus !== 200) addIssue("ADMIN_HELP_HTTP_STATUS", "admin-help", String(helpResult.httpStatus));
      if (!helpResult.domReady) addIssue("ADMIN_HELP_DOM_NOT_READY", "admin-help", helpResult.metrics.mainTextSample);
      for (const issue of metricIssues(helpResult.metrics)) addIssue(issue, "admin-help");
      if (helpResult.controls.saveButtons !== 1 || helpResult.controls.previewLinks !== 1 || helpResult.controls.backLinks !== 1) {
        addIssue("ADMIN_HELP_CONTROLS_MISSING", "admin-help", JSON.stringify(helpResult.controls));
      }
      await captureScreenshot("admin-help-1440x900");
    } catch (error) {
      helpResult.finalUrl = page.url();
      helpResult.error = redact(error?.message || error);
      addIssue("ADMIN_HELP_VISIT_FAILED", "admin-help", error?.message || error);
    } finally {
      helpResult.events = eventSlice(helpOffsets);
      helpResult.finishedAt = new Date().toISOString();
      report.adminHelp = helpResult;
    }

    report.authorization.localRequestsWithBearer = authorizationInjectionCount;
    report.blockedDiagnostics = uniqueEntries(report.blockedDiagnostics, (entry) => `${entry.method} ${entry.url}`);
    report.blockedWrites = uniqueEntries(report.blockedWrites, (entry) => `${entry.method} ${entry.url}`);
    report.blockedPaidRequests = uniqueEntries(report.blockedPaidRequests, (entry) => `${entry.method} ${entry.url}`);
    report.blockedExternalRequests = uniqueEntries(report.blockedExternalRequests, (entry) => `${entry.method} ${entry.origin} ${entry.url}`);
    report.excludedRequests = uniqueEntries(report.excludedRequests, (entry) => `${entry.method} ${entry.url}`);
    report.lockedSensitiveReadAttempts = uniqueEntries(report.lockedSensitiveReadAttempts, (entry) => `${entry.method} ${entry.url}`);
    report.lockedSensitive428Responses = uniqueEntries(report.lockedSensitive428Responses, (entry) => `${entry.status} ${entry.method} ${entry.url}`);
    report.lockedSensitiveConsole428 = uniqueEntries(report.lockedSensitiveConsole428, (entry) => `${entry.url} ${entry.message}`);
    report.failedResponses = uniqueEntries(report.failedResponses, (entry) => `${entry.status} ${entry.method} ${entry.url}`);
    report.pageErrors = uniqueEntries(report.pageErrors, (entry) => `${entry.url} ${entry.message}`);
    report.consoleErrors = uniqueEntries(report.consoleErrors, (entry) => `${entry.url} ${entry.message}`);
    report.networkErrors = uniqueEntries(report.networkErrors, (entry) => `${entry.method} ${entry.url} ${entry.resourceType} ${entry.error} ${entry.blockedByPolicy} ${entry.sameOrigin}`);
    report.benignNavigationAborts = report.networkErrors.filter(isBenignNavigationAbort);

    const unexpectedNetworkErrors = report.networkErrors.filter((entry) => !entry.blockedByPolicy && !isBenignNavigationAbort(entry));
    const unexpectedConsoleErrors = report.consoleErrors.filter((entry) => !/ERR_BLOCKED_BY_CLIENT|Failed to load resource: net::ERR_FAILED/iu.test(entry.message));
    const businessWrites = report.blockedWrites;
    if (report.adminTabs.length !== 27) addIssue("ADMIN_TAB_SWEEP_INCOMPLETE", "summary", `${report.adminTabs.length}/27`);
    if (report.commandCenterViews.length !== 7) addIssue("COMMAND_CENTER_SWEEP_INCOMPLETE", "summary", `${report.commandCenterViews.length}/7`);
    if (!report.adminHelp) addIssue("ADMIN_HELP_SWEEP_INCOMPLETE", "summary");
    if (report.excludedRequests.length) addIssue("EXCLUDED_COMMERCE_OR_MANJU_REQUEST_DETECTED", "network", JSON.stringify(report.excludedRequests));
    if (report.lockedSensitiveReadAttempts.length) addIssue("LOCKED_SENSITIVE_READ_ATTEMPTED", "network", JSON.stringify(report.lockedSensitiveReadAttempts));
    if (report.lockedSensitive428Responses.length) addIssue("LOCKED_SENSITIVE_428_RESPONSE", "network", JSON.stringify(report.lockedSensitive428Responses));
    if (report.lockedSensitiveConsole428.length) addIssue("LOCKED_SENSITIVE_CONSOLE_428", "browser", JSON.stringify(report.lockedSensitiveConsole428));
    if (report.blockedPaidRequests.length) addIssue("PAID_OR_MUTATION_REQUEST_ATTEMPTED", "network", JSON.stringify(report.blockedPaidRequests));
    if (businessWrites.length) addIssue("BUSINESS_WRITE_REQUEST_ATTEMPTED", "network", JSON.stringify(businessWrites));
    if (report.blockedExternalRequests.length) addIssue("ACTIVE_EXTERNAL_REQUEST_ATTEMPTED", "network", JSON.stringify(report.blockedExternalRequests));
    if (report.failedResponses.length) addIssue("HTTP_ERROR_RESPONSES", "network", JSON.stringify(report.failedResponses));
    if (report.pageErrors.length) addIssue("PAGE_ERRORS", "browser", JSON.stringify(report.pageErrors));
    if (unexpectedConsoleErrors.length) addIssue("CONSOLE_ERRORS", "browser", JSON.stringify(unexpectedConsoleErrors));
    if (unexpectedNetworkErrors.length) addIssue("NETWORK_ERRORS", "browser", JSON.stringify(unexpectedNetworkErrors));
  } finally {
    await browser.close();
  }

  try {
    report.runtimeIdentity.after = await readRuntimeIdentity("after-browser-sweep");
    if (!report.runtimeIdentity.after.runningLatest) {
      addIssue("RUNTIME_NOT_LATEST", "postflight", JSON.stringify(runtimeIdentityBinding(report.runtimeIdentity.after)));
    }
    report.runtimeIdentity.unchanged = JSON.stringify(runtimeIdentityBinding(report.runtimeIdentity.before))
      === JSON.stringify(runtimeIdentityBinding(report.runtimeIdentity.after));
    if (!report.runtimeIdentity.unchanged) {
      addIssue("RUNTIME_IDENTITY_DRIFTED", "postflight", JSON.stringify({
        before: runtimeIdentityBinding(report.runtimeIdentity.before),
        after: runtimeIdentityBinding(report.runtimeIdentity.after),
      }));
    }
  } catch (error) {
    addIssue("RUNTIME_IDENTITY_UNAVAILABLE", "postflight", error?.message || error);
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    adminTabsVisited: report.adminTabs.length,
    adminTabsReady: report.adminTabs.filter((entry) => entry.domReady && !entry.error).length,
    commandCenterViewsVisited: report.commandCenterViews.length,
    commandCenterViewsReady: report.commandCenterViews.filter((entry) => entry.domReady && !entry.error && entry.viewState?.ariaBusy === "false").length,
    adminHelpReady: Boolean(report.adminHelp?.domReady && !report.adminHelp?.error),
    screenshots: report.screenshots.length,
    blockedDiagnosticAttempts: report.blockedDiagnostics.length,
    blockedWriteAttempts: report.blockedWrites.length,
    blockedPaidAttempts: report.blockedPaidRequests.length,
    blockedExternalAttempts: report.blockedExternalRequests.length,
    excludedFeatureAttempts: report.excludedRequests.length,
    lockedSensitiveReadAttempts: report.lockedSensitiveReadAttempts.length,
    lockedSensitive428Responses: report.lockedSensitive428Responses.length,
    lockedSensitiveConsole428: report.lockedSensitiveConsole428.length,
    failedResponses: report.failedResponses.length,
    pageErrors: report.pageErrors.length,
    consoleErrors: report.consoleErrors.length,
    networkErrors: report.networkErrors.length,
    benignNavigationAborts: report.benignNavigationAborts.length,
    unexpectedNetworkErrors: report.networkErrors.filter((entry) => !entry.blockedByPolicy && !isBenignNavigationAbort(entry)).length,
    runningLatestBefore: report.runtimeIdentity.before?.runningLatest === true,
    runningLatestAfter: report.runtimeIdentity.after?.runningLatest === true,
    runtimeIdentityUnchanged: report.runtimeIdentity.unchanged,
    issueCount: report.issues.length,
  };
  report.passed = report.issues.length === 0;
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: report.passed, reportPath, summary: report.summary, issues: report.issues }, null, 2)}\n`);
  assert.equal(report.passed, true, `ADMIN_READONLY_SWEEP_FAILED:${report.issues.map((issue) => `${issue.code}@${issue.scope}`).join(",")}`);
}

export { main };

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
