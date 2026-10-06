import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import pg from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { hashPassword } from "@/lib/auth";
import { storeCode } from "@/lib/email-code-store";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { POST as registerUser } from "@/app/api/auth/register/route";

type JsonObject = Record<string, any>;

const ORIGIN = "http://127.0.0.1:5000";
const evidenceDir = path.resolve(".codex-evidence", "member-closure");
const reportPath = path.join(evidenceDir, "browser.json");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const localRuntime = JSON.parse(readFileSync(runtimePath, "utf8").replace(/^\uFEFF/u, ""));

assert.equal(localRuntime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(localRuntime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
assert.equal(Number(localRuntime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(new URL(localRuntime.supabaseUrl).origin, "http://127.0.0.1:54321", "LOCAL_SUPABASE_URL_REQUIRED");

Object.assign(process.env, {
  COZE_SUPABASE_URL: localRuntime.supabaseUrl,
  COZE_SUPABASE_SERVICE_ROLE_KEY: localRuntime.serviceRoleKey,
  COZE_SUPABASE_ANON_KEY: localRuntime.anonKey,
  JWT_SECRET: localRuntime.jwtSecret,
  SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_SUPABASE_URL: localRuntime.supabaseUrl,
  SHARED_CONFIGURATION_SERVICE_ROLE_KEY: localRuntime.serviceRoleKey,
  LOCAL_ACCEPTANCE_PREVIEW: "true",
});

const database = getSupabaseAdminClient();
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const nonce = `${Date.now()}${Math.floor(Math.random() * 10_000).toString().padStart(4, "0")}`;
const digits = nonce.replace(/\D/gu, "");
const phone = `198${digits.slice(-8)}`;
const email = `6${digits.slice(-9)}@qq.com`;
const displayName = `闭环学员${digits.slice(-4)}`;
const password = `Member9${randomBytes(5).toString("hex")}`;
const emailCode = String(Math.floor(100_000 + Math.random() * 900_000));
const invitationCode = `B${digits.slice(-7)}`.toUpperCase();
const offlineCreditDescription = `首次登录礼包-${digits.slice(-6)}`;
const onlineCashDescription = `在线现金礼包-${digits.slice(-6)}`;
const savedBrowserDescription = `保存浏览器礼包-${digits.slice(-6)}`;
const offlineAnnouncementTitle = `首次登录系统通知-${digits.slice(-6)}`;
const onlineAnnouncementTitle = `在线系统通知-${digits.slice(-6)}`;
const adminUsername = `member_browser_admin_${digits.slice(-10)}`;
const adminDisplayName = `闭环验收管理员${digits.slice(-4)}`;
const adminPassword = `Admin9${randomBytes(8).toString("hex")}`;
const adminPermissions = ["members.view", "invitations.manage", "wallet.adjust", "security.view"];

let temporaryUserId = "";
let temporaryAdminUserId = "";
let invitationCodeId = "";
let offlineAnnouncementId = "";
let onlineAnnouncementId = "";
let browser: Browser | null = null;
const cleanupErrors: string[] = [];

const report: JsonObject = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin: ORIGIN,
  target: "127.0.0.1:54322/zimeiti_local",
  viewports: ["1440x900", "1920x1080"],
  excluded: ["带货 Agent", "漫剧工作台"],
  assertions: {},
  queueOrder: [],
  screenshots: [],
  expectedLocalServiceFailures: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  cleanupErrors,
  productionWrites: 0,
  paidModelCalls: 0,
};

function internalRequest(pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function responseJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as JsonObject : {};
  } catch {
    throw new Error(`NON_JSON_RESPONSE_${response.status}:${text.slice(0, 160)}`);
  }
}

async function apiJson(pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await responseJson(response);
  return { response, body };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    return chromium.launch({ headless: true });
  }
}

function createOwnerClient() {
  return new pg.Client({
    ...localRuntime.ownerConnection,
    application_name: "codex-member-browser-closure",
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });
}

async function createTemporaryAdmin() {
  const client = createOwnerClient();
  const passwordHash = await hashPassword(adminPassword);
  temporaryAdminUserId = randomUUID();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.admin_governance_write','on',true)");
    await client.query(
      `INSERT INTO public.users (
         id, username, password_hash, display_name, role, credits, cash_balance,
         is_active, status, member_status
       ) VALUES ($1,$2,$3,$4,'admin',0,0,true,'active','inactive')`,
      [temporaryAdminUserId, adminUsername, passwordHash, adminDisplayName],
    );
    await client.query(
      `UPDATE public.admin_access_profiles
       SET permission_keys=public.normalize_delegable_admin_permission_keys($2::jsonb),
           checksum=public.admin_access_checksum(
             user_id,
             admin_level,
             public.normalize_delegable_admin_permission_keys($2::jsonb),
             revision,
             is_active
           ),
           updated_by=$1,
           updated_at=now()
       WHERE user_id=$1`,
      [temporaryAdminUserId, JSON.stringify(adminPermissions)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const login = await apiJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Codex member closure admin" },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(login.response.status, 200, `ADMIN_LOGIN_HTTP_${login.response.status}:${login.body.error || "unknown"}`);
  assert.equal(login.body.success, true, "ADMIN_LOGIN_SUCCESS_REQUIRED");
  assert.equal(login.body.user?.id, temporaryAdminUserId, "ADMIN_LOGIN_USER_MISMATCH");
  assert.equal(login.body.user?.role, "admin", "ADMIN_LOGIN_ROLE_REQUIRED");
  assert.equal(typeof login.body.token, "string", "ADMIN_LOGIN_TOKEN_REQUIRED");

  const unlock = await apiJson("/api/admin/access-control/unlock", {
    method: "POST",
    headers: {
      authorization: `Bearer ${login.body.token}`,
      "content-type": "application/json",
      "user-agent": "Codex member closure admin",
    },
    body: JSON.stringify({ password: adminPassword, mode: "login" }),
  });
  assert.equal(unlock.response.status, 200, `ADMIN_UNLOCK_HTTP_${unlock.response.status}:${unlock.body.error || "unknown"}`);
  assert.equal(unlock.body.success, true, "ADMIN_UNLOCK_SUCCESS_REQUIRED");
  assert.equal(unlock.body.authMethod, "login_password", "ADMIN_UNLOCK_LOGIN_PASSWORD_REQUIRED");
  const setCookie = unlock.response.headers.get("set-cookie") || "";
  const stepUpToken = setCookie.match(/(?:^|,\s*)zimeiti_admin_step_up=([^;]+)/u)?.[1] || "";
  assert(stepUpToken.length >= 32, "ADMIN_STEP_UP_COOKIE_REQUIRED");

  report.assertions.temporaryAdminUsesMinimumPermissions = true;
  report.assertions.adminPasswordLoginAndStepUp = true;
  return {
    id: temporaryAdminUserId,
    username: adminUsername,
    displayName: adminDisplayName,
    token: String(login.body.token),
    stepUpToken,
  };
}

async function insertAnnouncement(title: string, content: string) {
  const id = randomUUID();
  const { data, error } = await database.from("announcements").insert({
    id,
    title,
    content,
    is_pinned: false,
    is_active: true,
    priority: "important",
    status: "published",
    summary: content,
    target_audience: "selected",
    target_user_ids: [temporaryUserId],
    frequency_hours: 24,
    max_impressions: 3,
    require_ack: true,
  }).select("id,push_revision").single();
  assert(!error && data?.id && Number(data.push_revision) === 1, error?.message || "ANNOUNCEMENT_INSERT_FAILED");
  return id;
}

async function markExistingAnnouncementsRead() {
  const { data, error } = await database
    .from("announcements")
    .select("id,push_revision")
    .eq("is_active", true)
    .gt("push_revision", 0);
  assert(!error, error?.message || "EXISTING_ANNOUNCEMENTS_READ_FAILED");
  const rows = (data || []).map((item: { id: string; push_revision: number }) => ({
    announcement_id: item.id,
    revision: item.push_revision,
    user_id: temporaryUserId,
    read_at: new Date().toISOString(),
  }));
  if (rows.length > 0) {
    const { error: receiptError } = await database
      .from("announcement_user_reads")
      .upsert(rows, { onConflict: "announcement_id,revision,user_id" });
    assert(!receiptError, receiptError?.message || "EXISTING_ANNOUNCEMENT_RECEIPTS_FAILED");
  }
}

async function adminWalletGift(
  pathname: "/api/admin/credits" | "/api/admin/cash",
  adminToken: string,
  adminStepUpToken: string,
  amount: number,
  description: string,
) {
  const key = `member-browser-${pathname.endsWith("cash") ? "cash" : "credit"}-${randomUUID()}`;
  const result = await apiJson(pathname, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "x-admin-step-up": adminStepUpToken,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      userId: temporaryUserId,
      amount,
      description,
      idempotencyKey: key,
      notifyUser: true,
    }),
  });
  assert.equal(
    result.response.status,
    200,
    `${pathname}_HTTP_${result.response.status}:${result.body.error || result.body.code || "unknown"}`,
  );
  assert.equal(result.body.success, true, `${pathname}_SUCCESS_REQUIRED`);
  assert.equal(result.body.notificationDelivery, "created", `${pathname}_NOTIFICATION_REQUIRED`);
  assert.equal(typeof result.body.notificationId, "string", `${pathname}_NOTIFICATION_ID_REQUIRED`);
  report.assertions.walletWritePassedPermissionAndStepUp = true;
  return result.body;
}

