#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_APP_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PREVIEW_ORIGIN_REQUIRED");
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-auth-exclusive-session-browser",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
const outputDir = path.resolve(".codex-evidence/auth-exclusive-session");
const ipOne = "198.51.100.41";
const ipTwo = "198.51.100.42";
const userA = {
  id: crypto.randomUUID(),
  username: `exclusive_a_${crypto.randomBytes(6).toString("hex")}`,
  password: `Local-${crypto.randomBytes(12).toString("base64url")}!9`,
};
const userB = {
  id: crypto.randomUUID(),
  username: `exclusive_b_${crypto.randomBytes(6).toString("hex")}`,
  password: `Local-${crypto.randomBytes(12).toString("base64url")}!9`,
};
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  target: "127.0.0.1:54322/zimeiti_local",
  assertions: {},
  providerRequests: 0,
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
};

const requestJson = async (pathname, init = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw: raw.slice(0, 200) }; }
  return { response, body };
};

const login = async (user, ip) => {
  const result = await requestJson("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `Codex-Exclusive-Session/${user.username}`,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  assert.equal(result.response.status, 200, `LOGIN_FAILED:${result.response.status}:${result.body?.code || result.body?.error || "unknown"}`);
  assert.equal(result.body?.success, true);
  assert.ok(typeof result.body?.token === "string" && result.body.token.length > 32);
  return result.body;
};

const authStatus = async (token, ip) => (await requestJson("/api/auth/me", {
  headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": ip },
})).response.status;

await fs.mkdir(outputDir, { recursive: true });
await db.connect();
try {
  const identity = (await db.query(
    "SELECT current_database() AS database_name, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  for (const user of [userA, userB]) {
    await db.query(
      `INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status,member_status,member_expires_at)
       VALUES($1,$2,$3,$4,'student',0,true,'active','active',now()+interval '1 day')`,
      [user.id, user.username, await bcrypt.hash(user.password, 10), user.username],
    );
  }

  const a1 = await login(userA, ipOne);
  const appearance = await requestJson("/api/auth/me", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${a1.token}`,
      "content-type": "application/json",
      "x-forwarded-for": ipOne,
    },
    body: JSON.stringify({ theme_preference: "lattice", theme_mode_preference: "dark" }),
  });
  assert.equal(appearance.response.status, 200, `THEME_SAVE_FAILED:${appearance.response.status}`);
  assert.equal(appearance.body?.success, true);
  assert.ok(Date.parse(appearance.body?.appearancePreference?.expiresAt) > Date.now());
  report.assertions.personalThemeLeaseSaved = true;

  const a2 = await login(userA, ipOne);
  assert.deepEqual(await Promise.all([authStatus(a1.token, ipOne), authStatus(a2.token, ipOne)]), [200, 200]);
  report.assertions.sameAccountSameIpMultipleBrowsersRemainActive = true;

  const a3 = await login(userA, ipTwo);
  assert.deepEqual(
    await Promise.all([authStatus(a1.token, ipOne), authStatus(a2.token, ipOne), authStatus(a3.token, ipTwo)]),
    [401, 401, 200],
  );
  report.assertions.sameAccountDifferentIpEvictsPriorIpBrowsers = true;

  const b1 = await login(userB, ipTwo);
  assert.deepEqual(await Promise.all([authStatus(a3.token, ipTwo), authStatus(b1.token, ipTwo)]), [401, 200]);
  report.assertions.sameIpNewAccountEvictsPriorAccount = true;

  const a4 = await login(userA, ipOne);
  assert.deepEqual(await Promise.all([authStatus(a4.token, ipOne), authStatus(b1.token, ipTwo)]), [200, 200]);
  report.assertions.differentIpsKeepDifferentAccountsActive = true;

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    extraHTTPHeaders: { "x-forwarded-for": ipOne },
  });
  await context.addInitScript(() => {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    localStorage.setItem("user_theme_preference", "lattice");
    localStorage.setItem("user_theme_mode_preference", "dark");
    localStorage.setItem("user_theme_preference_expires_at", new Date(Date.now() + 60_000).toISOString());
    sessionStorage.removeItem("entered_app");
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/status (?:code )?of (?:401|503)|ERR_BLOCKED_BY_CLIENT/iu.test(message.text())) {
      report.consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on("response", response => {
    if (response.status() >= 500 && new URL(response.url()).pathname !== "/api/product-usage/events") {
      report.serverErrors.push({ status: response.status(), path: new URL(response.url()).pathname });
    }
  });

  const loginPageResponse = await page.goto(`${origin}/login?redirect=%2F`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(loginPageResponse?.status(), 200);
  await page.locator('[data-page="public-auth-login"]').waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.locator("html").getAttribute("data-theme-selection"), "lattice");
  await page.locator("#login-account").fill(userA.username);
  await page.locator("#login-password").fill(userA.password);
  await page.locator('form[data-react-managed]').filter({ has: page.locator("#login-account") }).getByRole("button", { name: "登 录", exact: true }).click();
  await page.waitForURL(origin + "/", { timeout: 60_000 });
  await page.locator(".marketplace-shell").waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await page.evaluate(() => sessionStorage.getItem("entered_app")), "1");
  assert.equal(await page.locator("html").getAttribute("data-theme-selection"), "lattice");
  assert.equal(await authStatus(a4.token, ipOne), 200, "SAME_IP_API_SESSION_EVICTED_BY_BROWSER_LOGIN");
  report.assertions.dedicatedLoginEntersMarketplace = true;
  report.assertions.personalThemeMatchesLoginAndMarketplace = true;
  report.assertions.browserLoginPreservesSameIpSiblingSession = true;
  await page.screenshot({ path: path.join(outputDir, "login-to-marketplace-lattice.png"), fullPage: false });

  const b2 = await login(userB, ipOne);
  assert.equal(await authStatus(b2.token, ipOne), 200);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(origin + "/", { timeout: 30_000 });
  await page.getByTestId("security-interruption-dialog").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem("auth_token")), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("entered_app")), null);
  report.assertions.evictedBrowserAutomaticallyLeavesApplication = true;
  await page.screenshot({ path: path.join(outputDir, "evicted-session-forced-out.png"), fullPage: false });
  await context.close();

  const activeRows = await db.query(
    `SELECT user_id,ip_hash,count(*)::int AS count
       FROM public.user_auth_sessions
      WHERE revoked_at IS NULL AND expires_at>now() AND user_id=ANY($1::text[])
      GROUP BY user_id,ip_hash`,
    [[userA.id, userB.id]],
  );
  const userIpConflicts = await db.query(
    `SELECT user_id FROM public.user_auth_sessions
      WHERE revoked_at IS NULL AND expires_at>now() AND ip_hash IS NOT NULL AND user_id=ANY($1::text[])
      GROUP BY user_id HAVING count(DISTINCT ip_hash)>1`,
    [[userA.id, userB.id]],
  );
  const ipUserConflicts = await db.query(
    `SELECT ip_hash FROM public.user_auth_sessions
      WHERE revoked_at IS NULL AND expires_at>now() AND ip_hash IS NOT NULL AND user_id=ANY($1::text[])
      GROUP BY ip_hash HAVING count(DISTINCT user_id)>1`,
    [[userA.id, userB.id]],
  );
  assert.equal(userIpConflicts.rowCount, 0);
  assert.equal(ipUserConflicts.rowCount, 0);
  assert.ok(activeRows.rows.every(row => row.count >= 1));
  report.assertions.databaseAccountIpScopeInvariantStillHoldsAfterHttpFlows = true;

  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.serverErrors, []);
  report.passed = true;
} finally {
  await browser.close().catch(() => undefined);
  await db.query("DELETE FROM public.login_logs WHERE user_id=ANY($1::text[]) OR username=ANY($2::text[])", [[userA.id, userB.id], [userA.username, userB.username]]).catch(() => undefined);
  await db.query("DELETE FROM public.security_events WHERE user_id=ANY($1::text[]) OR username=ANY($2::text[])", [[userA.id, userB.id], [userA.username, userB.username]]).catch(() => undefined);
  await db.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [[userA.id, userB.id]]).catch(() => undefined);
  await db.end();
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "browser-e2e.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));
