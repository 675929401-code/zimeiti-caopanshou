#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodeJwt } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";
import { ADMIN_THEME_OPTIONS } from "../src/lib/themes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const marker = crypto.randomBytes(5).toString("hex");
const evidenceDir = path.join(root, ".codex-evidence", "admin-settings-save-live", runId);
const reportPath = path.join(evidenceDir, "report.json");
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const SETTINGS_GET_BUDGET_WINDOW_MS = 60_000;
const SETTINGS_GET_BUDGET_LIMIT = 160;
const SETTINGS_GET_COLD_START_MS = SETTINGS_GET_BUDGET_WINDOW_MS + 250;
const SETTINGS_NAVIGATION_TIMEOUT_MS = 180_000;
const SETTINGS_GET_QUIET_WINDOW_MS = 750;

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");
const databaseIdentity = new URL(databaseUrl);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(databaseIdentity.hostname), "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(databaseIdentity.pathname.replace(/^\//u, ""), "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const actorId = String(decodeJwt(token).userId || "");
assert.ok(actorId, "LOCAL_ADMIN_ACTOR_REQUIRED");

const CASES = Object.freeze([
  { id: "global-system-prefix", scope: "prompts", keys: ["global_system_prefix"], tab: "general" },
  { id: "auto-avatar-model", scope: "models", keys: ["auto_avatar_model_id"], tab: "general" },
  { id: "platform-theme", scope: "brand", keys: ["theme", "theme_mode"], tab: "theme" },
  { id: "coze-non-secret", scope: "integrations", keys: ["coze_api_base_url", "coze_workspace_id"], tab: "connection" },
  { id: "smtp-non-secret", scope: "integrations", keys: ["email_smtp_host", "email_smtp_port", "email_smtp_user", "email_from"], tab: "connection" },
  { id: "page-card-layout", scope: "brand", keys: ["page_layout", "card_layout"], tab: "layout" },
  { id: "cover-workflow-app", scope: "models", keys: ["cover_workflow_api_url", "cover_workflow_app_id"], tab: "models" },
  { id: "credits-per-yuan", scope: "payment", keys: ["credits_per_yuan"], tab: "credits" },
]);
const ALL_KEYS = [...new Set(CASES.flatMap((item) => item.keys))].sort();
const SECRET_KEYS = new Set(["coze_api_token", "email_smtp_pass", "cover_workflow_token"]);
const REQUIRED_PERMISSIONS = [
  "brand.settings.manage",
  "integrations.manage",
  "models.manage",
  "payment.settings.manage",
  "prompts.view",
  "prompts.edit",
  "agents.manage",
];
const TAB_HEADINGS = Object.freeze({
  general: "品牌与联系设置",
  theme: "主题风格",
  connection: "模型与外部服务",
  layout: "布局编辑器",
  models: "封面工作流连接",
  credits: "积分充值",
});
const TAB_SCOPES = Object.freeze({
  general: "prompts",
  theme: "brand",
  connection: "integrations",
  layout: "brand",
  models: "models",
  credits: "payment",
});
const TAB_NAVIGATION = Object.freeze({
  general: { root: "general", label: "品牌与联系" },
  theme: { root: "general", label: "界面设置" },
  connection: { root: "models", label: "外部服务" },
  layout: { root: "general", label: "卡片布局" },
  models: { root: "models", label: "模型资源池" },
  credits: { root: "credits", label: "资金与计费" },
});
const THEME_NAMES = Object.freeze(Object.fromEntries(ADMIN_THEME_OPTIONS.map(({ id, name }) => [id, name])));
const THEME_MODES = Object.freeze({ lattice: "dark", "soft-white": "light", "crystal-aurora": "dark" });

const report = {
  schemaVersion: 1,
  task: "ADMIN-SAVE-01",
  passed: false,
  runId,
  checkedAt: null,
  origin,
  runtime: {},
  database: { local: true, database: databaseIdentity.pathname.replace(/^\//u, ""), settingsRowsRequired: ALL_KEYS.length },
  safety: {
    productionWrites: 0,
    providerCalls: 0,
    paymentCalls: 0,
    mailCalls: 0,
    deployCalls: 0,
    generationCalls: 0,
    secretValuesRecorded: false,
    settingsRestored: false,
    immutableLocalAdminAuditExpected: true,
  },
  cases: [],
  blockedExternalRequests: [],
  blockedExternalAssets: [],
  blockedPassiveWrites: [],
  unexpectedWrites: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  settingsResponses: { total: 0, bySource: { page: 0, node: 0 }, statuses: {}, nonOk: [], failures: [] },
  settingsReadBudget: {
    limit: SETTINGS_GET_BUDGET_LIMIT,
    windowMs: SETTINGS_GET_BUDGET_WINDOW_MS,
    reservations: 0,
    reservationsBySource: { page: 0, node: 0 },
    peakInWindow: 0,
    coldStartMs: SETTINGS_GET_COLD_START_MS,
    coldStartApplied: false,
    waits: 0,
    waitedMs: 0,
    waitEvents: [],
  },
  cleanup: {
    stepUpSessionRemoved: false,
    cases: [],
    settingsWritesStarted: 0,
    settingsWritesFinished: 0,
    settingsWritesFailed: 0,
    pendingSettingsWritesSettled: false,
    finalRowsMatchOriginal: false,
  },
};

const db = new pg.Client({ connectionString: databaseUrl, application_name: "codex-admin-settings-save-live" });
let dbConnected = false;
let browser;
let context;
let page;
let stepUpToken = "";
let stepUpHash = "";
let fatalError = null;
let baselineOriginalRows = null;
const cleanupEntries = new Map();
const pendingAdminSettingsWrites = new Set();
const pendingPageSettingsGets = new Map();
const settledPageSettingsGets = new WeakSet();
const settingsGetBudgetTimestamps = [];
let settingsGetBudgetTail = Promise.resolve();
let settingsGetColdStartComplete = false;
let lastPageSettingsActivityAt = Date.now();

function valueHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function diagnosticFingerprint(value) {
  const text = String(value || "");
  return { length: text.length, sha256: valueHash(text) };
}

function safeRows(rows) {
  return [...rows.values()].sort((left, right) => left.key.localeCompare(right.key)).map((row) => ({
    key: row.key,
    exists: row.exists,
    length: row.value.length,
    sha256: valueHash(row.value),
    updatedAt: row.updatedAt,
  }));
}

function rowsToValues(rows) {
  return Object.fromEntries([...rows.values()].map((row) => [row.key, row.value]));
}

function valuesEqual(rows, expected) {
  return Object.entries(expected).every(([key, value]) => rows.get(key)?.exists === true && rows.get(key)?.value === value);
}

function rowsEqual(left, right, includeUpdatedAt = false) {
  if (left.size !== right.size) return false;
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other || row.exists !== other.exists || row.value !== other.value) return false;
    if (includeUpdatedAt && row.updatedAt !== other.updatedAt) return false;
  }
  return true;
}

async function readDbRows(keys) {
  const result = await db.query(
    "SELECT setting_key, setting_value, updated_at FROM public.platform_settings WHERE setting_key = ANY($1::text[]) ORDER BY setting_key",
    [keys],
  );
  const found = new Map(result.rows.map((row) => [String(row.setting_key), {
    key: String(row.setting_key),
    exists: true,
    value: String(row.setting_value ?? ""),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }]));
  return new Map(keys.map((key) => [key, found.get(key) || { key, exists: false, value: "", updatedAt: null }]));
}

