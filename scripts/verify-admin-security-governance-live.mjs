#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const superToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const localIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const superUser = localIdentity.user || {};
const databaseUrl = String(process.env.DATABASE_URL || "");
const userAgent = "Codex-Security-Acceptance/1.0";
const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 CodexSecurityAcceptance";
const sessionRealIps = Object.freeze({
  superAdmin: "127.0.0.1",
  ordinaryAdmin: "127.0.0.2",
  promptAdmin: "127.0.0.3",
  anonymous: "127.0.0.10",
});
const announcementEventTypes = new Set(["impression", "read", "click", "close", "remind_later"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const evidenceDir = path.resolve(".codex-evidence", "super-admin-governance");
const startedAt = new Date().toISOString();

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.ok(superToken.length > 32, "LOCAL_SUPER_ADMIN_TOKEN_REQUIRED");
assert.ok(superUser.id, "LOCAL_SUPER_ADMIN_ID_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");

await fs.mkdir(evidenceDir, { recursive: true });

const report = {
  passed: false,
  checkedAt: "",
  origin,
  anonymous: [],
  crawler: null,
  pageGuard: null,
  superAdmin: {},
  promotion: {},
  ordinaryAdmin: {},
  promptPermissionMatrix: {},
  adminLock: {},
  announcementHandling: [],
  announcementEventIsolation: {},
  sessionIsolation: {
    policy: "AUTH-SESSION-01",
    realIps: sessionRealIps,
    playwrightContextRealIps: {
      superAdmin: sessionRealIps.superAdmin,
      ordinaryAdmin: sessionRealIps.ordinaryAdmin,
      promptAdmin: sessionRealIps.promptAdmin,
      anonymous: sessionRealIps.anonymous,
    },
    superSelfAfterOrdinaryLoginStatus: null,
    superSelfAfterPromptLoginStatus: null,
  },
  browser: {},
  cleanup: {},
  productionWrites: 0,
  paidCalls: 0,
};

function safeBody(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /password_hash|coze_api_token|system_prompt|api[_-]?key\s*[":=]/iu, "SENSITIVE_FIELD_LEAKED");
  return text;
}

function assertPrivateHeaders(response, label) {
  assert.match(response.headers.get("x-robots-tag") || "", /noindex/iu, `${label}:NOINDEX_REQUIRED`);
  assert.match(response.headers.get("cache-control") || "", /no-store/iu, `${label}:NO_STORE_REQUIRED`);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function cookieValue(header, name) {
  const match = String(header || "").match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;]+)`, "u"));
  return match?.[1] || "";
}

async function api(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...options,
    headers: {
      "User-Agent": userAgent,
      "X-Real-IP": sessionRealIps.superAdmin,
      ...(options.headers || {}),
    },
  });
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installAnnouncementEventInterceptor(context, label) {
  const audit = { label, requests: [] };
  await context.route("**/api/announcements/events", async (route) => {
    const request = route.request();
    const interception = inspectAnnouncementEventRequest(request);
    audit.requests.push(interception);
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
  });
  return audit;
}

function summarizeAnnouncementEventAudits(audits) {
  const requests = audits.flatMap((audit) => audit.requests.map((request) => ({
    context: audit.label,
    ...request,
  })));
  return {
    interceptedCount: requests.length,
    contexts: Object.fromEntries(audits.map((audit) => [audit.label, audit.requests.length])),
    intercepted: requests.every((request) => request.intercepted === true),
    serverReached: requests.some((request) => request.serverReached !== false),
    requests,
  };
}

function assertAnnouncementEventIsolation(audits) {
  const summary = summarizeAnnouncementEventAudits(audits);
  assert.ok(summary.interceptedCount > 0, "ANNOUNCEMENT_EVENT_INTERCEPTION_EVIDENCE_REQUIRED");
  for (const [index, request] of summary.requests.entries()) {
    assert.equal(request.contractValid, true, `ANNOUNCEMENT_EVENT_CONTRACT_INVALID:${index}`);
    assert.equal(request.intercepted, true, `ANNOUNCEMENT_EVENT_MUST_BE_INTERCEPTED:${index}`);
    assert.equal(request.serverReached, false, `ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED:${index}`);
  }
  assert.equal(summary.intercepted, true, "ANNOUNCEMENT_EVENTS_MUST_ALL_BE_INTERCEPTED");
  assert.equal(summary.serverReached, false, "ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED");
  return summary;
}

async function settleBlockingNotifications(page, {
  identity,
  allowAnnouncementReceipt = false,
  followDeferred = true,
} = {}) {
  const reader = page.locator('[data-testid="announcement-reader"]');
  const announcementAppeared = await reader.waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  let serverReceiptsConfirmed = 0;
  let announcementClosedWithoutReceipt = false;
  if (announcementAppeared) {
    if (allowAnnouncementReceipt) {
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
    if (await reader.isVisible().catch(() => false)) {
      await reader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
      await reader.waitFor({ state: "hidden", timeout: 10_000 });
      announcementClosedWithoutReceipt = true;
    }
  }

  let accountDialogClosed = false;
  const accountCloseButton = page.getByRole("button", { name: "关闭账号消息", exact: true });
  if (await accountCloseButton.isVisible().catch(() => false)) {
    await accountCloseButton.click();
    await accountCloseButton.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    accountDialogClosed = true;
  }
  if (announcementAppeared || accountDialogClosed) {
    report.announcementHandling.push({
      identity,
      serverReceiptsConfirmed,
      announcementClosedWithoutReceipt,
      accountDialogClosed,
      durableBusinessStateChanged: serverReceiptsConfirmed > 0,
    });
  }
  if (followDeferred && accountDialogClosed && !announcementAppeared) {
    // Releasing the account-message dialog may hand the shared dialog queue
    // to a deferred system announcement. Consume that second owner too.
    await settleBlockingNotifications(page, {
      identity,
      allowAnnouncementReceipt,
      followDeferred: false,
    });
  }
}

const db = new pg.Client({ connectionString: databaseUrl, application_name: "codex-admin-security-acceptance" });
let dbConnected = false;
let stepUpToken = "";
let stepUpHash = "";
let retiredMaintenanceStepUpHash = "";
let fixtureUserId = "";
let promptFixtureUserId = "";
let promptFixtureUsername = "";
let promptFixturePassword = "";
let promptFixtureToken = "";
let maintenanceEnabled = false;
let browser;
const announcementEventAudits = [];

async function assertStepUpSessionWindow({ actorId, rawToken, responseBody, durationMinutes, label }) {
  assert.equal(responseBody.durationMinutes, durationMinutes, `${label}:UNLOCK_DURATION_RECEIPT_REQUIRED`);
  const responseExpiryMs = new Date(responseBody.expiresAt || 0).getTime();
  assert.ok(Number.isFinite(responseExpiryMs), `${label}:UNLOCK_EXPIRY_RECEIPT_REQUIRED`);
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const row = (await db.query(
    `SELECT actor_id,created_at,expires_at
       FROM public.admin_step_up_sessions
      WHERE token_hash=$1`,
    [tokenHash],
  )).rows[0];
  assert.equal(String(row?.actor_id || ""), actorId, `${label}:STEP_UP_ACTOR_REQUIRED`);
  const createdAtMs = new Date(row.created_at).getTime();
  const expiresAtMs = new Date(row.expires_at).getTime();
  const expectedLifetimeMs = durationMinutes * 60 * 1000;
  assert.ok(
    Math.abs((expiresAtMs - createdAtMs) - expectedLifetimeMs) <= 5_000,
    `${label}:STEP_UP_DB_LIFETIME_REQUIRED`,
  );
  assert.ok(Math.abs(expiresAtMs - responseExpiryMs) <= 1_000, `${label}:STEP_UP_RESPONSE_DB_EXPIRY_MUST_MATCH`);
  assert.ok(
    expiresAtMs - Date.now() > expectedLifetimeMs - 15_000
      && expiresAtMs - Date.now() <= expectedLifetimeMs + 1_000,
    `${label}:STEP_UP_REMAINING_WINDOW_REQUIRED`,
  );
  return {
    durationMinutes,
    responseMatchesDatabase: true,
    databaseLifetimeSeconds: Math.round((expiresAtMs - createdAtMs) / 1000),
  };
}

try {
  await db.connect();
  dbConnected = true;

  for (const pathname of [
    "/api/admin/users?page=1&pageSize=1",
    "/api/admin/access-control",
    "/api/admin/agents?include_prompt=1",
    "/api/settings/admin?scope=brand",
    "/api/settings/operation-password",
    "/api/admin/unmapped-security-probe",
  ]) {
    const response = await api(pathname, {
      headers: { Accept: "application/json", "X-Real-IP": sessionRealIps.anonymous },
    });
    const body = await readJson(response);
    assert.ok([401, 403].includes(response.status), `${pathname}:ANONYMOUS_MUST_BE_REJECTED:${response.status}`);
    assertPrivateHeaders(response, pathname);
    safeBody(body);
    report.anonymous.push({ pathname, status: response.status, code: body.code || null });
  }

  const crawlerResponse = await fetch(`${origin}/api/admin/users?page=1&pageSize=1`, {
    redirect: "manual",
    headers: {
      "User-Agent": "sqlmap/1.8 automated scanner",
      Accept: "application/json",
      "X-Real-IP": sessionRealIps.anonymous,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const crawlerBody = await readJson(crawlerResponse);
  assert.ok([401, 403].includes(crawlerResponse.status), `CRAWLER_MUST_BE_REJECTED:${crawlerResponse.status}`);
  safeBody(crawlerBody);
  report.crawler = { status: crawlerResponse.status, code: crawlerBody.code || null };

  const guardedPage = await api("/admin?tab=super-admin", {
    headers: { Accept: "text/html", "X-Real-IP": sessionRealIps.anonymous },
  });
  assert.ok([307, 308].includes(guardedPage.status), `ADMIN_PAGE_REDIRECT_REQUIRED:${guardedPage.status}`);
  assert.match(guardedPage.headers.get("location") || "", /\/admin\/superzhujunguo\?redirect=/u, "ADMIN_LOGIN_REDIRECT_REQUIRED");
  assertPrivateHeaders(guardedPage, "admin-page");
  report.pageGuard = { status: guardedPage.status, location: new URL(guardedPage.headers.get("location"), origin).pathname };

  const selfResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const self = await readJson(selfResponse);
  assert.equal(selfResponse.status, 200, `SUPER_ADMIN_SELF_REQUIRED:${selfResponse.status}`);
  assert.equal(self.access?.adminLevel, "super_admin", "SUPER_ADMIN_LEVEL_REQUIRED");
  assert.equal(self.access?.integrityValid, true, "SUPER_ADMIN_PROFILE_INTEGRITY_REQUIRED");
  assert.ok(Array.isArray(self.access?.permissionKeys) && self.access.permissionKeys.includes("admin.accounts.manage"), "SUPER_ADMIN_PERMISSION_REQUIRED");

  const withoutStepUp = await api("/api/admin/access-control", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const withoutStepUpBody = await readJson(withoutStepUp);
  assert.equal(withoutStepUp.status, 428, `STEP_UP_MUST_BE_REQUIRED:${withoutStepUp.status}`);
  assert.equal(withoutStepUpBody.code, "ADMIN_STEP_UP_REQUIRED");

  stepUpToken = crypto.randomBytes(32).toString("base64url");
  stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const expiresAt = new Date(Date.now() + 8 * 60 * 1000).toISOString();
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.admin_governance_write','on',true)");
  await db.query(
    `INSERT INTO public.admin_step_up_sessions
      (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,$6)`,
    [superUser.id, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision, userAgent, expiresAt],
  );
  await db.query("COMMIT");

  const superHeaders = {
    Authorization: `Bearer ${superToken}`,
    "x-admin-step-up": stepUpToken,
    "X-Real-IP": sessionRealIps.superAdmin,
    Accept: "application/json",
  };
  const controlResponse = await api("/api/admin/access-control", { headers: superHeaders });
  const control = await readJson(controlResponse);
  assert.equal(controlResponse.status, 200, `SUPER_ADMIN_CONTROL_REQUIRED:${controlResponse.status}`);
  assert.equal(control.health?.healthy, true, "ADMIN_GOVERNANCE_HEALTH_REQUIRED");
  assert.ok(Array.isArray(control.candidates), "REGISTERED_MEMBER_CANDIDATES_REQUIRED");
  assert.doesNotMatch(JSON.stringify(control.candidates), /password_hash/iu, "CANDIDATE_PASSWORD_HASH_MUST_NOT_LEAK");
  report.superAdmin = {
    level: self.access.adminLevel,
    permissionCount: self.access.permissionKeys.length,
    candidateCount: control.candidates.length,
    health: control.health?.healthy === true,
    stepUpRequiredWithoutSession: withoutStepUp.status,
  };

  const protectedPrompts = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  assert.equal(protectedPrompts.status, 428, `PROMPT_VIEW_STEP_UP_REQUIRED:${protectedPrompts.status}`);
  const visiblePrompts = await api("/api/admin/agents?include_prompt=1", { headers: superHeaders });
  const visiblePromptBody = await readJson(visiblePrompts);
  assert.equal(visiblePrompts.status, 200, `PROMPT_VIEW_WITH_STEP_UP_REQUIRED:${visiblePrompts.status}`);
  assert.equal(visiblePromptBody.promptAccess, "visible", "PROMPT_ACCESS_RECEIPT_REQUIRED");

  fixtureUserId = crypto.randomUUID();
  const suffix = String(Date.now()).slice(-8);
  const fixtureUsername = `codex_security_${suffix}`;
  const fixturePhone = `199${suffix}`;
  const fixturePassword = `Codex!${crypto.randomBytes(18).toString("base64url")}`;
  const fixturePasswordHash = await bcrypt.hash(fixturePassword, 10);
  await db.query(
    `INSERT INTO public.users
      (id,username,password_hash,display_name,phone,email,role,credits,is_active,status,member_status,cash_balance,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'student',0,true,'active','inactive',0,now(),now())`,
    [fixtureUserId, fixtureUsername, fixturePasswordHash, "Codex安全验收临时会员", fixturePhone, `${fixtureUsername}@example.invalid`],
  );

  const promotionResponse = await api("/api/admin/access-control", {
    method: "POST",
    headers: {
      ...superHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-security-promotion-${fixtureUserId}`,
    },
    body: JSON.stringify({
      mode: "promote",
      existingUserId: fixtureUserId,
      permissionKeys: ["members.view", "members.manage"],
    }),
  });
  const promotion = await readJson(promotionResponse);
  assert.equal(promotionResponse.status, 200, `REGISTERED_MEMBER_PROMOTION_REQUIRED:${promotionResponse.status}:${JSON.stringify(promotion)}`);
  assert.equal(promotion.promoted, true);
  const promoted = (await db.query(
    `SELECT u.role,p.admin_level,p.permission_keys,p.revision
     FROM public.users u JOIN public.admin_access_profiles p ON p.user_id=u.id WHERE u.id=$1`,
    [fixtureUserId],
  )).rows[0];
  assert.equal(promoted?.role, "admin");
  assert.equal(promoted?.admin_level, "admin");
  assert.deepEqual(promoted?.permission_keys, ["members.view", "members.manage"]);
  report.promotion = { success: true, formerRole: "student", assignedPermissions: promoted.permission_keys };

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
  assert.equal(loginResponse.status, 200, `PROMOTED_ADMIN_LOGIN_REQUIRED:${loginResponse.status}:${JSON.stringify(login)}`);
  assert.equal(login.user?.role, "admin", "PROMOTED_ACCOUNT_MUST_LOGIN_AS_ADMIN");
  assert.ok(String(login.token || "").length > 32, "PROMOTED_ADMIN_TOKEN_REQUIRED");
  const ordinaryToken = String(login.token);
  const ordinaryHeaders = {
    Authorization: `Bearer ${ordinaryToken}`,
    Accept: "application/json",
    "X-Real-IP": sessionRealIps.ordinaryAdmin,
  };

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
    body: JSON.stringify({ password: fixturePassword, mode: "login", durationMinutes: 10 }),
  });
  const unlock = await readJson(unlockResponse);
  assert.equal(unlockResponse.status, 200, `ORDINARY_ADMIN_PASSWORD_UNLOCK_REQUIRED:${unlockResponse.status}:${JSON.stringify(unlock)}`);
  assert.equal(unlock.authMethod, "login_password", "LOGIN_PASSWORD_UNLOCK_RECEIPT_REQUIRED");
  assert.match(unlockResponse.headers.get("set-cookie") || "", /zimeiti_admin_step_up=.*HttpOnly.*SameSite=Strict/iu, "STEP_UP_COOKIE_MUST_BE_HTTPONLY_STRICT");
  const ordinaryStepUpToken = cookieValue(unlockResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  assert.ok(ordinaryStepUpToken.length > 20, "ORDINARY_STEP_UP_COOKIE_REQUIRED");
  report.adminLock.tenMinutes = await assertStepUpSessionWindow({
    actorId: fixtureUserId,
    rawToken: ordinaryStepUpToken,
    responseBody: unlock,
    durationMinutes: 10,
    label: "ORDINARY_ADMIN_10_MINUTES",
  });

  const ordinaryMembers = await api("/api/admin/users?page=1&pageSize=1", {
    headers: ordinaryHeaders,
  });
  assert.equal(ordinaryMembers.status, 200, `ORDINARY_MEMBERS_VIEW_REQUIRED:${ordinaryMembers.status}`);
  const deniedControl = await api("/api/admin/access-control", {
    headers: ordinaryHeaders,
  });
  const deniedControlBody = await readJson(deniedControl);
  assert.equal(deniedControl.status, 403, `ORDINARY_SUPER_CONTROL_MUST_BE_DENIED:${deniedControl.status}`);
  assert.equal(deniedControlBody.code, "SUPER_ADMIN_REQUIRED");
  const deniedSettings = await api("/api/settings/admin?scope=brand", {
    headers: ordinaryHeaders,
  });
  assert.equal(deniedSettings.status, 403, `ORDINARY_SETTINGS_MUST_BE_DENIED:${deniedSettings.status}`);
  const deniedPrompts = await api("/api/admin/agents?include_prompt=1", {
    headers: ordinaryHeaders,
  });
  assert.equal(deniedPrompts.status, 403, `ORDINARY_PROMPTS_MUST_BE_DENIED:${deniedPrompts.status}`);
  report.ordinaryAdmin = {
    dedicatedPasswordLogin: loginResponse.status,
    loginPasswordStepUp: unlockResponse.status,
    allowedMembersView: ordinaryMembers.status,
    deniedSuperControl: deniedControl.status,
    deniedSettings: deniedSettings.status,
    deniedPrompts: deniedPrompts.status,
  };

  // Exact owner-only prompt boundary. This uses a second disposable ordinary
  // administrator and proves that neither step-up nor maintenance mode can
  // turn a stale/requested prompts.view grant into readable prompt content.
  promptFixtureUserId = crypto.randomUUID();
  const promptSuffix = String(Date.now()).slice(-8);
  promptFixtureUsername = `codex_prompt_matrix_${promptSuffix}`;
  promptFixturePassword = `Codex!${crypto.randomBytes(18).toString("base64url")}`;
  const promptFixturePasswordHash = await bcrypt.hash(promptFixturePassword, 10);
  await db.query(
    `INSERT INTO public.users
      (id,username,password_hash,display_name,phone,email,role,credits,is_active,status,member_status,cash_balance,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'student',0,true,'active','inactive',0,now(),now())`,
    [
      promptFixtureUserId,
      promptFixtureUsername,
      promptFixturePasswordHash,
      "Codex提示词权限矩阵临时管理员",
      `198${promptSuffix}`,
      `${promptFixtureUsername}@example.invalid`,
    ],
  );
  const promptPromotionResponse = await api("/api/admin/access-control", {
    method: "POST",
    headers: {
      ...superHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-prompt-matrix-${promptFixtureUserId}`,
    },
    body: JSON.stringify({
      mode: "promote",
      existingUserId: promptFixtureUserId,
      permissionKeys: ["agents.view"],
    }),
  });
  const promptPromotion = await readJson(promptPromotionResponse);
  assert.equal(promptPromotionResponse.status, 200, `PROMPT_MATRIX_PROMOTION_REQUIRED:${promptPromotionResponse.status}:${JSON.stringify(promptPromotion)}`);

  const promptBrowserWriteHeaders = {
    ...browserWriteHeaders,
    "X-Real-IP": sessionRealIps.promptAdmin,
  };
  const promptLoginResponse = await api("/api/auth/login", {
    method: "POST",
    headers: promptBrowserWriteHeaders,
    body: JSON.stringify({ username: promptFixtureUsername, password: promptFixturePassword }),
  });
  const promptLogin = await readJson(promptLoginResponse);
  assert.equal(promptLoginResponse.status, 200, `PROMPT_MATRIX_LOGIN_REQUIRED:${promptLoginResponse.status}:${JSON.stringify(promptLogin)}`);
  promptFixtureToken = String(promptLogin.token || "");
  assert.ok(promptFixtureToken.length > 32, "PROMPT_MATRIX_TOKEN_REQUIRED");
  const promptHeaders = {
    Authorization: `Bearer ${promptFixtureToken}`,
    Accept: "application/json",
    "X-Real-IP": sessionRealIps.promptAdmin,
  };

  const superSelfAfterPromptLoginResponse = await api("/api/admin/access-control/self", {
    headers: {
      Authorization: `Bearer ${superToken}`,
      Accept: "application/json",
      "X-Real-IP": sessionRealIps.superAdmin,
    },
  });
  const superSelfAfterPromptLogin = await readJson(superSelfAfterPromptLoginResponse);
  assert.equal(
    superSelfAfterPromptLoginResponse.status,
    200,
    `SUPER_ADMIN_SESSION_MUST_SURVIVE_PROMPT_LOGIN:${superSelfAfterPromptLoginResponse.status}`,
  );
  assert.equal(superSelfAfterPromptLogin.access?.adminLevel, "super_admin", "SUPER_ADMIN_LEVEL_MUST_SURVIVE_PROMPT_LOGIN");
  report.sessionIsolation.superSelfAfterPromptLoginStatus = superSelfAfterPromptLoginResponse.status;

  const promptUnlockResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...promptBrowserWriteHeaders, Authorization: `Bearer ${promptFixtureToken}` },
    body: JSON.stringify({ password: promptFixturePassword, mode: "login", durationMinutes: 20 }),
  });
  const promptUnlock = await readJson(promptUnlockResponse);
  assert.equal(promptUnlockResponse.status, 200, `PROMPT_MATRIX_INITIAL_UNLOCK_REQUIRED:${promptUnlockResponse.status}:${JSON.stringify(promptUnlock)}`);
  const promptStepUpToken = cookieValue(promptUnlockResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  assert.ok(promptStepUpToken.length > 20, "PROMPT_MATRIX_INITIAL_STEP_UP_COOKIE_REQUIRED");
  report.adminLock.twentyMinutes = await assertStepUpSessionWindow({
    actorId: promptFixtureUserId,
    rawToken: promptStepUpToken,
    responseBody: promptUnlock,
    durationMinutes: 20,
    label: "PROMPT_ADMIN_20_MINUTES",
  });

  const onlyAgentsUnlocked = await api("/api/admin/agents?include_prompt=1", {
    headers: { ...promptHeaders, "x-admin-step-up": promptStepUpToken },
  });
  assert.equal(onlyAgentsUnlocked.status, 403, `ONLY_AGENTS_WITH_STEP_UP_MUST_NOT_READ_PROMPTS:${onlyAgentsUnlocked.status}`);

  const promptProfileBefore = (await db.query(
    "SELECT to_jsonb(profile) AS snapshot FROM public.admin_access_profiles profile WHERE user_id=$1",
    [promptFixtureUserId],
  )).rows[0]?.snapshot;
  assert.ok(promptProfileBefore, "PROMPT_PROFILE_BEFORE_REQUIRED");
  const grantPromptsResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: { ...superHeaders, "Content-Type": "application/json", "Idempotency-Key": `codex-prompt-grant-${promptFixtureUserId}` },
    body: JSON.stringify({
      action: "permissions",
      userId: promptFixtureUserId,
      permissionKeys: ["agents.view", "admin.accounts.manage"],
      isActive: true,
      expectedRevision: Number(promptProfileBefore.revision),
      reason: "所有者权限边界验收：尝试向普通管理员授予管理员授权控制权",
    }),
  });
  const grantPrompts = await readJson(grantPromptsResponse);
  assert.equal(grantPromptsResponse.status, 400, `PROMPT_MATRIX_ATOMIC_REJECTION_REQUIRED:${grantPromptsResponse.status}:${JSON.stringify(grantPrompts)}`);
  assert.equal(grantPrompts.code, "OWNER_PERMISSION_NOT_DELEGABLE", "PROMPT_MATRIX_OWNER_PERMISSION_CODE_REQUIRED");
  assert.deepEqual(Object.keys(grantPrompts).sort(), ["code", "error"], "PROMPT_MATRIX_REJECTION_DETAILS_MUST_BE_CONCEALED");
  const promptProfileAfter = (await db.query(
    "SELECT to_jsonb(profile) AS snapshot FROM public.admin_access_profiles profile WHERE user_id=$1",
    [promptFixtureUserId],
  )).rows[0]?.snapshot;
  assert.deepEqual(promptProfileAfter, promptProfileBefore, "PROMPT_MATRIX_REJECTION_MUST_BE_ATOMIC");

  const promptSelfAfterGrantResponse = await api("/api/admin/access-control/self", {
    headers: promptHeaders,
  });
  const promptSelfAfterGrant = await readJson(promptSelfAfterGrantResponse);
  assert.equal(promptSelfAfterGrantResponse.status, 200, `PROMPT_MATRIX_SELF_REQUIRED:${promptSelfAfterGrantResponse.status}`);
  assert.equal(promptSelfAfterGrant.access?.permissionKeys?.includes("agents.view"), true, "AGENTS_VIEW_MUST_REMAIN_GRANTED");
  assert.equal(promptSelfAfterGrant.access?.permissionKeys?.includes("prompts.view"), false, "OWNER_ONLY_PROMPT_GRANT_MUST_BE_STRIPPED");

  const promptsLocked = await api("/api/admin/agents?include_prompt=1", {
    headers: promptHeaders,
  });
  const promptsLockedBody = await readJson(promptsLocked);
  assert.equal(promptsLocked.status, 403, `PROMPTS_WITHOUT_STEP_UP_MUST_BE_OWNER_DENIED:${promptsLocked.status}`);
  assert.equal(promptsLockedBody.code, "SUPER_ADMIN_REQUIRED", "PROMPTS_OWNER_LEVEL_CODE_REQUIRED");

  const promptsWithStepUp = await api("/api/admin/agents?include_prompt=1", {
    headers: { ...promptHeaders, "x-admin-step-up": promptStepUpToken },
  });
  const promptsWithStepUpBody = await readJson(promptsWithStepUp);
  assert.equal(promptsWithStepUp.status, 403, `STEP_UP_MUST_NOT_CROSS_PROMPT_OWNER_BOUNDARY:${promptsWithStepUp.status}`);
  assert.equal(promptsWithStepUpBody.code, "SUPER_ADMIN_REQUIRED", "STEP_UP_OWNER_LEVEL_CODE_REQUIRED");

  const maintenanceStateResponse = await api("/api/admin/access-control/maintenance-lock", { headers: superHeaders });
  const maintenanceState = await readJson(maintenanceStateResponse);
  assert.equal(maintenanceStateResponse.status, 200, `MAINTENANCE_STATE_REQUIRED:${maintenanceStateResponse.status}:${JSON.stringify(maintenanceState)}`);
  assert.equal(maintenanceState.state?.enabled, false, "MAINTENANCE_MUST_START_DISABLED");
  const enableMaintenanceResponse = await api("/api/admin/access-control/maintenance-lock", {
    method: "PATCH",
    headers: { ...superHeaders, "Content-Type": "application/json", "Idempotency-Key": `codex-maintenance-enable-${promptFixtureUserId}` },
    body: JSON.stringify({
      enabled: true,
      reason: "提示词权限矩阵本地限时验收",
      durationMinutes: 10,
      expectedRevision: maintenanceState.state.revision,
    }),
  });
  const enableMaintenance = await readJson(enableMaintenanceResponse);
  assert.equal(enableMaintenanceResponse.status, 200, `MAINTENANCE_ENABLE_REQUIRED:${enableMaintenanceResponse.status}:${JSON.stringify(enableMaintenance)}`);
  maintenanceEnabled = true;

  const onlyAgentsMaintenance = await api("/api/admin/agents?include_prompt=1", {
    headers: promptHeaders,
  });
  assert.equal(onlyAgentsMaintenance.status, 403, `MAINTENANCE_MUST_NOT_BYPASS_PROMPTS_PERMISSION:${onlyAgentsMaintenance.status}`);

  const promptsWithMaintenance = await api("/api/admin/agents?include_prompt=1", {
    headers: promptHeaders,
  });
  const promptsWithMaintenanceBody = await readJson(promptsWithMaintenance);
  assert.equal(promptsWithMaintenance.status, 403, `MAINTENANCE_MUST_NOT_CROSS_PROMPT_OWNER_BOUNDARY:${promptsWithMaintenance.status}`);
  assert.equal(promptsWithMaintenanceBody.code, "SUPER_ADMIN_REQUIRED", "MAINTENANCE_OWNER_LEVEL_CODE_REQUIRED");
  const promptSelfMaintenanceResponse = await api("/api/admin/access-control/self", {
    headers: promptHeaders,
  });
  const promptSelfMaintenance = await readJson(promptSelfMaintenanceResponse);
  assert.equal(promptSelfMaintenance.stepUp?.status, "maintenance", "ORDINARY_ADMIN_MAINTENANCE_STATUS_REQUIRED");
  assert.equal(promptSelfMaintenance.access?.permissionKeys?.includes("prompts.view"), false, "MAINTENANCE_MUST_NOT_EXPOSE_OWNER_PERMISSION");
  report.promptPermissionMatrix = {
    mixedAgentsAndPromptsGrant: {
      status: grantPromptsResponse.status,
      code: grantPrompts.code,
      atomicProfileUnchanged: true,
      selfContainsAgentsView: true,
      selfContainsPromptsView: false,
    },
    onlyAgentsWithStepUp: onlyAgentsUnlocked.status,
    promptsWithoutStepUp: promptsLocked.status,
    promptsWithStepUp: promptsWithStepUp.status,
    onlyAgentsWithMaintenance: onlyAgentsMaintenance.status,
    promptsWithMaintenance: promptsWithMaintenance.status,
    ownerBoundary: "super_admin_only",
  };

  browser = await chromium.launch({ headless: true });
  const anonymousContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent,
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.anonymous },
  });
  const anonymousPage = await anonymousContext.newPage();
  const anonymousErrors = [];
  anonymousPage.on("console", (message) => { if (message.type() === "error") anonymousErrors.push(message.text()); });
  await anonymousPage.goto(`${origin}/admin?tab=super-admin`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await anonymousPage.waitForURL(/\/admin\/superzhujunguo/u, { timeout: 20_000 });
  await anonymousPage.locator('[data-testid="admin-login-page"]').waitFor({ state: "visible", timeout: 20_000 });
  await anonymousPage.getByRole("tab", { name: "账号登录" }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await anonymousPage.locator('[role="tab"]').count(), 1, "ADMIN_LOGIN_MUST_ONLY_SHOW_PASSWORD_MODE");
  assert.equal(await anonymousPage.getByText("注册", { exact: true }).count(), 0, "ADMIN_PUBLIC_REGISTRATION_MUST_BE_HIDDEN");
  await anonymousPage.screenshot({ path: path.join(evidenceDir, "admin-login-1440x900.png"), fullPage: true });
  await anonymousContext.close();

  const ordinaryContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent,
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.ordinaryAdmin },
  });
  announcementEventAudits.push(await installAnnouncementEventInterceptor(ordinaryContext, "ordinary-admin"));
  await ordinaryContext.addCookies([
    { name: "auth_token", value: ordinaryToken, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  await ordinaryContext.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: ordinaryToken, user: login.user });
  const ordinaryPage = await ordinaryContext.newPage();
  await ordinaryPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(ordinaryPage, {
    identity: "ordinary-admin",
    allowAnnouncementReceipt: true,
  });
  await ordinaryPage.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  const ordinarySidebarEntry = ordinaryPage.locator('[data-testid="sidebar-admin-entry"]');
  await ordinarySidebarEntry.waitFor({ state: "visible", timeout: 30_000 });
  await ordinaryPage.screenshot({ path: path.join(evidenceDir, "ordinary-admin-sidebar-entry-1440x900.png"), fullPage: true });
  await ordinarySidebarEntry.click();
  await ordinaryPage.waitForURL((url) => url.pathname === "/admin", { timeout: 45_000 });
  await ordinaryContext.close();

  const promptContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent,
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.promptAdmin },
  });
  announcementEventAudits.push(await installAnnouncementEventInterceptor(promptContext, "prompt-admin"));
  await promptContext.addCookies([
    { name: "auth_token", value: promptFixtureToken, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  await promptContext.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: promptFixtureToken, user: promptLogin.user });
  const promptPage = await promptContext.newPage();
  const promptBrowserErrors = [];
  const promptServerFailures = [];
  promptPage.on("console", (message) => { if (message.type() === "error") promptBrowserErrors.push(message.text()); });
  promptPage.on("response", (response) => { if (response.status() >= 500) promptServerFailures.push(`${response.status()} ${response.url()}`); });
  await promptPage.goto(`${origin}/admin?tab=agents&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(promptPage, {
    identity: "prompt-admin",
    allowAnnouncementReceipt: true,
  });
  await promptPage.locator('[data-testid="admin-maintenance-mode-banner"]').waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await promptPage.locator('[data-testid="admin-prompt-access-maintenance"]').count(), 0, "ORDINARY_ADMIN_MUST_NOT_RECEIVE_PROMPT_MAINTENANCE_ACCESS");
  const targetAgentRow = promptPage.getByRole("row", { name: /3D故事导演｜高能版/u });
  await targetAgentRow.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await targetAgentRow.getByRole("button", { name: "查看提示词" }).count(), 0, "ORDINARY_ADMIN_PROMPT_BUTTON_MUST_NOT_RENDER");
  assert.equal(await promptPage.locator('[data-testid="admin-agent-prompt-readonly"]').count(), 0, "ORDINARY_ADMIN_PROMPT_BODY_MUST_NOT_RENDER");
  await promptPage.screenshot({ path: path.join(evidenceDir, "ordinary-admin-prompt-owner-denied-1440x900.png"), fullPage: true });
  assert.deepEqual(promptBrowserErrors, [], `PROMPT_BROWSER_CONSOLE_ERRORS:${JSON.stringify(promptBrowserErrors)}`);
  assert.deepEqual(promptServerFailures, [], `PROMPT_BROWSER_SERVER_FAILURES:${JSON.stringify(promptServerFailures)}`);
  await promptContext.close();

  const superContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent,
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.superAdmin },
  });
  announcementEventAudits.push(await installAnnouncementEventInterceptor(superContext, "super-admin"));
  await superContext.addCookies([
    { name: "auth_token", value: superToken, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await superContext.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: superToken, user: superUser });
  const superHomePage = await superContext.newPage();
  await superHomePage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(superHomePage, { identity: "super-admin" });
  await superHomePage.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  const superSidebarEntry = superHomePage.locator('[data-testid="sidebar-admin-entry"]');
  await superSidebarEntry.waitFor({ state: "visible", timeout: 30_000 });
  await superHomePage.screenshot({ path: path.join(evidenceDir, "super-admin-sidebar-entry-1440x900.png"), fullPage: true });
  await superSidebarEntry.click();
  await superHomePage.waitForURL((url) => url.pathname === "/admin", { timeout: 45_000 });
  await superHomePage.close();
  const superPage = await superContext.newPage();
  const browserErrors = [];
  const serverFailures = [];
  superPage.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  superPage.on("response", (response) => { if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`); });
  await superPage.goto(`${origin}/admin?tab=super-admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await superPage.locator('[data-testid="super-admin-governance"]').waitFor({ state: "visible", timeout: 45_000 });
  await superPage.locator('[data-testid="admin-login-entry-card"]').waitFor({ state: "visible" });
  await superPage.locator('[data-testid="admin-governance-health"][data-health="true"]').waitFor({ state: "visible", timeout: 30_000 });
  await superPage.screenshot({ path: path.join(evidenceDir, "super-admin-governance-1440x900.png"), fullPage: true });
  await superPage.getByRole("button", { name: "添加管理员" }).click();
  await superPage.locator('[data-testid="add-administrator-dialog"]').waitFor({ state: "visible" });
  await superPage.locator('[data-testid="registered-member-admin-picker"]').waitFor({ state: "visible" });
  await superPage.getByRole("tab", { name: "新建内部管理员账号" }).click();
  await superPage.getByText("初始密码", { exact: false }).waitFor({ state: "visible" });
  await superPage.getByRole("tab", { name: "从已注册会员添加" }).click();
  await superPage.screenshot({ path: path.join(evidenceDir, "add-existing-member-admin-1440x900.png"), fullPage: true });

  const modelPage = await superContext.newPage();
  await modelPage.setViewportSize({ width: 1600, height: 1000 });
  modelPage.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  modelPage.on("response", (response) => { if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`); });
  await modelPage.goto(`${origin}/admin?tab=agents&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(modelPage, { identity: "super-admin" });
  const modelAgentRow = modelPage.getByRole("row", { name: /3D故事导演｜高能版/u });
  await modelAgentRow.waitFor({ state: "visible", timeout: 45_000 });
  await modelAgentRow.getByRole("button", { name: "编辑", exact: true }).click();
  const agentEditDialog = modelPage.locator('[data-testid="admin-agent-edit-dialog"]');
  const agentModelSelect = modelPage.locator('[data-testid="admin-agent-model-select"]');
  await agentEditDialog.waitFor({ state: "visible", timeout: 20_000 });
  await agentModelSelect.waitFor({ state: "visible", timeout: 20_000 });
  await modelPage.waitForFunction(() => {
    const select = document.querySelector('[data-testid="admin-agent-model-select"]');
    const text = select?.textContent || "";
    return text.includes("GPT-6.1 Sol") && text.includes("Claude Opus 5.5") && text.includes("Claude Sonnet 5.5");
  }, undefined, { timeout: 30_000 });
  const modelOptionsText = await agentModelSelect.locator("option").allTextContents();
  for (const expectedModel of ["GPT-6.1 Sol", "Claude Opus 5.5", "Claude Sonnet 5.5"]) {
    assert.ok(modelOptionsText.some((option) => option.includes(expectedModel)), `MODEL_OPTION_MISSING:${expectedModel}`);
  }
  await agentModelSelect.scrollIntoViewIfNeeded();
  await agentModelSelect.focus();
  const modelViewportOverflow = await modelPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(modelViewportOverflow, false, "MODEL_EDIT_DIALOG_HORIZONTAL_OVERFLOW");
  await modelPage.screenshot({ path: path.join(evidenceDir, "agent-model-options-1600x1000.png"), fullPage: false });
  await modelPage.close();
  assert.deepEqual(browserErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(browserErrors)}`);
  assert.deepEqual(serverFailures, [], `BROWSER_SERVER_FAILURES:${JSON.stringify(serverFailures)}`);
  report.browser = {
    anonymousRedirectedToDedicatedLogin: true,
    ordinaryAdminSidebarEntryVisible: true,
    superAdminSidebarEntryVisible: true,
    adminEntryInsideAccountMenu: true,
    superAdminPanelVisible: true,
    existingMemberPickerVisible: true,
    ordinaryPromptOwnerDenied: true,
    targetAgentModelOptionsVisible: true,
    targetAgentModelOptions: ["GPT-6.1 Sol", "Claude Opus 5.5", "Claude Sonnet 5.5"],
    desktopViewports: ["1440x900", "1600x1000"],
    consoleErrors: 0,
    http5xx: 0,
  };
  await superContext.close();

  const currentMaintenanceResponse = await api("/api/admin/access-control/maintenance-lock", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const currentMaintenance = await readJson(currentMaintenanceResponse);
  assert.equal(currentMaintenanceResponse.status, 200, "MAINTENANCE_CLEANUP_STATE_REQUIRED");
  const disableMaintenanceResponse = await api("/api/admin/access-control/maintenance-lock", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${superToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": `codex-maintenance-cleanup-${promptFixtureUserId}`,
    },
    body: JSON.stringify({
      enabled: false,
      reason: "提示词权限矩阵验收完成，恢复全部二次验证锁",
      expectedRevision: currentMaintenance.state.revision,
    }),
  });
  assert.equal(disableMaintenanceResponse.status, 200, `MAINTENANCE_CLEANUP_REQUIRED:${disableMaintenanceResponse.status}`);
  maintenanceEnabled = false;

  const maintenanceRevokedStepUp = (await db.query(
    `SELECT revoked_at
       FROM public.admin_step_up_sessions
      WHERE token_hash=$1`,
    [stepUpHash],
  )).rows[0];
  assert.ok(maintenanceRevokedStepUp?.revoked_at, "MAINTENANCE_DISABLE_MUST_REVOKE_PREEXISTING_STEP_UP");
  retiredMaintenanceStepUpHash = stepUpHash;
  stepUpToken = crypto.randomBytes(32).toString("base64url");
  stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const manualRelockExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.admin_governance_write','on',true)");
  await db.query(
    `INSERT INTO public.admin_step_up_sessions
      (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,$6)`,
    [superUser.id, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision, userAgent, manualRelockExpiresAt],
  );
  await db.query("COMMIT");
  superHeaders["x-admin-step-up"] = stepUpToken;
  report.adminLock.maintenanceBoundaryReauthentication = {
    preexistingSessionRevoked: true,
    freshSessionIssuedForManualRelock: true,
    durationMinutes: 10,
  };

  const unlockContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent,
    extraHTTPHeaders: { "X-Real-IP": sessionRealIps.superAdmin },
  });
  announcementEventAudits.push(await installAnnouncementEventInterceptor(unlockContext, "super-admin-manual-relock"));
  await unlockContext.addCookies([
    { name: "auth_token", value: superToken, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await unlockContext.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: superToken, user: superUser });
  const unlockPage = await unlockContext.newPage();
  const unlockBrowserErrors = [];
  const unlockServerFailures = [];
  unlockPage.on("console", (message) => { if (message.type() === "error") unlockBrowserErrors.push(message.text()); });
  unlockPage.on("response", (response) => { if (response.status() >= 500) unlockServerFailures.push(`${response.status()} ${response.url()}`); });
  await unlockPage.goto(`${origin}/admin?tab=agents&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(unlockPage, { identity: "super-admin" });
  const unlockTrigger = unlockPage.locator('[data-testid="admin-sensitive-lock"]');
  await unlockTrigger.waitFor({ state: "visible", timeout: 45_000 });
  await unlockPage.getByText(/已解锁至.*点击上锁/u).waitFor({ state: "visible", timeout: 20_000 });

  const sensitivePromptResponse = await api("/api/admin/agents?include_prompt=1", { headers: superHeaders });
  const sensitivePromptPayload = await readJson(sensitivePromptResponse);
  assert.equal(sensitivePromptResponse.status, 200, "MANUAL_RELOCK_PROMPT_BASELINE_REQUIRED");
  const sensitivePromptAgent = (sensitivePromptPayload.agents || []).find((agent) => (
    typeof agent?.system_prompt === "string" && agent.system_prompt.trim().length > 20
  ));
  assert.ok(sensitivePromptAgent, "MANUAL_RELOCK_NONEMPTY_PROMPT_BASELINE_REQUIRED");
  const sensitivePromptText = sensitivePromptAgent.system_prompt.trim();
  const sensitivePromptHash = crypto.createHash("sha256").update(sensitivePromptText).digest("hex");
  const sensitiveSettingsResponse = await api("/api/settings/admin?scope=prompts", { headers: superHeaders });
  const sensitiveSettingsPayload = await readJson(sensitiveSettingsResponse);
  assert.equal(sensitiveSettingsResponse.status, 200, "MANUAL_RELOCK_SETTINGS_BASELINE_REQUIRED");
  assert.ok(sensitiveSettingsPayload.settings && typeof sensitiveSettingsPayload.settings === "object", "MANUAL_RELOCK_SETTINGS_OBJECT_REQUIRED");

  const targetPromptRow = unlockPage.getByRole("row", { name: sensitivePromptAgent.name });
  await targetPromptRow.waitFor({ state: "visible", timeout: 45_000 });
  await targetPromptRow.getByRole("button", { name: "查看提示词" }).click();
  const promptViewer = unlockPage.locator('[data-testid="admin-agent-prompt-readonly"]');
  await promptViewer.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal((await promptViewer.locator("pre").innerText()).trim(), sensitivePromptText, "MANUAL_RELOCK_UI_PROMPT_BASELINE_REQUIRED");

  await unlockPage.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(unlockPage, { identity: "super-admin" });
  await unlockPage.locator('[data-testid="admin-sensitive-lock"]').waitFor({ state: "visible", timeout: 45_000 });
  const globalPromptTextarea = unlockPage.locator('textarea[placeholder*="中国广告法"]');
  await globalPromptTextarea.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(
    await globalPromptTextarea.inputValue(),
    String(sensitiveSettingsPayload.settings.global_system_prefix || ""),
    "MANUAL_RELOCK_UI_SETTINGS_BASELINE_REQUIRED",
  );

  const manualRelockResponsePromise = unlockPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE" && url.pathname === "/api/admin/access-control/unlock";
  }, { timeout: 20_000 });
  await unlockPage.locator('[data-testid="admin-sensitive-lock"]').click();
  const manualRelockResponse = await manualRelockResponsePromise;
  const manualRelockPayload = await manualRelockResponse.json();
  assert.equal(manualRelockResponse.status(), 200, "MANUAL_RELOCK_API_REQUIRED");
  assert.equal(manualRelockPayload.success, true, "MANUAL_RELOCK_SUCCESS_REQUIRED");
  assert.ok(Number(manualRelockPayload.revokedCount) >= 1, "MANUAL_RELOCK_SESSION_REVOCATION_REQUIRED");
  await unlockPage.getByText("解锁敏感操作", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await unlockPage.waitForFunction(() => {
    const textarea = document.querySelector('textarea[placeholder*="中国广告法"]');
    return textarea instanceof HTMLTextAreaElement && textarea.value === "";
  }, undefined, { timeout: 20_000 });
  assert.equal(
    (await unlockContext.cookies()).some((cookie) => cookie.name === "zimeiti_admin_step_up" && cookie.value),
    false,
    "MANUAL_RELOCK_COOKIE_MUST_BE_CLEARED",
  );
  const superSelfAfterRelockResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const superSelfAfterRelock = await readJson(superSelfAfterRelockResponse);
  assert.equal(superSelfAfterRelockResponse.status, 200, "MANUAL_RELOCK_SELF_REQUIRED");
  assert.ok(["missing", "locked"].includes(superSelfAfterRelock.stepUp?.status), "MANUAL_RELOCK_SELF_MUST_BE_LOCKED");
  const promptsAfterRelockResponse = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const promptsAfterRelock = await readJson(promptsAfterRelockResponse);
  assert.equal(promptsAfterRelockResponse.status, 428, "MANUAL_RELOCK_PROMPTS_MUST_LOCK");
  assert.equal(promptsAfterRelock.code, "ADMIN_STEP_UP_REQUIRED", "MANUAL_RELOCK_PROMPT_LOCK_CODE_REQUIRED");
  assert.equal(Object.hasOwn(promptsAfterRelock, "agents"), false, "MANUAL_RELOCK_PROMPTS_MUST_NOT_BE_RETURNED");
  const settingsAfterRelockResponse = await api("/api/settings/admin?scope=prompts", {
    headers: { Authorization: `Bearer ${superToken}`, Accept: "application/json" },
  });
  const settingsAfterRelock = await readJson(settingsAfterRelockResponse);
  assert.equal(settingsAfterRelockResponse.status, 428, "MANUAL_RELOCK_SETTINGS_MUST_LOCK");
  assert.equal(settingsAfterRelock.code, "ADMIN_STEP_UP_REQUIRED", "MANUAL_RELOCK_SETTINGS_LOCK_CODE_REQUIRED");
  assert.equal(Object.hasOwn(settingsAfterRelock, "settings"), false, "MANUAL_RELOCK_SETTINGS_MUST_NOT_BE_RETURNED");
  const manualStepUpRowsRemaining = Number((await db.query(
    "SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1 AND revoked_at IS NULL",
    [stepUpHash],
  )).rows[0].count);
  assert.equal(manualStepUpRowsRemaining, 0, "MANUAL_RELOCK_DATABASE_ACTIVE_SESSION_MUST_BE_REVOKED");

  await unlockPage.goto(`${origin}/admin?tab=agents&view=overview`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settleBlockingNotifications(unlockPage, { identity: "super-admin" });
  assert.equal(await unlockPage.locator('[data-testid="admin-agent-prompt-readonly"]').count(), 0, "MANUAL_RELOCK_PROMPT_VIEWER_MUST_CLEAR");
  assert.equal((await unlockPage.locator("body").innerText()).includes(sensitivePromptText), false, "MANUAL_RELOCK_PROMPT_TEXT_MUST_CLEAR");
  report.adminLock.manualRelock = {
    viewport: "1440x900",
    apiStatus: manualRelockResponse.status(),
    revokedCount: Number(manualRelockPayload.revokedCount),
    selfStepUpStatus: superSelfAfterRelock.stepUp?.status,
    promptStateCleared: true,
    settingsStateCleared: true,
    promptHashBeforeRelock: sensitivePromptHash,
    serverActiveSessionRowsRemaining: manualStepUpRowsRemaining,
  };

  await unlockPage.locator('[data-testid="admin-sensitive-lock"]').click();
  const unlockOverlay = unlockPage.locator('[data-testid="admin-sensitive-unlock-overlay"]');
  const unlockDialog = unlockOverlay.getByRole("dialog");
  await unlockDialog.waitFor({ state: "visible", timeout: 20_000 });
  const overlayContract = await unlockPage.evaluate(() => {
    const overlay = document.querySelector('[data-testid="admin-sensitive-unlock-overlay"]');
    const dialog = overlay?.querySelector('[role="dialog"]');
    const background = [...document.body.children].filter((element) => element !== overlay && !element.contains(overlay));
    return {
      zIndex: overlay ? Number.parseInt(getComputedStyle(overlay).zIndex || "0", 10) : 0,
      focusInside: Boolean(dialog && dialog.contains(document.activeElement)),
      backgroundInert: background.length > 0 && background.every((element) => element.hasAttribute("inert")),
      ariaModal: dialog?.getAttribute("aria-modal"),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  assert.ok(overlayContract.zIndex >= 2_147_483_647, `UNLOCK_OVERLAY_Z_INDEX_TOO_LOW:${overlayContract.zIndex}`);
  assert.equal(overlayContract.focusInside, true, "UNLOCK_DIALOG_INITIAL_FOCUS_REQUIRED");
  assert.equal(overlayContract.backgroundInert, true, "UNLOCK_DIALOG_BACKGROUND_INERT_REQUIRED");
  assert.equal(overlayContract.ariaModal, "true", "UNLOCK_DIALOG_ARIA_MODAL_REQUIRED");
  assert.equal(overlayContract.horizontalOverflow, false, "UNLOCK_DIALOG_HORIZONTAL_OVERFLOW_1440");
  for (let index = 0; index < 12; index += 1) {
    await unlockPage.keyboard.press("Tab");
    assert.equal(await unlockPage.evaluate(() => {
      const dialog = document.querySelector('[data-testid="admin-sensitive-unlock-overlay"] [role="dialog"]');
      return Boolean(dialog && dialog.contains(document.activeElement));
    }), true, `UNLOCK_DIALOG_FOCUS_TRAP_FAILED:${index}`);
  }
  await unlockPage.screenshot({ path: path.join(evidenceDir, "admin-unlock-dialog-1440x900.png"), fullPage: false });
  await unlockPage.keyboard.press("Escape");
  await unlockOverlay.waitFor({ state: "detached", timeout: 10_000 });
  await unlockPage.waitForFunction(() => {
    const trigger = document.querySelector('[data-testid="admin-sensitive-lock"]');
    return trigger instanceof HTMLButtonElement && document.activeElement === trigger;
  }, undefined, { timeout: 2_000 });
  await unlockPage.setViewportSize({ width: 1600, height: 1000 });
  await unlockTrigger.click();
  await unlockDialog.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await unlockPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "UNLOCK_DIALOG_HORIZONTAL_OVERFLOW_1600");
  await unlockPage.screenshot({ path: path.join(evidenceDir, "admin-unlock-dialog-1600x1000.png"), fullPage: false });
  await unlockPage.keyboard.press("Escape");
  await unlockPage.setViewportSize({ width: 1440, height: 900 });
  for (const adjacentPath of ["/admin?tab=models", "/admin?tab=users&view=overview"]) {
    await unlockPage.goto(`${origin}${adjacentPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settleBlockingNotifications(unlockPage, { identity: "super-admin" });
    await unlockPage.locator('[data-testid="admin-sensitive-lock"]').waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await unlockPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `ADJACENT_PAGE_HORIZONTAL_OVERFLOW:${adjacentPath}`);
  }
  assert.deepEqual(unlockBrowserErrors, [], `UNLOCK_BROWSER_CONSOLE_ERRORS:${JSON.stringify(unlockBrowserErrors)}`);
  assert.deepEqual(unlockServerFailures, [], `UNLOCK_BROWSER_SERVER_FAILURES:${JSON.stringify(unlockServerFailures)}`);
  await unlockContext.close();
  report.browser.unlockDialog = {
    topLayer: true,
    focusTrap: true,
    focusRestored: true,
    backgroundInert: true,
    escapeCloses: true,
    desktopViewports: ["1600x1000", "1440x900"],
    adjacentPages: ["models", "users"],
  };
  await browser.close();
  browser = null;

  report.announcementEventIsolation = assertAnnouncementEventIsolation(announcementEventAudits);
  report.passed = true;
} finally {
  if (!report.announcementEventIsolation.interceptedCount) {
    report.announcementEventIsolation = summarizeAnnouncementEventAudits(announcementEventAudits);
  }
  if (browser) await browser.close().catch(() => undefined);
  if (dbConnected) {
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.admin_governance_write','on',true)");
      if (maintenanceEnabled) {
        const maintenanceRow = (await db.query(
          "SELECT revision,is_enabled FROM public.admin_step_up_maintenance_lock WHERE singleton=true FOR UPDATE",
        )).rows[0];
        if (maintenanceRow?.is_enabled) {
          const maintenanceCleanup = (await db.query(
            `SELECT public.set_admin_step_up_maintenance_lock(
              $1,false,$2,30,$3,'',$4,$5,'PATCH','127.0.0.1',$6
            ) AS result`,
            [
              superUser.id,
              "验收 finally 清理：恢复全部二次验证锁",
              Number(maintenanceRow.revision),
              `codex-maintenance-finally-${promptFixtureUserId || Date.now()}`,
              "/api/admin/access-control/maintenance-lock",
              userAgent,
            ],
          )).rows[0]?.result;
          assert.equal(maintenanceCleanup?.success, true, "MAINTENANCE_FINALLY_CLEANUP_REQUIRED");
        }
        maintenanceEnabled = false;
      }
      if (fixtureUserId) {
        await db.query("DELETE FROM public.announcement_delivery_events WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.login_logs WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.users WHERE id=$1", [fixtureUserId]);
      }
      if (promptFixtureUserId) {
        await db.query("DELETE FROM public.announcement_delivery_events WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.login_logs WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.users WHERE id=$1", [promptFixtureUserId]);
      }
      const superStepUpHashes = [retiredMaintenanceStepUpHash, stepUpHash].filter(Boolean);
      if (superStepUpHashes.length > 0) {
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash = ANY($1::text[])", [superStepUpHashes]);
      }
      await db.query("COMMIT");
      const fixtureIds = [fixtureUserId, promptFixtureUserId].filter(Boolean);
      const remaining = fixtureIds.length > 0
        ? (await db.query(
          `SELECT
             (SELECT count(*)::int FROM public.users WHERE id::text = ANY($1::text[])) AS users,
             (SELECT count(*)::int FROM public.admin_access_profiles WHERE user_id::text = ANY($1::text[])) AS profiles,
             (SELECT count(*)::int FROM public.admin_step_up_sessions WHERE actor_id::text = ANY($1::text[])) AS step_up_sessions,
             (SELECT count(*)::int FROM public.user_auth_sessions WHERE user_id::text = ANY($1::text[])) AS auth_sessions,
             (SELECT count(*)::int FROM public.login_logs WHERE user_id::text = ANY($1::text[])) AS login_logs,
             (SELECT count(*)::int FROM public.announcement_delivery_events WHERE user_id::text = ANY($1::text[])) AS announcement_delivery_events`,
          [fixtureIds],
        )).rows[0]
        : {
          users: 0,
          profiles: 0,
          step_up_sessions: 0,
          auth_sessions: 0,
          login_logs: 0,
          announcement_delivery_events: 0,
        };
      const superStepUpRemaining = superStepUpHashes.length > 0
        ? Number((await db.query(
          "SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash = ANY($1::text[])",
          [superStepUpHashes],
        )).rows[0].count)
        : 0;
      const maintenanceRemaining = Number((await db.query(
        "SELECT count(*)::int AS count FROM public.admin_step_up_maintenance_lock WHERE singleton=true AND is_enabled=true",
      )).rows[0].count);
      assert.equal(Number(remaining.users), 0, "FIXTURE_USER_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.profiles), 0, "FIXTURE_PROFILE_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.step_up_sessions), 0, "FIXTURE_STEP_UP_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.auth_sessions), 0, "FIXTURE_AUTH_SESSION_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.login_logs), 0, "FIXTURE_LOGIN_LOG_CLEANUP_REQUIRED");
      assert.equal(Number(remaining.announcement_delivery_events), 0, "FIXTURE_ANNOUNCEMENT_DELIVERY_EVENT_CLEANUP_REQUIRED");
      assert.equal(superStepUpRemaining, 0, "SUPER_STEP_UP_CLEANUP_REQUIRED");
      assert.equal(maintenanceRemaining, 0, "MAINTENANCE_LOCK_CLEANUP_REQUIRED");
      report.cleanup = {
        fixtureUsersRemaining: Number(remaining.users),
        fixtureProfilesRemaining: Number(remaining.profiles),
        fixtureStepUpSessionsRemaining: Number(remaining.step_up_sessions),
        fixtureAuthSessionsRemaining: Number(remaining.auth_sessions),
        fixtureLoginLogsRemaining: Number(remaining.login_logs),
        fixtureAnnouncementDeliveryEventsRemaining: Number(remaining.announcement_delivery_events),
        maintenanceLocksEnabled: maintenanceRemaining,
        superStepUpSessionsRemaining: superStepUpRemaining,
        stepUpSessionRemoved: superStepUpHashes.length > 0 ? superStepUpRemaining === 0 : null,
      };
    } catch (cleanupError) {
      await db.query("ROLLBACK").catch(() => undefined);
      report.cleanup = { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) };
      if (report.passed) throw cleanupError;
    }
    await db.end();
    dbConnected = false;
  }
  report.checkedAt = new Date().toISOString();
  report.startedAt = startedAt;
  await fs.writeFile(path.join(evidenceDir, "security-governance-live.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.passed, true, "ADMIN_SECURITY_GOVERNANCE_ACCEPTANCE_FAILED");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
