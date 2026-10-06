#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const actor = identity.user || {};
const databaseUrl = String(process.env.DATABASE_URL || "");
const userAgent = "Codex-Security-Investigation-Acceptance/1.0";
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 CodexSecurityInvestigation";
const evidenceDir = path.resolve(".codex-evidence", "security-investigation-live");

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.ok(actor.id, "LOCAL_ADMIN_ID_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");

await fs.mkdir(evidenceDir, { recursive: true });

const report = {
  passed: false,
  checkedAt: "",
  origin,
  source: "local-postgres-and-local-browser",
  api: {},
  browser: {},
  audit: {},
  cleanup: {},
  productionWrites: 0,
  paidCalls: 0,
  externalRequests: 0,
};

function assertPrivateHeaders(response, label) {
  assert.match(response.headers.get("cache-control") || "", /private/iu, `${label}:PRIVATE_REQUIRED`);
  assert.match(response.headers.get("cache-control") || "", /no-store/iu, `${label}:NO_STORE_REQUIRED`);
  assert.match(response.headers.get("cache-control") || "", /max-age=0/iu, `${label}:MAX_AGE_ZERO_REQUIRED`);
  assert.match(response.headers.get("vary") || "", /authorization/iu, `${label}:VARY_AUTH_REQUIRED`);
  assert.match(response.headers.get("vary") || "", /cookie/iu, `${label}:VARY_COOKIE_REQUIRED`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

async function api(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...options,
    headers: {
      "User-Agent": userAgent,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
}

async function closeAnnouncementIfVisible(page) {
  const closeButton = page.getByRole("button", { name: "关闭系统公告" });
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await closeButton.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
  }
}

const db = new pg.Client({ connectionString: databaseUrl, application_name: "codex-security-investigation-live" });
let dbConnected = false;
let stepUpToken = "";
let stepUpHash = "";
let browser;

try {
  await db.connect();
  dbConnected = true;

  const fixture = (await db.query(
    `SELECT id,event_type,path,details,user_id,ip_address,created_at
       FROM public.security_events
      WHERE ip_address = '127.0.0.1'
      ORDER BY created_at DESC
      LIMIT 1`,
  )).rows[0];
  assert.ok(fixture?.id, "A_LOCAL_LOOPBACK_SECURITY_EVENT_IS_REQUIRED");

  const selfResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const self = await readJson(selfResponse);
  assert.equal(selfResponse.status, 200, `ADMIN_SELF_REQUIRED:${selfResponse.status}`);
  assert.ok(self.access?.permissionKeys?.includes("security.manage"), "SECURITY_MANAGE_PERMISSION_REQUIRED");

  const encodedReason = encodeURIComponent("核查本机登录失败事件的网络与设备线索");
  const endpoint = `/api/admin/security-events/${fixture.id}/investigation?reason=${encodedReason}`;
  const withoutStepUp = await api(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const withoutStepUpBody = await readJson(withoutStepUp);
  assert.equal(withoutStepUp.status, 428, `STEP_UP_REQUIRED:${withoutStepUp.status}`);
  assert.equal(withoutStepUpBody.code, "ADMIN_STEP_UP_REQUIRED");
  assertPrivateHeaders(withoutStepUp, "without-step-up");

  stepUpToken = crypto.randomBytes(32).toString("base64url");
  stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const expiresAt = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.admin_governance_write','on',true)");
  await db.query(
    `INSERT INTO public.admin_step_up_sessions
      (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,$6)`,
    [actor.id, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision, userAgent, expiresAt],
  );
  await db.query("COMMIT");

  const privilegedHeaders = {
    Authorization: `Bearer ${token}`,
    "x-admin-step-up": stepUpToken,
  };
  const shortReason = await api(`/api/admin/security-events/${fixture.id}/investigation?reason=${encodeURIComponent("太短")}`, {
    headers: privilegedHeaders,
  });
  const shortReasonBody = await readJson(shortReason);
  assert.equal(shortReason.status, 400, `REASON_LENGTH_GUARD_REQUIRED:${shortReason.status}`);
  assert.equal(shortReasonBody.code, "SECURITY_INVESTIGATION_REASON_REQUIRED");
  assertPrivateHeaders(shortReason, "short-reason");

  const requestKey = `codex-security-investigation-${crypto.randomUUID()}`;
  const reveal = await api(endpoint, {
    headers: { ...privilegedHeaders, "x-request-id": requestKey },
  });
  const revealBody = await readJson(reveal);
  assert.equal(reveal.status, 200, `INVESTIGATION_REVEAL_REQUIRED:${reveal.status}:${JSON.stringify(revealBody)}`);
  assertPrivateHeaders(reveal, "reveal");
  const investigation = revealBody.investigation;
  assert.ok(investigation, "INVESTIGATION_BODY_REQUIRED");
  assert.equal(investigation.network.ipAddress, "127.0.0.1", "FULL_LOOPBACK_IP_REQUIRED");
  assert.equal(investigation.network.scope, "loopback", "LOOPBACK_SCOPE_REQUIRED");
  assert.equal(investigation.location.status, "not_applicable_local", "LOCAL_LOCATION_STATUS_REQUIRED");
  assert.equal(investigation.location.source, "network_scope_classifier", "LOCAL_LOCATION_SOURCE_REQUIRED");
  assert.equal(investigation.location.province, null, "LOCAL_PROVINCE_MUST_NOT_BE_FABRICATED");
  assert.equal(investigation.location.city, null, "LOCAL_CITY_MUST_NOT_BE_FABRICATED");
  assert.equal(investigation.location.county, null, "LOCAL_COUNTY_MUST_NOT_BE_FABRICATED");
  assert.match(investigation.location.statement, /不能据此定位到省、市或县/u, "LOCAL_LOCATION_LIMIT_REQUIRED");
  assert.ok(investigation.client?.browser && investigation.client?.os && investigation.client?.automation, "CLIENT_EVIDENCE_REQUIRED");
  assert.ok(investigation.correlations?.byNetwork && investigation.correlations?.byAccount, "CORRELATION_EVIDENCE_REQUIRED");
  assert.ok(investigation.correlations?.sessionEvidence, "SESSION_EVIDENCE_REQUIRED");
  assert.ok(Array.isArray(investigation.evidenceQuality?.limitations), "EVIDENCE_LIMITATIONS_REQUIRED");
  assert.equal(investigation.audit.permission, "security.manage");
  assert.equal(investigation.audit.stepUpVerified, true);
  if (String(fixture.path || "").replace(/\/+$/u, "") === "/api/auth/login" || /login failed/iu.test(String(fixture.details || ""))) {
    assert.match(investigation.actor.classification, /^targeting_/u, "LOGIN_FAILURE_MUST_CLASSIFY_TARGET_NOT_ATTACKER");
  }

  const auditRows = (await db.query(
    `SELECT action,result,reason_code,permission_key,resource,request_key,metadata
       FROM public.admin_governance_audit
      WHERE actor_id=$1 AND request_key=$2
      LIMIT 1`,
    [actor.id, requestKey],
  )).rows;
  assert.equal(auditRows.length, 1, "IMMUTABLE_REVEAL_AUDIT_REQUIRED");
  assert.equal(auditRows[0].action, "security_event_investigation_reveal");
  assert.equal(auditRows[0].result, "success");
  assert.equal(auditRows[0].permission_key, "security.manage");
  assert.equal(auditRows[0].resource, "security_event_investigation");
  assert.equal(auditRows[0].metadata?.eventId, fixture.id);
  assert.equal(auditRows[0].metadata?.investigationReason, "核查本机登录失败事件的网络与设备线索");

  report.api = {
    stepUpRequiredStatus: withoutStepUp.status,
    shortReasonStatus: shortReason.status,
    revealStatus: reveal.status,
    cacheControl: reveal.headers.get("cache-control"),
    vary: reveal.headers.get("vary"),
    networkScope: investigation.network.scope,
    ipAvailable: investigation.network.ipAvailability === "available",
    locationStatus: investigation.location.status,
    exactLocationFabricated: false,
    actorClassification: investigation.actor.classification,
    clientEvidence: true,
    correlationEvidence: true,
    limitationCount: investigation.evidenceQuality.limitations.length,
  };
  report.audit = {
    immutableRevealAuditRecorded: true,
    action: auditRows[0].action,
    result: auditRows[0].result,
    permission: auditRows[0].permission_key,
  };

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: browserUserAgent });
  await context.addCookies([
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await context.addInitScript(({ authToken, user }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("user_theme_preference", "lattice");
    localStorage.setItem("user_theme_mode_preference", "light");
    sessionStorage.setItem("entered_app", "1");
  }, { authToken: token, user: actor });

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const serverFailures = [];
  const externalRequests = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`); });
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== origin && !["data:", "blob:"].includes(requestUrl.protocol)) externalRequests.push(request.url());
  });

  await page.goto(`${origin}/admin?tab=security`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await closeAnnouncementIfVisible(page);
  await page.getByRole("heading", { name: "安全中心" }).waitFor({ state: "visible", timeout: 45_000 }).catch(() => undefined);
  await page.locator("[data-security-event-card]").first().waitFor({ state: "visible", timeout: 45_000 });

  const eventCard = page.locator("[data-security-event-card]").filter({ hasText: "IP: 127.0.0.*" }).first();
  await eventCard.waitFor({ state: "visible", timeout: 30_000 });
  await eventCard.getByRole("button", { name: "查看调查线索" }).click();
  const reasonInput = eventCard.locator('[data-testid="security-investigation-reason"]');
  await reasonInput.waitFor({ state: "visible", timeout: 20_000 });
  await reasonInput.fill("浏览器验收：核查本机事件的网络与设备证据");
  await eventCard.locator('[data-testid="security-investigation-reveal"]').click();
  const result = eventCard.locator("[data-security-investigation-result]");
  await result.waitFor({ state: "visible", timeout: 30_000 });
  await result.getByText("受控调查证据", { exact: true }).waitFor({ state: "visible" });

  const resultText = await result.innerText();
  for (const expected of [
    "主体归因",
    "网络线索",
    "地区与网络情报",
    "设备与自动化特征",
    "同网络关联",
    "同账号关联",
    "证据缺口与口径",
    "127.0.0.1",
    "本机回环",
    "不能据此定位到省、市或县",
  ]) assert.match(resultText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `VISIBLE_EVIDENCE_REQUIRED:${expected}`);

  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const main = document.querySelector("main");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootOverflow: root.scrollWidth - root.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  assert.deepEqual(geometry.viewport, { width: 1440, height: 900 }, "DESKTOP_VIEWPORT_REQUIRED");
  assert.ok(geometry.rootOverflow <= 1, `ROOT_HORIZONTAL_OVERFLOW:${geometry.rootOverflow}`);
  assert.ok(geometry.bodyOverflow <= 1, `BODY_HORIZONTAL_OVERFLOW:${geometry.bodyOverflow}`);
  assert.ok(geometry.mainOverflow <= 1, `MAIN_HORIZONTAL_OVERFLOW:${geometry.mainOverflow}`);

  await result.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDir, "security-investigation-revealed-1440x900.png"), fullPage: false });
  const storageBeforeHide = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  assert.doesNotMatch(JSON.stringify(storageBeforeHide), /127\.0\.0\.1/u, "RAW_IP_MUST_NOT_PERSIST_IN_BROWSER_STORAGE");

  await result.locator('[data-testid="security-investigation-hide"]').click();
  await result.waitFor({ state: "detached", timeout: 10_000 });
  const bodyAfterHide = await page.locator("body").innerText();
  assert.doesNotMatch(bodyAfterHide, /127\.0\.0\.1(?!\d)/u, "RAW_IP_MUST_BE_REMOVED_FROM_DOM_AFTER_HIDE");
  await eventCard.screenshot({ path: path.join(evidenceDir, "security-investigation-hidden.png") });

  assert.deepEqual(consoleErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(consoleErrors)}`);
  assert.deepEqual(pageErrors, [], `BROWSER_PAGE_ERRORS:${JSON.stringify(pageErrors)}`);
  assert.deepEqual(serverFailures, [], `BROWSER_SERVER_FAILURES:${JSON.stringify(serverFailures)}`);
  assert.deepEqual(externalRequests, [], `EXTERNAL_REQUESTS_FORBIDDEN:${JSON.stringify(externalRequests)}`);
  report.externalRequests = externalRequests.length;
  report.browser = {
    exactPage: "/admin?tab=security",
    viewport: "1440x900",
    controlledRevealVisible: true,
    allEvidenceSectionsVisible: true,
    rawIpAbsentFromBrowserStorage: true,
    rawIpRemovedFromDomAfterHide: true,
    horizontalOverflow: geometry,
    consoleErrors: 0,
    pageErrors: 0,
    http5xx: 0,
  };

  await context.close();
  await browser.close();
  browser = null;
  report.passed = true;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (dbConnected) {
    try {
      if (stepUpHash) {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.admin_governance_write','on',true)");
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
        await db.query("COMMIT");
      }
      const remaining = stepUpHash
        ? Number((await db.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash])).rows[0].count)
        : 0;
      assert.equal(remaining, 0, "TEMP_STEP_UP_CLEANUP_REQUIRED");
      report.cleanup = { temporaryStepUpSessionsRemaining: remaining };
    } catch (cleanupError) {
      await db.query("ROLLBACK").catch(() => undefined);
      report.cleanup = { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) };
      throw cleanupError;
    } finally {
      await db.end().catch(() => undefined);
    }
  }
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.passed, true, "SECURITY_INVESTIGATION_LIVE_ACCEPTANCE_FAILED");
console.log(`PASS security investigation live acceptance: ${JSON.stringify(report)}`);