function isSettingsGet(url, method) {
  return method === "GET" && url.origin === origin && url.pathname.startsWith("/api/settings");
}

function responseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || null;
}

function recordSettingsResponse(source, url, status, headers) {
  report.settingsResponses.total += 1;
  report.settingsResponses.bySource[source] += 1;
  const statusKey = String(status);
  report.settingsResponses.statuses[statusKey] = (report.settingsResponses.statuses[statusKey] || 0) + 1;
  if (status < 200 || status >= 300) {
    report.settingsResponses.nonOk.push({
      source,
      pathname: url.pathname,
      scope: url.searchParams.get("scope"),
      status,
      retryAfter: responseHeader(headers, "retry-after"),
    });
  }
}

function recordSettingsFailure(source, url, error) {
  report.settingsResponses.failures.push({
    source,
    pathname: url.pathname,
    scope: url.searchParams.get("scope"),
    error: String(error || "SETTINGS_GET_FAILED").slice(0, 200),
  });
}

async function reserveSettingsGetBudget(source, url) {
  let release;
  const previous = settingsGetBudgetTail;
  settingsGetBudgetTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    while (true) {
      const now = Date.now();
      while (settingsGetBudgetTimestamps.length > 0
        && now - settingsGetBudgetTimestamps[0] >= SETTINGS_GET_BUDGET_WINDOW_MS) {
        settingsGetBudgetTimestamps.shift();
      }
      if (settingsGetBudgetTimestamps.length < SETTINGS_GET_BUDGET_LIMIT) {
        settingsGetBudgetTimestamps.push(now);
        report.settingsReadBudget.reservations += 1;
        report.settingsReadBudget.reservationsBySource[source] += 1;
        report.settingsReadBudget.peakInWindow = Math.max(
          report.settingsReadBudget.peakInWindow,
          settingsGetBudgetTimestamps.length,
        );
        return;
      }
      const waitMs = Math.max(100, settingsGetBudgetTimestamps[0] + SETTINGS_GET_BUDGET_WINDOW_MS - now + 100);
      report.settingsReadBudget.waits += 1;
      report.settingsReadBudget.waitedMs += waitMs;
      report.settingsReadBudget.waitEvents.push({
        source,
        pathname: url.pathname,
        scope: url.searchParams.get("scope"),
        waitMs,
        reason: "local-window-budget",
      });
      await sleep(waitMs);
    }
  } finally {
    release();
  }
}

async function settleServerSettingsWindowBeforeBrowser() {
  if (settingsGetColdStartComplete) return;
  report.settingsReadBudget.coldStartApplied = true;
  report.settingsReadBudget.waits += 1;
  report.settingsReadBudget.waitedMs += SETTINGS_GET_COLD_START_MS;
  report.settingsReadBudget.waitEvents.push({
    source: "harness",
    pathname: "/api/settings",
    scope: null,
    waitMs: SETTINGS_GET_COLD_START_MS,
    reason: "server-window-cold-start-before-browser",
  });
  await sleep(SETTINGS_GET_COLD_START_MS);
  settingsGetColdStartComplete = true;
}

