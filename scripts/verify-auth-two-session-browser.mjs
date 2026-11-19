#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium, devices } from "playwright";

const origin = "http://127.0.0.1:5000";
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection?.host, "127.0.0.1");
assert.equal(Number(runtime.ownerConnection?.port), 54322);
assert.equal(runtime.ownerConnection?.database, "zimeiti_local");

const versionResponse = await fetch(origin + "/api/version", { signal: AbortSignal.timeout(8_000) });
assert.equal(versionResponse.status, 200);
const version = await versionResponse.json();
const outputDir = path.resolve(".codex-evidence/auth-session-coexistence");
await fs.mkdir(outputDir, { recursive: true });
const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-auth-session-coexistence",
  connectionTimeoutMillis: 10_000,
  query_timeout: 20_000,
});
const users = [1, 2].map(() => ({
  id: randomUUID(),
  username: "authqa_" + randomBytes(7).toString("hex"),
  password: "Local-" + randomBytes(12).toString("base64url") + "!9",
}));
const report = {
  sourceVersion: version.sourceVersion,
  buildId: version.buildId,
  checked: [],
  screenshots: [],
  pageErrors: [],
  fixtureRowsRemoved: false,
};
const desktopIp = "198.51.100.41";
const phoneIp = "198.51.100.42";
const browsers = [];
const seededUsers = [];

async function login(browser, label, user, ip, options) {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    ...options,
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
  await context.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
    if (request.method() === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname)) return route.continue();
    return route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push({ label, name: error.name }));
  await page.goto(origin + "/login", { waitUntil: "domcontentloaded" });
  await page.locator("#login-account").fill(user.username);
  await page.locator("#login-password").fill(user.password);
  const loginReply = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST",
  );
  await page.locator("form").filter({ has: page.locator("#login-account") }).locator("button[type=submit]").click();
  const response = await loginReply;
  assert.equal(response.status(), 200, label + ": login");
  await page.waitForFunction(() => Boolean(localStorage.getItem("auth_token")));
  await page.waitForURL(url => url.pathname !== "/login");
  const token = await page.evaluate(() => localStorage.getItem("auth_token"));
  const session = { label, context, page, token, userId: user.id, ip };
  await assertActive(session);
  return session;
}

async function readSession(session) {
  return session.context.request.get(origin + "/api/auth/me", {
    headers: { Authorization: "Bearer " + session.token, "x-forwarded-for": session.ip },
  });
}

async function assertActive(session) {
  const response = await readSession(session);
  assert.equal(response.status(), 200, session.label + ": session");
  const body = await response.json();
  assert.equal(body.user?.id, session.userId, session.label + ": session owner");
  assert.equal(await session.page.evaluate(token => localStorage.getItem("auth_token") === token, session.token), true);
  assert.equal(await session.page.getByTestId("security-interruption-dialog").count(), 0);
}

async function failOneBrowserCheck(session, status, body, contentType) {
  const authUrl = "**/api/auth/me";
  const responsePromise = session.page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/auth/me" && response.status() === status,
  );
  const inject = route => route.fulfill({ status, body, contentType });
  await session.page.route(authUrl, inject);
  await session.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const response = await responsePromise;
  await response.finished();
  await session.page.unroute(authUrl, inject);
  await assertActive(session);
}

