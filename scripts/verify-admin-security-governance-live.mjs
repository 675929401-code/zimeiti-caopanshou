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
      ...(options.headers || {}),
    },
  });
}

async function closeAnnouncementIfVisible(page) {
  for (const accessibleName of ["关闭系统公告", "关闭账号消息"]) {
    const closeButton = page.getByRole("button", { name: accessibleName });
    const appeared = await closeButton.waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await closeButton.click();
      await closeButton.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    }
  }
}

const db = new pg.Client({ connectionString: databaseUrl, application_name: "codex-admin-security-acceptance" });
let dbConnected = false;
let stepUpToken = "";
let stepUpHash = "";
let fixtureUserId = "";
let promptFixtureUserId = "";
let promptFixtureUsername = "";
let promptFixturePassword = "";
let promptFixtureToken = "";
let maintenanceEnabled = false;
let browser;

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
    const response = await api(pathname, { headers: { Accept: "application/json" } });
    const body = await readJson(response);
    assert.ok([401, 403].includes(response.status), `${pathname}:ANONYMOUS_MUST_BE_REJECTED:${response.status}`);
    assertPrivateHeaders(response, pathname);
    safeBody(body);
    report.anonymous.push({ pathname, status: response.status, code: body.code || null });
  }

  const crawlerResponse = await fetch(`${origin}/api/admin/users?page=1&pageSize=1`, {
    redirect: "manual",
    headers: { "User-Agent": "sqlmap/1.8 automated scanner", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const crawlerBody = await readJson(crawlerResponse);
  assert.ok([401, 403].includes(crawlerResponse.status), `CRAWLER_MUST_BE_REJECTED:${crawlerResponse.status}`);
  safeBody(crawlerBody);
  report.crawler = { status: crawlerResponse.status, code: crawlerBody.code || null };

  const guardedPage = await api("/admin?tab=super-admin", { headers: { Accept: "text/html" } });
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

  const unlockResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...browserWriteHeaders, Authorization: `Bearer ${ordinaryToken}` },
    body: JSON.stringify({ password: fixturePassword, mode: "login" }),
  });
  const unlock = await readJson(unlockResponse);
  assert.equal(unlockResponse.status, 200, `ORDINARY_ADMIN_PASSWORD_UNLOCK_REQUIRED:${unlockResponse.status}:${JSON.stringify(unlock)}`);
  assert.equal(unlock.authMethod, "login_password", "LOGIN_PASSWORD_UNLOCK_RECEIPT_REQUIRED");
  assert.match(unlockResponse.headers.get("set-cookie") || "", /zimeiti_admin_step_up=.*HttpOnly.*SameSite=Strict/iu, "STEP_UP_COOKIE_MUST_BE_HTTPONLY_STRICT");

  const ordinaryMembers = await api("/api/admin/users?page=1&pageSize=1", {
    headers: { Authorization: `Bearer ${ordinaryToken}`, Accept: "application/json" },
  });
  assert.equal(ordinaryMembers.status, 200, `ORDINARY_MEMBERS_VIEW_REQUIRED:${ordinaryMembers.status}`);
  const deniedControl = await api("/api/admin/access-control", {
    headers: { Authorization: `Bearer ${ordinaryToken}`, Accept: "application/json" },
  });
  const deniedControlBody = await readJson(deniedControl);
  assert.equal(deniedControl.status, 403, `ORDINARY_SUPER_CONTROL_MUST_BE_DENIED:${deniedControl.status}`);
  assert.equal(deniedControlBody.code, "ADMIN_PERMISSION_DENIED");
  const deniedSettings = await api("/api/settings/admin?scope=brand", {
    headers: { Authorization: `Bearer ${ordinaryToken}`, Accept: "application/json" },
  });
  assert.equal(deniedSettings.status, 403, `ORDINARY_SETTINGS_MUST_BE_DENIED:${deniedSettings.status}`);
  const deniedPrompts = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${ordinaryToken}`, Accept: "application/json" },
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

  // Exact prompts.view matrix. This uses a second disposable administrator so
  // the long-standing member-governance assertions above remain unchanged.
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

  const promptLoginResponse = await api("/api/auth/login", {
    method: "POST",
    headers: browserWriteHeaders,
    body: JSON.stringify({ username: promptFixtureUsername, password: promptFixturePassword }),
  });
  const promptLogin = await readJson(promptLoginResponse);
  assert.equal(promptLoginResponse.status, 200, `PROMPT_MATRIX_LOGIN_REQUIRED:${promptLoginResponse.status}:${JSON.stringify(promptLogin)}`);
  promptFixtureToken = String(promptLogin.token || "");
  assert.ok(promptFixtureToken.length > 32, "PROMPT_MATRIX_TOKEN_REQUIRED");

  const promptUnlockResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...browserWriteHeaders, Authorization: `Bearer ${promptFixtureToken}` },
    body: JSON.stringify({ password: promptFixturePassword, mode: "login" }),
  });
  const promptUnlock = await readJson(promptUnlockResponse);
  assert.equal(promptUnlockResponse.status, 200, `PROMPT_MATRIX_INITIAL_UNLOCK_REQUIRED:${promptUnlockResponse.status}:${JSON.stringify(promptUnlock)}`);
  const promptStepUpToken = cookieValue(promptUnlockResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  assert.ok(promptStepUpToken.length > 20, "PROMPT_MATRIX_INITIAL_STEP_UP_COOKIE_REQUIRED");

  const onlyAgentsUnlocked = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${promptFixtureToken}`, "x-admin-step-up": promptStepUpToken, Accept: "application/json" },
  });
  assert.equal(onlyAgentsUnlocked.status, 403, `ONLY_AGENTS_WITH_STEP_UP_MUST_NOT_READ_PROMPTS:${onlyAgentsUnlocked.status}`);

  let promptProfile = (await db.query(
    "SELECT revision FROM public.admin_access_profiles WHERE user_id=$1",
    [promptFixtureUserId],
  )).rows[0];
  const grantPromptsResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: { ...superHeaders, "Content-Type": "application/json", "Idempotency-Key": `codex-prompt-grant-${promptFixtureUserId}` },
    body: JSON.stringify({
      action: "permissions",
      userId: promptFixtureUserId,
      permissionKeys: ["agents.view", "prompts.view"],
      isActive: true,
      expectedRevision: Number(promptProfile.revision),
      reason: "提示词权限矩阵验收：授予只读提示词权限",
    }),
  });
  assert.equal(grantPromptsResponse.status, 200, `PROMPT_MATRIX_GRANT_REQUIRED:${grantPromptsResponse.status}:${JSON.stringify(await readJson(grantPromptsResponse))}`);

  const promptsLocked = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${promptFixtureToken}`, Accept: "application/json" },
  });
  assert.equal(promptsLocked.status, 428, `PROMPTS_WITHOUT_STEP_UP_MUST_LOCK:${promptsLocked.status}`);

  const promptUnlockAfterGrantResponse = await api("/api/admin/access-control/unlock", {
    method: "POST",
    headers: { ...browserWriteHeaders, Authorization: `Bearer ${promptFixtureToken}` },
    body: JSON.stringify({ password: promptFixturePassword, mode: "login" }),
  });
  assert.equal(promptUnlockAfterGrantResponse.status, 200, `PROMPT_MATRIX_UNLOCK_AFTER_GRANT_REQUIRED:${promptUnlockAfterGrantResponse.status}`);
  const promptStepUpAfterGrant = cookieValue(promptUnlockAfterGrantResponse.headers.get("set-cookie"), "zimeiti_admin_step_up");
  const promptsWithStepUp = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${promptFixtureToken}`, "x-admin-step-up": promptStepUpAfterGrant, Accept: "application/json" },
  });
  const promptsWithStepUpBody = await readJson(promptsWithStepUp);
  assert.equal(promptsWithStepUp.status, 200, `PROMPTS_WITH_STEP_UP_REQUIRED:${promptsWithStepUp.status}`);
  assert.equal(promptsWithStepUpBody.promptAuthorizationMode, "step_up", "PROMPT_STEP_UP_MODE_RECEIPT_REQUIRED");

  promptProfile = (await db.query(
    "SELECT revision FROM public.admin_access_profiles WHERE user_id=$1",
    [promptFixtureUserId],
  )).rows[0];
  const revokePromptsResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: { ...superHeaders, "Content-Type": "application/json", "Idempotency-Key": `codex-prompt-revoke-${promptFixtureUserId}` },
    body: JSON.stringify({
      action: "permissions",
      userId: promptFixtureUserId,
      permissionKeys: ["agents.view"],
      isActive: true,
      expectedRevision: Number(promptProfile.revision),
      reason: "提示词权限矩阵验收：撤销提示词权限",
    }),
  });
  assert.equal(revokePromptsResponse.status, 200, `PROMPT_MATRIX_REVOKE_REQUIRED:${revokePromptsResponse.status}`);

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
    headers: { Authorization: `Bearer ${promptFixtureToken}`, Accept: "application/json" },
  });
  assert.equal(onlyAgentsMaintenance.status, 403, `MAINTENANCE_MUST_NOT_BYPASS_PROMPTS_PERMISSION:${onlyAgentsMaintenance.status}`);

  promptProfile = (await db.query(
    "SELECT revision FROM public.admin_access_profiles WHERE user_id=$1",
    [promptFixtureUserId],
  )).rows[0];
  const maintenanceSuperHeaders = { Authorization: `Bearer ${superToken}`, Accept: "application/json" };
  const maintenanceGrantResponse = await api("/api/admin/access-control", {
    method: "PATCH",
    headers: { ...maintenanceSuperHeaders, "Content-Type": "application/json", "Idempotency-Key": `codex-prompt-maintenance-grant-${promptFixtureUserId}` },
    body: JSON.stringify({
      action: "permissions",
      userId: promptFixtureUserId,
      permissionKeys: ["agents.view", "prompts.view"],
      isActive: true,
      expectedRevision: Number(promptProfile.revision),
      reason: "提示词权限矩阵验收：维护模式下恢复只读权限",
    }),
  });
  assert.equal(maintenanceGrantResponse.status, 200, `MAINTENANCE_PERMISSION_GRANT_REQUIRED:${maintenanceGrantResponse.status}`);

  const promptsWithMaintenance = await api("/api/admin/agents?include_prompt=1", {
    headers: { Authorization: `Bearer ${promptFixtureToken}`, Accept: "application/json" },
  });
  const promptsWithMaintenanceBody = await readJson(promptsWithMaintenance);
  assert.equal(promptsWithMaintenance.status, 200, `PROMPTS_WITH_MAINTENANCE_REQUIRED:${promptsWithMaintenance.status}`);
  assert.equal(promptsWithMaintenanceBody.promptAuthorizationMode, "maintenance", "PROMPT_MAINTENANCE_MODE_RECEIPT_REQUIRED");
  const promptSelfMaintenanceResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${promptFixtureToken}`, Accept: "application/json" },
  });
  const promptSelfMaintenance = await readJson(promptSelfMaintenanceResponse);
  assert.equal(promptSelfMaintenance.stepUp?.status, "maintenance", "ORDINARY_ADMIN_MAINTENANCE_STATUS_REQUIRED");
  report.promptPermissionMatrix = {
    onlyAgentsWithStepUp: onlyAgentsUnlocked.status,
    promptsWithoutStepUp: promptsLocked.status,
    promptsWithStepUp: promptsWithStepUp.status,
    onlyAgentsWithMaintenance: onlyAgentsMaintenance.status,
    promptsWithMaintenance: promptsWithMaintenance.status,
    maintenanceAuthorizationMode: promptsWithMaintenanceBody.promptAuthorizationMode,
  };

  browser = await chromium.launch({ headless: true });
  const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
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

  const ordinaryContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
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
  await closeAnnouncementIfVisible(ordinaryPage);
  await ordinaryPage.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  const ordinarySidebarEntry = ordinaryPage.locator('[data-testid="sidebar-admin-entry"]');
  await ordinarySidebarEntry.waitFor({ state: "visible", timeout: 30_000 });
  await ordinaryPage.screenshot({ path: path.join(evidenceDir, "ordinary-admin-sidebar-entry-1440x900.png"), fullPage: true });
  await ordinarySidebarEntry.click();
  await ordinaryPage.waitForURL((url) => url.pathname === "/admin", { timeout: 45_000 });
  await ordinaryContext.close();

  const promptContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
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
  await closeAnnouncementIfVisible(promptPage);
  await promptPage.locator('[data-testid="admin-maintenance-mode-banner"]').waitFor({ state: "visible", timeout: 45_000 });
  await promptPage.locator('[data-testid="admin-prompt-access-maintenance"]').waitFor({ state: "visible", timeout: 45_000 });
  const targetAgentRow = promptPage.getByRole("row", { name: /3D故事导演｜高能版/u });
  await targetAgentRow.waitFor({ state: "visible", timeout: 45_000 });
  await targetAgentRow.getByRole("button", { name: "查看提示词" }).click();
  const promptViewer = promptPage.locator('[data-testid="admin-agent-prompt-readonly"]');
  await promptViewer.waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await promptViewer.innerText(), /维护模式放行/u, "PROMPT_VIEWER_MUST_MARK_MAINTENANCE_AUTHORIZATION");
  assert.ok((await promptViewer.locator("pre").innerText()).trim().length > 20, "PROMPT_VIEWER_MUST_RENDER_PROMPT_CONTENT");
  await promptPage.screenshot({ path: path.join(evidenceDir, "ordinary-admin-prompt-maintenance-1440x900.png"), fullPage: true });
  assert.deepEqual(promptBrowserErrors, [], `PROMPT_BROWSER_CONSOLE_ERRORS:${JSON.stringify(promptBrowserErrors)}`);
  assert.deepEqual(promptServerFailures, [], `PROMPT_BROWSER_SERVER_FAILURES:${JSON.stringify(promptServerFailures)}`);
  await promptContext.close();

  const superContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
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
  await closeAnnouncementIfVisible(superHomePage);
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
  await closeAnnouncementIfVisible(modelPage);
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
    ordinaryPromptMaintenanceVisible: true,
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

  const unlockContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, userAgent });
  await unlockContext.addCookies([
    { name: "auth_token", value: superToken, url: origin, httpOnly: true, sameSite: "Lax" },
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
  await closeAnnouncementIfVisible(unlockPage);
  const unlockTrigger = unlockPage.locator('[data-testid="admin-sensitive-lock"]');
  await unlockTrigger.waitFor({ state: "visible", timeout: 45_000 });
  await unlockTrigger.click();
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
  assert.equal(overlayContract.horizontalOverflow, false, "UNLOCK_DIALOG_HORIZONTAL_OVERFLOW_1600");
  for (let index = 0; index < 12; index += 1) {
    await unlockPage.keyboard.press("Tab");
    assert.equal(await unlockPage.evaluate(() => {
      const dialog = document.querySelector('[data-testid="admin-sensitive-unlock-overlay"] [role="dialog"]');
      return Boolean(dialog && dialog.contains(document.activeElement));
    }), true, `UNLOCK_DIALOG_FOCUS_TRAP_FAILED:${index}`);
  }
  await unlockPage.screenshot({ path: path.join(evidenceDir, "admin-unlock-dialog-1600x1000.png"), fullPage: false });
  await unlockPage.keyboard.press("Escape");
  await unlockOverlay.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await unlockTrigger.evaluate((element) => document.activeElement === element), true, "UNLOCK_DIALOG_FOCUS_RESTORE_REQUIRED");
  await unlockPage.setViewportSize({ width: 1440, height: 900 });
  await unlockTrigger.click();
  await unlockDialog.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await unlockPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, "UNLOCK_DIALOG_HORIZONTAL_OVERFLOW_1440");
  await unlockPage.screenshot({ path: path.join(evidenceDir, "admin-unlock-dialog-1440x900.png"), fullPage: false });
  await unlockPage.keyboard.press("Escape");
  for (const adjacentPath of ["/admin?tab=models", "/admin?tab=users&view=overview"]) {
    await unlockPage.goto(`${origin}${adjacentPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await closeAnnouncementIfVisible(unlockPage);
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

  report.passed = true;
} finally {
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
        await db.query("DELETE FROM public.login_logs WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [fixtureUserId]);
        await db.query("DELETE FROM public.users WHERE id=$1", [fixtureUserId]);
      }
      if (promptFixtureUserId) {
        await db.query("DELETE FROM public.login_logs WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [promptFixtureUserId]);
        await db.query("DELETE FROM public.users WHERE id=$1", [promptFixtureUserId]);
      }
      if (stepUpHash) await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await db.query("COMMIT");
      const remaining = fixtureUserId
        ? Number((await db.query("SELECT count(*)::int AS count FROM public.users WHERE id=$1", [fixtureUserId])).rows[0].count)
        : 0;
      assert.equal(remaining, 0, "FIXTURE_USER_CLEANUP_REQUIRED");
      const promptRemaining = promptFixtureUserId
        ? Number((await db.query("SELECT count(*)::int AS count FROM public.users WHERE id=$1", [promptFixtureUserId])).rows[0].count)
        : 0;
      const maintenanceRemaining = Number((await db.query(
        "SELECT count(*)::int AS count FROM public.admin_step_up_maintenance_lock WHERE singleton=true AND is_enabled=true",
      )).rows[0].count);
      assert.equal(promptRemaining, 0, "PROMPT_FIXTURE_USER_CLEANUP_REQUIRED");
      assert.equal(maintenanceRemaining, 0, "MAINTENANCE_LOCK_CLEANUP_REQUIRED");
      report.cleanup = {
        fixtureUsersRemaining: remaining,
        promptFixtureUsersRemaining: promptRemaining,
        maintenanceLocksEnabled: maintenanceRemaining,
        stepUpSessionRemoved: Boolean(stepUpHash),
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