async function api(pathname, init = {}, includeStepUp = true) {
  const requestUrl = new URL(pathname, origin);
  const method = String(init.method || "GET").toUpperCase();
  if (isSettingsGet(requestUrl, method)) await reserveSettingsGetBudget("node", requestUrl);
  let response;
  try {
    response = await fetch(requestUrl, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(includeStepUp && stepUpToken ? { "x-admin-step-up": stepUpToken } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (isSettingsGet(requestUrl, method)) recordSettingsFailure("node", requestUrl, error?.message || error);
    throw error;
  }
  if (isSettingsGet(requestUrl, method)) recordSettingsResponse("node", requestUrl, response.status, response.headers);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function requireApiOk(result, code) {
  assert.equal(result.response.ok, true, `${code}:HTTP_${result.response.status}:${String(result.body?.code || "UNKNOWN")}`);
  return result.body;
}

async function readApiScope(scope, keys) {
  const body = requireApiOk(await api(`/api/settings/admin?scope=${encodeURIComponent(scope)}`), `${scope}:API_READ`);
  const values = body?.settings || {};
  for (const key of keys) assert.equal(typeof values[key], "string", `${scope}:${key}:API_VALUE_REQUIRED`);
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

function assertReceipt(body, expectedKeys, label) {
  assert.equal(body?.success, true, `${label}:SUCCESS_RECEIPT_REQUIRED`);
  assert.equal(body?.verification, "database-readback", `${label}:DATABASE_READBACK_RECEIPT_REQUIRED`);
  const verified = new Set(Array.isArray(body?.verifiedKeys) ? body.verifiedKeys : []);
  for (const key of expectedKeys) assert.equal(verified.has(key), true, `${label}:${key}:VERIFIED_KEY_REQUIRED`);
  return {
    success: true,
    verification: body.verification,
    verifiedKeys: [...verified].sort(),
    changedKeys: Array.isArray(body.changedKeys) ? [...body.changedKeys].sort() : [],
  };
}

async function postSettings(scope, values, label) {
  assert.equal(Object.keys(values).some((key) => SECRET_KEYS.has(key)), false, `${label}:SECRET_RESTORE_FORBIDDEN`);
  const result = await api(`/api/settings/admin?scope=${encodeURIComponent(scope)}`, {
    method: "POST",
    headers: { "Idempotency-Key": `admin-save-live-${runId}-${crypto.randomUUID()}` },
    body: JSON.stringify(values),
  });
  requireApiOk(result, `${label}:POST`);
  return assertReceipt(result.body, Object.keys(values), label);
}

async function verifyRunningLatest() {
  const [receiptText, diskBuildId, manifestText, versionResponse] = await Promise.all([
    fs.readFile(path.join(root, ".next", "local-source-fingerprint.v1.json"), "utf8"),
    fs.readFile(path.join(root, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    fs.readFile(path.join(root, "public", "version.json"), "utf8"),
    fetch(`${origin}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const receipt = JSON.parse(receiptText);
  const manifest = JSON.parse(manifestText);
  const version = await versionResponse.json();
  const fingerprint = computeLocalBuildFingerprint(root);
  const servedBuildId = String(version.buildId || version.version || "");
  const runningLatest = receipt.fingerprint === fingerprint.fingerprint
    && receipt.fileCount === fingerprint.fileCount
    && receipt.buildId === diskBuildId
    && servedBuildId === diskBuildId
    && version.sourceVersion === manifest.sourceVersion;
  assert.equal(runningLatest, true, "RUNNING_LATEST_REQUIRED");
  return {
    sourceVersion: version.sourceVersion,
    diskBuildId,
    servedBuildId,
    sourceFingerprint: fingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    runningLatest,
  };
}

async function createStepUpSession() {
  const self = requireApiOk(await api("/api/admin/access-control/self", {}, false), "ADMIN_SELF");
  assert.equal(self.access?.adminLevel, "super_admin", "LOCAL_SUPER_ADMIN_REQUIRED");
  const permissions = Array.isArray(self.access?.permissionKeys) ? self.access.permissionKeys : [];
  for (const permission of REQUIRED_PERMISSIONS) assert.equal(permissions.includes(permission), true, `${permission}:PERMISSION_REQUIRED`);
  stepUpToken = crypto.randomBytes(32).toString("base64url");
  stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,$6)`,
      [actorId, stepUpHash, JSON.stringify(permissions), self.access.revision, "Codex-Admin-Save-Live/1.0", new Date(Date.now() + 15 * 60_000).toISOString()],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function removeStepUpSession() {
  if (!dbConnected || !stepUpHash) return false;
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1 AND token_hash=$2", [actorId, stepUpHash]);
    await db.query("COMMIT");
    const remaining = await db.query("SELECT count(*)::integer AS count FROM public.admin_step_up_sessions WHERE actor_id=$1 AND token_hash=$2", [actorId, stepUpHash]);
    return remaining.rows[0]?.count === 0;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function installDiagnostics(targetPage) {
  targetPage.on("pageerror", (error) => report.pageErrors.push(diagnosticFingerprint(error?.message || error)));
  targetPage.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/ERR_BLOCKED_BY_CLIENT|fonts\.(?:gstatic|googleapis)/iu.test(text)) return;
    report.consoleErrors.push(diagnosticFingerprint(text));
  });
  targetPage.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() < 500) return;
    if (url.origin === origin) report.serverErrors.push({ method: response.request().method(), pathname: url.pathname, status: response.status() });
  });
  targetPage.on("request", (request) => {
    const url = new URL(request.url());
    if (!isSettingsGet(url, request.method())) return;
    pendingPageSettingsGets.set(request, {
      pathname: url.pathname,
      scope: url.searchParams.get("scope"),
      startedAt: Date.now(),
    });
    lastPageSettingsActivityAt = Date.now();
  });
  targetPage.on("requestfinished", async (request) => {
    const url = new URL(request.url());
    if (!isSettingsGet(url, request.method())) return;
    pendingPageSettingsGets.delete(request);
    lastPageSettingsActivityAt = Date.now();
    if (settledPageSettingsGets.has(request)) return;
    settledPageSettingsGets.add(request);
    const response = await request.response();
    if (response) {
      recordSettingsResponse("page", url, response.status(), response.headers());
    } else {
      recordSettingsFailure("page", url, "SETTINGS_GET_RESPONSE_MISSING");
    }
    lastPageSettingsActivityAt = Date.now();
  });
  targetPage.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (isSettingsGet(url, request.method())) {
      pendingPageSettingsGets.delete(request);
      lastPageSettingsActivityAt = Date.now();
      if (settledPageSettingsGets.has(request)) return;
      settledPageSettingsGets.add(request);
      recordSettingsFailure("page", url, request.failure()?.errorText || "SETTINGS_GET_REQUEST_FAILED");
      lastPageSettingsActivityAt = Date.now();
    }
  });
}

async function waitForPendingPageSettingsGets(timeoutMs = 30_000) {
  const startedAt = Date.now();
  let quietSince = null;
  let observedActivityAt = lastPageSettingsActivityAt;
  while (Date.now() - startedAt <= timeoutMs) {
    const now = Date.now();
    if (lastPageSettingsActivityAt !== observedActivityAt) {
      observedActivityAt = lastPageSettingsActivityAt;
      quietSince = null;
    }
    const pageFailures = report.settingsResponses.failures.filter((item) => item.source === "page").length;
    const accounted = report.settingsResponses.bySource.page + pageFailures;
    const reservations = report.settingsReadBudget.reservationsBySource.page;
    if (pendingPageSettingsGets.size === 0 && accounted === reservations) {
      quietSince ??= now;
      if (now - quietSince >= SETTINGS_GET_QUIET_WINDOW_MS) {
        return {
          settled: true,
          pending: 0,
          accounted,
          reservations,
          quietWindowMs: SETTINGS_GET_QUIET_WINDOW_MS,
          waitedMs: now - startedAt,
        };
      }
    } else {
      quietSince = null;
    }
    await sleep(100);
  }
  const now = Date.now();
  const pageFailures = report.settingsResponses.failures.filter((item) => item.source === "page").length;
  return {
    settled: false,
    pending: pendingPageSettingsGets.size,
    pendingRequests: [...pendingPageSettingsGets.values()].map((item) => ({
      pathname: item.pathname,
      scope: item.scope,
      ageMs: now - item.startedAt,
    })),
    accounted: report.settingsResponses.bySource.page + pageFailures,
    reservations: report.settingsReadBudget.reservationsBySource.page,
    quietWindowMs: SETTINGS_GET_QUIET_WINDOW_MS,
    waitedMs: now - startedAt,
  };
}

async function waitForSettingsGetSettlement(timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const accounted = report.settingsResponses.total + report.settingsResponses.failures.length;
    if (accounted === report.settingsReadBudget.reservations) {
      return { settled: true, waitedMs: Date.now() - startedAt, accounted };
    }
    await sleep(100);
  }
  return {
    settled: false,
    waitedMs: Date.now() - startedAt,
    accounted: report.settingsResponses.total + report.settingsResponses.failures.length,
    reservations: report.settingsReadBudget.reservations,
  };
}

function isAdminSettingsWrite(request) {
  try {
    const url = new URL(request.url());
    return url.origin === origin && url.pathname === "/api/settings/admin" && request.method() === "POST";
  } catch {
    return false;
  }
}

async function waitForPendingAdminSettingsWrites(timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (pendingAdminSettingsWrites.size > 0 && Date.now() - startedAt <= timeoutMs) await sleep(100);
  return {
    settled: pendingAdminSettingsWrites.size === 0,
    pending: pendingAdminSettingsWrites.size,
    waitedMs: Date.now() - startedAt,
  };
}

async function launchBrowser(identity) {
  try {
    await fs.access(bundledChromium);
    browser = await chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUpToken },
  });
  await context.addCookies([
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Strict" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await context.addInitScript(({ authToken, authUser }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    sessionStorage.setItem("entered_app", "1");
  }, { authToken: token, authUser: identity });
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { await route.continue(); return; }
    if (!["http:", "https:"].includes(url.protocol)) { await route.continue(); return; }
    if (url.origin !== origin) {
      const entry = { method: request.method(), resourceType: request.resourceType(), origin: url.origin, pathname: url.pathname };
      if (["GET", "HEAD"].includes(request.method()) && ["image", "font", "stylesheet"].includes(request.resourceType())) {
        report.blockedExternalAssets.push(entry);
      } else {
        report.blockedExternalRequests.push(entry);
      }
      await route.abort("blockedbyclient");
      return;
    }
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      if (isSettingsGet(url, request.method())) await reserveSettingsGetBudget("page", url);
      await route.continue();
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/settings/admin") { await route.continue(); return; }
    if (request.method() === "POST" && url.pathname === "/api/announcements/events") {
      report.blockedPassiveWrites.push({ method: request.method(), pathname: url.pathname });
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const entry = { method: request.method(), pathname: url.pathname };
    report.unexpectedWrites.push(entry);
    if (/deploy|generate|payment|mail|smtp|provider|test-connection/iu.test(url.pathname)) {
      if (/deploy/iu.test(url.pathname)) report.safety.deployCalls += 1;
      if (/generate/iu.test(url.pathname)) report.safety.generationCalls += 1;
      if (/payment/iu.test(url.pathname)) report.safety.paymentCalls += 1;
      if (/mail|smtp/iu.test(url.pathname)) report.safety.mailCalls += 1;
      if (/provider|test-connection/iu.test(url.pathname)) report.safety.providerCalls += 1;
    }
    await route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  installDiagnostics(page);
  page.on("request", (request) => {
    if (!isAdminSettingsWrite(request)) return;
    pendingAdminSettingsWrites.add(request);
    report.cleanup.settingsWritesStarted += 1;
  });
  page.on("requestfinished", (request) => {
    if (!pendingAdminSettingsWrites.delete(request)) return;
    report.cleanup.settingsWritesFinished += 1;
  });
  page.on("requestfailed", (request) => {
    if (!pendingAdminSettingsWrites.delete(request)) return;
    report.cleanup.settingsWritesFailed += 1;
  });
}

async function openTab(tab, reload = false) {
  const priorSettingsReads = await waitForPendingPageSettingsGets();
  assert.equal(
    priorSettingsReads.settled,
    true,
    `${tab}:PRIOR_SETTINGS_READS_MUST_SETTLE:${JSON.stringify(priorSettingsReads)}`,
  );
  const scope = TAB_SCOPES[tab];
  const navigation = TAB_NAVIGATION[tab];
  assert.ok(navigation, `${tab}:TAB_NAVIGATION_REQUIRED`);
  const currentUrl = page.url().startsWith(origin) ? new URL(page.url()) : null;
  const fullDocumentNavigation = !currentUrl || currentUrl.pathname !== "/admin" || reload;
  if (fullDocumentNavigation) {
    const settingsResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === "/api/settings/admin"
        && url.searchParams.get("scope") === scope;
    }, { timeout: SETTINGS_NAVIGATION_TIMEOUT_MS });
    let documentResponse;
    if (reload && currentUrl?.searchParams.get("tab") === tab) {
      documentResponse = await page.reload({ waitUntil: "domcontentloaded", timeout: SETTINGS_NAVIGATION_TIMEOUT_MS });
    } else {
      documentResponse = await page.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: SETTINGS_NAVIGATION_TIMEOUT_MS });
    }
    assert.equal(documentResponse?.status(), 200, `${tab}:ADMIN_HTTP_200_REQUIRED`);
    const settingsResponse = await settingsResponsePromise;
    assert.equal(settingsResponse.ok(), true, `${tab}:${scope}:SETTINGS_READ_REQUIRED:HTTP_${settingsResponse.status()}`);
  } else {
    const currentTab = currentUrl.searchParams.get("tab");
    const currentNavigation = currentTab ? TAB_NAVIGATION[currentTab] : null;
    if (currentTab !== tab) {
      if (currentNavigation?.root !== navigation.root || tab === navigation.root) {
        await page.locator(`[data-testid="admin-primary-nav-${navigation.root}"]`).click();
        await page.waitForURL((url) => url.pathname === "/admin" && url.searchParams.get("tab") === navigation.root, { timeout: 30_000 });
      }
      if (tab !== navigation.root) {
        const moduleNavigation = page.locator(`[data-testid="admin-module-${navigation.root}"]`);
        await moduleNavigation.getByRole("button", { name: navigation.label, exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/admin" && url.searchParams.get("tab") === tab, { timeout: 30_000 });
      }
    }
    const settingsRead = await api(`/api/settings/admin?scope=${encodeURIComponent(scope)}`);
    assert.equal(settingsRead.response.ok, true, `${tab}:${scope}:SETTINGS_READ_REQUIRED:HTTP_${settingsRead.response.status}`);
  }
  await page.getByRole("heading", { name: TAB_HEADINGS[tab], exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  const currentSettingsReads = await waitForPendingPageSettingsGets();
  assert.equal(
    currentSettingsReads.settled,
    true,
    `${tab}:CURRENT_SETTINGS_READS_MUST_SETTLE:${JSON.stringify(currentSettingsReads)}`,
  );
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  }));
  assert.deepEqual(dimensions, { width: 1440, height: 900, overflow: 0 }, `${tab}:DESKTOP_LAYOUT_REQUIRED`);
}

