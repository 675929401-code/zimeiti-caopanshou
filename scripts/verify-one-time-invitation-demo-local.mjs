#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence", "one-time-invitation", "demo");

const demo = {
  inviter: {
    username: "invite_demo_owner_20261001",
    displayName: "邀请码闭环演示-邀请人",
    phone: "18800001001",
    email: "26091001@qq.com",
    password: "InviteDemo#2026",
  },
  invitee: {
    username: "user_18800001002",
    displayName: "邀请码闭环演示-受邀学员",
    phone: "18800001002",
    email: "26091002@qq.com",
    password: "InviteDemo#2026",
  },
  rejectedSecondInvitee: {
    username: "user_18800001999",
    displayName: "邀请码复用应失败",
    phone: "18800001999",
    email: "26091999@qq.com",
  },
};

function asNumber(value) {
  const number = Number(value);
  assert.ok(Number.isFinite(number), `FINITE_NUMBER_REQUIRED:${value}`);
  return number;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function closeOptionalOverlays(page) {
  await page.waitForTimeout(800);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const announcement = page.getByTestId("announcement-reader");
    if (await announcement.isVisible().catch(() => false)) {
      const close = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
      if (await close.count()) await close.click();
      else {
        const markRead = announcement.getByRole("button", { name: /标记已阅读/u }).first();
        if (await markRead.count()) await markRead.click();
        else {
          const iconClose = announcement.locator("button").first();
          if (await iconClose.count()) await iconClose.click();
        }
      }
      await page.waitForTimeout(150);
      continue;
    }
    const account = page.getByTestId("account-notification-dialog");
    if (await account.isVisible().catch(() => false)) {
      await account.getByRole("button", { name: "关闭账号消息" }).click();
      await page.waitForTimeout(150);
      continue;
    }
    break;
  }
}

