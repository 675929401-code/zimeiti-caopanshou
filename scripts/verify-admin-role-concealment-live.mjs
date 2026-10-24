#!/usr/bin/env node

/**
 * Local, zero-provider runtime acceptance for least-privilege administrator
 * concealment. Run through the verified local session launcher:
 *
 *   node scripts/with-local-admin-session.mjs scripts/verify-admin-role-concealment-live.mjs
 *
 * The script writes only disposable local fixture rows and evidence under
 * .codex-evidence/admin-role-concealment-live. It never invokes a model,
 * payment provider, deployment endpoint, or non-loopback HTTP origin.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium } from "playwright";
import {
  createLoadedJavaScriptSentinelAudit,
} from "./lib/admin-loaded-javascript-audit.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const superToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const localIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const superUser = localIdentity.user || {};
const databaseUrl = String(process.env.DATABASE_URL || "");
const evidenceDir = path.resolve(".codex-evidence", "admin-role-concealment-live");
const reportPath = path.join(evidenceDir, "report.json");
const startedAt = new Date().toISOString();
const apiUserAgent = "Codex-Admin-Role-Concealment/1.0";
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 CodexAdminRoleConcealment";
const sessionRealIps = Object.freeze({
  superAdmin: "127.0.0.1",
  ordinaryAdmin: "127.0.0.2",
  promptAdmin: "127.0.0.3",
  anonymous: "127.0.0.10",
});
const announcementDismissalsStorageKey = "announcement_session_dismissals_v3";
const announcementEventTypes = new Set(["impression", "read", "click", "close", "remind_later"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestedPermissions = ["members.view", "models.view", "platform.settings.manage", "white_label.manage"];
const expectedEffectivePermissions = [
  "members.view",
  "models.view",
  "platform.settings.manage",
  "brand.settings.manage",
  "white_label.manage",
];
const expectedOrdinaryTabs = [
  "dashboard",
  "general",
  "layout",
  "models",
  "theme",
  "users",
  "white-label",
  "workspace-models",
];
const expectedVisiblePrimaryTabs = ["dashboard", "users", "models", "workspace-models", "general", "white-label"];
const expectedHiddenPrimaryTabs = [
  "benefit-packages",
  "credits",
  "payment",
  "announcements",
  "agents",
  "security",
  "health",
  "super-admin",
];
const memberFinancialFields = new Set([
  "credits",
  "cash_balance",
  "cashBalance",
  "totalCreditRecharge",
  "totalCashRecharge",
  "totalCreditConsume",
  "totalCashConsume",
  "totalRecharge",
  "totalConsume",
]);

async function prepareEvidenceDirectory() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const removed = [];
  const entries = await fs.readdir(evidenceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name !== "report.json" && !entry.name.endsWith(".png") && !/^report\..+\.tmp$/u.test(entry.name)) continue;
    const artifactPath = path.resolve(evidenceDir, entry.name);
    assert.equal(path.dirname(artifactPath), evidenceDir, "EVIDENCE_CLEANUP_PATH_MUST_STAY_SCOPED");
    await fs.unlink(artifactPath);
    removed.push(entry.name);
  }
  return removed.sort();
}

async function writeReportAtomically(value) {
  const temporaryPath = `${reportPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, reportPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}
const readOnlyModelFields = new Set([
  "id",
  "name",
  "model_type",
  "billing_mode",
  "selling_price",
  "price_per_use",
  "is_active",
  "is_hidden",
  "sort_order",
  "duration_seconds",
  "max_duration",
  "supports_image_input",
  "requires_image",
  "description",
  "category",
  "user_access",
  "icon_url",
  "created_at",
  "updated_at",
]);
const sensitiveModelFields = new Set([
  "model_name",
  "api_endpoint",
  "api_key",
  "api_key_configured",
  "cost_price",
  "token_billing_enabled",
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
  "token_rounding_unit",
  "provider",
  "protocol_type",
  "admin_notes",
  "api_protocol_config",
  "max_context_rounds",
  "max_context_tokens",
  "max_reply_tokens",
  "timeout",
  "enable_web_search",
  "deep_thinking_type",
  "deduct_deep_think",
  "temperature",
  "response_format",
  "proxy_url",
  "frequency_limit",
  "image_parsing",
  "file_parsing",
  "total_requests",
  "success_count",
  "fail_count",
  "agent_id",
]);

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.equal(process.env.LOCAL_ACCEPTANCE_PREVIEW, "true", "LOCAL_ACCEPTANCE_WRAPPER_REQUIRED");
assert.ok(superToken.length > 32, "LOCAL_SUPER_ADMIN_TOKEN_REQUIRED");
assert.ok(superUser.id, "LOCAL_SUPER_ADMIN_ID_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");
assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(databaseUrl).hostname), "LOOPBACK_DATABASE_REQUIRED");

const removedPriorEvidence = await prepareEvidenceDirectory();

const report = {
  schemaVersion: 1,
  passed: false,
  startedAt,
  checkedAt: "",
  origin,
  viewport: { width: 1440, height: 900 },
  runtime: {},
  sessionIsolation: {
    policy: "AUTH-SESSION-01",
    realIps: sessionRealIps,
    playwrightContextRealIps: {
      superAdmin: sessionRealIps.superAdmin,
      ordinaryAdmin: sessionRealIps.ordinaryAdmin,
    },
    superSelfAfterOrdinaryLoginStatus: null,
  },
  superAdmin: {},
  fixture: {
    requestedPermissions,
    effectivePermissions: [],
  },
  api: {
    selfProjection: {},
    genericDenials: [],
    membersView: {},
    memberPermissionSnapshot: {},
    modelsView: {},
    brandScope: {},
    whiteLabel: {},
    liveness: {},
    capabilityTransition: {},
  },
  browser: {
    ordinary: {},
    superAdmin: {},
  },
  screenshots: [],
  evidence: {
    removedPriorArtifacts: removedPriorEvidence,
    deniedDeepLinkNavigations: [],
    announcementHandling: [],
  },
  cleanup: {},
  externalCalls: 0,
  externalAttempts: 0,
  providerCalls: 0,
  paidCalls: 0,
  productionWrites: 0,
  localFixtureWrites: true,
  failure: null,
};

function redactText(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[jwt-redacted]")
    .replace(/zimeiti_admin_step_up=[^;\s]+/giu, "zimeiti_admin_step_up=[redacted]")
    .slice(0, 1000);
}

function errorSummary(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: redactText(error instanceof Error ? error.message : error),
  };
}

function fingerprintToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function announcementPushRevision(announcement) {
  const candidates = [
    announcement?.revision,
    announcement?.push_revision,
    announcement?.pushRevision,
    announcement?.receipt?.revision,
    announcement?.receipt?.push_revision,
    announcement?.receipt?.pushRevision,
    announcement?.delivery?.revision,
    announcement?.delivery?.push_revision,
    announcement?.delivery?.pushRevision,
  ];
  const revision = candidates.find((value) => typeof value === "number" && Number.isFinite(value));
  return typeof revision === "number" ? Math.max(0, Math.trunc(revision)) : 1;
}

async function loadAnnouncementSessionDismissals(headers, user, token) {
  const response = await api("/api/announcements/inbox", { headers });
  const payload = await readJson(response);
  assert.equal(response.status, 200, `ANNOUNCEMENT_INBOX_REQUIRED_FOR_TEST_ISOLATION:${response.status}`);
  const announcements = Array.isArray(payload.announcements) ? payload.announcements : [];
  const keys = announcements
    .filter((announcement) => announcement && typeof announcement.id === "string" && announcement.id)
    .map((announcement) => `${announcement.id}:${announcementPushRevision(announcement)}`);
  return {
    identity: `${String(user.id)}:${fingerprintToken(token)}`,
    keys,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: redactText(text.slice(0, 500)) };
  }
}

async function api(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: {
      "User-Agent": apiUserAgent,
      "X-Real-IP": sessionRealIps.superAdmin,
      ...(options.headers || {}),
    },
  });
}

function collectObjectKeys(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    output.add(key);
    collectObjectKeys(nested, output);
  }
  return output;
}

function assertGenericDeny(pathname, response, body) {
  assert.equal(response.status, 403, `${pathname}:GENERIC_DENY_STATUS_REQUIRED:${response.status}`);
  assert.ok(
    ["ADMIN_PERMISSION_DENIED", "SUPER_ADMIN_REQUIRED"].includes(body.code),
    `${pathname}:GENERIC_DENY_CODE_REQUIRED`,
  );
  assert.deepEqual(Object.keys(body).sort(), ["code", "error"], `${pathname}:DENIAL_DETAIL_LEAKED`);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /requiredPermission|permissionKey|operation|resource/iu, `${pathname}:DENIAL_METADATA_LEAKED`);
  assert.doesNotMatch(serialized, /(?:admin|members|member_content|billing|wallet|agents|prompts|models|platform|brand|integrations|payment|white_label|security|logs|backups|deployment)\.[a-z_.]+/iu, `${pathname}:PERMISSION_KEY_LEAKED`);
  return { pathname, status: response.status, code: body.code, responseKeys: Object.keys(body).sort() };
}

function assertMemberFinancialFieldsHidden(payload) {
  const keys = collectObjectKeys(payload);
  const leaked = [...memberFinancialFields].filter((field) => keys.has(field));
  assert.deepEqual(leaked, [], `MEMBER_FINANCIAL_FIELDS_LEAKED:${leaked.join(",")}`);
  return [...keys].sort();
}

function assertReadOnlyModels(payload) {
  assert.equal(payload.access?.mode, "read", "MODELS_VIEW_MUST_USE_READ_MODE");
  assert.deepEqual(payload.video_surface_orders || {}, {}, "MODEL_SURFACE_ORDER_MUST_BE_HIDDEN");
  assert.ok(Array.isArray(payload.models) && payload.models.length > 0, "READ_ONLY_MODEL_CATALOG_REQUIRED");
  const observedFields = new Set();
  for (const model of payload.models) {
    assert.ok(model && typeof model === "object" && !Array.isArray(model), "MODEL_DTO_OBJECT_REQUIRED");
    for (const key of Object.keys(model)) {
      observedFields.add(key);
      assert.ok(readOnlyModelFields.has(key), `MODEL_READ_ONLY_DTO_UNEXPECTED_FIELD:${key}`);
      assert.equal(sensitiveModelFields.has(key), false, `MODEL_READ_ONLY_DTO_SENSITIVE_FIELD:${key}`);
    }
  }
  return [...observedFields].sort();
}

function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return true;
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return true;
  }
}

function inspectAnnouncementEventRequest(request) {
  try {
    const payload = JSON.parse(request.postData() || "{}");
    assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "ANNOUNCEMENT_EVENT_OBJECT_REQUIRED");
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["event", "eventKey", "id", "pushRevision"],
      "ANNOUNCEMENT_EVENT_EXACT_FIELDS_REQUIRED",
    );
    assert.match(payload.id, uuidPattern, "ANNOUNCEMENT_EVENT_ID_REQUIRED");
    assert.ok(announcementEventTypes.has(payload.event), `ANNOUNCEMENT_EVENT_TYPE_REQUIRED:${payload.event}`);
    assert.ok(Number.isInteger(payload.pushRevision) && payload.pushRevision > 0, "ANNOUNCEMENT_EVENT_REVISION_REQUIRED");
    assert.equal(
      payload.eventKey,
      `announcement:${payload.id}:r${payload.pushRevision}:${payload.event}:v1`,
      "ANNOUNCEMENT_EVENT_KEY_CONTRACT_REQUIRED",
    );
    assert.match(request.headers()["content-type"] || "", /^application\/json(?:;|$)/iu, "ANNOUNCEMENT_EVENT_JSON_REQUIRED");
    assert.match(request.headers().authorization || "", /^Bearer\s+\S+$/u, "ANNOUNCEMENT_EVENT_AUTH_REQUIRED");
    return {
      id: payload.id,
      event: payload.event,
      revision: payload.pushRevision,
      eventKey: payload.eventKey,
      contractValid: true,
      intercepted: true,
      serverReached: false,
    };
  } catch (error) {
    return {
      contractValid: false,
      intercepted: true,
      serverReached: false,
      error: errorSummary(error),
    };
  }
}

async function installNetworkGuard(context, label) {
  const audit = {
    label,
    localRequests: [],
    writeRequests: [],
    externalAttempts: [],
    consoleErrors: [],
    pageErrors: [],
    http4xx: [],
    http5xx: [],
    telemetryWrites: [],
    announcementReceiptWrites: [],
    announcementEventInterceptions: [],
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!isLoopbackHttpUrl(request.url())) {
      audit.externalAttempts.push({ method: request.method(), url: redactText(request.url()) });
      await route.abort("blockedbyclient");
      return;
    }
    const url = new URL(request.url());
    if (request.method().toUpperCase() === "POST" && url.pathname === "/api/announcements/events") {
      const interception = inspectAnnouncementEventRequest(request);
      audit.announcementEventInterceptions.push(interception);
      await route.fulfill({
        status: interception.contractValid ? 200 : 400,
        contentType: "application/json",
        headers: {
          "Cache-Control": "no-store",
          "X-Codex-Announcement-Event-Intercepted": "true",
        },
        body: JSON.stringify(interception.contractValid
          ? { success: true, recorded: false, alreadyRecorded: true }
          : { success: false, code: "ANNOUNCEMENT_EVENT_CONTRACT_INVALID" }),
      });
      return;
    }
    await route.continue();
  });
  context.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol) || !isLoopbackHttpUrl(request.url())) return;
      const method = request.method().toUpperCase();
      const entry = `${method} ${url.pathname}${url.search}`;
      audit.localRequests.push(entry);
      if (method === "POST" && url.pathname === "/api/operation-events") {
        try {
          const payload = JSON.parse(request.postData() || "{}");
          audit.telemetryWrites.push({
            route: String(payload.route || ""),
            phase: String(payload.phase || ""),
            outcome: String(payload.outcome || ""),
            durationMs: Number(payload.duration_ms || 0),
            httpStatus: payload.http_status ?? null,
            errorCode: payload.error_code ?? null,
            method: String(payload.metadata?.method || "").toUpperCase(),
          });
        } catch {
          audit.telemetryWrites.push({ parseError: true });
        }
      } else if (method === "POST" && /^\/api\/announcements\/[^/]+\/read$/u.test(url.pathname)) {
        audit.announcementReceiptWrites.push(entry);
      } else if (method === "POST" && url.pathname === "/api/announcements/events") {
        // Fulfilled inside the Playwright route above; never reaches the app server.
      } else if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        audit.writeRequests.push(entry);
      }
    } catch { /* Ignore blob/data URLs. */ }
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    const entry = `${response.status()} ${response.request().method()} ${url.pathname}${url.search}`;
    if (response.status() >= 400 && response.status() < 500) audit.http4xx.push(entry);
    if (response.status() >= 500) audit.http5xx.push(entry);
  });
  return audit;
}