function observePage(page: Page, label: string) {
  page.on("pageerror", (error) => report.pageErrors.push(`${label}:${error.message}`));
  page.on("console", (message) => {
    const locationUrl = message.location().url || "";
    if (message.type() === "error"
      && message.text().includes("503 (Service Unavailable)")
      && locationUrl.includes("/api/product-usage/events")) {
      return;
    }
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) {
      report.consoleErrors.push(`${label}:${message.text()}`);
    }
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() === 503 && pathname === "/api/product-usage/events") {
      report.expectedLocalServiceFailures.push({
        label,
        status: response.status(),
        pathname,
        reason: "PRODUCT_USAGE_POLICY_NOT_CONFIGURED_LOCAL_FAIL_CLOSED",
      });
      return;
    }
    if (response.status() >= 500) {
      report.serverErrors.push({ label, status: response.status(), pathname });
    }
  });
}

async function visibleFullDialogIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    '[data-testid="account-notification-dialog"], [data-testid="announcement-reader"]',
  )].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }).map((element) => element.dataset.testid || "unknown"));
}

async function waitForFullDialog(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(
    '[data-testid="account-notification-dialog"], [data-testid="announcement-reader"]',
  )].some((element) => element.getBoundingClientRect().width > 0), null, { timeout: 30_000 });
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `${label}_HORIZONTAL_OVERFLOW:${JSON.stringify(metrics)}`);
}