async function waitForInputValue(locator, expected, label) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await locator.inputValue() === String(expected)) return;
    await page.waitForTimeout(100);
  }
  assert.equal(await locator.inputValue(), String(expected), label);
}

async function selectExactOption(locator, expected, label) {
  const value = String(expected);
  const options = await locator.locator("option").evaluateAll((nodes) => nodes.map((node, index) => ({
    index,
    value: node.value,
    disabled: node.disabled,
  })));
  const option = options.find((item) => item.value === value);
  assert.ok(option, `${label}:OPTION_NOT_PRESENT`);
  assert.equal(option.disabled, false, `${label}:OPTION_DISABLED`);
  await locator.selectOption({ index: option.index });
  assert.equal(await locator.inputValue(), value, `${label}:SELECT_READBACK_MISMATCH`);
}

function dirtyBadge() {
  return page.getByText(/^\d+ 项未保存$/u);
}

async function assertDirty(expected, label) {
  if (expected) {
    await dirtyBadge().waitFor({ state: "visible", timeout: 10_000 });
  } else {
    await dirtyBadge().waitFor({ state: "hidden", timeout: 10_000 }).catch(async () => {
      assert.equal(await dirtyBadge().count(), 0, `${label}:DIRTY_BADGE_MUST_CLEAR`);
    });
  }
}

async function saveThroughUi(scope, expectedKeys, click, label) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST"
      && url.pathname === "/api/settings/admin"
      && url.searchParams.get("scope") === scope;
  }, { timeout: 30_000 });
  await click();
  const response = await responsePromise;
  const requestPayload = response.request().postDataJSON();
  for (const secretKey of SECRET_KEYS) {
    if (!(secretKey in requestPayload)) continue;
    assert.match(String(requestPayload[secretKey] || ""), /^(?:|\*{3,}|•{3,}|已配置|configured)$/iu, `${label}:${secretKey}:SECRET_VALUE_FORBIDDEN`);
  }
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok(), true, `${label}:UI_POST_HTTP_${response.status()}`);
  const receipt = assertReceipt(body, expectedKeys, label);
  await assertDirty(false, label);
  return {
    receipt,
    requestValues: Object.fromEntries(Object.entries(requestPayload).filter(([key]) => !SECRET_KEYS.has(key))),
  };
}

async function verifyPersisted(definition, expectedValues, label) {
  const dbRows = await readDbRows(definition.keys);
  assert.equal(valuesEqual(dbRows, expectedValues), true, `${label}:DATABASE_READBACK_MISMATCH`);
  const apiValues = await readApiScope(definition.scope, definition.keys);
  assert.deepEqual(apiValues, expectedValues, `${label}:API_READBACK_MISMATCH`);
  return dbRows;
}

async function assertConcurrencyStable(definition, confirmedRows, label) {
  const current = await readDbRows(definition.keys);
  assert.equal(rowsEqual(current, confirmedRows, true), true, `${label}:CONCURRENCY_DRIFT_BEFORE_RESTORE`);
}

function caseDefinition(id) {
  const definition = CASES.find((item) => item.id === id);
  assert.ok(definition, `${id}:CASE_DEFINITION_REQUIRED`);
  return definition;
}