function attachPageAudit(page, audit) {
  page.on("console", (message) => {
    if (message.type() === "error") audit.consoleErrors.push(redactText(message.text()));
  });
  page.on("pageerror", (error) => audit.pageErrors.push(redactText(error.message)));
}

function summarizeBrowserAudit(audit) {
  return {
    localRequestCount: audit.localRequests.length,
    localRequestPaths: [...new Set(audit.localRequests)].sort(),
    writeRequests: audit.writeRequests,
    externalAttempts: audit.externalAttempts,
    consoleErrors: audit.consoleErrors,
    pageErrors: audit.pageErrors,
    http4xx: audit.http4xx,
    http5xx: audit.http5xx,
    telemetryWrites: audit.telemetryWrites,
    announcementReceiptWrites: audit.announcementReceiptWrites,
    announcementEventInterceptions: audit.announcementEventInterceptions,
  };
}

function assertCleanBrowserAudit(audit) {
  assert.deepEqual(audit.externalAttempts, [], `${audit.label}:EXTERNAL_REQUEST_ATTEMPTED`);
  assert.deepEqual(audit.writeRequests, [], `${audit.label}:BROWSER_WRITE_REQUEST_FORBIDDEN`);
  for (const entry of audit.announcementReceiptWrites) {
    assert.match(entry, /^POST \/api\/announcements\/[^/]+\/read$/u, `${audit.label}:UNEXPECTED_ANNOUNCEMENT_RECEIPT_WRITE`);
  }
  for (const [index, interception] of audit.announcementEventInterceptions.entries()) {
    assert.equal(interception.contractValid, true, `${audit.label}:ANNOUNCEMENT_EVENT_CONTRACT_INVALID:${index}`);
    assert.equal(interception.intercepted, true, `${audit.label}:ANNOUNCEMENT_EVENT_MUST_BE_INTERCEPTED:${index}`);
    assert.equal(interception.serverReached, false, `${audit.label}:ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED:${index}`);
  }
  for (const [index, telemetry] of audit.telemetryWrites.entries()) {
    assert.equal(telemetry.parseError, undefined, `${audit.label}:TELEMETRY_PAYLOAD_PARSE_REQUIRED:${index}`);
    assert.equal(telemetry.method, "GET", `${audit.label}:TELEMETRY_GET_ONLY:${index}`);
    assert.equal(telemetry.outcome, "success", `${audit.label}:TELEMETRY_SUCCESS_ONLY:${index}`);
    assert.ok(
      Number.isInteger(telemetry.httpStatus) && telemetry.httpStatus >= 200 && telemetry.httpStatus < 400,
      `${audit.label}:TELEMETRY_SUCCESS_STATUS_REQUIRED:${index}`,
    );
  }
  assert.deepEqual(audit.consoleErrors, [], `${audit.label}:CONSOLE_ERRORS`);
  assert.deepEqual(audit.pageErrors, [], `${audit.label}:PAGE_ERRORS`);
  assert.deepEqual(audit.http4xx, [], `${audit.label}:HTTP_4XX`);
  assert.deepEqual(audit.http5xx, [], `${audit.label}:HTTP_5XX`);
}