async function saveScreenshot(page: Page, filename: string) {
  const screenshotPath = path.join(evidenceDir, filename);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  report.screenshots.push(filename);
}

async function processInitialDialogQueue(page: Page) {
  const seen = new Set<string>();
  while (seen.size < 2) {
    await waitForFullDialog(page);
    await page.waitForTimeout(350);
    const visibleIds = await visibleFullDialogIds(page);
    assert.equal(visibleIds.length, 1, `DIALOG_QUEUE_OVERLAP:${visibleIds.join(",")}`);
    const id = visibleIds[0];
    assert(!seen.has(id), `DIALOG_REOPENED_BEFORE_QUEUE_ADVANCED:${id}`);
    seen.add(id);
    report.queueOrder.push(id);
    const owner = await page.locator("html").getAttribute("data-app-dialog-owner");
    assert.equal(owner, id === "account-notification-dialog" ? "account" : "announcement");
    const dialog = page.getByTestId(id);
    const box = await dialog.boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900, `${id}_OUTSIDE_1440_VIEWPORT`);

    if (id === "account-notification-dialog") {
      await page.getByText("积分礼包已到账", { exact: true }).waitFor({ state: "visible" });
      await saveScreenshot(page, "first-login-account-dialog-1440x900.png");
      await page.getByRole("button", { name: "标记已读", exact: true }).click();
      await page.getByRole("button", { name: "关闭账号消息", exact: true }).click();
    } else {
      await page.getByText(offlineAnnouncementTitle, { exact: true }).waitFor({ state: "visible" });
      await saveScreenshot(page, "first-login-announcement-dialog-1440x900.png");
      await page.getByTestId("announcement-mark-read").click();
      await page.getByText("当前已阅读", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "关闭系统公告", exact: true }).click();
    }
    await page.waitForFunction((closedId) => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${closedId}"]`);
      return !element || element.getBoundingClientRect().width === 0;
    }, id, { timeout: 10_000 });
  }
  await page.waitForTimeout(500);
  assert.deepEqual(new Set(report.queueOrder), new Set(["account-notification-dialog", "announcement-reader"]));
  assert.equal((await visibleFullDialogIds(page)).length, 0, "INITIAL_DIALOG_QUEUE_NOT_DRAINED");
  report.assertions.firstLoginUnreadUsesFullDialog = true;
  report.assertions.fullDialogsAreSerialized = true;
}