async function preflightPlans(originalRows) {
  const original = rowsToValues(originalRows);
  const plans = {};

  await openTab("general");
  await assertDirty(false, "preflight-general");
  const prefixInput = page.locator('textarea[placeholder^="例如："]');
  await waitForInputValue(prefixInput, original.global_system_prefix, "PREFIX_UI_DB_MISMATCH");
  const prefixMarker = `[ADMIN-SAVE-01:${marker}]`;
  assert.ok(original.global_system_prefix.length + prefixMarker.length + 1 <= 64 * 1024, "PREFIX_NO_SAFE_MUTATION_SPACE");
  plans["global-system-prefix"] = { target: original.global_system_prefix ? `${original.global_system_prefix}\n${prefixMarker}` : prefixMarker };

  const avatarSelect = page.getByText("头像生图模型", { exact: true }).locator("xpath=following-sibling::select");
  await waitForInputValue(avatarSelect, original.auto_avatar_model_id, "AVATAR_MODEL_UI_DB_MISMATCH");
  const avatarOptions = await avatarSelect.locator("option").evaluateAll((options) => options.map((option) => ({
    value: option.value,
    disabled: option.disabled,
  })));
  const avatarTarget = original.auto_avatar_model_id
    ? ""
    : avatarOptions.find((option) => !option.disabled && option.value && option.value !== original.auto_avatar_model_id)?.value;
  assert.ok(typeof avatarTarget === "string" && avatarTarget !== original.auto_avatar_model_id, "AVATAR_MODEL_SAFE_ALTERNATE_REQUIRED");
  plans["auto-avatar-model"] = {
    target: avatarTarget,
    restoreUi: avatarOptions.some((option) => !option.disabled && option.value === original.auto_avatar_model_id),
  };

  await openTab("theme");
  await assertDirty(false, "preflight-theme");
  const themeTarget = Object.keys(THEME_NAMES).find((value) => value !== original.theme);
  assert.ok(themeTarget && THEME_NAMES[original.theme], "THEME_SAFE_ALTERNATE_REQUIRED");
  assert.equal(original.theme_mode, THEME_MODES[original.theme], "THEME_MODE_BASELINE_INVALID");
  await page.locator('button[aria-pressed="true"]').filter({ hasText: THEME_NAMES[original.theme] }).waitFor({ state: "visible" });
  plans["platform-theme"] = { target: themeTarget, mode: THEME_MODES[themeTarget] };

  await openTab("connection");
  await assertDirty(false, "preflight-connection");
  const cozeInput = page.locator('input[placeholder="不填则自动搜索所有空间的智能体"]');
  const smtpInput = page.locator('input[placeholder^="如："]');
  await waitForInputValue(cozeInput, original.coze_workspace_id, "COZE_UI_DB_MISMATCH");
  await waitForInputValue(smtpInput, original.email_from, "SMTP_UI_DB_MISMATCH");
  plans["coze-non-secret"] = { target: `admin-save-01-${marker}` };
  plans["smtp-non-secret"] = { target: `ADMIN-SAVE-01 ${marker}` };

  await openTab("layout");
  await assertDirty(false, "preflight-layout");
  const layoutInput = page.getByText("每行列数", { exact: true }).locator('xpath=following-sibling::input[@type="number"]');
  await layoutInput.waitFor({ state: "visible" });
  const layoutColumns = Number(await layoutInput.inputValue());
  assert.ok(Number.isInteger(layoutColumns) && layoutColumns >= 1 && layoutColumns <= 8, "LAYOUT_COLUMNS_BASELINE_INVALID");
  plans["page-card-layout"] = { target: layoutColumns === 8 ? 7 : layoutColumns + 1, originalColumns: layoutColumns };

  await openTab("models");
  await assertDirty(false, "preflight-models");
  const coverInput = page.locator('input[placeholder="应用 ID"]');
  await waitForInputValue(coverInput, original.cover_workflow_app_id, "COVER_APP_UI_DB_MISMATCH");
  plans["cover-workflow-app"] = { target: `admin-save-01-${marker}` };

  await openTab("credits");
  await assertDirty(false, "preflight-credits");
  const creditsInput = page.getByText("每元积分数：", { exact: true }).locator('xpath=following-sibling::input[@type="number"]');
  await waitForInputValue(creditsInput, original.credits_per_yuan, "CREDITS_UI_DB_MISMATCH");
  plans["credits-per-yuan"] = { target: original.credits_per_yuan === "51" ? "52" : "51" };

  return plans;
}

async function prepareCase(definition, originalRows, expectedValues) {
  const current = await readDbRows(definition.keys);
  const originals = new Map(definition.keys.map((key) => [key, originalRows.get(key)]));
  assert.equal(rowsEqual(current, originals, false), true, `${definition.id}:BASELINE_DRIFT_BEFORE_MUTATION`);
  cleanupEntries.set(definition.id, { definition, originals, expectedValues, confirmedRows: null });
}

async function finishCase(definition, originals, changedRows, receipt, restoreReceipt, restoreMode, screenshot) {
  const restoredRows = await verifyPersisted(definition, rowsToValues(originals), `${definition.id}:RESTORE`);
  assert.equal(rowsEqual(restoredRows, originals, false), true, `${definition.id}:RESTORE_DATABASE_MISMATCH`);
  cleanupEntries.delete(definition.id);
  report.cases.push({
    id: definition.id,
    scope: definition.scope,
    keys: definition.keys,
    dirtyBeforeSave: true,
    dirtyClearedAfterSave: true,
    databaseReadback: true,
    apiReadback: true,
    fullRefreshReadback: true,
    concurrencyDriftCheckedBeforeRestore: true,
    restoreMode,
    restoreReadback: true,
    receipt,
    restoreReceipt,
    original: safeRows(originals),
    changed: safeRows(changedRows),
    restored: safeRows(restoredRows),
    screenshot,
  });
}

async function executeTextCase({ definition, input, target, expectedKeys, saveButton, originalRows, verifyUi, waitOriginalUi, restoreUi = true }) {
  const originals = new Map(definition.keys.map((key) => [key, originalRows.get(key)]));
  await openTab(definition.tab);
  await waitOriginalUi();
  await assertDirty(false, `${definition.id}:INITIAL`);
  const expectedValues = { ...rowsToValues(originals), [definition.keys.at(-1)]: target };
  await prepareCase(definition, originalRows, expectedValues);
  const targetInput = input();
  if (await targetInput.evaluate((element) => element.tagName === "SELECT")) {
    await selectExactOption(targetInput, target, `${definition.id}:TARGET`);
  }
  else await targetInput.fill(String(target));
  await assertDirty(true, `${definition.id}:DIRTY`);
  const dirtyScreenshot = path.join(evidenceDir, `${definition.id}-dirty.png`);
  await page.screenshot({ path: dirtyScreenshot, fullPage: false });
  const saved = await saveThroughUi(definition.scope, expectedKeys, () => saveButton().click(), `${definition.id}:SAVE`);
  assert.deepEqual(saved.requestValues, expectedValues, `${definition.id}:UI_REQUEST_SCOPE_MISMATCH`);
  const changedRows = await verifyPersisted(definition, expectedValues, `${definition.id}:SAVE`);
  cleanupEntries.get(definition.id).confirmedRows = changedRows;
  await openTab(definition.tab, true);
  await verifyUi(String(target));
  await assertDirty(false, `${definition.id}:REFRESH`);
  await assertConcurrencyStable(definition, changedRows, definition.id);

  let restoreReceipt;
  let restoreMode;
  if (restoreUi) {
    const restoreInput = input();
    const originalValue = originals.get(definition.keys.at(-1)).value;
    if (await restoreInput.evaluate((element) => element.tagName === "SELECT")) {
      await selectExactOption(restoreInput, originalValue, `${definition.id}:RESTORE`);
    }
    else await restoreInput.fill(originalValue);
    await assertDirty(true, `${definition.id}:RESTORE_DIRTY`);
    const restored = await saveThroughUi(definition.scope, expectedKeys, () => saveButton().click(), `${definition.id}:RESTORE`);
    restoreReceipt = restored.receipt;
    restoreMode = "same-admin-ui-and-api-path";
  } else {
    restoreReceipt = await postSettings(definition.scope, rowsToValues(originals), `${definition.id}:RESTORE`);
    restoreMode = "same-api-path-exact-serialized-restore";
  }
  await openTab(definition.tab, true);
  await verifyUi(originals.get(definition.keys.at(-1)).value);
  await assertDirty(false, `${definition.id}:RESTORED_REFRESH`);
  await finishCase(definition, originals, changedRows, saved.receipt, restoreReceipt, restoreMode, path.relative(root, dirtyScreenshot));
}