async function removePriorDemo(client) {
  const users = await client.query(
    "SELECT id::text AS id FROM public.users WHERE username=ANY($1::text[])",
    [[demo.inviter.username, demo.invitee.username, demo.rejectedSecondInvitee.username]],
  );
  const ids = users.rows.map((row) => String(row.id));
  if (ids.length === 0) return 0;

  await client.query("BEGIN");
  try {
    const records = await client.query(
      "SELECT id::text AS id FROM public.invitation_records WHERE inviter_id::text=ANY($1::text[]) OR invitee_id::text=ANY($1::text[])",
      [ids],
    );
    const recordIds = records.rows.map((row) => String(row.id));
    if (recordIds.length > 0) {
      await client.query("DELETE FROM public.invitation_reward_grants WHERE invitation_record_id=ANY($1::text[])", [recordIds]);
      await client.query("DELETE FROM public.invitation_records WHERE id=ANY($1::text[])", [recordIds]);
    }
    await client.query("DELETE FROM public.member_activation_events WHERE user_id::text=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.user_notifications WHERE user_id::text=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.wallet_operations WHERE user_id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.login_logs WHERE user_id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.password_audit_log WHERE user_id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.user_auth_sessions WHERE user_id=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.invitation_codes WHERE user_id::text=ANY($1::text[])", [ids]);
    await client.query("DELETE FROM public.users WHERE id=ANY($1::text[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return ids.length;
}

async function dispatchReward(page, inviterName, stageTitle, credits, cashAmount) {
  const row = page.getByTestId("invitation-attribution-row").filter({ hasText: inviterName });
  const stageCard = row.locator("div.rounded-2xl").filter({ hasText: stageTitle }).last();
  await stageCard.getByRole("button", { name: "发给邀请人" }).click();
  const dialog = page.getByTestId("invitation-reward-dialog");
  await dialog.getByTestId("invitation-reward-credits").fill(String(credits));
  await dialog.getByTestId("invitation-reward-cash").fill(String(cashAmount));
  page.once("dialog", async (confirmation) => confirmation.accept());
  await page.getByTestId("invitation-reward-dialog").getByTestId("invitation-reward-send").click();
  await page.getByTestId("invitation-reward-dialog").getByTestId("invitation-reward-receipt").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("invitation-reward-dialog").getByRole("button", { name: "关闭礼包派发窗口" }).click();
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(adminIdentity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const adminId = String(adminIdentity.user.id || "");
  assert.match(adminId, /^[0-9a-f-]{36}$/iu, "LOCAL_ADMIN_UUID_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-one-time-invitation-demo",
    connectionTimeoutMillis: 10_000,
    query_timeout: 45_000,
  });
  const report = {
    passed: false,
    checkedAt: "",
    target: `${origin}/admin?tab=invitations`,
    viewport: { width: 1440, height: 900 },
    assertions: {},
    failedResponses: [],
    pageErrors: [],
    consoleErrors: [],
    productionWrites: 0,
    paidCalls: 0,
  };

  await fs.mkdir(evidenceDir, { recursive: true });
  await client.connect();
  let browser;
  try {
    report.replacedPriorDemoUsers = await removePriorDemo(client);

    const inviterId = crypto.randomUUID();
    const inviterHash = await bcrypt.hash(demo.inviter.password, 10);
    await client.query(
      `INSERT INTO public.users
       (id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,allowed_categories,phone,email,created_at,updated_at)
       VALUES($1,$2,$3,$4,'student',0,0,true,'active','active','[]'::jsonb,$5,$6,now(),now())`,
      [inviterId, demo.inviter.username, inviterHash, demo.inviter.displayName, demo.inviter.phone, demo.inviter.email],
    );
    await client.query(
      `INSERT INTO public.password_audit_log(user_id,action,performed_by,performed_by_role,performed_by_name,details)
       VALUES($1,'admin_create',$2,'admin',$3,'本地一次性邀请码闭环演示账号')`,
      [inviterId, adminId, String(adminIdentity.user.displayName || adminIdentity.user.username || "本地管理员")],
    );

    const permissionRead = await jsonRequest(`${origin}/api/admin/users/permissions?user_id=${encodeURIComponent(inviterId)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(permissionRead.response.status, 200, `DEMO_PERMISSION_READ_FAILED:${JSON.stringify(permissionRead.payload)}`);
    const permissionRevision = Number(permissionRead.payload.permission?.revision || 0);
    const permissionKey = `invitation-demo-permission:${inviterId}`;
    const permissionSave = await jsonRequest(`${origin}/api/admin/users/permissions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
        "Idempotency-Key": permissionKey,
      },
      body: JSON.stringify({
        userId: inviterId,
        featureNavigationKeys: ["youcai"],
        agentNavigationKeys: [],
        expectedRevision: permissionRevision,
        idempotencyKey: permissionKey,
        reason: "本地邀请闭环演示：开放有才推荐计划验收页",
      }),
    });
    assert.equal(permissionSave.response.status, 200, `DEMO_PERMISSION_SAVE_FAILED:${JSON.stringify(permissionSave.payload)}`);
    assert.equal(permissionSave.payload.success, true);
    report.assertions.demoFeaturePermissionPersisted = true;

    const inviterLogin = await jsonRequest(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: demo.inviter.phone, password: demo.inviter.password }),
    });
    assert.equal(inviterLogin.response.status, 200, `INVITER_LOGIN_FAILED:${JSON.stringify(inviterLogin.payload)}`);
    assert.equal(inviterLogin.payload.success, true);
    const inviterToken = String(inviterLogin.payload.token || "");
    assert.ok(inviterToken, "INVITER_TOKEN_REQUIRED");
    report.assertions.inviterCanLogin = true;

    const generated = await jsonRequest(`${origin}/api/invitation/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviterToken}` },
    });
    assert.equal(generated.response.status, 200, `FIRST_CODE_GENERATION_FAILED:${JSON.stringify(generated.payload)}`);
    const firstCode = String(generated.payload.code?.code || "");
    assert.match(firstCode, /^[A-Z2-9]{8}$/u, "FIRST_ONE_TIME_CODE_REQUIRED");
    assert.equal(generated.payload.code?.is_used, false);
    assert.equal(generated.payload.code?.is_permanent, false);

    const generatedAgain = await jsonRequest(`${origin}/api/invitation/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviterToken}` },
    });
    assert.equal(generatedAgain.response.status, 200);
    assert.equal(generatedAgain.payload.code?.code, firstCode, "OPEN_CODE_GENERATION_MUST_BE_IDEMPOTENT");
    assert.equal(generatedAgain.payload.reusedOpenCode, true);
    report.assertions.onlyOneOpenCodeBeforeUse = true;

    const validBefore = await jsonRequest(`${origin}/api/invitation/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: firstCode }),
    });
    assert.equal(validBefore.payload.valid, true);

    const inviteeHash = await bcrypt.hash(demo.invitee.password, 10);
    const registrationSession = crypto.randomBytes(32).toString("hex");
    const inviterSession = (await client.query(
      `SELECT id,ip_hash FROM public.user_auth_sessions
       WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [inviterId],
    )).rows[0];
    assert.ok(inviterSession?.id, "INVITER_ACTIVE_SESSION_REQUIRED");
    const registrationIpHash = String(inviterSession.ip_hash || "f".repeat(16));
    if (!inviterSession.ip_hash) {
      await client.query("UPDATE public.user_auth_sessions SET ip_hash=$1 WHERE id=$2", [registrationIpHash, inviterSession.id]);
    }
    const registrationDeviceHash = "e".repeat(32);
    const registered = await client.query(
      "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [demo.invitee.email, demo.invitee.phone, demo.invitee.username, inviteeHash, demo.invitee.displayName, firstCode, registrationSession, registrationIpHash, registrationDeviceHash],
    );
    assert.equal(registered.rows[0].result?.ok, true, "FIRST_REGISTRATION_MUST_SUCCEED");
    assert.equal(registered.rows[0].result?.risk_status, "review", "SAME_IP_REGISTRATION_MUST_REQUIRE_REVIEW");
    assert.equal(registered.rows[0].result?.automatic_trial_eligible, false);
    const inviteeId = String(registered.rows[0].result.user.id);
    await client.query(
      `INSERT INTO public.password_audit_log(user_id,action,details)
       VALUES($1,'register','本地一次性邀请码闭环演示：原子注册事务')`,
      [inviteeId],
    );

    const validAfter = await jsonRequest(`${origin}/api/invitation/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: firstCode }),
    });
    assert.equal(validAfter.payload.valid, false);
    assert.match(String(validAfter.payload.error || ""), /已被使用/u);

    const rejectedReuse = await client.query(
      "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [
        demo.rejectedSecondInvitee.email,
        demo.rejectedSecondInvitee.phone,
        demo.rejectedSecondInvitee.username,
        inviteeHash,
        demo.rejectedSecondInvitee.displayName,
        firstCode,
        crypto.randomBytes(32).toString("hex"),
        registrationIpHash,
        registrationDeviceHash,
      ],
    );
    assert.equal(rejectedReuse.rows[0].result?.ok, false);
    assert.equal(rejectedReuse.rows[0].result?.code, "INVITATION_USED");
    const rejectedUserCount = await client.query("SELECT count(*)::integer AS count FROM public.users WHERE phone=$1", [demo.rejectedSecondInvitee.phone]);
    assert.equal(Number(rejectedUserCount.rows[0].count), 0, "REUSED_CODE_MUST_NOT_CREATE_SECOND_USER");
    report.assertions.usedCodeRejectsSecondRegistrationAtomically = true;

    const nextGenerated = await jsonRequest(`${origin}/api/invitation/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviterToken}` },
    });
    assert.equal(nextGenerated.response.status, 200, `NEXT_CODE_GENERATION_FAILED:${JSON.stringify(nextGenerated.payload)}`);
    const nextCode = String(nextGenerated.payload.code?.code || "");
    assert.match(nextCode, /^[A-Z2-9]{8}$/u);
    assert.notEqual(nextCode, firstCode, "SECOND_INVITATION_REQUIRES_NEW_CODE");
    report.assertions.nextCodeRequiresPriorConsumption = true;

    const activationKey = `invitation-demo-activation:${inviteeId}`;
    const activation = await client.query(
      "SELECT public.set_member_activation_state_atomic($1,$2,'active','admin_manual',$3,3980,$4,$5) AS result",
      [adminId, inviteeId, "WX-DEMO-3980-20261001", "本地闭环演示：微信学费人工确认", activationKey],
    );
    assert.equal(activation.rows[0].result?.success, true, "INVITEE_ACTIVATION_REQUIRED");
    report.assertions.activationOnlyUnlocksRewardNode = true;

    browser = await chromium.launch({ headless: true });
    const adminContext = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    adminContext.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.includes("__nextjs_original-stack-frames")) {
        report.failedResponses.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });
    await adminContext.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: adminToken, user: adminIdentity.user });
    const adminPage = await adminContext.newPage();
    adminPage.on("pageerror", (error) => report.pageErrors.push(error.message));
    adminPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
    await adminPage.goto(`${origin}/admin?tab=invitations`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await adminPage.getByTestId("admin-invitation-attribution").waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(adminPage);
    await adminPage.getByTestId("invitation-monthly-limit").selectOption("6");
    await adminPage.getByTestId("save-invitation-monthly-limit").click();
    await adminPage.getByTestId("invitation-reward-success").filter({ hasText: "每位会员每月最多生成 6 枚" }).waitFor({ state: "visible", timeout: 20_000 });
    report.assertions.adminCanPersistMonthlyInvitationLimit = true;
    const relationRow = adminPage.getByTestId("invitation-attribution-row").filter({ hasText: demo.inviter.displayName });
    await relationRow.waitFor({ state: "visible", timeout: 30_000 });
    const rowText = await relationRow.innerText();
    assert.match(rowText, new RegExp(firstCode, "u"));
    assert.match(rowText, /一次性码 · 已消费/u);
    assert.match(rowText, /人工确认付款/u);
    assert.match(rowText, /需人工复核|自动体验包已暂缓/u);
    report.assertions.adminShowsConsumedCodeAndExactAttribution = true;
    const reviewDialogHandler = async (dialog) => {
      if (dialog.type() === "prompt") await dialog.accept("本地验收：已核实为真实学员，共用网络");
      else await dialog.accept();
    };
    adminPage.on("dialog", reviewDialogHandler);
    await relationRow.getByRole("button", { name: "核验通过" }).click();
    await adminPage.getByTestId("invitation-reward-success").filter({ hasText: "风险复核已通过" }).waitFor({ state: "visible", timeout: 20_000 });
    adminPage.off("dialog", reviewDialogHandler);
    report.assertions.adminCanClearRiskForSharedNetwork = true;
    await adminPage.screenshot({ path: path.join(evidenceDir, "01-admin-before-dispatch-1440x900.png"), fullPage: true });

    await dispatchReward(adminPage, demo.inviter.displayName, "② 邀请注册奖励", 88, 0.88);
    report.assertions.registrationRewardDispatchedFromAdminUi = true;
    await dispatchReward(adminPage, demo.inviter.displayName, "③ 正式会员邀请奖励", 398, 3.98);
    report.assertions.activationRewardDispatchedFromAdminUi = true;

    await adminPage.getByRole("button", { name: "已闭环" }).click();
    await adminPage.getByText("没有符合当前搜索或筛选条件的邀请关系。", { exact: true }).waitFor({ state: "visible" });
    report.assertions.relationshipDoesNotFalselyCloseBeforeNewcomerPackage = true;
    await adminPage.getByRole("button", { name: "全部关系" }).click();
    await adminPage.getByTestId("invitation-attribution-row").filter({ hasText: demo.inviter.displayName }).waitFor({ state: "visible" });
    await adminPage.screenshot({ path: path.join(evidenceDir, "02-admin-inviter-rewards-sent-package-pending-1440x900.png"), fullPage: true });
    const adminLayout = await adminPage.evaluate(() => ({
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(adminLayout.horizontalOverflow <= 1, `ADMIN_HORIZONTAL_OVERFLOW:${adminLayout.horizontalOverflow}`);
    assert.equal(adminLayout.applicationError, false);
    report.adjacentAdminPages = [];
    for (const tab of ["users", "cami"]) {
      await adminPage.goto(`${origin}/admin?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await adminPage.locator("main").waitFor({ state: "visible", timeout: 30_000 });
      await closeOptionalOverlays(adminPage);
      if (tab === "users") {
        await adminPage.getByTestId("admin-member-card").filter({ hasText: demo.inviter.displayName }).waitFor({ state: "visible", timeout: 30_000 });
        await adminPage.getByTestId("admin-member-card").filter({ hasText: demo.invitee.displayName }).waitFor({ state: "visible", timeout: 30_000 });
      } else {
        await adminPage.getByText("卡密管理", { exact: true }).last().waitFor({ state: "visible", timeout: 30_000 });
      }
      const layout = await adminPage.evaluate(() => ({
        textLength: document.querySelector("main")?.textContent?.trim().length || 0,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      }));
      assert.ok(layout.textLength > 80, `ADJACENT_ADMIN_PAGE_EMPTY:${tab}`);
      assert.ok(layout.horizontalOverflow <= 1, `ADJACENT_ADMIN_HORIZONTAL_OVERFLOW:${tab}`);
      assert.equal(layout.applicationError, false, `ADJACENT_ADMIN_APPLICATION_ERROR:${tab}`);
      report.adjacentAdminPages.push({ tab, ...layout });
      await adminPage.screenshot({ path: path.join(evidenceDir, `adjacent-${tab}-1440x900.png`), fullPage: true });
    }
    report.assertions.twoAdjacentAdminPagesPassed = true;
    await adminContext.close();

    const wallet = await client.query(
      `SELECT users.credits,users.cash_balance,
              (SELECT count(*)::integer FROM public.wallet_operations WHERE user_id=users.id) AS wallet_operations,
              (SELECT count(*)::integer FROM public.user_notifications WHERE user_id=users.id::uuid AND type='invitation_reward') AS notifications,
              (SELECT count(*)::integer FROM public.invitation_reward_grants grant_row
                JOIN public.invitation_records record ON record.id=grant_row.invitation_record_id
               WHERE record.inviter_id=users.id::uuid AND grant_row.status='sent') AS sent_rewards
         FROM public.users WHERE users.id=$1`,
      [inviterId],
    );
    assert.equal(asNumber(wallet.rows[0].credits), 486);
    assert.equal(asNumber(wallet.rows[0].cash_balance), 4.86);
    assert.equal(asNumber(wallet.rows[0].wallet_operations), 4);
    assert.equal(asNumber(wallet.rows[0].notifications), 2);
    assert.equal(asNumber(wallet.rows[0].sent_rewards), 2);
    report.assertions.rewardsCreditedDirectlyExactlyOnce = true;

    const notificationApi = await jsonRequest(`${origin}/api/notifications/user`, {
      headers: { Authorization: `Bearer ${inviterToken}` },
    });
    assert.equal(notificationApi.response.status, 200);
    assert.equal(notificationApi.payload.unreadCount, 2);
    assert.ok(notificationApi.payload.notifications.every((item) => item.type === "invitation_reward" && item.cami_code == null));
    report.assertions.notificationsAreUnreadReceiptsWithoutClaimCode = true;

    const userContext = await browser.newContext({
      viewport: report.viewport,
      serviceWorkers: "block",
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await userContext.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { token: inviterToken, user: inviterLogin.payload.user });
    const userPage = await userContext.newPage();
    userPage.on("pageerror", (error) => report.pageErrors.push(error.message));
    userPage.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
    await userPage.goto(`${origin}/profile?tab=notifications`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await userPage.getByText("通知中心", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    const announcement = userPage.getByTestId("announcement-reader");
    if (await announcement.isVisible().catch(() => false)) {
      const closeAnnouncement = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
      if (await closeAnnouncement.count()) await closeAnnouncement.click();
    }
    const notificationDialog = userPage.getByTestId("account-notification-dialog");
    if (!await notificationDialog.isVisible().catch(() => false)) {
      await userPage.evaluate(() => window.dispatchEvent(new Event("open-account-notifications")));
    }
    await notificationDialog.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await notificationDialog.innerText(), /正式会员邀请奖励已到账|邀请注册奖励已到账/u);
    await userPage.screenshot({ path: path.join(evidenceDir, "03-user-login-unread-popup-1440x900.png"), fullPage: true });
    await notificationDialog.getByRole("button", { name: "关闭账号消息" }).click();
    await userPage.getByText("邀请注册奖励已到账", { exact: true }).waitFor({ state: "visible" });
    await userPage.getByText("正式会员邀请奖励已到账", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await userPage.getByRole("button", { name: "一键兑换" }).count(), 0, "INVITATION_REWARD_MUST_NOT_REQUIRE_CLAIM");
    await userPage.screenshot({ path: path.join(evidenceDir, "04-user-notification-receipts-1440x900.png"), fullPage: true });
    report.assertions.userSeesUnreadPopupAndReceiptList = true;

    await userPage.goto(`${origin}/profile?tab=invitation`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await closeOptionalOverlays(userPage);
    await userPage.getByText(firstCode, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await userPage.getByText(nextCode, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await userPage.locator("body").innerText(), /一人一码/u);
    const nextCodeRow = userPage.getByTestId("invitation-code-row").filter({ hasText: nextCode });
    const invitationCopyButton = await nextCodeRow.count()
      ? nextCodeRow.getByRole("button", { name: "复制邀请说明" })
      : userPage.getByRole("button", { name: "复制邀请说明" }).last();
    await invitationCopyButton.click();
    const invitationClipboard = await userPage.evaluate(() => navigator.clipboard.readText());
    assert.match(invitationClipboard, new RegExp(`/register\\?invite=${nextCode}`, "u"));
    assert.match(invitationClipboard, new RegExp(`一次性邀请码：${nextCode}`, "u"));
    assert.match(invitationClipboard, /本人QQ邮箱|体验说明/u);
    report.assertions.clipboardContainsSiteLinkCodeAndRegistrationGuide = true;
    await userPage.screenshot({ path: path.join(evidenceDir, "05-user-one-time-codes-1440x900.png"), fullPage: true });
    const userLayout = await userPage.evaluate(() => ({
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(userLayout.horizontalOverflow <= 1, `USER_HORIZONTAL_OVERFLOW:${userLayout.horizontalOverflow}`);
    assert.equal(userLayout.applicationError, false);

    report.referralSurfaces = [];
    for (const [label, pathname] of [["referral", "/referral"], ["youcai-referral", "/youcai/referral"]]) {
      await userPage.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await closeOptionalOverlays(userPage);
      await userPage.getByText("我的邀请码", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
      const surface = await userPage.evaluate(() => ({
        text: document.body.innerText,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/u.test(document.body.innerText),
      }));
      assert.match(surface.text, /一次|一人|使用后/u, `ONE_TIME_COPY_REQUIRED:${label}`);
      assert.ok(surface.horizontalOverflow <= 1, `REFERRAL_HORIZONTAL_OVERFLOW:${label}`);
      assert.equal(surface.applicationError, false, `REFERRAL_APPLICATION_ERROR:${label}`);
      report.referralSurfaces.push({ label, horizontalOverflow: surface.horizontalOverflow });
      await userPage.screenshot({ path: path.join(evidenceDir, `surface-${label}-1440x900.png`), fullPage: true });
    }
    report.assertions.allMemberInvitationSurfacesPassed = true;
    await userContext.close();

    const anonymousContext = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    const registerPage = await anonymousContext.newPage();
    await registerPage.goto(`${origin}/register?invite=${encodeURIComponent(nextCode)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const inviteInput = registerPage.getByPlaceholder("请输入邀请码（联系现有学员获取）");
    await inviteInput.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await inviteInput.inputValue(), nextCode);
    assert.match(await registerPage.locator("body").innerText(), /已从邀请链接安全填入/u);
    report.assertions.sharedRegistrationLinkPrefillsOneTimeCode = true;
    await anonymousContext.close();

    const finalRows = await client.query(
      `SELECT code,is_used,is_permanent,used_by::text,used_at
         FROM public.invitation_codes WHERE user_id=$1::uuid ORDER BY created_at ASC`,
      [inviterId],
    );
    assert.equal(finalRows.rowCount, 2);
    assert.deepEqual(finalRows.rows.map((row) => row.code), [firstCode, nextCode]);
    assert.equal(finalRows.rows[0].is_used, true);
    assert.equal(finalRows.rows[0].used_by, inviteeId);
    assert.equal(finalRows.rows[1].is_used, false);
    assert.ok(finalRows.rows.every((row) => row.is_permanent === false));

    report.passed = true;
    report.checkedAt = new Date().toISOString();
    report.demo = {
      inviterId,
      inviteeId,
      firstConsumedCode: firstCode,
      nextAvailableCode: nextCode,
      registrationReward: { credits: 88, cash: 0.88 },
      activationReward: { credits: 398, cash: 3.98 },
      finalWallet: { credits: 486, cash: 4.86 },
      unreadNotifications: 2,
      retained: true,
    };
    report.assertions.demoDataRetainedForManualInspection = true;
    assert.deepEqual(report.failedResponses, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);

    await fs.writeFile(path.join(evidenceDir, "credentials.local.json"), `${JSON.stringify({
      localOnly: true,
      origin,
      inviter: demo.inviter,
      invitee: demo.invitee,
      firstConsumedCode: firstCode,
      nextAvailableCode: nextCode,
      inspect: {
        admin: `${origin}/admin?tab=invitations`,
        userNotifications: `${origin}/profile?tab=notifications`,
        userInvitationCodes: `${origin}/profile?tab=invitation`,
      },
    }, null, 2)}\n`, "utf8");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await client.end();
  }

  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