async function assertCompactToast(page: Page, testId: "account-notification-toast" | "announcement-online-toast", expectedText: string) {
  const toast = page.getByTestId(testId);
  await toast.waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(expectedText, { exact: true }).waitFor({ state: "visible" });
  assert.equal((await visibleFullDialogIds(page)).length, 0, `${testId}_OPENED_WITH_FULL_DIALOG`);
  const geometry = await toast.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rightGap: innerWidth - box.right,
      bottomGap: innerHeight - box.bottom,
      backdropFilter: style.backdropFilter || (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "",
      backgroundColor: style.backgroundColor,
    };
  });
  assert(geometry.width >= 336 && geometry.width <= 344, `${testId}_WIDTH:${geometry.width}`);
  assert(geometry.height >= 190 && geometry.height <= 320, `${testId}_HEIGHT:${geometry.height}`);
  assert(geometry.rightGap >= 20 && geometry.rightGap <= 30, `${testId}_RIGHT_GAP:${geometry.rightGap}`);
  assert(geometry.bottomGap >= 20 && geometry.bottomGap <= 30, `${testId}_BOTTOM_GAP:${geometry.bottomGap}`);
  assert.match(geometry.backdropFilter, /blur/iu, `${testId}_SMOKE_BLUR_REQUIRED:${geometry.backdropFilter}`);
  assert.notEqual(geometry.backgroundColor, "rgb(255, 255, 255)", `${testId}_OPAQUE_WHITE_FORBIDDEN`);
  return geometry;
}