async function executeAllCases(originalRows, plans) {
  const prefix = caseDefinition("global-system-prefix");
  await executeTextCase({
    definition: prefix,
    input: () => page.locator('textarea[placeholder^="例如："]'),
    target: plans[prefix.id].target,
    expectedKeys: prefix.keys,
    saveButton: () => page.getByRole("button", { name: "保存提示词规则", exact: true }),
    originalRows,
    waitOriginalUi: async () => waitForInputValue(page.locator('textarea[placeholder^="例如："]'), originalRows.get("global_system_prefix").value, "PREFIX_INITIAL_READBACK"),
    verifyUi: async (expected) => waitForInputValue(page.locator('textarea[placeholder^="例如："]'), expected, "PREFIX_REFRESH_READBACK"),
  });

  const avatar = caseDefinition("auto-avatar-model");
  await executeTextCase({
    definition: avatar,
    input: () => page.getByText("头像生图模型", { exact: true }).locator("xpath=following-sibling::select"),
    target: plans[avatar.id].target,
    expectedKeys: avatar.keys,
    saveButton: () => page.getByRole("button", { name: "保存模型默认项", exact: true }),
    originalRows,
    waitOriginalUi: async () => waitForInputValue(page.getByText("头像生图模型", { exact: true }).locator("xpath=following-sibling::select"), originalRows.get("auto_avatar_model_id").value, "AVATAR_INITIAL_READBACK"),
    verifyUi: async (expected) => waitForInputValue(page.getByText("头像生图模型", { exact: true }).locator("xpath=following-sibling::select"), expected, "AVATAR_REFRESH_READBACK"),
    restoreUi: plans[avatar.id].restoreUi,
  });

  const theme = caseDefinition("platform-theme");
  {
    const originals = new Map(theme.keys.map((key) => [key, originalRows.get(key)]));
    const target = plans[theme.id].target;
    const expectedValues = { theme: target, theme_mode: plans[theme.id].mode };
    await openTab(theme.tab);
    await assertDirty(false, `${theme.id}:INITIAL`);
    await prepareCase(theme, originalRows, expectedValues);
    await page.locator('button[aria-pressed]').filter({ hasText: THEME_NAMES[target] }).click();
    await assertDirty(true, `${theme.id}:DIRTY`);
    const dirtyScreenshot = path.join(evidenceDir, `${theme.id}-dirty.png`);
    await page.screenshot({ path: dirtyScreenshot, fullPage: false });
    const saved = await saveThroughUi(theme.scope, theme.keys, () => page.locator('[data-admin-default-theme-push="true"]').click(), `${theme.id}:SAVE`);
    assert.deepEqual(saved.requestValues, expectedValues, `${theme.id}:UI_REQUEST_SCOPE_MISMATCH`);
    const changedRows = await verifyPersisted(theme, expectedValues, `${theme.id}:SAVE`);
    cleanupEntries.get(theme.id).confirmedRows = changedRows;
    const publicSaved = requireApiOk(await api("/api/settings/appearance"), `${theme.id}:PUBLIC_READ`);
    const publicSavedTheme = Object.fromEntries(theme.keys.map((key) => [key, String(publicSaved.settings?.[key] ?? "")]));
    assert.deepEqual(publicSavedTheme, expectedValues, `${theme.id}:PUBLIC_APPEARANCE_MISMATCH`);
    assert.equal(publicSaved.authority?.authoritative, true, `${theme.id}:PUBLIC_AUTHORITY_REQUIRED`);
    await openTab(theme.tab, true);
    await page.locator('button[aria-pressed="true"]').filter({ hasText: THEME_NAMES[target] }).waitFor({ state: "visible" });
    await assertDirty(false, `${theme.id}:REFRESH`);
    await assertConcurrencyStable(theme, changedRows, theme.id);
    await page.locator('button[aria-pressed]').filter({ hasText: THEME_NAMES[originals.get("theme").value] }).click();
    await assertDirty(true, `${theme.id}:RESTORE_DIRTY`);
    const restored = await saveThroughUi(theme.scope, theme.keys, () => page.locator('[data-admin-default-theme-push="true"]').click(), `${theme.id}:RESTORE`);
    await openTab(theme.tab, true);
    await page.locator('button[aria-pressed="true"]').filter({ hasText: THEME_NAMES[originals.get("theme").value] }).waitFor({ state: "visible" });
    await assertDirty(false, `${theme.id}:RESTORED_REFRESH`);
    const publicRestored = requireApiOk(await api("/api/settings/appearance"), `${theme.id}:PUBLIC_RESTORE_READ`);
    const publicRestoredTheme = Object.fromEntries(theme.keys.map((key) => [key, String(publicRestored.settings?.[key] ?? "")]));
    assert.deepEqual(publicRestoredTheme, rowsToValues(originals), `${theme.id}:PUBLIC_RESTORE_MISMATCH`);
    await finishCase(theme, originals, changedRows, saved.receipt, restored.receipt, "same-admin-ui-and-api-path", path.relative(root, dirtyScreenshot));
  }

  const coze = caseDefinition("coze-non-secret");
  await executeTextCase({
    definition: coze,
    input: () => page.locator('input[placeholder="不填则自动搜索所有空间的智能体"]'),
    target: plans[coze.id].target,
    expectedKeys: coze.keys,
    saveButton: () => page.getByRole("heading", { name: "智能体平台连接", exact: true }).locator("xpath=..").getByRole("button", { name: "保存", exact: true }),
    originalRows,
    waitOriginalUi: async () => {
      await waitForInputValue(page.locator('input[placeholder="https://api.coze.cn"]'), originalRows.get("coze_api_base_url").value, "COZE_BASE_INITIAL_READBACK");
      await waitForInputValue(page.locator('input[placeholder="不填则自动搜索所有空间的智能体"]'), originalRows.get("coze_workspace_id").value, "COZE_INITIAL_READBACK");
    },
    verifyUi: async (expected) => waitForInputValue(page.locator('input[placeholder="不填则自动搜索所有空间的智能体"]'), expected, "COZE_REFRESH_READBACK"),
  });

  const smtp = caseDefinition("smtp-non-secret");
  await executeTextCase({
    definition: smtp,
    input: () => page.locator('input[placeholder^="如："]'),
    target: plans[smtp.id].target,
    expectedKeys: smtp.keys,
    saveButton: () => page.getByRole("heading", { name: /邮件服务配置/u }).locator("xpath=..").getByRole("button", { name: "保存", exact: true }),
    originalRows,
    waitOriginalUi: async () => {
      await waitForInputValue(page.locator('input[placeholder="smtp.qq.com"]'), originalRows.get("email_smtp_host").value, "SMTP_HOST_INITIAL_READBACK");
      await waitForInputValue(page.locator('input[placeholder="465"]'), originalRows.get("email_smtp_port").value, "SMTP_PORT_INITIAL_READBACK");
      await waitForInputValue(page.locator('input[placeholder="your@qq.com"]'), originalRows.get("email_smtp_user").value, "SMTP_USER_INITIAL_READBACK");
      await waitForInputValue(page.locator('input[placeholder^="如："]'), originalRows.get("email_from").value, "SMTP_FROM_INITIAL_READBACK");
    },
    verifyUi: async (expected) => waitForInputValue(page.locator('input[placeholder^="如："]'), expected, "SMTP_REFRESH_READBACK"),
  });

  const layout = caseDefinition("page-card-layout");
  {
    const originals = new Map(layout.keys.map((key) => [key, originalRows.get(key)]));
    await openTab(layout.tab);
    await assertDirty(false, `${layout.id}:INITIAL`);
    const beforeMutation = await readDbRows(layout.keys);
    assert.equal(rowsEqual(beforeMutation, originals, false), true, `${layout.id}:BASELINE_DRIFT_BEFORE_MUTATION`);
    cleanupEntries.set(layout.id, { definition: layout, originals, expectedValues: null, confirmedRows: null });
    const input = page.getByText("每行列数", { exact: true }).locator('xpath=following-sibling::input[@type="number"]');
    await waitForInputValue(input, String(plans[layout.id].originalColumns), `${layout.id}:INITIAL_READBACK`);
    await input.fill(String(plans[layout.id].target));
    await assertDirty(true, `${layout.id}:DIRTY`);
    const dirtyScreenshot = path.join(evidenceDir, `${layout.id}-dirty.png`);
    await page.screenshot({ path: dirtyScreenshot, fullPage: false });
    assert.equal(await input.count(), 1, `${layout.id}:LAYOUT_INPUT_REQUIRED`);
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/settings/admin" && url.searchParams.get("scope") === "brand";
    });
    await page.getByRole("button", { name: "保存", exact: true }).first().click();
    const response = await responsePromise;
    const requestPayload = response.request().postDataJSON();
    cleanupEntries.get(layout.id).expectedValues = requestPayload;
    const body = await response.json();
    assert.equal(response.ok(), true, `${layout.id}:UI_POST_HTTP_${response.status()}`);
    const savedReceipt = assertReceipt(body, layout.keys, `${layout.id}:SAVE`);
    assert.deepEqual(Object.keys(requestPayload).sort(), [...layout.keys].sort(), `${layout.id}:UI_REQUEST_SCOPE_MISMATCH`);
    const expectedValues = requestPayload;
    await assertDirty(false, `${layout.id}:SAVE`);
    const changedRows = await verifyPersisted(layout, expectedValues, `${layout.id}:SAVE`);
    cleanupEntries.get(layout.id).confirmedRows = changedRows;
    await openTab(layout.tab, true);
    await waitForInputValue(page.getByText("每行列数", { exact: true }).locator('xpath=following-sibling::input[@type="number"]'), String(plans[layout.id].target), "LAYOUT_REFRESH_READBACK");
    await assertDirty(false, `${layout.id}:REFRESH`);
    await assertConcurrencyStable(layout, changedRows, layout.id);
    const restoreReceipt = await postSettings(layout.scope, rowsToValues(originals), `${layout.id}:RESTORE`);
    await openTab(layout.tab, true);
    await waitForInputValue(page.getByText("每行列数", { exact: true }).locator('xpath=following-sibling::input[@type="number"]'), String(plans[layout.id].originalColumns), "LAYOUT_RESTORE_REFRESH_READBACK");
    await assertDirty(false, `${layout.id}:RESTORED_REFRESH`);
    await finishCase(layout, originals, changedRows, savedReceipt, restoreReceipt, "same-api-path-exact-serialized-restore", path.relative(root, dirtyScreenshot));
  }

  const cover = caseDefinition("cover-workflow-app");
  await executeTextCase({
    definition: cover,
    input: () => page.locator('input[placeholder="应用 ID"]'),
    target: plans[cover.id].target,
    expectedKeys: cover.keys,
    saveButton: () => page.getByRole("heading", { name: "封面工作流连接", exact: true }).locator("xpath=..").getByRole("button", { name: "保存", exact: true }),
    originalRows,
    waitOriginalUi: async () => {
      await waitForInputValue(page.locator('input[placeholder="https://xxxxx.coze.site/stream_run"]'), originalRows.get("cover_workflow_api_url").value, "COVER_URL_INITIAL_READBACK");
      await waitForInputValue(page.locator('input[placeholder="应用 ID"]'), originalRows.get("cover_workflow_app_id").value, "COVER_APP_INITIAL_READBACK");
    },
    verifyUi: async (expected) => waitForInputValue(page.locator('input[placeholder="应用 ID"]'), expected, "COVER_APP_REFRESH_READBACK"),
  });

  const credits = caseDefinition("credits-per-yuan");
  await executeTextCase({
    definition: credits,
    input: () => page.getByText("每元积分数：", { exact: true }).locator('xpath=following-sibling::input[@type="number"]'),
    target: plans[credits.id].target,
    expectedKeys: credits.keys,
    saveButton: () => page.getByText("每元积分数：", { exact: true }).locator("xpath=..").getByRole("button", { name: "保存", exact: true }),
    originalRows,
    waitOriginalUi: async () => waitForInputValue(page.getByText("每元积分数：", { exact: true }).locator('xpath=following-sibling::input[@type="number"]'), originalRows.get("credits_per_yuan").value, "CREDITS_INITIAL_READBACK"),
    verifyUi: async (expected) => waitForInputValue(page.getByText("每元积分数：", { exact: true }).locator('xpath=following-sibling::input[@type="number"]'), expected, "CREDITS_REFRESH_READBACK"),
  });
}