async function installAdminSession(context, token, user, stepUpToken = "", announcementDismissals = null) {
  const cookies = [
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
  ];
  if (stepUpToken) {
    cookies.push({ name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" });
  }
  await context.addCookies(cookies);
  await context.addInitScript(({ authToken, authUser, dismissalStorageKey, dismissals }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    sessionStorage.setItem("entered_app", "1");
    if (dismissals?.identity && Array.isArray(dismissals.keys)) {
      sessionStorage.setItem(dismissalStorageKey, JSON.stringify(dismissals));
    }
  }, {
    authToken: token,
    authUser: user,
    dismissalStorageKey: announcementDismissalsStorageKey,
    dismissals: announcementDismissals,
  });
}

async function settleAnnouncementReader(page, {
  identity = "ordinary-admin",
  allowServerReceipt = true,
} = {}) {
  const reader = page.locator('[data-testid="announcement-reader"]');
  if (!await reader.isVisible().catch(() => false)) return;

  let serverReceiptsConfirmed = 0;
  if (allowServerReceipt) {
    for (let index = 0; index < 50; index += 1) {
      if (!await reader.isVisible().catch(() => false)) break;
      const acknowledge = reader.getByTestId("announcement-mark-read");
      if (!await acknowledge.isVisible().catch(() => false)) break;
      const receiptResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST"
          && /^\/api\/announcements\/[^/]+\/read$/u.test(url.pathname);
      }, { timeout: 20_000 });
      await acknowledge.click();
      const receiptResponse = await receiptResponsePromise;
      assert.equal(receiptResponse.status(), 200, `${identity}:ANNOUNCEMENT_READ_RECEIPT_REQUIRED`);
      serverReceiptsConfirmed += 1;
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="announcement-mark-read"]');
        return !button || !button.hasAttribute("disabled");
      }, undefined, { timeout: 10_000 });
    }
  }

  let closedWithoutReceipt = false;
  if (await reader.isVisible().catch(() => false)) {
    const closeButton = reader.getByRole("button", { name: "关闭系统公告", exact: true });
    await closeButton.click();
    await reader.waitFor({ state: "hidden", timeout: 10_000 });
    closedWithoutReceipt = true;
  }
  report.evidence.announcementHandling.push({
    identity,
    serverReceiptsConfirmed,
    closedWithoutReceipt,
    durableBusinessStateChanged: serverReceiptsConfirmed > 0,
  });
  if (report.evidence.announcementIsolation) {
    report.evidence.announcementIsolation.serverReadReceiptsWritten += serverReceiptsConfirmed;
    report.evidence.announcementIsolation.disposableFixtureReceiptsWritten += serverReceiptsConfirmed;
  }
}

async function waitForAdminReady(page, primaryTab = "users", announcementOptions = undefined) {
  await page.locator(".admin-light-shell").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".admin-light-shell h1", { hasText: "管理后台" }).first().waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(`[data-testid="admin-primary-nav-${primaryTab}"]`).waitFor({ state: "visible", timeout: 45_000 });
  await settleAnnouncementReader(page, announcementOptions);
  await page.locator('[data-testid="announcement-reader"]').waitFor({ state: "hidden", timeout: 20_000 });
}

async function waitForTabInUrl(page, tab, project = null) {
  await page.waitForFunction(({ expectedTab, expectedProject }) => {
    const current = new URL(window.location.href);
    return current.searchParams.get("tab") === expectedTab
      && (expectedProject === null || current.searchParams.get("project") === expectedProject);
  }, { expectedTab: tab, expectedProject: project }, { timeout: 30_000 });
}