async function addStoredAuth(context: BrowserContext, token: string, user: JsonObject) {
  await context.addCookies([{
    name: "auth_token",
    value: token,
    url: ORIGIN,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await context.addInitScript(({ savedToken, savedUser }) => {
    localStorage.setItem("auth_token", savedToken);
    localStorage.setItem("auth_user", JSON.stringify(savedUser));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.removeItem("entered_app");
    sessionStorage.removeItem("trial_dialog_dismissed");
  }, { savedToken: token, savedUser: user });
}

async function deleteWhere(table: string, column: string, value: string) {
  const { error } = await database.from(table).delete().eq(column, value);
  if (error) cleanupErrors.push(`${table}:${error.code || error.message}`);
}

async function cleanup() {
  let resolvedUserId = temporaryUserId;
  if (!resolvedUserId) {
    const { data } = await database.from("users").select("id").eq("email", email).maybeSingle();
    resolvedUserId = data?.id ? String(data.id) : "";
  }

  for (const announcementId of [offlineAnnouncementId, onlineAnnouncementId].filter(Boolean)) {
    await deleteWhere("announcements", "id", announcementId);
  }
  if (resolvedUserId) {
    await deleteWhere("announcement_user_reads", "user_id", resolvedUserId);
    await deleteWhere("user_notifications", "user_id", resolvedUserId);
    await deleteWhere("balance_audit_log", "user_id", resolvedUserId);
    await deleteWhere("credit_transactions", "user_id", resolvedUserId);
    await deleteWhere("cash_transactions", "user_id", resolvedUserId);
    await deleteWhere("wallet_ledger_entries", "user_id", resolvedUserId);
    await deleteWhere("wallet_operations", "user_id", resolvedUserId);
    await deleteWhere("login_logs", "user_id", resolvedUserId);
    await deleteWhere("password_audit_log", "user_id", resolvedUserId);
    await deleteWhere("user_appearance_preferences", "user_id", resolvedUserId);
    await deleteWhere("invitation_records", "invitee_id", resolvedUserId);
    await deleteWhere("user_auth_sessions", "user_id", resolvedUserId);
    await deleteWhere("users", "id", resolvedUserId);
  }
  if (invitationCodeId) await deleteWhere("invitation_codes", "id", invitationCodeId);
  else await deleteWhere("invitation_codes", "code", invitationCode);

  if (temporaryAdminUserId) {
    const client = createOwnerClient();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.admin_governance_write','on',true)");
      await client.query("DELETE FROM public.admin_step_up_sessions WHERE actor_id=$1", [temporaryAdminUserId]);
      await client.query("DELETE FROM public.admin_access_profiles WHERE user_id=$1", [temporaryAdminUserId]);
      await client.query("DELETE FROM public.login_logs WHERE user_id=$1", [temporaryAdminUserId]);
      await client.query("DELETE FROM public.password_audit_log WHERE user_id=$1", [temporaryAdminUserId]);
      await client.query("DELETE FROM public.user_auth_sessions WHERE user_id=$1", [temporaryAdminUserId]);
      await client.query("DELETE FROM public.users WHERE id=$1", [temporaryAdminUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      cleanupErrors.push(`temporary_admin:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end();
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  if (resolvedUserId) {
    await deleteWhere("login_logs", "user_id", resolvedUserId);
    await deleteWhere("password_audit_log", "user_id", resolvedUserId);
  }
}

async function assertNoResidue() {
  const results = await Promise.all([
    database.from("users").select("id", { count: "exact", head: true }).eq("email", email),
    database.from("invitation_codes").select("id", { count: "exact", head: true }).eq("code", invitationCode),
    temporaryUserId
      ? database.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", temporaryUserId)
      : Promise.resolve({ count: 0, error: null }),
    database.from("announcements").select("id", { count: "exact", head: true }).in("id", [offlineAnnouncementId || randomUUID(), onlineAnnouncementId || randomUUID()]),
    temporaryAdminUserId
      ? database.from("users").select("id", { count: "exact", head: true }).eq("id", temporaryAdminUserId)
      : Promise.resolve({ count: 0, error: null }),
    temporaryAdminUserId
      ? database.from("admin_access_profiles").select("user_id", { count: "exact", head: true }).eq("user_id", temporaryAdminUserId)
      : Promise.resolve({ count: 0, error: null }),
    temporaryAdminUserId
      ? database.from("admin_step_up_sessions").select("id", { count: "exact", head: true }).eq("actor_id", temporaryAdminUserId)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  for (const result of results) assert(!result.error, result.error?.message || "CLEANUP_RESIDUE_CHECK_FAILED");
  assert.deepEqual(results.map((item) => Number(item.count || 0)), [0, 0, 0, 0, 0, 0, 0], "TEMPORARY_BROWSER_DATA_RESIDUE");
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  let executionError: unknown = null;
  try {
    const admin = await createTemporaryAdmin();
    const adminToken = admin.token;

    const { data: codeRow, error: codeError } = await database.from("invitation_codes").insert({
      user_id: admin.id,
      code: invitationCode,
      is_permanent: false,
      is_used: false,
    }).select("id").single();
    assert(!codeError && codeRow?.id, codeError?.message || "INVITATION_CODE_CREATE_FAILED");
    invitationCodeId = String(codeRow.id);

    assert.equal(storeCode(email, emailCode, "register").ok, true, "EMAIL_CODE_STORE_FAILED");
    const registrationResponse = await registerUser(internalRequest("/api/auth/register", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.41", "user-agent": "Codex R602 browser closure" },
      body: { email, phone, displayName, password, code: emailCode, invitationCode },
    }));
    const registration = await responseJson(registrationResponse);
    assert.equal(registrationResponse.status, 200, `REGISTER_HTTP_${registrationResponse.status}:${registration.error || "unknown"}`);
    assert.equal(registration.success, true, "REGISTER_SUCCESS_REQUIRED");
    temporaryUserId = String(registration.user?.id || "");
    assert(temporaryUserId, "REGISTER_USER_ID_REQUIRED");
    await database.from("users").update({
      member_status: "active",
      member_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).eq("id", temporaryUserId);

    const { data: attribution, error: attributionError } = await database
      .from("invitation_records")
      .select("inviter_id,invitation_code_id,invitation_code_snapshot")
      .eq("invitee_id", temporaryUserId)
      .single();
    assert(!attributionError, attributionError?.message || "INVITATION_ATTRIBUTION_MISSING");
    assert.equal(String(attribution.inviter_id), admin.id);
    assert.equal(String(attribution.invitation_code_id), invitationCodeId);
    assert.equal(String(attribution.invitation_code_snapshot), invitationCode);
    report.assertions.invitationRegistrationAttribution = true;

    await markExistingAnnouncementsRead();
    offlineAnnouncementId = await insertAnnouncement(
      offlineAnnouncementTitle,
      "这是一条用于验证登录后未读系统通知、账号级已读回执和弹窗排队的本地临时公告。",
    );
    await adminWalletGift("/api/admin/credits", adminToken, admin.stepUpToken, 37, offlineCreditDescription);

    browser = await launchBrowser();
    const firstContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const firstPage = await firstContext.newPage();
    observePage(firstPage, "member-1440");
    const homeResponse = await firstPage.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(homeResponse?.status(), 200, "PUBLIC_HOME_UNAVAILABLE");
    await firstPage.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await firstPage.locator(".app-shell").count(), 0, "ANONYMOUS_BROWSER_SKIPPED_HOME");
    report.assertions.anonymousStartsAtHome = true;
    await firstPage.getByRole("button", { name: /登录平台/u }).click();
    await firstPage.getByTestId("login-form-shell").waitFor({ state: "visible", timeout: 30_000 });
    await firstPage.locator("#login-account").fill(email);
    await firstPage.locator("#login-password").fill(password);
    await firstPage.getByRole("button", { name: "登 录", exact: true }).click();
    await firstPage.locator(".app-shell").waitFor({ state: "visible", timeout: 60_000 });
    await processInitialDialogQueue(firstPage);
    await assertNoHorizontalOverflow(firstPage, "FIRST_LOGIN_1440");

    const savedAuth = await firstPage.evaluate(() => ({
      token: localStorage.getItem("auth_token") || "",
      user: JSON.parse(localStorage.getItem("auth_user") || "{}"),
      enteredApp: sessionStorage.getItem("entered_app"),
    }));
    assert(savedAuth.token.length > 32 && savedAuth.user?.id === temporaryUserId, "BROWSER_LOGIN_SESSION_NOT_PERSISTED");
    assert.equal(savedAuth.enteredApp, "1", "LOGIN_DID_NOT_ENTER_WORKBENCH");
    report.assertions.passwordLoginReachedWorkbench = true;

    await adminWalletGift("/api/admin/cash", adminToken, admin.stepUpToken, 8.88, onlineCashDescription);
    await firstPage.evaluate(() => window.dispatchEvent(new Event("refresh-account-notifications")));
    report.accountToastGeometry = await assertCompactToast(firstPage, "account-notification-toast", "现金礼包已到账");
    await saveScreenshot(firstPage, "online-cash-toast-1440x900.png");
    await firstPage.getByTestId("account-notification-toast").getByRole("button", { name: "查看详情", exact: true }).click();
    await firstPage.getByTestId("account-notification-dialog").waitFor({ state: "visible" });
    await firstPage.getByText(onlineCashDescription, { exact: false }).waitFor({ state: "visible" });
    await firstPage.getByRole("button", { name: "去个人中心查看", exact: true }).click();
    await firstPage.waitForURL(/\/profile\?tab=notifications/u, { timeout: 30_000 });
    await firstPage.getByText("通知中心", { exact: true }).last().waitFor({ state: "visible", timeout: 30_000 });
    await firstPage.getByText(onlineCashDescription, { exact: false }).waitFor({ state: "visible" });
    await firstPage.getByRole("button", { name: "标记已读", exact: true }).click();
    await firstPage.waitForTimeout(350);
    const notificationState = await firstPage.evaluate(async () => {
      const token = localStorage.getItem("auth_token") || "";
      const response = await fetch("/api/notifications/user", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      return response.json();
    });
    assert.equal(Number(notificationState.unreadCount || 0), 0, "PROFILE_MARK_READ_DID_NOT_CLOSE_LOOP");
    report.assertions.onlineGiftUsesCompactToast = true;
    report.assertions.personalCenterReadLoop = true;

    onlineAnnouncementId = await insertAnnouncement(
      onlineAnnouncementTitle,
      "这是一条用于验证使用过程中系统公告只在右下角提示、不会抢占工作区的本地临时公告。",
    );
    await firstPage.evaluate(() => window.dispatchEvent(new Event("refresh-announcements")));
    report.announcementToastGeometry = await assertCompactToast(firstPage, "announcement-online-toast", onlineAnnouncementTitle);
    await saveScreenshot(firstPage, "online-announcement-toast-1440x900.png");
    await firstPage.getByTestId("announcement-online-toast").getByRole("button", { name: "查看详情", exact: true }).click();
    await firstPage.getByTestId("announcement-reader").waitFor({ state: "visible" });
    await firstPage.getByTestId("announcement-mark-read").click();
    await firstPage.getByText("当前已阅读", { exact: true }).waitFor({ state: "visible" });
    await firstPage.getByRole("button", { name: "关闭系统公告", exact: true }).click();
    report.assertions.onlineAnnouncementUsesCompactToast = true;

    await adminWalletGift("/api/admin/credits", adminToken, admin.stepUpToken, 19, savedBrowserDescription);
    await firstContext.close();

    const savedContext = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: "block" });
    await addStoredAuth(savedContext, savedAuth.token, savedAuth.user);
    const savedPage = await savedContext.newPage();
    observePage(savedPage, "saved-browser-1920");
    await savedPage.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await savedPage.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
    const savedEntryState = await savedPage.evaluate(() => ({
      enteredApp: sessionStorage.getItem("entered_app"),
      homeVisible: Boolean(document.querySelector('[data-testid="soft-white-premium-home"]')),
    }));
    assert.deepEqual(savedEntryState, { enteredApp: null, homeVisible: true }, "SAVED_BROWSER_MUST_START_AT_HOME");
    await savedPage.getByTestId("account-notification-dialog").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await visibleFullDialogIds(savedPage)).length, 1, "SAVED_BROWSER_UNREAD_DIALOG_OVERLAP");
    await savedPage.getByText(savedBrowserDescription, { exact: false }).waitFor({ state: "visible" });
    await assertNoHorizontalOverflow(savedPage, "SAVED_BROWSER_HOME_1920");
    await saveScreenshot(savedPage, "saved-browser-home-unread-1920x1080.png");
    await savedPage.getByRole("button", { name: "标记已读", exact: true }).click();
    await savedPage.getByRole("button", { name: "关闭账号消息", exact: true }).click();
    await savedPage.getByRole("button", { name: /登录平台/u }).click();
    await savedPage.locator(".app-shell").waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await savedPage.evaluate(() => sessionStorage.getItem("entered_app")), "1");
    await assertNoHorizontalOverflow(savedPage, "SAVED_BROWSER_WORKBENCH_1920");
    report.assertions.savedBrowserReturnsHomeBeforeWorkbench = true;
    report.assertions.savedBrowserUnreadUsesFullDialog = true;
    await savedContext.close();

    const adminContext = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: "block" });
    await addStoredAuth(adminContext, adminToken, {
      id: admin.id,
      username: admin.username,
      displayName: admin.displayName,
      role: "admin",
    });
    const adminPage = await adminContext.newPage();
    observePage(adminPage, "admin-1920");
    await adminPage.goto(`${ORIGIN}/admin?tab=invitations`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await adminPage.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await adminPage.getByTestId("invitation-search").fill(invitationCode);
    const invitationRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: invitationCode });
    await invitationRow.waitFor({ state: "visible" });
    assert((await invitationRow.textContent())?.includes(displayName), "ADMIN_INVITATION_STUDENT_NOT_TRACEABLE");
    await assertNoHorizontalOverflow(adminPage, "ADMIN_INVITATIONS_1920");
    await saveScreenshot(adminPage, "admin-invitation-attribution-1920x1080.png");
    report.assertions.adminCanTraceExactInvitation = true;

    await adminPage.goto(`${ORIGIN}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const userCell = adminPage.getByText(displayName, { exact: true }).first();
    await userCell.waitFor({ state: "visible", timeout: 30_000 });
    const userRow = userCell.locator("xpath=ancestor::*[@data-testid='admin-member-card'][1]");
    assert.match((await userRow.textContent()) || "", /2026/u, "ADMIN_USER_ACTIVITY_MUST_INCLUDE_YEAR");
    await saveScreenshot(adminPage, "admin-user-activity-1920x1080.png");

    await adminPage.goto(`${ORIGIN}/admin?tab=login-logs`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const loginCell = adminPage.getByText(displayName, { exact: true }).first();
    await loginCell.waitFor({ state: "visible", timeout: 30_000 });
    const loginRow = loginCell.locator("xpath=ancestor::tr[1]");
    assert.match((await loginRow.textContent()) || "", /2026/u, "LOGIN_LOG_DATE_MUST_INCLUDE_YEAR");
    await assertNoHorizontalOverflow(adminPage, "ADMIN_LOGIN_LOGS_1920");
    await saveScreenshot(adminPage, "admin-login-log-time-1920x1080.png");
    report.assertions.adminActivityAndLoginDatesUseFullYear = true;
    await adminContext.close();

    const [{ data: accountNotifications }, { data: announcementReceipts }] = await Promise.all([
      database.from("user_notifications").select("id,is_read,read_at").eq("user_id", temporaryUserId),
      database.from("announcement_user_reads").select("announcement_id,revision,read_at").eq("user_id", temporaryUserId).in("announcement_id", [offlineAnnouncementId, onlineAnnouncementId]),
    ]);
    assert.equal(accountNotifications?.length, 3, "EXPECTED_THREE_WALLET_NOTIFICATIONS");
    assert(accountNotifications?.every((item: { is_read: boolean; read_at: string | null }) => item.is_read && item.read_at), "ACCOUNT_NOTIFICATION_READ_RECEIPTS_REQUIRED");
    assert.equal(announcementReceipts?.length, 2, "ANNOUNCEMENT_READ_RECEIPTS_REQUIRED");
    assert(announcementReceipts?.every((item: { read_at: string | null }) => item.read_at), "ANNOUNCEMENT_READ_AT_REQUIRED");
    report.assertions.accountScopedReadReceiptsPersisted = true;

    assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
    assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
    assert.deepEqual(report.serverErrors, [], "BROWSER_SERVER_ERRORS");
    report.passed = true;
  } catch (error) {
    executionError = error;
    report.failure = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    await browser?.close().catch(() => undefined);
    await cleanup();
    try {
      await assertNoResidue();
      report.assertions.temporaryDataRemoved = true;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      report.passed = false;
      if (!executionError) executionError = cleanupError;
    }
    if (cleanupErrors.length > 0) report.passed = false;
    report.checkedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
  if (executionError) throw executionError;
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  },
);