async function cleanupSettings(phase = "primary") {
  for (const [id, entry] of [...cleanupEntries.entries()].reverse()) {
    const cleanup = { id, phase, restored: false, driftBlocked: false, mode: null };
    try {
      const current = await readDbRows(entry.definition.keys);
      if (rowsEqual(current, entry.originals, false)) {
        cleanup.restored = true;
        cleanup.mode = "already-original";
      } else {
        const stable = entry.confirmedRows
          ? rowsEqual(current, entry.confirmedRows, true)
          : Boolean(entry.expectedValues && valuesEqual(current, entry.expectedValues));
        if (!stable) {
          cleanup.driftBlocked = true;
          cleanup.mode = "concurrency-drift-refused";
        } else {
          await postSettings(entry.definition.scope, rowsToValues(entry.originals), `${id}:FINALLY_RESTORE`);
          const restored = await readDbRows(entry.definition.keys);
          cleanup.restored = rowsEqual(restored, entry.originals, false);
          cleanup.mode = entry.confirmedRows ? "confirmed-same-api-path" : "interrupted-value-match-same-api-path";
        }
      }
    } catch (error) {
      cleanup.error = String(error?.message || error).slice(0, 300);
    }
    report.cleanup.cases.push(cleanup);
  }
}

async function originalRowsRemainStable(originalRows, samples = 4, gapMs = 750) {
  for (let index = 0; index < samples; index += 1) {
    if (index > 0) await sleep(gapMs);
    const current = await readDbRows(ALL_KEYS);
    if (!rowsEqual(current, originalRows, false)) return false;
  }
  return true;
}

