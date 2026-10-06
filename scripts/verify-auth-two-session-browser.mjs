#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium } from "playwright";
import { decodeJwt } from "jose";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PREVIEW_ORIGIN_REQUIRED");
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const launchBrowser = async () => {
  try {
    await fs.access(bundledChromium);
    return chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    return chromium.launch({ headless: true });
  }
};

const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-auth-two-session-browser-e2e",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const browser = await launchBrowser();
const userId = crypto.randomUUID();
const username = `auth_browser_${crypto.randomBytes(6).toString("hex")}`;
const password = `Local-${crypto.randomBytes(12).toString("base64url")}!9`;
const passwordHash = await bcrypt.hash(password, 10);
const outputDir = path.resolve(".codex-evidence", "auth-two-session");
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  target: "127.0.0.1:54322/zimeiti_local",
  assertions: {},
  providerRequests: 0,
  pageErrors: [],
  consoleErrors: [],
  clientErrors: [],
  serverErrors: [],
};

const requestJson = async (pathname, init = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { response, body };
};

const login = async (ip, userAgent) => {
  const result = await requestJson("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": userAgent,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.response.status, 200, `LOGIN_FAILED:${result.response.status}:${result.body?.code || result.body?.error || "unknown"}`);
  assert.equal(result.body?.success, true);
  assert.ok(typeof result.body?.token === "string" && result.body.token.length > 32, "LOGIN_TOKEN_MISSING");
  return result.body;
};

const authMeStatus = async (token) => (await requestJson("/api/auth/me", {
  headers: { Authorization: `Bearer ${token}` },
})).response.status;