async function endSessionAndCapture(session, mode) {
  const revocationStatus = await session.page.evaluate(async token => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    return response.status;
  }, session.token);
  assert.equal(revocationStatus, 200);
  const check = await readSession(session);
  assert.equal(check.status(), 401);
  assert.equal((await check.json()).code, "SESSION_REVOKED");

  await session.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const dialog = session.page.getByTestId("security-interruption-dialog");
  await dialog.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await dialog.getByRole("heading").innerText(), "登录已结束");
  assert.equal(await dialog.locator("[data-slot=dialog-description]").innerText(), "重新登录后即可继续使用工作台。");
  const button = dialog.getByRole("button", { name: "重新登录", exact: true });
  assert.equal(await dialog.getByRole("button").count(), 1);
  assert.equal(await button.evaluate(element => document.activeElement === element), true);
  const measurements = await dialog.evaluate(element => ({
    cardWidth: Math.round(element.getBoundingClientRect().width),
    screenWidth: innerWidth,
    borderWidth: getComputedStyle(element).borderLeftWidth,
    iconColor: getComputedStyle(element.querySelector("svg")).color,
  }));
  assert.ok(measurements.cardWidth < measurements.screenWidth);
  assert.equal(measurements.borderWidth, "1px");
  await session.page.screenshot({ path: path.join(outputDir, mode + ".png"), animations: "disabled" });
  if (mode === "desktop") {
    await dialog.screenshot({ path: path.join(outputDir, "dialog-detail.png"), animations: "disabled" });
    await session.page.keyboard.press("Escape");
    assert.ok(await dialog.isVisible());
    await session.page.mouse.click(12, 12);
    assert.ok(await dialog.isVisible());
  }
  await button.click();
  await session.page.waitForURL(url => url.pathname === "/login");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await session.page.evaluate(() => localStorage.getItem("auth_token")), null);
  report.screenshots.push({ mode, ...measurements, loginButtonOpensForm: true });
}

try {
  await db.connect();
  const { rows: [database] } = await db.query("SELECT current_database() AS name, inet_server_port() AS port");
  assert.equal(database.name, "zimeiti_local");
  assert.equal(Number(database.port), 54322);
  for (const user of users) {
    await db.query(
      "INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status,member_status,member_expires_at) " +
      "VALUES($1,$2,$3,$4,'student',0,true,'active','active',now()+interval '1 day')",
      [user.id, user.username, await bcrypt.hash(user.password, 10), "本地验收"],
    );
    seededUsers.push(user);
  }

  const chrome = await chromium.launch({ channel: "chrome", headless: true });
  browsers.push(chrome);
  const edge = await chromium.launch({ channel: "msedge", headless: true });
  browsers.push(edge);

  const first = await login(chrome, "Chrome", users[0], desktopIp);
  const second = await login(edge, "Edge", users[0], desktopIp);
  await assertActive(first);
  const phone = await login(chrome, "phone emulation", users[0], phoneIp, devices["iPhone 13"]);
  const other = await login(chrome, "different account, same computer", users[1], desktopIp);
  const sessions = [first, second, phone, other];
  assert.equal(new Set(sessions.map(session => session.token)).size, sessions.length);
  await Promise.all(sessions.map(assertActive));
  report.checked.push("same-account Chrome, Edge and mobile coexist", "different account on the same computer coexists");

  await failOneBrowserCheck(first, 429, '{"code":"RATE_LIMITED"}', "application/json");
  await failOneBrowserCheck(second, 401, "<html>Proxy unavailable</html>", "text/html");
  await failOneBrowserCheck(phone, 503, '{"code":"AUTH_AUTHORITY_UNAVAILABLE"}', "application/json");
  report.checked.push("unconfirmed 429, HTML 401, and 503 preserve login");

  await endSessionAndCapture(first, "desktop");
  await Promise.all([second, phone, other].map(assertActive));
  await endSessionAndCapture(phone, "mobile");
  await Promise.all([second, other].map(assertActive));
  report.checked.push("explicit logout revokes only its session", "confirmed logout opens desktop and mobile re-login dialog");
  assert.deepEqual(report.pageErrors, []);
} finally {
  await Promise.all(browsers.map(browser => browser.close()));
  try {
    if (seededUsers.length) {
      const ids = seededUsers.map(user => user.id);
      const names = seededUsers.map(user => user.username);
      await db.query("DELETE FROM public.login_logs WHERE user_id=ANY($1::text[]) OR username=ANY($2::text[])", [ids, names]);
      await db.query("DELETE FROM public.security_events WHERE user_id=ANY($1::text[]) OR username=ANY($2::text[])", [ids, names]);
      const deleted = await db.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [ids]);
      assert.equal(deleted.rowCount, seededUsers.length);
      report.fixtureRowsRemoved = true;
    }
  } finally {
    await db.end();
  }
}
await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