await fs.mkdir(evidenceDir, { recursive: true });
try {
  report.runtime = await verifyRunningLatest();
  await settleServerSettingsWindowBeforeBrowser();
  await db.connect();
  dbConnected = true;
  const dbIdentity = await db.query("SELECT current_database() AS database, inet_server_addr()::text AS server_address");
  assert.equal(dbIdentity.rows[0]?.database, "zimeiti_local", "CONNECTED_LOCAL_DATABASE_REQUIRED");
  report.database.serverAddress = dbIdentity.rows[0]?.server_address || "local-socket";

  const originalRows = await readDbRows(ALL_KEYS);
  baselineOriginalRows = originalRows;
  const missingKeys = [...originalRows.values()].filter((row) => !row.exists).map((row) => row.key);
  assert.deepEqual(missingKeys, [], `REVERSIBLE_EXISTING_SETTING_ROWS_REQUIRED:${missingKeys.join(",")}`);
  report.database.originalRows = safeRows(originalRows);

  await createStepUpSession();
  const identity = requireApiOk(await api("/api/auth/me", {}, false), "ADMIN_IDENTITY").user;
  assert.equal(identity?.id, actorId, "ADMIN_IDENTITY_MISMATCH");
  await launchBrowser(identity);
  const plans = await preflightPlans(originalRows);
  await executeAllCases(originalRows, plans);

  report.settingsReadBudget.settlement = await waitForSettingsGetSettlement();

  assert.equal(report.cases.length, CASES.length, "ALL_EIGHT_SAVE_CASES_REQUIRED");
  assert.deepEqual(report.unexpectedWrites, [], "UNEXPECTED_BROWSER_WRITES_FORBIDDEN");
  assert.deepEqual(report.blockedExternalRequests, [], "UNEXPECTED_EXTERNAL_REQUESTS_FORBIDDEN");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS_FORBIDDEN");
  assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS_FORBIDDEN");
  assert.deepEqual(report.serverErrors, [], "SERVER_5XX_FORBIDDEN");
  assert.deepEqual(report.settingsResponses.nonOk, [], "SETTINGS_READ_ERRORS_FORBIDDEN");
  assert.deepEqual(report.settingsResponses.failures, [], "SETTINGS_READ_TRANSPORT_FAILURES_FORBIDDEN");
  assert.equal(report.settingsReadBudget.settlement.settled, true, "SETTINGS_READ_ACCOUNTING_MUST_SETTLE");
  assert.equal(
    report.settingsReadBudget.reservations,
    report.settingsResponses.total + report.settingsResponses.failures.length,
    "SETTINGS_READ_ACCOUNTING_MISMATCH",
  );
  assert.deepEqual({
    deployCalls: report.safety.deployCalls,
    generationCalls: report.safety.generationCalls,
    paymentCalls: report.safety.paymentCalls,
    mailCalls: report.safety.mailCalls,
    providerCalls: report.safety.providerCalls,
  }, { deployCalls: 0, generationCalls: 0, paymentCalls: 0, mailCalls: 0, providerCalls: 0 }, "FORBIDDEN_SIDE_EFFECT_CALL");
} catch (error) {
  fatalError = error;
  report.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 500) };
} finally {
  report.cleanup.settingsWriteSettlement = await waitForPendingAdminSettingsWrites().catch((error) => ({
    settled: false,
    pending: pendingAdminSettingsWrites.size,
    waitedMs: null,
    error: String(error?.message || error).slice(0, 300),
  }));
  report.cleanup.pendingSettingsWritesSettled = report.cleanup.settingsWriteSettlement.settled === true;
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  page = undefined;
  context = undefined;
  browser = undefined;
  await sleep(750);
  await cleanupSettings("primary").catch((error) => {
    report.cleanup.settingsError = String(error?.message || error).slice(0, 300);
  });
  if (dbConnected && baselineOriginalRows) {
    report.cleanup.finalRowsMatchOriginal = await originalRowsRemainStable(baselineOriginalRows).catch(() => false);
    if (!report.cleanup.finalRowsMatchOriginal) {
      report.cleanup.lateRecoveryAttempted = true;
      await cleanupSettings("late-recovery").catch((error) => {
        report.cleanup.lateRecoveryError = String(error?.message || error).slice(0, 300);
      });
      report.cleanup.finalRowsMatchOriginal = await originalRowsRemainStable(baselineOriginalRows).catch(() => false);
    }
  }
  cleanupEntries.clear();
  if (dbConnected) {
    await removeStepUpSession().then((removed) => { report.cleanup.stepUpSessionRemoved = removed; }).catch((error) => {
      report.cleanup.stepUpError = String(error?.message || error).slice(0, 300);
    });
  }
  const finalCleanupByCase = new Map(report.cleanup.cases.map((entry) => [entry.id, entry]));
  report.safety.settingsRestored = report.cleanup.finalRowsMatchOriginal === true
    && [...finalCleanupByCase.values()].every((entry) => entry.restored === true && entry.driftBlocked !== true);
  if (report.cleanup.cases.length === 0 && report.cases.length === CASES.length) {
    report.safety.settingsRestored = report.cleanup.finalRowsMatchOriginal === true;
  }
  const forbiddenSideEffectCalls = report.safety.deployCalls + report.safety.generationCalls
    + report.safety.paymentCalls + report.safety.mailCalls + report.safety.providerCalls;
  report.checkedAt = new Date().toISOString();
  report.passed = !fatalError
    && report.cases.length === CASES.length
    && report.safety.settingsRestored
    && report.cleanup.stepUpSessionRemoved
    && report.cleanup.pendingSettingsWritesSettled
    && report.cleanup.settingsWritesFailed === 0
    && report.cleanup.settingsWritesStarted === report.cleanup.settingsWritesFinished
    && report.unexpectedWrites.length === 0
    && report.blockedExternalRequests.length === 0
    && report.pageErrors.length === 0
    && report.consoleErrors.length === 0
    && report.serverErrors.length === 0
    && report.settingsResponses.nonOk.length === 0
    && report.settingsResponses.failures.length === 0
    && report.settingsReadBudget.settlement?.settled === true
    && report.settingsReadBudget.reservations === report.settingsResponses.total + report.settingsResponses.failures.length
    && forbiddenSideEffectCalls === 0;
  await db.end().catch(() => undefined);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.passed, true, fatalError?.message || "ADMIN_SETTINGS_SAVE_LIVE_NOT_PASSED");
console.log(JSON.stringify({ passed: true, report: path.relative(root, reportPath), cases: report.cases.map((item) => item.id) }, null, 2));