await fs.mkdir(outputDir, { recursive: true });
await db.connect();
try {
  const identity = (await db.query(
    "SELECT current_database() AS database_name, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  await db.query(
    `INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status)
     VALUES($1,$2,$3,$4,'student',0,true,'active')`,
    [userId, username, passwordHash, "双会话浏览器验收"],
  );
  await db.query(
    "UPDATE public.users SET member_status='active', member_expires_at=now()+interval '1 day' WHERE id=$1",
    [userId],
  );

  const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const anonymousPage = await anonymousContext.newPage();
  const anonymousResponse = await anonymousPage.goto(`${origin}/cover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(anonymousResponse?.status(), 200, "ANONYMOUS_DEEP_LINK_UNAVAILABLE");
  await anonymousPage.waitForURL(`${origin}/`, { timeout: 30_000 });
  await anonymousPage.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
  report.assertions.anonymousSecondaryDeepLinkReturnsHome = true;
  await anonymousContext.close();

  const first = await login("198.51.100.11", "Codex-Auth-E2E/first");
  const second = await login("198.51.100.12", "Codex-Auth-E2E/second");
  assert.equal(await authMeStatus(first.token), 200, "FIRST_SESSION_NOT_ACTIVE_AFTER_SECOND_LOGIN");
  assert.equal(await authMeStatus(second.token), 200, "SECOND_SESSION_NOT_ACTIVE");
  report.assertions.firstTwoSessionsActive = true;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const clientErrorBodyReads = [];
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error"
      && !message.text().includes("ERR_BLOCKED_BY_CLIENT")
      && !/status of 401|status code 401/iu.test(message.text())
    ) {
      report.consoleErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const entry = { status: response.status(), pathname: new URL(response.url()).pathname, code: "" };
      if (response.status() < 500) report.clientErrors.push(entry);
      else report.serverErrors.push(entry);
      clientErrorBodyReads.push(response.json().then((body) => {
        entry.code = typeof body?.code === "string" ? body.code : "";
      }).catch(() => undefined));
    }
  });

  const rootResponse = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(rootResponse?.status(), 200, "PUBLIC_HOME_UNAVAILABLE");
  await page.evaluate(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { token: first.token, user: first.user });
  const initialAuthReady = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/me" && response.status() === 200,
    { timeout: 60_000 },
  );
  // Use an account-level protected page that every authenticated member owns.
  // A newly created fixture user intentionally has no storyboard feature grant;
  // using that route here would test feature authorization instead of session revocation.
  const protectedPageResponse = await page.goto(`${origin}/profile`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(protectedPageResponse?.status(), 200, "PROFILE_PAGE_UNAVAILABLE");
  await initialAuthReady;
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForFunction(() => (
    localStorage.getItem("auth_token") != null
    && sessionStorage.getItem("entered_app") === "1"
    && document.body.innerText.includes("个人中心")
  ));
  report.assertions.revokedSessionWasMountedInProtectedPage = true;

  const third = await login("198.51.100.13", "Codex-Auth-E2E/third");
  const statusesAfterThird = await Promise.all([
    authMeStatus(first.token),
    authMeStatus(second.token),
    authMeStatus(third.token),
  ]);
  assert.deepEqual(statusesAfterThird, [401, 200, 200], "THIRD_LOGIN_DID_NOT_REVOKE_ONLY_THE_OLDEST_SESSION");
  report.assertions.thirdLoginRevokesOldestOnly = true;

  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(`${origin}/`, { timeout: 30_000 });
  await page.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
  const forcedLogoutDialog = page.getByTestId("security-interruption-dialog");
  await forcedLogoutDialog.getByRole("heading", { name: "登录状态已失效", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await forcedLogoutDialog.getByText("登录状态已失效，请重新登录", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await forcedLogoutDialog.getByText("当前会话已被服务器撤销。请确认后返回主页重新登录。", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const redirectedState = await page.evaluate(() => ({
    pathname: location.pathname,
    tokenPresent: Boolean(localStorage.getItem("auth_token")),
    userPresent: Boolean(localStorage.getItem("auth_user")),
    enteredApp: sessionStorage.getItem("entered_app"),
    reason: document.body.innerText.includes("登录状态已失效，请重新登录"),
  }));
  assert.deepEqual(
    { pathname: redirectedState.pathname, tokenPresent: redirectedState.tokenPresent, userPresent: redirectedState.userPresent, enteredApp: redirectedState.enteredApp },
    { pathname: "/", tokenPresent: false, userPresent: false, enteredApp: null },
    "REVOKED_BROWSER_SESSION_WAS_NOT_CLEARED_AND_RETURNED_HOME",
  );
  assert.equal(redirectedState.reason, true, "FORCED_LOGOUT_REASON_NOT_VISIBLE");
  report.assertions.revokedBrowserReturnsHome = true;
  report.assertions.forcedLogoutReasonSurvivesRedirect = true;
  await page.screenshot({ path: path.join(outputDir, "revoked-session-returned-home.png"), fullPage: false });
  await forcedLogoutDialog.getByRole("button", { name: "返回主页", exact: true }).click();
  await forcedLogoutDialog.waitFor({ state: "detached", timeout: 10_000 });
  report.assertions.forcedLogoutAcknowledgementClearsDialog = true;
  await context.close();

  const logout = await requestJson("/api/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${second.token}` },
  });
  assert.equal(logout.response.status, 200, `LOGOUT_FAILED:${logout.response.status}`);
  assert.deepEqual(await Promise.all([authMeStatus(second.token), authMeStatus(third.token)]), [401, 200]);
  report.assertions.logoutRevokesCurrentOnly = true;

  const sessionRows = (await db.query(
    `SELECT session_id, revoked_at, revoke_reason, ip_hash, user_agent_hash
       FROM public.user_auth_sessions
      WHERE user_id=$1
      ORDER BY created_at,id`,
    [userId],
  )).rows;
  assert.equal(sessionRows.length, 3, "EXPECTED_THREE_SESSION_AUDIT_ROWS");
  const firstSessionId = decodeJwt(first.token).sessionId;
  const secondSessionId = decodeJwt(second.token).sessionId;
  const thirdSessionId = decodeJwt(third.token).sessionId;
  const sessionsById = new Map(sessionRows.map((row) => [row.session_id, row]));
  assert.equal(sessionsById.get(firstSessionId)?.revoke_reason, "concurrency_limit");
  assert.equal(sessionsById.get(secondSessionId)?.revoke_reason, "logout");
  assert.equal(sessionsById.get(thirdSessionId)?.revoked_at, null);
  assert.equal(sessionRows.filter((row) => row.revoked_at == null).length, 1, "EXPECTED_ONE_ACTIVE_SESSION_AFTER_LOGOUT");
  assert.ok(sessionRows.every((row) => row.ip_hash && row.user_agent_hash), "SESSION_AUDIT_HASH_MISSING");
  assert.equal(new Set(sessionRows.map((row) => row.ip_hash)).size, 3, "IP_HASH_IS_NOT_AUDIT_DISTINCT");
  report.assertions.databaseAuditTrailCorrect = true;
  report.assertions.ipAndUserAgentAreAuditMetadata = true;

  // Password and identity-change routes clear the legacy users.session_id.
  // The deployed database trigger must turn that legacy write into an
  // authoritative revocation of every server-owned session, otherwise old
  // devices would remain usable after a credential change.
  await db.query("UPDATE public.users SET session_id=NULL, updated_at=now() WHERE id=$1", [userId]);
  assert.equal(await authMeStatus(third.token), 401, "CREDENTIAL_CHANGE_DID_NOT_REVOKE_REMAINING_SESSION");
  const credentialChangeRows = (await db.query(
    `SELECT session_id, revoked_at, revoke_reason
       FROM public.user_auth_sessions
      WHERE user_id=$1
      ORDER BY created_at,id`,
    [userId],
  )).rows;
  assert.equal(credentialChangeRows.filter((row) => row.revoked_at == null).length, 0, "CREDENTIAL_CHANGE_LEFT_ACTIVE_SESSION");
  assert.equal(
    credentialChangeRows.find((row) => row.session_id === thirdSessionId)?.revoke_reason,
    "account_credentials_changed",
    "CREDENTIAL_CHANGE_REVOKE_REASON_MISSING",
  );
  report.assertions.credentialChangeRevokesEverySession = true;

  await Promise.allSettled(clientErrorBodyReads);
  const expectedTelemetryFailures = report.serverErrors.filter((entry) => (
    entry.status === 503
    && entry.pathname === "/api/product-usage/events"
    && ["PRODUCT_USAGE_POLICY_NOT_CONFIGURED", "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED"].includes(entry.code)
  ));
  const unexpectedServerErrors = report.serverErrors.filter((entry) => !expectedTelemetryFailures.includes(entry));
  const expectedTelemetryConsoleErrors = report.consoleErrors.filter((message) => /status (?:code )?of 503|status of 503/iu.test(message));
  const unexpectedConsoleErrors = report.consoleErrors.filter((message) => !expectedTelemetryConsoleErrors.includes(message));
  assert.equal(
    report.clientErrors.some((entry) => entry.pathname === "/api/product-usage/events" && entry.status === 403),
    false,
    "SAME_ORIGIN_PRODUCT_USAGE_WAS_REJECTED",
  );
  assert.ok(
    expectedTelemetryConsoleErrors.length <= expectedTelemetryFailures.length,
    "UNMATCHED_PRODUCT_USAGE_503_CONSOLE_ERROR",
  );
  report.assertions.sameOriginProductUsageAccepted = true;
  report.assertions.localProductUsagePolicyFailsClosed = expectedTelemetryFailures.length > 0;
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
  assert.deepEqual(unexpectedConsoleErrors, [], "BROWSER_CONSOLE_ERRORS");
  assert.deepEqual(unexpectedServerErrors, [], "SERVER_ERRORS_DURING_AUTH_E2E");
  report.passed = true;
} finally {
  await browser.close().catch(() => undefined);
  const logDeadline = Date.now() + 5_000;
  while (Date.now() < logDeadline) {
    const count = Number((await db.query(
      "SELECT count(*)::int AS count FROM public.login_logs WHERE user_id=$1 OR username=$2",
      [userId, username],
    )).rows[0]?.count || 0);
    if (count >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await db.query("DELETE FROM public.login_logs WHERE user_id=$1 OR username=$2", [userId, username]).catch(() => undefined);
  await db.query("DELETE FROM public.security_events WHERE user_id=$1 OR username=$2", [userId, username]).catch(() => undefined);
  await db.query("DELETE FROM public.users WHERE id=$1", [userId]).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await db.query("DELETE FROM public.login_logs WHERE user_id=$1 OR username=$2", [userId, username]).catch(() => undefined);
  await db.query("DELETE FROM public.security_events WHERE user_id=$1 OR username=$2", [userId, username]).catch(() => undefined);
  await db.end();
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "browser-e2e.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));