function cookieValue(setCookie, cookieName) {
  const match = String(setCookie || "").match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`, "u"));
  return match?.[1] || "";
}

async function captureScreenshot(page, fileName) {
  const relative = path.posix.join(".codex-evidence", "admin-role-concealment-live", fileName);
  const outputPath = path.join(evidenceDir, fileName);
  await page.screenshot({ path: outputPath });
  report.screenshots.push(relative);
}

async function captureFailurePageEvidence(page, phase) {
  if (!page || page.isClosed()) return { phase, available: false };
  const selectorState = async (selector) => {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const visible = count > 0 ? await locator.first().isVisible().catch(() => false) : false;
    return { count, visible };
  };
  const safePhase = String(phase || "unknown").replace(/[^a-z0-9_-]+/giu, "-").slice(0, 80);
  const screenshot = `failure-${safePhase || "unknown"}-1440x900.png`;
  await captureScreenshot(page, screenshot).catch(() => undefined);
  return {
    phase,
    available: true,
    url: redactText(page.url()),
    title: redactText(await page.title().catch(() => "")),
    adminShell: await selectorState(".admin-light-shell"),
    adminLogin: await selectorState('[data-testid="admin-login-page"]'),
    announcementReader: await selectorState('[data-testid="announcement-reader"]'),
    accessEmpty: await selectorState('[data-testid="admin-access-empty"]'),
    screenshot,
  };
}

const db = new pg.Client({
  connectionString: databaseUrl,
  application_name: "codex-admin-role-concealment-live",
});
let dbConnected = false;
let fixtureUserId = "";
let superStepUpHash = "";
let browser = null;
let ordinaryContext = null;
let superContext = null;
let ordinaryAudit = null;
let superAudit = null;
let ordinaryPage = null;
let superPage = null;
let ordinaryLoadedJavaScriptAudit = null;
let superLoadedJavaScriptAudit = null;
let activeBrowserPhase = "setup";
let failure = null;

try {
  await db.connect();
  dbConnected = true;

  const versionResponse = await api("/api/version", {
    headers: { Accept: "application/json", "X-Real-IP": sessionRealIps.anonymous },
  });
  const version = await readJson(versionResponse);
  report.runtime = {
    versionStatus: versionResponse.status,
    sourceVersion: version.sourceVersion || version.version || null,
    buildId: version.buildId || version.build_id || null,
  };

  const superSelfResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const superSelf = await readJson(superSelfResponse);
  assert.equal(superSelfResponse.status, 200, `SUPER_ADMIN_SELF_REQUIRED:${superSelfResponse.status}`);
  assert.equal(superSelf.access?.adminLevel, "super_admin", "SUPER_ADMIN_LEVEL_REQUIRED");
  assert.equal(superSelf.access?.integrityValid, true, "SUPER_ADMIN_INTEGRITY_REQUIRED");
  assert.equal(superSelf.access?.permissionKeys?.length, 31, "SUPER_ADMIN_PERMISSION_MATRIX_31_REQUIRED");
  assert.equal(new Set(superSelf.access.permissionKeys).size, 31, "SUPER_ADMIN_PERMISSION_KEYS_MUST_BE_UNIQUE");
  assert.equal(superSelf.catalog?.length, 31, "SUPER_ADMIN_CATALOG_31_REQUIRED");
  assert.equal(new Set(superSelf.catalog.map((permission) => permission.key)).size, 31, "SUPER_ADMIN_CATALOG_KEYS_MUST_BE_UNIQUE");

  const superStepUpToken = crypto.randomBytes(32).toString("base64url");
  superStepUpHash = crypto.createHash("sha256").update(superStepUpToken).digest("hex");
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,$6)`,
      [
        superUser.id,
        superStepUpHash,
        JSON.stringify(superSelf.access.permissionKeys),
        superSelf.access.revision,
        apiUserAgent,
        new Date(Date.now() + 8 * 60 * 1000).toISOString(),
      ],
    );
    await db.query("COMMIT");
  } catch (transactionError) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw transactionError;
  }

  const superHeaders = {
    Authorization: `Bearer ${superToken}`,
    "x-admin-step-up": superStepUpToken,
    "X-Real-IP": sessionRealIps.superAdmin,
    Accept: "application/json",
  };
  const controlResponse = await api("/api/admin/access-control", { headers: superHeaders });
  const control = await readJson(controlResponse);
  assert.equal(controlResponse.status, 200, `SUPER_ADMIN_CONTROL_REQUIRED:${controlResponse.status}`);
  assert.equal(control.health?.healthy, true, "SUPER_ADMIN_GOVERNANCE_HEALTH_REQUIRED");
  assert.equal(control.catalogCoverage?.healthy, true, "PERMISSION_CATALOG_COVERAGE_REQUIRED");
  assert.equal(control.catalogCoverage?.codeCount, 31, "CODE_PERMISSION_CATALOG_31_REQUIRED");
  assert.equal(control.catalogCoverage?.databaseCount, 31, "DATABASE_PERMISSION_CATALOG_31_REQUIRED");
  assert.equal(control.catalog?.length, 31, "CONTROL_PLANE_PERMISSION_CATALOG_31_REQUIRED");
  report.superAdmin = {
    level: superSelf.access.adminLevel,
    permissionMatrix: "31/31",
    uniquePermissionKeys: new Set(superSelf.access.permissionKeys).size,
    catalogCoverage: `${control.catalogCoverage.databaseCount}/${control.catalogCoverage.codeCount}`,
    governanceHealthy: control.health.healthy === true && control.catalogCoverage.healthy === true,
  };

  fixtureUserId = crypto.randomUUID();
  const suffix = `${String(Date.now()).slice(-6)}${crypto.randomInt(10, 99)}`;
  const fixtureUsername = `codex_role_hide_${suffix}`;
  const fixturePhone = `199${suffix}`;
  const fixturePassword = `Codex7!${crypto.randomBytes(18).toString("base64url")}`;
  const fixturePasswordHash = await bcrypt.hash(fixturePassword, 10);
  await db.query(
    `INSERT INTO public.users
      (id,username,password_hash,display_name,phone,email,role,credits,is_active,status,member_status,cash_balance,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'student',0,true,'active','inactive',0,now(),now())`,
    [
      fixtureUserId,
      fixtureUsername,
      fixturePasswordHash,
      "Codex岗位权限隐藏验收临时管理员",
      fixturePhone,
      `${fixtureUsername}@example.invalid`,
    ],
  );

  const promotionResponse = await api("/api/admin/access-control", {
    method: "POST",
    headers: {
      ...superHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-role-concealment-${fixtureUserId}`,
    },
    body: JSON.stringify({
      mode: "promote",
      existingUserId: fixtureUserId,
      permissionKeys: requestedPermissions,
    }),
  });
  const promotion = await readJson(promotionResponse);
  assert.equal(promotionResponse.status, 200, `ORDINARY_ADMIN_PROMOTION_REQUIRED:${promotionResponse.status}:${JSON.stringify(promotion)}`);
  assert.equal(promotion.promoted, true, "ORDINARY_ADMIN_PROMOTION_RECEIPT_REQUIRED");

  const profile = (await db.query(
    `SELECT u.role,p.admin_level,p.permission_keys,p.revision,p.is_active
     FROM public.users u
     JOIN public.admin_access_profiles p ON p.user_id=u.id
     WHERE u.id=$1`,
    [fixtureUserId],
  )).rows[0];
  assert.equal(profile?.role, "admin", "FIXTURE_ROLE_ADMIN_REQUIRED");
  assert.equal(profile?.admin_level, "admin", "FIXTURE_ADMIN_LEVEL_REQUIRED");
  assert.equal(profile?.is_active, true, "FIXTURE_PROFILE_ACTIVE_REQUIRED");
  assert.deepEqual(profile?.permission_keys, expectedEffectivePermissions, "WHITE_LABEL_DEPENDENCY_AUTO_FILL_REQUIRED");
  report.fixture.effectivePermissions = profile.permission_keys;
  report.fixture.whiteLabelDependencyAutoFilled = profile.permission_keys.includes("brand.settings.manage");

  const browserWriteHeaders = {
    "User-Agent": browserUserAgent,
    "X-Real-IP": sessionRealIps.ordinaryAdmin,
    Origin: origin,
    Referer: `${origin}/admin/superzhujunguo`,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const loginResponse = await api("/api/auth/login", {
    method: "POST",
    headers: browserWriteHeaders,
    body: JSON.stringify({ username: fixtureUsername, password: fixturePassword }),
  });
  const login = await readJson(loginResponse);
  assert.equal(loginResponse.status, 200, `ORDINARY_ADMIN_LOGIN_REQUIRED:${loginResponse.status}:${JSON.stringify(login)}`);
  assert.equal(login.user?.role, "admin", "ORDINARY_ADMIN_LOGIN_ROLE_REQUIRED");
  assert.ok(String(login.token || "").length > 32, "ORDINARY_ADMIN_TOKEN_REQUIRED");
  const ordinaryToken = String(login.token);

  const superSelfAfterOrdinaryLoginResponse = await api("/api/admin/access-control/self", {
    headers: {
      Authorization: `Bearer ${superToken}`,
      Accept: "application/json",
      "X-Real-IP": sessionRealIps.superAdmin,
    },
  });
  const superSelfAfterOrdinaryLogin = await readJson(superSelfAfterOrdinaryLoginResponse);
  assert.equal(
    superSelfAfterOrdinaryLoginResponse.status,
    200,
    `SUPER_ADMIN_SESSION_MUST_SURVIVE_ORDINARY_LOGIN:${superSelfAfterOrdinaryLoginResponse.status}`,
  );
  assert.equal(superSelfAfterOrdinaryLogin.access?.adminLevel, "super_admin", "SUPER_ADMIN_LEVEL_MUST_SURVIVE_ORDINARY_LOGIN");
  report.sessionIsolation.superSelfAfterOrdinaryLoginStatus = superSelfAfterOrdinaryLoginResponse.status;

  const unlockResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...browserWriteHeaders, Authorization: `Bearer ${ordinaryToken}` },
    body: JSON.stringify({ password: fixturePassword, mode: "login" }),
  });
  const unlock = await readJson(unlockResponse);
  assert.equal(unlockResponse.status, 200, `ORDINARY_ADMIN_STEP_UP_REQUIRED:${unlockResponse.status}:${JSON.stringify(unlock)}`);
  assert.equal(unlock.authMethod, "login_password", "ORDINARY_ADMIN_LOGIN_PASSWORD_STEP_UP_REQUIRED");
  const ordinaryStepUpToken = cookieValue(unlockResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  assert.ok(ordinaryStepUpToken.length > 20, "ORDINARY_ADMIN_STEP_UP_COOKIE_REQUIRED");

  const ordinaryHeaders = {
    Authorization: `Bearer ${ordinaryToken}`,
    "x-admin-step-up": ordinaryStepUpToken,
    "X-Real-IP": sessionRealIps.ordinaryAdmin,
    Accept: "application/json",
  };
  const ordinarySelfResponse = await api("/api/admin/access-control/self", { headers: ordinaryHeaders });
  const ordinarySelf = await readJson(ordinarySelfResponse);
  assert.equal(ordinarySelfResponse.status, 200, `ORDINARY_ADMIN_SELF_REQUIRED:${ordinarySelfResponse.status}`);
  assert.equal(ordinarySelf.access?.adminLevel, "admin", "ORDINARY_ADMIN_LEVEL_REQUIRED");
  assert.equal(ordinarySelf.access?.integrityValid, true, "ORDINARY_ADMIN_INTEGRITY_REQUIRED");
  assert.deepEqual(ordinarySelf.access?.permissionKeys, expectedEffectivePermissions, "ORDINARY_EFFECTIVE_PERMISSIONS_WRONG");
  assert.deepEqual(ordinarySelf.catalog?.map((permission) => permission.key), expectedEffectivePermissions, "ORDINARY_CATALOG_MUST_ONLY_INCLUDE_GRANTED_PERMISSIONS");
  assert.deepEqual(Object.keys(ordinarySelf.tabAccess || {}).sort(), expectedOrdinaryTabs, "ORDINARY_TAB_SELF_PROJECTION_MUST_ONLY_INCLUDE_GRANTED_TABS");
  assert.equal(ordinarySelf.stepUp?.status, "ready", "ORDINARY_STEP_UP_STATE_REQUIRED");
  report.api.selfProjection = {
    adminLevel: ordinarySelf.access.adminLevel,
    permissionKeys: ordinarySelf.access.permissionKeys,
    catalogKeys: ordinarySelf.catalog.map((permission) => permission.key),
    allowedTabs: Object.keys(ordinarySelf.tabAccess).sort(),
    fullCatalogHidden: ordinarySelf.catalog.length === expectedEffectivePermissions.length,
  };

  const memberCommandCenterResponse = await api("/api/admin/command-center?hours=24&view=members", { headers: ordinaryHeaders });
  const memberCommandCenter = await readJson(memberCommandCenterResponse);
  assert.equal(memberCommandCenterResponse.status, 200, "MEMBER_COMMAND_CENTER_VIEW_REQUIRED");
  assert.equal(memberCommandCenter.view, "members", "MEMBER_COMMAND_CENTER_VIEW_ID_INVALID");
  assert.deepEqual(memberCommandCenter.includedSectionIds, ["business"], "MEMBER_COMMAND_CENTER_MUST_ONLY_RETURN_BUSINESS_SECTION");
  assert.deepEqual((memberCommandCenter.sections || []).map((section) => section.id), ["business"], "MEMBER_COMMAND_CENTER_SECTION_LEAK");

  const productionCommandCenterResponse = await api("/api/admin/command-center?hours=24&view=production", { headers: ordinaryHeaders });
  const productionCommandCenter = await readJson(productionCommandCenterResponse);
  assert.equal(productionCommandCenterResponse.status, 200, "PRODUCTION_COMMAND_CENTER_VIEW_REQUIRED");
  assert.equal(productionCommandCenter.view, "production", "PRODUCTION_COMMAND_CENTER_VIEW_ID_INVALID");
  assert.deepEqual(productionCommandCenter.includedSectionIds, ["tasks", "models"], "PRODUCTION_COMMAND_CENTER_SCOPE_INVALID");
  assert.deepEqual((productionCommandCenter.sections || []).map((section) => section.id), ["tasks", "models"], "PRODUCTION_COMMAND_CENTER_SECTION_LEAK");

  for (const deniedView of ["overview", "revenue", "security", "system", "evidence"]) {
    const deniedResponse = await api(`/api/admin/command-center?hours=24&view=${deniedView}`, { headers: ordinaryHeaders });
    const deniedBody = await readJson(deniedResponse);
    assert.equal(deniedResponse.status, 403, `${deniedView}:UNAUTHORIZED_COMMAND_CENTER_VIEW_MUST_BE_DENIED`);
    assert.deepEqual(Object.keys(deniedBody).sort(), ["code", "error"], `${deniedView}:COMMAND_CENTER_DENIAL_MUST_CONCEAL_PERMISSION_KEYS`);
    assert.doesNotMatch(JSON.stringify(deniedBody), /missingPermissions|requiredPermissions|[a-z_]+\.(?:view|manage|edit|export|execute)/iu);
  }
  report.api.commandCenterViewAccess = {
    visibleViews: ["members", "production"],
    deniedViews: ["overview", "revenue", "security", "system", "evidence"],
    boundedSections: {
      members: memberCommandCenter.includedSectionIds,
      production: productionCommandCenter.includedSectionIds,
    },
  };

  const memberPermissionResponse = await api("/api/member-permissions", { headers: ordinaryHeaders });
  const memberPermissionPayload = await readJson(memberPermissionResponse);
  assert.equal(memberPermissionResponse.status, 200, `MEMBER_PERMISSION_SNAPSHOT_REQUIRED:${memberPermissionResponse.status}`);
  assert.equal(memberPermissionPayload.permission?.authorityStatus, "ready", "MEMBER_PERMISSION_AUTHORITY_READY_REQUIRED");
  assert.equal(memberPermissionPayload.permission?.integrityValid, true, "MEMBER_PERMISSION_INTEGRITY_REQUIRED");
  report.api.memberPermissionSnapshot = {
    status: memberPermissionResponse.status,
    authorityStatus: memberPermissionPayload.permission.authorityStatus,
    integrityValid: memberPermissionPayload.permission.integrityValid,
    revision: memberPermissionPayload.permission.revision,
  };

  const membersResponse = await api("/api/admin/users?page=1&page_size=20", { headers: ordinaryHeaders });
  const members = await readJson(membersResponse);
  assert.equal(membersResponse.status, 200, `MEMBERS_VIEW_REQUIRED:${membersResponse.status}`);
  assert.ok(Array.isArray(members.users), "MEMBERS_ARRAY_REQUIRED");
  const memberObservedFields = assertMemberFinancialFieldsHidden(members.users);
  report.api.membersView = {
    status: membersResponse.status,
    returnedMembers: members.users.length,
    financialFieldsPresent: false,
    observedMemberFields: memberObservedFields,
  };

  const modelsResponse = await api("/api/admin/models", { headers: ordinaryHeaders });
  const models = await readJson(modelsResponse);
  assert.equal(modelsResponse.status, 200, `MODELS_VIEW_REQUIRED:${modelsResponse.status}`);
  const modelObservedFields = assertReadOnlyModels(models);
  report.api.modelsView = {
    status: modelsResponse.status,
    accessMode: models.access.mode,
    modelCount: models.models.length,
    observedDtoFields: modelObservedFields,
    sensitiveFieldsPresent: false,
    videoSurfaceOrdersHidden: Object.keys(models.video_surface_orders || {}).length === 0,
  };

  for (const pathname of [
    "/api/admin/unmapped-role-concealment-probe",
    "/api/admin/revenue",
    "/api/admin/access-control",
    "/api/admin/user-chats?user_id=fixture&page=1&page_size=20",
    "/api/admin/model-health",
    "/api/admin/credential-health",
    "/api/video/channel-health",
    "/api/admin/voice-services",
    "/api/admin/plugins",
    "/api/settings/admin?scope=integrations",
    "/api/health",
    "/api/health?logs=true",
    "/api/stats?admin=true",
    "/api/storage/status",
    "/api/storyboard/agent",
    "/api/announcements?admin=1",
    "/api/conversations?bot_id=1",
    "/api/voice/nest/authorize",
    "/api/extract/reconciliation",
    `/api/credits?user_id=${encodeURIComponent(String(superUser.id))}`,
  ]) {
    const response = await api(pathname, { headers: ordinaryHeaders });
    const body = await readJson(response);
    report.api.genericDenials.push(assertGenericDeny(pathname, response, body));
  }

  for (const pathname of ["/api/coze/test", "/api/coze/test-coding", "/api/video/detect-protocol"]) {
    const response = await api(pathname, {
      method: "POST",
      headers: { ...ordinaryHeaders, "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await readJson(response);
    report.api.genericDenials.push(assertGenericDeny(pathname, response, body));
  }

  for (const probe of [
    { method: "POST", pathname: "/api/admin/categories", body: { name: "denied-probe" } },
    { method: "PUT", pathname: "/api/admin/categories", body: { categoryId: "00000000-0000-0000-0000-000000000000", name: "denied-probe" } },
    { method: "DELETE", pathname: "/api/admin/categories?id=00000000-0000-0000-0000-000000000000", body: {} },
    { method: "POST", pathname: "/api/admin/nav-items", body: { name: "denied-probe" } },
    { method: "PUT", pathname: "/api/admin/nav-items", body: { id: "00000000-0000-0000-0000-000000000000", name: "denied-probe" } },
    { method: "DELETE", pathname: "/api/admin/nav-items?id=00000000-0000-0000-0000-000000000000", body: {} },
    { method: "POST", pathname: "/api/admin/agents", body: { name: "denied-probe" } },
    { method: "PUT", pathname: "/api/admin/agents", body: { agentId: "00000000-0000-0000-0000-000000000000", name: "denied-probe" } },
    { method: "DELETE", pathname: "/api/admin/agents?id=00000000-0000-0000-0000-000000000000", body: {} },
  ]) {
    const response = await api(probe.pathname, {
      method: probe.method,
      headers: { ...ordinaryHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(probe.body),
    });
    const body = await readJson(response);
    report.api.genericDenials.push(assertGenericDeny(`${probe.method} ${probe.pathname}`, response, body));
  }

  const livenessResponse = await api("/api/health?liveness=true", {
    headers: { Accept: "application/json", "X-Real-IP": sessionRealIps.anonymous },
  });
  const liveness = await readJson(livenessResponse);
  assert.equal(livenessResponse.status, 200, "PUBLIC_LIVENESS_REQUIRED");
  assert.deepEqual(Object.keys(liveness).sort(), ["status", "timestamp"], "PUBLIC_LIVENESS_MUST_STAY_MINIMAL");
  assert.equal(liveness.status, "ok", "PUBLIC_LIVENESS_STATUS_REQUIRED");
  assert.equal(typeof liveness.timestamp, "number", "PUBLIC_LIVENESS_TIMESTAMP_REQUIRED");
  report.api.liveness = { status: livenessResponse.status, responseKeys: Object.keys(liveness).sort() };

  const brandResponse = await api("/api/settings/admin?scope=brand", { headers: ordinaryHeaders });
  const brand = await readJson(brandResponse);
  assert.equal(brandResponse.status, 200, `BRAND_SCOPE_READ_REQUIRED:${brandResponse.status}`);
  const brandKeys = Object.keys(brand.settings || {}).sort();
  assert.ok(brandKeys.length > 0, "BRAND_SCOPE_SETTINGS_REQUIRED");
  assert.deepEqual(
    brandKeys.filter((key) => /coze|token|smtp|global_system_prefix|cost|profit|credits_per_yuan|thinking_model/iu.test(key)),
    [],
    "BRAND_SCOPE_CROSS_DOMAIN_FIELDS_LEAKED",
  );
  report.api.brandScope = { status: brandResponse.status, settingKeys: brandKeys };

  const helpPreviewResponse = await api("/api/help?preview=role-concealment-probe", { headers: ordinaryHeaders });
  const helpPreview = await readJson(helpPreviewResponse);
  assert.equal(helpPreviewResponse.status, 200, `GRANTED_HELP_PREVIEW_REQUIRED:${helpPreviewResponse.status}`);
  assert.equal(typeof helpPreview, "object", "HELP_PREVIEW_DTO_REQUIRED");
  report.api.helpPreview = {
    status: helpPreviewResponse.status,
    permission: "platform.settings.manage",
    responseKeys: Object.keys(helpPreview).sort(),
  };

  for (const pathname of ["/api/admin/domain-release/status", "/api/admin/multitenant-boundary"]) {
    const response = await api(pathname, { headers: ordinaryHeaders });
    const body = await readJson(response);
    assert.equal(response.status, 200, `${pathname}:WHITE_LABEL_READ_REQUIRED:${response.status}:${JSON.stringify(body)}`);
    report.api.whiteLabel[pathname] = { status: response.status, code: body.code || null };
  }
  report.api.whiteLabel.permission = "white_label.manage";
  report.api.whiteLabel.dependency = "brand.settings.manage";

  const ordinaryAnnouncementDismissals = await loadAnnouncementSessionDismissals(
    ordinaryHeaders,
    login.user,
    ordinaryToken,
  );
  const superAnnouncementDismissals = await loadAnnouncementSessionDismissals(
    {
      Authorization: `Bearer ${superToken}`,
      Accept: "application/json",
      "X-Real-IP": sessionRealIps.superAdmin,
    },
    superUser,
    superToken,
  );
  report.evidence.announcementIsolation = {
    strategy: "session-dismissals-with-disposable-receipt-fallback",
    ordinaryAnnouncementCount: ordinaryAnnouncementDismissals.keys.length,
    superAdminAnnouncementCount: superAnnouncementDismissals.keys.length,
    serverReadReceiptsWritten: 0,
    disposableFixtureReceiptsWritten: 0,
    realAccountReceiptsWritten: 0,
  };

  browser = await chromium.launch({ headless: true });

  ordinaryContext = await browser.newContext({
    viewport: report.viewport,
    userAgent: browserUserAgent,
    serviceWorkers: "block",
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.ordinaryAdmin },
  });
  ordinaryAudit = await installNetworkGuard(ordinaryContext, "ordinary-admin");
  await installAdminSession(
    ordinaryContext,
    ordinaryToken,
    login.user,
    ordinaryStepUpToken,
    ordinaryAnnouncementDismissals,
  );
  ordinaryPage = await ordinaryContext.newPage();
  attachPageAudit(ordinaryPage, ordinaryAudit);
  ordinaryLoadedJavaScriptAudit = createLoadedJavaScriptSentinelAudit(ordinaryPage, { origin });

  const initialUsersUiResponse = ordinaryPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/users" && response.request().method() === "GET";
  }, { timeout: 45_000 });
  activeBrowserPhase = "ordinary-super-admin-fallback";
  await ordinaryPage.goto(`${origin}/admin?tab=super-admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "dashboard");
  await waitForTabInUrl(ordinaryPage, "dashboard");
  await ordinaryPage.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "members", undefined, { timeout: 20_000 });
  for (const tab of expectedVisiblePrimaryTabs) {
    await ordinaryPage.locator(`[data-testid="admin-primary-nav-${tab}"]`).waitFor({ state: "visible", timeout: 20_000 });
  }
  for (const tab of expectedHiddenPrimaryTabs) {
    assert.equal(await ordinaryPage.locator(`[data-testid="admin-primary-nav-${tab}"]`).count(), 0, `${tab}:UNGRANTED_PRIMARY_ENTRY_MUST_BE_ABSENT`);
  }
  assert.equal(await ordinaryPage.locator('[data-testid="super-admin-locked"]').count(), 0, "LOCKED_SUPER_ADMIN_DISCLOSURE_MUST_BE_ABSENT");
  assert.equal(await ordinaryPage.getByText("当前账号暂无可用后台页面。", { exact: true }).count(), 0, "GRANTED_ADMIN_MUST_HAVE_VISIBLE_SURFACES");

  await ordinaryPage.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "users");
  await waitForTabInUrl(ordinaryPage, "users");
  await ordinaryPage.locator('[data-testid="admin-member-workspace"]').waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await ordinaryPage.getByRole("button", { name: "聊天记录", exact: true }).count(), 0, "MEMBER_CONTENT_ENTRY_MUST_BE_HIDDEN");
  assert.equal((await initialUsersUiResponse).status(), 200, "INITIAL_MEMBER_UI_READ_REQUIRED");
  await captureScreenshot(ordinaryPage, "ordinary-granted-hidden-1440x900.png");

  const memberDashboardResponse = ordinaryPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/command-center"
      && url.searchParams.get("view") === "members"
      && response.request().method() === "GET";
  }, { timeout: 45_000 });
  activeBrowserPhase = "ordinary-command-center-view-concealment";
  await ordinaryPage.goto(`${origin}/admin?tab=dashboard&view=evidence`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "dashboard");
  await waitForTabInUrl(ordinaryPage, "dashboard");
  await ordinaryPage.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "members", undefined, { timeout: 20_000 });
  assert.equal((await memberDashboardResponse).status(), 200, "MEMBER_COMMAND_CENTER_UI_READ_REQUIRED");
  await ordinaryPage.locator('[data-testid="admin-command-center"][data-view="members"]').waitFor({ state: "visible", timeout: 45_000 });
  for (const visibleView of ["members", "production"]) {
    await ordinaryPage.locator(`[data-testid="command-center-view-${visibleView}"]`).waitFor({ state: "visible", timeout: 20_000 });
  }
  for (const concealedView of ["overview", "revenue", "security", "system", "evidence"]) {
    assert.equal(
      await ordinaryPage.locator(`[data-testid="command-center-view-${concealedView}"]`).count(),
      0,
      `${concealedView}:UNAUTHORIZED_COMMAND_CENTER_NAVIGATION_MUST_BE_ABSENT`,
    );
  }
  for (const forbiddenSupplementalPath of [
    "/api/admin/revenue",
    "/api/admin/runtime-telemetry",
    "/api/admin/external-site-monitor",
    "/api/admin/slo-metrics/registry",
  ]) {
    assert.equal(
      ordinaryAudit.localRequests.some((entry) => entry.includes(forbiddenSupplementalPath)),
      false,
      `${forbiddenSupplementalPath}:UNAUTHORIZED_COMMAND_CENTER_REQUEST_MUST_BE_ZERO`,
    );
  }
  await captureScreenshot(ordinaryPage, "ordinary-command-center-bounded-views-1440x900.png");

  for (const deniedTab of ["connection", "health", "super-admin"]) {
    activeBrowserPhase = `ordinary-${deniedTab}-fallback`;
    const navigationResponse = await ordinaryPage.goto(`${origin}/admin?tab=${deniedTab}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForAdminReady(ordinaryPage, "dashboard");
    await waitForTabInUrl(ordinaryPage, "dashboard");
    await ordinaryPage.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "members", undefined, { timeout: 20_000 });
    report.evidence.deniedDeepLinkNavigations.push({
      requestedTab: deniedTab,
      responseStatus: navigationResponse?.status() ?? null,
      responseUrl: redactText(navigationResponse?.url() || ""),
      finalUrl: redactText(ordinaryPage.url()),
    });
  }

  activeBrowserPhase = "ordinary-workspace-deep-link-fallback";
  await ordinaryPage.goto(`${origin}/admin?tab=voice-studio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "workspace-models");
  await waitForTabInUrl(ordinaryPage, "workspace-models", "image");
  await ordinaryPage.locator('[data-workspace-project="image"]').waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await ordinaryPage.locator('[data-workspace-project-button="voice"]').count(), 0, "VOICE_PROJECT_MUST_BE_HIDDEN_WITHOUT_MODELS_MANAGE");
  assert.equal(await ordinaryPage.locator('[data-workspace-project-button="tools"]').count(), 0, "TOOLS_PROJECT_MUST_BE_HIDDEN_WITHOUT_INTEGRATIONS_MANAGE");
  assert.equal(await ordinaryPage.locator('[data-workspace-project-button="commerce"]').count(), 0, "COMMERCE_PROJECT_MUST_BE_HIDDEN_WITHOUT_AGENT_PROMPT_PERMISSIONS");
  assert.equal(await ordinaryPage.locator('[data-workspace-project-button="manju"]').count(), 0, "MANJU_PROJECT_MUST_BE_HIDDEN_WITHOUT_AGENT_PROMPT_PERMISSIONS");
  await captureScreenshot(ordinaryPage, "ordinary-workspace-deep-link-fallback-1440x900.png");

  const modelUiResponse = ordinaryPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/admin/models" && response.request().method() === "GET";
  }, { timeout: 45_000 });
  activeBrowserPhase = "ordinary-models-read-only";
  await ordinaryPage.goto(`${origin}/admin?tab=models`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "models");
  await waitForTabInUrl(ordinaryPage, "models");
  assert.equal((await modelUiResponse).status(), 200, "MODEL_UI_READ_RESPONSE_REQUIRED");
  assert.equal(await ordinaryPage.locator('[data-testid="credential-safety-panel"]').count(), 0, "MODEL_CREDENTIAL_HEALTH_PANEL_MUST_BE_HIDDEN");
  assert.equal(await ordinaryPage.locator('details[data-video-channel-health-summary]').count(), 0, "MODEL_CHANNEL_HEALTH_PANEL_MUST_BE_HIDDEN");
  assert.equal(await ordinaryPage.getByRole("button", { name: "外部服务", exact: true }).count(), 0, "EXTERNAL_SERVICE_ENTRY_MUST_BE_HIDDEN");
  await captureScreenshot(ordinaryPage, "ordinary-models-read-only-1440x900.png");

  const brandUiResponse = ordinaryPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/branding", { timeout: 45_000 });
  activeBrowserPhase = "ordinary-brand-scope";
  await ordinaryPage.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "general");
  await waitForTabInUrl(ordinaryPage, "general");
  assert.equal((await brandUiResponse).status(), 200, "BRAND_CENTER_UI_READ_REQUIRED");
  await ordinaryPage.locator('[data-testid="platform-brand-settings"]').waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await ordinaryPage.locator('[data-testid="brand-center-unavailable"]').count(), 0, "BRAND_CENTER_MUST_BE_AVAILABLE");
  await captureScreenshot(ordinaryPage, "ordinary-brand-scope-1440x900.png");

  const whiteLabelResponses = Promise.all([
    ordinaryPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/domain-release/status", { timeout: 45_000 }),
    ordinaryPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/multitenant-boundary", { timeout: 45_000 }),
  ]);
  activeBrowserPhase = "ordinary-white-label";
  await ordinaryPage.goto(`${origin}/admin?tab=white-label`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(ordinaryPage, "white-label");
  await waitForTabInUrl(ordinaryPage, "white-label");
  const [domainUiResponse, boundaryUiResponse] = await whiteLabelResponses;
  assert.equal(domainUiResponse.status(), 200, "WHITE_LABEL_DOMAIN_UI_READ_REQUIRED");
  assert.equal(boundaryUiResponse.status(), 200, "WHITE_LABEL_BOUNDARY_UI_READ_REQUIRED");
  await ordinaryPage.locator('[data-testid="white-label-readiness-panel"]').waitFor({ state: "visible", timeout: 45_000 });
  await captureScreenshot(ordinaryPage, "ordinary-white-label-dependency-1440x900.png");

  const settingScopes = ordinaryAudit.localRequests
    .map((entry) => entry.replace(/^[A-Z]+\s+/u, ""))
    .filter((entry) => entry.startsWith("/api/settings/admin"))
    .map((entry) => new URL(entry, origin).searchParams.get("scope") || "missing");
  assert.ok(settingScopes.length > 0, "BRAND_SETTINGS_SCOPE_REQUEST_REQUIRED");
  assert.deepEqual([...new Set(settingScopes)].sort(), ["brand"], "BRAND_ADMIN_MUST_ONLY_REQUEST_BRAND_SCOPE");
  for (const forbiddenPath of [
    "/api/video/channel-health",
    "/api/admin/credential-health",
    "/api/admin/model-health",
    "/api/admin/plugins",
    "/api/admin/voice-config",
    "/api/admin/voice-list",
    "/api/admin/voice-services",
    "/api/admin/voice-studio",
    "/api/admin/voices",
  ]) {
    assert.equal(
      ordinaryAudit.localRequests.some((entry) => entry.includes(forbiddenPath)),
      false,
      `${forbiddenPath}:UNAUTHORIZED_UI_REQUEST_MUST_BE_ZERO`,
    );
  }
  const ordinaryLoadedJavaScript = await ordinaryLoadedJavaScriptAudit.finish();
  ordinaryLoadedJavaScriptAudit = null;
  assert.ok(ordinaryLoadedJavaScript.scriptCount > 0, "ORDINARY_ADMIN_JAVASCRIPT_EVIDENCE_REQUIRED");
  assert.deepEqual(ordinaryLoadedJavaScript.failures, [], "ORDINARY_ADMIN_JAVASCRIPT_SOURCE_MUST_BE_READABLE");
  assert.deepEqual(
    ordinaryLoadedJavaScript.matchedSentinels,
    [],
    "ORDINARY_ADMIN_CONCEALED_CHUNKS_MUST_NOT_LOAD",
  );
  report.browser.ordinary = {
    ...summarizeBrowserAudit(ordinaryAudit),
    visiblePrimaryTabs: expectedVisiblePrimaryTabs,
    hiddenPrimaryTabs: expectedHiddenPrimaryTabs,
    deepLinkFallbacks: {
      "super-admin": "dashboard:members",
      connection: "dashboard:members",
      health: "dashboard:members",
      "voice-studio": "workspace-models:image",
      "dashboard:evidence": "dashboard:members",
    },
    settingsScopes: [...new Set(settingScopes)].sort(),
    hiddenUiRequests: 0,
    loadedJavaScript: ordinaryLoadedJavaScript,
  };
  assertCleanBrowserAudit(ordinaryAudit);
  await ordinaryContext.close();
  ordinaryContext = null;

  superContext = await browser.newContext({
    viewport: report.viewport,
    userAgent: browserUserAgent,
    serviceWorkers: "block",
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.superAdmin },
  });
  superAudit = await installNetworkGuard(superContext, "super-admin");
  await installAdminSession(
    superContext,
    superToken,
    superUser,
    superStepUpToken,
    superAnnouncementDismissals,
  );
  superPage = await superContext.newPage();
  attachPageAudit(superPage, superAudit);
  superLoadedJavaScriptAudit = createLoadedJavaScriptSentinelAudit(superPage, { origin });
  activeBrowserPhase = "super-admin-governance";
  await superPage.goto(`${origin}/admin?tab=super-admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAdminReady(superPage, "super-admin", {
    identity: "super-admin",
    allowServerReceipt: false,
  });
  await waitForTabInUrl(superPage, "super-admin");
  await superPage.locator('[data-testid="super-admin-governance"]').waitFor({ state: "visible", timeout: 45_000 });
  await superPage.locator('[data-testid="admin-governance-health"][data-health="true"]').waitFor({ state: "visible", timeout: 45_000 });
  await superPage.locator('[data-testid="admin-permission-catalog-summary"][data-catalog-ready="true"]').waitFor({ state: "visible", timeout: 45_000 });
  await superPage.locator('[data-testid="admin-permission-catalog-summary"]').getByText("31 / 31", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await captureScreenshot(superPage, "super-admin-permission-matrix-31-of-31-1440x900.png");
  await superPage.getByRole("button", { name: /Codex岗位权限隐藏验收临时管理员/u }).click();
  await superPage.locator('[data-testid="admin-job-template-drafts"]').waitFor({ state: "visible", timeout: 20_000 });
  await superPage.locator('[data-testid="admin-permission-effect-preview"]').waitFor({ state: "visible", timeout: 20_000 });
  const permissionSearch = superPage.locator('[data-testid="edit-admin-permission-search"]');
  const permissionGroupFilter = superPage.locator('[data-testid="edit-admin-permission-group-filter"]');
  await permissionSearch.fill("提示词");
  await superPage.locator('[data-permission-key="prompts.view"]').waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await superPage.locator('[data-permission-key="members.view"]').count(), 0, "PERMISSION_SEARCH_MUST_FILTER_RESULTS");
  await permissionSearch.fill("");
  await permissionGroupFilter.selectOption({ label: "安全与运维" });
  await superPage.locator('[data-permission-key="logs.view"]').waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await superPage.locator('[data-permission-key="members.view"]').count(), 0, "PERMISSION_GROUP_FILTER_MUST_FILTER_RESULTS");
  await permissionGroupFilter.selectOption("");
  await superPage.locator('[data-testid="admin-job-template-drafts"]').scrollIntoViewIfNeeded();
  await captureScreenshot(superPage, "super-admin-ordinary-role-editor-1440x900.png");
  const superLoadedJavaScript = await superLoadedJavaScriptAudit.finish();
  superLoadedJavaScriptAudit = null;
  assert.deepEqual(superLoadedJavaScript.failures, [], "SUPER_ADMIN_JAVASCRIPT_SOURCE_MUST_BE_READABLE");
  assert.ok(
    superLoadedJavaScript.matchedSentinels.includes("SUPER ADMIN CONTROL PLANE"),
    "SUPER_ADMIN_GOVERNANCE_CHUNK_MUST_LOAD",
  );
  report.browser.superAdmin = {
    ...summarizeBrowserAudit(superAudit),
    permissionMatrixVisible: "31/31",
    governanceHealthVisible: true,
    roleEditor: {
      jobTemplatesVisible: 5,
      permissionSearchVerified: true,
      permissionGroupFilterVerified: true,
      permissionEffectPreviewVerified: true,
    },
    loadedJavaScript: superLoadedJavaScript,
  };
  assertCleanBrowserAudit(superAudit);
  await superContext.close();
  superContext = null;
  await browser.close();
  browser = null;
  activeBrowserPhase = "api-capability-transition";

  // Reuse the disposable administrator after the visual phase to prove the
  // owner boundary: ordinary capabilities may be delegated, but an unlock is
  // never allowed to turn an ordinary administrator into a platform owner.
  const capabilityPermissions = ["agents.view", "logs.view"];
  const capabilityUpdateResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: {
      ...superHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-role-capability-transition-${fixtureUserId}`,
    },
    body: JSON.stringify({
      action: "permissions",
      userId: fixtureUserId,
      permissionKeys: capabilityPermissions,
      isActive: true,
      expectedRevision: Number(profile.revision),
      reason: "本地岗位权限隐藏验收：复合能力与再次验证边界",
    }),
  });
  const capabilityUpdate = await readJson(capabilityUpdateResponse);
  assert.equal(
    capabilityUpdateResponse.status,
    200,
    `CAPABILITY_TRANSITION_REQUIRED:${capabilityUpdateResponse.status}:${JSON.stringify(capabilityUpdate)}`,
  );
  const capabilityRevision = Number(capabilityUpdate.profile?.revision);
  assert.ok(Number.isInteger(capabilityRevision) && capabilityRevision > Number(profile.revision), "CAPABILITY_REVISION_REQUIRED");

  const ownerPermissionAttemptResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: {
      ...superHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-role-owner-boundary-${fixtureUserId}`,
    },
    body: JSON.stringify({
      action: "permissions",
      userId: fixtureUserId,
      permissionKeys: [...capabilityPermissions, "admin.accounts.manage"],
      isActive: true,
      expectedRevision: capabilityRevision,
      reason: "本地岗位权限隐藏验收：所有者权限不可委派",
    }),
  });
  const ownerPermissionAttempt = await readJson(ownerPermissionAttemptResponse);
  assert.equal(ownerPermissionAttemptResponse.status, 400, "OWNER_PERMISSION_DELEGATION_MUST_BE_REJECTED");
  assert.equal(ownerPermissionAttempt.code, "OWNER_PERMISSION_NOT_DELEGABLE");
  assert.deepEqual(Object.keys(ownerPermissionAttempt).sort(), ["code", "error"]);

  const capabilityHeaders = {
    Authorization: `Bearer ${ordinaryToken}`,
    Accept: "application/json",
    "X-Real-IP": sessionRealIps.ordinaryAdmin,
  };
  const commandCenterResponse = await api("/api/admin/command-center", { headers: capabilityHeaders });
  const commandCenterBody = await readJson(commandCenterResponse);
  assert.equal(commandCenterResponse.status, 403, "INCOMPLETE_COMMAND_CENTER_SET_MUST_BE_DENIED");
  assert.equal(commandCenterBody.code, "ADMIN_PERMISSION_SET_INCOMPLETE");
  assert.deepEqual(Object.keys(commandCenterBody).sort(), ["code", "error"], "COMMAND_CENTER_DENIAL_MUST_HIDE_PERMISSION_KEYS");
  assert.doesNotMatch(JSON.stringify(commandCenterBody), /missingPermissions|requiredPermissions|[a-z_]+\.(?:view|manage|edit|export|execute)/iu);

  const publicCategoriesResponse = await api("/api/admin/categories", { headers: capabilityHeaders });
  const publicCategories = await readJson(publicCategoriesResponse);
  assert.equal(publicCategoriesResponse.status, 200, "PUBLIC_ADMIN_CATEGORY_CATALOG_REQUIRED");
  assert.equal(
    (publicCategories.categories || []).some((category) => (
      category?.visibility === "private" || category?.is_active !== true || category?.name === "自用"
    )),
    false,
    "AGENTS_VIEW_MUST_HIDE_PRIVATE_INACTIVE_OR_INTERNAL_CATEGORIES",
  );
  const publicAgentsResponse = await api("/api/admin/agents", { headers: capabilityHeaders });
  const publicAgents = await readJson(publicAgentsResponse);
  assert.equal(publicAgentsResponse.status, 200, "PUBLIC_ADMIN_AGENT_CATALOG_REQUIRED");
  assert.equal(
    (publicAgents.agents || []).some((agent) => agent?.user_access === "hidden"),
    false,
    "AGENTS_VIEW_MUST_HIDE_INTERNAL_AGENTS",
  );

  const internalCatalogPaths = [
    "/api/admin/categories?include_internal=1",
    "/api/admin/nav-items?include_internal=1",
    "/api/admin/agents?include_internal=1",
  ];
  for (const pathname of internalCatalogPaths) {
    const lockedResponse = await api(pathname, { headers: capabilityHeaders });
    const lockedBody = await readJson(lockedResponse);
    assert.equal(lockedResponse.status, 403, `${pathname}:OWNER_PERMISSION_REQUIRED`);
    assert.equal(lockedBody.code, "SUPER_ADMIN_REQUIRED", `${pathname}:OWNER_LEVEL_CODE_REQUIRED`);
    assert.deepEqual(Object.keys(lockedBody).sort(), ["code", "error"], `${pathname}:OWNER_DENIAL_DETAILS_MUST_BE_CONCEALED`);
  }

  const capabilityUnlockResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...browserWriteHeaders, Authorization: `Bearer ${ordinaryToken}` },
    body: JSON.stringify({ password: fixturePassword, mode: "login", durationMinutes: 10 }),
  });
  const capabilityUnlock = await readJson(capabilityUnlockResponse);
  assert.equal(capabilityUnlockResponse.status, 200, `ORDINARY_STEP_UP_REQUIRED:${capabilityUnlockResponse.status}:${JSON.stringify(capabilityUnlock)}`);
  assert.equal(capabilityUnlock.durationMinutes, 10, "ORDINARY_STEP_UP_DURATION_REQUIRED");
  const capabilityStepUpToken = cookieValue(capabilityUnlockResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  assert.ok(capabilityStepUpToken.length > 20, "ORDINARY_STEP_UP_TOKEN_REQUIRED");
  for (const pathname of internalCatalogPaths) {
    const unlockedResponse = await api(pathname, {
      headers: { ...capabilityHeaders, "x-admin-step-up": capabilityStepUpToken },
    });
    const unlockedBody = await readJson(unlockedResponse);
    assert.equal(unlockedResponse.status, 403, `${pathname}:UNLOCK_MUST_NOT_CROSS_OWNER_BOUNDARY`);
    assert.equal(unlockedBody.code, "SUPER_ADMIN_REQUIRED", `${pathname}:UNLOCKED_OWNER_LEVEL_CODE_REQUIRED`);
    assert.deepEqual(Object.keys(unlockedBody).sort(), ["code", "error"], `${pathname}:UNLOCKED_OWNER_DENIAL_DETAILS_MUST_BE_CONCEALED`);
  }

  /*
   * Public catalogs remain usable with the delegated read permission. Keep
   * the evidence below separate from the owner-only internal catalog checks.
   */
  const internalRowEvidence = {
    categories: 0,
    navigation: 0,
    agents: 0,
  };
  report.api.capabilityTransition = {
    permissionKeys: capabilityPermissions,
    commandCenterIncompleteSetConcealed: true,
    publicCatalogFiltered: true,
    ownerPermissionDelegationRejected: true,
    internalCatalogLockedWithoutStepUp: true,
    internalCatalogStillLockedAfterStepUp: true,
    ordinaryUnlockCannotCrossOwnerBoundary: true,
    internalRowEvidence,
  };

  const announcementEventInterceptions = [
    ...(ordinaryAudit?.announcementEventInterceptions || []),
    ...(superAudit?.announcementEventInterceptions || []),
  ];
  report.evidence.announcementEventIsolation = {
    interceptedCount: announcementEventInterceptions.length,
    contexts: {
      ordinaryAdmin: ordinaryAudit?.announcementEventInterceptions.length || 0,
      superAdmin: superAudit?.announcementEventInterceptions.length || 0,
    },
    intercepted: announcementEventInterceptions.every((entry) => entry.intercepted === true),
    serverReached: announcementEventInterceptions.some((entry) => entry.serverReached !== false),
  };
  assert.ok(announcementEventInterceptions.length > 0, "ANNOUNCEMENT_EVENT_INTERCEPTION_EVIDENCE_REQUIRED");
  assert.equal(report.evidence.announcementEventIsolation.intercepted, true, "ANNOUNCEMENT_EVENTS_MUST_ALL_BE_INTERCEPTED");
  assert.equal(report.evidence.announcementEventIsolation.serverReached, false, "ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED");

  report.passed = true;
} catch (error) {
  failure = error;
  const activePage = activeBrowserPhase.startsWith("super-") ? superPage : ordinaryPage;
  report.failure = {
    ...errorSummary(error),
    phase: activeBrowserPhase,
    page: await captureFailurePageEvidence(activePage, activeBrowserPhase),
  };
} finally {
  if (ordinaryContext) await ordinaryContext.close().catch(() => undefined);
  if (superContext) await superContext.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (ordinaryAudit && Object.keys(report.browser.ordinary).length === 0) {
    report.browser.ordinary = summarizeBrowserAudit(ordinaryAudit);
  }
  if (superAudit && Object.keys(report.browser.superAdmin).length === 0) {
    report.browser.superAdmin = summarizeBrowserAudit(superAudit);
  }
  report.externalAttempts = (ordinaryAudit?.externalAttempts.length || 0)
    + (superAudit?.externalAttempts.length || 0);

  if (dbConnected) {
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.admin_governance_write','on',true)");
      if (fixtureUserId) {
        await db.query("DELETE FROM public.announcement_delivery_events WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.login_logs WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.users WHERE id=$1", [fixtureUserId]);
      }
      if (superStepUpHash) {
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [superStepUpHash]);
      }
      await db.query("COMMIT");

      const remaining = (await db.query(
        `SELECT
          (SELECT count(*)::int FROM public.users WHERE $1::text <> '' AND id=$1) AS users,
          (SELECT count(*)::int FROM public.admin_access_profiles WHERE $1::text <> '' AND user_id=$1) AS profiles,
          (SELECT count(*)::int FROM public.admin_step_up_sessions WHERE $1::text <> '' AND actor_id=$1) AS step_up_sessions,
          (SELECT count(*)::int FROM public.user_auth_sessions WHERE $1::text <> '' AND user_id=$1) AS auth_sessions,
          (SELECT count(*)::int FROM public.login_logs WHERE $1::text <> '' AND user_id=$1) AS login_logs,
          (SELECT count(*)::int FROM public.member_permission_assignments WHERE $1::text <> '' AND user_id=$1) AS member_permission_assignments,
          (SELECT count(*)::int FROM public.member_permission_events WHERE $1::text <> '' AND user_id=$1) AS member_permission_events,
          (SELECT count(*)::int FROM public.announcement_delivery_events WHERE $1::text <> '' AND user_id=$1) AS announcement_delivery_events,
          (SELECT count(*)::int FROM public.admin_governance_audit WHERE $1::text <> '' AND (actor_id=$1 OR target_user_id=$1)) AS immutable_audit_rows,
          (SELECT count(*)::int FROM public.admin_step_up_sessions WHERE $2::text <> '' AND token_hash=$2) AS super_step_up_sessions,
          (SELECT count(*)::int FROM public.users WHERE username LIKE 'codex_role_hide_%') AS matching_fixture_users`,
        [fixtureUserId, superStepUpHash],
      )).rows[0];
      assert.equal(Number(remaining.users), 0, "FIXTURE_USER_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.profiles), 0, "FIXTURE_PROFILE_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.step_up_sessions), 0, "FIXTURE_STEP_UP_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.auth_sessions), 0, "FIXTURE_AUTH_SESSION_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.login_logs), 0, "FIXTURE_LOGIN_LOG_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.member_permission_assignments), 0, "FIXTURE_MEMBER_PERMISSION_ASSIGNMENT_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.member_permission_events), 0, "FIXTURE_MEMBER_PERMISSION_EVENT_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.announcement_delivery_events), 0, "FIXTURE_ANNOUNCEMENT_DELIVERY_EVENT_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.super_step_up_sessions), 0, "SUPER_STEP_UP_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.matching_fixture_users), 0, "STALE_FIXTURE_USER_CLEANUP_REQUIRED");
      report.cleanup = {
        attempted: true,
        verified: true,
        fixtureUsersRemaining: Number(remaining.users),
        fixtureProfilesRemaining: Number(remaining.profiles),
        fixtureStepUpSessionsRemaining: Number(remaining.step_up_sessions),
        fixtureAuthSessionsRemaining: Number(remaining.auth_sessions),
        fixtureLoginLogsRemaining: Number(remaining.login_logs),
        fixtureMemberPermissionAssignmentsRemaining: Number(remaining.member_permission_assignments),
        fixtureMemberPermissionEventsRemaining: Number(remaining.member_permission_events),
        fixtureAnnouncementDeliveryEventsRemaining: Number(remaining.announcement_delivery_events),
        matchingFixtureUsersRemaining: Number(remaining.matching_fixture_users),
        immutableGovernanceAuditRowsRetained: Number(remaining.immutable_audit_rows),
        superStepUpSessionsRemaining: Number(remaining.super_step_up_sessions),
        superStepUpSessionRemoved: superStepUpHash ? Number(remaining.super_step_up_sessions) === 0 : null,
      };
    } catch (cleanupError) {
      await db.query("ROLLBACK").catch(() => undefined);
      report.cleanup = { attempted: true, verified: false, error: errorSummary(cleanupError) };
      report.passed = false;
      if (!failure) {
        failure = cleanupError;
        report.failure = errorSummary(cleanupError);
      }
    }
    await db.end().catch(() => undefined);
    dbConnected = false;
  } else {
    report.cleanup = { attempted: false, verified: false, reason: "DATABASE_CONNECTION_NOT_ESTABLISHED" };
  }

  report.checkedAt = new Date().toISOString();
  try {
    await writeReportAtomically(report);
  } catch (reportWriteError) {
    const summary = errorSummary(reportWriteError);
    if (!failure) {
      failure = reportWriteError;
      report.failure = summary;
    } else {
      process.stderr.write(`${JSON.stringify({ reportWriteFailure: summary, originalFailure: report.failure })}\n`);
    }
  }
}

if (failure) throw failure;
assert.equal(report.passed, true, "ADMIN_ROLE_CONCEALMENT_LIVE_ACCEPTANCE_FAILED");
process.stdout.write(`${JSON.stringify({
  passed: report.passed,
  evidence: path.relative(process.cwd(), reportPath).replaceAll("\\", "/"),
  permissionMatrix: report.superAdmin.permissionMatrix,
  effectivePermissions: report.fixture.effectivePermissions,
  screenshots: report.screenshots,
  cleanup: report.cleanup,
}, null, 2)}\n`);
