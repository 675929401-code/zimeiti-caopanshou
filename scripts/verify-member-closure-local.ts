import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { createToken } from "@/lib/auth";
import { storeCode } from "@/lib/email-code-store";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { POST as registerUser } from "@/app/api/auth/register/route";
import { POST as loginUser } from "@/app/api/auth/login/route";
import { GET as getCurrentUser } from "@/app/api/auth/me/route";
import { GET as getAdminInvitations } from "@/app/api/admin/invitations/route";
import { GET as getAdminUsers } from "@/app/api/admin/users/route";
import { GET as getAdminLoginLogs } from "@/app/api/admin/login-logs/route";
import { POST as addAdminCredits } from "@/app/api/admin/credits/route";
import { POST as addAdminCash } from "@/app/api/admin/cash/route";
import {
  GET as getUserNotifications,
  PUT as updateUserNotifications,
} from "@/app/api/notifications/user/route";

type JsonObject = Record<string, any>;

const LOCAL_ORIGIN = "http://127.0.0.1:5000";
const evidenceDir = path.resolve(".codex-evidence", "member-closure");
const evidencePath = path.join(evidenceDir, "integration.json");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const localRuntime = JSON.parse(readFileSync(runtimePath, "utf8").replace(/^\uFEFF/u, ""));
assert.equal(localRuntime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(localRuntime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
assert.equal(Number(localRuntime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(new URL(localRuntime.supabaseUrl).origin, "http://127.0.0.1:54321", "LOCAL_SUPABASE_URL_REQUIRED");
// Override the repository's cloud-oriented .env.local before any lazy database
// or JWT helper initializes. This verifier is intentionally unable to write to
// the production project.
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
const cleanupErrors: string[] = [];

const nonce = `${Date.now()}${Math.floor(Math.random() * 10_000).toString().padStart(4, "0")}`;
const digits = nonce.replace(/\D/gu, "");
const phone = `198${digits.slice(-8)}`;
const email = `7${digits.slice(-9)}@qq.com`;
const displayName = `新学员${digits.slice(-4)}`;
const password = `Member9${randomBytes(5).toString("hex")}`;
const emailCode = String(Math.floor(100_000 + Math.random() * 900_000));
const invitationCode = `I${digits.slice(-7)}`.toUpperCase();
const creditRequestKey = `member-closure-credit-${randomUUID()}`;
const cashRequestKey = `member-closure-cash-${randomUUID()}`;

let temporaryUserId = "";
let invitationCodeId = "";
let temporaryAdminSessionId = "";

function request(
  pathname: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers(init.headers || {});
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`${LOCAL_ORIGIN}${pathname}`, {
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

async function callRoute(
  handler: (input: any) => Promise<Response>,
  input: NextRequest,
): Promise<{ response: Response; payload: JsonObject }> {
  const response = await handler(input);
  return { response, payload: await responseJson(response) };
}

async function findActiveAdmin(): Promise<{
  id: string;
  username: string;
  displayName: string;
  sessionId: string;
}> {
  const { data: admins, error } = await database
    .from("users")
    .select("id, username, display_name")
    .eq("role", "admin")
    .eq("is_active", true)
    .eq("status", "active")
    .limit(20);
  assert(!error && admins?.length, error?.message || "ACTIVE_ADMIN_MISSING");

  for (const admin of admins || []) {
    const { data: session, error: sessionError } = await database
      .from("user_auth_sessions")
      .select("session_id")
      .eq("user_id", admin.id)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sessionError && session?.session_id) {
      return {
        id: String(admin.id),
        username: String(admin.username),
        displayName: String(admin.display_name || "管理员"),
        sessionId: String(session.session_id),
      };
    }
  }

  // A production-mode local runtime does not expose a dev-session endpoint and
  // can legitimately have no administrator browser session. Create a narrow,
  // short-lived authority row for this verifier and remove it in finally.
  const admin = admins![0];
  temporaryAdminSessionId = `member-closure-admin-${randomUUID()}`;
  const { error: insertError } = await database.from("user_auth_sessions").insert({
    user_id: admin.id,
    session_id: temporaryAdminSessionId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    revoked_at: null,
    revoke_reason: null,
  });
  assert(!insertError, insertError?.message || "TEMPORARY_ADMIN_SESSION_CREATE_FAILED");
  return {
    id: String(admin.id),
    username: String(admin.username),
    displayName: String(admin.display_name || "管理员"),
    sessionId: temporaryAdminSessionId,
  };
}

async function waitForSuccessfulLoginLog(userId: string): Promise<JsonObject> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data, error } = await database
      .from("login_logs")
      .select("id, user_id, status, login_method, created_at")
      .eq("user_id", userId)
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data as JsonObject;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SUCCESSFUL_LOGIN_LOG_NOT_PERSISTED");
}

async function deleteWhere(table: string, column: string, value: string): Promise<void> {
  const { error } = await database.from(table).delete().eq(column, value);
  if (error) cleanupErrors.push(`${table}:${error.code || error.message}`);
}

async function cleanup(): Promise<void> {
  let resolvedUserId = temporaryUserId;
  if (!resolvedUserId) {
    const { data } = await database.from("users").select("id").eq("email", email).maybeSingle();
    resolvedUserId = data?.id ? String(data.id) : "";
  }

  if (resolvedUserId) {
    // Child rows first: wallet ledger intentionally uses RESTRICT for audit safety.
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
  if (temporaryAdminSessionId) await deleteWhere("user_auth_sessions", "session_id", temporaryAdminSessionId);
}

async function assertNoResidue(): Promise<void> {
  const checks = await Promise.all([
    database.from("users").select("id", { count: "exact", head: true }).eq("email", email),
    database.from("invitation_codes").select("id", { count: "exact", head: true }).eq("code", invitationCode),
    temporaryUserId
      ? database.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", temporaryUserId)
      : Promise.resolve({ count: 0, error: null }),
    temporaryUserId
      ? database.from("wallet_operations").select("id", { count: "exact", head: true }).eq("user_id", temporaryUserId)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  for (const result of checks) assert(!result.error, result.error?.message || "CLEANUP_RESIDUE_CHECK_FAILED");
  assert.deepEqual(checks.map((item) => Number(item.count || 0)), [0, 0, 0, 0], "TEMPORARY_DATA_RESIDUE");
}

async function main(): Promise<void> {
  const checks: Record<string, unknown> = {};
  let passed = false;
  try {
    const admin = await findActiveAdmin();
    const adminToken = await createToken({
      userId: admin.id,
      username: admin.username,
      role: "admin",
      displayName: admin.displayName,
      sessionId: admin.sessionId,
    });

    const { data: codeRow, error: codeError } = await database
      .from("invitation_codes")
      .insert({
        user_id: admin.id,
        code: invitationCode,
        is_permanent: false,
        is_used: false,
      })
      .select("id")
      .single();
    assert(!codeError && codeRow?.id, codeError?.message || "INVITATION_CODE_CREATE_FAILED");
    invitationCodeId = String(codeRow.id);

    assert.equal(storeCode(email, emailCode, "register").ok, true, "EMAIL_CODE_STORE_FAILED");
    const registration = await callRoute(
      registerUser,
      request("/api/auth/register", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.27",
          "user-agent": "Codex local member closure verifier",
        },
        body: { email, phone, displayName, password, code: emailCode, invitationCode },
      }),
    );
    assert.equal(registration.response.status, 200, `REGISTER_HTTP_${registration.response.status}:${registration.payload.error || "unknown"}`);
    assert.equal(registration.payload.success, true, "REGISTER_SUCCESS_REQUIRED");
    assert.equal(typeof registration.payload.token, "string", "REGISTER_TOKEN_REQUIRED");
    temporaryUserId = String(registration.payload.user?.id || "");
    assert(temporaryUserId, "REGISTER_USER_ID_REQUIRED");
    const registrationToken = String(registration.payload.token);

    const currentAfterRegister = await callRoute(
      getCurrentUser,
      request("/api/auth/me", { token: registrationToken }),
    );
    assert.equal(currentAfterRegister.response.status, 200, "REGISTER_TOKEN_MUST_BE_AUTHORIZED");
    assert.equal(String(currentAfterRegister.payload.user?.id || ""), temporaryUserId);

    const [{ data: registeredUser }, { data: attribution }, { data: consumedCode }] = await Promise.all([
      database.from("users").select("id, invited_by, last_sign_in_at, credits, cash_balance").eq("id", temporaryUserId).single(),
      database.from("invitation_records").select("inviter_id, invitee_id, invitation_code_id, invitation_code_snapshot").eq("invitee_id", temporaryUserId).single(),
      database.from("invitation_codes").select("is_used, used_by").eq("id", invitationCodeId).single(),
    ]);
    // Query the authoritative registration session without deriving the opaque id from the JWT.
    const { data: activeRegistrationSessions, error: registrationSessionError } = await database
      .from("user_auth_sessions")
      .select("session_id, revoked_at, expires_at")
      .eq("user_id", temporaryUserId)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());
    assert(!registrationSessionError && activeRegistrationSessions?.length === 1, "REGISTRATION_SESSION_AUTHORITY_REQUIRED");
    assert.equal(String(registeredUser?.invited_by || ""), admin.id, "INVITER_OWNERSHIP_MISMATCH");
    assert.equal(String(attribution?.invitation_code_id || ""), invitationCodeId, "INVITATION_CODE_ID_NOT_RETAINED");
    assert.equal(String(attribution?.invitation_code_snapshot || ""), invitationCode, "INVITATION_CODE_SNAPSHOT_NOT_RETAINED");
    assert.equal(consumedCode?.is_used, true, "ONE_TIME_INVITATION_NOT_CONSUMED");
    assert.equal(String(consumedCode?.used_by || ""), temporaryUserId, "INVITATION_USED_BY_MISMATCH");

    const login = await callRoute(
      loginUser,
      request("/api/auth/login", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.28",
          "user-agent": "Codex local member closure verifier",
        },
        body: { username: email, password },
      }),
    );
    assert.equal(login.response.status, 200, `LOGIN_HTTP_${login.response.status}:${login.payload.error || "unknown"}`);
    assert.equal(login.payload.success, true, "PASSWORD_LOGIN_REQUIRED");
    const studentToken = String(login.payload.token || "");
    assert(studentToken, "LOGIN_TOKEN_REQUIRED");
    const loginLog = await waitForSuccessfulLoginLog(temporaryUserId);
    const { data: userAfterLogin, error: userAfterLoginError } = await database
      .from("users")
      .select("last_sign_in_at, credits, cash_balance")
      .eq("id", temporaryUserId)
      .single();
    assert(!userAfterLoginError && userAfterLogin?.last_sign_in_at, "LAST_SIGN_IN_NOT_UPDATED");
    const activityDriftSeconds = Math.abs(
      new Date(String(userAfterLogin.last_sign_in_at)).getTime() - new Date(String(loginLog.created_at)).getTime(),
    ) / 1000;
    assert(activityDriftSeconds <= 5, `LOGIN_ACTIVITY_DRIFT_${activityDriftSeconds}`);

    const invitationProjection = await callRoute(
      getAdminInvitations,
      request("/api/admin/invitations", { token: adminToken }),
    );
    assert.equal(invitationProjection.response.status, 200, "ADMIN_INVITATION_HTTP_REQUIRED");
    const projectedRecord = (invitationProjection.payload.records || []).find(
      (row: JsonObject) => String(row.invitee_id) === temporaryUserId,
    );
    assert(projectedRecord, "ADMIN_INVITATION_RECORD_MISSING");
    assert.equal(projectedRecord.invitation_code, invitationCode);
    assert.equal(projectedRecord.attribution_status, "exact");

    const usersProjection = await callRoute(
      getAdminUsers,
      request(`/api/admin/users?search=${encodeURIComponent(email)}&page_size=10`, { token: adminToken }),
    );
    assert.equal(usersProjection.response.status, 200, "ADMIN_USERS_HTTP_REQUIRED");
    const projectedUser = (usersProjection.payload.users || []).find((row: JsonObject) => String(row.id) === temporaryUserId);
    assert(projectedUser, "ADMIN_USER_PROJECTION_MISSING");
    assert.equal(projectedUser.lastActive, userAfterLogin.last_sign_in_at, "ADMIN_LAST_ACTIVE_MUST_BE_RAW_ISO");

    const loginLogProjection = await callRoute(
      getAdminLoginLogs,
      request(`/api/admin/login-logs?userId=${encodeURIComponent(temporaryUserId)}&pageSize=10`, { token: adminToken }),
    );
    assert.equal(loginLogProjection.response.status, 200, "ADMIN_LOGIN_LOG_HTTP_REQUIRED");
    assert((loginLogProjection.payload.logs || []).some((row: JsonObject) => row.status === "success"), "ADMIN_LOGIN_LOG_MISSING");

    const creditBody = {
      userId: temporaryUserId,
      amount: 37,
      description: "新学员积分礼包",
      notifyUser: true,
      idempotencyKey: creditRequestKey,
    };
    const creditFirst = await callRoute(
      addAdminCredits,
      request("/api/admin/credits", { method: "POST", token: adminToken, body: creditBody }),
    );
    assert.equal(creditFirst.response.status, 200, `CREDIT_HTTP_${creditFirst.response.status}:${creditFirst.payload.error || "unknown"}`);
    assert.equal(creditFirst.payload.success, true);
    assert.equal(Number(creditFirst.payload.credits), 37);
    assert.equal(creditFirst.payload.notificationDelivery, "created");
    const creditReplay = await callRoute(
      addAdminCredits,
      request("/api/admin/credits", { method: "POST", token: adminToken, body: creditBody }),
    );
    assert.equal(creditReplay.response.status, 200, "CREDIT_REPLAY_HTTP_REQUIRED");
    assert.equal(creditReplay.payload.alreadyFulfilled, true, "CREDIT_REPLAY_MUST_BE_IDEMPOTENT");
    assert.equal(Number(creditReplay.payload.credits), 37);
    assert.equal(creditReplay.payload.notificationDelivery, "existing");

    const cashBody = {
      userId: temporaryUserId,
      amount: 12.34,
      description: "新学员现金礼包",
      notifyUser: true,
      idempotencyKey: cashRequestKey,
    };
    const cashFirst = await callRoute(
      addAdminCash,
      request("/api/admin/cash", { method: "POST", token: adminToken, body: cashBody }),
    );
    assert.equal(cashFirst.response.status, 200, `CASH_HTTP_${cashFirst.response.status}:${cashFirst.payload.error || "unknown"}`);
    assert.equal(cashFirst.payload.success, true);
    assert.equal(Number(cashFirst.payload.balance), 12.34);
    assert.equal(cashFirst.payload.notificationDelivery, "created");
    const cashReplay = await callRoute(
      addAdminCash,
      request("/api/admin/cash", { method: "POST", token: adminToken, body: cashBody }),
    );
    assert.equal(cashReplay.response.status, 200, "CASH_REPLAY_HTTP_REQUIRED");
    assert.equal(cashReplay.payload.alreadyFulfilled, true, "CASH_REPLAY_MUST_BE_IDEMPOTENT");
    assert.equal(Number(cashReplay.payload.balance), 12.34);
    assert.equal(cashReplay.payload.notificationDelivery, "existing");

    const [{ data: finalWallet }, { count: operationCount }, { count: notificationCount }] = await Promise.all([
      database.from("users").select("credits, cash_balance").eq("id", temporaryUserId).single(),
      database.from("wallet_operations").select("id", { count: "exact", head: true }).eq("user_id", temporaryUserId),
      database.from("user_notifications").select("id", { count: "exact", head: true }).eq("user_id", temporaryUserId),
    ]);
    assert.equal(Number(finalWallet?.credits), 37, "CREDIT_BALANCE_DUPLICATED");
    assert.equal(Number(finalWallet?.cash_balance), 12.34, "CASH_BALANCE_DUPLICATED");
    assert.equal(operationCount, 2, "WALLET_OPERATION_COUNT_MUST_BE_TWO");
    assert.equal(notificationCount, 2, "NOTIFICATION_COUNT_MUST_BE_TWO");

    const unread = await callRoute(
      getUserNotifications,
      request("/api/notifications/user", { token: studentToken }),
    );
    assert.equal(unread.response.status, 200, "USER_NOTIFICATIONS_HTTP_REQUIRED");
    assert.equal(unread.payload.success, true);
    assert.equal(unread.payload.unreadCount, 2);
    assert.deepEqual(
      new Set((unread.payload.notifications || []).map((row: JsonObject) => row.title)),
      new Set(["积分礼包已到账", "现金礼包已到账"]),
    );

    const firstNotificationId = String(unread.payload.notifications?.[0]?.id || "");
    assert(firstNotificationId, "NOTIFICATION_ID_REQUIRED");
    const markOne = await callRoute(
      updateUserNotifications,
      request("/api/notifications/user", {
        method: "PUT",
        token: studentToken,
        body: { notificationId: firstNotificationId },
      }),
    );
    assert.equal(markOne.response.status, 200);
    const afterOne = await callRoute(
      getUserNotifications,
      request("/api/notifications/user", { token: studentToken }),
    );
    assert.equal(afterOne.payload.unreadCount, 1, "SINGLE_READ_STATE_NOT_PERSISTED");
    const markAll = await callRoute(
      updateUserNotifications,
      request("/api/notifications/user", {
        method: "PUT",
        token: studentToken,
        body: { markAllRead: true },
      }),
    );
    assert.equal(markAll.response.status, 200);
    const afterAll = await callRoute(
      getUserNotifications,
      request("/api/notifications/user", { token: studentToken }),
    );
    assert.equal(afterAll.payload.unreadCount, 0, "MARK_ALL_READ_STATE_NOT_PERSISTED");

    checks.registrationSessionAuthorized = true;
    checks.exactInvitationAttribution = true;
    checks.passwordLoginAndActivity = true;
    checks.adminInvitationProjection = true;
    checks.adminUserTimestampIso = true;
    checks.creditExactlyOnce = true;
    checks.cashExactlyOnce = true;
    checks.notificationDeliveryExactlyOnce = true;
    checks.notificationReadLifecycle = true;
    checks.activityDriftSeconds = activityDriftSeconds;
    checks.temporaryAdminSessionCreated = Boolean(temporaryAdminSessionId);
    passed = true;
  } finally {
    await cleanup();
    if (cleanupErrors.length === 0) await assertNoResidue();
  }

  assert.equal(cleanupErrors.length, 0, `CLEANUP_FAILED:${cleanupErrors.join(",")}`);
  const report = {
    verifier: "member-closure-local",
    checkedAt: new Date().toISOString(),
    target: "local protected runtime only",
    passed,
    checks,
    temporaryDataRemoved: true,
    productionWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, evidencePath }, null, 2)}\n`);
}

void main().then(
  () => process.exit(0),
  async (error) => {
    const failure = {
      verifier: "member-closure-local",
      checkedAt: new Date().toISOString(),
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      cleanupErrors,
      productionWrites: 0,
      paidModelCalls: 0,
      credentialsPrinted: false,
    };
    await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
    await writeFile(evidencePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => undefined);
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  },
);
